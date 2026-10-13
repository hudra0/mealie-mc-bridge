// Checks a RecipeInput against the schema and the limits from the knowledge file.
//
// The schema checks structure and types; every limit the knowledge file states is checked
// here, against the loaded file. Every error names the path of the offending field and
// says in plain words what is wrong and what is allowed, so the converter can hand the
// list back to the language model for a correction round.

import { z } from "zod";
import type {
  ConditionField,
  DeviceLimits,
  LimitCondition,
  LimitValue,
  ParamLimit,
  Range,
} from "./limits.js";
import {
  INPUT_FIELD,
  MODES,
  apiModeSettings,
  apiSettings,
  type DeviceSettingKey,
  type ModeSettingKey,
} from "./modes.js";
import { RecipeInputSchema, StepSchema, type RecipeInput, type RecipeStep } from "./schema.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  // The parsed recipe when ok is true.
  recipe: RecipeInput | null;
}

export interface ValidateOptions {
  // Category ids from the live catalog. Without it, ids are not checked against a catalog.
  knownCategoryIds?: Iterable<number>;
  // Attachments this installation has, for example "food_processor_attachment".
  attachments?: readonly string[];
}

type ZodIssue = z.core.$ZodIssue;

// The recipe-level fields the knowledge file limits, read leniently: a field of the wrong
// type becomes undefined (the schema reports it), so the limits of the other fields can
// still be checked when the recipe as a whole does not parse.
const optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const RecipeFieldsSchema = z.object({
  title: optional(z.string()),
  description: optional(z.string()),
  categoryIds: optional(z.array(z.number())),
  nutrients: optional(z.array(z.object({ name: z.string(), amount: z.number() }))),
  servingSize: optional(
    z.object({
      amount: optional(z.number()),
      preparationTime: optional(z.number()),
      readyInTime: optional(z.number()),
    }),
  ),
});
type RecipeFields = z.infer<typeof RecipeFieldsSchema>;

export function validateRecipeInput(
  input: unknown,
  limits: DeviceLimits,
  options: ValidateOptions = {},
): ValidationResult {
  const parsed = RecipeInputSchema.safeParse(input);
  if (parsed.success) {
    const recipe = parsed.data;
    const errors = [
      ...checkRecipe(recipe, limits, options),
      ...recipe.servingSize.steps.flatMap((step, index) =>
        checkStep(step, stepPath(index), limits, options),
      ),
    ];
    return { ok: errors.length === 0, errors, recipe: errors.length === 0 ? recipe : null };
  }

  const errors = parsed.error.issues.map((issue) => formatIssue(issue, input));
  // The knowledge file's limits still run on every field and every step that is
  // well-formed on its own, so one round reports as much as possible.
  const fields = RecipeFieldsSchema.safeParse(input);
  if (fields.success) {
    const schemaPaths = errors.map((error) => error.path);
    for (const issue of checkRecipe(fields.data, limits, options)) {
      if (!schemaPaths.some((path) => overlaps(path, issue.path))) errors.push(issue);
    }
  }
  rawSteps(input).forEach((raw, index) => {
    const path = stepPath(index);
    if (errors.some((error) => overlaps(error.path, path))) return;
    const step = StepSchema.safeParse(raw);
    if (step.success) errors.push(...checkStep(step.data, path, limits, options));
  });
  return { ok: false, errors, recipe: null };
}

// Whether one path is the other or lies inside it.
function overlaps(a: string, b: string): boolean {
  const inside = (outer: string, inner: string) =>
    inner === outer || inner.startsWith(`${outer}.`) || inner.startsWith(`${outer}[`);
  return inside(a, b) || inside(b, a);
}

