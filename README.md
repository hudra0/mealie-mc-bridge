# mealie-mc-bridge

Sends a recipe from your Mealie instance to a Monsieur Cuisine Smart as a guided-cooking recipe.

## What it does

The bridge is a small service that runs next to Mealie. Mealie hands it a recipe; a language model (OpenAI or Anthropic) rewrites the recipe into the step format of the machine, with programs, temperatures, times and speeds; the bridge checks the result against the device limits and a set of cooking rules, uploads it to your monsieur-cuisine.com account and reports back into Mealie. The recipe then shows up on your machine, private to your account.

1. In Mealie you open a recipe, set the servings, and pick "Send to Monsieur Cuisine" (whatever you named the action) from the three-dot menu.
2. Mealie posts the recipe id and the scale to the bridge, which queues a job and answers at once.
3. The bridge loads the recipe, scales the ingredients, has the model convert it, checks the answer (and lets the model correct it), and uploads the recipe with its photo.
4. The recipe is saved privately in your Monsieur Cuisine account, so it appears on the machine.
5. Mealie gets a tag on the recipe and a timeline entry with the link and the points you should check before you cook.

Status: first version, not tagged yet. It runs end to end and is used with German recipes on a real machine. English output exists but has not been checked on a device yet. Every converted recipe is written by a language model, so check times and temperatures before you cook it.

## Requirements

