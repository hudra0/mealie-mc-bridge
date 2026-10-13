// Loads the device limits from knowledge/device-programs.json and exposes the "effective"
// layer: what the validator enforces. The file carries more (editor, server, corpus
// layers, evidence); this loader checks only the parts it reads and ignores the rest.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_DEVICE_PROGRAMS_PATH = "./knowledge/device-programs.json";

export type ConditionOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
export type LimitValue = number | string | boolean;

export interface LimitCondition {
  when: Readonly<Record<string, Partial<Record<ConditionOp, LimitValue>>>>;
  set: Readonly<Record<string, LimitValue>>;
  kind: string | null;
}

export interface ParamLimit {
  unit: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  values: readonly LimitValue[] | null;
  conditions: readonly LimitCondition[];
}

export interface ModeLimits {
  id: string;
  allowed: boolean;
  reason: string | null;
  // Attachments the mode needs, for example "food_processor_attachment".
  requires: readonly string[];
  stepDescription: "required" | "cleared";
  deviceSettingsKeys: readonly string[] | null;
  modeSettingKeys: readonly string[] | null;
  params: Readonly<Record<string, ParamLimit>>;
}

export interface Range {
  min: number;
  max: number;
}

export interface RecipeLimits {
  deviceTypeIds: readonly number[];
  recipeTitle: Range;
  recipeDescription: { max: number };
  stepTitle: Range;
  stepDescription: Range & { requiredOn: readonly string[] };
  servings: Range & { step: number };
  categories: Range;
  preparationTime: Range;
  readyInTime: Range;
  nutrients: Range & { names: readonly string[] };
  speed: Range;
}

export interface DeviceLimits {
  readonly recipe: RecipeLimits;
  readonly modes: ReadonlyMap<string, ModeLimits>;
  mode(id: string): ModeLimits | undefined;
}

export class DeviceLimitsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeviceLimitsError";
  }
}

const limitValue = z.union([z.number(), z.string(), z.boolean()]);
const op = z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]);

const conditionSchema = z.looseObject({
  when: z.record(z.string(), z.partialRecord(op, limitValue)),
  set: z.record(z.string(), limitValue),
  kind: z.string().optional(),
});

const paramSchema = z.looseObject({
  unit: z.string().nullish(),
  min: z.number().nullish(),
  max: z.number().nullish(),
  step: z.number().positive().nullish(),
  values: z.array(limitValue).nullish(),
  conditions: z.array(conditionSchema).optional(),
});

const modeSchema = z.looseObject({
  id: z.string().min(1),
  payload: z.looseObject({
    deviceSettingsKeys: z.array(z.string()).nullable(),
    modeSettingKeys: z.array(z.string()).nullable(),
  }),
  stepDescription: z.enum(["required", "cleared"]),
  effective: z.looseObject({
    allowed: z.boolean(),
    reason: z.string().optional(),
    requires: z.array(z.string()).optional(),
  }),
  params: z.record(z.string(), z.looseObject({ effective: paramSchema })),
});

const range = z.looseObject({ min: z.number(), max: z.number() });
const effective = <T extends z.ZodType>(schema: T) => z.looseObject({ effective: schema });

const fileSchema = z.looseObject({
  schemaVersion: z.literal(1),
  recipeLimits: z.looseObject({
    deviceTypeIds: effective(z.looseObject({ values: z.array(z.number().int()).min(1) })),
    speedRules: z.looseObject({ range: effective(range) }),
    text: z.looseObject({
      recipeTitle: effective(z.looseObject({ minLength: z.number(), maxLength: z.number() })),
      recipeDescription: effective(z.looseObject({ maxLength: z.number() })),
      stepTitle: effective(z.looseObject({ minLength: z.number(), maxLength: z.number() })),
      stepDescription: effective(
        z.looseObject({
          minLength: z.number(),
          maxLength: z.number(),
          requiredOn: z.array(z.string()),
        }),
      ),
    }),
    servings: z.looseObject({
      amount: effective(range.extend({ step: z.number().positive() })),
    }),
    categories: effective(range),
    times: z.looseObject({
      preparationTime: effective(range),
      readyInTime: effective(range),
    }),
    nutrients: effective(range.extend({ names: z.array(z.string()) })),
  }),
  modes: z.array(modeSchema).min(1),
});

type DeviceProgramsFile = z.infer<typeof fileSchema>;

// Reads and checks the knowledge file. A relative path resolves against the working
// directory.
export async function loadDeviceLimits(
  path: string = DEFAULT_DEVICE_PROGRAMS_PATH,
): Promise<DeviceLimits> {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (error) {
    throw new DeviceLimitsError(`Cannot read the device programs file ${absolute}`, {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new DeviceLimitsError(`${absolute} is not valid JSON`, { cause: error });
  }
  return parseDeviceLimits(json, absolute);
}

export function parseDeviceLimits(json: unknown, source = "device programs"): DeviceLimits {
  const result = fileSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new DeviceLimitsError(`${source} does not have the expected shape: ${issues}`);
  }
  return toDeviceLimits(result.data, source);
}

function toDeviceLimits(file: DeviceProgramsFile, source: string): DeviceLimits {
  const r = file.recipeLimits;
  const text = r.text;
  const recipe: RecipeLimits = {
    deviceTypeIds: r.deviceTypeIds.effective.values,
    recipeTitle: lengths(text.recipeTitle.effective),
    recipeDescription: { max: text.recipeDescription.effective.maxLength },
    stepTitle: lengths(text.stepTitle.effective),
    stepDescription: {
      ...lengths(text.stepDescription.effective),
      requiredOn: text.stepDescription.effective.requiredOn,
    },
    servings: {
      min: r.servings.amount.effective.min,
      max: r.servings.amount.effective.max,
      step: r.servings.amount.effective.step,
    },
    categories: pick(r.categories.effective),
    preparationTime: pick(r.times.preparationTime.effective),
    readyInTime: pick(r.times.readyInTime.effective),
    nutrients: { ...pick(r.nutrients.effective), names: r.nutrients.effective.names },
    speed: pick(r.speedRules.range.effective),
  };

  const modes = new Map<string, ModeLimits>();
  for (const mode of file.modes) {
    if (modes.has(mode.id))
      throw new DeviceLimitsError(`${source}: mode ${mode.id} is listed twice`);
    const params: Record<string, ParamLimit> = {};
    for (const [name, param] of Object.entries(mode.params)) {
      const p = param.effective;
      params[name] = {
        unit: p.unit ?? null,
        min: p.min ?? null,
        max: p.max ?? null,
        step: p.step ?? null,
        values: p.values ?? null,
        conditions: (p.conditions ?? []).map((condition) => ({
          when: condition.when,
          set: condition.set,
          kind: condition.kind ?? null,
        })),
      };
    }
    modes.set(mode.id, {
      id: mode.id,
      allowed: mode.effective.allowed,
      reason: mode.effective.reason ?? null,
      requires: mode.effective.requires ?? [],
      stepDescription: mode.stepDescription,
      deviceSettingsKeys: mode.payload.deviceSettingsKeys,
      modeSettingKeys: mode.payload.modeSettingKeys,
      params,
    });
  }

  return { recipe, modes, mode: (id) => modes.get(id) };
}

function lengths(value: { minLength: number; maxLength: number }): Range {
  return { min: value.minLength, max: value.maxLength };
}

function pick(value: { min: number; max: number }): Range {
  return { min: value.min, max: value.max };
}
