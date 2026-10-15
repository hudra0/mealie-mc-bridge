# Changelog

The project follows [semantic versioning](https://semver.org). A tag `vX.Y.Z` builds and publishes the image `ghcr.io/hudra0/mealie-mc-bridge` with the tags `X.Y.Z` and `X.Y`. Every push to `main` publishes `latest` and `sha-<commit>`. Until 1.0, a minor version may change settings or behaviour; such changes are listed here under "Changed" with what to do.

## Unreleased

### Fixed

- Automatic login: a Lidl login page that opens asking for a phone number no longer stops the login. The bridge clicks the link to the e-mail address ("Verwende stattdessen deine E-Mail-Adresse" and its translations) and never touches the country selector or the phone field; before, it could open the country selector and end with "the login form was sent, but no session followed".
- The login follows the two Lidl steps: the e-mail address and "Weiter", then the password and "Weiter". Enter is pressed only in a visible e-mail or password field when the page has no button. An address the site does not know ends the attempt with its own reason, and the password is never typed into a page that offers a new account.
- On the first login, monsieur-cuisine.com can ask for its terms of use and the device. When the session has not come 10 seconds after the redirect, the login ticks the terms checkbox, confirms it, picks MC Smart and closes the hint next to the chooser. The settings page notes both ("Nutzungsbedingungen wurden in deinem Namen bestätigt").
- Less waiting: the consent dialog check returns as soon as the page has no dialog and looks at most 3 seconds (was 5), and the Lidl page gets at most 15 seconds to show its e-mail field.

## 0.2.1 (2026-10-15)

### Fixed

- Automatic login: a consent dialog on accounts.lidl.com (or the cookie banner on monsieur-cuisine.com) no longer blocks the form. After every navigation the login looks for such a dialog for up to 5 seconds and declines it, or closes it with its close button; it never clicks an accept button, also not as a welcome screen button. The decline words cover all site languages, independent of `MC_LOCALE`.
- The login fills only an enabled e-mail field, clicks "Weiter" (or "Continue" and the like) in a login in two steps, and after sending the form ends with a precise reason: a wrong password the site reports, another error message of the site, or a captcha or verification request. The settings page shows these reasons and notes a declined consent dialog; the screenshot of a failed attempt stays.

## 0.2.0 (2026-10-15)

### Added

- Automatic login: the settings page stores the Lidl account (encrypted with `SETTINGS_KEY`), and when the session expires the bridge logs in with a headless Chromium, at most hourly and three times a day, with backoff after failures. Failed attempts keep a screenshot and the reason, and the session mail then asks for a manual login. "Test login now" runs a login at once.
- `npm run mc:login`: a login helper for your computer that logs in in a browser with a persistent profile and sends the session to the bridge. `--headless` reuses the profile without a window, for scheduled runs; `--self-test` checks the browser.
- `POST /admin/api/session` and `GET /admin/api/session` for scripts, with Basic Auth or the login cookie.
- The serving size follows the Mealie yield: "10 Scheiben" in Mealie becomes 10 Scheiben on the machine, scaled with the recipe. A recipe without servings and yield gets an estimated serving size flagged as a point to check.
- Text steps get short action titles instead of the start of their text; a copied title goes back to the model once.
- Admin pages: an event timeline with relative times, a reload every 5 seconds while a job is queued or running, a dry-run form that converts in one step, coloured badges and narrow-screen layouts.

### Changed

- The admin pages use a login form and a signed session cookie (12 hours) instead of HTTP Basic Auth, with a logout button on every page. `ADMIN_USER` and `ADMIN_PASSWORD` stay the credentials. Scripts that called the pages with Basic Auth should use `/admin/api/session`.
- The Docker image includes a headless Chromium and its libraries and is a few hundred MB larger.
- The bridge exits at start with one log line when `DATA_DIR` is not writable or the database cannot be migrated, with the hint to `chown` the directory to uid 1000. `/health` answers 503 when the database or the data directory becomes unusable, and the container health check accepts only 200.
- Database migration 4 adds the serving unit to jobs; it runs on start.

## 0.1.0 (2026-10-14)

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
