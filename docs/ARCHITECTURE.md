# Architecture

Status: the service runs end to end. `src/pipeline/converter-port.ts` loads the LLM converter (`src/convert`) at startup through its `createConverter({ env, limits, logger })`. Everything else on this page exists, except where it is marked as planned.

The bridge turns a Mealie recipe into a private recipe in a Monsieur Cuisine account: it creates a draft and then sets private-publish, so the recipe appears on the machine. It runs as one container next to Mealie and keeps its state in `/data/bridge.db`.

## Components

- **Mealie.** Holds the recipes. A recipe action posts the recipe id and the scale to the bridge. The bridge reads the recipe and image through the Mealie REST API and writes a tag, machine state in `extras` and a timeline entry back.
- **Bridge.** A Node/TypeScript service (Fastify, better-sqlite3). It receives the webhook, queues jobs, normalizes and scales ingredients, calls the converter, validates the result, uploads the draft and reports the outcome. Admin pages show jobs and the session.
- **LLM provider.** Produces the guided-cooking recipe as structured JSON, behind the converter interface.
- **monsieur-cuisine.com.** Receives the recipe as a draft in the user's account through the same web API the recipe editor uses. Only a recipe with status `private-publish` appears on the machine under "Meine Rezepte"; a draft is visible in the web editor only.

## Job flow

1. `POST /hooks/mealie/<token>`: the token is compared in constant time before the body is parsed. The body yields only the recipe id and the scale. The job is stored and the hook answers 202. A click for a recipe and scale that already has an active job (queued, running, waiting for a session) gets that job back instead of a second one; a click at another scale is its own job, since it leads to its own draft.
2. The worker claims the oldest queued job and loads the recipe and its image from Mealie. A missing or broken image is a warning, not a failure.
3. It fingerprints the recipe: everything the converter sees (name, description, times, normalized ingredients, step texts, notes, nutrition, servings) plus the scale. Tags, categories and the image are left out. When `mc_recipes` holds a draft for the same recipe, scale and fingerprint, the job ends as skipped and the timeline entry links to that draft. A forced job goes on.
4. Ingredients are normalized and scaled; servings follow Mealie's scaler and the device's range. The recipe is rendered as German Markdown.
5. Categories: the live catalog (cached for a day in `settings`) is matched by name against the Mealie categories and tags. The converter gets the catalog with the matches first; afterwards the matched ids and the converter's known ids are merged.
6. The converter turns the request into a `RecipeInput`; the validator checks it against the schema, the device limits and the catalog. A result that passes is stored on the job (`conversion_json`, with the fingerprint), so a retry after a later temporary failure reuses it and does not pay for the conversion again. A plain admin retry reuses it as well; a force rebuild or a changed recipe converts again.
7. Ingredient ids (`MC_RESOLVE_INGREDIENTS`, default `exact`): each distinct ingredient name of the converted recipe is looked up in `ingredient-catalog.json` from `KNOWLEDGE_DIR` (in memory), then in the `ingredient_cache` table, then in the Monsieur Cuisine quick search, at most one search per second. A name matches only when it is equal after normalization (Unicode NFC, trimmed, whitespace collapsed, lower case); the search's first hit is never taken on its own. Search results are cached, a miss for seven days. A session error from the search sends the job to `session_expired`; any other search error leaves the name without an id. The counts and the names without an id go into `ingredients_json` and the job detail page; the job log gets the counts only. A shutdown during the lookup records nothing and sends the job back to the queue. The ids feed the app's shopping list and ingredient filters; the device shows no icons either way, and an ingredient without an id cooks the same.
8. The photo is cropped and uploaded. Then the job is marked (`create_started_at`) and the draft is created. This is the point of no return: after a timeout the server may have created the draft anyway, so the request is never retried, a shutdown no longer sends the job back to the queue, and a job found running with the mark on start fails with a "check your drafts" message. Once the draft exists, the job cannot fail.
9. The status is set to private-publish (the default of `MC_RECIPE_STATUS`) so the recipe appears on the device. A draft is not shown there. A failure here is a warning; the recipe stays a draft and the timeline entry says so. With `MC_RECIPE_STATUS=draft` this step is skipped, which is meant for debugging.
10. Write-back to Mealie: the tag (created on first use) and `extras` (`mc_recipe_id`, `mc_recipe_url`, `mc_source_hash`, `mc_synced_at`, `mc_servings`) in one merged PATCH, then a timeline entry with the link, servings, model and review hints. A 403 on the PATCH (no edit rights) is logged and the timeline entry, which needs no edit rights, is still written.

