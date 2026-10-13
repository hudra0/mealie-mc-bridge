# Architecture

Status: partly built. Implemented are the HTTP skeleton with `/health`, the Mealie side (`src/mealie`), ingredient handling (`src/ingredients`), the Monsieur Cuisine client (`src/mc`), the recipe input format with its validator and payload builder (`src/recipe`), the LLM converter (`src/convert`), and the knowledge base. They exist as libraries and are not yet wired together: the webhook route, the job queue and the pipeline that runs the Mealie write-back are still target design. [Modules](#modules) lists what exists; the rest of this page describes what the finished service will do.

The bridge turns a Mealie recipe into a private draft in a Monsieur Cuisine account. It runs as one container next to Mealie and keeps its state under `/data`.

## Components

- **Mealie.** Holds the recipes. A recipe action posts the recipe id to the bridge. The bridge reads the recipe and image through the Mealie REST API and writes a tag and a timeline entry back.
- **Bridge.** A Node/TypeScript service. It receives the webhook, queues jobs, normalizes and scales ingredients, calls the LLM, validates the result, uploads the draft and reports the outcome. A small admin page shows jobs and session state.
- **LLM provider.** Produces the guided-cooking recipe as structured JSON. The provider is selectable by configuration.
- **monsieur-cuisine.com.** Receives the recipe as a private draft in the user's account through the same web API the site uses. The draft then syncs to the device.

## Job flow

1. Receive the webhook, check its token, read only the recipe id and the scale, store a job and answer 202. A second job for the same recipe is not started while one is running.
2. Load the recipe and its image from Mealie.
3. Hash the recipe content (name, ingredients, steps, notes, servings, scale). If a draft with the same hash exists, report it as unchanged instead of converting again. An admin can force a rebuild.
4. Normalize ingredients and scale them. Use structured fields first, parse free-text amounts with deterministic rules, and hand only the remainder to the LLM. Servings follow Mealie's scaler (recipe servings, else the yield quantity, times the scale) and are limited to the range the device accepts, `recipeLimits.servings` in `knowledge/device-programs.json` (1–100), passed in from the loaded device limits.
5. Convert with the LLM into the intermediate recipe structure. Validate against the schema, the device limits and plausibility rules (heating rates, fill levels, times). Feed validation errors back for up to three correction rounds.
6. Convert the image, upload it and create the draft. The code sets the draft status, never the model.
7. Write the result back to Mealie: a tag, a link to the draft and any review hints as a timeline entry.
8. On failure, write the error to the timeline. If the Monsieur Cuisine session has expired, pause the job, flag it in the admin page, send a notification and resume the waiting jobs after the session is renewed.

## Modules

What exists today, and which module owns which rule:

```text
knowledge/device-programs.json   the only source of device and recipe limits: programs, API keys per
                                 program, temperature grids, time ranges, speed rules and their
                                 conditions, text lengths, servings, times, categories, nutrients,
                                 cover photo aspect, device type id
src/recipe/
  schema.ts     recipe input format (zod): structure and types only, plus a JSON Schema export
                that carries the knowledge file's recipe limits for structured LLM output
  modes.ts      step kind -> API mode type, time granularity, input field -> API setting
  limits.ts     loads and checks the knowledge file; rejects conditions the validator could
                not evaluate and contradicting step description rules
  validate.ts   checks an input against the schema and every limit of the loaded file;
                errors carry a field path and a plain explanation for the correction round
  payload.ts    builds the API payload from a validated input; API keys, description rule
                and device type ids come from the loaded file
src/mc/
  transport.ts  website proxy envelope, headers, timeouts, session error classification;
                retries an idempotent call once when no response arrived, never a create
  session.ts    session provider interface (cookie source, renewal signal) and a static one
  client.ts     account calls: user, recipes, status, categories, ingredients, image upload;
                McRecipeSink is the narrow interface the pipeline will depend on
  image.ts      photo -> 16:9 JPEG variants (aspect from the knowledge file)
scripts/mc-smoke.ts   manual checks against a real account (whoami, categories, dry-run, create)
```

The Mealie side and ingredient handling:

- **`src/mealie`**: everything that talks to Mealie.
  - `webhook.ts` parses the recipe action body (snake_case) down to the recipe id and the scale (job flow step 1).
  - `client.ts` is the REST client: read a recipe and its image (step 2), find or create a tag, merge extras, tags and notes with GET, merge and PATCH, because PATCH replaces whole keys, and post timeline events and comments (step 7). The token never reaches a log.
  - `render.ts` turns the recipe and its scaled ingredients into German Markdown for the LLM (input to step 5).
  - `types.ts` holds the zod schemas of the recipe JSON (camelCase).
- **`src/ingredients`**: ingredient handling, independent of Mealie. It declares the row shape it reads, and Mealie's recipe rows satisfy it (step 4).
  - `units.ts` is the single unit vocabulary: codes, aliases, conversions, scaling kind and the labels the renderer writes.
  - `parse.ts` parses a free-text line deterministically. It is measured against the 260-line fixture set and a held-out set in `test/fixtures/ingredients/`.
  - `normalize.ts` takes structured rows as they are, parses free-text rows and keeps lines it cannot read as unparsed with their original text.
  - `scale.ts` applies the scale with per-unit-kind rounding and computes the servings.

```text
webhook  ->  client.getRecipe  ->  normalizeIngredients  ->  scaleIngredients  ->  renderRecipeForLlm
```

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

- **SQLite** (`/data/bridge.db`): `jobs` (status, attempts, errors, LLM input and output, token usage), `mc_recipes` (recipe id, scale, source hash, draft id and link) and `settings` (the encrypted session, last session check, category cache).
- **Knowledge base** (`knowledge/`, in the repository): tables and rules derived from public cooking guidance, written in our own words.
- **Local corpus** (optional, never committed): normalized example recipes used for retrieval at conversion time.

## Provider abstraction

A `RecipeGenerator` takes the prompts, the recipe JSON Schema and, on a correction round, the errors with the previous answer, and returns the answer as JSON text with its token usage. Each provider implements it with its own SDK and structured-output mechanism. The prompt builder, the Zod schema, the plausibility rules and the correction loop are shared, so adding a provider means one new file in `src/convert/providers` and a branch in `createGenerator`.
