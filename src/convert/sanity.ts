// Plausibility checks on a recipe that passed the schema: physics (heat-up time, bowl
// mass), accessory rules, recipe structure and the balance of amounts against the input.
// The validator checks every limit of device-programs.json; these rules check what a
// limit table cannot see. Errors go back to the model for a correction round, warnings
// become review hints.
//
// Each rule is a data entry (id, what it checks) with a function. Thresholds come from
// the knowledge base: timing-model.json massLimits and heatUpRules, device-limits.json
// rules, techniques.json temperature ranges.

import type { DeviceLimits } from "../recipe/limits.js";
import type { RecipeInput, RecipeStep } from "../recipe/schema.js";
import type { ValidationIssue } from "../recipe/validate.js";
import type { NormalizedIngredient } from "../ingredients/index.js";
import { normalizeUnit } from "../ingredients/index.js";
import {
  massLimit,
  ruleValue,
  techniqueById,
  type Knowledge,
  type Technique,
} from "./knowledge.js";
import {
  ADDING,
  EMPTYING,
  OUTSIDE_BOWL,
  RESERVED,
  amountMentions,
  attributeIngredient,
  clauses,
  gramsFor,
  indexIngredients,
  matchScore,
  mentionedIngredients,
  nameKeys,
  stem,
  stepTemperature,
  stepText,
  traceBowl,
  words,
  type IngredientIndex,
  type StepTrace,
} from "./mass.js";
import type { ConversionRequest } from "./types.js";

export interface SanityResult {
  errors: ValidationIssue[];
  warnings: string[];
}