function checkRecipe(
  recipe: RecipeFields,
  limits: DeviceLimits,
  options: ValidateOptions,
): ValidationIssue[] {
  const r = limits.recipe;
  const serving = recipe.servingSize ?? {};
  const errors: ValidationIssue[] = [];
  const push = (issue: ValidationIssue | null) => {
    if (issue) errors.push(issue);
  };

  if (recipe.title !== undefined) {
    push(checkLength("title", "title", recipe.title, r.recipeTitle));
  }
  if (recipe.description !== undefined) {
    push(
      checkLength("description", "description", recipe.description, {
        min: 0,
        ...r.recipeDescription,
      }),
    );
  }
  if (serving.amount !== undefined) {
    push(checkRange("servingSize.amount", "servings", serving.amount, r.servings, ""));
    if (serving.amount % r.servings.step !== 0) {
      errors.push({
        path: "servingSize.amount",
        message: `servings must be a multiple of ${r.servings.step}`,
      });
    }
  }
  if (serving.preparationTime !== undefined) {
    push(
      checkRange(
        "servingSize.preparationTime",
        "preparationTime",
        serving.preparationTime,
        r.preparationTime,
        " min",
      ),
    );
  }
  // readyInTime >= preparationTime is a schema rule, so it is not repeated here.
  if (serving.readyInTime !== undefined) {
    push(
      checkRange(
        "servingSize.readyInTime",
        "readyInTime",
        serving.readyInTime,
        r.readyInTime,
        " min",
      ),
    );
  }

  const categoryIds = recipe.categoryIds;
  if (categoryIds !== undefined) {
    const count = categoryIds.length;
    if (count < r.categories.min || count > r.categories.max) {
      errors.push({
        path: "categoryIds",
        message: `pick ${r.categories.min} to ${r.categories.max} categories, not ${count}`,
      });
    }
    if (options.knownCategoryIds) {
      const known = new Set(options.knownCategoryIds);
      categoryIds.forEach((id, index) => {
        if (!known.has(id)) {
          errors.push({
            path: `categoryIds[${index}]`,
            message: `category ${id} does not exist; known ids: ${[...known].sort((a, b) => a - b).join(", ")}`,
          });
        }
      });
    }
  }

  (recipe.nutrients ?? []).forEach((nutrient, index) => {
    const path = `nutrients[${index}]`;
    if (!r.nutrients.names.includes(nutrient.name)) {
      errors.push({
        path: `${path}.name`,
        message: `nutrient ${nutrient.name} is not supported; use one of ${r.nutrients.names.join(", ")}`,
      });
    }
    push(checkRange(`${path}.amount`, `${nutrient.name}`, nutrient.amount, r.nutrients, ""));
  });
  return errors;
}

function checkStep(
  step: RecipeStep,
  path: string,
  limits: DeviceLimits,
  options: ValidateOptions,
): ValidationIssue[] {
  const r = limits.recipe;
  const errors: ValidationIssue[] = [];
  const titleIssue = checkLength(`${path}.title`, "step title", step.title, r.stepTitle);
  if (titleIssue) errors.push(titleIssue);

  const description = "description" in step ? step.description : null;
  const descriptionRequired = r.stepDescription.requiredOn.includes(step.kind);
  if (description !== null) {
    if (!descriptionRequired) {
      errors.push({
        path: `${path}.description`,
        message: `${step.kind} steps take no description because the device does not show it`,
      });
    } else {
      const issue = checkLength(
        `${path}.description`,
        "step description",
        description,
        r.stepDescription,
      );
      if (issue) errors.push(issue);
    }
  } else if (descriptionRequired) {
    errors.push({
      path: `${path}.description`,
      message: `${step.kind} steps need a description of ${r.stepDescription.min}-${r.stepDescription.max} characters`,
    });
  }

  if (step.kind === "text") return errors;

  const mode = limits.mode(step.kind);
  if (!mode) {
    errors.push({
      path: `${path}.kind`,
      message: `the knowledge file has no limits for ${step.kind}, so the step cannot be checked`,
    });
    return errors;
  }
  if (!mode.allowed) {
    errors.push({
      path: `${path}.kind`,
      message: `${step.kind} is not allowed${mode.reason ? `: ${mode.reason}` : ""}`,
    });
    return errors;
  }
  const attachments = options.attachments ?? [];
  for (const required of mode.requires) {
    if (!attachments.includes(required)) {
      errors.push({
        path: `${path}.kind`,
        message: `${step.kind} needs the ${required.replace(/_/g, " ")}, which this installation does not have; use another program`,
      });
    }
  }

  // What the knowledge file's conditions can test: the API settings plus the fitted
  // accessory, which is not sent to the device.
  const values: ConditionContext = {
    ...apiSettings(step),
    ...apiModeSettings(step),
    ...("accessory" in step && step.accessory !== undefined ? { accessory: step.accessory } : {}),
  };
  for (const [name, limit] of Object.entries(mode.params)) {
    if (!(name in INPUT_FIELD)) continue;
    const key = name as DeviceSettingKey | ModeSettingKey;
    const value = values[key];
    if (value === undefined) continue;
    const field = key === "time" && step.kind === "turbo" ? "seconds" : INPUT_FIELD[key];
    errors.push(...checkParam(step.kind, key, value, limit, values, `${path}.${field}`, path));
  }
  return errors;
}

