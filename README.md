# mealie-mc-bridge

Sends a recipe from your Mealie instance to a Monsieur Cuisine Smart as a guided-cooking draft. A language model converts the recipe, the bridge checks the result against the device limits, and the draft lands in your Monsieur Cuisine account for you to review and cook.

## Status

Early development. The service runs end to end with one gap: the LLM converter is built separately and not wired in yet. Until it is, every job stops at the conversion step with "converter not configured", and Mealie shows that in the recipe's timeline.

What exists:

- the service: webhook for Mealie's recipe action, job queue in SQLite, worker with retries, session handling for Monsieur Cuisine, admin pages, mail notifications, write-back into Mealie
- the Monsieur Cuisine client (session check, drafts, status change, categories, ingredient search, image upload)
- the recipe format the converter produces, its validator against the device limits in `knowledge/device-programs.json`, and the builder for the Monsieur Cuisine payload
- the Mealie side: the recipe action parser, the REST client, ingredient parsing and scaling, and the Markdown input for the converter
- `npm run mc:smoke`, a command line tool for manual checks against your own account

## How it works

1. In Mealie you open a recipe, set the servings, and pick "Send to Monsieur Cuisine" (or whatever you called the action) from the three-dot menu.
2. Mealie posts the recipe id and the scale to the bridge. The bridge queues a job and answers at once.
3. The worker loads the recipe from Mealie, scales the ingredients, has the LLM convert it, validates the result and uploads it with its photo as a draft to your Monsieur Cuisine account.
4. The bridge tags the recipe in Mealie and adds a timeline entry with a link to the draft and the points you should check.
5. You open the draft in the Monsieur Cuisine web editor, check times and temperatures, and save it to your device.

A recipe that has not changed since it was last sent is not sent again; the timeline entry points to the existing draft instead. The admin page can force a rebuild.

## Requirements

- Docker with Compose
- Mealie, ideally 3.26 or newer (older versions work without the allow list step)
- A Monsieur Cuisine account (monsieur-cuisine.com)
- An API key for a supported LLM provider, once the converter is wired in

## Run it

### 1. Prepare the files

```sh
mkdir mc-bridge && cd mc-bridge
curl -O https://raw.githubusercontent.com/hudra0/mealie-mc-bridge/main/compose.example.yml
curl -o .env https://raw.githubusercontent.com/hudra0/mealie-mc-bridge/main/.env.example
mv compose.example.yml compose.yml
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
```

The bridge has to share a Docker network with Mealie: Mealie calls the bridge, and the bridge calls Mealie. Pick one layout:

- **In Mealie's compose project (simplest).** Paste the `mc-bridge` service from `compose.yml` into Mealie's compose file, and put `.env` and `data/` into Mealie's directory instead of `mc-bridge/`. Both services are then on Mealie's default network.
- **As its own project.** Keep `mc-bridge/compose.yml` and join Mealie's network: find its name with `docker network ls` (usually `<mealie directory>_default`), then uncomment the two `networks:` blocks in `compose.yml` and put that name in.

With either layout, Mealie must reach the bridge by name. After step 4, check it from the Mealie container:

```sh
docker exec mealie python -c "import urllib.request as u; print(u.urlopen('http://mc-bridge:3000/health').read().decode())"
```

Replace `mealie` with the name of your Mealie container (`docker ps`). No answer means the two are not on one network, and the recipe action will fail without any message.

### 2. Generate the secrets

```sh
docker run --rm ghcr.io/hudra0/mealie-mc-bridge:latest node dist/main.js generate-secrets
```

This prints a `SETTINGS_KEY` and a `WEBHOOK_TOKEN`. Put both into `.env`. `SETTINGS_KEY` encrypts the Monsieur Cuisine cookie in `bridge.db`; keep a copy outside the server, because without it the stored cookie cannot be read. `openssl rand -base64 32` and `openssl rand -hex 32` produce the same kind of values.

### 3. Create a Mealie user and API token

The bridge acts as a Mealie user. A dedicated one keeps its changes apart from yours:

1. In Mealie, create a user (for example `mc-bridge`) in the same household as the recipes. Give it the "advanced" flag, so it can create API tokens, and permission to organize, so it can create the tag.
2. Log in as that user, open Profile, API Tokens, and create a token.
3. Put the token into `MEALIE_API_TOKEN` and the address the bridge uses to reach Mealie into `MEALIE_URL`, for example `http://mealie:9000` when both run in one compose project. Set `MEALIE_PUBLIC_URL` to the address you open in the browser, for example `https://mealie.example.com`, so links on the admin page work.

