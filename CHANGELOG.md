# Changelog

The project follows [semantic versioning](https://semver.org). A tag `vX.Y.Z` builds and publishes the image `ghcr.io/hudra0/mealie-mc-bridge` with the tags `X.Y.Z` and `X.Y`. Every push to `main` publishes `latest` and `sha-<commit>`. Until 1.0, a minor version may change settings or behaviour; such changes are listed here under "Changed" with what to do.

## Unreleased

First version, not tagged yet.

### Added

- Webhook for a Mealie recipe action: a click in Mealie queues a job for the recipe at the chosen scale, and a double click does not queue a second one.
- Conversion with OpenAI or Anthropic into the step format of the Monsieur Cuisine Smart, with the device limits, conversion rules and cooking techniques of a knowledge base distilled from published recipes.
- Validation of every answer against the device limits of each program and plausibility rules (heat-up time, bowl mass, turbo, whisk, kneading, steaming, step structure, completeness and amounts of the ingredients), with correction rounds that send the errors back to the model.
- Upload to the user's monsieur-cuisine.com account with the photo, as a draft that is then saved privately so it appears on the machine. `MC_RECIPE_STATUS=draft` stops after the draft.
- Ingredient ids from a catalog of published recipes, a local cache and the site's search (`MC_RESOLVE_INGREDIENTS`). The model gets close catalog names to pick from, and the catalog is tried once more without qualifiers such as "zum Garnieren"; search hits need the exact name.
- Write-back into Mealie: a tag, machine state in `extras` and a timeline entry with the link, servings, model and the points to check.
- A recipe that has not changed since it was last sent is not sent again while its Monsieur Cuisine recipe still exists; "Force rebuild" overrides this.
- Job queue in SQLite with a single worker, retries for temporary failures, recovery after a crash, and a point of no return before the draft is created so a recipe is never created twice.
- Session handling for the Monsieur Cuisine cookie: encrypted storage, an hourly check, a paused queue while the session is dead, and automatic continuation after a new cookie is pasted.
- Admin pages with the session form, the job list and log, retry, force rebuild, cancel and a dry run, protected by Basic Auth and against cross-site requests and DNS rebinding.
- Mail notifications for an expired session, a job that failed for good and a failing session check.
- `/health` with session, queue and worker state, and a container health check.
- Locale packs for the recipe language: `de-DE` (verified on a device) and `en-US` (generated, not verified on a device), selected with `MC_LOCALE`. Timeline entries, mails and admin pages in German or English, selected with `UI_LANGUAGE`.
- Command line tools: `npm run convert` (convert without uploading, and an evaluation against a local corpus), `npm run mc:smoke` (checks against your own account) and the corpus crawler and knowledge build.
- Docker image for linux/amd64 and linux/arm64, an example compose file, and a configuration reference in the README generated from the settings schema.

### Notes for pre-release builds

- Builds from `main` before localization read `TIMELINE_LANGUAGE`. Rename it to `UI_LANGUAGE`; the old name is ignored without a warning.