- Docker with Compose, on a host that runs Mealie or shares a Docker network with it
- Mealie 3.x; on 3.26 and newer one extra setting is needed (`HTTP_ALLOW_LIST`, step 8 below)
- A Monsieur Cuisine account on www.monsieur-cuisine.com and a Monsieur Cuisine Smart linked to it
- An API key for OpenAI or Anthropic. Conversions are paid per use; see [Costs](#costs)

The image is published for linux/amd64 and linux/arm64.

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

This prints a `SETTINGS_KEY` and a `WEBHOOK_TOKEN`. Put both into `.env`. `SETTINGS_KEY` encrypts the Monsieur Cuisine cookie in `bridge.db`; keep a copy outside the server. `openssl rand -base64 32` and `openssl rand -hex 32` produce the same kind of values.

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
- `ADMIN_USER` and `ADMIN_PASSWORD` for the admin pages.
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

### 6. Paste the Monsieur Cuisine session

Open the admin pages at `http://127.0.0.1:3000/admin` and log in with `ADMIN_USER` and `ADMIN_PASSWORD`. The example compose file publishes the port on localhost only; to reach it from another machine, bind it to the host's LAN address (see the comment in `compose.example.yml`). Keep it off the internet.

Copy the session cookie from your browser and paste it into the form on the dashboard, as described under [Monsieur Cuisine session](#monsieur-cuisine-session). The bridge checks it against your account before it stores it. The session state turns `valid`.

### 7. Create the recipe action in Mealie

In Mealie, open Settings, Data Management, pick "Recipe Actions" and add one:

- Title: for example "Send to Monsieur Cuisine"
- Type: `post`
- URL: `http://mc-bridge:3000/hooks/mealie/<WEBHOOK_TOKEN>`

The host is the bridge's service name on the Docker network, not `localhost` and not the published port. Actions belong to a household; every household that wants the button needs its own.

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

| Variable                  | Default                            | Values                                                       | Description                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                    | `3000`                             | integer 1 to 65535                                           | TCP port the bridge listens on. The image's health check reads it too.                                                                                                                                                         |
| `HOST`                    | `0.0.0.0`                          |                                                              | Interface to bind. Keep `0.0.0.0` in a container; `127.0.0.1` keeps a local run off the network.                                                                                                                               |
| `LOG_LEVEL`               | `info`                             | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | Log verbosity. `debug` logs every request to Mealie and Monsieur Cuisine. Secrets are masked at every level.                                                                                                                   |
| `TZ`                      | UTC in the image                   |                                                              | Time zone of the dates in timeline entries, mails and the admin pages, for example `Europe/Berlin`. Read by Node.js itself.                                                                                                    |
| `DATA_DIR`                | `./data`                           |                                                              | Directory of `bridge.db`. The image sets `/data`. Do not set it in `.env` with Docker: even an empty line overrides the image's value, and the bridge then falls back to `./data` inside `/app`.                               |
| `SETTINGS_KEY`            | **required**                       |                                                              | Base64 of 32 random bytes; `generate-secrets` prints one. Encrypts the Monsieur Cuisine cookie in `bridge.db`. With another key the stored cookie cannot be read, and you paste it again.                                      |
| `WEBHOOK_TOKEN`           | **required**                       |                                                              | Secret path segment of the webhook, `/hooks/mealie/<WEBHOOK_TOKEN>`. At least 32 characters of letters, digits and `. _ ~ -`.                                                                                                  |
| `MEALIE_URL`              | **required**                       |                                                              | How the bridge reaches Mealie, for example `http://mealie:9000` on a shared Docker network. An http or https URL.                                                                                                              |
| `MEALIE_API_TOKEN`        | **required**                       |                                                              | API token of the Mealie user the bridge acts as. A secret.                                                                                                                                                                     |
| `MEALIE_PUBLIC_URL`       | `MEALIE_URL`                       |                                                              | How you open Mealie in the browser, for example `https://mealie.example.com`. Used for links on the admin pages and in mails.                                                                                                  |
| `MEALIE_GROUP_SLUG`       | `home`                             |                                                              | The part after `/g/` in your Mealie recipe URLs, for those links.                                                                                                                                                              |
| `TAG_NAME`                | `Monsieur Cuisine`                 |                                                              | Tag the bridge adds to every recipe it sent, 1 to 60 characters.                                                                                                                                                               |
| `MC_LOCALE`               | `de-DE`                            |                                                              | Language of the recipes the bridge writes, and the Monsieur Cuisine settings of that language. Needs a locale pack in `KNOWLEDGE_DIR/locales/`: `de-DE` (verified on a device) or `en-US` (not verified).                      |
| `UI_LANGUAGE`             | language of `MC_LOCALE`, else `en` | `de`, `en`                                                   | Language of timeline entries, mails and admin pages.                                                                                                                                                                           |
| `MC_RECIPE_STATUS`        | `private-publish`                  | `draft`, `private-publish`                                   | What happens after the draft is created. `private-publish` saves the recipe on your device only, which makes it show up on the machine. `draft` leaves it in the web editor, where the machine does not see it; for debugging. |
| `MC_RESOLVE_INGREDIENTS`  | `exact`                            | `exact`, `off`                                               | How ingredients get their Monsieur Cuisine ingredient id, which the app uses for the shopping list. `exact`: bundled catalog, also without qualifiers like "zum Garnieren", local cache, then the site's search. `off`: none.  |
| `MC_COOKIE`               | unset                              |                                                              | Cookie header of a logged-in monsieur-cuisine.com browser session. A secret. Stored on the first start and whenever the value changes; the admin page can replace it at any time.                                              |
| `SESSION_CHECK_MINUTES`   | `60`                               | integer 1 to 1440                                            | Minutes between session checks. Each check is a cheap account call.                                                                                                                                                            |
| `DEVICE_PROGRAMS_PATH`    | `./knowledge/device-programs.json` |                                                              | Device limits the validator enforces. A relative path resolves against the working directory, `/app` in the image.                                                                                                             |
| `LLM_PROVIDER`            | `openai`                           | `openai`, `anthropic`                                        | Language model provider that converts the recipes.                                                                                                                                                                             |
| `OPENAI_API_KEY`          | required with `openai`             |                                                              | OpenAI API key. A secret. Checked when a conversion runs, so a missing key fails the job, not the start.                                                                                                                       |
| `OPENAI_MODEL`            | `gpt-6.1-sol`                      |                                                              | OpenAI model. Any Responses API model with strict JSON schema support works; check that your account offers the default.                                                                                                       |
| `OPENAI_REASONING_EFFORT` | `medium`                           | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`   | Reasoning effort of the OpenAI model.                                                                                                                                                                                          |
| `ANTHROPIC_API_KEY`       | required with `anthropic`          |                                                              | Anthropic API key. A secret. Checked when a conversion runs.                                                                                                                                                                   |
| `ANTHROPIC_MODEL`         | `claude-opus-5-5`                  |                                                              | Anthropic model; check that your account offers the default. The effort is fixed at `high`.                                                                                                                                    |
| `LLM_MAX_CORRECTIONS`     | `3`                                | integer 0 to 10                                              | Correction rounds after the first answer when the recipe fails the checks. Each round is another paid model call.                                                                                                              |
| `KNOWLEDGE_DIR`           | `./knowledge`                      |                                                              | Knowledge base the converter reads, with the locale packs under `locales/<locale>/`. A relative path resolves against the working directory.                                                                                   |
| `LLM_PRICES_JSON`         | unset                              |                                                              | Token prices in USD per million tokens for the cost estimate, merged over the built-in table, for example `{"gpt-5.5": {"input": 5, "cachedInput": 0.5, "output": 30}}`.                                                       |
| `WORKER_POLL_SECONDS`     | `2`                                | number above 0 to 60                                         | Seconds between queue polls. A webhook call wakes the worker at once.                                                                                                                                                          |
| `ADMIN_USER`              | unset                              |                                                              | Basic Auth user for the admin pages. Set it together with `ADMIN_PASSWORD`; without both the pages are open to anyone who reaches the port.                                                                                    |
| `ADMIN_PASSWORD`          | unset                              |                                                              | Basic Auth password for the admin pages. A secret.                                                                                                                                                                             |
| `ADMIN_HOSTS`             | unset                              |                                                              | Host names the admin pages answer to, comma-separated, without ports. IP addresses and `localhost` always work. Without Basic Auth other names are refused, which blocks DNS rebinding.                                        |
| `SMTP_URL`                | unset                              |                                                              | `smtp://` or `smtps://` URL with credentials, for example `smtps://user:password@mail.example.com:465`. Without it no mail is sent.                                                                                            |
| `NOTIFY_EMAIL`            | required with `SMTP_URL`           |                                                              | Recipient of the mails: session expired or invalid, a job failed for good, the session check keeps failing.                                                                                                                    |
| `SMTP_FROM`               | `NOTIFY_EMAIL`                     |                                                              | Sender address of the mails.                                                                                                                                                                                                   |
| `NODE_ENV`                | `production` in the image          |                                                              | Anything but `production` makes `npm run dev` and `npm start` read `.env` from the working directory; variables already set win.                                                                                               |

<!-- config-reference:end -->

## Monsieur Cuisine session

Monsieur Cuisine has no public API for writing recipes. The bridge uses the same internal API as the recipe editor on www.monsieur-cuisine.com, with the session cookies of your browser.

### Get the cookie

1. Log in on www.monsieur-cuisine.com and open "Create recipe".
2. Open the browser's developer tools (F12), Network tab, and reload the page.
3. Pick any request whose URL contains `proxy-api` and copy the value of its `Cookie` request header. In Chrome and Edge it is under Headers, Request Headers; in Firefox under Headers, Request Headers with "Raw" switched on.
4. Paste it into the form on the admin dashboard and press "Save session" ("Sitzung speichern").

The bridge checks the cookie with a separate request before it stores it, encrypted with `SETTINGS_KEY`. A cookie Monsieur Cuisine rejects is not stored, and the working session stays in place. The cookie is a secret: anyone who has it can change the recipes in your account. Keep it out of chats, screenshots and issue reports.

Instead of the form you can set `MC_COOKIE` in `.env`. The bridge stores it on the next start, and again whenever that value changes; a cookie pasted on the admin page later wins until you change `MC_COOKIE`. Wrap the value in single quotes in `.env`, so Compose leaves characters like `$` alone.

### How long it lasts

The login cookies carry an expiry date 14 days after you logged in. Expect to paste a new cookie about every two weeks. Logging out on the website may end it earlier, so close the tab after copying the cookie instead of logging out.

The bridge checks the session on start and then every `SESSION_CHECK_MINUTES` (60 by default) with a cheap account call. "Check now" ("Jetzt prüfen") on the dashboard runs the check at once, and the dashboard shows the state, the time of the last check and the age of the cookie.

### When it expires

When Monsieur Cuisine rejects the cookie:

- the dashboard shows the session as `expired` or `invalid`, and `/health` reports `degraded`
- the worker stops taking jobs; queued jobs and jobs that hit the dead session move to "session expired" instead of failing
- Mealie gets a timeline entry on the recipe saying the job waits for a new session
- you get one mail, if mail is configured

Paste a fresh cookie and the waiting jobs run on their own. A check that fails for another reason, such as the site being down, leaves the state alone and sends one mail per failure streak.

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

Errors go back to the model with its previous answer, up to `LLM_MAX_CORRECTIONS` times. Warnings do not trigger a correction; they go into the timeline entry next to the model's own review hints.

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

The dashboard shows the session, the queue and recent jobs. The job list shows every job with its log. A failed job can be retried; "Force rebuild" sends the recipe again even if it has not changed; queued jobs can be cancelled. Temporary failures (network, server errors) are retried three times with a pause of 2, 4 and 8 seconds. Validation and conversion failures are not retried automatically, and neither is creating the recipe on Monsieur Cuisine, so a timeout never leaves two copies behind.

"Dry run" ("Probelauf") shows what the converter would get for a Mealie recipe and, on request, runs the conversion without uploading anything. That conversion is a paid model call.

Without `ADMIN_USER` and `ADMIN_PASSWORD` the admin pages are open to anyone who reaches the port, and they answer only to an IP address, `localhost` or a host name listed in `ADMIN_HOSTS`.

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

`status` is `degraded` while the session is `invalid` or `expired` or the worker is stopped. A restart fixes neither, so the container health check fails only when the bridge stops answering or its database fails (503). `lastError` carries only the time of the last worker error; the message is on the dashboard.

`GET /jobs/<id>` returns one job with its log as JSON. It needs no login either; job ids are random UUIDs that appear in the bridge's pages, logs and failure mails, and in its answer to Mealie. Anyone who has a job id can read that job's log.

### Data directory and backups

Everything the bridge keeps is in `bridge.db` in the data directory (`/data` in the container): jobs and their logs, the list of sent recipes, the encrypted session, the category cache and the ingredient id cache. The database runs in WAL mode, so back up the whole directory with the container stopped, or take a consistent copy while it runs:

```sh
docker compose exec mc-bridge node -e "require('better-sqlite3')('/data/bridge.db').backup('/data/backup.db').then(() => console.log('done'))"
```

This writes `backup.db` into `data/` next to the database. Keep `SETTINGS_KEY` with the backup; without it the stored cookie cannot be read, and you would paste a new one.

### Upgrading and migrations

```sh
docker compose pull mc-bridge
docker compose up -d mc-bridge
```

Schema migrations run on start, each in its own transaction. A database written by a newer release is refused rather than guessed at, so back up `data/` before an upgrade if you might roll back. Stopping the container hands a running job back to the queue, unless the job is already creating the recipe on Monsieur Cuisine; give it the `stop_grace_period` of the example compose file.

`latest` follows the `main` branch. No release is tagged yet; until then, pin a build with its `sha-<commit>` tag from the [package page](https://github.com/hudra0/mealie-mc-bridge/pkgs/container/mealie-mc-bridge). Once a release is tagged, its image carries the tags `X.Y.Z` and `X.Y`; see [CHANGELOG.md](CHANGELOG.md).

### Email notifications

Set `SMTP_URL` (for example `smtps://user:password@mail.example.com:465`) and `NOTIFY_EMAIL`. `SMTP_FROM` sets the sender; it defaults to the recipient. The bridge mails when the session stops working (once per change), when a job fails for good (once per job) and when the session check itself keeps failing, for example because the site is down. Mails are short plain text in `UI_LANGUAGE` and never contain cookies or tokens.

## Troubleshooting

### Mealie says "Daten gesendet" (Message sent), but no job appears

Mealie answers the click before it contacts the bridge and ignores the answer, so the message says nothing about the bridge. Errors land only in Mealie's log (`docker logs mealie`). Check in this order:

1. **Allow list.** Mealie 3.26 and newer needs `HTTP_ALLOW_LIST: "mc-bridge"` (the host name of the action URL, without scheme or port). Mealie's log shows an `InvalidDomainError` when this is missing.
2. **Network.** Run the `docker exec mealie python ...` check from step 8. If it fails, the containers do not share a network, or the service name differs from the host in the action URL.
3. **Token.** The URL must end in exactly the `WEBHOOK_TOKEN` of `.env`. A wrong token gets a 404, and the bridge logs `webhook call with a wrong token`.
4. **Method.** The action type must be `post`.

### A job ends as "session expired"

The Monsieur Cuisine cookie expired or was rejected. Paste a new one ([Monsieur Cuisine session](#monsieur-cuisine-session)); the job continues on its own. If a fresh cookie is rejected right away, copy it from a `proxy-api` request again: a cookie from another request or another site will not do.

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

## Costs

Each job shows its token usage and an estimated cost on the job page and the dashboard. The system prompt is about 9000 tokens and the same for every recipe, so later recipes and correction rounds read most of it from the provider's prompt cache; the recipe and its techniques add about 3000 tokens. Each correction round is another call. To spend less, lower `LLM_MAX_CORRECTIONS` or pick a cheaper model and effort. The estimate uses a built-in price table; `LLM_PRICES_JSON` overrides it when your prices differ. Set a spending limit in your provider account as well.

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
cp .env.example .env     # fill in WEBHOOK_TOKEN, MEALIE_URL, MEALIE_API_TOKEN, SETTINGS_KEY
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

See `CONTRIBUTING.md` for the pull request format, the secrets policy and how to add a language, and `docs/ARCHITECTURE.md` for the design.

## Disclaimer

Not affiliated with Lidl, Monsieur Cuisine, Silvercrest or Mealie. The bridge uses an undocumented API of monsieur-cuisine.com that may change without notice. Recipes are written by a language model and can contain wrong times, temperatures or amounts; you cook them at your own risk.

## License

MIT, see `LICENSE`. Third-party notices are in `THIRD_PARTY_NOTICES.md`.