type ConditionContext = Partial<Record<ConditionField, LimitValue>>;

function checkParam(
  kind: string,
  key: DeviceSettingKey | ModeSettingKey,
  value: LimitValue,
  limit: ParamLimit,
  context: ConditionContext,
  path: string,
  stepPathPrefix: string,
): ValidationIssue[] {
  const label = key === "time" ? "time" : INPUT_FIELD[key];
  const unit = unitOf(key);
  if (limit.values) {
    if (limit.values.includes(value)) return [];
    return [
      {
        path,
        message: `${label} ${show(key, value)} is not available for ${kind}; allowed: ${limit.values.map((v) => show(key, v)).join(", ")}`,
      },
    ];
  }
  if (typeof value !== "number") return [];

  let max = limit.max;
  let maxCause: LimitCondition | null = null;
  let min = limit.min;
  let minCause: LimitCondition | null = null;
  for (const condition of limit.conditions) {
    if (!matches(condition, context)) continue;
    const setMax = condition.set.max;
    if (typeof setMax === "number" && (max === null || setMax < max)) {
      max = setMax;
      maxCause = condition;
    }
    const setMin = condition.set.min;
    if (typeof setMin === "number" && (min === null || setMin > min)) {
      min = setMin;
      minCause = condition;
    }
  }

  const errors: ValidationIssue[] = [];
  if (min !== null && value < min) {
    errors.push({
      path,
      message: `${label} ${show(key, value)} is below the minimum of ${show(key, min)} for ${kind}${because(minCause)}`,
    });
  } else if (max !== null && value > max) {
    errors.push({
      path,
      message: `${label} ${show(key, value)} is above the maximum of ${show(key, max)} for ${kind}${because(maxCause)}`,
    });
  }
  if (limit.step !== null && value % limit.step !== 0) {
    if (key === "time" && limit.step === 60) {
      errors.push({
        path: `${stepPathPrefix}.seconds`,
        message: `${kind} runs in whole minutes; set seconds to 0 (time is ${show(key, value)})`,
      });
    } else {
      errors.push({
        path,
        message: `${label} must be a multiple of ${limit.step}${unit} for ${kind}`,
      });
    }
  }
  return errors;
}

// A condition on a field the step does not have (no accessory fitted, no temperature on a
// steaming step) does not apply.
function matches(condition: LimitCondition, context: ConditionContext) {
  return conditionEntries(condition).every(([field, ops]) => {
    const actual = context[field];
    if (actual === undefined) return false;
    return Object.entries(ops).every(([op, expected]) => compare(actual, op, expected));
  });
}

function conditionEntries(condition: LimitCondition) {
  return (
    Object.entries(condition.when) as [
      ConditionField,
      Partial<Record<string, LimitValue>> | undefined,
    ][]
  ).flatMap(([field, ops]) => (ops ? [[field, ops] as const] : []));
}

