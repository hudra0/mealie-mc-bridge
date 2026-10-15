# Architecture

The bridge turns a Mealie recipe into a private recipe in a Monsieur Cuisine account: it creates a draft and then sets private-publish, so the recipe appears on the machine. It runs as one container next to Mealie and keeps its state in `/data/bridge.db`.

## Components

- **Mealie.** Holds the recipes. A recipe action posts the recipe id and the scale to the bridge. The bridge reads the recipe and its image through the Mealie REST API and writes a tag, machine state in `extras` and a timeline entry back.
- **Bridge.** A Node/TypeScript service (Fastify, better-sqlite3). It receives the webhook, queues jobs, normalizes and scales ingredients, calls the converter, validates the result, uploads the recipe and reports the outcome. Admin pages show jobs and the session.
- **LLM provider.** OpenAI or Anthropic. Produces the guided-cooking recipe as structured JSON, behind the converter interface.
- **monsieur-cuisine.com.** Receives the recipe through the same web API the recipe editor uses, with the session cookie of the user's browser. Only a recipe with status `private-publish` appears on the machine; a draft is visible in the web editor only.

## Job flow

1. `POST /hooks/mealie/<token>`. The token is compared in constant time before the body is parsed; a wrong token gets the same 404 as an unknown route. The body yields the recipe id and the scale. The job is stored and the hook answers 202. A recipe and scale that already have an active job (queued, running, session_expired) get that job back.
2. The worker claims the oldest queued job and loads the recipe and its image from Mealie. A missing or broken image is a warning.
3. Fingerprint: everything the converter sees (name, description, times, normalized ingredients, step texts, notes, nutrition, servings) plus the scale. When `mc_recipes` holds a recipe for the same Mealie recipe, scale and fingerprint, the bridge asks Monsieur Cuisine for it before loading the image: if it still exists (or the check fails) the job ends as `skipped` and the timeline entry links to it; on 404 the job converts again. A forced job goes on.
4. Ingredients are normalized and scaled; servings follow Mealie's scaler and the device's range. The recipe is rendered as Markdown with the labels and decimal separator of the `MC_LOCALE` pack; every ingredient line carries its index `[i]` for the converter's ingredient mapping.
5. Categories: the live Monsieur Cuisine catalog (cached for a day per locale in `settings`) is matched by name against the Mealie categories and tags. The converter gets the catalog with the matches first; afterwards the matched ids and the converter's ids are merged.
6. The converter returns a `RecipeInput`; the pipeline validates it again against the schema, the device limits and the live catalog. A result that passes is stored on the job (`conversion_json`), so a retry after a later temporary failure or a plain admin retry does not pay for it again. A force rebuild or a changed recipe converts again.
7. Ingredient ids (`MC_RESOLVE_INGREDIENTS=exact`): each name is looked up in the pack's `ingredient-catalog.json`, then as an id an earlier search found in `ingredient_cache` (keys carry a rules version), then in the same catalog by a relaxed form (usage notes from the pack's `qualifierSuffixes` removed, a buying form from `buyingFormSuffixes` only when the catalog has no entry in that form, a parenthesis read as the comma form, singular and plural folded; `src/ingredients/catalog-match.ts`), then, unless a recent miss is cached, in the site's quick search (one search per second, misses cached for seven days). A search hit counts only for an equal name after normalization. Before the conversion the user message lists up to three close catalog names per source ingredient. A session error sends the job to `session_expired`; other search errors leave the name without an id. Counts and unmatched names go into `ingredients_json`.
8. The photo is cropped and uploaded. Then the job is marked (`create_started_at`) and the draft is created with the pack's `languageLocale`, complexity id and default group name. This is the point of no return: the request is never retried, a shutdown no longer requeues the job, and a job found running with the mark on start fails with a "check your drafts" message. Once the draft exists, the job cannot fail.
9. The status is set to `MC_RECIPE_STATUS` (default `private-publish`). A failure here is a warning; the recipe stays a draft and the timeline entry says so. With `draft` the step is skipped.
10. Write-back to Mealie: the tag (created on first use) and `extras` (`mc_recipe_id`, `mc_recipe_url`, `mc_source_hash`, `mc_synced_at`, `mc_servings`, `mc_serving_unit`) in one PATCH, then a timeline entry with the link, serving size, model and review hints. A 403 on the PATCH is logged, and the timeline entry, which needs no edit rights, is still written.

Every stage appends a job event, shown as the job's log. Failures before the draft exists end the job as `failed`, with a short timeline entry in `UI_LANGUAGE` and a mail. Network errors and 5xx answers are retried three times with a pause of 2, 4 and 8 seconds; validation and conversion failures fail on the first attempt.

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

