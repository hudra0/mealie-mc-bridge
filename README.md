# mealie-mc-bridge

Sends a recipe from your Mealie instance to a Monsieur Cuisine Smart as a guided-cooking recipe.

## What it does

The bridge is a small service that runs next to Mealie. Mealie hands it a recipe; a language model (OpenAI or Anthropic) rewrites the recipe into the step format of the machine, with programs, temperatures, times and speeds; the bridge checks the result against the device limits and a set of cooking rules, uploads it to your monsieur-cuisine.com account and reports back into Mealie. The recipe then shows up on your machine, private to your account.

1. In Mealie you open a recipe, set the servings, and pick "Send to Monsieur Cuisine" (whatever you named the action) from the three-dot menu.
2. Mealie posts the recipe id and the scale to the bridge, which queues a job and answers at once.
3. The bridge loads the recipe, scales the ingredients, has the model convert it, checks the answer (and lets the model correct it), and uploads the recipe with its photo.
4. The recipe is saved privately in your Monsieur Cuisine account, so it appears on the machine.
5. Mealie gets a tag on the recipe and a timeline entry with the link and the points you should check before you cook.

Status: 0.x releases, listed in [CHANGELOG.md](CHANGELOG.md). It runs end to end and is used with German recipes on a real machine. English output exists but has not been checked on a device yet. Every converted recipe is written by a language model, so check times and temperatures before you cook it.

## Requirements

