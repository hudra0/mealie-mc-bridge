// Technique analysis: classifies every machine step of the normalized corpus
// with the rulebook in technique-rules.ts and aggregates the device settings
// per technique, so a prompt can say which settings official recipes use for
// a given cooking action.
//
// Input:  $CORPUS_DIR/derived/steps.jsonl, recipes.jsonl (from corpus:normalize)
// Output: $CORPUS_DIR/derived/techniques.json        aggregated table + spot-check list
//         $CORPUS_DIR/derived/techniques.md          rulebook and results explained
//         $CORPUS_DIR/derived/technique-steps.jsonl  one classification per machine step, no text
//
// Everything stays under the gitignored corpus directory.
//
// Run:   npm run corpus:analyze-techniques
// Debug: npm run corpus:analyze-techniques -- --dump=unclassified --n=30   (prints step context to stdout only)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRecipe,
  ingredientClasses,
  techniques,
  type ClassifiedStep,
  type Technique,
} from "./technique-rules.js";
import type { NormalizedRecipe, NormalizedStep } from "./types.js";
import { parseCorpusArgs } from "./locale.js";

// ---------------------------------------------------------------------------
// Statistics helpers

export interface Quantiles {
  n: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}

export function quantiles(values: readonly number[]): Quantiles {
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number): number | null => {
    if (v.length === 0) return null;
    // Nearest rank: device settings are discrete, so report observed values.
    const idx = Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1));
    return v[idx] ?? null;
  };
  return {
    n: v.length,
    min: v[0] ?? null,
    p10: at(0.1),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: v.at(-1) ?? null,
  };
}

const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

export function comboKey(step: NormalizedStep): string {
  const parts = [step.mode];
  if (step.temperature !== null) parts.push(`${step.temperature}°C`);
  if (step.timeSeconds !== null) parts.push(`${step.timeSeconds}s`);
  if (step.speed !== null) parts.push(`speed ${step.speed}`);
  if (step.reverse) parts.push("reverse");
  if (step.turbo) parts.push("turbo");
  return parts.join(" / ");
}

const nums = (values: readonly (number | null)[]) =>
  values.filter((x): x is number => typeof x === "number");

export interface TechniqueStats {
  steps: number;
  recipes: number;
  shareOfRecipes: number;
  bySource: Record<string, number>;
  modes: Record<string, number>;
  temperature: Quantiles;
  timeSeconds: Quantiles;
  speed: Quantiles;
  reverseShare: number;
  turboShare: number;
  cumulativeGramsBefore: Quantiles;
  topCombos: { combo: string; steps: number; share: number }[];
  mainIngredient: Record<string, number>;
  evidence: Record<string, number>;
}

export function techniqueStats(
  items: readonly ClassifiedStep[],
  recipeTotal: number,
): TechniqueStats {
  const steps = items.map((c) => c.step);
  const recipes = new Set(steps.map((s) => s.recipeId)).size;
  const combos = countBy(steps, comboKey);
  return {
    steps: steps.length,
    recipes,
    shareOfRecipes: recipeTotal ? round(recipes / recipeTotal) : 0,
    bySource: countBy(steps, (s) => s.source ?? "unknown"),
    modes: countBy(steps, (s) => s.mode),
    temperature: quantiles(nums(steps.map((s) => s.temperature))),
    timeSeconds: quantiles(nums(steps.map((s) => s.timeSeconds))),
    speed: quantiles(nums(steps.map((s) => s.speed))),
    reverseShare: steps.length ? round(steps.filter((s) => s.reverse).length / steps.length) : 0,
    turboShare: steps.length ? round(steps.filter((s) => s.turbo).length / steps.length) : 0,
    cumulativeGramsBefore: quantiles(steps.map((s) => s.cumulativeGramsBefore)),
    topCombos: Object.entries(combos)
      .slice(0, 5)
      .map(([combo, n]) => ({ combo, steps: n, share: round(n / steps.length) })),
    mainIngredient: countBy(items, (c) => c.result.mainIngredient),
    evidence: countBy(items, (c) => c.result.evidence ?? "none"),
  };
}