- `running` goes back to `queued` when the worker stops before the draft request is out, and on start when a crash left it running. A job found running on start that already has its draft ends as `done`; one stopped while the draft request was out ends as `failed`, so it is never sent twice.
- While the session is `invalid` or `expired`, the worker claims nothing. The session manager (on a rejection) and the worker (for jobs queued while the gate is closed) move queued jobs to `session_expired`; a new valid cookie moves them back to `queued`.

## Session and security

- `src/session/manager.ts` is the cookie source for the Monsieur Cuisine client. The cookie lives in `settings`, encrypted with AES-256-GCM under `SETTINGS_KEY`. `MC_COOKIE` is stored on the first start and whenever its value changes. The manager checks the session on start and every `SESSION_CHECK_MINUTES` with a cheap account call. States: `unknown`, `valid`, `invalid`, `expired`. A change to `invalid` or `expired` pauses the queue and sends one notification. A cookie pasted on the admin page is checked with a separate client before it replaces the stored one, and a late rejection of a cookie that has since been replaced is ignored. With a Lidl account stored on the settings page, a change to `invalid` or `expired` first starts `src/session/auto-login.ts`: a headless Chromium logs in through the site's SSO page in a fresh profile under `DATA_DIR/tmp`, removed after the attempt, and the cookie it gets goes through the same check. The browser fills the Lidl form only on an https page of a host in `LIDL_LOGIN_HOSTS`, gets a minimal environment without the bridge's secrets, and no Playwright error message reaches the stored attempt, the log, the page or a mail (`src/session/browser-errors.ts`). The notification goes out only when that login fails. Automatic attempts run one at a time, at most hourly and three times in 24 hours, with 1, 4 and 24 hours of backoff after failures.
- Admin pages use a login form and a signed session cookie (`src/service/admin-auth.ts`); `/admin/api/` also takes Basic Auth. The service does not start without `ADMIN_USER` and `ADMIN_PASSWORD` unless `ADMIN_AUTH=off`; without a login the pages answer only to an IP address, `localhost` or a name in `ADMIN_HOSTS` (DNS rebinding). Every form carries a token bound to the login session, and a POST with a foreign `Origin` is refused. Pages are server-rendered with an escaping template, a strict Content Security Policy, `X-Frame-Options: DENY` and, over HTTPS, HSTS. `TRUST_PROXY` decides whose `X-Forwarded-For` and `X-Forwarded-Proto` count, for the login throttle and the https detection.
- The webhook enforces `JOB_DAILY_LIMIT` and `JOB_DAILY_COST_LIMIT_USD` over the last 24 hours before it queues a job (429 and a timeline entry otherwise), and rounds the scale to quarter steps between 0.25 and 10. The service converter refuses a recipe text above `LLM_MAX_RECIPE_KB` before any model call, and the prompt puts the recipe between `<recipe>` delimiters as untrusted data.
- `/health` and `GET /jobs/:id` need no login. `/health` carries no free text; `/jobs/:id` shows the state and the log of a job, not its Monsieur Cuisine link. Unexpected errors answer with a generic 500 body.
- Request logs replace the webhook token with `[redacted]`; pino redacts cookies, tokens and keys; error texts that reach mails, the timeline or pages pass through `scrubSecrets`.

## Languages

The Mealie recipe may be in any language. `MC_LOCALE` selects a locale pack in `knowledge/locales/<locale>/` (`mc.json`, `units.json`, `phrases.json`, `technique-aliases.json`, `ingredient-catalog.json`, `prompt-rules.md`), which sets the language of the Monsieur Cuisine recipe and everything the site needs per language. The neutral knowledge files name phrases and units by placeholder; `src/locale/placeholders.ts` fills them from the pack, and a placeholder a pack cannot fill fails the load. `UI_LANGUAGE` selects the message catalog in `src/i18n` for timeline entries, mails and admin pages; logs and job events stay English. Names are never compared across languages: the converter returns an `ingredientMapping` from each of its ingredients to a numbered source line, and the plausibility checks compare coverage and amounts along it (`src/convert/mapping.ts`).

## Modules

