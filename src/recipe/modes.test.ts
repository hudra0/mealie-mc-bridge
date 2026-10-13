import { beforeAll, describe, expect, it } from "vitest";
import { loadDeviceLimits, type DeviceLimits } from "./limits.js";
import {
  INPUT_FIELD,
  MACHINE_STEP_KINDS,
  MODES,
  apiModeSettings,
  apiSettings,
  stepSeconds,
  type DeviceSettingKey,
  type ModeSettingKey,
} from "./modes.js";
import { StepSchema } from "./schema.js";

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

  // The payload builder reads the API keys from the knowledge file and the values from the
  // step, so every key the file lists needs an input field in the schema, and no input
  // field may go unused.
  it("gives every machine step kind exactly the inputs its API keys need", () => {
    for (const option of StepSchema.options) {
      const kind = option.shape.kind.value;
      if (kind === "text") continue;
      const mode = limits.mode(kind);
      if (!mode) throw new Error(`no knowledge entry for ${kind}`);
      // accessory only feeds the validator's conditions; it is not an API setting.
      const fields = Object.keys(option.shape).filter(
        (key) => !["kind", "title", "description", "accessory"].includes(key),
      );
      const expected = new Set<string>();
      for (const key of mode.deviceSettingsKeys ?? []) {
        if (key === "order") continue;
        if (key === "time") {
          if (kind !== "turbo") expected.add("minutes");
          expected.add("seconds");
        } else {
          expect(INPUT_FIELD, `${kind}.${key}`).toHaveProperty(key);
          expected.add(INPUT_FIELD[key as DeviceSettingKey]);
        }
      }
      for (const key of mode.modeSettingKeys ?? []) {
        expect(INPUT_FIELD, `${kind}.${key}`).toHaveProperty(key);
        expected.add(INPUT_FIELD[key as ModeSettingKey]);
      }
      expect(fields.sort(), kind).toEqual([...expected].sort());
      expect("description" in option.shape, kind).toBe(
        limits.recipe.stepDescription.requiredOn.includes(kind),
      );
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