export interface Finding {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface SanityContext {
  recipe: RecipeInput;
  request: Pick<ConversionRequest, "servings" | "ingredients">;
  knowledge: Knowledge;
  limits: DeviceLimits;
  traces: StepTrace[];
  index: IngredientIndex;
}

export interface SanityRule {
  id: string;
  description: string;
  check(ctx: SanityContext): Finding[];
}

const stepPath = (index: number) => `servingSize.steps[${index}]`;
const stepLabel = (index: number, step: RecipeStep) => `step ${index + 1} (${step.kind})`;
const seconds = (step: RecipeStep) =>
  "minutes" in step ? step.minutes * 60 + step.seconds : step.kind === "turbo" ? step.seconds : 0;
const error = (path: string, message: string): Finding => ({ severity: "error", path, message });
const warning = (path: string, message: string): Finding => ({
  severity: "warning",
  path,
  message,
});

// Seconds to bring water-like contents from the start temperature (room temperature unless
// given) to the target, at most the boiling point: the physical lower bound of
// timing-model.json tMinSeconds.
export function tMinSeconds(
  massGrams: number,
  temperature: number,
  constants: Knowledge["timing"]["constants"],
  startTemperature: number = constants.startTemperatureC,
): number {
  const delta = Math.min(temperature, 100) - startTemperature;
  if (delta <= 0 || massGrams <= 0) return 0;
  return (
    ((massGrams / 1000) * constants.heatCapacityJoulePerKgKelvin * delta) /
    (constants.heaterWatts * constants.efficiency)
  );
}

const isHeated = (step: RecipeStep) =>
  step.kind !== "text" && step.kind !== "scale" && stepTemperature(step) > 0;

// Reports once per stretch in which the condition holds, at its first step.
function firstOfRuns(
  traces: readonly StepTrace[],
  holds: (trace: StepTrace) => boolean,
): StepTrace[] {
  const found: StepTrace[] = [];
  let inside = false;
  for (const trace of traces) {
    const now = holds(trace);
    if (now && !inside) found.push(trace);
    inside = now;
  }
  return found;
}

export const heatUpRule: SanityRule = {
  id: "heat_up",
  description:
    "A heated manual step on contents below the rule temperature (cold, or cooled down by cold additions) must last long enough to heat them (timing-model.json heatUpRules).",
  check({ knowledge, traces }) {
    const { errorFactor, warningFactor, minTemperature, typicalFactor } = knowledge.heatUp;
    const constants = knowledge.timing.constants;
    const findings: Finding[] = [];
    for (const { step, before, index } of traces) {
      if (step.kind !== "customized" || step.temperature < minTemperature) continue;
      if (before.temperature >= minTemperature || before.grams <= 0) continue;
      const tMin = tMinSeconds(before.grams, step.temperature, constants, before.temperature);
      if (tMin <= 0) continue;
      const time = seconds(step);
      const grams = Math.round(before.grams);
      const start = Math.round(before.temperature);
      const from = start > constants.startTemperatureC ? ` from about ${start} °C` : "";
      const label = stepLabel(index, step);
      const minutes = Math.ceil(tMin / 60);
      const typical =
        typicalFactor !== undefined
          ? ` (official recipes give about ${typicalFactor} times the minimum, here about ${Math.round((typicalFactor * tMin) / 60)} min)`
          : "";
      if (time < errorFactor * tMin) {
        findings.push(
          error(
            `${stepPath(index)}.minutes`,
            `${label} heats about ${grams} g${from} to ${step.temperature} °C in ${time} s, but that takes at least ${Math.round(tMin)} s; make the step at least ${minutes} min long${typical}`,
          ),
        );
      } else if (time < warningFactor * tMin) {
        findings.push(
          warning(
            `${stepPath(index)}.minutes`,
            `${label} heats about ${grams} g${from} to ${step.temperature} °C in ${time} s, close to the physical minimum of ${Math.round(tMin)} s; check that it is long enough`,
          ),
        );
      } else if (before.unknown) {
        findings.push(
          warning(
            stepPath(index),
            `${label}: the heat-up time was checked against ${grams} g only, because some ingredients in the bowl have no known weight`,
          ),
        );
      }
    }
    return findings;
  },
};

export const bowlMaxRule: SanityRule = {
  id: "bowl_max",
  description: "The bowl holds at most 3000 g at any step (timing-model.json bowl_max).",
  check({ knowledge, traces }) {
    const max = massLimit(knowledge, "bowl_max").grams;
    return firstOfRuns(traces, (trace) => trace.after.grams > max).map(({ index, step, after }) =>
      error(
        stepPath(index),
        `about ${Math.round(after.grams)} g are in the bowl after ${stepLabel(index, step)}, more than the ${max} g it holds; work in batches or scale the whole recipe down and say so in reviewHints`,
      ),
    );
  },
};

export const bowlMaxFoamingRule: SanityRule = {
  id: "bowl_max_foaming",
  description:
    "Contents that foam or boil up (milk, pasta, rice, legumes, potatoes, jam) stay below 2500 g when heated (timing-model.json bowl_max_foaming).",
  check({ knowledge, traces }) {
    const max = massLimit(knowledge, "bowl_max_foaming").grams;
    return firstOfRuns(
      traces,
      ({ step, before }) => isHeated(step) && before.foaming && before.grams > max,
    ).map(({ index, step, before }) =>
      warning(
        stepPath(index),
        `${stepLabel(index, step)} heats about ${Math.round(before.grams)} g of contents that can foam or boil over; more than ${max} g may overflow`,
      ),
    );
  },
};

export const turboRule: SanityRule = {
  id: "turbo_limits",
  description:
    "Turbo only with at most 2500 g in the bowl and contents at most 60 °C (timing-model.json turbo_bowl_max, device-limits.json turbo_content_temperature).",
  check({ knowledge, traces }) {
    const maxGrams = massLimit(knowledge, "turbo_bowl_max").grams;
    const maxTemperature = ruleValue(knowledge, "turbo_content_temperature");
    const findings: Finding[] = [];
    for (const { step, before, index } of traces) {
      if (step.kind !== "turbo") continue;
      if (before.grams > maxGrams) {
        findings.push(
          error(
            stepPath(index),
            `${stepLabel(index, step)} runs with about ${Math.round(before.grams)} g in the bowl; turbo is allowed up to ${maxGrams} g`,
          ),
        );
      }
      if (before.temperature > maxTemperature) {
        findings.push(
          error(
            stepPath(index),
            `${stepLabel(index, step)} runs on contents at about ${Math.round(before.temperature)} °C; turbo is allowed only up to ${maxTemperature} °C, so let them cool first (say so in a text step) or use a manual step at rising speed`,
          ),
        );
      }
    }
    return findings;
  },
};

export const whiskRule: SanityRule = {
  id: "whisk",
  description:
    "With the butterfly whisk fitted (accessory field or a text step that fits it) the speed is at most 4 and turbo is not allowed (device-limits.json speed_max_whisk, no_turbo_with_whisk).",
  check({ knowledge, traces }) {
    const maxSpeed = ruleValue(knowledge, "speed_max_whisk");
    const findings: Finding[] = [];
    for (const { step, before, index } of traces) {
      if (step.kind === "customized") {
        const fitted = step.accessory === "butterfly_whisk" || before.whisk;
        if (fitted && step.speed > maxSpeed) {
          findings.push(
            error(
              `${stepPath(index)}.speed`,
              `${stepLabel(index, step)} runs at speed ${step.speed} while the butterfly whisk is fitted; the limit is ${maxSpeed}. Lower the speed, or remove the whisk in a text step ("Rühraufsatz entfernen") first`,
            ),
          );
        }
      } else if (step.kind === "turbo" && before.whisk) {
        findings.push(
          error(
            stepPath(index),
            `${stepLabel(index, step)} uses turbo while the butterfly whisk is fitted; remove the whisk in a text step first`,
          ),
        );
      }
    }
    return findings;
  },
};

export const flourRule: SanityRule = {
  id: "flour_max_per_knead",
  description: "At most 1000 g flour in the bowl for a kneading step (timing-model.json).",
  check({ knowledge, traces }) {
    const max = massLimit(knowledge, "flour_max_per_knead").grams;
    return traces
      .filter(({ step, before }) => step.kind.startsWith("kneading") && before.flourGrams > max)
      .map(({ index, step, before }) =>
        error(
          stepPath(index),
          `${stepLabel(index, step)} kneads about ${Math.round(before.flourGrams)} g flour; at most ${max} g per kneading step, so knead in two batches`,
        ),
      );
  },
};

export const steamingWaterRule: SanityRule = {
  id: "steaming_liquid_min",
  description:
    "A steaming step needs at least 500 g water or stock in the bowl (timing-model.json steaming_liquid_min).",
  check({ knowledge, traces }) {
    const min = massLimit(knowledge, "steaming_liquid_min").grams;
    return traces
      .filter(
        ({ step, before }) =>
          step.kind === "steaming" && !before.liquidUnknown && before.liquidGrams < min,
      )
      .map(({ index, step, before }) =>
        error(
          stepPath(index),
          `${stepLabel(index, step)} has ${Math.round(before.liquidGrams)} g of water or stock in the bowl; steaming needs at least ${min} g (typically 1000 g), weighed in with a scale step before`,
        ),
      );
  },
};

export const textBeforeMachineStepRule: SanityRule = {
  id: "text_before_machine_step",
  description:
    "Every working step follows a step the device shows text for (text, scale, turbo) or continues a working step of the same program (step-patterns.md rule 6).",
  check({ recipe, limits }) {
    const shown = new Set(limits.recipe.stepDescription.requiredOn);
    const steps = recipe.servingSize.steps;
    return steps.flatMap((step, index) => {
      if (shown.has(step.kind)) return [];
      const previous = steps[index - 1];
      if (previous && (shown.has(previous.kind) || previous.kind === step.kind)) return [];
      return [
        error(
          stepPath(index),
          `${stepLabel(index, step)} shows only its title on the device, so it needs a text or scale step before it that says what to do`,
        ),
      ];
    });
  },
};

const nameStems = (text: string) => words(text).map(stem);

// Input ingredients the ingredient list must carry: parsed, not optional, with a name.
function listable(request: SanityContext["request"], index: IngredientIndex): number[] {
  return request.ingredients.flatMap((ingredient, position) =>
    ingredient.source === "unparsed" ||
    ingredient.optional ||
    (index.keys[position] ?? []).length === 0
      ? []
      : [position],
  );
}

export const ingredientListedRule: SanityRule = {
  id: "ingredient_listed",
  description:
    "Every parsed, non-optional input ingredient appears in the ingredient list. When most names do not match (a translated recipe), one warning replaces the errors.",
  check({ recipe, request, index }) {
    const entries = recipe.servingSize.ingredientGroups.flatMap((group) =>
      group.ingredients.map((entry) => nameStems(entry.name)),
    );
    const candidates = listable(request, index);
    const missing = candidates.filter(
      (position) => !entries.some((stems) => matchScore(index.keys[position] ?? [], stems) > 0),
    );
    if (missing.length === 0) return [];
    if (missing.length * 2 > candidates.length) {
      return [
        warning(
          "servingSize.ingredientGroups",
          `${missing.length} of ${candidates.length} ingredients of the recipe are not found by name in the ingredient list; check that none was dropped`,
        ),
      ];
    }
    return missing.map((position) => {
      const food = request.ingredients[position]?.food ?? "";
      return error(
        "servingSize.ingredientGroups",
        `the ingredient "${food}" of the recipe is missing from the ingredient list; never drop an ingredient: list it with its amount and keep "${food}" in the name`,
      );
    });
  },
};

export const ingredientReferencedRule: SanityRule = {
  id: "ingredient_referenced",
  description:
    "Every input ingredient appears in at least one step. When most names do not appear (a translated recipe), one warning replaces the list.",
  check({ recipe, request, index }) {
    const stems = recipe.servingSize.steps.flatMap((step) =>
      words("description" in step ? `${step.title} ${step.description}` : step.title).map(stem),
    );
    const named = request.ingredients.filter(
      (_, position) => (index.keys[position] ?? []).length > 0,
    );
    const missing = request.ingredients.filter((_, position) => {
      const keys = index.keys[position] ?? [];
      return keys.length > 0 && matchScore(keys, stems) === 0;
    });
    if (missing.length > 1 && missing.length * 2 > named.length) {
      return [
        warning(
          "servingSize.steps",
          `${missing.length} of ${named.length} ingredients of the recipe are not named in any step, as in a translated recipe; check that each is used`,
        ),
      ];
    }
    return missing.map((ingredient) =>
      warning(
        "servingSize.steps",
        `the ingredient "${ingredient.food}" is not named in any step; check that it is used`,
      ),
    );
  },
};

// "weight" (grams, volumes converted by density), "tbsp", "tsp", "count", or another
// unit code, which compares only with itself.
type Dimension = string;

const WEIGHT_UNITS = new Set(["g", "kg", "ml", "l", "oz", "lb", "floz", "cup", "Tasse"]);
const COUNT_UNITS = new Set(["Stueck"]);

function dimension(unit: string | null): Dimension {
  if (unit === null || COUNT_UNITS.has(unit)) return "count";
  if (WEIGHT_UNITS.has(unit)) return "weight";
  if (unit === "EL" || unit === "tbsp") return "tbsp";
  if (unit === "TL" || unit === "tsp") return "tsp";
  return unit;
}

interface Amount {
  dimension: Dimension;
  value: number;
}

function amountIn(
  value: number,
  unit: string | null,
  food: string,
  knowledge: Knowledge,
): Amount | null {
  const dim = dimension(unit);
  if (dim !== "weight") return { dimension: dim, value };
  const grams = gramsFor(value, unit, food, knowledge.units);
  return grams === null ? null : { dimension: "weight", value: grams };
}

// The rounding slack an amount may grow by: one step of the gram grid of units.json, half
// a spoon or half a piece.
function slack(amount: Amount, knowledge: Knowledge): number {
  if (amount.dimension === "weight") {
    const band = knowledge.units.roundingGrid.grams.find(
      ({ band: [from, to] }) => amount.value >= from && (to === null || amount.value < to),
    );
    return band?.step ?? 0;
  }
  if (["tbsp", "tsp", "count"].includes(amount.dimension)) return 0.5;
  return 0;
}

// The most an output amount may be: the tolerance of converter-rules.json or one rounding
// step above the input, whichever is larger.
function allowed(input: Amount, knowledge: Knowledge): number {
  return Math.max(
    input.value * (1 + knowledge.amountTolerance),
    input.value + slack(input, knowledge),
  );
}

// The least an output amount may be, by the same rule below the input.
function required(input: Amount, knowledge: Knowledge): number {
  return Math.min(
    input.value * (1 - knowledge.amountTolerance),
    input.value - slack(input, knowledge),
  );
}

const VOLUME_UNITS = new Set(["cup", "Tasse"]);

// A cup of a solid (grated cheese, cherry tomatoes) has a weight the bridge cannot know:
// 240 ml times a density holds for liquids only (converter-rules.json volumeLiquids).
function unknownVolume(ingredient: NormalizedIngredient, knowledge: Knowledge): boolean {
  if (ingredient.unit === null || !VOLUME_UNITS.has(ingredient.unit)) return false;
  return matchScore(nameKeys(ingredient.food), knowledge.volumeLiquidWords.map(stem)) === 0;
}

// "plus bis zu ½ Tasse mehr zum Verdünnen", "+ etwas zum Einfetten": the recipe allows more
// than its amount. The parser keeps that phrase in the note, so the model reads it as the
// source wrote it, and the amount has no upper bound.
const MORE_ALLOWED = /(?:^|\s)(?:plus|\+)\s.*(?:mehr|more|etwas|extra)/iu;
const openEnded = (ingredient: NormalizedIngredient) =>
  ingredient.quantityMax === null && MORE_ALLOWED.test(ingredient.note);

// The input amount of an ingredient: the upper end of a range for the upper bound, the
// lower end for the lower bound. Null when unknown, also for a cup of a solid.
function inputAmount(
  ingredient: NormalizedIngredient,
  knowledge: Knowledge,
  end: "max" | "min" = "max",
): Amount | null {
  const value =
    end === "max" ? (ingredient.quantityMax ?? ingredient.quantity) : ingredient.quantity;
  if (value === null || ingredient.source === "unparsed") return null;
  if (unknownVolume(ingredient, knowledge)) return null;
  return amountIn(value, ingredient.unit, ingredient.food, knowledge);
}

// The share of the input a recipe that was scaled down on purpose (fewer servings than
// requested, explained in reviewHints) must keep.
function keptShare(ctx: SanityContext): number {
  const { amount } = ctx.recipe.servingSize;
  const { servings } = ctx.request;
  return amount < servings && servings > 0 ? amount / servings : 1;
}

const scaled = (amount: Amount, share: number): Amount => ({
  ...amount,
  value: amount.value * share,
});

// Whether a step that is not a scale step names the ingredient without a counted addition
// of it ("die restliche Brühe dazugeben", "mit der Brühe ablöschen"): it may add the rest.
function mayAddRest(ctx: SanityContext, position: number, counted: readonly Addition[]): boolean {
  const steps = new Set(counted.map((addition) => addition.stepIndex));
  return ctx.recipe.servingSize.steps.some(
    (step, stepIndex) =>
      step.kind !== "scale" &&
      !steps.has(stepIndex) &&
      mentionedIngredients(stepText(step), ctx.index).includes(position),
  );
}

// Setting a portion aside, collecting it or emptying the bowl: a later addition of the same
// ingredient may be that portion going back in.
const SET_ASIDE = new RegExp(`${EMPTYING.source}|${RESERVED.source}`, "iu");

// A text clause that puts back a portion weighed or prepared earlier: "die beiseitegestellten
// 400 g Birnen wieder dazugeben", "die abgewogenen 150 g Hirse hineingeben", "die aus 200 g
// Sahne geschlagene Sahne unterheben". Its amount was counted when it was weighed.
const REUSED = new RegExp(`${RESERVED.source}|abgewogen|wieder|geschlagen`, "iu");

// Whether a step after `from`, up to and including `to`, sets a portion aside.
function setAsideBetween(ctx: SanityContext, from: number, to: number): boolean {
  return ctx.recipe.servingSize.steps
    .slice(from + 1, to + 1)
    .some((step) => SET_ASIDE.test(stepText(step)));
}

const show = (amount: Amount) =>
  amount.dimension === "weight"
    ? `${Math.round(amount.value)} g`
    : `${Math.round(amount.value * 100) / 100}${amount.dimension === "count" ? "" : ` ${amount.dimension === "tbsp" ? "El" : amount.dimension === "tsp" ? "Tl" : amount.dimension}`}`;

export interface Addition {
  ingredient: number;
  stepIndex: number;
  amount: Amount;
  source: "scale" | "text";
}

// The amounts the steps add per input ingredient: scale steps that name exactly one input
// ingredient, and amounts such as "2 Tl Salz" in step texts. A text amount counts only in a
// clause with an adding verb that does not put it outside the bowl, and once per step:
// "600 g Kartoffeln schälen", "die 3 Nelken entfernen" or "in den Dampfgaraufsatz
// geben" add nothing, and neither does a portion that goes back in. A text amount equal to a
// scale step of the same ingredient next to it describes the same addition.
export function collectAdditions(ctx: SanityContext): Addition[] {
  const { recipe, index, knowledge } = ctx;
  const additions: Addition[] = [];
  recipe.servingSize.steps.forEach((step, stepIndex) => {
    const text = stepText(step);
    if (step.kind === "scale") {
      const ingredient = attributeIngredient(text, index);
      if (ingredient !== null) {
        additions.push({
          ingredient,
          stepIndex,
          amount: { dimension: "weight", value: step.grams },
          source: "scale",
        });
      }
      return;
    }
    if (step.kind !== "text") return;
    const seen = new Set<string>();
    for (const clause of clauses(text)) {
      if (!ADDING.test(clause) || OUTSIDE_BOWL.test(clause) || REUSED.test(clause)) continue;
      for (const mention of amountMentions(clause)) {
        const ingredient = attributeIngredient(mention.phrase, index);
        const food = ingredient === null ? undefined : ctx.request.ingredients[ingredient]?.food;
        if (ingredient === null || food === undefined) continue;
        const amount = amountIn(mention.amount, mention.unit, food, knowledge);
        if (!amount) continue;
        const key = `${ingredient}|${amount.dimension}|${Math.round(amount.value * 100)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        additions.push({ ingredient, stepIndex, amount, source: "text" });
      }
    }
  });
  const same = (a: Addition, b: Addition) =>
    a.ingredient === b.ingredient &&
    a.amount.dimension === b.amount.dimension &&
    Math.abs(a.amount.value - b.amount.value) < 0.5;
  return additions.filter(
    (addition) =>
      addition.source === "scale" ||
      !additions.some(
        (other) =>
          other.source === "scale" &&
          Math.abs(other.stepIndex - addition.stepIndex) <= 1 &&
          same(other, addition),
      ),
  );
}

export const amountBalanceRule: SanityRule = {
  id: "amount_balance",
  description:
    'Amounts in steps (summed per ingredient) and in the ingredient list stay within the tolerance of converter-rules.json (or one rounding step) of the input amount, in both directions. Too much in the steps is an error only when scale steps alone add it with no step between them that sets a portion aside; otherwise a warning. The step sum is checked from below only when every step that names the ingredient adds a counted amount. Open-ended amounts ("plus mehr") have no upper bound; cups of solids are not checked.',
  check(ctx) {
    const { request, knowledge, recipe, index } = ctx;
    const findings: Finding[] = [];
    const additions = collectAdditions(ctx);
    const share = keptShare(ctx);
    request.ingredients.forEach((ingredient, position) => {
      const input = inputAmount(ingredient, knowledge);
      if (!input) return;
      const limit = openEnded(ingredient) ? Number.POSITIVE_INFINITY : allowed(input, knowledge);
      const own = additions.filter(
        (addition) =>
          addition.ingredient === position && addition.amount.dimension === input.dimension,
      );
      const steps = own.map((a) => a.stepIndex + 1).join(", ");
      let total = 0;
      for (const [k, addition] of own.entries()) {
        total += addition.amount.value;
        if (total <= limit) continue;
        const contributing = own.slice(0, k + 1);
        const firstStep = contributing[0]?.stepIndex ?? addition.stepIndex;
        const sum = show({ dimension: input.dimension, value: total });
        // A text amount may describe an addition counted elsewhere, and a portion set aside
        // may go back in: the bridge cannot tell, so the cook checks.
        const uncertain =
          contributing.some((a) => a.source === "text") ||
          setAsideBetween(ctx, firstStep, addition.stepIndex);
        findings.push(
          uncertain
            ? warning(
                stepPath(addition.stepIndex),
                `"${ingredient.food}" may be added more than once: the steps add ${sum} (step ${steps}), the recipe has ${show(input)}; check that a reserved portion is not counted twice`,
              )
            : error(
                stepPath(addition.stepIndex),
                `the steps add ${sum} of "${ingredient.food}" (step ${steps}), but the recipe has ${show(input)}; never add more than the recipe gives`,
              ),
        );
        return;
      }
      const least = inputAmount(ingredient, knowledge, "min");
      const first = own[0];
      if (!least || !first || mayAddRest(ctx, position, own)) return;
      const expected = scaled(least, share);
      if (total < required(expected, knowledge)) {
        findings.push(
          error(
            stepPath(first.stepIndex),
            `the steps add only ${show({ dimension: input.dimension, value: total })} of "${ingredient.food}" (step ${steps}), but the recipe has ${show(expected)}; keep the amount from the input and add all of it`,
          ),
        );
      }
    });

    // Ingredient-list entries per input ingredient, with their amounts in its dimension.
    const listed = new Map<number, { path: string; amount: Amount | null }[]>();
    recipe.servingSize.ingredientGroups.forEach((group, g) => {
      group.ingredients.forEach((entry, k) => {
        const position = attributeIngredient(entry.name, index);
        const ingredient = position === null ? undefined : request.ingredients[position];
        if (position === null || !ingredient) return;
        const path = `servingSize.ingredientGroups[${g}].ingredients[${k}].amount`;
        const value =
          typeof entry.amount === "number" ? entry.amount : parseListAmount(entry.amount);
        const unit =
          entry.unit.trim() === "" ? null : (normalizeUnit(entry.unit)?.code ?? entry.unit);
        const output = value === null ? null : amountIn(value, unit, ingredient.food, knowledge);
        listed.set(position, [...(listed.get(position) ?? []), { path, amount: output }]);
        const input = inputAmount(ingredient, knowledge);
        if (!input || !output || output.dimension !== input.dimension) return;
        if (!openEnded(ingredient) && output.value > allowed(input, knowledge)) {
          findings.push(
            error(
              path,
              `the ingredient list gives ${show(output)} of "${entry.name}", but the recipe has ${show(input)}; keep the scaled amounts from the input`,
            ),
          );
        }
      });
    });
    for (const [position, entries] of listed) {
      const ingredient = request.ingredients[position];
      const least = ingredient ? inputAmount(ingredient, knowledge, "min") : null;
      const first = entries[0];
      if (!ingredient || !least || !first) continue;
      // Entries in another unit or without a readable amount: the sum is unknown.
      if (entries.some((entry) => entry.amount?.dimension !== least.dimension)) continue;
      const total = entries.reduce((sum, entry) => sum + (entry.amount?.value ?? 0), 0);
      const expected = scaled(least, share);
      if (total < required(expected, knowledge)) {
        findings.push(
          error(
            first.path,
            `the ingredient list gives only ${show({ dimension: least.dimension, value: total })} of "${ingredient.food}", but the recipe has ${show(expected)}; keep the scaled amounts from the input`,
          ),
        );
      }
    }
    return findings;
  },
};

const LIST_FRACTIONS: Readonly<Record<string, number>> = { "½": 0.5, "¼": 0.25, "¾": 0.75 };

// An ingredient-list amount: "200", "1 ½", "½", "1,5". Ranges and words give null.
export function parseListAmount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const mixed = /^(\d+)?\s*([½¼¾])$/u.exec(trimmed);
  if (mixed?.[2]) return Number(mixed[1] ?? 0) + (LIST_FRACTIONS[mixed[2]] ?? 0);
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

export const machineStepDescriptionRule: SanityRule = {
  id: "machine_step_description",
  description:
    "Only text, scale and turbo steps carry a description; the device does not show it on other programs.",
  check({ recipe, limits }) {
    const shown = new Set(limits.recipe.stepDescription.requiredOn);
    return recipe.servingSize.steps.flatMap((step, index) => {
      const description = (step as Record<string, unknown>).description;
      if (shown.has(step.kind) || typeof description !== "string" || description === "") return [];
      return [
        error(
          `${stepPath(index)}.description`,
          `${stepLabel(index, step)} takes no description; move the instruction into a text step before it`,
        ),
      ];
    });
  },
};

const titleMatches = (title: string, aliases: readonly string[]) =>
  matchScore(nameKeys(title), aliases.flatMap(nameKeys)) > 0;

// The temperature range of a technique's manual-mode setting: its main program, or the
// manual alternative when the main program is another mode.
const manualRange = (technique: Technique) =>
  technique.device.mode === "customized"
    ? technique.device.temperature?.range
    : technique.alternatives?.find((alternative) => alternative.mode === "customized")?.temperature
        ?.range;

// Which steps a technique's temperature range applies to, and which range.
export const TEMPERATURE_CONVENTIONS: readonly {
  technique: string;
  applies: (step: RecipeStep, technique: Technique) => boolean;
  range: (technique: Technique) => readonly [number, number] | undefined;
}[] = [
  {
    technique: "sear_roast",
    applies: (step) => step.kind === "roasting",
    range: (technique) => technique.device.temperature?.range,
  },
  {
    // Manual sauté steps; sautéing with the roasting program falls under sear_roast.
    technique: "saute_onions",
    applies: (step, technique) =>
      step.kind === "customized" &&
      step.temperature > 0 &&
      titleMatches(step.title, technique.aliases.de),
    range: manualRange,
  },
];

export const temperatureConventionRule: SanityRule = {
  id: "temperature_convention",
  description:
    "Roasting and sautéing temperatures stay inside the range official recipes use (techniques.json sear_roast, saute_onions).",
  check({ recipe, knowledge }) {
    const findings: Finding[] = [];
    for (const convention of TEMPERATURE_CONVENTIONS) {
      const technique = techniqueById(knowledge, convention.technique);
      const range = technique ? convention.range(technique) : undefined;
      if (!technique || !range) continue;
      recipe.servingSize.steps.forEach((step, index) => {
        if (!convention.applies(step, technique)) return;
        const temperature = stepTemperature(step);
        if (temperature >= range[0] && temperature <= range[1]) return;
        findings.push(
          warning(
            `${stepPath(index)}.temperature`,
            `${stepLabel(index, step)} runs at ${temperature} °C; official recipes use ${range[0]}-${range[1]} °C for this (${technique.label})`,
          ),
        );
      });
    }
    return findings;
  },
};

export const duplicateAdditionRule: SanityRule = {
  id: "duplicate_addition",
  description:
    "The same ingredient is not added twice with the same amount, unless a step in between sets a portion aside or empties the bowl.",
  check(ctx) {
    const findings: Finding[] = [];
    const additions = collectAdditions(ctx);
    ctx.request.ingredients.forEach((ingredient, position) => {
      const own = additions.filter((addition) => addition.ingredient === position);
      for (let i = 0; i < own.length; i++) {
        const first = own[i];
        const twin = own
          .slice(i + 1)
          .find(
            (other) =>
              first !== undefined &&
              other.stepIndex !== first.stepIndex &&
              other.amount.dimension === first.amount.dimension &&
              Math.abs(other.amount.value - first.amount.value) < 0.5 &&
              !setAsideBetween(ctx, first.stepIndex, other.stepIndex),
          );
        if (first && twin) {
          findings.push(
            warning(
              stepPath(twin.stepIndex),
              `"${ingredient.food}" is added twice with ${show(first.amount)} (steps ${first.stepIndex + 1} and ${twin.stepIndex + 1}); check that both are meant`,
            ),
          );
          return;
        }
      }
    });
    return findings;
  },
};

export const servingsRule: SanityRule = {
  id: "servings_changed",
  description: "The recipe keeps the servings the amounts were scaled to.",
  check({ recipe, request }) {
    const amount = recipe.servingSize.amount;
    if (amount === request.servings) return [];
    return [
      warning(
        "servingSize.amount",
        `the recipe is for ${amount} servings, but the amounts were scaled to ${request.servings}; check the amounts`,
      ),
    ];
  },
};

export const SANITY_RULES: readonly SanityRule[] = [
  heatUpRule,
  bowlMaxRule,
  bowlMaxFoamingRule,
  turboRule,
  whiskRule,
  flourRule,
  steamingWaterRule,
  textBeforeMachineStepRule,
  ingredientListedRule,
  ingredientReferencedRule,
  amountBalanceRule,
  machineStepDescriptionRule,
  temperatureConventionRule,
  duplicateAdditionRule,
  servingsRule,
];

export function checkSanity(
  recipe: RecipeInput,
  request: Pick<ConversionRequest, "servings" | "ingredients">,
  knowledge: Knowledge,
  limits: DeviceLimits,
  rules: readonly SanityRule[] = SANITY_RULES,
): SanityResult {
  const ctx: SanityContext = {
    recipe,
    request,
    knowledge,
    limits,
    traces: traceBowl(recipe, request.ingredients, knowledge),
    index: indexIngredients(request.ingredients),
  };
  const errors: ValidationIssue[] = [];
  const warnings: string[] = [];
  for (const rule of rules) {
    for (const finding of rule.check(ctx)) {
      if (finding.severity === "error") {
        errors.push({ path: finding.path, message: finding.message });
      } else {
        const text = finding.message.charAt(0).toUpperCase() + finding.message.slice(1);
        if (!warnings.includes(text)) warnings.push(text);
      }
    }
  }
  return { errors, warnings };
}