Every stage appends a job event, which the admin page shows as the job's log.

Failures before the draft exists end the job as failed, with a short timeline entry "Monsieur Cuisine: Fehler – ..." and a mail. Network errors and server errors (5xx) are retried by the worker three times with a pause of 2, 4 and 8 seconds. Validation and conversion failures fail on the first attempt, and creating the draft is never retried.

## Job states

```text
                     webhook
                        │
                        ▼
     ┌─────────────── queued ◀───────────────────────────┐
     │ cancel          │   ▲                              │ session renewed,
     ▼                 │   │ shutdown before the draft    │ admin retry
 cancelled   claimNext │   │ request; crash recovery      │
                       ▼   │ on start                     │
                     running ──── session rejected ──▶ session_expired
                       │                                 ▲        │
                       │      gate paused: queued jobs   │        │ cancel
                       │      wait here ─────────────────┘        ▼
        ┌──────────────┼──────────────┐                       cancelled
        ▼              ▼              ▼
      done          skipped         failed
  (draft made)    (unchanged)   (not retryable, retries used up,
                                 or stopped while creating the draft)

done, skipped, failed and cancelled go back to queued on admin retry or force rebuild.
```

- `running` goes back to `queued` when the worker stops before the draft request is out, and on start when a crash left it running. A job found running on start that already has its draft ends as `done`; one that was stopped while the draft request was out ends as `failed`, so it is never sent twice.
- While the session is invalid or expired, the worker claims nothing. Both the session manager (when the session is rejected) and the worker (for jobs queued while the gate is closed) move queued jobs to `session_expired`. A new valid cookie moves them back to `queued`.

## Session

`src/session/manager.ts` is the cookie source for the Monsieur Cuisine client. The cookie lives in `settings`, encrypted with AES-256-GCM under `SETTINGS_KEY`; the setting name is bound to the ciphertext as additional data. `MC_COOKIE` is stored on the first start and whenever its value changes, so a cookie pasted on the admin page survives restarts.

The manager checks the session on start and every `SESSION_CHECK_MINUTES` with the cheapest account call, which also keeps the session alive. McClient reports a rejected cookie together with the cookie the request used; a late rejection of a cookie that has since been replaced is ignored. A cookie offered on the admin page is checked with a separate client before it replaces the stored one, so a stale paste never breaks a working session. Session states are `unknown` (not checked yet), `valid`, `invalid` and `expired`. Each change to `invalid` or `expired` pauses the queue and sends one notification; a failing check that is not a rejection (the site is down) sends one mail per failure streak and leaves the state alone.

## Admin pages and security

