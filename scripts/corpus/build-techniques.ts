// Builds knowledge/techniques.json: cooking techniques for the converter, each with the
// recommended device setting, alternatives seen in the corpus, structure rules and evidence.
//
// Hand-written technique metadata (labels, aliases, selection rules, structure notes in our
// own words) is merged with numbers from the corpus analysis:
//   $CORPUS_DIR/derived/steps.jsonl            (corpus:normalize)
//   $CORPUS_DIR/derived/technique-steps.jsonl  (corpus:analyze-techniques)
//   $CORPUS_DIR/derived/timing.json            (corpus:analyze-timing)
// Called by build-knowledge.ts (npm run corpus:build-knowledge); this module does no I/O.

import { accessoryActions } from "./analyze-structure.js";
import { chopClasses, classify } from "./analyze-timing.js";
import type { run as runTiming } from "./analyze-timing.js";
import type { ModeSetting, NormalizedStep } from "./types.js";

const SOURCE = "corpus 2026-10";

/** One row of technique-steps.jsonl. */
export interface TechniqueStepRow {
  recipeId: number;
  stepIndex: number;
  technique: string;
  mainIngredient: string | null;
}

export type TimingAnalysis = ReturnType<typeof runTiming>;

export interface TechniquesInput {
  steps: readonly NormalizedStep[];
  techniqueSteps: readonly TechniqueStepRow[];
  timing: TimingAnalysis;
}

/** A machine step enriched with its technique and the text since the previous machine step. */
interface Row {
  recipeId: number;
  source: string | null;
  mode: string;
  temperature: number | null;
  timeSeconds: number | null;
  speed: number | null;
  reverse: boolean;
  turbo: boolean;
  weight: number | null;
  modeSetting: ModeSetting | null;
  technique: string | null;
  mainIngredient: string | null;
  chopClass: string;
  splash: boolean;
}

// ---------------------------------------------------------------- enrich steps
function enrich(input: TechniquesInput): Row[] {
  const techByKey = new Map(input.techniqueSteps.map((r) => [`${r.recipeId}:${r.stepIndex}`, r]));
  const byRecipe = new Map<number, NormalizedStep[]>();
  for (const s of input.steps) {
    const list = byRecipe.get(s.recipeId) ?? [];
    list.push(s);
    byRecipe.set(s.recipeId, list);
  }
  const rows: Row[] = [];
  for (const list of byRecipe.values()) {
    list.sort((a, b) => a.stepIndex - b.stepIndex);
    list.forEach((s, i) => {
      if (s.kind !== "machine") return;
      const parts: string[] = [];
      let splash = false;
      for (let j = i; j >= 0; j--) {
        const p = list[j];
        if (!p) break;
        if (j < i && p.kind === "machine" && p.mode !== "scale") break;
        const txt = p.text.toLowerCase();
        parts.unshift(txt);
        if (j < i && p.kind === "text" && accessoryActions(txt, "gareinsatz").includes("splash"))
          splash = true;
      }
      const t = techByKey.get(`${s.recipeId}:${s.stepIndex}`);
      rows.push({
        recipeId: s.recipeId,
        source: s.source,
        mode: s.mode,
        temperature: s.temperature,
        timeSeconds: s.timeSeconds,
        speed: s.speed,
        reverse: s.reverse,
        turbo: s.turbo,
        weight: s.weight,
        modeSetting: s.modeSetting,
        technique: t?.technique ?? null,
        mainIngredient: t?.mainIngredient ?? null,
        chopClass: classify(parts.join(" | "), chopClasses).primary,
        splash,
      });
    });
  }
  return rows;
}

// ---------------------------------------------------------------- stats helpers
/** Nearest-rank quantile, so every value is one the device used. */
const q = (arr: readonly number[], p: number): number => {
  const s = [...arr].sort((a, b) => a - b);
  const v = s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  if (v === undefined) throw new Error("quantile of an empty list");
  return v;
};
type NumericKey = "temperature" | "timeSeconds" | "speed" | "weight";
const nums = (rows: readonly Row[], k: NumericKey) =>
  rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