The user needs edit rights on a recipe to tag it. Without them the bridge still writes the timeline entry, which needs no edit rights.

### 4. Set the admin password and start

Set `ADMIN_USER` and `ADMIN_PASSWORD` in `.env`, then:

```sh
docker compose up -d
curl http://127.0.0.1:3000/health
```

The admin pages are at `http://127.0.0.1:3000/admin`. The example compose file publishes the port on localhost only; put a LAN address there if you want to reach it from another machine, and keep it off the internet. Without a password, the admin pages answer only to an IP address or `localhost`; list any host name you use for them (a reverse proxy name, say) in `ADMIN_HOSTS`.

### 5. Paste the Monsieur Cuisine session

The bridge uses the same internal API as the recipe editor on www.monsieur-cuisine.com and logs in with your browser's session cookies:

1. Log in on www.monsieur-cuisine.com and open "Create recipe".
2. Open the browser's developer tools, Network tab, and reload the page.
3. Pick any request to `proxy-api` and copy the value of its `Cookie` request header.
4. Paste it into the form on the admin dashboard and save.

The bridge checks the cookie against your account before it stores it, encrypted. The cookie is a secret: anyone who has it can change the recipes in your account. Keep it out of chats, screenshots and issue reports. Instead of the form you can set `MC_COOKIE` in `.env`; the bridge stores it on the next start.

### 6. Create the recipe action in Mealie

In Mealie, open Settings, Data Management, pick "Recipe Actions" and add one:

- Title: for example "An Monsieur Cuisine senden"
- Type: `post`
- URL: `http://mc-bridge:3000/hooks/mealie/<WEBHOOK_TOKEN>`

The host is the bridge's name on the Docker network. Actions belong to a household; every household that wants the button needs its own.

### 7. Allow the bridge on Mealie 3.26 and newer

From 3.26 on, Mealie refuses to post to private addresses unless they are on its allow list, and it does so silently. Add the bridge's host name to Mealie's environment and restart Mealie:

```yaml
HTTP_ALLOW_LIST: "mc-bridge"
```

The value is the bare host name, without scheme or port. A CIDR of the Docker network works as well.

### 8. Try it

Open a recipe in Mealie, pick the action, and watch the job on the admin page. After a minute or two the recipe carries the tag, and its timeline (the clock icon in the recipe header) has the result.

## Operations

### Session renewal

The Monsieur Cuisine session cookies last about two weeks. The bridge checks the session every `SESSION_CHECK_MINUTES` (60 by default), which also keeps it alive. When Monsieur Cuisine rejects it:

- the dashboard shows the session as expired or invalid and `/health` reports `degraded`
- new jobs wait instead of failing; jobs that hit the dead session move to "session expired"
- Mealie gets a timeline entry on the recipe saying the job is waiting
- you get one mail, if mail is configured

Paste a fresh cookie on the dashboard (step 5 above). The waiting jobs then run on their own. "Check now" on the dashboard runs the session check at once.

### Mail

Set `SMTP_URL` (for example `smtps://user:password@mail.example.com:465`) and `NOTIFY_EMAIL`. `SMTP_FROM` sets the sender; it defaults to the recipient. The bridge mails when the session stops working (once per change), when a job fails for good (once per job) and when the session check itself fails, for example because the site is down. Mails are short German plain text, whatever `TIMELINE_LANGUAGE` says, and never contain cookies or tokens.

### Jobs

The admin page lists every job with its log. A failed job can be retried; "Force rebuild" sends the recipe again even if it has not changed. Queued jobs can be cancelled. Temporary failures (network, server errors) are retried three times with a growing pause. Validation and conversion failures are not retried automatically, and neither is creating the draft itself, so a timeout never leaves two drafts behind.

"Dry run" on the admin page shows what the converter would get for a recipe, and on request runs the conversion without uploading anything. The conversion calls the LLM and costs money.

### Logs

The bridge logs JSON lines to stdout: `docker compose logs -f mc-bridge`. Set `LOG_LEVEL=debug` to see every request to Mealie and Monsieur Cuisine. Cookies, tokens, keys and the webhook token in the URL are masked in the logs.

### Health

`GET /health` answers 200 with `status`, `version`, the session state, the queue depth, the worker state and the last error. `status` is `degraded` while the session is unusable or the worker is stopped; restarting does not fix either, so the container healthcheck only fails when the bridge itself stops answering or its database fails (503).

### Backups and upgrades

