// Knowledge builder for knowledge/timing-model.json and knowledge/units.json.
//
// timing-model.json holds time formulas, heat-up rules and mass limits for the validator
// and the converter; units.json holds the unit vocabulary, free-text unit mapping,
// rounding grid and piece weights for ingredient lists.
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
      "Starch thickens only at 95 °C or more for at least 120 s; yeast at most 37 °C; egg yolk at most 80 °C; milk at most 95 °C (bridge and SmartRecipe rules).",
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
// units.json

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

export function buildUnits(input: TimingUnitsInput) {
  const pieceWeights = singularPluralMerged(input.ingredients.pieceWeights)
    .filter((p) => p.n >= 4 && !/\(|½/.test(p.name))
    .map((p) => {
      const spread = required(p.spread, "pieceWeights[].spread");
      return {
        name: p.name,
        unit: p.concept,
        grams: round(p.gramsPerUnit),
        range: [round(spread.p10), round(spread.p90)],
        n: p.n,
      };
    });

  return {
    description:
      "Unit vocabulary, free-text unit mapping and rounding rules for MC Smart ingredient lists (de-DE official style).",
    version: 1,
    source: SOURCE,
    allowedUnits: [
      {
        unit: "g",
        officialRows: 7836,
        use: "Everything that can be weighed, liquids included (water, milk, stock, cream, oil). 65.3 % of official rows.",
      },
      {
        unit: "Stück",
        officialRows: 1448,
        use: "Countable items that are not weighed: eggs, garlic cloves, herb stems, slices, bay leaves, whole lemons.",
      },
      {
        unit: "Tl",
        officialRows: 1412,
        use: "Spices, salt, baking powder, small amounts. Mixed case; TL appears 35 times.",
      },
      {
        unit: "El",
        officialRows: 120,
        use: "Rare in official recipes; tablespoon amounts are converted to g in 88 % of cases.",
      },
      { unit: "Prise", officialRows: 249, use: "Amount 1 (or a fraction)." },
      { unit: "Prisen", officialRows: 269, use: "Amounts above 1 (3 exceptions in the corpus)." },
      {
        unit: "Msp.",
        officialRows: 147,
        use: "Knife tip, with a dot (Msp without dot 13 times).",
      },
      {
        unit: "",
        officialRows: 457,
        use: "To-taste items: purpose suffix in the name, empty amount.",
      },
    ],
    notAllowed: [
      "ml and l: 3 official rows in total; weigh liquids in g.",
      "Household units in the unit field (Dose, Päckchen, Bund, Zehe, Scheibe, Tasse, Becher, Handvoll, Glas): map them as in freeTextMapping.",
    ],
    amountFormat: {
      rules: [
        "A bare number as a string: integer (90.2 % of official rows), unicode fraction (4.8 %), empty (3.6 %), ASCII fraction (1.4 %).",
        "No decimals for spoon amounts, no ranges, no units inside the amount field.",
        "Fractions as unicode: ½, ¼, ¾, ⅛, 1 ½.",
        "In step text official recipes put a space between number and unit: 500 g (official scale steps: 6996 with a space, 1 without; member recipes mix both styles).",
      ],
      typicalValues: {
        Tl: { "1": 545, "½": 437, "¼": 196, "2": 157, "1 ½": 70, "3": 19, "1 ¼": 8, "4": 3 },
        El: { "1": 71, "2": 34, "3": 7, "4": 6, "1 ½": 3, "5": 1 },
        Prise: { "1": 246, "2": 147, "3": 84, "4": 26, "5": 6 },
        Stück: { "1": 459, "2": 283, "3": 145, "4": 177, "5": 62, "6": 45, "7": 112, "8": 35 },
      },
    },
    roundingGrid: {
      grams: [
        {
          band: [0, 10],
          step: 5,
          note: "All 240 official amounts below 10 g are exactly 5 g; smaller amounts move to Tl, Prise or Msp.",
        },
        { band: [10, 50], step: 5, preferredStep: 10, onPreferred: 0.851 },
        { band: [50, 100], step: 10, onStep: 0.916 },
        { band: [100, 250], step: 10, onStep: 0.936, preferredStep: 25, onPreferred: 0.803 },
        { band: [250, 500], step: 50, onStep: 0.924 },
        { band: [500, 1000], step: 50, onStep: 0.971, preferredStep: 100 },
        { band: [1000, null], step: 100, onStep: 1 },
      ],
      note: "Bands are [from, to) in grams. Member recipes round less (below 10 g only 53 % on 5 g). Snap converted amounts to the grid; keep the user's amount when it is already on a coarser grid.",
      spoons: "Tl and El in whole, half or quarter units; Prise and Msp. in whole units.",
    },
    freeTextMapping: [
      { input: ["g", "gramm", "gr", "grams"], target: "g", gramsPerUnit: 1 },
      { input: ["kg", "kilogramm", "kilogram"], target: "g", gramsPerUnit: 1000 },
      {
        input: ["ml", "milliliter", "millilitre"],
        target: "g",
        gramsPerUnit: "density",
        note: "use densities; water-like liquids 1 g/ml",
      },
      { input: ["l", "liter", "litre"], target: "g", gramsPerUnit: "1000 * density" },
      { input: ["cl"], target: "g", gramsPerUnit: "10 * density" },
      { input: ["dl"], target: "g", gramsPerUnit: "100 * density" },
      {
        input: ["EL", "El", "Esslöffel", "tbsp", "tablespoon"],
        target: "g",
        fallback: "El",
        gramsPerUnit: 15,
        evidence:
          "Member El rows with an official counterpart: g 88.2 %, Tl 7.6 %, El 2.3 %. 15 g per El from only 7 stated weights; liquids and powders differ (oil about 12 g, flour about 10 g, honey about 20 g).",
      },
      {
        input: ["TL", "Tl", "Teelöffel", "tsp", "teaspoon"],
        target: "Tl",
        alternative: "g for amounts of 5 g or more of sugar, butter or oil",
        gramsPerUnit: 5,
        evidence:
          "Member TL rows: official Tl 55.9 %, g 32.9 %, Prisen 7.9 %. 5 g per Tl from 9 stated weights.",
      },
      {
        input: ["Prise", "Prisen", "pinch"],
        target: "Prise / Prisen",
        alternative:
          "Tl for salt in savory dishes (official gives salt in Tl: Prise rows map to Tl in 65.3 %)",
        gramsPerUnit: null,
      },
      {
        input: ["Msp", "Msp.", "Messerspitze"],
        target: "Msp.",
        alternative: "Tl or Prisen",
        gramsPerUnit: null,
      },
      {
        input: ["Stück", "Stk", "St.", "piece", "pc", ""],
        target: "Stück when the item is not weighed by a scale step, otherwise g",
        gramsPerUnit: "pieceWeights",
        evidence:
          "Member Stück rows: official Stück 52.2 %, g 31.5 %, empty 15.8 %. Median stated piece weight 80 g over 979 annotations.",
      },
      {
        input: ["Zehe", "Zehen", "clove"],
        target: "Stück",
        nameRule:
          "write the clove into the name: Knoblauchzehen (290 official rows, plural even for 1)",
      },
      {
        input: ["Dose", "Dosen", "can", "tin"],
        target: "g",
        gramsPerUnit: 400,
        nameRule: "name ends in 'aus der Dose/Glas' (202 official rows)",
      },
      {
        input: ["Glas", "Gläser", "jar"],
        target: "g",
        gramsPerUnit: null,
        nameRule:
          "name ends in 'aus der Dose/Glas'; take the drained or net weight from the source",
      },
      {
        input: ["Päckchen", "Pkg", "Pck.", "P.", "packet", "sachet"],
        target: "g",
        gramsPerUnit: {
          Vanillezucker: 8,
          Backpulver: 16,
          Trockenhefe: 7,
          Vanillepuddingpulver: 37,
        },
      },
      { input: ["Würfel", "cube"], target: "g", gramsPerUnit: { "Hefe, frisch": 40 } },
      {
        input: ["Bund", "bunch"],
        target: "g or Stück of stems",
        gramsPerUnit: 125,
        evidence: "9 stated weights, spread 50-300 g: low confidence",
      },
      {
        input: ["Stiel", "Stiele", "Zweig", "Zweige", "sprig"],
        target: "Stück",
        nameRule:
          "write the stem into the name: Petersilienstiele, Thymianstiele (327 official rows)",
      },
      {
        input: ["Scheibe", "Scheiben", "slice"],
        target: "Stück",
        nameRule: "name ends in 'in Scheiben' (35 official rows with Stück, 7 with g)",
        gramsPerUnit: 30,
      },
      { input: ["Blatt", "Blätter", "leaf"], target: "Stück" },
      {
        input: ["Becher", "tub"],
        target: "g",
        gramsPerUnit: 200,
        evidence: "2 stated weights: low confidence; use the package size from the source",
      },
      {
        input: ["Handvoll", "handful"],
        target: "g",
        gramsPerUnit: null,
        note: "no stated weight in the corpus; estimate and add a review hint",
      },
      {
        input: ["Spritzer", "Tropfen", "dash", "drop"],
        target: "g or empty amount",
        gramsPerUnit: null,
      },
      {
        input: ["Tasse", "cup"],
        target: "g",
        gramsPerUnit: "240 ml * density",
        note: "US cup; not in the corpus. Dry goods: flour about 125 g, sugar about 200 g, rice about 185 g per cup.",
      },
      { input: ["oz", "ounce"], target: "g", gramsPerUnit: 28.35 },
      { input: ["lb", "pound"], target: "g", gramsPerUnit: 453.6 },
      { input: ["fl oz"], target: "g", gramsPerUnit: "29.57 * density" },
    ],
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
    pieceWeights: {
      note: 'Grams per piece or package from weights stated in the corpus ("1 Zwiebel (80 g)", scale steps, "à 170 g" in names). Entries with at least 4 observations.',
      items: pieceWeights,
    },
    nameConventions: [
      "Use the catalog spelling: 99.2 % of official rows link a catalog id; ids and names map one to one.",
      "Counted items use the plural catalog name even for 1: Knoblauchzehen, Eier (Größe M).",
      "Qualifiers go in parentheses (fat content, egg size, flour type: 17.5 % of official names) or after a comma (schwarz, gemahlen, getrocknet: 26 %).",
      "To-taste items: purpose suffix in the name and an empty amount, for example 'Salz zum Abschmecken' (210 rows) or 'Mehl zum Verarbeiten' (81). 96.8 % of official 'zum ...' rows have no amount.",
      "Optional markers (n. B., nach Belieben, etwas) are a member habit (12.1 % of member rows have one); official recipes almost never mark items optional.",
      "Equipment listed as an ingredient (jars, baking paper, moulds) goes into a ZUBEHÖR group and never counts toward the bowl mass (348 corpus rows).",
    ],
    groups: {
      shareOfficialWithoutGroups: 0.367,
      style:
        "Upper case (99.6 %): FÜR DEN/DIE/DAS <component> (56 %), yield header such as FÜR 12 STÜCKE (31 %), AUSSERDEM (8 %), ZUBEHÖR (4 %).",
      mostFrequent: {
        "FÜR DEN TEIG": 475,
        AUSSERDEM: 468,
        "FÜR DIE FÜLLUNG": 275,
        ZUBEHÖR: 273,
        "FÜR DEN BELAG": 161,
        "FÜR DIE SAUCE": 135,
      },
    },
    perPortionMedians: {
      note: "Median amount per portion over recipes counted in Portionen; a sanity check for scaled amounts.",
      items: {
        Salz: "¼ Tl",
        "Pfeffer, schwarz, gemahlen": "⅛ Tl",
        Butter: "10 g",
        Olivenöl: "6 g",
        Zucker: "12 g",
        Zwiebeln: "20 g",
        "Eier (Größe M)": "0.7 Stück",
        Knoblauchzehen: "0.4 Stück",
        "Mehl (Type 405)": "12.5 g",
        "Sahne (30 % Fett)": "37.5 g",
        "Gemüsebrühe, zubereitet": "130 g",
        Möhren: "37.5 g",
        "Kartoffeln, festkochend": "150 g",
      },
    },
    servings: {
      default: "4 Portionen (750 of 2221 recipes; median 4 for Portionen recipes)",
      units: ["Portionen", "Portion", "Stück", "Stücke", "Gläser", "Glas", "Flaschen"],
      byDishType: {
        Backen: "1 Stück or 12 Stücke",
        Getränke: "Flaschen or Gläser",
        "Marmelade & Gelee": "3 Gläser",
      },
    },
    massTotals: {
      note: "Sum of g over the ingredient list, not the bowl content.",
      allRecipes: { median: 1055, p90: 2280 },
      official: { median: 1273, p90: 2609 },
      shareAbove3000: { all: 0.026, official: 0.047 },
    },
  };
}
