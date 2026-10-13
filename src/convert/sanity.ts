// Plausibility checks on a recipe that passed the schema: physics (heat-up time, bowl
// mass), accessory rules, recipe structure and the balance of amounts against the input.
// The validator checks every limit of device-programs.json; these rules check what a
// limit table cannot see. Errors go back to the model for a correction round, warnings
// become review hints.
//
// Coverage and amounts are compared through the recipe's ingredientMapping (mapping.ts),
// which links each ingredient-list entry to the source line it comes from, so the checks
// work whatever the languages of source and recipe. Step texts are read in the output
// language, with the words of its locale pack.
//
// Each rule is a data entry (id, what it checks) with a function. Thresholds come from
// the knowledge base: timing-model.json massLimits and heatUpRules, device-limits.json
// rules, techniques.json temperature ranges.

import type { NormalizedIngredient } from "../ingredients/index.js";
import type { DeviceLimits } from "../recipe/limits.js";
import type { RecipeInput, RecipeStep } from "../recipe/schema.js";
import type { ValidationIssue } from "../recipe/validate.js";
import {
  massLimit,
  phrase,
  ruleValue,
  techniqueById,
  type Knowledge,
  type Technique,
} from "./knowledge.js";
import {
  attributeItem,
  inputsNamedIn,
  linkIngredients,
  mentionedItems,
  type IngredientLinks,
} from "./mapping.js";
import {
  amountMentions,
  clauses,
  gramsFor,
  listUnit,
  parseListAmount,
  stepTemperature,
  stepText,
  traceBowl,
  type StepTrace,
} from "./mass.js";
import type { ConversionRequest } from "./types.js";

export { parseListAmount } from "./mass.js";

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
  links: IngredientLinks;
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
              `${stepLabel(index, step)} runs at speed ${step.speed} while the butterfly whisk is fitted; the limit is ${maxSpeed}. Lower the speed, or remove the whisk in a text step ("${phrase(knowledge, "whiskOut")}") first`,
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

// Source ingredients the recipe must carry: parsed, not optional, with a name.
function listable(ingredients: readonly NormalizedIngredient[]): number[] {
  return ingredients.flatMap((ingredient, position) =>
    ingredient.source === "unparsed" || ingredient.optional || ingredient.food.trim() === ""
      ? []
      : [position],
  );
}

const source = (ingredients: readonly NormalizedIngredient[], position: number) =>
  `[${position}] "${ingredients[position]?.food ?? ""}"`;

export const ingredientMappingRule: SanityRule = {
  id: "ingredient_mapping",
  description:
    "Every parsed, non-optional source ingredient is linked to an ingredient-list entry by ingredientMapping, every mapping entry names a list entry and a source line that exist, and every list entry is mapped. Source lines the mapping leaves out but the list names in the same language count, with one summary warning; a recipe without a mapping is checked by name only and gets at most one summary warning.",
  check({ request, knowledge, links }) {
    const text = knowledge.text;
    const inputs = request.ingredients;
    const candidates = listable(inputs);
    const listNames = links.items.map((item) => item.name);
    if (!links.hasMapping) {
      const found = inputsNamedIn(text, inputs, listNames);
      const missing = candidates.filter((position) => !found.has(position));
      if (missing.length === 0) return [];
      return [
        warning(
          "servingSize.ingredientGroups",
          `${missing.length} of ${candidates.length} ingredients of the recipe are not found by name in the ingredient list, and the recipe has no ingredientMapping; check that none was dropped`,
        ),
      ];
    }
    const findings: Finding[] = [];
    for (const problem of links.unknownNames) {
      findings.push(
        error(
          `ingredientMapping[${problem.position}].name`,
          `ingredientMapping names "${problem.name}", which is not in the ingredient list; use the list name exactly`,
        ),
      );
    }
    for (const problem of links.badIndices) {
      findings.push(
        error(
          `ingredientMapping[${problem.position}].inputIndex`,
          `ingredientMapping links "${problem.name}" to [${problem.inputIndex}], but the source has ingredients [0] to [${inputs.length - 1}] only`,
        ),
      );
    }
    const unmapped = new Set(links.unmappedInputs);
    const left = candidates.filter((position) => unmapped.has(position));
    const byName = inputsNamedIn(text, inputs, listNames);
    const named = left.filter((position) => byName.has(position));
    for (const position of left.filter((p) => !byName.has(p))) {
      findings.push(
        error(
          "ingredientMapping",
          `the source ingredient ${source(inputs, position)} is not in ingredientMapping; never drop an ingredient: list it with its amount and add a mapping entry with inputIndex ${position}`,
        ),
      );
    }
    if (named.length > 0) {
      findings.push(
        warning(
          "ingredientMapping",
          `${named.length} source ingredient(s) have no ingredientMapping entry and were matched by name: ${named.map((p) => source(inputs, p)).join(", ")}; check their amounts`,
        ),
      );
    }
    if (links.unmappedItems.length > 0) {
      const names = links.unmappedItems.map((item) => `"${links.items[item]?.name ?? ""}"`);
      findings.push(
        warning(
          "ingredientMapping",
          `the ingredient list has entries without an ingredientMapping entry (${names.join(", ")}); their amounts were not compared with the recipe`,
        ),
      );
    }
    return findings;
  },
};

