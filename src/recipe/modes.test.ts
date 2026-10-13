import { beforeAll, describe, expect, it } from "vitest";
import { loadDeviceLimits, type DeviceLimits } from "./limits.js";
import {
  INPUT_FIELD,
  MACHINE_STEP_KINDS,
  MC_SMART_DEVICE_TYPE_ID,
  MODES,
  apiModeSettings,
  apiSettings,
  stepSeconds,
} from "./modes.js";
import { SCHEMA_LIMITS, StepSchema } from "./schema.js";

// The mode table, the schema and the knowledge file describe the same device. These tests
// fail when one of them changes without the others.
describe("mode table against the knowledge file", () => {
  let limits: DeviceLimits;

  beforeAll(async () => {
    limits = await loadDeviceLimits();
  });

  it.each(MACHINE_STEP_KINDS)("%s matches the effective layer", (kind) => {
    const mode = limits.mode(kind);
    const mapping = MODES[kind];
    expect(mode, `knowledge entry for ${kind}`).toBeDefined();
    if (!mode) return;
    expect(mode.allowed).toBe(true);
    expect(mapping.apiType).toBe(mode.id);
    expect(
      mapping.deviceSettingsKeys ? ["order", ...mapping.deviceSettingsKeys].sort() : null,
    ).toEqual(mode.deviceSettingsKeys ? [...mode.deviceSettingsKeys].sort() : null);
    expect(mapping.modeSettingKeys).toEqual(mode.modeSettingKeys);
    expect(mapping.description).toBe(mode.stepDescription === "required");
    const timeStep = mode.params.time?.step ?? null;
    expect(mapping.timeUnit).toBe(timeStep === null ? null : timeStep === 60 ? "min" : "s");
    for (const param of Object.keys(mode.params)) {
      expect(INPUT_FIELD, `input field for ${kind}.${param}`).toHaveProperty(param);
    }
  });

  it("leaves out the programs members cannot use", () => {
    const disallowed = [...limits.modes.values()]
      .filter((mode) => !mode.allowed)
      .map((mode) => mode.id);
    expect(disallowed.sort()).toEqual(["kneading", "ramp"]);
    for (const id of disallowed) expect(MACHINE_STEP_KINDS).not.toContain(id);
  });

  it("uses the device type id of the knowledge file", () => {
    expect(limits.recipe.deviceTypeIds).toEqual([MC_SMART_DEVICE_TYPE_ID]);
  });

  it("keeps the schema limits equal to the effective recipe limits", () => {
    const r = limits.recipe;
    expect(SCHEMA_LIMITS.title).toEqual(r.recipeTitle);
    expect(SCHEMA_LIMITS.description.max).toBe(r.recipeDescription.max);
    expect(SCHEMA_LIMITS.stepTitle).toEqual(r.stepTitle);
    expect(SCHEMA_LIMITS.stepDescription).toEqual({
      min: r.stepDescription.min,
      max: r.stepDescription.max,
    });
    expect(SCHEMA_LIMITS.servings).toEqual({ min: r.servings.min, max: r.servings.max });
    expect(SCHEMA_LIMITS.categories).toEqual(r.categories);
    expect(SCHEMA_LIMITS.preparationTime).toEqual(r.preparationTime);
    expect(SCHEMA_LIMITS.readyInTime).toEqual(r.readyInTime);
    const longest = Math.max(
      ...MACHINE_STEP_KINDS.map((kind) => limits.mode(kind)?.params.time?.max ?? 0),
    );
    expect(SCHEMA_LIMITS.stepMinutes.max).toBe(longest / 60);
  });

  it("gives every machine step kind exactly the inputs its API keys need", () => {
    for (const option of StepSchema.options) {
      const kind = option.shape.kind.value;
      if (kind === "text") continue;
      const mapping = MODES[kind];
      const fields = Object.keys(option.shape).filter(
        (key) => !["kind", "title", "description"].includes(key),
      );
      const expected = new Set<string>();
      for (const key of mapping.deviceSettingsKeys ?? []) {
        if (key === "time") {
          if (kind !== "turbo") expected.add("minutes");
          expected.add("seconds");
        } else {
          expected.add(INPUT_FIELD[key]);
        }
      }
      for (const key of mapping.modeSettingKeys ?? []) expected.add(INPUT_FIELD[key]);
      expect(fields.sort(), kind).toEqual([...expected].sort());
      expect("description" in option.shape, kind).toBe(mapping.description);
    }
  });
});

describe("API settings of a step", () => {
  it("converts minutes, rotation and grams", () => {
    expect(
      apiSettings({
        kind: "customized",
        title: "t",
        temperature: 100,
        minutes: 2,
        seconds: 5,
        speed: 1,
        rotation: "left",
      }),
    ).toEqual({ temperature: 100, speed: 1, time: 125, clockwise: false });
    expect(apiSettings({ kind: "scale", title: "t", description: "d", grams: 250 })).toEqual({
      weight: 250,
    });
    expect(apiSettings({ kind: "turbo", title: "t", description: "d", seconds: 4 })).toEqual({
      time: 4,
    });
  });

  it("reads the program settings of eggs and pre-cleaning", () => {
    expect(
      apiModeSettings({ kind: "cooking_eggs", title: "t", size: "large", texture: "soft" }),
    ).toEqual({
      size: "large",
      texture: "soft",
    });
    expect(apiModeSettings({ kind: "precleaning", title: "t", duration: "long" })).toEqual({
      duration: "long",
    });
    expect(stepSeconds({ kind: "precleaning", title: "t", duration: "long" })).toBeNull();
  });
});
