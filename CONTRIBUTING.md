# Contributing

## Workflow

- Branch from `main`.
- Commit subjects are short and imperative ("Add ingredient parser"). The body explains why the change is needed, not what the diff already shows.
- Before pushing, run `npm run format:check && npm run lint && npm run typecheck && npm test`.

## Pull requests

Use this body, in this shape:

```markdown
## Summary

<diagram, diff-sketch, or tree>

## Evidence

- **Before:** <screenshot/output/failing test run>
  **After:** <screenshot/output/passing test run>

## Merge Danger

**Door:** <one-way or two-way>

<optional: description>

**Blast Radius:** <one-word description>

<optional: potential ramifications of merge>
```

Rules:

- Keep prose brief and skip preambles.
- Pick the smallest visual that makes the point: pseudocode, a call tree, a file tree, a mermaid sequence diagram, or a diff of the shape.
- Evidence is before/after output or tests.

## Secrets

- Never commit keys, cookies, tokens, passwords, or hostnames and addresses of private infrastructure.
- Put every setting in `.env.example` with an empty or harmless value. Real values live in your own `.env`, which git ignores.
- Install the pre-commit hook with `npm run hooks:install`. It runs gitleaks on staged changes when gitleaks is installed.
- CI runs gitleaks on every push and pull request.

## Fixtures

Recorded API responses are scrubbed before they are committed: ids, names, emails and cookies are replaced with synthetic values.