- The webhook token sits in the path and is compared in constant time; a wrong token gets the same 404 body as an unknown route. Request logs replace it with `[redacted]`, and the not-found handler logs no URL, so a token on a missed route (a GET, a trailing slash) stays out of the log too.
- Admin pages use Basic Auth (`ADMIN_USER`, `ADMIN_PASSWORD`), compared in constant time. Without both, the pages are open, a warning is logged and every page shows a banner.
- DNS rebinding: without Basic Auth, the admin pages answer only to an IP address, `localhost` or a name listed in `ADMIN_HOSTS`. With Basic Auth the list applies only when set, because the browser does not send the credentials to a rebound name.
- `/health` needs no login and carries no free text: for the last worker error it shows only the time; the message is on the dashboard.
- Cross-site request forgery: every form carries a random token generated when the process starts, and every POST must return it. A page on another site cannot read the token, so it cannot forge a post even though the browser would add the Basic Auth credentials on its own. A POST whose `Origin` names another host is refused as well. The dry-run conversion, a GET that costs money, needs the token too. The token changes on restart, so a page loaded before a restart has to be reloaded. This needs no cookie and no extra dependency.
- Pages are server-rendered strings. A tagged template escapes every interpolated value, so recipe titles and error texts render as text. Responses carry a strict Content Security Policy and `X-Frame-Options: DENY`.
- Error texts that reach mails, the timeline or pages pass through `scrubSecrets`, which masks cookie headers, session cookie values, bearer tokens and key=value secrets.

## Modules

```text
knowledge/device-programs.json   the only source of device and recipe limits
knowledge/ingredient-catalog.json  ingredient names with their systemIngredientId
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
    ingredient-cache.ts  ingredient ids found by search, and recent misses
    settings.ts     key-value settings, AES-256-GCM secrets, key generation
  session/
    manager.ts      SessionProvider for McClient: stored cookie, checks, state, pause/resume
  pipeline/
    converter-port.ts  the converter contract and the lazy loader of src/convert
    prepare.ts      steps shared with the dry run: normalize, scale, render, categories,
                    converter request, validation of the answer
    categories.ts   catalog cache, name matching, id merge
    ingredient-resolver.ts  systemIngredientId per ingredient: catalog, cache, rate-limited
                    search with exact name matches only
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
  ingredients/      unit vocabulary, free-text parser, normalizer, scaling, ingredient
                    catalog loader and name normalization
scripts/            corpus crawl and analysis, mc-smoke, formatter
```

Rules that are data live in one place each: device limits in `knowledge/device-programs.json`, step kinds and API keys in `src/recipe/modes.ts`, rounding per unit kind in `src/ingredients/scale.ts`, timeline texts in `src/pipeline/messages.ts`, the job states in `src/store/migrations.ts`.

The converter (job flow step 5):

- **`src/convert`**: turns a rendered Mealie recipe into a validated `RecipeInput` with a language model.
  - `types.ts` is the contract the service depends on: `ConversionRequest`, `ConversionResult`, `Converter`, and the provider interface `RecipeGenerator` with `GenerationInput` and `GenerationOutput`.
  - `knowledge.ts` loads `techniques.json`, `timing-model.json`, `units.json`, `device-limits.json`, `converter-rules.json` (ingredient-class words, amount tolerance) and `prompt-rules.md` from `KNOWLEDGE_DIR`, checks the fields it reads, and picks the techniques a recipe needs (aliases and ingredient classes found in the recipe, plus chopping, sautéing, simmering and the scale step), offering only those whose program the installation can run. `step-patterns.md` stays in the directory as the evidence behind the prompt rules.
  - `prompt.ts` builds the system prompt in a fixed order (role, device limits from the effective layer of `device-programs.json`, conversion rules, technique table, timing, units, output contract) and the user message (category list, servings, the full entries of the picked techniques, recipe, and on a correction round the errors and the previous answer). The system prompt is the same for every recipe of an installation, so the providers' prompt caches reuse it across recipes. File names and source remarks of the knowledge files are rewritten to prompt section names, and technique alternatives in modes the installation cannot run are left out. Without a category list the user message is refused: the model must not guess category ids.
  - `sanity.ts` holds the plausibility rules, each an id, a description and a function: heat-up time of every heating that starts on cold contents (cold additions cool hot contents to the mixing temperature), bowl mass, foaming contents, turbo, whisk, flour per kneading step, steaming water, a text step before every program step, every input ingredient in the ingredient list, ingredients used, amounts against the input in both directions, descriptions on program steps, roasting and sautéing temperatures, duplicate additions, servings. Thresholds come from the knowledge base. `mass.ts` follows the bowl content from step to step for them.
  - `loop.ts` runs the conversion: prompts, generator call, JSON parsing, validator and plausibility rules, correction rounds, usage and cost over all attempts (each attempt of a server-side fallback at its own model's price), abort signal. It needs the category catalog or `defaultCategoryIds`. The result keeps the plausibility warnings (English, for the bridge's report) apart from the model's review hints (German, as the recipe carries them).
  - `cost.ts` is the price table per model (USD per million tokens, `LLM_PRICES_JSON` overrides it) and the cost estimate.
  - `providers/openai.ts` calls the Responses API with a strict JSON schema; `prepareStrictSchema` turns the recipe schema into what strict mode accepts. `providers/anthropic.ts` calls `messages.parse` with structured output built from the same JSON schema (enums kept), a cached system block and server-side fallbacks.
  - `index.ts` exports the module and `createGenerator(config)`, which picks the provider from `LLM_PROVIDER`.

