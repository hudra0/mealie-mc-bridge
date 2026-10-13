# Architecture

Status: the service runs end to end. The LLM converter (`src/convert`) is built separately; until it is wired in, `src/pipeline/converter-port.ts` hands the pipeline a placeholder that fails every conversion with "converter not configured". Everything else on this page exists.

The bridge turns a Mealie recipe into a private draft in a Monsieur Cuisine account. It runs as one container next to Mealie and keeps its state in `/data/bridge.db`.

## Components

- **Mealie.** Holds the recipes. A recipe action posts the recipe id and the scale to the bridge. The bridge reads the recipe and image through the Mealie REST API and writes a tag, machine state in `extras` and a timeline entry back.
- **Bridge.** A Node/TypeScript service (Fastify, better-sqlite3). It receives the webhook, queues jobs, normalizes and scales ingredients, calls the converter, validates the result, uploads the draft and reports the outcome. Admin pages show jobs and the session.
- **LLM provider.** Produces the guided-cooking recipe as structured JSON, behind the converter interface.
- **monsieur-cuisine.com.** Receives the recipe as a draft in the user's account through the same web API the recipe editor uses. Saved on the device, it syncs to the machine.

## Job flow

1. `POST /hooks/mealie/<token>`: the token is compared in constant time before the body is parsed. The body yields only the recipe id and the scale. The job is stored and the hook answers 202. A recipe with an active job (queued, running, waiting for a session) gets that job back instead of a second one.
2. The worker claims the oldest queued job and loads the recipe and its image from Mealie. A missing or broken image is a warning, not a failure.
3. It fingerprints the recipe: name, normalized ingredients, step texts, notes, servings and scale. When `mc_recipes` holds a draft for the same recipe, scale and fingerprint, the job ends as skipped and the timeline entry links to that draft. A forced job goes on.
4. Ingredients are normalized and scaled; servings follow Mealie's scaler and the device's range. The recipe is rendered as German Markdown.
5. Categories: the live catalog (cached for a day in `settings`) is matched by name against the Mealie categories and tags. The converter gets the catalog with the matches first; afterwards the matched ids and the converter's known ids are merged.
6. The converter turns the request into a `RecipeInput`; the validator checks it against the schema, the device limits and the catalog.
7. The photo is cropped and uploaded, the draft is created. From here on the job cannot fail: the draft exists, so a retry would leave a second one.
8. With `MC_RECIPE_STATUS=private-publish` the status is changed so the recipe appears on the device. A failure here is a warning; the recipe stays a draft.
9. Write-back to Mealie: the tag (created on first use) and `extras` (`mc_recipe_id`, `mc_recipe_url`, `mc_source_hash`, `mc_synced_at`, `mc_servings`) in one merged PATCH, then a timeline entry with the link, servings, model and review hints. A 403 on the PATCH (no edit rights) is logged and the timeline entry, which needs no edit rights, is still written.

Every stage appends a job event, which the admin page shows as the job's log.

Failures before step 7 end the job as failed, with a short timeline entry "Monsieur Cuisine: Fehler – ..." and a mail. Network errors and server errors (5xx) are retried by the worker three times with a pause of 2, 4 and 8 seconds. Validation and conversion failures are not retried, and neither is creating the draft.

## Job states

```text
              webhook / admin retry
                     │
                     ▼
   ┌──────────── queued ◀──────────────────────────────┐
   │ cancel         │ claimNext                         │ session renewed,
   ▼                ▼                                   │ restart, shutdown
cancelled        running ──────────────────────▶ session_expired
                    │   Monsieur Cuisine rejected        ▲
                    │   the session                      │ cancel
       ┌────────────┼─────────────┐                      └─────▶ cancelled
       ▼            ▼             ▼
     done        skipped        failed
  (draft made)  (unchanged)   (after retries)
       │            │             │
       └────────────┴─────────────┴──▶ queued   (admin retry or force rebuild)
```

- `running` goes back to `queued` when the worker stops (shutdown aborts the job before the draft exists) and on start when a crash left it running.
- While the session is invalid or expired, the worker claims nothing and the session manager moves queued jobs to `session_expired`. A new valid cookie moves them back to `queued`.

## Session

`src/session/manager.ts` is the cookie source for the Monsieur Cuisine client. The cookie lives in `settings`, encrypted with AES-256-GCM under `SETTINGS_KEY`; the setting name is bound to the ciphertext as additional data. `MC_COOKIE` is stored on the first start and whenever its value changes, so a cookie pasted on the admin page survives restarts.

The manager checks the session on start and every `SESSION_CHECK_MINUTES` with the cheapest account call, which also keeps the session alive. A cookie offered on the admin page is checked with a separate client before it replaces the stored one, so a stale paste never breaks a working session. Session states are `unknown` (not checked yet), `valid`, `invalid` and `expired`. Each change to `invalid` or `expired` pauses the queue and sends one notification; a failing check that is not a rejection (the site is down) sends one mail per failure streak and leaves the state alone.