// Deterministic PRNG so the spot-check list is stable between runs.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const rnd = mulberry32(seed);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, n);
}

// ---------------------------------------------------------------------------
// IO

function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function classifyCorpus(
  recipes: readonly Pick<NormalizedRecipe, "id" | "title">[],
  steps: readonly NormalizedStep[],
): ClassifiedStep[] {
  const byRecipe = new Map<number, NormalizedStep[]>();
  for (const step of steps) {
    const list = byRecipe.get(step.recipeId) ?? [];
    list.push(step);
    byRecipe.set(step.recipeId, list);
  }
  const titles = new Map(recipes.map((r) => [r.id, r.title]));
  const out: ClassifiedStep[] = [];
  for (const [id, list] of byRecipe) {
    out.push(...classifyRecipe({ title: titles.get(id) ?? "", steps: list }));
  }
  return out;
}

function parseArgs(argv: readonly string[]): { dump: string | null; n: number } {
  let dump: string | null = null;
  let n = 20;
  for (const arg of argv) {
    if (arg.startsWith("--dump=")) dump = arg.slice(7);
    if (arg.startsWith("--n=")) n = Number(arg.slice(4)) || n;
  }
  return { dump, n };
}

export function run(corpusDir: string, argv: readonly string[] = []) {
  const started = Date.now();
  const derived = path.join(corpusDir, "derived");
  const recipes = readJsonl<NormalizedRecipe>(path.join(derived, "recipes.jsonl"));
  const steps = readJsonl<NormalizedStep>(path.join(derived, "steps.jsonl"));
  const classified = classifyCorpus(recipes, steps);

  const args = parseArgs(argv);
  if (args.dump) {
    const wanted = classified.filter(
      (c) =>
        c.step.mode !== "scale" && (c.result.technique === args.dump || c.step.mode === args.dump),
    );
    for (const c of sample(wanted, args.n, Date.now())) {
      const s = c.step;
      console.log(
        `#${s.recipeId}/${s.stepIndex} ${s.source} ${comboKey(s)} -> ${c.result.technique} ` +
          `[${c.result.keywords.join(", ")}] main=${c.result.mainIngredient}\n` +
          `  R: ${c.context.recipeTitle}\n  T: ${c.context.title}\n  B: ${c.context.before.slice(-300)}\n` +
          `  A: ${c.context.after.slice(0, 200)}\n  prev: ${c.context.prev?.technique ?? "-"}`,
      );
    }
    return null;
  }

  const output = buildOutput(recipes, classified);
  writeFileSync(path.join(derived, "techniques.json"), JSON.stringify(output, null, 2) + "\n");
  writeFileSync(path.join(derived, "technique-steps.jsonl"), stepLines(classified));
  writeFileSync(path.join(derived, "techniques.md"), renderMarkdown(output));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const t = output.totals;
  console.log(
    `corpus:analyze-techniques: ${t.machineSteps} machine steps (${t.nonScaleMachineSteps} without scale), ` +
      `unclassified ${t.unclassified} = ${(t.unclassifiedShareAll * 100).toFixed(1)} % of all, ` +
      `${(t.unclassifiedShareNonScale * 100).toFixed(1)} % of non-scale -> ${derived} (${seconds}s)`,
  );
  return output;
}

