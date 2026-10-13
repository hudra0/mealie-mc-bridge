// Knowledge builder for knowledge/timing-model.json, knowledge/units.json and the piece
// weights of the locale packs.
//
// timing-model.json holds time formulas, heat-up rules and mass limits for the validator
// and the converter; units.json holds the language-neutral densities and mass totals. The
// unit vocabulary, mapping, rounding grid and name rules of a language are hand-written in
// its locale pack; pieceWeightItems derives the pack's piece weights from its corpus.
//
// Input (parsed by the caller, produced by npm run corpus:analyze):
//   local/corpus/derived/steps.jsonl       NormalizedStep rows from corpus:normalize
//   local/corpus/derived/timing.json       written by run() in analyze-timing.ts
//   local/corpus/derived/ingredients.json  written by run() in analyze-ingredients.ts
//
// Corpus numbers come from those analyses. SmartRecipe limits and rules (bowl, turbo,
// flour, steaming liquid and basket limits) are typed in from its source analysis. Rule
// texts, notes and unit tables are hand-written data.
//
// No file I/O here: scripts/corpus/build-knowledge.ts (npm run corpus:build-knowledge)
// calls the builders and writes the results.

import type { run as runIngredients } from "./analyze-ingredients.js";
import type { Dist, LinearFit, run as runTiming } from "./analyze-timing.js";
import type { NormalizedStep } from "./types.js";

/** Shape of local/corpus/derived/timing.json. */
export type TimingAnalysis = ReturnType<typeof runTiming>;
/** Shape of local/corpus/derived/ingredients.json. */
export type IngredientsAnalysis = ReturnType<typeof runIngredients>;

export interface TimingUnitsInput {
  /** All rows of steps.jsonl. The current builders take every number from timing and ingredients. */
  steps: readonly NormalizedStep[];
  timing: TimingAnalysis;
  ingredients: IngredientsAnalysis;
}

export type TimingModel = ReturnType<typeof buildTimingModel>;
export type Units = ReturnType<typeof buildUnits>;

const SOURCE = "corpus 2026-10";

// ---------------------------------------------------------------------------
// Helpers

