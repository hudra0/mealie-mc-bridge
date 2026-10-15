# Changelog

The project follows [semantic versioning](https://semver.org). A tag `vX.Y.Z` builds and publishes the image `ghcr.io/hudra0/mealie-mc-bridge` with the tags `X.Y.Z` and `X.Y`. Every push to `main` publishes `latest` and `sha-<commit>`. Until 1.0, a minor version may change settings or behaviour; such changes are listed here under "Changed" with what to do.

## 0.3.2 (2026-10-16)

### Fixed

- When the Lidl page answers the login with "Die Kapazität wurde überschritten" (or "too many attempts", "try again later" and the like, in the sites' languages), the attempt ends as "rate limited" ("Lidl hat die Anmeldung vorübergehend gedrosselt") instead of "the site reported an error". The bridge then waits at least 60 minutes before the next automatic attempt and blocks "Test login now" for 60 minutes; the attempt does not count as a failure for the backoff. The message is also found when the page shows it outside its usual error elements.

### Changed

- The automatic login runs the full Chromium in its new headless mode instead of the headless shell, with the browser's own user agent without "HeadlessChrome", `--disable-blink-features=AutomationControlled`, a 1280x800 window at scale 1, the locale of `MC_LOCALE` with a matching `Accept-Language` header and the time zone of `TZ`. It types the e-mail address and the password one character at a time, 40 to 120 ms apart, and pauses 0.6 to 1.5 seconds before each field. When only the headless shell is installed (outside the image), it falls back to it.
- The Docker image installs the full Chromium (`playwright install --no-shell chromium`) instead of only the headless shell, so it grows by the difference between the two.
- Each attempt records the browser it ran in; the settings page shows it under the last attempt ("Browser: Chrome 141, headless (new mode)").

## 0.3.1 (2026-10-15)

### Fixed

- The automatic login no longer ends with "the browser timed out on the login page" when the Lidl consent dialog renders a moment after the page. It used to look for a dialog once after each navigation; it now looks before every fill, click and Enter and on every poll while it waits for the form, declines the dialog inside it (the exact "Ablehnen" first, a close control with an accessible name such as "Schließen" otherwise), never clicks a hidden element or an accept button, and waits up to 3 seconds for the dialog to go. An action gets 1 second first; when it times out, the login dismisses dialogs and tries once more with the full timeout.
- The invisible reCAPTCHA Enterprise frame the Lidl login page loads at once no longer counts as a captcha.
- The switch from the phone login to the e-mail address is found as a button, a link or any element with its text. The e-mail field is also found by its id `input-email`, and "Weiter" by its exact text before buttons that only start with it.

### Changed

- The automatic login pauses 300 to 700 ms between actions.
- Each attempt records the steps it reached: login page, consent dismissed (with a count), e-mail entered, continue clicked, password page, password entered, redirect, terms confirmed, device chosen, cookies received. The settings page lists them under the last attempt, and the reason of a failure ends with the last step reached ("stuck after: e-mail entered").

## 0.3.0 (2026-10-15)

Security hardening after an audit of 0.2.0; it applies to 0.2.1 and 0.2.2 as well. Read "What to do" before you upgrade: the bridge refuses to start until the admin credentials are set.

### What to do

- **Set `ADMIN_USER` and `ADMIN_PASSWORD`** (at least 12 characters). The bridge no longer starts without them. To keep open admin pages on a port only this machine reaches, set `ADMIN_AUTH=off` instead.
- **`HOST` now defaults to `127.0.0.1`** outside the container. The Docker image sets `BRIDGE_IN_CONTAINER=1`, which keeps `0.0.0.0` there, so Compose setups need no change. A local `npm start` that other machines must reach needs `HOST=0.0.0.0`. Remove `HOST=0.0.0.0` from an `.env` that does not need it.
- **Behind a reverse proxy, set `TRUST_PROXY`** to the proxy's address or network. `X-Forwarded-For` and `X-Forwarded-Proto` are ignored otherwise: the login throttle then counts every client as the proxy, and the session cookie is no longer marked `Secure` from a forged or untrusted header.
- **Check the new limits**: `JOB_DAILY_LIMIT` (50 jobs) and `JOB_DAILY_COST_LIMIT_USD` (10 USD of estimated model cost) per 24 hours, `LLM_MAX_RECIPE_KB` (40 kB of recipe text). Raise them if your household converts more.
- **Mail over `smtp://` now requires STARTTLS.** A server without it gets no mail; switch to `smtps://`, or set `SMTP_ALLOW_INSECURE=true` for a mail server on the same host.
- **If an automatic login failed before this upgrade, change your Lidl password.** Up to 0.2.2 the stored reason of a failed login could contain the browser's call log with the typed password, in `bridge.db`, the log, the settings page and the session mail. Migration 5 replaces the stored reason; old logs and mails keep what they had.
- Optional: take over the hardening of `compose.example.yml` (`init`, `read_only` with `tmpfs`, `cap_drop`, `no-new-privileges`, `pids_limit`, `mem_limit`).

### Changed

- The automatic login never passes a Playwright error message on. Browser failures become fixed texts (timeout, navigation, page element, launch), anything that looks like a call log is withheld, and the account's own e-mail address and password are masked in every stored reason, log line, page and mail.
- The automatic login types the Lidl account only into an https page whose host is exactly in `LIDL_LOGIN_HOSTS` (default `accounts.lidl.com`); a password field anywhere else ends the attempt as "unexpected page" with a screenshot.
- Each automatic login runs in a fresh browser profile under `DATA_DIR/tmp`, removed after the attempt. The persistent `browser-profile/` of 0.2.x is deleted on start, so no Lidl or Monsieur Cuisine session lives on disk outside the encrypted settings.
- Chromium starts with a minimal environment (`PATH`, `HOME`, `LANG`, `PLAYWRIGHT_BROWSERS_PATH`) instead of the bridge's, and a browser that does not close within 10 seconds is killed with its process group.
- The webhook rounds the scale to quarter steps and clamps it to 0.25 to 10 (it accepted any value up to 100), and answers 429 with a timeline entry on the recipe when a daily limit is reached.
- The admin pages send `Strict-Transport-Security` over HTTPS. The paid dry-run conversion is a form POST; the form token no longer appears in a URL.
- `GET /jobs/:id` no longer shows the title, slug, servings or the Monsieur Cuisine recipe link; the state and the log stay.
- Unexpected errors answer with a generic 500 body; the message stays in the log.
- The signed image upload goes only to https hosts on `MC_UPLOAD_HOSTS` (default `*.googleapis.com,*.tecpal.com`) and follows no redirect.
- Recipe images above 15 MB or 40 million pixels are skipped instead of decoded.
- The prompt puts the recipe between `<recipe>` delimiters and tells the model it is untrusted data whose instructions it must ignore.
- Outside Docker, the data directory and the screenshot directory are created with mode 700 and a new `bridge.db` with mode 600.
- The Docker image runs under tini.
- Database migration 5 replaces the stored reason of the last automatic login; it runs on start.

### Fixed

- A recipe with a numeric HTML entity above U+10FFFF (for example `&#9999999;`) no longer fails every job; such entities become U+FFFD.

### Added

- Settings `ADMIN_AUTH`, `TRUST_PROXY`, `JOB_DAILY_LIMIT`, `JOB_DAILY_COST_LIMIT_USD`, `LLM_MAX_RECIPE_KB`, `MC_UPLOAD_HOSTS`, `LIDL_LOGIN_HOSTS` and `SMTP_ALLOW_INSECURE`.
- A "Security" section in the README and `SECURITY.md` with the way to report vulnerabilities.
- gitleaks rules for SMTP URLs with credentials, the `wordpress_sec_` cookie and the bridge's secret settings with a value, with fixtures that prove each rule fires.

## 0.2.2 (2026-10-15)

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