- Docker with Compose, on a host that runs Mealie or shares a Docker network with it
- Mealie 3.x; on 3.26 and newer one extra setting is needed (`HTTP_ALLOW_LIST`, step 8 below)
- A Monsieur Cuisine account on www.monsieur-cuisine.com and a Monsieur Cuisine Smart linked to it
- An API key for OpenAI or Anthropic. Conversions are paid per use; see [Costs](#costs)

The image is published for linux/amd64 and linux/arm64. It carries a headless Chromium for the automatic login, which makes it a few hundred MB larger than a plain Node.js image.

## Quick start with Docker Compose

### 1. Get the files

```sh
mkdir mc-bridge && cd mc-bridge
curl -o compose.yml https://raw.githubusercontent.com/hudra0/mealie-mc-bridge/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/hudra0/mealie-mc-bridge/main/.env.example
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
```

Mealie calls the bridge and the bridge calls Mealie, so both need one Docker network. Pick a layout:

- **In Mealie's compose project (simplest).** Paste the `mc-bridge` service from `compose.yml` into Mealie's compose file, and put `data/` next to that file. Save the bridge's settings there as `mc-bridge.env` instead of `.env` and change the service's `env_file:` line to match: Compose reads a `.env` in the project directory for its own variables, and many Mealie setups keep theirs there. Do not merge the two files; Mealie reads some of the same variable names. Both services then share Mealie's default network. Wherever this guide says `.env`, use `mc-bridge.env`.
- **As its own project.** Keep `mc-bridge/compose.yml` and join Mealie's network: find its name with `docker network ls` (usually `<mealie directory>_default`), uncomment the two `networks:` blocks in `compose.yml` and put that name in.

### 2. Generate the secrets

```sh
docker run --rm ghcr.io/hudra0/mealie-mc-bridge:latest node dist/main.js generate-secrets
```

This prints a `SETTINGS_KEY` and a `WEBHOOK_TOKEN`. Put both into `.env`. `SETTINGS_KEY` encrypts the Monsieur Cuisine cookie and the Lidl account in `bridge.db`; keep a copy outside the server. `openssl rand -base64 32` and `openssl rand -hex 32` produce the same kind of values.

### 3. Create a Mealie user and API token

The bridge acts as a Mealie user. A dedicated one keeps its changes apart from yours:

1. In Mealie, create a user (for example `mc-bridge`) in the same household as the recipes. Give it the "advanced" flag, so it can create API tokens, and the permission to organize, so it can create the tag.
2. Log in as that user, open Profile, API Tokens, and create a token.
3. Put the token into `MEALIE_API_TOKEN` in `.env`.

The user needs edit rights on a recipe to tag it. Without them the bridge still writes the timeline entry, which needs no edit rights.

### 4. Fill in the rest of `.env`

- `MEALIE_URL`: how the bridge reaches Mealie on the Docker network, for example `http://mealie:9000`.
- `MEALIE_PUBLIC_URL`: the address you open in the browser, for example `https://mealie.example.com`, so links on the admin page and in mails work.
- `LLM_PROVIDER` and the key of that provider, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- `ADMIN_USER` and `ADMIN_PASSWORD` for the admin pages. Both are required, and the password needs at least 12 characters; the bridge does not start without them unless you set `ADMIN_AUTH=off`.
- `TZ`, for example `Europe/Berlin`, for the dates in timeline entries and mails.
- `MC_LOCALE` and `UI_LANGUAGE` (see [Languages](#languages)). The default `MC_LOCALE=de-DE` writes German recipes to the machine, and the admin pages, timeline entries and mails follow it in German. For English recipes set `MC_LOCALE=en-US` (not verified on a device yet); to keep German recipes but read English pages, set only `UI_LANGUAGE=en`. This guide names the English labels and gives the German ones in parentheses.
- Optional: the mail settings (see [Email notifications](#email-notifications)).

Every variable is listed in the [configuration reference](#configuration-reference).

### 5. Start it

```sh
docker compose up -d mc-bridge
curl http://127.0.0.1:3000/health
```

`/health` answers with `"status": "degraded"` and the session state `invalid` until the next step. That is expected. If mail is configured, this first check also sends a mail that the session does not work; ignore it. If the container does not start, `docker compose logs mc-bridge` names the setting it rejects; values are never printed.

### 6. Connect the Monsieur Cuisine session

Open the admin pages at `http://127.0.0.1:3000/admin` and log in with `ADMIN_USER` and `ADMIN_PASSWORD`. The example compose file publishes the port on localhost only. To reach the pages from another machine, put a reverse proxy with TLS in front, as described under [Security](#security): over plain HTTP the admin password, the session cookie and the Lidl password cross the network readable. Keep it off the internet.

Open Settings ("Einstellungen"), enter the e-mail address and password of your Lidl account for monsieur-cuisine.com and press "Test login now" ("Anmeldung jetzt testen"). The bridge logs in in a headless browser, checks the session against your account and stores it; the session state turns `valid`. If that does not work, use the login helper or paste the cookie, as described under [Monsieur Cuisine session](#monsieur-cuisine-session).

### 7. Create the recipe action in Mealie

In Mealie, open Settings, Data Management, pick "Recipe Actions" and add one:

- Title: for example "Send to Monsieur Cuisine"
- Type: `post`
- URL: `http://mc-bridge:3000/hooks/mealie/<WEBHOOK_TOKEN>`

The host is the bridge's service name on the Docker network, not `localhost` and not the published port. Actions belong to a household; every household that wants the button needs its own. Every member of the household can see the action's URL, with the token, and use it; the daily limits (`JOB_DAILY_LIMIT`, `JOB_DAILY_COST_LIMIT_USD`) cap what that can cost. See [Security](#security).

### 8. Allow the bridge on Mealie 3.26 and newer

From 3.26 on, Mealie refuses to post to private addresses that are not on its allow list, and it does so without telling you. Add the bridge's host name to Mealie's environment and recreate the Mealie container:

```yaml
HTTP_ALLOW_LIST: "mc-bridge"
```

The value is the bare host name, without scheme or port. A CIDR of the Docker network works as well. Older Mealie versions ignore the variable, so it does no harm to set it before an upgrade.

Check that Mealie reaches the bridge by name:

```sh
docker exec mealie python -c "import urllib.request as u; print(u.urlopen('http://mc-bridge:3000/health').read().decode())"
```

Replace `mealie` with the name of your Mealie container (`docker ps`). An error here means the two are not on one network.

### 9. Send a first recipe

Open a recipe in Mealie, pick the action and watch the job on the admin page (Jobs, "Aufträge"). A conversion takes one to a few minutes. Then:

- On the machine, the recipe is in your own recipes ("Meine Rezepte" on a German device). It is saved privately: nobody else sees it, and it is not submitted for publication.
- On monsieur-cuisine.com, it is in the recipe editor of your account. The timeline entry links to it.
- In Mealie, reload the recipe page: the recipe carries the tag `Monsieur Cuisine`, and its timeline (the clock icon in the recipe header) has an entry with the link, the servings, the model and the points to check.

Mealie shows "Message sent" ("Daten gesendet") as soon as it accepted the click, whatever the bridge does afterwards. If no job appears on the admin page, see [Troubleshooting](#troubleshooting).

## Configuration reference

The bridge reads its settings from the environment; Compose passes `.env` through `env_file`. The bridge treats an empty value as unset, but an empty line in `.env` still overrides a variable the image sets (`DATA_DIR`, `NODE_ENV`), so leave those out. The service refuses to start when a required setting is missing or a value is invalid, and names the setting. Generated from `src/config.ts` by `npm run docs:config`; a test fails when this table and the schema disagree.

<!-- config-reference:start -->

| Variable                   | Default                              | Values                                                       | Description                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                     | `3000`                               | integer 1 to 65535                                           | TCP port the bridge listens on. The image's health check reads it too.                                                                                                                                                                                                                                                                                                                               |
| `HOST`                     | `127.0.0.1`; `0.0.0.0` in the image  |                                                              | Interface to listen on. Outside a container the bridge answers on this machine only unless you set it; in the container the port mapping in the compose file decides who reaches it.                                                                                                                                                                                                                 |
| `BRIDGE_IN_CONTAINER`      | `1` in the image                     |                                                              | Set by the Docker image; makes `HOST` default to `0.0.0.0`. Leave it alone.                                                                                                                                                                                                                                                                                                                          |
| `LOG_LEVEL`                | `info`                               | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | Log verbosity. `debug` logs every request to Mealie and Monsieur Cuisine. Secrets are masked at every level.                                                                                                                                                                                                                                                                                         |
| `TZ`                       | UTC in the image                     |                                                              | Time zone of the dates in timeline entries, mails and the admin pages, for example `Europe/Berlin`. Read by Node.js itself.                                                                                                                                                                                                                                                                          |
| `DATA_DIR`                 | `./data`                             |                                                              | Directory of `bridge.db`. The image sets `/data`. Do not set it in `.env` with Docker: even an empty line overrides the image's value, and the bridge then falls back to `./data` inside `/app`.                                                                                                                                                                                                     |
| `SETTINGS_KEY`             | **required**                         |                                                              | Base64 of 32 random bytes; `generate-secrets` prints one. Encrypts the Monsieur Cuisine cookie and the Lidl account in `bridge.db`. With another key they cannot be read, and you enter them again.                                                                                                                                                                                                  |
| `WEBHOOK_TOKEN`            | **required**                         |                                                              | Secret path segment of the webhook, `/hooks/mealie/<WEBHOOK_TOKEN>`. At least 32 characters of letters, digits and `. _ ~ -`.                                                                                                                                                                                                                                                                        |
| `MEALIE_URL`               | **required**                         |                                                              | How the bridge reaches Mealie, for example `http://mealie:9000` on a shared Docker network. An http or https URL.                                                                                                                                                                                                                                                                                    |
| `MEALIE_API_TOKEN`         | **required**                         |                                                              | API token of the Mealie user the bridge acts as. A secret.                                                                                                                                                                                                                                                                                                                                           |
| `MEALIE_PUBLIC_URL`        | `MEALIE_URL`                         |                                                              | How you open Mealie in the browser, for example `https://mealie.example.com`. Used for links on the admin pages and in mails.                                                                                                                                                                                                                                                                        |
| `MEALIE_GROUP_SLUG`        | `home`                               |                                                              | The part after `/g/` in your Mealie recipe URLs, for those links.                                                                                                                                                                                                                                                                                                                                    |
| `TAG_NAME`                 | `Monsieur Cuisine`                   |                                                              | Tag the bridge adds to every recipe it sent, 1 to 60 characters.                                                                                                                                                                                                                                                                                                                                     |
| `MC_LOCALE`                | `de-DE`                              |                                                              | Language of the recipes the bridge writes, and the Monsieur Cuisine settings of that language. Needs a locale pack in `KNOWLEDGE_DIR/locales/`: `de-DE` (verified on a device) or `en-US` (not verified).                                                                                                                                                                                            |
| `UI_LANGUAGE`              | language of `MC_LOCALE`, else `en`   | `de`, `en`                                                   | Language of timeline entries, mails and admin pages.                                                                                                                                                                                                                                                                                                                                                 |
| `MC_RECIPE_STATUS`         | `private-publish`                    | `draft`, `private-publish`                                   | What happens after the draft is created. `private-publish` saves the recipe on your device only, which makes it show up on the machine. `draft` leaves it in the web editor, where the machine does not see it; for debugging.                                                                                                                                                                       |
| `MC_RESOLVE_INGREDIENTS`   | `exact`                              | `exact`, `off`                                               | How ingredients get their Monsieur Cuisine ingredient id, which the app uses for the shopping list. `exact`: bundled catalog, also without qualifiers like "zum Garnieren", local cache, then the site's search. `off`: none.                                                                                                                                                                        |
| `MC_COOKIE`                | unset                                |                                                              | Cookie header of a logged-in monsieur-cuisine.com browser session. A secret. Stored on the first start and whenever the value changes; the admin page can replace it at any time.                                                                                                                                                                                                                    |
| `SESSION_CHECK_MINUTES`    | `60`                                 | integer 1 to 1440                                            | Minutes between session checks. Each check is a cheap account call.                                                                                                                                                                                                                                                                                                                                  |
| `DEVICE_PROGRAMS_PATH`     | `./knowledge/device-programs.json`   |                                                              | Device limits the validator enforces. A relative path resolves against the working directory, `/app` in the image.                                                                                                                                                                                                                                                                                   |
| `LLM_PROVIDER`             | `openai`                             | `openai`, `anthropic`                                        | Language model provider that converts the recipes.                                                                                                                                                                                                                                                                                                                                                   |
| `OPENAI_API_KEY`           | required with `openai`               |                                                              | OpenAI API key. A secret. Checked when a conversion runs, so a missing key fails the job, not the start.                                                                                                                                                                                                                                                                                             |
| `OPENAI_MODEL`             | `gpt-6.1-sol`                        |                                                              | OpenAI model. Any Responses API model with strict JSON schema support works; check that your account offers the default.                                                                                                                                                                                                                                                                             |
| `OPENAI_REASONING_EFFORT`  | `medium`                             | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`   | Reasoning effort of the OpenAI model.                                                                                                                                                                                                                                                                                                                                                                |
| `ANTHROPIC_API_KEY`        | required with `anthropic`            |                                                              | Anthropic API key. A secret. Checked when a conversion runs.                                                                                                                                                                                                                                                                                                                                         |
| `ANTHROPIC_MODEL`          | `claude-opus-5-5`                    |                                                              | Anthropic model; check that your account offers the default. The effort is fixed at `high`.                                                                                                                                                                                                                                                                                                          |
| `LLM_MAX_CORRECTIONS`      | `3`                                  | integer 0 to 10                                              | Correction rounds after the first answer when the recipe fails the checks. Each round is another paid model call.                                                                                                                                                                                                                                                                                    |
| `KNOWLEDGE_DIR`            | `./knowledge`                        |                                                              | Knowledge base the converter reads, with the locale packs under `locales/<locale>/`. A relative path resolves against the working directory.                                                                                                                                                                                                                                                         |
| `LLM_PRICES_JSON`          | unset                                |                                                              | Token prices in USD per million tokens for the cost estimate, merged over the built-in table, for example `{"gpt-5.5": {"input": 5, "cachedInput": 0.5, "output": 30}}`.                                                                                                                                                                                                                             |
| `WORKER_POLL_SECONDS`      | `2`                                  | number above 0 to 60                                         | Seconds between queue polls. A webhook call wakes the worker at once.                                                                                                                                                                                                                                                                                                                                |
| `ADMIN_USER`               | **required** unless `ADMIN_AUTH=off` |                                                              | User of the admin login form (and of Basic Auth on `/admin/api/`). Set it together with `ADMIN_PASSWORD`.                                                                                                                                                                                                                                                                                            |
| `ADMIN_PASSWORD`           | **required** unless `ADMIN_AUTH=off` |                                                              | Password of the admin login, at least 12 characters. A secret. It travels to the bridge on every login, so put a TLS reverse proxy in front when the admin pages leave the machine.                                                                                                                                                                                                                  |
| `ADMIN_AUTH`               | `on`                                 | `on`, `off`                                                  | `off` lets the bridge start without `ADMIN_USER` and `ADMIN_PASSWORD`; then anyone who reaches the port can use the admin pages, replace the session and store a Lidl account. Only for a port that answers on this machine alone.                                                                                                                                                                   |
| `ADMIN_HOSTS`              | unset                                |                                                              | Host names the admin pages answer to, comma-separated, without ports. IP addresses and `localhost` always work. Without a login other names are refused, which blocks DNS rebinding.                                                                                                                                                                                                                 |
| `TRUST_PROXY`              | `false`                              |                                                              | Reverse proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` the bridge believes: `false`, `true` (any sender, only when nothing but the proxy reaches the port) or a comma-separated list of proxy addresses or CIDR ranges, for example `192.0.2.0/24`. Behind a proxy it gives the login throttle the real client address, and over HTTPS it marks the session cookie `Secure` and sends HSTS. |
| `JOB_DAILY_LIMIT`          | `50`                                 | integer 0 to 100000                                          | Jobs the webhook accepts in 24 hours, counted over every recipe; above it Mealie gets 429 and the recipe's timeline says why. `0` turns the limit off.                                                                                                                                                                                                                                               |
| `JOB_DAILY_COST_LIMIT_USD` | `10`                                 | number 0 to 100000                                           | Estimated language model cost in USD of the jobs of the last 24 hours at which the webhook stops accepting jobs. `0` turns the limit off. The estimate uses the price table (`LLM_PRICES_JSON`).                                                                                                                                                                                                     |
| `LLM_MAX_RECIPE_KB`        | `40`                                 | integer 1 to 1000                                            | Largest recipe text, in kB, sent to the language model. A longer recipe fails its job with a message instead of being sent.                                                                                                                                                                                                                                                                          |
| `MC_UPLOAD_HOSTS`          | `*.googleapis.com,*.tecpal.com`      |                                                              | Hosts the signed image upload URL from Monsieur Cuisine may point to, comma-separated; `*.example.com` covers the subdomains. Other hosts get no image bytes, and the upload follows no redirect.                                                                                                                                                                                                    |
| `LIDL_LOGIN_HOSTS`         | `accounts.lidl.com`                  |                                                              | Hosts of the Lidl login page, comma-separated and matched exactly. The automatic login types the account only into an https page on one of them; a password field anywhere else ends the attempt.                                                                                                                                                                                                    |
| `SMTP_URL`                 | unset                                |                                                              | `smtp://` or `smtps://` URL with credentials, for example `smtps://user:password@mail.example.com:465`. `smtp://` must upgrade with STARTTLS. Without it no mail is sent.                                                                                                                                                                                                                            |
| `SMTP_ALLOW_INSECURE`      | `false`                              |                                                              | `true` lets `smtp://` send without STARTTLS, password and mails in plain text; only for a mail server on the same host or a trusted network.                                                                                                                                                                                                                                                         |
| `NOTIFY_EMAIL`             | required with `SMTP_URL`             |                                                              | Recipient of the mails: session expired or invalid, a job failed for good, the session check keeps failing.                                                                                                                                                                                                                                                                                          |
| `SMTP_FROM`                | `NOTIFY_EMAIL`                       |                                                              | Sender address of the mails.                                                                                                                                                                                                                                                                                                                                                                         |
| `NODE_ENV`                 | `production` in the image            |                                                              | Anything but `production` makes `npm run dev` and `npm start` read `.env` from the working directory; variables already set win.                                                                                                                                                                                                                                                                     |

<!-- config-reference:end -->

## Monsieur Cuisine session

Monsieur Cuisine has no public API for writing recipes. The bridge uses the same internal API as the recipe editor on www.monsieur-cuisine.com, with the session cookies of a logged-in browser. There are three ways to give it that session, best first:

1. **Settings page (recommended).** Store your Lidl account; the bridge logs in by itself whenever the session expires.
2. **Login helper.** `npm run mc:login` logs in in a browser on your computer and sends the session to the bridge.
3. **Cookie paste.** Copy the `Cookie` header from your browser's developer tools and paste it on the settings page.

Whichever way, the bridge checks the cookie with a separate request before it stores it, encrypted with `SETTINGS_KEY`. A cookie Monsieur Cuisine rejects is not stored, and the working session stays in place. The cookie is a secret: anyone who has it can change the recipes in your account. Keep it out of chats, screenshots and issue reports.

### Automatic login with your Lidl account

On Settings ("Einstellungen") the bridge stores the e-mail address and password of your Lidl account, encrypted with `SETTINGS_KEY` like the cookie. The password is never shown again or logged; leave the field empty to keep it when you change the address. "Delete account" ("Konto löschen") removes both and the screenshots of failed logins.

When Monsieur Cuisine rejects the session, the bridge opens the site's login in a headless Chromium inside the container, signs in on the Lidl page, waits for the login cookies and checks them against your account. The Lidl login takes two steps: the e-mail address and "Weiter", then the password and "Weiter". When the page opens asking for a phone number, the bridge switches it to the e-mail address; it never touches the country selector or the phone field. Consent dialogs on the Lidl pages and on monsieur-cuisine.com are declined (or closed) on the way, in any of the sites' languages; the bridge never accepts them. The waiting jobs then continue, and no mail goes out. Each attempt runs in a fresh browser profile under `tmp/` in the data directory, which is removed when the attempt ends, so no Lidl session stays on disk. The browser types the account only into an https page on `accounts.lidl.com` (`LIDL_LOGIN_HOSTS`); a password field anywhere else ends the attempt as "unexpected page", with a screenshot. It runs with a minimal environment that holds none of the bridge's keys.

On the first login with an account, monsieur-cuisine.com may ask you to accept its terms of use and to choose your device before it starts a session. The automatic login then ticks the terms checkbox and confirms it on your behalf, and picks MC Smart. The settings page says so under the last attempt ("The terms of use were confirmed on your behalf"). To read and accept them yourself, log in once on monsieur-cuisine.com before you store the account.

A login on a third-party site should stay rare, so the bridge limits it: one at a time, an automatic attempt at most once per hour and three times in 24 hours, and after a failure it waits 1 hour, after two failures in a row 4 hours, after three 24 hours. When the session breaks while the automatic login has to wait, you get the session mail with the time of the next attempt. "Test login now" skips these waiting times, but not a login that is already running, and it runs at most every 3 minutes; manual tests count neither toward the daily limit nor toward the waiting times after failures.

A wrong password, an unknown e-mail address, a captcha, a second factor or a changed page stops the login. When the site names a wrong password or an unknown address, or asks for a captcha or a code, the reason says so; the bridge never types the password into a page that offers to create a new account. The settings page then shows the time, the reason and a screenshot of the page (the last five stay in `login-screenshots/` in the data directory), and the session mail says that a manual login is needed: use the login helper or paste the cookie. A screenshot can show the Lidl account page with your e-mail address; it is served to the logged-in admin only. The reason never contains the browser's own error text, which can carry the typed password.

Without Chromium in the image (a self-built image without it, or an unusual platform) the settings page says the browser is not available; everything else works.

### Renewing the session with the login helper

The helper runs on your computer, from a clone of this repository:

```sh
npm ci
npm run mc:login -- --bridge http://<bridge address>:3000
```

It opens a browser window on the Monsieur Cuisine login. Log in with your Lidl account; the helper waits up to 10 minutes, checks the new session against your account and sends it to the bridge (`POST /admin/api/session`) with `ADMIN_USER` and `ADMIN_PASSWORD`. The password comes from the `ADMIN_PASSWORD` environment variable or a prompt that does not echo, and the helper never prints the cookie. `--user` sets another admin user.

The browser is an installed Google Chrome when the helper finds one, otherwise Playwright's Chromium: install it once with `npx playwright install chromium`, or force it with `--chromium`. `npm run mc:login -- --self-test` opens the public recipe list without logging in, to check that the browser starts.

The browser profile stays in `local/mc-login-profile` (`--profile` sets another directory), so the Lidl login survives between runs. `--headless` reuses it without a window: when the Lidl login in the profile is still valid, the helper gets a new session without any input; otherwise it exits with code 1 and asks you to log in once with a window. Run it on a schedule (cron, or the Windows Task Scheduler) to keep the bridge's session fresh for as long as the profile's Lidl login lasts:

```sh
ADMIN_PASSWORD='...' npm run mc:login -- --bridge http://<bridge address>:3000 --headless
```

### Get the cookie by hand

1. Log in on www.monsieur-cuisine.com and open "Create recipe".
2. Open the browser's developer tools (F12), Network tab, and reload the page.
3. Pick any request whose URL contains `proxy-api` and copy the value of its `Cookie` request header. In Chrome and Edge it is under Headers, Request Headers; in Firefox under Headers, Request Headers with "Raw" switched on.
4. Paste it into the form under Settings ("Einstellungen"), Monsieur Cuisine session, and press "Save session" ("Sitzung speichern").

Instead of the form you can set `MC_COOKIE` in `.env`. The bridge stores it on the next start, and again whenever that value changes; a cookie pasted on the admin page later wins until you change `MC_COOKIE`. Wrap the value in single quotes in `.env`, so Compose leaves characters like `$` alone.

### How long it lasts

The login cookies carry an expiry date 14 days after the login. Without a stored Lidl account, expect to renew the session about every two weeks. Logging out on the website may end it earlier, so close the tab after copying the cookie instead of logging out.

The bridge checks the session on start and then every `SESSION_CHECK_MINUTES` (60 by default) with a cheap account call. "Check now" ("Jetzt prüfen") on the settings page runs the check at once; that page shows the state, the time of the last check, the age of the cookie and when the login behind it ends.

### When it expires

When Monsieur Cuisine rejects the cookie:

- the overview and the settings page show the session as `expired` or `invalid`, and `/health` reports `degraded`
- the worker stops taking jobs; queued jobs and jobs that hit the dead session move to "session expired" instead of failing
- Mealie gets a timeline entry on the recipe saying the job waits for a new session
- with a stored Lidl account, the automatic login runs; without one, or when it fails, you get one mail, if mail is configured

Once a new session is stored, the waiting jobs run on their own. A check that fails for another reason, such as the site being down, leaves the state alone and sends one mail per failure streak.

## Languages

Monsieur Cuisine publishes recipes in several languages, and each recipe carries its language. The bridge keeps three languages apart:

| What                        | Setting                      | What it decides                                                                                                                                                                                                          |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Mealie recipe           | none                         | The model reads any language; ingredient lines are parsed in German and English.                                                                                                                                         |
| The Monsieur Cuisine recipe | `MC_LOCALE`, default `de-DE` | The language of steps and ingredients, their units and standard phrases, the ingredient catalog, and what Monsieur Cuisine needs per language: `languageLocale`, complexity ids, the editor link, the language of calls. |
| What you read               | `UI_LANGUAGE`, `de` or `en`  | Timeline entries in Mealie, mails and admin pages. Defaults to the language of `MC_LOCALE` when there are texts for it, otherwise English. Logs and command line output are English.                                     |

`MC_LOCALE` needs a locale pack in `knowledge/locales/<locale>/`; the bridge refuses to start with a locale it has no pack for and lists the ones it has. Two packs ship:

- `de-DE` is verified: recipes created with it show up and cook on a Monsieur Cuisine Smart, and the settings were checked against the web editor.
- `en-US` is generated from the 1015 English MC Smart recipes of the public recipe API and marked `verifiedOnDevice: false`. Its complexity ids and editor path come from another project's source and are unchecked, and its default ingredient group name is a translation. The bridge logs a warning on start with an unverified pack. Check the first recipes in the web editor before you cook them, and please report what you find.

A Mealie recipe in English can become a German Monsieur Cuisine recipe, or the other way round. The checks never compare ingredient names across languages; the model says which Mealie ingredient line each of its ingredients comes from, and amounts are compared along that mapping. Adding a language is a data change; see "Adding a language" in `CONTRIBUTING.md`.

## How conversion works

The worker renders the scaled Mealie recipe as Markdown with numbered ingredient lines and sends it to the model, together with the device limits, conversion rules and the cooking techniques the recipe needs from the [knowledge base](#knowledge-base). The model answers with structured JSON in the recipe format of the device. Two layers check the answer:

- the validator, against the hard limits of every device program in `knowledge/device-programs.json`
- plausibility rules for what a limit table cannot see: heat-up time against the bowl content, at most 3000 g in the bowl, turbo only on cool contents, speed 4 at most with the whisk, flour per kneading step, water under the steamer, a text step before every program step, every source ingredient used, amounts neither larger nor smaller than in the source

The serving size follows the Mealie recipe: a yield with a text ("10 Scheiben", "12 Muffins") becomes the serving size on the machine, scaled with the recipe; servings alone become portions ("Portionen" in German); a recipe with neither gets a serving size the model estimates and flags as a point to check.

Errors go back to the model with its previous answer, up to `LLM_MAX_CORRECTIONS` times. Warnings do not trigger a correction; they go into the timeline entry next to the model's own review hints. A text step title that copies the start of its description, or one longer than 60 characters, goes back to the model once; after that round the recipe is accepted and the title problem is reported as a warning.

| `LLM_PROVIDER` | Key                 | Model settings                                                                       | How it asks for JSON                                                     |
| -------------- | ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `openai`       | `OPENAI_API_KEY`    | `OPENAI_MODEL` (default `gpt-6.1-sol`), `OPENAI_REASONING_EFFORT` (default `medium`) | Responses API with a strict JSON schema                                  |
| `anthropic`    | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default `claude-opus-5-5`), effort fixed at `high`                | Structured output, cached system prompt, server-side fallback on refusal |

The defaults are the models the bridge was written against; check that your account offers them.

Two more steps happen around the conversion:

- **Already sent.** A recipe that has not changed since it was last sent at the same scale is not converted again; the timeline entry points to the existing recipe. "Force rebuild" ("Neu senden erzwingen") on the admin page sends it anyway.
- **Ingredient ids.** Published Monsieur Cuisine recipes link each ingredient to an id of the site's ingredient database, which the app uses for the shopping list. With `MC_RESOLVE_INGREDIENTS=exact` (the default) the bridge looks each name up in a catalog built from published recipes, then in a local cache, then in the site's search, and takes an id only for the same name; in the catalog it also tries the name without trailing usage words such as "zum Garnieren" and with singular and plural folded, and before the conversion the model gets up to three catalog names per ingredient to pick from. It never guesses: "Karotten" gets no id, because published recipes say "Möhren". Names without a match go out without an id; the job page lists them. A recipe without ids cooks the same.

The job flow, the job states and the modules are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Operations

### Admin pages

Overview ("Übersicht") has a getting-started checklist (Mealie reachable, session valid, automatic login, the recipe action URL to paste into Mealie, first recipe sent), the queue, the last ten jobs and the last error. Jobs ("Aufträge") lists every job with duration and cost; a job page shows its timeline, the points to check before cooking, and which ingredients got a Monsieur Cuisine id. Dry run ("Probelauf") converts a recipe without uploading it. Settings ("Einstellungen") holds the session, the automatic login and a read-only view of the effective configuration, secrets hidden. A failed job can be retried; "Force rebuild" sends the recipe again even if it has not changed; queued jobs can be cancelled. Temporary failures (network, server errors) are retried three times with a pause of 2, 4 and 8 seconds. Validation and conversion failures are not retried automatically, and neither is creating the recipe on Monsieur Cuisine, so a timeout never leaves two copies behind.

"Dry run" ("Probelauf") shows what the converter would get for a Mealie recipe and, on request, runs the conversion without uploading anything. That conversion is a paid model call; it is a form submission (POST), never a link.

The pages need a login with `ADMIN_USER` and `ADMIN_PASSWORD`. A correct login sets a session cookie for 12 hours (HttpOnly, SameSite=Lax, signed with a key derived from `SETTINGS_KEY`); "Log out" ("Abmelden") on every page ends every session issued until then, on every device, and a new `ADMIN_PASSWORD` does the same. Five failed logins from one address within 15 minutes, on the form or with Basic Auth on the API, lock that address out for the rest of those 15 minutes. Behind a reverse proxy every client shares the proxy's address, so set `TRUST_PROXY` to the proxy's address: the throttle then counts per client, and over HTTPS the cookie gets the `Secure` flag and the pages send `Strict-Transport-Security`. The job list and a job page reload every 5 seconds while a job is queued or running.

With `ADMIN_AUTH=off` and no credentials the admin pages are open to anyone who reaches the port, and they answer only to an IP address, `localhost` or a host name listed in `ADMIN_HOSTS`.

`/admin/api/session` is the one endpoint for scripts: `GET` returns the session state as JSON, `POST` with `{"cookie": "..."}` checks and stores a new cookie like the form on the settings page. Both take HTTP Basic Auth with `ADMIN_USER` and `ADMIN_PASSWORD` or the login cookie, and `POST` needs `Content-Type: application/json`. The login helper uses it.

### Logs

The bridge logs JSON lines to stdout: `docker compose logs -f mc-bridge`. Set `LOG_LEVEL=debug` to see every request to Mealie and Monsieur Cuisine. Cookies, tokens, keys and the webhook token in the URL are masked.

### Health endpoint

`GET /health` needs no login and answers 200 with:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "session": { "state": "valid", "checkedAt": "2026-01-01T12:00:00.000Z" },
  "queue": { "depth": 0, "running": 0, "waitingForSession": 0 },
  "worker": { "running": true, "paused": false },
  "lastError": null
}
```

`status` is `degraded` while the session is `invalid` or `expired` or the worker is stopped. A restart fixes neither, so the container health check fails only when the bridge stops answering or its store is unusable: the database does not answer, or the data directory or `bridge.db` is no longer writable. Then `/health` answers 503 and the Docker health check counts that as a failure. `lastError` carries only the time of the last worker error; the message is on the overview.

`GET /jobs/<id>` returns one job as JSON: `id`, `status`, `recipeId`, `scale`, `attempts`, `error`, `createdAt`, `updatedAt`, `finishedAt` and the log (`events`, each with `ts`, `level` and `message`). It needs no login either; job ids are random UUIDs that appear in the bridge's pages, logs and failure mails, and in its answer to Mealie. Anyone who has a job id can read that job's log, which names the recipe. The link to the recipe in your Monsieur Cuisine account is on the admin pages only.

### Data directory and backups

Everything the bridge keeps is in `bridge.db` in the data directory (`/data` in the container): jobs and their logs, the list of sent recipes, the encrypted session and Lidl account, the category cache and the ingredient id cache. Next to it are `login-screenshots/` (pages of failed logins) and, while a login runs, its temporary browser profile in `tmp/`. Outside Docker the bridge creates the directory with mode 700 and a new `bridge.db` with mode 600. The container runs as uid and gid 1000 and needs to write the directory; on start it checks that and exits with one log line that says what to do. The database runs in WAL mode, so back up the whole directory with the container stopped, or take a consistent copy while it runs:

```sh
docker compose exec mc-bridge node -e "require('better-sqlite3')('/data/bridge.db').backup('/data/backup.db').then(() => console.log('done'))"
```

This writes `backup.db` into `data/` next to the database. Keep `SETTINGS_KEY` with the backup, but not in the same place; without it the stored cookie and Lidl account cannot be read, and you would enter them again. What a backup holds is listed under [Security](#security).

### Upgrading and migrations

```sh
docker compose pull mc-bridge
docker compose up -d mc-bridge
```

Schema migrations run on start, each in its own transaction. A database written by a newer release is refused rather than guessed at, so back up `data/` before an upgrade if you might roll back. Stopping the container hands a running job back to the queue, unless the job is already creating the recipe on Monsieur Cuisine; give it the `stop_grace_period` of the example compose file.

`latest` follows the `main` branch. A release image carries the tags `X.Y.Z` and `X.Y`; see [CHANGELOG.md](CHANGELOG.md) for what changed and what to do. Builds of `main` carry a `sha-<commit>` tag on the [package page](https://github.com/hudra0/mealie-mc-bridge/pkgs/container/mealie-mc-bridge). To run exactly the image you checked, pin its digest: `image: ghcr.io/hudra0/mealie-mc-bridge:X.Y.Z@sha256:<digest>` (`docker buildx imagetools inspect ghcr.io/hudra0/mealie-mc-bridge:X.Y.Z` prints it).

### Email notifications

Set `SMTP_URL` (for example `smtps://user:password@mail.example.com:465`) and `NOTIFY_EMAIL`. `SMTP_FROM` sets the sender; it defaults to the recipient. Prefer `smtps://`; with `smtp://` the bridge requires STARTTLS and refuses to send in plain text, unless `SMTP_ALLOW_INSECURE=true` (for a mail server on the same host). The bridge mails when the session stops working (once per change), when a job fails for good (once per job) and when the session check itself keeps failing, for example because the site is down. Mails are short plain text in `UI_LANGUAGE` and never contain cookies, tokens or passwords.

## Security

The bridge holds keys to three accounts: your Monsieur Cuisine session, your Lidl account (with the automatic login) and your language model API key. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

**What crosses the network.** The bridge speaks plain HTTP. On a LAN without a TLS proxy, anyone who can read the traffic sees the admin password at every login, the session cookie of the admin pages, a Monsieur Cuisine cookie you paste, the Lidl password you store on the settings page, the Basic Auth of `npm run mc:login` and the webhook token in Mealie's calls (when Mealie and the bridge do not share a Docker network). The bridge itself talks HTTPS to Monsieur Cuisine, Lidl and the model provider; `MEALIE_URL` is whatever you set.

**Reverse proxy with TLS.** Keep the published port on `127.0.0.1` (as in the example compose file) and reach the admin pages through a reverse proxy with a certificate, for example Caddy, Traefik or nginx on the same host. Then set `ADMIN_HOSTS` to the proxy's host name and `TRUST_PROXY` to the address the proxy connects from (its container address or the Docker network, for example `192.0.2.0/24`), so the login throttle sees the real client and the session cookie is marked `Secure`. Mealie keeps calling the bridge directly over the Docker network. Never publish the bridge on the internet.

**Who can use the webhook.** The recipe action's URL contains `WEBHOOK_TOKEN`, and Mealie shows it to every member of the household, and to their API tokens. Each of them can start conversions (paid model calls) and drafts in your Monsieur Cuisine account. The bridge accepts at most `JOB_DAILY_LIMIT` jobs (50) and stops at `JOB_DAILY_COST_LIMIT_USD` (10 USD) of estimated model cost in 24 hours; a refused click gets a 429 and a timeline entry on the recipe. The scale is rounded to quarter steps between 0.25 and 10, and a recipe text above `LLM_MAX_RECIPE_KB` (40 kB) is not sent. Change the token when someone leaves the household. Set a spending limit at your provider as well.

**Recipes are untrusted input.** Recipes come from arbitrary websites. The prompt marks the recipe as data and tells the model to ignore instructions inside it, and every answer passes the schema, the device limits and the cooking rules, but a crafted recipe can still change what the model writes within those limits. For sources you do not trust, set `MC_RECIPE_STATUS=draft` and look at the draft before it goes to the machine.

**What a backup holds.** `bridge.db` holds the session cookie and the Lidl account encrypted with `SETTINGS_KEY`, and in plain text the job logs (recipe titles, errors), the list of sent recipes with their Monsieur Cuisine links and the time of the last login attempt. `login-screenshots/` can show the Lidl account page with your e-mail address. Treat a backup of the data directory as private, and store `SETTINGS_KEY` apart from it.

**Container.** The image runs as uid 1000 under tini. The example compose file drops every capability, forbids new privileges, limits processes and memory and mounts the root file system read-only with `/tmp` and the home directory in memory; the bridge writes only to `/data`. The headless Chromium of the automatic login runs without its own sandbox, which needs kernel features a hardened container does not grant, so it gets no secrets in its environment and a fresh profile per login. Pin the image by digest (see [Upgrading and migrations](#upgrading-and-migrations)) if you want to decide when it changes.

**Model provider endpoints.** The OpenAI and Anthropic SDKs honour `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` from the environment; whoever sets them receives your API key. The bridge sets neither.

## Troubleshooting

### Mealie says "Daten gesendet" (Message sent), but no job appears

Mealie answers the click before it contacts the bridge and ignores the answer, so the message says nothing about the bridge. Errors land only in Mealie's log (`docker logs mealie`). Check in this order:

1. **Allow list.** Mealie 3.26 and newer needs `HTTP_ALLOW_LIST: "mc-bridge"` (the host name of the action URL, without scheme or port). Mealie's log shows an `InvalidDomainError` when this is missing.
2. **Network.** Run the `docker exec mealie python ...` check from step 8. If it fails, the containers do not share a network, or the service name differs from the host in the action URL.
3. **Token.** The URL must end in exactly the `WEBHOOK_TOKEN` of `.env`. A wrong token gets a 404, and the bridge logs `webhook call with a wrong token`.
4. **Method.** The action type must be `post`.
5. **Daily limit.** Over `JOB_DAILY_LIMIT` or `JOB_DAILY_COST_LIMIT_USD` the bridge answers 429, logs `webhook call refused: daily limit reached` and leaves a timeline entry on the recipe. The limits count the last 24 hours.

### A job ends as "session expired"

The Monsieur Cuisine cookie expired or was rejected. With a stored Lidl account the bridge logs in again by itself; the settings page shows the last attempt. Otherwise renew the session with the login helper or paste a new cookie ([Monsieur Cuisine session](#monsieur-cuisine-session)); the job continues on its own. If a fresh cookie is rejected right away, copy it from a `proxy-api` request again: a cookie from another request or another site will not do.

### A job fails with "checks not passed" or "conversion failed"

The model's answer still broke a device limit or a plausibility rule after the last correction round. The job page lists the errors of the last round. Usually it helps to:

- run the job again (the model answers differently each time)
- raise `LLM_MAX_CORRECTIONS`, or switch to a stronger model or a higher `OPENAI_REASONING_EFFORT`
- make the Mealie recipe clearer: give amounts for every ingredient, and say which steps happen outside the machine (oven, pan)

A conversion that failed on a provider error (refusal, cut-off answer, missing key) says so in the job error.

### The recipe is on monsieur-cuisine.com but not on the machine

Only a recipe saved privately shows up on the machine; a draft does not. Check:

- `MC_RECIPE_STATUS` is `private-publish` (the default). With `draft` the bridge stops after creating the draft.
- The timeline entry. If setting the status failed, it says the recipe stayed a draft. Open it in the web editor and save it privately there.
- The machine is online and signed in to the same account.

### The container exits with "unable to open database file"

The bridge runs as uid 1000 and cannot write the data directory, usually because Docker created the bind-mounted directory as root. The log names the directory and the uid the process runs as:

```text
Cannot open the database: DATA_DIR /data is not writable (EACCES: ...); chown the data directory to the service user, uid 1000 ...
```

Fix the owner on the host and start again:

```sh
sudo chown -R 1000:1000 ./data
docker compose up -d mc-bridge
```

With a named volume, run the `chown` once in a helper container: `docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data`. If the directory becomes read-only while the bridge runs, `/health` answers 503 and the container turns unhealthy.

### Mealie's log shows the action URL with "%3C" and "%3E", and the bridge answers 404

The action URL still contains the placeholder from the docs: `<WEBHOOK_TOKEN>` arrives URL-encoded as `%3CWEBHOOK_TOKEN%3E`, which is not a token, so the bridge answers 404 like for any unknown path and logs `webhook call with a wrong token`. Edit the recipe action in Mealie and put the value of `WEBHOOK_TOKEN` from `.env` in place of `<WEBHOOK_TOKEN>`, without the angle brackets.

### Portainer stacks: where the `${VAR}` values come from

In a Portainer stack written in the web editor there is no `.env` file next to the compose file, so `env_file: .env` finds nothing, and `${VAR}` in the compose text is filled from the stack's "Environment variables" section instead. Put the settings there ("Advanced mode" takes the lines of a `.env` file, and "Load variables from .env file" uploads one). Portainer also writes them to a file named `stack.env`, so the simplest change to the example compose file is `env_file: stack.env` in place of `env_file: .env`. Alternatively list each setting under `environment:`, for example `WEBHOOK_TOKEN: ${WEBHOOK_TOKEN}`. The values are applied when the stack is deployed: after changing one, press "Update the stack". A variable that is missing becomes an empty string, and the bridge then names the setting it rejects in its log. A `$` inside a value written into the compose text needs `$$`.

### The login helper or the automatic login does not get a session

- "No browser": install Playwright's Chromium with `npx playwright install chromium`, or install Google Chrome. In the container the browser ships with the image; the settings page says when it is missing.
- "refused the admin user or password": the helper uses `ADMIN_USER` and `ADMIN_PASSWORD` of the bridge, not your Lidl account.
- `--headless` asks to "log in once with a window": the Lidl login in the profile has ended or needs a confirmation. Run the helper once without `--headless`.
- On the settings page, a failed attempt shows its reason and a screenshot. A captcha or a second factor cannot be solved headless; log in once with the helper, and the profile on your computer keeps the Lidl login for the scheduled runs.
- "Unexpected page": a password field showed up on a page that is not an https page on a host in `LIDL_LOGIN_HOSTS`, and the bridge typed nothing. Look at the screenshot; if Lidl moved its login to another host, add that host to `LIDL_LOGIN_HOSTS`.
- The settings page still shows "details removed by the security update": the reason of the last attempt before the upgrade was removed, because it could contain the Lidl password. If a login failed before you upgraded from 0.2.2 or earlier, change your Lidl password.

## Costs

Each job shows its token usage and an estimated cost on the job page and the job list. The system prompt is about 9000 tokens and the same for every recipe, so later recipes and correction rounds read most of it from the provider's prompt cache; the recipe and its techniques add about 3000 tokens. Each correction round is another call. To spend less, lower `LLM_MAX_CORRECTIONS` or pick a cheaper model and effort. The estimate uses a built-in price table; `LLM_PRICES_JSON` overrides it when your prices differ. The webhook stops accepting jobs at `JOB_DAILY_LIMIT` jobs or `JOB_DAILY_COST_LIMIT_USD` of estimated cost in 24 hours. Set a spending limit in your provider account as well.

## Knowledge base

`knowledge/` holds the data the converter and the checks use, distilled from published Monsieur Cuisine recipes. It contains numbers, ingredient names, short standard device phrases and rules written in our own words; the raw recipes are not included.

- Language-neutral files: hard device limits per program (`device-programs.json`), recommended ranges (`device-limits.json`), cooking techniques with their device settings (`techniques.json`), timing rules (`timing-model.json`), densities (`units.json`), converter tables (`converter-rules.json`) and the prompt rules (`prompt-rules.md`, with `step-patterns.md` as the evidence behind them). They name phrases and units by placeholder (`{{phrase:pushDown}}`, `{{unit:teaspoon}}`).
- Locale packs, `knowledge/locales/<locale>/`: the Monsieur Cuisine settings of the locale (`mc.json`), units (`units.json`), standard phrases and the words the checks read in step texts (`phrases.json`), the wording per technique (`technique-aliases.json`), language-specific prompt rules (`prompt-rules.md`) and the ingredient catalog (`ingredient-catalog.json`).

To rebuild it from your own crawl of the public recipe API (no account needed):

```sh
npm run corpus:crawl            # 1 request/s, resumable, writes local/corpus/
npm run corpus:analyze          # normalizes and runs the five analyzers
npm run corpus:build-knowledge  # writes the neutral files and the de-DE pack
npm run corpus:build-knowledge -- --check   # compare instead of writing
```

Every corpus command takes `--locale` (default `de-DE`). The de-DE corpus lives in `local/corpus`, every other locale in `local/corpus/<locale>`; `CORPUS_DIR` overrides the directory. A rebuild from the same crawl reproduces the committed files byte for byte. The hand-written files (`prompt-rules.md`, `step-patterns.md`, `converter-rules.json`, and in each pack `mc.json`, `technique-aliases.json`, `prompt-rules.md` and the hand-written parts of `units.json` and `phrases.json`) are left alone. The editor and server layers of `device-programs.json` come from a capture of the website's editor and are transcribed in `scripts/corpus/build-device-programs.ts`.

## Development

Node 22 or newer.

```sh
npm ci
cp .env.example .env     # fill in WEBHOOK_TOKEN, MEALIE_URL, MEALIE_API_TOKEN, SETTINGS_KEY, ADMIN_USER, ADMIN_PASSWORD
npm run dev              # tsx watch; reads .env, keeps bridge.db in ./data
npm run check            # format, lint, typecheck, tests with coverage
npm test                 # tests only
npm run build            # compiles to dist/; npm start runs it
npm run format           # Prettier over every file git knows about
npm run docs:config      # rewrite the configuration table in README.md
npm run hooks:install    # secret scan before every commit, needs gitleaks 8.19 or newer
```

`npm run dev` and `npm start` read `.env` from the working directory when `NODE_ENV` is not `production`. `npm run test:coverage` enforces 85 % line coverage per module directory under `src/`. The tests never call a provider; `src/convert/providers/live.test.ts` converts a fixture with the real API when `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set, is skipped otherwise and in CI, and costs money.

Image conversion uses [sharp](https://sharp.pixelplumbing.com) and the database [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). Both ship prebuilt native binaries per platform. The Docker image installs them on linux during the build; do not copy a `node_modules` folder from Windows or macOS into an image. To build the image yourself, clone the repository (`git clone https://github.com/hudra0/mealie-mc-bridge`), replace the `image:` line in `compose.yml` with `build: <path of the clone>` (or `build: .` when `compose.yml` sits in the clone) and run `docker compose up -d --build`.

### Command line tools

`npm run convert` runs the converter without uploading anything. The input is a recipe as Mealie's `GET /api/recipes/{slug}` returns it:

```sh
npm run convert -- prompt --mealie-json recipe.json                 # print both prompts, no API call
npm run convert -- convert --mealie-json recipe.json --scale 1.5    # convert and print the steps
npm run convert -- convert --mealie-json recipe.json --provider anthropic --out result.json
npm run convert -- convert --mealie-json recipe.json --locale en-US   # write an English recipe
```

It prints the steps, warnings, review hints, token usage and a cost estimate. The category list comes from `--categories <file>` or from the public Monsieur Cuisine API. `npm run convert:eval -- --ids 1234,5678` converts recipes of your own corpus crawl from their ingredients and texts and compares programs, temperatures and times with the original; it reads the corpus of `--locale` (else `MC_LOCALE`). Exit codes: 0 done, 1 unreadable input or a recipe that still failed, 3 provider error, 64 usage error, 66 no corpus, 78 configuration.

`npm run mc:smoke` checks the Monsieur Cuisine side against your own account and reads `.env` when it exists. `whoami`, `categories` and `create` take the session only from `MC_COOKIE` in the environment or `.env`, not from a cookie pasted on the admin page; `dry-run` works offline:

```sh
npm run mc:smoke -- whoami                        # is the session valid?
npm run mc:smoke -- categories                    # category ids for recipes
npm run mc:smoke -- dry-run recipe.json           # validate and print the payload, offline
npm run mc:smoke -- create recipe.json --image photo.jpg [--status private-publish]
```

`create` adds a real recipe to your account, as a draft unless `--status private-publish` is given; it never submits a recipe for publication. `test/fixtures/recipe/all-modes.recipe-input.json` is a sample input with one step per device program (do not cook it). Exit codes: 0 done, 1 invalid input, 2 no usable session, 3 API failure, 64 usage error, 78 missing or broken device limits file or locale pack.

`npm run mc:login` logs in in a browser and sends the session to a running bridge; see [Renewing the session with the login helper](#renewing-the-session-with-the-login-helper). Exit codes: 0 stored, 1 no session, 2 the bridge refused or did not answer, 64 usage error.

See `CONTRIBUTING.md` for the pull request format, the secrets policy and how to add a language, and `docs/ARCHITECTURE.md` for the design.

## Disclaimer

Not affiliated with Lidl, Monsieur Cuisine, Silvercrest or Mealie. The bridge uses an undocumented API of monsieur-cuisine.com that may change without notice. Recipes are written by a language model and can contain wrong times, temperatures or amounts; you cook them at your own risk.

## License

MIT, see `LICENSE`. Third-party notices are in `THIRD_PARTY_NOTICES.md`.