Everything the bridge keeps is in `data/bridge.db`: jobs, the list of sent recipes, the encrypted session and the category cache. Back it up together with `SETTINGS_KEY`. Schema migrations run on start; a database from a newer release is refused rather than guessed at. Stopping the container hands a running job back to the queue, and it runs again after the start.

## Manual checks

`npm run mc:smoke` checks the Monsieur Cuisine side against your own account. It reads `.env` when the file exists, so the cookie never has to be typed into the shell:

```sh
cp .env.example .env                              # then paste the cookie after MC_COOKIE= in an editor
npm run mc:smoke -- whoami                        # is the session valid?
npm run mc:smoke -- categories                    # category ids for recipes
npm run mc:smoke -- dry-run recipe.json           # validate and print the payload, offline, no cookie needed
npm run mc:smoke -- create recipe.json --image photo.jpg [--status private-publish]
```

`.env` is gitignored. If you prefer an environment variable, set it without echoing the value, for example `read -rs MC_COOKIE && export MC_COOKIE` in bash.

`create` adds a real recipe to your account. It is created as a draft; `--status private-publish` then saves it on your device only. If that second step fails, the tool prints the id and editor link of the draft it left behind; set the status there instead of running `create` again. The tool never submits a recipe for publication. Exit codes: 0 done, 1 invalid input, 2 no usable session, 3 API failure, 64 usage error, 78 missing or broken device limits file. `test/fixtures/recipe/all-modes.recipe-input.json` is a sample input with one step per device program (do not cook it).

## Development

```sh
npm ci
cp .env.example .env    # fill in WEBHOOK_TOKEN, MEALIE_URL, MEALIE_API_TOKEN, SETTINGS_KEY
npm run dev             # tsx watch; reads .env, keeps bridge.db in ./data
npm run check           # format, lint, typecheck, tests with coverage
npm test                # tests only
npm run test:coverage   # 85 % line threshold per module directory under src/
npm run build
npm run hooks:install   # secret scan before every commit, needs gitleaks 8.19 or newer
```

`npm run dev` and `npm start` read `.env` from the working directory when `NODE_ENV` is not `production`.

Image conversion uses [sharp](https://sharp.pixelplumbing.com) and the database uses [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). Both ship prebuilt native binaries per platform, and `npm ci` installs the one for the machine it runs on. The Docker image runs `npm ci` on linux during the build, so it gets the linux binaries; do not copy a `node_modules` folder from Windows or macOS into an image.

To build and run the image locally, replace the `image:` line in `compose.yml` with `build: .` and run `docker compose up -d --build`. CI publishes `ghcr.io/hudra0/mealie-mc-bridge` on every push to `main` (tags `latest` and `sha-<commit>`) and for `v*` tags (semver tags).

See `CONTRIBUTING.md` for the pull request format and the secrets policy. The architecture is described in `docs/ARCHITECTURE.md`.

## Knowledge base

`knowledge/` holds the data the converter and the validator use: hard device limits per program (`device-programs.json`), recommended ranges (`device-limits.json`), cooking techniques (`techniques.json`), timing rules (`timing-model.json`), units (`units.json`), step patterns and prompt rules (`step-patterns.md`, `prompt-rules.md`). It is distilled from an analysis of published Monsieur Cuisine recipes. The raw recipes are not included; the files contain only numbers and rules written in our own words.

To rebuild it from your own crawl:

```sh
npm run corpus:crawl            # public recipe API, 1 request/s, resumable, writes local/corpus/
npm run corpus:normalize        # flat JSON lines under local/corpus/derived/
npm run corpus:analyze          # normalizes again and runs the five analyzers
npm run corpus:build-knowledge  # writes the JSON files in knowledge/
```

`corpus:crawl` takes `CORPUS_DIR`, `DEVICE` (default `MC3.0`) and `LOCALE` (default `de-DE`) from the environment. `corpus:build-knowledge -- --check` compares instead of writing; a rebuild from the same crawl reproduces the committed files byte for byte. It stops with exit code 1 and names the file when an analyzer output is missing.

The crawl needs no account. The editor and server layers of `device-programs.json` came from a logged-in capture of the website's recipe editor and from probes with a member account; they are transcribed by hand in `scripts/corpus/build-device-programs.ts`, so the build runs without that capture, but updating them needs your own. `prompt-rules.md` and `step-patterns.md` are written by hand from the analyzer reports.

## Disclaimer

Not affiliated with Lidl, Monsieur Cuisine, Silvercrest or Mealie.

## License

MIT, see `LICENSE`. Third-party notices are in `THIRD_PARTY_NOTICES.md`.
