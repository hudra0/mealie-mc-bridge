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

## Adding a language

A language is data: a locale pack under `knowledge/locales/<locale>/` and, for the texts people read, a message catalog. The converter, the checks and the Monsieur Cuisine client read everything language-specific from the pack, so no code outside `src/i18n` changes. `knowledge/locales/en-US/` is the template; it was built with the steps below and is not verified on a device.

1. **Crawl** the public recipes of the locale (no account needed, one request per second, resumable):
   `npm run corpus:crawl -- --locale fr-FR`. The raw recipes land in `local/corpus/fr-FR/`, which git ignores; they are copyrighted and never enter the repository. Check first that the public API answers your locale: it serves `en-US` but refuses `en-GB`.
2. **Normalize and analyze** it: `npm run corpus:analyze -- --locale fr-FR`. The reports in `local/corpus/fr-FR/derived/*.md` show the units, group names and phrases official recipes of that language use.
3. **Build the generated files**: `npm run corpus:build-knowledge -- --locale fr-FR`. It writes `ingredient-catalog.json`, the piece weights and a `corpus` table of unit spellings, group names and serving units into `units.json`, and a `corpus` table of the most frequent short text steps into `phrases.json`. It never touches the neutral files, which come from the de-DE reference corpus. Run it again after the next step; it keeps what you wrote.
4. **Write the rest of the pack** by hand, in your own words, from the corpus tables and the reports. Copy a file of `en-US` and translate it:
   - `mc.json`: `locale`, `language` (the English name the prompt uses), `proxyLang` and `acceptLanguage`, `editorPath` (the path of "Create recipe" on monsieur-cuisine.com in your language), `complexityIds` for easy, medium and hard, `defaultGroupName` (what the web editor calls an unnamed ingredient group), `verifiedOnDevice: false` and `notes` saying what you have not checked. Category ids differ per language; the bridge fetches the category list in the pack's Accept-Language and caches it per locale.
   - `units.json`: the `vocabulary` (one entry per unit concept, mapped to a unit code of `src/ingredients/units.ts`), `decimalSeparator`, `allowedUnits`, `notAllowed`, `amountFormat`, `roundingGrid`, `freeTextMapping` (targets and name rules in your language), `nameConventions`, `groups`, `densityWords` and `liquidWords`.
   - `phrases.json`: the `standardPhrases` and `stepTitleRules` the prompt quotes (take the official wording from the corpus table), the word lists the checks read in step texts (adding verbs, emptying, cooling, setting aside, outside the bowl, hot additions, the whisk, measure words), `ingredientWords`, `matching` (stopwords, plural endings, regional names), `categoryMatching` and the `sectionLabels` of the converter input. List entries match anywhere inside a word; a leading `^` ties an entry to the start of a word and a trailing `$` to its end.
   - `technique-aliases.json`: the action words for every technique of `knowledge/techniques.json` and the words for every ingredient class.
   - `prompt-rules.md`: the rules that depend on the language, such as unit spellings, phrase wording, the catalog spelling of ingredient names and examples. The language-neutral rules stay in `knowledge/prompt-rules.md`.
5. **Add the message catalog** if your language has none yet: copy `src/i18n/en.ts` to `src/i18n/<language>.ts`, translate it, and add it to `UI_LANGUAGES` and `CATALOGS` in `src/i18n/index.ts`. The compiler and `src/i18n/i18n.test.ts` hold it to the same keys as the others.
6. **Run the pack test**: `npx vitest run src/locale/completeness.test.ts`, then `npm run check`. The test validates every folder under `knowledge/locales`: the file shapes, wording for every technique and ingredient class, every placeholder the neutral files use, the units your phrases name and the ingredient catalog.
7. **Try it**: `npm run convert -- prompt --mealie-json recipe.json --locale fr-FR` shows the prompts; `npm run convert:eval -- --locale fr-FR --ids ...` converts recipes of your corpus and compares them with the originals (it costs money).
8. **Verify on a device**: set `MC_LOCALE=fr-FR`, send a few recipes, open them in the web editor (difficulty, ingredient group, links), save them privately and cook one on the machine. Note what you checked in the pull request.
9. **Mark it verified**: set `verifiedOnDevice: true` in `mc.json`, update its `notes`, and say so in the README.