```text
ConversionRequest (rendered Markdown, scaled ingredients, servings)
  |
  v
buildSystemPrompt (once) + selectTechniques -> buildUserMessage
  |
  v
+-> RecipeGenerator.generate ---------------------------- OpenAI or Anthropic
|     |
|     v
|   parse JSON -> validateRecipeInput (device-programs.json)
|              -> checkSanity (physics, structure, amounts)
|     |
|     +-- no errors ---------------------> ConversionResult (recipe, warnings, review hints)
|     |
|     +-- errors, rounds left: feedback = errors + previous answer
|     |
+-----+
      +-- errors, no rounds left --------> ConversionFailedError
```

`scripts/convert.ts` runs the converter from the command line (`convert`, `prompt`, `eval` against a local corpus) and never uploads.

## Data stores

- **SQLite** (`/data/bridge.db`): `jobs` (status, attempts, error, draft id and link, provider, model, token usage, cost, timestamps, force flag, the validated conversion, the draft creation mark), `job_events` (the log per job), `mc_recipes` (recipe id, scale, source hash, draft id and link; this table, not the Mealie extras, decides whether a recipe was sent), `settings` (the encrypted cookie, session state and last check, category cache) and `ingredient_cache` (normalized ingredient name, id or null, source, time; ids found by search and misses). `jobs.ingredients_json` holds the counts per resolution layer and the names left without an id.
- **Knowledge base** (`knowledge/`, in the repository): tables and rules derived from public cooking guidance, written in our own words.
- **Local corpus** (planned, part of the converter; optional, never committed): normalized example recipes for retrieval at conversion time.

## Converter interface

A `RecipeGenerator` takes the prompts, the recipe JSON Schema and, on a correction round, the errors with the previous answer, and returns the answer as JSON text with its token usage. Each provider implements it with its own SDK and structured-output mechanism. The prompt builder, the Zod schema, the plausibility rules and the correction loop are shared, so adding a provider means one new file in `src/convert/providers` and a branch in `createGenerator`.

```ts
interface Converter {
  convert(req: ConversionRequest, opts?: { signal?: AbortSignal }): Promise<ConversionResult>;
}
```

The request carries the title, the Markdown, the servings, the locale, the scaled ingredients and the category catalog. The result carries the `RecipeInput`, the number of attempts, token usage and cost, warnings, review hints, provider and model. `loadConverter` imports `src/convert/index.js` and calls its `createConverter({ env, limits, logger })`; when that module does not exist it returns the placeholder. The converter takes the category catalog from the request's category hints (one `<id>: <name>` line per category), builds the generator at the first conversion so a missing API key fails the job rather than the start, and reads `KNOWLEDGE_DIR`, `LLM_MAX_CORRECTIONS` and `LLM_PRICES_JSON` from the environment. The converter runs its own correction rounds against the validator; the pipeline validates the final answer again with the live category catalog.