function round(x: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Returns the value, or throws when the analysis left a required value empty. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} is missing in the derived corpus analysis`);
  }
  return value;
}

function percent(share: number | null | undefined, what: string): number {
  return round(required(share, what) * 100, 1);
}

function pick(d: Dist) {
  return { typical: d.median, range: [d.p10, d.p90], steps: d.n };
}

function fit(f: LinearFit | null) {
  if (!f) return null;
  return {
    expression: `${round(f.a)} + ${round(f.b, 3)} * massGrams`,
    a: round(f.a),
    b: round(f.b, 4),
    r2: round(f.r2, 3),
    n: f.n,
    residualSeconds: {
      p10: round(required(f.residual.p10, "fit residual p10")),
      median: round(required(f.residual.median, "fit residual median")),
      p90: round(required(f.residual.p90, "fit residual p90")),
    },
  };
}

function logLogFit(f: LinearFit | null, what: string) {
  const v = required(f, what);
  return {
    expression: `exp(${round(v.a, 3)}) * massGrams ^ ${round(v.b, 3)}`,
    r2: round(v.r2, 3),
    n: v.n,
  };
}

// ---------------------------------------------------------------------------
// timing-model.json

export function buildTimingModel(input: TimingUnitsInput) {
  const { timing } = input;
  const h = timing.heating;
  const firstHeating = h.physics.customized.firstHeating;
  const roastFirstHeating = h.physics.roasting.firstHeating;
  const liquid = timing.steaming.liquidWeighedBeforeSteaming;
  const flour = timing.kneading.flourPerKneadStep;
  const puree = required(timing.blending.puree, "blending.puree");
  const smoothie = required(timing.blending.smoothie, "blending.smoothie");
  const manualBlend = required(timing.blending.manual_blend, "blending.manual_blend");
  const manualBlendSpeed = required(manualBlend.speed, "blending.manual_blend.speed");
  const transitions = timing.sequences.transitionShares;
  const bowl = timing.capacity.bowlEstimate;
  const bowlHeated = timing.capacity.bowlEstimateAtHeatedSteps;
  const fitTotal = required(timing.durations.fitTotal.all, "durations.fitTotal.all");
  const fitPrep = required(timing.durations.fitPrep.all, "durations.fitPrep.all");

  return {
    description:
      "Time formulas and mass limits for the validator and the converter. Mass numbers rely on a text heuristic for the bowl content (low to medium confidence); temperature and program defaults rely on many steps (medium to high confidence).",
    version: 1,
    source: SOURCE,
    constants: {
      heaterWatts: 1050,
      efficiency: 0.7,
      heatCapacityJoulePerKgKelvin: 4200,
      startTemperatureC: 20,
      note: "Assumptions for water-like contents, not measurements of the MC Smart.",
    },
    functions: {
      tMinSeconds: {
        expression: "massGrams / 1000 * 4200 * (min(temperature, 100) - 20) / (1050 * 0.7)",
        meaning:
          "Physical lower bound to bring water-like contents from 20 °C to the target (at most the boiling point).",
        secondsPerKgToBoil: 457,
        confidence: "high as a physical bound; ignores lid losses and the control loop",
      },
      clamp: { expression: "min(hi, max(lo, x))" },
    },
    heatUpRules: [
      {
        id: "heatup_too_short",
        appliesTo:
          "first heated manual step since the bowl was filled, temperature >= 90, bowl mass known",
        condition: "timeSeconds < 0.5 * tMinSeconds(massGrams, temperature)",
        severity: "error",
        evidence: `${percent(firstHeating.shareBelowHalfTMin, "heating.physics.customized.firstHeating.shareBelowHalfTMin")} % of ${firstHeating.n} first heatings in the corpus fall below half of tMin.`,
      },
      {
        id: "heatup_short",
        appliesTo: "same as heatup_too_short",
        condition: "timeSeconds < 0.87 * tMinSeconds(massGrams, temperature)",
        severity: "warning",
        typicalFactor: round(
          required(
            firstHeating.ratioOfficial.median,
            "heating.physics.customized.firstHeating.ratioOfficial.median",
          ),
          1,
        ),
        evidence: `0.87 is the p10 of time/tMin over ${firstHeating.ratioOfficial.n} official first heatings (median ${required(firstHeating.ratioOfficial.median, "heating.physics.customized.firstHeating.ratioOfficial.median")}, median headroom ${round(required(firstHeating.headroomSecondsOfficial.median, "heating.physics.customized.firstHeating.headroomSecondsOfficial.median"))} s above tMin).`,
      },
      {
        id: "content_already_hot",
        appliesTo: "heated step after an earlier heated step without emptying the bowl",
        condition:
          "heat up from the mixed temperature of the hot contents and any cold additions; skip the check while that stays at or above the rule temperature",
        evidence: `${percent(h.physics.customized.afterEarlierHeating.shareBelowTMin, "heating.physics.customized.afterEarlierHeating.shareBelowTMin")} % of such steps are shorter than tMin, as expected for hot contents.`,
      },
      {
        id: "mass_unknown",
        appliesTo: "bowl mass unknown because ingredients are given in pieces or spoons",
        condition:
          "convert pieces to grams with units.json pieceWeights first; skip the check when that fails and add a review hint",
      },
      {
        id: "roasting_not_water",
        appliesTo: "roasting program",
        condition: "do not apply the water model; roasting time is fixed by temperature",
        evidence: `Roasting first heatings: ${percent(roastFirstHeating.shareBelowTMin, "heating.physics.roasting.firstHeating.shareBelowTMin")} % below the water tMin, ratio median ${required(roastFirstHeating.ratio.median, "heating.physics.roasting.firstHeating.ratio.median")}.`,
      },
    ],
    manualCooking: {
      note: "The cooking goal (simmer a sauce, cook pasta, reduce) sets the time, not the mass. Use the defaults per temperature or per technique (techniques.json) and the mass only for the lower bound.",
      defaultsByTemperature: Object.fromEntries(
        Object.entries(h.customized.timeByTemperature)
          .filter(([, v]) => v.n >= 8)
          .map(([k, v]) => [k, pick(v)]),
      ),
      fitsByBand: Object.fromEntries(
        Object.entries(h.customized.fitsByBand).map(([band, v]) => [
          band,
          { all: fit(v.all), firstHeating: fit(v.firstHeating), official: fit(v.official) },
        ]),
      ),
      logLogFits: {
        all: logLogFit(h.customized.logLogFitAll, "heating.customized.logLogFitAll"),
        firstHeating: logLogFit(
          h.customized.logLogFitFirstHeating,
          "heating.customized.logLogFitFirstHeating",
        ),
      },
      defaultExpression: {
        expression: "max(tMinSeconds(massGrams, 100), 421 + 0.252 * massGrams)",
        appliesTo: "100 °C cooking when neither the source recipe nor a technique gives a time",
        confidence: "low (R² 0.07)",
      },
      firstHeatingTimeByMass: h.customized.minTimeByMass250gFirstHeating.map((b) => ({
        massGrams: [b.from, b.to],
        steps: b.time.n,
        p10: b.time.p10,
        median: b.time.median,
        tMinAt100: round(b.tMinAtBucketMid),
      })),
    },
    roasting: {
      note: "Roasting time is set by temperature, not mass.",
      defaultsByTemperature: Object.fromEntries(
        Object.entries(h.roasting.timeByTemperature)
          .filter(([, v]) => v.n >= 20)
          .map(([k, v]) => [k, pick(v)]),
      ),
      fitAll: fit(h.roasting.fitAll),
      fitOfficial: fit(h.roasting.fitOfficial),
      massGrams: { median: h.roasting.mass.median, p90: h.roasting.mass.p90 },
    },
    steaming: {
      note: "Steaming time does not depend on the food mass; pick it by load class.",
      timeAll: pick(timing.steaming.timeAll),
      byLoadClass: Object.fromEntries(
        Object.entries(timing.steaming.byClass).map(([k, v]) => [k, pick(v.time)]),
      ),
      liquidWeighedBefore: {
        typical: liquid.median,
        range: [liquid.p10, liquid.p90],
        min: liquid.min,
        steps: liquid.n,
        shareOfSteamingSteps: round(timing.steaming.shareWithLiquidWeighed, 3),
      },
      shareWithFoodCookingBelow: round(timing.steaming.shareBowlHoldsMoreThanLiquid, 3),
      fitFoodMass: fit(timing.steaming.fitTimeVsFoodMass),
    },
    kneading: {
      note: "Kneading time is a plateau: 120 s whatever the flour mass, up to the 1000 g flour limit per kneading step.",
      byMode: Object.fromEntries(
        Object.entries(timing.kneading.byMode).map(([k, v]) => [
          k,
          { ...pick(v.time), max: v.time.max },
        ]),
      ),
      expression: "min(240, max(60, round((95 + 0.091 * flourGrams) / 30) * 30))",
      fit: { ...fit(timing.kneading.fitAllTimeVsFlour), expression: "95 + 0.091 * flourGrams" },
      timeByFlour: timing.kneading.timeByFlour250g.map((b) => ({
        flourGrams: [b.from, b.to],
        steps: b.time.n,
        p10: b.time.p10,
        median: b.time.median,
        p90: b.time.p90,
      })),
      flourPerKneadStep: { median: flour.median, p90: flour.p90, max: flour.max },
      doughInBowl: {
        median: timing.kneading.doughMassAtKneadStep.median,
        max: timing.kneading.doughMassAtKneadStep.max,
      },
    },
    blending: {
      note: "Puree, smoothie and manual blending run 30-60 s almost regardless of mass.",
      puree: {
        ...pick(puree.time),
        fit: fit(puree.fitTimeVsMass),
        expression: "clamp(30, 120, 33 + 0.009 * massGrams)",
      },
      smoothie: { ...pick(smoothie.time), fit: fit(smoothie.fitTimeVsMass) },
      manualBlend: {
        definition: "customized, 0 °C, speed >= 8, at least 20 s",
        ...pick(manualBlend.time),
        speed: {
          typical: manualBlendSpeed.median,
          range: [manualBlendSpeed.p10, manualBlendSpeed.p90],
        },
        fit: fit(manualBlend.fitTimeVsMass),
      },
    },
    chopping: {
      definition: "customized, 0 °C, speed 5-10, at most 15 s",
      note: "Batch mass has no effect on chopping time.",
      timeBySpeed: Object.fromEntries(
        Object.entries(timing.chopping.timeBySpeed).map(([k, v]) => [k, pick(v)]),
      ),
      byIngredientClass: Object.fromEntries(
        Object.entries(timing.chopping.byClass).map(([k, v]) => [
          k,
          {
            speed: { typical: v.speed.median, range: [v.speed.p10, v.speed.p90] },
            timeSeconds: { typical: v.time.median, range: [v.time.p10, v.time.p90] },
            steps: v.n,
          },
        ]),
      ),
      fit: fit(timing.chopping.fitTimeVsBatch),
      turbo: { ...pick(timing.chopping.turbo.time), max: timing.chopping.turbo.time.max },
    },
    sequences: {
      note: "Chains of heated steps without emptying the bowl. Later steps in a chain start hot and run shorter.",
      chains: timing.sequences.chains,
      chainLength: {
        median: timing.sequences.chainLength.median,
        max: timing.sequences.chainLength.max,
      },
      chainTotalSeconds: pick(timing.sequences.chainTotalSeconds),
      // transitionShares already holds shares of all transitions; only n is a count.
      temperatureChange: {
        transitions: transitions.n,
        drops: round(transitions.tempDrops, 3),
        rises: round(transitions.tempRises, 3),
        same: round(transitions.tempSame, 3),
      },
      topTransitions: timing.sequences.topTransitions.slice(0, 12).map((t) => ({
        pair: t.pair,
        count: t.count,
        firstSeconds: t.firstSeconds,
        secondSeconds: t.secondSeconds,
      })),
    },
    massLimits: [
      {
        id: "bowl_max",
        maxGrams: 3000,
        appliesTo: "estimated bowl content at any step",
        severity: "error",
        source: "3 litre bowl; SmartRecipe prompt; bridge sanity rule",
        corpus: `Bowl estimate above 3000 g in ${percent(bowl.shareAbove["3000"], "capacity.bowlEstimate.shareAbove.3000")} % of recipes (max ${required(bowl.maxPerRecipe.max, "capacity.bowlEstimate.maxPerRecipe.max")} g), above 2500 g in ${percent(bowl.shareAbove["2500"], "capacity.bowlEstimate.shareAbove.2500")} %.`,
      },
      {
        id: "bowl_max_foaming",
        maxGrams: 2500,
        appliesTo:
          "contents that foam or boil up: milk, jam, pasta, rice, legumes, potatoes in water",
        severity: "warning",
        source: "bridge sanity rule",
        corpus: `Bowl estimate above 2500 g at heated steps in ${percent(bowlHeated.shareAbove["2500"], "capacity.bowlEstimateAtHeatedSteps.shareAbove.2500")} % of recipes.`,
      },
      {
        id: "turbo_bowl_max",
        maxGrams: 2500,
        appliesTo: "turbo steps",
        severity: "error",
        source: "SmartRecipe prompt",
      },
      {
        id: "flour_max_per_knead",
        maxGrams: 1000,
        appliesTo: "flour in the bowl at a kneading step",
        severity: "error",
        source: "SmartRecipe prompt",
        corpus: `Flour per kneading step median ${required(flour.median, "kneading.flourPerKneadStep.median")} g, p90 ${required(flour.p90, "kneading.flourPerKneadStep.p90")} g, max ${required(flour.max, "kneading.flourPerKneadStep.max")} g.`,
      },
      {
        id: "steaming_liquid_min",
        minGrams: 500,
        appliesTo: "water or stock in the bowl when a steaming step starts",
        severity: "error",
        source: "SmartRecipe prompt",
        corpus: `Liquid weighed in before steaming: median ${required(liquid.median, "steaming.liquidWeighedBeforeSteaming.median")} g, p10 ${required(liquid.p10, "steaming.liquidWeighedBeforeSteaming.p10")} g, min ${required(liquid.min, "steaming.liquidWeighedBeforeSteaming.min")} g.`,
      },
      {
        id: "steaming_time_vs_liquid",
        appliesTo: "long steaming",
        condition:
          "warn when steaming exceeds 1800 s with less than 1000 g of liquid; tell the user to check and refill water",
        severity: "warning",
        corpus: "Text steps that say to refill water: 31.",
      },
      {
        id: "basket_food_max",
        maxGrams: 1200,
        appliesTo: "food in the cooking basket",
        severity: "warning",
        source: "SmartRecipe prompt (about 1000-1200 g); not measured in the corpus",
      },
      {
        id: "scale_step_max",
        maxGrams: 2500,
        appliesTo: "one scale step",
        severity: "warning",
        source:
          "device-limits.json recommended scale range (corpus maximum); the hard limit of 5000 g is in device-programs.json",
      },
    ],
    temperatureNotes: [
      "Settings of 105-130 °C with water-based contents are normal practice and not a fault: the contents stay at their boiling point and the setting drives harder boiling and evaporation. Official recipes use them for steaming in manual mode (120 °C, speed 1, steamer fitted), for jam and for reducing with the basket on the lid.",
      "Starch thickens only at 95 °C or more for at least 120 s; yeast at most 37 °C; egg-yolk mixtures at 70-80 °C (bridge and SmartRecipe rules). Official recipes heat milk and cream at 100 °C; mind the foaming limit.",
    ],
    massEstimation: {
      method:
        "Scale steps add their weight unless the text says the weighing happens on a plate on the lid, in the steamer or outside the machine; text steps add listed grams when they name an ingredient with an adding verb; transfer or rinsing empties the bowl. Pieces and spoons count 0 g unless converted.",
      warning:
        "The normalizer's cumulativeGramsBefore never decreases and overstates the bowl (median 1460 g at heated steps against 825 g with resets). Do not use it for limits.",
      bowlAtHeatedSteps: {
        median: h.customized.massVsNaive.bowl.median,
        p90: h.customized.massVsNaive.bowl.p90,
      },
    },
    durations: {
      totalMinutes: {
        expression:
          "14.1 + 0.94 * machineMinutes + 0.63 * passiveMinutes + 1.32 * textSteps + 1.96 * scaleSteps",
        r2: round(fitTotal.r2, 2),
        n: fitTotal.n,
        note: "passiveMinutes = oven, proofing, chilling or resting time named in text steps (52 % of recipes have some).",
      },
      prepMinutes: {
        expression: "3.8 + 0.99 * textSteps + 0.73 * scaleSteps",
        r2: round(fitPrep.r2, 2),
        n: fitPrep.n,
        note: "fitted on recipes declaring 1-120 min prep; declared prep median 15 min",
      },
      minutesPerTextStep: { median: 1.5, p25: 0.9, p75: 2.8 },
      totalOverMachineByCategory: {
        "Suppen & Eintöpfe": 1.35,
        "One-Pot / All-in-One": 1.55,
        "Marmelade & Gelee": 1.5,
        Hauptgerichte: 1.74,
        Abendessen: 1.96,
        Getränke: 3,
        Desserts: 10,
        Backen: 18,
      },
      rule: "The declared total time is never below the summed machine time (38 of 2221 corpus recipes break this; the timing analysis counts 2.4 % with its own machine-time sum).",
    },
  };
}

// ---------------------------------------------------------------------------
// units.json (language-neutral) and the piece weights of a locale pack's units.json

// Singular and plural spellings of one item ("Zwiebel", "Zwiebeln") would give the
// converter two piece weights; only the one with more observations is kept.
export function singularPluralMerged<T extends { name: string; n: number }>(items: T[]): T[] {
  const key = (name: string) =>
    name
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/(?:en|n|e|s)$/u, ""))
      .join(" ");
  const best = new Map<string, T>();
  for (const item of items) {
    const current = best.get(key(item.name));
    if (!current || item.n > current.n) best.set(key(item.name), item);
  }
  return items.filter((item) => best.get(key(item.name)) === item);
}

export interface PieceWeightItem {
  name: string;
  unit: string;
  grams: number;
  range: [number, number];
  n: number;
}

// Grams per piece or package from weights the corpus states, entries with at least 4
// observations. `unitLabel` renames the analyzer's unit concept ("Stück") for the pack.
export function pieceWeightItems(
  ingredients: IngredientsAnalysis,
  unitLabel: (concept: string) => string = (concept) => concept,
): PieceWeightItem[] {
  return singularPluralMerged(ingredients.pieceWeights)
    .filter((p) => p.n >= 4 && !/\(|½/.test(p.name))
    .map((p) => {
      const spread = required(p.spread, "pieceWeights[].spread");
      return {
        name: p.name,
        unit: unitLabel(p.concept),
        grams: round(p.gramsPerUnit),
        range: [round(spread.p10), round(spread.p90)] as [number, number],
        n: p.n,
      };
    });
}

// The language-neutral unit data: densities per kind of liquid and the mass totals of the
// reference corpus. The unit vocabulary, the unit mapping, the rounding grid, piece weights
// and name conventions are language-specific and live in the locale packs
// (build-locale-pack.ts writes their corpus parts).
export function buildUnits() {
  return {
    description:
      "Language-neutral unit data for the converter: densities per kind of liquid and the mass totals of official ingredient lists. The unit vocabulary, the free-text unit mapping, the rounding grid, piece weights and name conventions are language-specific and live in the locale packs (knowledge/locales/<locale>/units.json).",
    version: 2,
    source: SOURCE,
    densities: {
      note: "g per ml. The corpus gives no densities; these are standard values the ingredient analysis used.",
      water: 1,
      milk: 1.03,
      stock: 1,
      cream: 1,
      wine: 1,
      oil: 0.92,
      honey: 1.4,
      syrup: 1.4,
    },
    massTotals: {
      note: "Sum of g over the ingredient list, not the bowl content.",
      allRecipes: { median: 1055, p90: 2280 },
      official: { median: 1273, p90: 2609 },
      shareAbove3000: { all: 0.026, official: 0.047 },
    },
  };
}