```text
knowledge/device-programs.json   the only source of device and recipe limits
knowledge/locales/<locale>/      locale packs: language-specific data, ingredient catalogs
src/
  main.ts           wiring: config, store, session manager, clients, converter, worker,
                    signals; `node dist/main.js generate-secrets`
  config.ts         zod schema of the environment, loadServiceConfig for the service
  version.ts        version from package.json
  server.ts         Fastify instance with /health and the shared 404
  logger.ts         pino options with redaction; app-logger.ts logger type, scrubSecrets
  store/            bridge.db (WAL), versioned migrations, jobs, sent recipes,
                    ingredient cache, encrypted settings
  session/          manager.ts: stored cookie, checks, state, queue pause and resume;
                    auto-login.ts: stored Lidl account, limits, screenshots;
                    browser-login.ts: the SSO login flow behind a small browser
                    interface; playwright-browser.ts: that interface on Playwright
  pipeline/         run-job.ts (one run, stage by stage), worker.ts (poll, retry, gate,
                    clean stop), prepare.ts (shared with the dry run), categories.ts,
                    ingredient-resolver.ts, source-hash.ts, messages.ts, locale.ts,
                    converter-port.ts (converter contract and lazy loader)
  service/          app.ts (builds app and worker), routes.ts (webhook, GET /jobs/:id),
                    admin.ts and admin-views.ts, admin-auth.ts (login cookie),
                    admin-settings.ts (settings page), html.ts, health.ts, security.ts
  notify/           email.ts: Notifier, EmailNotifier (nodemailer), NullNotifier
  convert/          the LLM converter, see below
  recipe/           recipe input schema, device limits loader, validator, payload builder,
                    step kinds and API keys (modes.ts)
  mc/               Monsieur Cuisine transport, client, session providers, image preparation
  mealie/           webhook parser, REST client, Markdown renderer, schemas
  ingredients/      unit vocabulary, free-text parser, normalizer, scaling, catalog loader
  locale/           locale pack schema and loader, placeholders, word-list matcher
  i18n/             message catalogs (de, en), Markdown escaping and dates
  testing/          fakes and helpers for the tests, not part of the build
scripts/            corpus crawl, analysis and knowledge build; convert and mc-smoke CLIs;
                    formatter; configuration reference for the README
```

Rules that are data live in one place each: device limits in `knowledge/device-programs.json`, step kinds and API keys in `src/recipe/modes.ts`, rounding per unit kind in `src/ingredients/scale.ts`, texts people read in `src/i18n`, everything language-specific in `knowledge/locales/<locale>/`, the job states in `src/store/migrations.ts`, the settings in `src/config.ts`.

## Converter

`src/pipeline/converter-port.ts` imports `src/convert/index.js` at startup and calls `createConverter({ env, limits, logger })` from `src/convert/index.ts`, which hands it to `createServiceConverter` (`src/convert/service.ts`). The generator is built at the first conversion, so a missing API key fails the job rather than the start.

```ts
interface Converter {
  convert(req: ConversionRequest, opts?: { signal?: AbortSignal }): Promise<ConversionResult>;
}
```

- `knowledge.ts` loads the knowledge base and the pack of the output language and picks the techniques a recipe needs; `prompt.ts` builds a system prompt that is the same for every recipe of an installation (so provider prompt caches reuse it) and a user message with the categories, servings, techniques and recipe. Without a category list the request is refused.
- `loop.ts` runs generator call, JSON parsing (`output.ts`), validator and plausibility rules (`sanity.ts`, with `mapping.ts`, `mass.ts`, `text.ts`), and correction rounds with the errors and the previous answer, up to `LLM_MAX_CORRECTIONS`. It sums usage and cost (`cost.ts`) over all attempts. Errors are in `errors.ts`.
- `generator.ts` picks the provider: `providers/openai.ts` (Responses API, strict JSON schema) or `providers/anthropic.ts` (structured output, cached system block, server-side fallbacks). A new provider is one file there and a branch in `createGenerator`.

```text
ConversionRequest -> system prompt (once) + user message
  -> RecipeGenerator.generate -> parse JSON -> validateRecipeInput -> checkSanity
       no errors                 -> ConversionResult (recipe, warnings, review hints, usage)
       errors, rounds left       -> generate again with errors + previous answer
       errors, no rounds left    -> ConversionFailedError
```

`scripts/convert.ts` runs the converter from the command line (`prompt`, `convert`, `eval` against a local corpus) and never uploads.

## Data stores

- **SQLite** (`/data/bridge.db`): `jobs` (status, attempts, error, recipe id and link, provider, model, usage, cost, timestamps, force flag, `conversion_json`, `create_started_at`, `ingredients_json`), `job_events` (log per job), `mc_recipes` (Mealie recipe, scale, fingerprint, Monsieur Cuisine id and link; this table, not the Mealie extras, decides whether a recipe was sent), `settings` (encrypted cookie, session state, category cache), `ingredient_cache` (normalized name, id or null, source, time).
- **Knowledge base** (`knowledge/`, in the repository): tables and rules derived from published recipes, written in our own words.