export const ingredientReferencedRule: SanityRule = {
  id: "ingredient_referenced",
  description:
    "Every ingredient-list entry is named in at least one step. When most names do not appear, one warning replaces the list.",
  check({ recipe, knowledge, links }) {
    const text = knowledge.text;
    const stems = recipe.servingSize.steps.flatMap((step) =>
      text
        .words("description" in step ? `${step.title} ${step.description}` : step.title)
        .map(text.stem),
    );
    const named = links.items.filter((_, position) => (links.keys[position] ?? []).length > 0);
    const missing = links.items.filter((_, position) => {
      const keys = links.keys[position] ?? [];
      return keys.length > 0 && text.matchScore(keys, stems) === 0;
    });
    if (missing.length > 1 && missing.length * 2 > named.length) {
      return [
        warning(
          "servingSize.steps",
          `${missing.length} of ${named.length} ingredients of the list are not named in any step; check that each is used`,
        ),
      ];
    }
    return missing.map((item) =>
      warning(
        "servingSize.steps",
        `the ingredient "${item.name}" is not named in any step; check that it is used`,
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
  food: string | readonly string[],
  knowledge: Knowledge,
): Amount | null {
  const dim = dimension(unit);
  if (dim !== "weight") return { dimension: dim, value };
  const grams = gramsFor(knowledge.text, value, unit, food, knowledge.units);
  return grams === null ? null : { dimension: "weight", value: grams };
}

// The rounding slack an amount may grow by: one step of the gram grid of the pack's unit
// rules, half a spoon or half a piece.
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
// 240 ml times a density holds for liquids only (the liquid words of every pack).
function unknownVolume(ingredient: NormalizedIngredient, knowledge: Knowledge): boolean {
  if (ingredient.unit === null || !VOLUME_UNITS.has(ingredient.unit)) return false;
  const text = knowledge.text;
  return text.matchScore(text.nameKeys(ingredient.food), text.cupLiquidWords.map(text.stem)) === 0;
}

// "plus bis zu ½ Tasse mehr zum Verdünnen", "+ etwas zum Einfetten": the recipe allows more
// than its amount. The parser keeps that phrase in the note, so the model reads it as the
// source wrote it, and the amount has no upper bound.
const openEnded = (ingredient: NormalizedIngredient, knowledge: Knowledge) =>
  ingredient.quantityMax === null && knowledge.text.moreAllowed.test(ingredient.note);

// The source amount of an ingredient: the upper end of a range for the upper bound, the
// lower end for the lower bound. Null when unknown, also for a cup of a solid. `alsoNamed`
// are the list names it became, for piece weights and densities its own name lacks.
function inputAmount(
  ingredient: NormalizedIngredient,
  knowledge: Knowledge,
  end: "max" | "min" = "max",
  alsoNamed: readonly string[] = [],
): Amount | null {
  const value =
    end === "max" ? (ingredient.quantityMax ?? ingredient.quantity) : ingredient.quantity;
  if (value === null || ingredient.source === "unparsed") return null;
  if (unknownVolume(ingredient, knowledge)) return null;
  return amountIn(value, ingredient.unit, [ingredient.food, ...alsoNamed], knowledge);
}

// The source amount of a cluster: the sum over its source lines. To-taste lines without an
// amount add nothing; an unparsed line, an unknown conversion or two dimensions make the
// amount unknown. Null as well for a cluster without source lines.
function clusterAmount(
  ctx: SanityContext,
  cluster: number,
  end: "max" | "min",
): { amount: Amount; openEnded: boolean } | null {
  const { links, request, knowledge } = ctx;
  const entry = links.clusters[cluster];
  if (!entry || entry.inputs.length === 0) return null;
  const names = entry.items.map((item) => links.items[item]?.name ?? "");
  let dimension: Dimension | null = null;
  let sum = 0;
  let open = false;
  for (const position of entry.inputs) {
    const ingredient = request.ingredients[position];
    if (!ingredient) return null;
    if (ingredient.source === "unparsed") return null;
    if (ingredient.quantity === null && ingredient.quantityMax === null) continue;
    const amount = inputAmount(ingredient, knowledge, end, names);
    if (!amount) return null;
    if (dimension !== null && dimension !== amount.dimension) return null;
    dimension = amount.dimension;
    sum += amount.value;
    if (openEnded(ingredient, knowledge)) open = true;
  }
  return dimension === null ? null : { amount: { dimension, value: sum }, openEnded: open };
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

// Whether a step that is not a scale step names an item of the cluster without a counted
// addition of it ("die restliche Brühe dazugeben", "mit der Brühe ablöschen"): it may add
// the rest.
function mayAddRest(ctx: SanityContext, cluster: number, counted: readonly Addition[]): boolean {
  const steps = new Set(counted.map((addition) => addition.stepIndex));
  const items = new Set(ctx.links.clusters[cluster]?.items ?? []);
  return ctx.recipe.servingSize.steps.some(
    (step, stepIndex) =>
      step.kind !== "scale" &&
      !steps.has(stepIndex) &&
      mentionedItems(ctx.knowledge.text, stepText(step), ctx.links).some((item) => items.has(item)),
  );
}

// Whether a step after `from`, up to and including `to`, sets a portion aside or empties the
// bowl: a later addition of the same ingredient may be that portion going back in.
function setAsideBetween(ctx: SanityContext, from: number, to: number): boolean {
  const text = ctx.knowledge.text;
  return ctx.recipe.servingSize.steps.slice(from + 1, to + 1).some((step) => {
    const source = stepText(step);
    return text.emptying.test(source) || text.reserved.test(source);
  });
}

function show(amount: Amount, knowledge: Knowledge): string {
  if (amount.dimension === "weight") return `${Math.round(amount.value)} g`;
  const value = `${Math.round(amount.value * 100) / 100}`;
  if (amount.dimension === "count") return value;
  const unit =
    amount.dimension === "tbsp"
      ? knowledge.text.unitLabel("tablespoon")
      : amount.dimension === "tsp"
        ? knowledge.text.unitLabel("teaspoon")
        : amount.dimension;
  return `${value} ${unit}`;
}

// The names of a cluster's list items, for messages.
const clusterNames = (ctx: SanityContext, cluster: number) =>
  (ctx.links.clusters[cluster]?.items ?? [])
    .map((item) => `"${ctx.links.items[item]?.name ?? ""}"`)
    .join(" and ");

export interface Addition {
  // The list item the step adds.
  item: number;
  stepIndex: number;
  amount: Amount;
  source: "scale" | "text";
}

// The amounts the steps add per list item: scale steps that name exactly one item, and
// amounts such as "2 Tl Salz" in step texts. A text amount counts only in a clause with an
// adding verb that does not put it outside the bowl, and once per step: "600 g Kartoffeln
// schälen", "die 3 Nelken entfernen" or "in den Dampfgaraufsatz geben" add nothing, and
// neither does a portion that goes back in. A text amount equal to a scale step of the same
// item next to it describes the same addition.
export function collectAdditions(ctx: SanityContext): Addition[] {
  const { recipe, links, knowledge } = ctx;
  const text = knowledge.text;
  const additions: Addition[] = [];
  recipe.servingSize.steps.forEach((step, stepIndex) => {
    const source = stepText(step);
    if (step.kind === "scale") {
      const item = attributeItem(text, source, links);
      if (item !== null) {
        additions.push({
          item,
          stepIndex,
          amount: { dimension: "weight", value: step.grams },
          source: "scale",
        });
      }
      return;
    }
    if (step.kind !== "text") return;
    const seen = new Set<string>();
    for (const clause of clauses(source)) {
      if (!text.adding.test(clause) || text.outsideBowl.test(clause) || text.reused.test(clause))
        continue;
      for (const mention of amountMentions(text, clause)) {
        const item = attributeItem(text, mention.phrase, links);
        const name = item === null ? undefined : links.items[item]?.name;
        if (item === null || name === undefined) continue;
        const amount = amountIn(mention.amount, mention.unit, name, knowledge);
        if (!amount) continue;
        const key = `${item}|${amount.dimension}|${Math.round(amount.value * 100)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        additions.push({ item, stepIndex, amount, source: "text" });
      }
    }
  });
  const same = (a: Addition, b: Addition) =>
    a.item === b.item &&
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
    'Amounts in steps (summed per mapped ingredient) and in the ingredient list stay within the tolerance of converter-rules.json (or one rounding step) of the source amount, in both directions. Too much in the steps is an error only when scale steps alone add it with no step between them that sets a portion aside; otherwise a warning. The step sum is checked from below only when every step that names the ingredient adds a counted amount. Open-ended amounts ("plus mehr") have no upper bound; cups of solids are not checked. Ingredients without a mapping entry are not compared.',
  check(ctx) {
    const { knowledge, links } = ctx;
    const text = knowledge.text;
    const findings: Finding[] = [];
    const additions = collectAdditions(ctx);
    const share = keptShare(ctx);
    links.clusters.forEach((cluster, index) => {
      const input = clusterAmount(ctx, index, "max");
      if (!input) return;
      const names = clusterNames(ctx, index);
      const limit = input.openEnded ? Number.POSITIVE_INFINITY : allowed(input.amount, knowledge);
      const own = additions.filter(
        (addition) =>
          cluster.items.includes(addition.item) &&
          addition.amount.dimension === input.amount.dimension,
      );
      const steps = own.map((a) => a.stepIndex + 1).join(", ");
      let total = 0;
      let reported = false;
      for (const [k, addition] of own.entries()) {
        total += addition.amount.value;
        if (total <= limit) continue;
        const contributing = own.slice(0, k + 1);
        const firstStep = contributing[0]?.stepIndex ?? addition.stepIndex;
        const sum = show({ dimension: input.amount.dimension, value: total }, knowledge);
        // A text amount may describe an addition counted elsewhere, and a portion set aside
        // may go back in: the bridge cannot tell, so the cook checks.
        const uncertain =
          contributing.some((a) => a.source === "text") ||
          setAsideBetween(ctx, firstStep, addition.stepIndex);
        findings.push(
          uncertain
            ? warning(
                stepPath(addition.stepIndex),
                `${names} may be added more than once: the steps add ${sum} (step ${steps}), the recipe has ${show(input.amount, knowledge)}; check that a reserved portion is not counted twice`,
              )
            : error(
                stepPath(addition.stepIndex),
                `the steps add ${sum} of ${names} (step ${steps}), but the recipe has ${show(input.amount, knowledge)}; never add more than the recipe gives`,
              ),
        );
        reported = true;
        break;
      }
      if (reported) return;
      const least = clusterAmount(ctx, index, "min");
      const first = own[0];
      if (!least || !first || mayAddRest(ctx, index, own)) return;
      const expected = scaled(least.amount, share);
      if (total < required(expected, knowledge)) {
        findings.push(
          error(
            stepPath(first.stepIndex),
            `the steps add only ${show({ dimension: input.amount.dimension, value: total }, knowledge)} of ${names} (step ${steps}), but the recipe has ${show(expected, knowledge)}; keep the amount from the input and add all of it`,
          ),
        );
      }
    });

    // Ingredient-list entries per cluster, with their amounts in its dimension.
    links.clusters.forEach((cluster, index) => {
      const input = clusterAmount(ctx, index, "max");
      const least = clusterAmount(ctx, index, "min");
      if (!input) return;
      const entries = cluster.items.flatMap((item) => {
        const listed = links.items[item];
        if (!listed) return [];
        return listed.entries.map(({ path, entry }) => {
          const value =
            typeof entry.amount === "number" ? entry.amount : parseListAmount(entry.amount);
          const unit = listUnit(text, entry.unit);
          const amount = value === null ? null : amountIn(value, unit, entry.name, knowledge);
          return { path: `${path}.amount`, name: entry.name, amount };
        });
      });
      for (const entry of entries) {
        const output = entry.amount;
        if (!output || output.dimension !== input.amount.dimension) continue;
        if (!input.openEnded && output.value > allowed(input.amount, knowledge)) {
          findings.push(
            error(
              entry.path,
              `the ingredient list gives ${show(output, knowledge)} of "${entry.name}", but the recipe has ${show(input.amount, knowledge)}; keep the scaled amounts from the input`,
            ),
          );
        }
      }
      const first = entries[0];
      if (!least || !first) return;
      // Entries in another unit or without a readable amount: the sum is unknown.
      if (entries.some((entry) => entry.amount?.dimension !== least.amount.dimension)) return;
      const total = entries.reduce((sum, entry) => sum + (entry.amount?.value ?? 0), 0);
      const expected = scaled(least.amount, share);
      if (total < required(expected, knowledge)) {
        findings.push(
          error(
            first.path,
            `the ingredient list gives only ${show({ dimension: least.amount.dimension, value: total }, knowledge)} of ${clusterNames(ctx, index)}, but the recipe has ${show(expected, knowledge)}; keep the scaled amounts from the input`,
          ),
        );
      }
    });
    return findings;
  },
};

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

// The temperature range of a technique's manual-mode setting: its main program, or the
// manual alternative when the main program is another mode.
const manualRange = (technique: Technique) =>
  technique.device.mode === "customized"
    ? technique.device.temperature?.range
    : technique.alternatives?.find((alternative) => alternative.mode === "customized")?.temperature
        ?.range;

// Whether a step title is worded like the technique in the output language.
function titleMatches(knowledge: Knowledge, title: string, technique: Technique): boolean {
  const text = knowledge.text;
  const aliases = knowledge.aliases[technique.id] ?? [];
  return text.matchScore(text.nameKeys(title), aliases.flatMap(text.nameKeys)) > 0;
}

// Which steps a technique's temperature range applies to, and which range.
export const TEMPERATURE_CONVENTIONS: readonly {
  technique: string;
  applies: (step: RecipeStep, technique: Technique, knowledge: Knowledge) => boolean;
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
    applies: (step, technique, knowledge) =>
      step.kind === "customized" &&
      step.temperature > 0 &&
      titleMatches(knowledge, step.title, technique),
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
        if (!convention.applies(step, technique, knowledge)) return;
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
    ctx.links.clusters.forEach((cluster, index) => {
      const own = additions.filter((addition) => cluster.items.includes(addition.item));
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
              `${clusterNames(ctx, index)} is added twice with ${show(first.amount, ctx.knowledge)} (steps ${first.stepIndex + 1} and ${twin.stepIndex + 1}); check that both are meant`,
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
  ingredientMappingRule,
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
  const links = linkIngredients(recipe, request.ingredients, knowledge.text);
  const ctx: SanityContext = {
    recipe,
    request,
    knowledge,
    limits,
    traces: traceBowl(recipe, request.ingredients, knowledge, links),
    links,
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