const recipesOf = (rows: readonly Row[]) => new Set(rows.map((r) => r.recipeId)).size;
const basisOf = (rows: readonly Row[]) => {
  const off = rows.filter((r) => r.source === "official");
  return off.length >= 20
    ? { name: "official" as const, rows: off }
    : { name: "all" as const, rows: [...rows] };
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

interface Quant {
  typical: number;
  range: [number, number];
}
interface DeviceStats {
  basis: "official" | "all";
  n: number;
  temperature: Quant | null;
  timeSeconds: Quant | null;
  speed: { typical: number; max: number } | null;
  reverseShare: number;
}

function deviceStats(rows: readonly Row[], opts: { speedCap?: number } = {}): DeviceStats {
  const b = basisOf(rows);
  const T = nums(b.rows, "temperature");
  const t = nums(b.rows, "timeSeconds");
  const v = nums(b.rows, "speed");
  let speed: DeviceStats["speed"] = null;
  if (v.length) {
    let max = q(v, 0.9);
    if (opts.speedCap !== undefined) max = Math.min(max, opts.speedCap);
    speed = { typical: Math.min(q(v, 0.5), max), max };
  }
  return {
    basis: b.name,
    n: b.rows.length,
    temperature: T.length ? { typical: q(T, 0.5), range: [q(T, 0.1), q(T, 0.9)] } : null,
    timeSeconds: t.length ? { typical: q(t, 0.5), range: [q(t, 0.1), q(t, 0.9)] } : null,
    speed,
    reverseShare: r3(b.rows.filter((r) => r.reverse).length / Math.max(1, b.rows.length)),
  };
}

// ---------------------------------------------------------------- technique specs
type Cup = "in" | "out" | "either" | "n/a";
interface Spec {
  id: string;
  label: string;
  de: string[];
  en: string[];
  classes: string[];
  select: (r: Row) => boolean;
  selection: string;
  mode?: string;
  speedCap?: number;
  reverse?: boolean | string;
  cup: Cup;
  attachment?: string | null;
  formula?: string;
  formulaNote?: string;
  structure: string[];
  notes?: string[];
  alternativesNote?: Record<string, string>;
  pendingVerification?: string;
  statsMode?: string;
  /** Lower bound for the temperature range where the corpus p10 is physically too low. */
  temperatureMin?: { value: number; reason: string };
}

const T = (name: string) => (r: Row) => r.technique === name;
const chop = (cls: string) => (r: Row) =>
  r.mode === "customized" &&
  r.temperature === 0 &&
  (r.speed ?? 0) >= 5 &&
  (r.timeSeconds ?? 0) > 0 &&
  (r.timeSeconds ?? 0) <= 15 &&
  r.chopClass === cls;
const chopSel = (what: string) =>
  `manual mode, 0 °C, speed 5-10, at most 15 s, text since the previous machine step names ${what}`;

const pushDownNote =
  'Text step after the step: "mit dem Spatel nach unten schieben" when the next step works on the same contents (75.7 % of these phrases follow cold chopping, 18.6 % turbo).';
const cupInNote =
  "Measuring cup in the lid (state at cold manual steps: inserted 724, removed 237).";

const specs: Spec[] = [
  {
    id: "weigh_ingredient",
    label: "Weigh an ingredient into the bowl with the built-in scale",
    de: ["abwiegen", "einwiegen", "in den Mixbehälter geben", "zugeben", "dazugeben"],
    en: ["weigh", "add", "put in the bowl"],
    classes: ["any"],
    select: () => false,
    selection: "scale mode",
    mode: "scale",
    cup: "n/a",
    structure: [
      'One scale step per ingredient added by weight; the title starts with amount and name, for example "200 g Wasser" (78.7 % of official scale titles start with "<N> g").',
      "74.3 % of scale steps weigh exactly the gram amount of the one ingredient they name; split an ingredient across two scale steps only when it goes in at two points of the recipe.",
      "The text step right before a scale step names the same ingredient in only 3.2 % of cases: it prepares something else (cutting, fitting an accessory).",
      "Amounts below 5 g never go on the scale; write them in a text step in Tl, Prise or Msp.",
    ],
    notes: [
      "Scale steps carry text on the device, like turbo steps; all other program steps show only their title.",
    ],
  },
  {
    id: "chop_onion_garlic",
    label: "Chop onions, shallots, garlic or ginger",
    de: ["hacken", "fein hacken", "würfeln", "klein schneiden", "zerkleinern"],
    en: ["chop", "dice", "mince", "finely chop"],
    classes: ["onion_garlic"],
    select: chop("onion_garlic"),
    selection: chopSel("onion, shallot, garlic or ginger"),
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: peel and halve the onions (peeling is named in 35 % of the text before official chopping steps, halving in 20 %); garlic cloves go in whole.",
      cupInNote,
      pushDownNote,
      "Usually followed by fat in a scale step and the sauté or roasting step.",
    ],
    alternativesNote: {
      turbo: "Turbo for 2-3 s chops onions coarsely (229 turbo steps work on onion or garlic).",
    },
  },
  {
    id: "chop_vegetables",
    label: "Chop vegetables coarse or fine",
    de: ["zerkleinern", "grob hacken", "klein schneiden", "würfeln", "raspeln"],
    en: ["chop", "dice", "cut into small pieces", "shred"],
    classes: ["vegetables"],
    select: chop("vegetables"),
    selection: chopSel("a vegetable"),
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: peel and cut into pieces (pieces are named in 18 %, quartering in 14 % of the text before official chopping steps).",
      "Speed 5 chops coarse, 6-8 fine; for a finer result run a second short step instead of a longer one.",
      cupInNote,
      pushDownNote,
    ],
  },
  {
    id: "chop_herbs",
    label: "Chop fresh herbs",
    de: ["Kräuter hacken", "fein hacken", "zupfen und hacken"],
    en: ["chop herbs", "mince herbs"],
    classes: ["herbs"],
    select: chop("herbs"),
    selection: chopSel("a herb"),
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: pick the leaves from the stems; the ingredient list counts herbs as Stück of stems (Petersilienstiele, Thymianstiele).",
      "Chop herbs while the bowl is still dry, then transfer and set them aside when they are used at the end.",
    ],
  },
  {
    id: "chop_nuts_seeds",
    label: "Chop nuts or seeds",
    de: ["Nüsse hacken", "grob hacken", "hacken"],
    en: ["chop nuts", "roughly chop"],
    classes: ["nuts_seeds"],
    select: chop("nuts_seeds"),
    selection: chopSel("nuts, almonds or seeds"),
    reverse: false,
    cup: "in",
    structure: ["For ground nuts use grind_fine (speed 8-10, 10-20 s) instead.", cupInNote],
  },
  {
    id: "grate_hard_cheese",
    label: "Grate hard cheese",
    de: ["reiben", "Parmesan reiben", "fein reiben"],
    en: ["grate", "grate cheese"],
    classes: ["hard_cheese"],
    select: chop("hard_cheese"),
    selection: chopSel("cheese"),
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: cut the cheese into pieces; grate it first in the dry bowl and set it aside when the recipe needs it later.",
      cupInNote,
    ],
  },
  {
    id: "chop_chocolate",
    label: "Chop chocolate or couverture",
    de: ["Schokolade hacken", "grob hacken", "zerkleinern"],
    en: ["chop chocolate"],
    classes: ["chocolate"],
    select: chop("chocolate"),
    selection: chopSel("chocolate or couverture"),
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: break the chocolate into pieces.",
      "Chop before melting; the melt step follows in the same bowl at about 50 °C.",
    ],
  },
  {
    id: "chop_fruit",
    label: "Chop fruit",
    de: ["Obst zerkleinern", "würfeln", "klein schneiden"],
    en: ["chop fruit", "dice fruit"],
    classes: ["fruit"],
    select: chop("fruit"),
    selection: chopSel("a fruit"),
    reverse: false,
    cup: "in",
    structure: ["Text step before: peel, core and cut into pieces.", cupInNote],
  },
  {
    id: "chop_meat_fish",
    label: "Chop or mince meat, ham or fish",
    de: ["hacken", "zerkleinern", "fein hacken", "faschieren"],
    en: ["chop", "mince", "grind meat"],
    classes: ["meat", "fish"],
    select: chop("meat_fish"),
    selection: chopSel("meat, ham, bacon or fish"),
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: cut into pieces of about 3 cm; the meat should be well chilled.",
    ],
  },
  {
    id: "make_crumbs",
    label: "Make crumbs from bread, rolls or biscuits",
    de: ["Brösel herstellen", "zerbröseln", "fein mahlen"],
    en: ["make breadcrumbs", "crush biscuits"],
    classes: ["bread_biscuits"],
    select: chop("bread_biscuits"),
    selection: chopSel("bread, rolls, rusks or biscuits"),
    reverse: false,
    cup: "in",
    structure: ["Text step before: break into pieces; bread from the day before."],
  },
  {
    id: "turbo_pulse",
    label: "Turbo pulse for coarse chopping",
    de: ["Turbo", "kurz zerkleinern", "grob hacken"],
    en: ["pulse", "turbo"],
    classes: ["onion_garlic", "vegetables", "nuts_seeds", "hard_cheese"],
    select: (r) => r.mode === "turbo",
    selection: "turbo mode",
    mode: "turbo",
    reverse: false,
    cup: "in",
    structure: [
      'Turbo is its own step; its title names the seconds ("Turbo-Taste für 2 Sekunden"); the number matches the programmed time in 99.6 % of 262 such titles.',
      "Turbo steps sit early in the recipe (68 % in the first third) and are often followed by roasting (83 times).",
      "Never with the whisk fitted; never on hot contents (SmartRecipe rule: at most 60 °C) and at most 2500 g in the bowl.",
      pushDownNote,
    ],
    notes: [
      "Official recipes use 2 s most (125 of 244 steps); all sources together have median 3 s.",
    ],
  },
  {
    id: "grind_fine",
    label: "Grind fine: sugar to icing sugar, grains, spices, ground nuts",
    de: ["mahlen", "fein mahlen", "pulverisieren", "Puderzucker herstellen"],
    en: ["grind", "mill", "powder"],
    classes: ["sugar_spices", "rice_grain", "nuts_seeds"],
    select: T("fein_mahlen"),
    selection: 'technique "fein_mahlen"',
    reverse: false,
    cup: "in",
    structure: [
      "The bowl must be completely dry.",
      "Measuring cup in; let the dust settle before opening the lid.",
    ],
  },
  {
    id: "crush_ice_frozen",
    label: "Crush ice or blend frozen fruit (sorbet, ice cream)",
    de: ["Eis crushen", "zerkleinern", "Sorbet mixen"],
    en: ["crush ice", "blend frozen fruit"],
    classes: ["ice", "fruit"],
    select: T("eis_gefrorenes"),
    selection: 'technique "eis_gefrorenes"',
    reverse: false,
    cup: "in",
    structure: [
      "Frozen fruit straight from the freezer; push down with the spatula and repeat a short step if lumps remain.",
    ],
  },
  {
    id: "stir_cold",
    label: "Stir or mix cold ingredients",
    de: ["verrühren", "vermischen", "vermengen", "unterrühren", "mischen"],
    en: ["stir", "mix", "combine"],
    classes: ["dairy", "vegetables", "flour_dough", "egg"],
    select: (r) => r.technique === "ruehren_kalt" && !r.reverse,
    selection: 'technique "ruehren_kalt", forward rotation',
    reverse: false,
    cup: "in",
    structure: [
      'Text step before: name everything that goes in ("zugeben", "in den Mixbehälter geben").',
      "Speed 4 is the mixing speed (median 30 s at speed 4); speed 2-3 for short stirs.",
    ],
  },
  {
    id: "fold_in_reverse",
    label: "Fold in or stir gently so pieces stay whole (reverse rotation)",
    de: ["unterheben", "vorsichtig unterrühren", "im Linkslauf rühren"],
    en: ["fold in", "stir gently"],
    classes: ["vegetables", "meat", "dairy", "pasta"],
    select: (r) => r.technique === "ruehren_kalt" && r.reverse,
    selection: 'technique "ruehren_kalt", reverse rotation',
    speedCap: 3,
    reverse: true,
    cup: "either",
    structure: [
      "Reverse rotation makes the blade stir instead of cut (official guide); use it whenever solid pieces must stay whole.",
      "Speed with reverse never above 3.",
    ],
  },
  {
    id: "blend_smooth_cold",
    label: "Blend smooth (cold purée, pesto, dip, dressing)",
    de: ["pürieren", "fein pürieren", "mixen", "cremig mixen"],
    en: ["purée", "blend", "blend until smooth"],
    classes: ["vegetables", "fruit", "nuts_seeds", "liquid"],
    select: (r) =>
      r.mode === "customized" &&
      r.temperature === 0 &&
      (r.speed ?? 0) >= 8 &&
      (r.timeSeconds ?? 0) >= 20,
    selection:
      "manual mode, 0 °C, speed 8-10, at least 20 s (how official recipes purée cold contents)",
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: name what goes in; liquids first for a smoother result.",
      "Push down with the spatula and repeat a short step instead of one long one.",
    ],
    alternativesNote: {
      puree:
        "The puree program (30-60 s) does the same job; member recipes use it, official recipes almost never (3 steps).",
    },
  },
  {
    id: "puree_hot_soup",
    label: "Purée a hot soup or sauce after cooking",
    de: ["pürieren", "Suppe pürieren", "fein mixen"],
    en: ["purée soup", "blend soup"],
    classes: ["vegetables", "liquid"],
    select: T("suppe_puerieren_heiss"),
    selection: 'technique "suppe_puerieren_heiss"',
    mode: "puree",
    reverse: false,
    cup: "in",
    formula: "clamp(30, 120, 33 + 0.009 * massGrams)",
    formulaNote:
      "puree program time vs bowl mass, R² 0.13 (n 76): the time is nearly fixed at 30-60 s",
    structure: [
      "Measuring cup in before puréeing hot contents (at ramp steps the cup was inserted 30 times, never removed).",
      "Never start hot contents at a high speed. Without the puree program, use manual steps at 0 °C with rising speed, starting at speed 4 or lower, for example 10 s each at speed 4, 6 and 8 (official ramps run 4>5>6>7>8 at about 10 s per phase).",
      "Purée is the last machine step of a soup (63 % of ramp steps sit in the last third of the recipe).",
    ],
    notes: [
      "Official recipes purée hot soup with the ramp mode (35 of 52 official steps); member recipes use the puree program. The member editor offers the puree program but not ramp on MC3.0; the server stores ramp from a member account, but whether the device plays it is untested.",
    ],
    pendingVerification: "ramp mode for private drafts",
  },
  {
    id: "blend_drink_smoothie",
    label: "Blend a drink or smoothie",
    de: ["mixen", "aufmixen", "Smoothie mixen"],
    en: ["blend", "mix a drink"],
    classes: ["fruit", "vegetables", "dairy", "liquid"],
    select: T("mixen_smoothie"),
    selection: 'technique "mixen_smoothie"',
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: solids first, liquid on top; with turbo at most 2500 g in the bowl (SmartRecipe rule).",
    ],
    alternativesNote: { smoothie: "smoothie program, typically 60 s (member recipes)." },
  },
  {
    id: "whip",
    label: "Whip cream, egg whites or eggs with sugar (whisk attachment)",
    de: ["steif schlagen", "aufschlagen", "schaumig schlagen", "Sahne schlagen", "Eischnee"],
    en: ["whip", "whisk", "beat until stiff"],
    classes: ["egg", "dairy"],
    select: T("schlagen"),
    selection: 'technique "schlagen"',
    speedCap: 4,
    reverse: false,
    cup: "out",
    attachment: "whisk",
    structure: [
      'Own text step to fit the whisk attachment ("Rühraufsatz einsetzen", 230 text steps) and one to remove it afterwards (125).',
      "With the whisk fitted the speed is at most 4 (official guide; 92 % of steps with the whisk run at speed 4 or lower).",
      "Bowl and whisk must be free of fat for egg whites; cream should be cold.",
      "Whipping time depends on fat content and temperature, so the text step after says to check the stiffness.",
    ],
  },
  {
    id: "emulsify",
    label: "Emulsify: mayonnaise, aioli, creamy dressings",
    de: ["emulgieren", "Mayonnaise herstellen", "Öl einlaufen lassen", "aufschlagen"],
    en: ["emulsify", "make mayonnaise", "drizzle in oil"],
    classes: ["egg", "liquid"],
    select: T("emulgieren"),
    selection: 'technique "emulgieren"',
    speedCap: 4,
    reverse: false,
    cup: "out",
    structure: [
      'The oil goes in slowly through the lid opening while the blade runs ("durch die Deckelöffnung", 98 text steps; the next step is the working step in 94 %).',
      "Two-step pattern: a short step (about 10 s) mixes the base, then a long step at speed 4 (top setting 240 s) runs while the oil is poured onto the lid.",
    ],
  },
  {
    id: "batter_sponge",
    label: "Mix a cake batter or sponge mixture",
    de: ["Teig rühren", "Rührteig", "verrühren", "glatt rühren"],
    en: ["mix batter", "beat batter"],
    classes: ["flour_dough", "egg", "dairy"],
    select: T("ruehrteig_biskuit"),
    selection: 'technique "ruehrteig_biskuit"',
    reverse: false,
    cup: "in",
    structure: [
      "Soft butter, eggs at room temperature; add the flour last and mix only until combined.",
      "Push down with the spatula between two short mixing steps.",
    ],
    alternativesNote: {
      kneading_liquid_dough: "liquid-dough kneading program (member recipes).",
    },
  },
  {
    id: "activate_yeast",
    label: "Dissolve yeast in lukewarm liquid",
    de: ["Hefe auflösen", "Hefe anrühren", "lauwarm erwärmen"],
    en: ["dissolve yeast", "proof yeast", "warm milk"],
    classes: ["liquid", "dairy", "flour_dough"],
    select: T("hefe_aktivieren"),
    selection: 'technique "hefe_aktivieren"',
    speedCap: 3,
    reverse: false,
    cup: "in",
    structure: [
      "Text step before: crumble the fresh yeast into the liquid with a little sugar.",
      "Yeast never above 37 °C (SmartRecipe rule); 37 °C for 180 s at speed 1 is the standard setting (53 of 84 official steps).",
      "Followed directly by the flour and the kneading step (83 transitions from warm/dissolve to knead).",
    ],
  },
  {
    id: "knead_yeast_dough",
    label: "Knead a yeast dough",
    de: ["kneten", "Hefeteig kneten", "zu einem Teig verkneten"],
    en: ["knead", "knead the dough"],
    classes: ["flour_dough"],
    select: T("hefeteig_kneten"),
    selection: 'technique "hefeteig_kneten"',
    mode: "kneading_solid_dough",
    statsMode: "kneading",
    reverse: false,
    cup: "in",
    formula: "min(240, max(60, round((95 + 0.091 * flourGrams) / 30) * 30))",
    formulaNote:
      "kneading time vs flour in the bowl, R² 0.10: the time is a plateau at 120 s up to 1250 g flour",
    structure: [
      "At most 1000 g flour per kneading step (corpus maximum 1000 g, p90 600 g; SmartRecipe rule 1000 g).",
      "Text step after: let the dough rise covered outside the machine and name the time (52 % of recipes name passive time in text).",
    ],
    notes: [
      "Official recipes use the kneading program (120 s in 79 of 115 official yeast-dough steps); member recipes use kneading_solid_dough. The member editor offers only the kneading_*_dough variants on MC3.0; the server stores kneading from a member account, but whether the device plays it is untested.",
    ],
    pendingVerification: "kneading mode (official) for private drafts",
  },
  {
    id: "knead_short_dough",
    label: "Mix a short crust or another firm dough without yeast",
    de: ["Mürbteig kneten", "verkneten", "zu einem Teig verarbeiten"],
    en: ["make shortcrust", "knead briefly"],
    classes: ["flour_dough", "dairy", "egg"],
    select: T("muerbteig_kneten"),
    selection: 'technique "muerbteig_kneten"',
    mode: "kneading_solid_dough",
    statsMode: "kneading",
    reverse: false,
    cup: "in",
    structure: [
      "Cold butter in pieces; knead briefly so the dough stays short (official: kneading program for 45 s or 120 s, or 20 s at speed 4-6).",
    ],
    notes: [
      "Official recipes use the kneading program or a short manual step; member recipes use kneading_solid_dough or kneading_soft_dough.",
    ],
    pendingVerification: "kneading mode (official) for private drafts",
  },
  {
    id: "melt",
    label: "Melt chocolate or butter",
    de: ["schmelzen", "zerlassen", "Schokolade schmelzen", "Butter zerlassen"],
    en: ["melt"],
    classes: ["chocolate", "dairy"],
    select: T("schmelzen"),
    selection: 'technique "schmelzen"',
    speedCap: 3,
    reverse: false,
    cup: "either",
    structure: [
      "Text step before: break the chocolate or cut the butter into pieces (pieces are named in 38 % of the text before official melting steps).",
      "Chocolate at 50 °C (top setting 50 °C for 90 s at speed 1); butter tolerates up to 100 °C.",
    ],
  },
  {
    id: "warm_heat",
    label: "Warm or heat a liquid or a finished dish",
    de: ["erwärmen", "erhitzen", "warm machen", "temperieren"],
    en: ["warm", "heat", "reheat"],
    classes: ["liquid", "dairy", "vegetables"],
    select: T("erwaermen_temperieren"),
    selection: 'technique "erwaermen_temperieren"',
    speedCap: 3,
    reverse: "true when the dish contains pieces that must stay whole",
    cup: "either",
    structure: [
      "Milk at most 95 °C (SmartRecipe rule) so it does not boil over; stir at speed 1-2.",
    ],
    notes: [
      "Mostly a member-recipe label (23 official steps); official recipes fold warming into simmer steps.",
    ],
  },
  {
    id: "saute_onions",
    label: "Sauté onions, garlic or vegetables in fat without browning (anschwitzen, dünsten)",
    de: ["anschwitzen", "andünsten", "dünsten", "glasig dünsten"],
    en: ["sauté", "sweat", "soften"],
    classes: ["onion_garlic", "vegetables"],
    select: T("anschwitzen"),
    selection: 'technique "anschwitzen"',
    mode: "customized",
    speedCap: 3,
    reverse:
      "true when diced vegetables must keep their shape (52.6 % of official manual sauté steps)",
    cup: "out",
    structure: [
      "Text step before: add the fat (oil is named in 37 %) and push the chopped onions down with the spatula (the spatula is named in 50 % of the text before official sauté steps).",
      "Measuring cup out so the steam escapes (state at manual steps of 105-130 °C: removed 148, inserted 67).",
      "Spices bloom at the end of this step; deglaze afterwards with liquid in a scale step.",
    ],
    alternativesNote: {
      roasting:
        "The roasting program at 120-130 °C for 180 s does the same job (official top setting roasting 130 °C, 180 s).",
    },
  },
  {
    id: "sear_roast",
    label: "Sear or brown with the roasting program (anbraten)",
    de: ["anbraten", "braten", "scharf anbraten", "anrösten"],
    en: ["sear", "brown", "fry"],
    classes: ["vegetables", "meat", "onion_garlic"],
    select: T("anbraten"),
    selection: 'technique "anbraten"',
    mode: "roasting",
    reverse: false,
    cup: "out",
    structure: [
      "Measuring cup out before roasting (state at roasting steps: removed 493, inserted 15).",
      "Text step before: add the fat (oil is named in 47 %) and push down with the spatula (52 %).",
      "Roasting time does not scale with mass (fit 225 + 0.125 * grams, R² 0.09); 130 °C for 240 s is the median, 420 s the top setting.",
      "Followed by deglazing and simmering at 100 °C with reverse (66 transitions from roasting to a reverse simmer).",
    ],
    notes: ["The roasting program stores no speed; the device stirs on its own."],
  },
  {
    id: "toast_dry",
    label: "Toast nuts, seeds, spices or flour without fat",
    de: ["rösten", "anrösten", "ohne Fett rösten"],
    en: ["toast", "dry-roast"],
    classes: ["nuts_seeds", "sugar_spices", "flour_dough"],
    select: T("roesten"),
    selection: 'technique "roesten"',
    speedCap: 3,
    reverse: "true when whole nuts or seeds must stay whole",
    cup: "out",
    structure: ["Measuring cup out; transfer right afterwards so nothing burns in the hot bowl."],
    alternativesNote: { roasting: "roasting program at 110-130 °C." },
  },
  {
    id: "bring_to_boil",
    label: "Bring a liquid to the boil",
    de: ["aufkochen", "zum Kochen bringen", "aufwallen lassen"],
    en: ["bring to the boil", "boil"],
    classes: ["liquid", "vegetables"],
    select: T("aufkochen"),
    selection: 'technique "aufkochen" (member recipes only)',
    speedCap: 3,
    reverse: "true when the liquid contains pieces that must stay whole",
    cup: "either",
    formula: "max(tMinSeconds(massGrams, 100), 300)",
    formulaNote: "the step must at least cover the physical heat-up time; see timing-model.json",
    structure: [
      "Official recipes never title a step this way (0 official steps); they program a 100 °C simmer step long enough to reach the boil.",
    ],
  },
  {
    id: "simmer_cook",
    label: "Simmer or cook in liquid (soups, stews, sauces, vegetables)",
    de: ["köcheln", "kochen", "garen", "weich kochen", "köcheln lassen"],
    en: ["simmer", "cook", "boil gently", "stew"],
    classes: ["vegetables", "liquid", "meat", "dairy"],
    select: (r) => r.technique === "koecheln_garen" && !r.splash,
    selection: 'technique "koecheln_garen" without the basket as splash guard',
    speedCap: 3,
    reverse:
      "true when pieces must stay whole (vegetable chunks, meat, legumes); false for liquids that are puréed afterwards",
    cup: "either",
    formula: "max(tMinSeconds(massGrams, temperature), 421 + 0.252 * massGrams)",
    formulaNote:
      "100 °C fit over all steps (R² 0.07, residual p10/p90 -526/+623 s); the cooking goal sets the time, the mass only the lower bound",
    structure: [
      "Text step before: the liquid goes in by a scale step (stock, water); name what cooks.",
      "The first heated step after filling must at least cover the heat-up time (official headroom: time/tMin median 2.30, p10 0.87).",
      "Long simmering is often split into two steps at the same temperature: 600 s then 300 s at 100 °C (296 transitions).",
    ],
  },
  {
    id: "reduce_open",
    label: "Reduce or cook hard with the cooking basket on the lid as splash guard",
    de: ["einkochen", "reduzieren", "sämig einkochen", "offen köcheln"],
    en: ["reduce", "cook down", "simmer uncovered"],
    classes: ["liquid", "vegetables", "fruit"],
    select: (r) => r.splash && (r.temperature ?? 0) > 0,
    selection:
      'text before the step places the cooking basket on the lid ("Kocheinsatz als Spritzschutz")',
    speedCap: 3,
    reverse: "true when pieces must stay whole",
    cup: "out",
    attachment: "cooking_basket_on_lid",
    structure: [
      "Text step before: remove the measuring cup and set the cooking basket on the lid as a splash guard (98 such text steps; the next step is the working step in 91 %).",
      "This is not steaming: the basket only stops splashes while water evaporates.",
      "For a reduction keep the measuring cup out and extend the simmering time by the seconds given here; do not estimate the evaporation loss. Do not reduce soups.",
    ],
  },
  {
    id: "thicken_bind",
    label: "Thicken or bind: roux, béchamel, custard, starch-bound sauces",
    de: ["binden", "andicken", "eindicken", "Mehlschwitze", "Béchamel kochen"],
    en: ["thicken", "bind", "make a roux", "make béchamel"],
    classes: ["flour_dough", "dairy", "liquid"],
    select: T("eindicken_binden"),
    selection: 'technique "eindicken_binden"',
    speedCap: 3,
    reverse: "false for smooth sauces; true when the sauce already holds pieces",
    cup: "in",
    temperatureMin: { value: 95, reason: "starch binds only near the boil" },
    structure: [
      "Starch thickens only at 95 °C or more for at least 2 minutes (bridge sanity rule).",
      "Add thickeners in the last 2-3 minutes (SmartRecipe rule) or stir them cold into the liquid first.",
      "Egg yolk at most 80 °C, dairy at most 95 °C (SmartRecipe rules); custard runs at 80-90 °C, speed 2-3.",
    ],
  },
  {
    id: "cook_risotto",
    label: "Cook risotto or another rice dish in the bowl",
    de: ["Risotto kochen", "Reis garen", "Reis köcheln"],
    en: ["cook risotto", "cook rice in the bowl"],
    classes: ["rice_grain", "liquid"],
    select: T("risotto_reis"),
    selection: 'technique "risotto_reis"',
    speedCap: 3,
    reverse: true,
    cup: "either",
    structure: [
      "Always reverse rotation at speed 1 so the grains stay whole (reverse in 90.6 % of official steps).",
      "Sauté the rice briefly first, then add the liquid in a scale step.",
      "For plain rice the cooking basket in the bowl is the usual route, see cook_in_basket.",
    ],
  },
  {
    id: "cook_pasta",
    label: "Cook pasta in the bowl (one-pot)",
    de: ["Nudeln kochen", "Pasta garen", "Nudeln garen"],
    en: ["cook pasta", "boil noodles"],
    classes: ["pasta", "liquid"],
    select: T("nudeln_garen"),
    selection: 'technique "nudeln_garen"',
    speedCap: 3,
    reverse: true,
    cup: "either",
    structure: [
      "Reverse rotation at speed 1 (reverse in 92.3 % of official steps); the time follows the package cooking time plus about 2 minutes for the heat-up.",
      "Pasta cooks in the sauce or with enough liquid to cover it; keep the total below 3000 g.",
    ],
  },
  {
    id: "cook_milk_rice_pudding",
    label: "Cook milk rice, pudding or porridge",
    de: ["Milchreis kochen", "Pudding kochen", "Brei kochen", "Grießbrei"],
    en: ["cook rice pudding", "cook pudding", "cook porridge"],
    classes: ["dairy", "rice_grain", "egg"],
    select: T("milchreis_pudding_brei"),
    selection: 'technique "milchreis_pudding_brei"',
    speedCap: 3,
    reverse: "true for milk rice so the grains stay whole; false for smooth pudding",
    cup: "in",
    structure: [
      "Milk at most 95 °C (SmartRecipe rule); long milk rice steps run at 90-100 °C with reverse.",
    ],
  },
  {
    id: "cook_jam",
    label: "Cook jam, jelly or compote",
    de: ["Marmelade kochen", "einkochen", "Gelee kochen", "Kompott kochen"],
    en: ["make jam", "cook jam", "cook compote"],
    classes: ["fruit"],
    select: T("marmelade_einkochen"),
    selection: 'technique "marmelade_einkochen"',
    speedCap: 3,
    reverse: false,
    cup: "out",
    attachment: "cooking_basket_on_lid",
    structure: [
      "Measuring cup out and the cooking basket on the lid as splash guard (the basket is named before 20 % of official jam steps).",
      "Jam boils hard: at most 2500 g in the bowl (fill rule for foaming contents).",
      "Add a gelling test as a text step after the cooking step.",
    ],
  },
  {
    id: "cook_in_basket",
    label: "Cook potatoes, rice or eggs in the cooking basket",
    de: ["im Kocheinsatz garen", "Kartoffeln garen", "Reis im Garkorb kochen"],
    en: ["cook in the basket", "boil potatoes", "cook rice in the basket"],
    classes: ["potatoes", "rice_grain", "egg", "vegetables"],
    select: T("daempfen_gareinsatz"),
    selection: 'technique "daempfen_gareinsatz"',
    speedCap: 3,
    reverse: false,
    cup: "out",
    attachment: "cooking_basket",
    structure: [
      'Text step before: insert the cooking basket and fill it ("Kocheinsatz einsetzen", named before 90 % of these steps); water or stock goes into the bowl in a scale step.',
      "The basket holds about 1000-1200 g of food (SmartRecipe rule).",
      "Often combined with the steamer on top: the basket cooks a side while the steamer cooks the main item.",
    ],
    alternativesNote: {
      steaming: "steaming program for 900 s when the basket only steams above the water.",
    },
  },
  {
    id: "steam_in_steamer",
    label: "Steam in the steamer attachment (vegetables, fish, meat, dumplings)",
    de: ["dämpfen", "dampfgaren", "im Dampfgaraufsatz garen"],
    en: ["steam"],
    classes: ["vegetables", "fish", "meat", "potatoes", "flour_dough"],
    select: (r) =>
      r.technique === "daempfen_dampfgaraufsatz" || r.technique === "daempfen_unbestimmt",
    selection: 'techniques "daempfen_dampfgaraufsatz" and "daempfen_unbestimmt"',
    mode: "steaming",
    reverse: false,
    cup: "out",
    attachment: "steamer",
    structure: [
      "Scale step before: water or stock into the bowl, typically 1000 g, never below 500 g (p10 500 g over 270 steaming steps).",
      'Text steps before: spread the food in the steamer ("im Dampfgaraufsatz verteilen", 376 text steps) and set it on ("Dampfgaraufsatz aufsetzen", 342); name the level (deep bowl or flat insert) before 78.3 % of steaming steps.',
      "Steaming time does not scale with food mass (fit 877 + 0.343 * grams, R² 0.06); pick it by load class (timeByLoadClass).",
      "In 48 % of steaming steps something else cooks in the bowl below; count its mass toward the bowl limit.",
    ],
    notes: [
      "Official recipes also steam in manual mode at 120 °C, speed 1, with the steamer fitted (official top settings 120 °C for 180 s or 300 s).",
    ],
  },
  {
    id: "sous_vide",
    label: "Cook sous-vide in the bowl",
    de: ["sous-vide garen", "vakuumgaren"],
    en: ["sous-vide"],
    classes: ["meat", "fish", "egg"],
    select: T("sous_vide"),
    selection: 'technique "sous_vide"',
    mode: "sous_vide",
    reverse: false,
    cup: "n/a",
    structure: [
      "Text step before: vacuum-sealed food into the basket, water into the bowl to cover it; refill water during long programs (31 text steps say so).",
    ],
    notes: ["Only 7 steps in the corpus; the device limits come from SmartRecipe."],
  },
  {
    id: "slow_cook",
    label: "Slow cook a stew or braise",
    de: ["schmoren", "langsam garen", "Slow Cook"],
    en: ["slow cook", "braise"],
    classes: ["meat", "vegetables"],
    select: T("slow_cooking"),
    selection: 'technique "slow_cooking"',
    mode: "slow_cooking",
    reverse: false,
    cup: "n/a",
    structure: [
      "Sear in a roasting step first, then deglaze, then slow cook (official: 90 °C for 3-4 h).",
    ],
    notes: ["Only 8 steps in the corpus."],
  },
  {
    id: "ferment",
    label: "Ferment or proof (yogurt, dough rising in the bowl)",
    de: ["fermentieren", "gehen lassen", "Joghurt herstellen"],
    en: ["ferment", "proof", "make yogurt"],
    classes: ["dairy", "flour_dough"],
    select: T("fermentieren"),
    selection: 'technique "fermentieren"',
    mode: "fermentation",
    reverse: false,
    cup: "n/a",
    structure: [
      "Official recipes ferment at 40 °C for 1-12 h, member recipes at 37 °C. Yeast doughs usually rise outside the machine instead.",
    ],
    notes: ["Only 10 steps in the corpus."],
  },
  {
    id: "cook_eggs",
    label: "Cook eggs with the egg program",
    de: ["Eier kochen"],
    en: ["boil eggs"],
    classes: ["egg"],
    select: T("eier_kochen"),
    selection: 'technique "eier_kochen"',
    mode: "cooking_eggs",
    reverse: false,
    cup: "n/a",
    structure: [
      "The eggs go into the cooking basket; the program sets time and temperature from size and texture.",
    ],
    notes: ["Only 3 steps in the corpus, all size medium."],
  },
  {
    id: "food_processor_slice",
    label: "Slice or grate with the food processor attachment",
    de: ["hobeln", "in Scheiben schneiden", "raspeln"],
    en: ["slice", "grate", "shred"],
    classes: ["vegetables", "potatoes"],
    select: T("food_processor"),
    selection: 'technique "food_processor"',
    mode: "food_processor",
    reverse: false,
    cup: "n/a",
    attachment: "food_processor",
    structure: [
      "Needs the optional food processor attachment; use it only when the installation says the user owns one (SmartRecipe flag MC_HAS_FOOD_PROCESSOR).",
    ],
  },
  {
    id: "preclean",
    label: "Pre-clean the bowl between stages",
    de: ["vorreinigen", "Mixbehälter reinigen"],
    en: ["pre-clean", "rinse the bowl"],
    classes: [],
    select: T("vorreinigen"),
    selection: 'technique "vorreinigen" (member recipes only)',
    mode: "precleaning",
    reverse: false,
    cup: "n/a",
    structure: [
      'Official recipes write a text step instead ("Mixbehälter ausspülen", 731 text steps); prefer the text step.',
    ],
  },
];

