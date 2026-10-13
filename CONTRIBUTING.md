# Contributing

## Workflow

- Branch from `main`.
- Commit subjects are short and imperative ("Add ingredient parser"). The body explains why the change is needed, not what the diff already shows.
- Before pushing, run `npm run check`, `npm run build` and `gitleaks git` (scans the history).

## Pull requests

The title is imperative and in sentence case, and names the change: `Add ingredient parser`.

Use this body, in this shape:

```markdown
## Summary

<the smallest view that shows the change, plus one or two sentences>

## Evidence

- **Before:** <output, failing check or observed behaviour>
  **After:** <the same check now>

## Merge danger

**Door:** <one-way or two-way>, <optional: why>
**Blast radius:** <who or what breaks if this is wrong>
```

Rules:

- Keep prose brief and skip preambles.
- Pick the smallest visual that makes the point: a short list of behaviour changes, a call tree, a file tree, or a diff of a structure.
- Evidence names the exact command and what it printed. "Tests pass" is a claim. Say what was not tested.
- Add a `Notes for reviewers` section only for something a reviewer has to act on, such as a merge order or a follow-up left out on purpose.

## Secrets

- Never commit keys, cookies, tokens, passwords, or hostnames and addresses of private infrastructure.
- Put every setting in `.env.example` with an empty or harmless value. Real values live in your own `.env`, which git ignores.
- Install the pre-commit hook with `npm run hooks:install`. It runs gitleaks on staged changes and refuses to commit when gitleaks is missing. `SKIP_GITLEAKS=1` skips the scan once.
- CI runs gitleaks on every push and pull request, and rescans the full history weekly.
- Maintainer only: a newly pushed GHCR package is private until its visibility is set to public in the package settings.
- Browser sessions, HAR files and cookie dumps belong under `local/`, which git ignores.

## Fixtures

Recorded API responses are scrubbed before they are committed: ids, names, emails and cookies are replaced with synthetic values.
