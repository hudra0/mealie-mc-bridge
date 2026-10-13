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
  amountMentions,
  attributeIngredient,
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
  description: "Every input ingredient appears in at least one step.",
  check({ recipe, request, index }) {
    const stems = recipe.servingSize.steps.flatMap((step) =>
      words("description" in step ? `${step.title} ${step.description}` : step.title).map(stem),
    );
    return request.ingredients.flatMap((ingredient, position) => {
      const keys = index.keys[position] ?? [];
      if (keys.length === 0 || matchScore(keys, stems) > 0) return [];
      return [
        warning(
          "servingSize.steps",
          `the ingredient "${ingredient.food}" is not named in any step; check that it is used`,
        ),
      ];
    });
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

// The input amount of an ingredient: the upper end of a range for the upper bound, the
// lower end for the lower bound.
function inputAmount(
  ingredient: NormalizedIngredient,
  knowledge: Knowledge,
  end: "max" | "min" = "max",
): Amount | null {
  const value =
    end === "max" ? (ingredient.quantityMax ?? ingredient.quantity) : ingredient.quantity;
  if (value === null || ingredient.source === "unparsed") return null;
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

// Steps that name an input ingredient without giving its amount: they may add the rest.
function unquantifiedMentions(ctx: SanityContext, position: number): number[] {
  return ctx.recipe.servingSize.steps.flatMap((step, stepIndex) => {
    const text = stepText(step);
    if (step.kind === "scale") return [];
    if (!mentionedIngredients(text, ctx.index).includes(position)) return [];
    const quantified = amountMentions(text).some(
      (mention) => attributeIngredient(mention.phrase, ctx.index) === position,
    );
    return quantified ? [] : [stepIndex];
  });
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
// ingredient, and amounts such as "2 Tl Salz" in step texts. A text amount equal to a
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
    for (const mention of amountMentions(text)) {
      const ingredient = attributeIngredient(mention.phrase, index);
      const food = ingredient === null ? undefined : ctx.request.ingredients[ingredient]?.food;
      if (ingredient === null || food === undefined) continue;
      const amount = amountIn(mention.amount, mention.unit, food, knowledge);
      if (amount) additions.push({ ingredient, stepIndex, amount, source: "text" });
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
    "Amounts in steps (summed per ingredient) and in the ingredient list stay within the tolerance of converter-rules.json (or one rounding step) of the input amount, in both directions. The step sum is checked from below only when no step names the ingredient without an amount.",
  check(ctx) {
    const { request, knowledge, recipe, index } = ctx;
    const findings: Finding[] = [];
    const additions = collectAdditions(ctx);
    const share = keptShare(ctx);
    request.ingredients.forEach((ingredient, position) => {
      const input = inputAmount(ingredient, knowledge);
      if (!input) return;
      const limit = allowed(input, knowledge);
      const own = additions.filter(
        (addition) =>
          addition.ingredient === position && addition.amount.dimension === input.dimension,
      );
      const steps = own.map((a) => a.stepIndex + 1).join(", ");
      let total = 0;
      for (const addition of own) {
        total += addition.amount.value;
        if (total > limit) {
          findings.push(
            error(
              stepPath(addition.stepIndex),
              `the steps add ${show({ dimension: input.dimension, value: total })} of "${ingredient.food}" (step ${steps}), but the recipe has ${show(input)}; never add more than the recipe gives`,
            ),
          );
          return;
        }
      }
      const least = inputAmount(ingredient, knowledge, "min");
      const first = own[0];
      if (!least || !first || unquantifiedMentions(ctx, position).length > 0) return;
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
        if (output.value > allowed(input, knowledge)) {
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

// Which steps a technique's temperature range applies to.
export const TEMPERATURE_CONVENTIONS: readonly {
  technique: string;
  applies: (step: RecipeStep, technique: Technique) => boolean;
}[] = [
  { technique: "sear_roast", applies: (step) => step.kind === "roasting" },
  {
    technique: "saute_onions",
    applies: (step, technique) =>
      step.kind === "customized" &&
      step.temperature > 0 &&
      titleMatches(step.title, technique.aliases.de),
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
      const range = technique?.device.temperature?.range;
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
  description: "The same ingredient is not added twice with the same amount.",
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
              other.amount.dimension === first.amount.dimension &&
              Math.abs(other.amount.value - first.amount.value) < 0.5,
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