// ---------------------------------------------------------------- build techniques.json
interface Device {
  mode: string;
  weightGrams?: Quant & { max: number };
  modeSetting?: Record<string, { typical?: string; observed: Record<string, number> }>;
  temperature?: (Quant & { note?: string }) | null;
  timeSeconds?: (Partial<Quant> & { formula?: string; formulaNote?: string }) | null;
  speed?: DeviceStats["speed"];
  reverse?: boolean | string;
  turbo?: boolean;
  accessory?: { measuringCup: Cup; attachment: string | null };
}
interface Alternative {
  mode: string;
  steps?: number;
  officialSteps?: number;
  temperature?: Quant;
  timeSeconds?: Quant;
  speed?: { typical: number; max: number };
  reverseShare?: number;
  note?: string;
}
export interface TechniqueEntry {
  id: string;
  label: string;
  aliases: { de: string[]; en: string[] };
  ingredientClasses: string[];
  device: Device;
  recommendedModeObserved?: {
    mode: string;
    steps: number;
    basis: DeviceStats["basis"];
    timeSeconds: Quant | null;
    note: string;
  };
  alternatives?: Alternative[];
  timeByLoadClass?: Record<
    string,
    { typical: number | null; range: [number | null, number | null]; steps: number }
  >;
  structure: string[];
  notes?: string[];
  pendingVerification?: string;
  evidence: {
    steps: number;
    recipes: number;
    officialSteps: number;
    officialRecipes: number;
    modes: Record<string, number>;
    basis: DeviceStats["basis"];
    basisSteps: number;
    statsMode: string;
    reverseShare: number;
    selection: string;
    source: string;
  };
}

