# mealie-mc-bridge

Sends a recipe from your Mealie instance to a Monsieur Cuisine Smart as a guided-cooking draft. A language model converts the recipe, the bridge checks the result against the device limits, and the draft lands in your Monsieur Cuisine account for you to review and cook.

## Status

Early development, not usable yet. What exists:

- the HTTP skeleton with a `/health` endpoint
- the Monsieur Cuisine client (session check, drafts, status change, categories, ingredient search, image upload)
- the recipe format the converter will produce, its validator against the device limits in `knowledge/device-programs.json`, and the builder for the Monsieur Cuisine payload
- `npm run mc:smoke`, a command line tool for manual checks against your own account
- the Mealie side: the recipe action parser, the REST client, ingredient parsing and scaling, and the Markdown input for the converter

The LLM converter, the job queue and the pipeline that connects the parts are still missing.

## Planned architecture

- A recipe action in Mealie posts the recipe id to the bridge.
- The bridge loads the recipe, normalizes and scales the ingredients, and asks an LLM to convert it.
- The converted recipe is validated against device limits (modes, temperatures, times, speeds) and corrected until it passes.
- The result is uploaded as a private draft to your Monsieur Cuisine account.
- The bridge writes a status and a link back into the Mealie recipe.

## Requirements

For development of the skeleton:

- Node 22 or newer and npm

For the finished service (planned):

- Docker
- A Mealie instance
- A Monsieur Cuisine account
- An API key for a supported LLM provider

## Run the skeleton

With Node:

```sh
cp .env.example .env
npm ci
npm run dev
curl http://127.0.0.1:3000/health
```

`npm run dev` and `npm start` read `.env` from the working directory when `NODE_ENV` is not `production`.

With Docker, build the image locally:

```sh
cp .env.example .env
cp compose.example.yml compose.yml
# in compose.yml, replace the image line with: build: .
docker compose up -d --build
curl http://127.0.0.1:3000/health
```

CI publishes `ghcr.io/hudra0/mealie-mc-bridge` on every push to `main` (tags `latest` and `sha-<commit>`) and for `v*` tags (semver tags). The example compose file keeps its state in a named volume. If you switch `/data` to a bind mount, run `mkdir -p data && sudo chown 1000:1000 data` first, because the container runs as uid 1000.

## Monsieur Cuisine session

The bridge talks to the same internal API as the recipe editor on www.monsieur-cuisine.com and authenticates with the browser session cookies. To get them:

1. Log in on www.monsieur-cuisine.com and open "Create recipe".
2. Open the browser developer tools, Network tab, and reload the page.
3. Pick a request to `proxy-api` and copy the value of its `Cookie` request header.

Put that value into `MC_COOKIE`. It is a secret: anyone who has it can change the recipes in your account. Keep it out of git, shell history, screenshots and issue reports. The session lasts about two weeks; after that, copy a fresh value.

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
npm run check           # format, lint, typecheck, tests with coverage
npm test                # tests only
npm run test:coverage   # tests with an 85 % line threshold for src/mc, src/recipe, src/mealie and src/ingredients
npm run build
npm run hooks:install   # secret scan before every commit, needs gitleaks 8.19 or newer
```

Image conversion uses [sharp](https://sharp.pixelplumbing.com), which ships prebuilt native binaries per platform. `npm ci` installs the one for the machine it runs on. The Docker image runs `npm ci` on linux during the build, so it gets the linux binaries; do not copy a `node_modules` folder from Windows or macOS into an image.

See `CONTRIBUTING.md` for the pull request format and the secrets policy. The architecture is described in `docs/ARCHITECTURE.md`.

## Knowledge base

`knowledge/` holds the data the converter and the validator will use: hard device limits per program (`device-programs.json`), recommended ranges (`device-limits.json`), cooking techniques (`techniques.json`), timing rules (`timing-model.json`), units (`units.json`), step patterns and prompt rules (`step-patterns.md`, `prompt-rules.md`). It is distilled from an analysis of published Monsieur Cuisine recipes. The raw recipes are not included; the files contain only numbers and rules written in our own words.

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