## Admin pages and security

- The webhook token sits in the path and is compared in constant time; a wrong token gets the same 404 as an unknown route. Request logs replace it with `[redacted]`.
- Admin pages use Basic Auth (`ADMIN_USER`, `ADMIN_PASSWORD`), compared in constant time. Without both, the pages are open, a warning is logged and every page shows a banner.
- Cross-site request forgery: every form carries a random token generated when the process starts, and every POST must return it. A page on another site cannot read the token, so it cannot forge a post even though the browser would add the Basic Auth credentials on its own. A POST whose `Origin` names another host is refused as well. The dry-run conversion, a GET that costs money, needs the token too. The token changes on restart, so a page loaded before a restart has to be reloaded. This needs no cookie and no extra dependency.
- Pages are server-rendered strings. A tagged template escapes every interpolated value, so recipe titles and error texts render as text. Responses carry a strict Content Security Policy and `X-Frame-Options: DENY`.
- Error texts that reach mails, the timeline or pages pass through `scrubSecrets`, which masks cookie headers, session cookie values, bearer tokens and key=value secrets.

## Modules

```text
knowledge/device-programs.json   the only source of device and recipe limits
src/
  main.ts           wiring: config, store, session manager, clients, converter, worker,
                    signals; `node dist/main.js generate-secrets` prints SETTINGS_KEY and
                    WEBHOOK_TOKEN
  config.ts         zod schema of the environment; loadServiceConfig adds the settings the
                    service cannot start without
  server.ts         Fastify instance with /health
  logger.ts         pino options with redaction; app-logger.ts the logger type and
                    scrubSecrets for free text
  store/
    db.ts           opens bridge.db (WAL), runs migrations
    migrations.ts   versioned schema (user_version), each step in a transaction
    jobs.ts         job repository: enqueue with dedupe, claimNext, events, requeue, cancel,
                    pause/resume for the session, recovery after a crash
    mc-recipes.ts   drafts sent, keyed by recipe, scale and source hash
    settings.ts     key-value settings, AES-256-GCM secrets, key generation
  session/
    manager.ts      SessionProvider for McClient: stored cookie, checks, state, pause/resume
  pipeline/
    converter-port.ts  the converter contract and the lazy loader of src/convert
    prepare.ts      steps shared with the dry run: normalize, scale, render, categories,
                    converter request, validation of the answer
    categories.ts   catalog cache, name matching, id merge
    source-hash.ts  the fingerprint for "already sent"
    messages.ts     timeline texts per language (German), Markdown escaping
    run-job.ts      one run of a job, stage by stage
    worker.ts       single worker: poll, retry with backoff, session gate, clean stop
  service/
    app.ts          builds the HTTP app and the worker from the parts
    routes.ts       webhook and GET /jobs/:id
    admin.ts        admin routes, Basic Auth, form token
    admin-views.ts  page bodies; html.ts the escaping template and the layout
    health.ts       /health report
    security.ts     constant-time compare, Basic Auth parsing, URL redaction for logs
  notify/
    email.ts        Notifier interface, EmailNotifier (nodemailer, German plain text,
                    de-duplicated), NullNotifier
  recipe/           recipe input schema, device limits loader, validator, payload builder
  mc/               Monsieur Cuisine transport, client, session providers, image preparation
  mealie/           webhook parser, REST client, Markdown renderer, schemas
  ingredients/      unit vocabulary, free-text parser, normalizer, scaling
scripts/            corpus crawl and analysis, mc-smoke, formatter
```

Rules that are data live in one place each: device limits in `knowledge/device-programs.json`, step kinds and API keys in `src/recipe/modes.ts`, rounding per unit kind in `src/ingredients/scale.ts`, timeline texts in `src/pipeline/messages.ts`, the job states in `src/store/migrations.ts`.

## Data stores

- **SQLite** (`/data/bridge.db`): `jobs` (status, attempts, error, draft id and link, provider, model, token usage, cost, timestamps, force flag), `job_events` (the log per job), `mc_recipes` (recipe id, scale, source hash, draft id and link; this table, not the Mealie extras, decides whether a recipe was sent) and `settings` (the encrypted cookie, session state and last check, category cache).
- **Knowledge base** (`knowledge/`, in the repository): tables and rules derived from public cooking guidance, written in our own words.
- **Local corpus** (optional, never committed): normalized example recipes for retrieval at conversion time.

## Converter interface

```ts
interface Converter {
  convert(req: ConversionRequest, opts?: { signal?: AbortSignal }): Promise<ConversionResult>;
}
```

The request carries the title, the Markdown, the servings, the locale, the scaled ingredients and the category catalog. The result carries the `RecipeInput`, the number of attempts, token usage and cost, warnings, review hints, provider and model. `loadConverter` imports `src/convert/index.js` and calls its `createConverter({ env, limits, logger })`; when that module does not exist it returns the placeholder. The converter runs its own correction rounds against the validator; the pipeline validates the final answer again with the live category catalog.