const count = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function buildTechniques(input: TechniquesInput) {
  const E = enrich(input);
  const timing = input.timing;
  const scaleRows = E.filter((r) => r.mode === "scale");
  const noHeat = new Set(["steaming", "turbo", "puree", "smoothie", "food_processor"]);
  const out: TechniqueEntry[] = [];
  for (const s of specs) {
    const rows = s.id === "weigh_ingredient" ? scaleRows : E.filter(s.select);
    if (!rows.length) throw new Error(`no rows for ${s.id}`);
    const officialRows = rows.filter((r) => r.source === "official");
    const modeCounts: Record<string, number> = {};
    for (const r of rows) count(modeCounts, r.mode);
    const basisAll = basisOf(rows);
    const basisModeCounts: Record<string, number> = {};
    for (const r of basisAll.rows) count(basisModeCounts, r.mode);
    const topMode = Object.entries(basisModeCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const mainMode = s.mode ?? topMode;
    if (mainMode === undefined) throw new Error(`no mode for ${s.id}`);
    const modeRows = rows.filter((r) => r.mode === (s.statsMode ?? mainMode));
    if (!modeRows.length) throw new Error(`no rows for ${s.id} in mode ${mainMode}`);
    const st = deviceStats(modeRows, s.speedCap === undefined ? {} : { speedCap: s.speedCap });
    const device: Device = { mode: mainMode };
    const extraNotes: string[] = [];
    if (mainMode === "scale") {
      const w = nums(basisOf(rows).rows, "weight");
      device.weightGrams = {
        typical: q(w, 0.5),
        range: [q(w, 0.1), q(w, 0.9)],
        max: Math.max(...w),
      };
    } else if (mainMode === "cooking_eggs") {
      const sizes: Record<string, number> = {};
      const tex: Record<string, number> = {};
      for (const r of modeRows) {
        if (r.modeSetting?.size) count(sizes, r.modeSetting.size);
        if (r.modeSetting?.texture) count(tex, r.modeSetting.texture);
      }
      device.modeSetting = {
        size: { typical: "medium", observed: sizes },
        texture: { observed: tex },
      };
    } else if (mainMode === "precleaning") {
      const c: Record<string, number> = {};
      for (const r of modeRows)
        if (r.modeSetting?.cleaningMode) count(c, r.modeSetting.cleaningMode);
      device.modeSetting = { duration: { typical: "short", observed: c } };
    } else {
      device.temperature = st.temperature;
      if (noHeat.has(mainMode) || mainMode.startsWith("kneading"))
        device.temperature = {
          typical: 0,
          range: [0, 0],
          note: mainMode === "steaming" ? "device-controlled; the API stores 0" : "no heating",
        };
      const floor = s.temperatureMin;
      const temp = device.temperature;
      if (floor && temp && temp.range[0] < floor.value) {
        extraNotes.push(
          `The temperature range starts at ${floor.value} °C because ${floor.reason}; the corpus p10 is ${temp.range[0]} °C.`,
        );
        device.temperature = {
          ...temp,
          typical: Math.max(temp.typical, floor.value),
          range: [floor.value, Math.max(temp.range[1], floor.value)],
        };
      }
      device.timeSeconds = s.formula
        ? {
            ...st.timeSeconds,
            formula: s.formula,
            ...(s.formulaNote ? { formulaNote: s.formulaNote } : {}),
          }
        : st.timeSeconds;
      device.speed = mainMode === "customized" ? st.speed : null;
    }
    device.reverse =
      s.reverse ??
      (st.reverseShare >= 0.8
        ? true
        : st.reverseShare <= 0.15
          ? false
          : `optional (reverse in ${Math.round(st.reverseShare * 100)} %)`);
    device.turbo = mainMode === "turbo";
    device.accessory = { measuringCup: s.cup, attachment: s.attachment ?? null };

    const alternatives: Alternative[] = [];
    for (const [m, n] of Object.entries(modeCounts).sort((a, b) => b[1] - a[1])) {
      if (m === mainMode) continue;
      const altNote = s.alternativesNote?.[m];
      if (n / rows.length < 0.1 && !altNote) continue;
      const ar = rows.filter((r) => r.mode === m);
      const as = deviceStats(ar, s.speedCap === undefined ? {} : { speedCap: s.speedCap });
      const alt: Alternative = {
        mode: m,
        steps: n,
        officialSteps: ar.filter((r) => r.source === "official").length,
      };
      if (as.temperature && as.temperature.range[1] > 0) alt.temperature = as.temperature;
      if (as.timeSeconds) alt.timeSeconds = as.timeSeconds;
      if (as.speed && m === "customized") alt.speed = as.speed;
      if (m === "customized") alt.reverseShare = as.reverseShare;
      if (altNote) alt.note = altNote;
      alternatives.push(alt);
    }
    for (const [m, note] of Object.entries(s.alternativesNote ?? {})) {
      if (m === mainMode || alternatives.some((a) => a.mode === m)) continue;
      alternatives.push({ mode: m, note });
    }

    const entry: TechniqueEntry = {
      id: s.id,
      label: s.label,
      aliases: { de: s.de, en: s.en },
      ingredientClasses: s.classes,
      device,
      structure: s.structure,
      evidence: {
        steps: rows.length,
        recipes: recipesOf(rows),
        officialSteps: officialRows.length,
        officialRecipes: recipesOf(officialRows),
        modes: modeCounts,
        basis: st.basis,
        basisSteps: st.n,
        statsMode: s.statsMode ?? mainMode,
        reverseShare: st.reverseShare,
        selection: s.selection,
        source: SOURCE,
      },
    };
    if (s.statsMode && s.statsMode !== mainMode) {
      const mr = rows.filter((r) => r.mode === mainMode);
      const ms = deviceStats(mr);
      entry.recommendedModeObserved = {
        mode: mainMode,
        steps: mr.length,
        basis: ms.basis,
        timeSeconds: ms.timeSeconds,
        note: `device numbers above come from the ${s.statsMode} mode; this is what recipes using ${mainMode} programmed`,
      };
    }
    if (alternatives.length) entry.alternatives = alternatives;
    if (s.id === "steam_in_steamer") {
      entry.timeByLoadClass = Object.fromEntries(
        Object.entries(timing.steaming.byClass)
          .filter(([, v]) => v.n >= 10)
          .map(([k, v]) => [
            k,
            { typical: v.time.median, range: [v.time.p10, v.time.p90], steps: v.n },
          ]),
      );
      // One steaming default for the bridge: the timing model's numbers over all steaming steps.
      const all = timing.steaming.timeAll;
      if (all.median === null || all.p10 === null || all.p90 === null)
        throw new Error("timing.json: steaming.timeAll is empty");
      device.timeSeconds = { typical: all.median, range: [all.p10, all.p90] };
      const sample = st.timeSeconds;
      extraNotes.push(
        `timeSeconds follows timing-model.json (steaming.timeAll over all ${all.n} steaming-program steps).` +
          (sample
            ? ` The ${st.n} ${st.basis} steaming steps assigned to this technique give ${sample.typical} s (${sample.range[0]}-${sample.range[1]} s); the difference comes from the sample, not from the device.`
            : ""),
      );
    }
    const notes = [...(s.notes ?? []), ...extraNotes];
    if (notes.length) entry.notes = notes;
    if (s.pendingVerification) entry.pendingVerification = s.pendingVerification;
    out.push(orderEntry(entry));
  }
  return {
    description:
      "Cooking techniques for the converter, derived from the de-DE MC Smart corpus. Numbers and generic phrases only, in our own words; no recipe text.",
    version: 1,
    source: SOURCE,
    corpus: {
      recipes: 2221,
      official: 1094,
      member: 1127,
      steps: 42322,
      machineSteps: 20999,
      language: "de-DE",
      device: "MC3.0",
    },
    fields: {
      "device.mode":
        "Recommended mode for an uploaded draft. Official practice that differs is listed under alternatives and notes.",
      "device.temperature":
        "°C; typical = median, range = [p10, p90] of the basis group in the recommended mode (nearest rank, so every value is one the device used).",
      "device.timeSeconds":
        "Seconds; typical = median, range = [p10, p90]. formula, when present, is an expression in massGrams (bowl content), flourGrams or temperature, using tMinSeconds() from timing-model.json; clamp(lo, hi, x) limits x to [lo, hi].",
      "device.speed":
        "typical = median, max = p90 of the basis group, capped by the rules in device-limits.json (3 when heated or in reverse, 4 with the whisk). null for program modes, which store no speed.",
      "device.reverse": "true, false, or a condition the converter decides per recipe.",
      "device.accessory.measuringCup": "in, out, either (the recipe decides) or n/a.",
      "device.accessory.attachment":
        "null, whisk (Rühraufsatz), cooking_basket (Kocheinsatz in the bowl), cooking_basket_on_lid (Kocheinsatz as splash guard), steamer (Dampfgaraufsatz), food_processor.",
      alternatives:
        "Other modes the corpus uses for the same technique, with their own quantiles; included when they cover at least 10 % of the technique's steps or carry a note.",
      "evidence.statsMode":
        "Mode whose steps supplied the device numbers. It differs from device.mode when official recipes use a mode that the member editor does not offer (kneading); recommendedModeObserved then shows the numbers of the recommended mode.",
      "evidence.basis":
        "official when the recommended mode has at least 20 official steps for this technique, otherwise all recipes.",
      "evidence.selection":
        "How steps were assigned to the technique. Technique labels come from a rule-based classifier that was about 85-90 % correct on a manual spot check of about 100 steps.",
      ingredientClasses:
        "vegetables, onion_garlic, herbs, nuts_seeds, hard_cheese, chocolate, fruit, meat, fish, dairy, egg, flour_dough, sugar_spices, bread_biscuits, rice_grain, pasta, potatoes, liquid, ice",
    },
    techniques: out,
  };
}

/** Puts the optional fields of an entry back into the published key order. */
function orderEntry(e: TechniqueEntry): TechniqueEntry {
  const { recommendedModeObserved, alternatives, timeByLoadClass, notes, pendingVerification } = e;
  return {
    id: e.id,
    label: e.label,
    aliases: e.aliases,
    ingredientClasses: e.ingredientClasses,
    device: e.device,
    ...(recommendedModeObserved ? { recommendedModeObserved } : {}),
    ...(alternatives ? { alternatives } : {}),
    ...(timeByLoadClass ? { timeByLoadClass } : {}),
    structure: e.structure,
    ...(notes ? { notes } : {}),
    ...(pendingVerification ? { pendingVerification } : {}),
    evidence: e.evidence,
  };
}
