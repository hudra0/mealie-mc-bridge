# Architecture

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
4. Normalize ingredients and scale them. Use structured fields first, parse free-text amounts with deterministic rules, and hand only the remainder to the LLM. Servings are limited to the range the device accepts.
5. Convert with the LLM into the intermediate recipe structure. Validate against the schema, the device limits and plausibility rules (heating rates, fill levels, times). Feed validation errors back for up to three correction rounds.
6. Convert the image, upload it and create the draft. The code sets the draft status, never the model.
7. Write the result back to Mealie: a tag, a link to the draft and any review hints as a timeline entry.
8. On failure, write the error to the timeline. If the Monsieur Cuisine session has expired, pause the job, flag it in the admin page, send a notification and resume the waiting jobs after the session is renewed.

## Data stores

- **SQLite** (`/data/bridge.db`): `jobs` (status, attempts, errors, LLM input and output, token usage), `mc_recipes` (recipe id, scale, source hash, draft id and link) and `settings` (the encrypted session, last session check, category cache).
- **Knowledge base** (`knowledge/`, in the repository): tables and rules derived from public cooking guidance, written in our own words.
- **Local corpus** (optional, never committed): normalized example recipes used for retrieval at conversion time.

## Provider abstraction

A `RecipeGenerator` interface takes the normalized recipe plus validator feedback and returns the intermediate recipe structure. Each provider implements it with its own SDK and structured-output mechanism. The prompt builder, the Zod schema and the validation loop are shared, so adding a provider does not touch the rest of the pipeline.