function compare(actual: LimitValue, op: string, expected: LimitValue | undefined): boolean {
  if (expected === undefined) return false;
  if (op === "eq") return actual === expected;
  if (op === "ne") return actual !== expected;
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  if (op === "gt") return actual > expected;
  if (op === "gte") return actual >= expected;
  if (op === "lt") return actual < expected;
  if (op === "lte") return actual <= expected;
  return false;
}

const opWords: Record<string, string> = {
  eq: "is",
  ne: "is not",
  gt: "is above",
  gte: "is at least",
  lt: "is below",
  lte: "is at most",
};

function because(condition: LimitCondition | null): string {
  if (!condition) return "";
  const parts = conditionEntries(condition).flatMap(([field, ops]) =>
    Object.entries(ops).map(([op, expected]) => {
      if (field === "clockwise" && op === "eq") {
        return `rotation is ${expected === false ? "left" : "right"}`;
      }
      if (field === "accessory" && op === "eq") {
        return `the ${String(expected).replace(/_/g, " ")} is fitted`;
      }
      const name = field in INPUT_FIELD ? INPUT_FIELD[field as DeviceSettingKey] : field;
      const shown =
        field in INPUT_FIELD ? show(field as DeviceSettingKey, expected) : String(expected);
      return `${name === "minutes" ? "time" : name} ${opWords[op] ?? op} ${shown}`;
    }),
  );
  return ` when ${parts.join(" and ")}`;
}

function unitOf(key: DeviceSettingKey | ModeSettingKey): string {
  if (key === "temperature") return " °C";
  if (key === "weight") return " g";
  if (key === "time") return " s";
  return "";
}

function show(key: DeviceSettingKey | ModeSettingKey, value: LimitValue | undefined): string {
  if (key === "clockwise") return value === false ? "left" : "right";
  if (typeof value !== "number") return String(value);
  if (key === "time") return formatSeconds(value);
  return `${value}${unitOf(key)}`;
}

function formatSeconds(total: number): string {
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

function checkLength(
  path: string,
  label: string,
  value: string,
  range: Range,
): ValidationIssue | null {
  if (value.length < range.min) {
    return {
      path,
      message:
        range.min === 1
          ? `${label} must not be empty`
          : `${label} needs at least ${range.min} characters`,
    };
  }
  if (value.length > range.max) {
    return {
      path,
      message: `${label} has ${value.length} characters; at most ${range.max} are allowed`,
    };
  }
  return null;
}

function checkRange(
  path: string,
  label: string,
  value: number,
  range: Range,
  unit: string,
): ValidationIssue | null {
  if (value < range.min)
    return {
      path,
      message: `${label} ${value}${unit} is below the minimum of ${range.min}${unit}`,
    };
  if (value > range.max)
    return {
      path,
      message: `${label} ${value}${unit} is above the maximum of ${range.max}${unit}`,
    };
  return null;
}

function stepPath(index: number): string {
  return `servingSize.steps[${index}]`;
}

function rawSteps(input: unknown): unknown[] {
  const serving = field(input, "servingSize");
  const steps = field(serving, "steps");
  return Array.isArray(steps) ? (steps as unknown[]) : [];
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function formatIssue(issue: ZodIssue, input: unknown): ValidationIssue {
  const path = formatPath(issue.path);
  if (issue.code === "unrecognized_keys") {
    const target = issue.path.reduce<unknown>(
      (value, segment) => field(value, String(segment)),
      input,
    );
    const kind = field(target, "kind");
    return {
      path: [path, issue.keys.length === 1 ? issue.keys[0] : ""].filter(Boolean).join("."),
      message:
        issue.keys.length === 1 &&
        issue.keys[0] === "description" &&
        typeof kind === "string" &&
        kind in MODES
          ? `${kind} steps take no description because the device does not show it; put the instruction into a text step before it`
          : `unknown field ${issue.keys.join(", ")}`,
    };
  }
  return { path: path || "(recipe)", message: issue.message };
}
