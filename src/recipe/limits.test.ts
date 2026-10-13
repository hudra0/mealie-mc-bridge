import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_PROGRAMS_PATH,
  DeviceLimitsError,
  loadDeviceLimits,
  parseDeviceLimits,
  type DeviceLimits,
} from "./limits.js";

const knowledgePath = new URL("../../knowledge/device-programs.json", import.meta.url);
const readKnowledge = async () =>
  JSON.parse(await readFile(knowledgePath, "utf8")) as Record<string, unknown>;

describe("loadDeviceLimits", () => {
  let limits: DeviceLimits;

  beforeAll(async () => {
    limits = await loadDeviceLimits(DEFAULT_DEVICE_PROGRAMS_PATH);
  });

  it("loads the effective recipe limits from the knowledge file", () => {
    expect(limits.recipe).toEqual({
      deviceTypeIds: [13],
      recipeTitle: { min: 1, max: 86 },
      recipeDescription: { max: 240 },
      stepTitle: { min: 1, max: 80 },
      stepDescription: { min: 1, max: 240, requiredOn: ["text", "scale", "turbo"] },
      servings: { min: 1, max: 100, step: 1 },
      categories: { min: 1, max: 8 },
      preparationTime: { min: 1, max: 1440 },
      readyInTime: { min: 1, max: 18000 },
      nutrients: {
        min: 0,
        max: 99999,
        names: [
          "calories",
          "carbohydrate",
          "fat",
          "protein",
          "saturates",
          "sugar",
          "salt",
          "roughage",
        ],
      },
      coverPhotoAspect: { width: 16, height: 9 },
    });
  });

  it("exposes the effective layer per program", () => {
    const customized = limits.mode("customized");
    expect(customized).toMatchObject({
      allowed: true,
      requires: [],
      stepDescription: "cleared",
      deviceSettingsKeys: ["order", "temperature", "speed", "time", "clockwise"],
      modeSettingKeys: null,
    });
    expect(customized?.params.time).toMatchObject({ unit: "s", min: 1, max: 5940, step: 1 });
    expect(customized?.params.speed?.conditions).toEqual([
      { when: { temperature: { ne: 0 } }, set: { max: 3 }, kind: "device" },
      { when: { clockwise: { eq: false } }, set: { max: 3 }, kind: "device" },
      { when: { accessory: { eq: "butterfly_whisk" } }, set: { max: 4 }, kind: "accessory" },
    ]);
    expect(limits.mode("roasting")?.params.temperature?.values).toEqual([
      100, 105, 110, 115, 120, 125, 130,
    ]);
    expect(limits.mode("steaming")?.params.time?.min).toBe(180);
    expect(limits.mode("sous_vide")?.params.time?.step).toBe(60);
    expect(limits.mode("food_processor")?.requires).toEqual(["food_processor_attachment"]);
    expect(limits.mode("kneading")).toMatchObject({
      allowed: false,
      reason: expect.any(String) as unknown,
    });
    expect(limits.mode("ramp")?.allowed).toBe(false);
    expect(limits.mode("frying")).toBeUndefined();
    expect(limits.modes.size).toBe(19);
  });

  it("resolves the default path against the working directory", async () => {
    await expect(loadDeviceLimits()).resolves.toMatchObject({ recipe: { deviceTypeIds: [13] } });
  });
});

describe("rejecting a malformed knowledge file", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-limits-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the missing file", async () => {
    const missing = join(dir, "missing.json");
    await expect(loadDeviceLimits(missing)).rejects.toThrow(
      new DeviceLimitsError(`Cannot read the device programs file ${missing}`),
    );
  });

  it("rejects invalid JSON", async () => {
    const file = join(dir, "broken.json");
    await writeFile(file, "{ not json");
    await expect(loadDeviceLimits(file)).rejects.toThrow(/is not valid JSON$/);
  });

  it("rejects a file without recipe limits", async () => {
    const file = join(dir, "partial.json");
    const knowledge = await readKnowledge();
    delete knowledge.recipeLimits;
    await writeFile(file, JSON.stringify(knowledge));
    const error = await loadDeviceLimits(file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceLimitsError);
    expect((error as Error).message).toContain("does not have the expected shape: recipeLimits:");
  });

  it("rejects another schema version", async () => {
    const knowledge = await readKnowledge();
    knowledge.schemaVersion = 2;
    expect(() => parseDeviceLimits(knowledge)).toThrow(/schemaVersion/);
  });

  it("rejects a program with a broken limit", async () => {
    const knowledge = await readKnowledge();
    const modes = knowledge.modes as {
      params: Record<string, { effective: Record<string, unknown> }>;
    }[];
    const time = modes[1]?.params.time;
    if (time) time.effective.min = "45";
    expect(() => parseDeviceLimits(knowledge, "test file")).toThrow(
      /^test file does not have the expected shape: modes\.1\.params\.time\.effective\.min:/,
    );
  });

  // An operator the validator does not know would never match, so the limit it sets would
  // silently not apply. The loader refuses the file instead.
  it("rejects a condition with an unknown operator", async () => {
    const knowledge = await readKnowledge();
    const modes = knowledge.modes as {
      id: string;
      params: Record<string, { effective: { conditions: unknown[] } }>;
    }[];
    const speed = modes.find((mode) => mode.id === "customized")?.params.speed;
    speed?.effective.conditions.push({ when: { temperature: { between: 1 } }, set: { max: 1 } });
    expect(() => parseDeviceLimits(knowledge)).toThrow(
      /conditions\.3\.when\.temperature: Unrecognized key: "between"/,
    );
  });

  // Same reason: the validator can only supply the step's API settings and the accessory.
  it("rejects a condition on a field the validator cannot supply", async () => {
    const knowledge = await readKnowledge();
    const modes = knowledge.modes as {
      id: string;
      params: Record<string, { effective: { conditions: unknown[] } }>;
    }[];
    const speed = modes.find((mode) => mode.id === "customized")?.params.speed;
    speed?.effective.conditions.push({ when: { altitude: { gt: 1000 } }, set: { max: 2 } });
    expect(() => parseDeviceLimits(knowledge)).toThrow(
      /conditions\.3\.when: Unrecognized key: "altitude"/,
    );
  });

  it("rejects a step description rule that contradicts the program entry", async () => {
    const knowledge = await readKnowledge();
    const modes = knowledge.modes as { id: string; stepDescription: string }[];
    const scale = modes.find((mode) => mode.id === "scale");
    if (scale) scale.stepDescription = "cleared";
    expect(() => parseDeviceLimits(knowledge, "test file")).toThrow(
      "test file: mode scale has stepDescription cleared, but recipeLimits.text.stepDescription.requiredOn lists it",
    );
  });

  it("rejects a cover photo aspect that is not width:height", async () => {
    const knowledge = await readKnowledge();
    const limits = knowledge.recipeLimits as { coverPhoto: { effective: { aspect: string } } };
    limits.coverPhoto.effective.aspect = "wide";
    expect(() => parseDeviceLimits(knowledge)).toThrow(/coverPhoto\.effective\.aspect/);
  });

  it("rejects a program listed twice", async () => {
    const knowledge = await readKnowledge();
    const modes = knowledge.modes as unknown[];
    knowledge.modes = [...modes, modes[1]];
    expect(() => parseDeviceLimits(knowledge)).toThrow(/mode kneading_solid_dough is listed twice/);
  });

  it("rejects something that is not an object", () => {
    expect(() => parseDeviceLimits([])).toThrow(DeviceLimitsError);
  });
});
