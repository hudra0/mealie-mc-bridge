# mealie-mc-bridge

Sends a recipe from your Mealie instance to a Monsieur Cuisine Smart as a guided-cooking draft. A language model converts the recipe, the bridge checks the result against the device limits, and the draft lands in your Monsieur Cuisine account for you to review and cook.

## Status

Early development, not usable yet. Only the HTTP skeleton with a `/health` endpoint exists.

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

## Development

```sh
npm run check           # format, lint, typecheck, tests
npm run build
npm run hooks:install   # secret scan before every commit, needs gitleaks 8.19 or newer
```

See `CONTRIBUTING.md` for the pull request format and the secrets policy. The architecture is described in `docs/ARCHITECTURE.md`.

## Disclaimer

Not affiliated with Lidl, Monsieur Cuisine, Silvercrest or Mealie.

## License

MIT, see `LICENSE`. Third-party notices are in `THIRD_PARTY_NOTICES.md`.