export function buildOutput(
  recipes: readonly Pick<NormalizedRecipe, "id" | "source">[],
  classified: readonly ClassifiedStep[],
) {
  const officialRecipes = recipes.filter((r) => r.source === "official").length;
  const nonScale = classified.filter((c) => c.step.mode !== "scale");
  const unclassified = classified.filter((c) => c.result.technique === "unclassified");

  const byTechnique = new Map<Technique, ClassifiedStep[]>();
  for (const c of classified) {
    const list = byTechnique.get(c.result.technique) ?? [];
    list.push(c);
    byTechnique.set(c.result.technique, list);
  }

  const techniqueTable: Record<string, unknown> = {};
  for (const id of Object.keys(techniques) as Technique[]) {
    const items = byTechnique.get(id) ?? [];
    const official = items.filter((c) => c.step.source === "official");
    techniqueTable[id] = {
      label: techniques[id],
      all: techniqueStats(items, recipes.length),
      official: techniqueStats(official, officialRecipes),
    };
  }

  const modes = [...new Set(classified.map((c) => c.step.mode))];
  const unclassifiedByMode = Object.fromEntries(
    modes
      .map((mode) => {
        const all = classified.filter((c) => c.step.mode === mode);
        const un = all.filter((c) => c.result.technique === "unclassified").length;
        return [
          mode,
          { steps: all.length, unclassified: un, share: round(un / all.length) },
        ] as const;
      })
      .sort((a, b) => b[1].steps - a[1].steps),
  );

  const classifiedNonScale = nonScale.filter((c) => c.result.technique !== "unclassified");
  const confusionCheck = sample(classifiedNonScale, 40, 20261013).map((c) => ({
    recipeId: c.step.recipeId,
    stepIndex: c.step.stepIndex,
    source: c.step.source,
    setting: comboKey(c.step),
    technique: c.result.technique,
    evidence: c.result.evidence,
    keywords: c.result.keywords,
    mainIngredient: c.result.mainIngredient,
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    note: "Derived from the gitignored corpus. Counts and settings only, no recipe text.",
    totals: {
      recipes: recipes.length,
      officialRecipes,
      machineSteps: classified.length,
      scaleSteps: classified.length - nonScale.length,
      nonScaleMachineSteps: nonScale.length,
      unclassified: unclassified.length,
      unclassifiedShareAll: round(unclassified.length / classified.length),
      unclassifiedShareNonScale: round(unclassified.length / nonScale.length),
      unclassifiedShareOfficialNonScale: round(
        unclassified.filter((c) => c.step.source === "official").length /
          nonScale.filter((c) => c.step.source === "official").length,
      ),
      evidenceNonScale: countBy(nonScale, (c) => c.result.evidence ?? "none"),
      mainIngredientClasses: ingredientClasses,
    },
    unclassifiedByMode,
    techniques: techniqueTable,
    confusionCheck,
  };

  return output;
}

function stepLines(classified: readonly ClassifiedStep[]): string {
  const rows = classified.map((c) =>
    JSON.stringify({
      recipeId: c.step.recipeId,
      stepIndex: c.step.stepIndex,
      source: c.step.source,
      mode: c.step.mode,
      temperature: c.step.temperature,
      timeSeconds: c.step.timeSeconds,
      speed: c.step.speed,
      reverse: c.step.reverse,
      technique: c.result.technique,
      family: c.result.family,
      evidence: c.result.evidence,
      keywords: c.result.keywords,
      mainIngredient: c.result.mainIngredient,
    }),
  );
  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Markdown report

type Output = ReturnType<typeof buildOutput>;

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const q = (x: Quantiles) => (x.n === 0 ? "–" : `${x.p25}–${x.p50}–${x.p75}`);

function renderMarkdown(out: Output): string {
  const t = out.totals;
  const rows = (Object.keys(techniques) as Technique[])
    .map((id) => ({
      id,
      stats: out.techniques[id] as { all: TechniqueStats; official: TechniqueStats },
    }))
    .filter((r) => r.id !== "unclassified" && r.stats.all.steps > 0)
    .sort((a, b) => b.stats.all.steps - a.stats.all.steps);

  const table = rows
    .map(({ id, stats }) => {
      const o = stats.official;
      const top = o.topCombos[0] ?? stats.all.topCombos[0];
      const mode = Object.keys(o.steps ? o.modes : stats.all.modes)[0] ?? "–";
      return (
        `| ${id} | ${stats.all.steps} | ${o.steps} | ${pct(stats.all.shareOfRecipes)} | ${mode} | ` +
        `${q(o.steps ? o.temperature : stats.all.temperature)} | ${q(o.steps ? o.timeSeconds : stats.all.timeSeconds)} | ` +
        `${q(o.steps ? o.speed : stats.all.speed)} | ${pct(o.steps ? o.reverseShare : stats.all.reverseShare)} | ` +
        `${top ? `${top.combo} (${top.steps})` : "–"} |`
      );
    })
    .join("\n");

  const modeRows = Object.entries(out.unclassifiedByMode)
    .map(([mode, v]) => `| ${mode} | ${v.steps} | ${v.unclassified} | ${pct(v.share)} |`)
    .join("\n");

  const evidenceRows = Object.entries(t.evidenceNonScale)
    .map(([e, n]) => `| ${e} | ${n} | ${pct(n / t.nonScaleMachineSteps)} |`)
    .join("\n");

  return `# Technique analysis

Generated ${out.generatedAt} by \`scripts/corpus/analyze-techniques.ts\` from
\`steps.jsonl\` and \`recipes.jsonl\`. Rulebook: \`scripts/corpus/technique-rules.ts\`.
Internal file, gitignored. Numbers only, no recipe text.

## Result

- Machine steps: ${t.machineSteps} (${t.scaleSteps} scale, ${t.nonScaleMachineSteps} other)
- Unclassified: ${t.unclassified} = **${pct(t.unclassifiedShareAll)} of all machine steps**,
  **${pct(t.unclassifiedShareNonScale)} of non-scale machine steps**
  (official recipes alone: ${pct(t.unclassifiedShareOfficialNonScale)} of non-scale steps)

The share over all machine steps is flattered by scale steps, which the mode
alone classifies. The non-scale share is the honest figure.

## How the rulebook works

Every machine step gets a context built from the derived step list of its recipe:

- **title**: the step's own text, blanked when it is an editor default
  ("Manuelles Kochen", "Rampe", "Schritt 3" ...). Official recipes title almost
  every manual step "Manuelles Kochen", so for them the context decides.
- **before**: the text steps *and scale steps* since the previous non-scale
  machine step (max 8). Scale step texts name the ingredients that go in, which
  the normalizer's \`prevTextSteps\` skips, so the context is rebuilt here.
- **after**: the text steps right after the step (max 2), e.g. "transfer the
  chopped ..." or "if not fine enough, run the next step".
- **bowl**: all step texts since the bowl was last emptied (transfer, rinse,
  clean), max 25 steps.
- **recipe**: the recipe title (used only for coarse hints: soup, drink, jam, risotto).
- **hot**: temperature > 0, or a heating program (roasting, steaming, slow
  cooking, sous-vide, fermentation, egg cooking). This binary flag is the only
  input taken from the settings. Temperature values, time and speed are never
  used, so the statistics below are not circular.
- **prev**: technique and heat of the previous non-scale machine step in the same bowl.

Classification has two stages.

1. **Family** (first match wins):
   1. Fixed program modes name the action: scale, steaming, sous_vide,
      slow_cooking, fermentation, cooking_eggs, precleaning, food_processor.
   2. Title verbs (zerkleinern, pürieren, anbraten, dünsten, kneten, verrühren,
      Hefe auflösen, schmelzen ...). A title verb loses against a program mode it
      contradicts (a kneading program titled "kochen" stays kneading).
   3. Program modes with a default family: turbo → chop, kneading* → knead,
      kneading_liquid_dough → batter, puree/ramp → puree, smoothie → mix,
      roasting → fry.
   4. Repeat: "run the next step if needed", or nothing but housekeeping (spatula,
      measuring cup, lid) since the previous step at the same heat → the step
      continues the previous technique.
   5. Keywords in the after/before text (whip, grind, chop, purée, melt, boil, sauté ...).
   6. Bowl contents plus heat. Hot: basket inserted or steamer put on → steam;
      basket placed on the lid as a splash guard → simmer (open reduction, not
      steaming); whisk + eggs or egg white → whip (also warm); yeast without
      flour → yeast; chocolate or butter without liquid or flour → melt; fat +
      onion/garlic → sauté; fat + meat → fry; flour added → roux/thicken; meat or
      vegetables without liquid → fry/sauté; fruit → simmer (compote); liquid in
      the bowl → simmer; soup/sauce/jam/risotto recipe → simmer. Cold: frozen
      items → ice; drink recipe → mix; flour + yeast in bowl → knead; flour +
      egg/milk → batter; flour without liquid → knead; seasoning or stir words
      → stir; minced meat → stir; nothing but housekeeping after a hot step in a
      soup/purée recipe → hot purée; sugar or grain alone → grind; whole or cut
      solids without liquid → chop; anything else added → stir.
   7. Nothing matched → unclassified.
2. **Technique**: the family is refined with ingredients and accessories, e.g.
   simmer + jam recipe → marmelade_einkochen, simmer + rice → risotto_reis,
   simmer + pasta → nudeln_garen, simmer + binding agent → eindicken_binden,
   knead + yeast in the bowl or "let rise" → hefeteig_kneten else muerbteig_kneten,
   fry + mostly onion/garlic → anschwitzen, fry + nuts/spices/sugar → roesten,
   puree when hot or right after a hot step → suppe_puerieren_heiss,
   steam + Dampfgaraufsatz/Gareinsatz mention → the matching accessory.

The **main ingredient class** counts keyword hits per class (title ×3, before ×2,
bowl ×1, liquid ×0.5) and takes the highest; ties go to the more specific class
(meat, fish, onion_garlic, chocolate, nuts, pasta, rice_grain, egg, flour_dough,
fruit, vegetables, dairy, liquid).

## Evidence used (non-scale steps)

| Evidence | Steps | Share |
|---|---|---|
${evidenceRows}

## Techniques

Settings columns use official steps where the technique has any, otherwise all
steps. Quantiles are p25–p50–p75 (nearest rank). Full numbers, member/official
split, gram quantiles and the top 5 combinations per technique are in
\`techniques.json\`.

| Technique | Steps | Official | Recipes | Main mode | Temp °C | Time s | Speed | Reverse | Top combination (official) |
|---|---|---|---|---|---|---|---|---|---|
${table}

## Unclassified share per mode

| Mode | Steps | Unclassified | Share |
|---|---|---|---|
${modeRows}

## Known limits

- Official manual steps carry no verb; their technique comes from context, so
  "stir" vs "chop" vs "purée" after cold additions is the weakest call.
- Repeat steps inherit the previous technique, which is right for "run again if
  not fine enough" and wrong if the author changes the action without saying so.
- The bowl reset only fires on explicit transfer/rinse/clean text; partial
  removals ("take the meat out") keep the old contents in the bowl.
- Manual and outside-the-machine actions ("knead by hand", "boil water in a
  kettle", "fry in a pan") still leak into the before/after text; the rulebook
  excludes the common ones but not all.
- Hot steps with liquid default to koecheln_garen; aufkochen only appears when
  a title or the following text says so, so it is undercounted.
- Spot checks during development (about 100 random steps read against the step
  text): roughly 85–90 % judged correct. Errors cluster in cold stir vs chop vs
  purée and in steps whose context window carries text about another mixture.
- \`confusionCheck\` in techniques.json lists 40 random classified steps
  (recipe id, step index, keywords) for a manual spot check against the raw data.
`;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || norm(entry) === norm(self.replace(/\.ts$/, ""));
}

if (isMain()) {
  const args = parseCorpusArgs(process.argv.slice(2));
  run(args.corpusDir, args.rest);
}
