import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { McWritableStatus } from "../mc/types.js";
import { parseDeviceLimits } from "./limits.js";
import { buildMcPayload, formatAmount } from "./payload.js";
import { dePack, enPack } from "../testing/locale.js";
import { RecipeInputSchema, type RecipeInput } from "./schema.js";

const de = dePack.mc;

const sample = (): RecipeInput =>
  RecipeInputSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../test/fixtures/recipe/all-modes.recipe-input.json", import.meta.url),
        "utf8",
      ),
    ),
  );

const limits = parseDeviceLimits(
  JSON.parse(
    readFileSync(new URL("../../knowledge/device-programs.json", import.meta.url), "utf8"),
  ),
);

const steps = (input: RecipeInput) =>
  buildMcPayload(input, limits, { locale: de, status: "draft" }).servingSizes[0].steps;

describe("buildMcPayload", () => {
  it("builds the all-modes sample", () => {
    const payload = buildMcPayload(sample(), limits, {
      locale: de,
      status: "draft",
      detailsMediaId: 700002,
      thumbnailMediaId: 700001,
    });
    expect(payload).toMatchSnapshot();
  });

  it("sets the constant fields the server expects", () => {
    const payload = buildMcPayload(sample(), limits, { locale: de, status: "draft" });
    expect(payload).toMatchObject({
      source: "member",
      languageLocale: "de-DE",
      deviceTypeIds: [13],
      complexityId: 142,
      allowSocialSharing: false,
    });
    expect(payload.servingSizes).toHaveLength(1);
    expect(payload.servingSizes[0]).toMatchObject({ isDefault: true, maxServing: null, order: 0 });
  });

  it.each<[RecipeInput["complexity"], number]>([
    ["easy", 142],
    ["medium", 99],
    ["hard", 104],
  ])("maps complexity %s to id %i", (complexity, id) => {
    expect(
      buildMcPayload({ ...sample(), complexity }, limits, { locale: de, status: "draft" })
        .complexityId,
    ).toBe(id);
  });

  it.each<McWritableStatus>(["draft", "private-publish"])(
    "takes the status %s from the caller",
    (status) => {
      expect(buildMcPayload(sample(), limits, { locale: de, status }).status).toBe(status);
    },
  );

  it("takes the language, complexity ids and default group name from the locale pack", () => {
    const english = { ...sample(), locale: "en-US", complexity: "medium" as const };
    english.servingSize.ingredientGroups[0]!.name = "";
    const payload = buildMcPayload(english, limits, { locale: enPack.mc, status: "draft" });
    expect(payload).toMatchObject({ languageLocale: "en-US", complexityId: 16 });
    expect(payload.servingSizes[0]?.ingredientGroups[0]?.name).toBe("General ingredients");
  });

  it("refuses a recipe written for another locale", () => {
    expect(() => buildMcPayload(sample(), limits, { locale: enPack.mc, status: "draft" })).toThrow(
      "The recipe is written for de-DE, but the payload is built for en-US",
    );
  });

  it("refuses statuses that would publish the recipe", () => {
    for (const status of ["pending", "publish", "rejected", undefined]) {
      expect(() =>
        buildMcPayload(sample(), limits, { locale: de, status: status as McWritableStatus }),
      ).toThrow(`Refusing to build a payload with status "${String(status)}"`);
    }
  });

  it("sets both orientations to the uploaded media ids", () => {
    const payload = buildMcPayload(sample(), limits, {
      locale: de,
      status: "draft",
      detailsMediaId: 11,
      thumbnailMediaId: 12,
    });
    expect(payload.detailsImage).toEqual({
      portraitMediaId: 11,
      landscapeMediaId: 11,
      portraitIsAiGenerated: false,
      landscapeIsAiGenerated: false,
    });
    expect(payload.thumbnail).toEqual({
      portraitMediaId: 12,
      landscapeMediaId: 12,
      portraitIsAiGenerated: false,
      landscapeIsAiGenerated: false,
    });
  });

  it("sends null media ids without an image", () => {
    const payload = buildMcPayload(sample(), limits, {
      locale: de,
      status: "draft",
      detailsMediaId: null,
    });
    expect(payload.detailsImage).toMatchObject({ portraitMediaId: null, landscapeMediaId: null });
    expect(payload.thumbnail).toMatchObject({ portraitMediaId: null, landscapeMediaId: null });
  });

  it("uses the category ids from the options over those of the input", () => {
    expect(buildMcPayload(sample(), limits, { locale: de, status: "draft" }).categoryIds).toEqual([
      228,
    ]);
    const ids = [260, 471];
    const payload = buildMcPayload(sample(), limits, {
      locale: de,
      status: "draft",
      categoryIds: ids,
    });
    expect(payload.categoryIds).toEqual([260, 471]);
    expect(payload.categoryIds).not.toBe(ids);
  });

  it("rounds nutrients to whole numbers and adds their units", () => {
    expect(buildMcPayload(sample(), limits, { locale: de, status: "draft" }).nutrients).toEqual([
      { name: "calories", unit: "kCal", amount: 300 },
      { name: "carbohydrate", unit: "g", amount: 60 },
      { name: "fat", unit: "g", amount: 1 },
      { name: "protein", unit: "g", amount: 9 },
    ]);
  });

  it("sends empty nutrients and instruction when the input has none", () => {
    const input = sample();
    delete input.nutrients;
    delete input.servingSize.instruction;
    const payload = buildMcPayload(input, limits, { locale: de, status: "draft" });
    expect(payload.nutrients).toEqual([]);
    expect(payload.servingSizes[0].instruction).toBe("");
  });

  it("numbers groups from 0 and ingredients from 1, with amounts as strings", () => {
    const input = sample();
    input.servingSize.ingredientGroups.push({
      name: "  ",
      ingredients: [{ name: "Öl", amount: 0.1 + 0.2, unit: "EL", isOptional: false }],
    });
    const groups = buildMcPayload(input, limits, { locale: de, status: "draft" }).servingSizes[0]
      .ingredientGroups;
    expect(groups.map(({ name, isDefault, order }) => ({ name, isDefault, order }))).toEqual([
      { name: "Zutaten", isDefault: true, order: 0 },
      { name: "Allgemeine Zutaten", isDefault: false, order: 1 },
    ]);
    expect(groups[0]?.ingredients.map(({ order, amount }) => [order, amount])).toEqual([
      [1, "500"],
      [2, "1"],
      [3, "1/2"],
      [4, "300"],
    ]);
    expect(groups[1]?.ingredients[0]).toEqual({
      name: "Öl",
      isOptional: false,
      unit: "EL",
      amount: "0.3",
      systemIngredientId: null,
      order: 1,
      ingredientCategory: null,
      iconUrl: null,
    });
  });

  it("sets the resolved systemIngredientId per ingredient, null where none is known", () => {
    const ingredientIds = new Map<string, number | null>([
      ["zwiebel", 9001],
      ["salz", null],
      ["mehl", 9002],
    ]);
    const input = sample();
    input.servingSize.ingredientGroups[0]!.ingredients[3]!.name = "  MEHL ";
    const ids = buildMcPayload(input, limits, {
      locale: de,
      status: "draft",
      ingredientIds,
    }).servingSizes[0].ingredientGroups[0]?.ingredients.map((item) => [
      item.name,
      item.systemIngredientId,
    ]);
    expect(ids).toEqual([
      ["Wasser", null],
      ["Zwiebel", 9001],
      ["Salz", null],
      ["  MEHL ", 9002],
    ]);
  });

  it("builds text steps without a mode", () => {
    expect(steps(sample())[0]).toEqual({
      title: "Wasser einfüllen",
      description: "500 g Wasser in den Mixbehälter geben.",
      duration: null,
      mode: null,
      videoMedia: null,
      order: 0,
    });
  });

  it("keeps descriptions only where the device shows them", () => {
    for (const step of steps(sample())) {
      const kind = step.mode?.type;
      if (kind === undefined) expect(step.description).not.toBe("");
      else if (limits.recipe.stepDescription.requiredOn.includes(kind)) {
        expect(step.description).not.toBe("");
      } else expect(step.description, kind).toBe("");
    }
  });

  it("numbers steps from 0", () => {
    expect(steps(sample()).map((step) => step.order)).toEqual([...Array(20).keys()]);
  });

  it("converts manual cooking to seconds and a direction", () => {
    expect(steps(sample())[2]?.mode).toEqual({
      type: "customized",
      modeSetting: null,
      deviceSettings: [{ order: 0, temperature: 100, speed: 1, time: 300, clockwise: false }],
    });
    expect(steps(sample())[12]?.mode?.deviceSettings).toEqual([
      { order: 0, temperature: 0, speed: 5, time: 20, clockwise: true },
    ]);
  });

  it("sends weight, turbo seconds and whole minutes as the API keys", () => {
    const built = steps(sample());
    expect(built[1]).toMatchObject({
      description: "500 g Wasser abwiegen.",
      mode: { type: "scale", modeSetting: null, deviceSettings: [{ order: 0, weight: 500 }] },
    });
    expect(built[11]).toMatchObject({
      description: "Zwiebel 5 Sekunden zerkleinern.",
      mode: { type: "turbo", deviceSettings: [{ order: 0, time: 5 }] },
    });
    expect(built[14]?.mode?.deviceSettings).toEqual([{ order: 0, temperature: 60, time: 900 }]);
  });

  it("sends program settings instead of device settings for eggs and pre-cleaning", () => {
    const built = steps(sample());
    expect(built[17]?.mode).toEqual({
      type: "cooking_eggs",
      modeSetting: { size: "medium", texture: "hard" },
      deviceSettings: null,
    });
    expect(built[18]?.mode).toEqual({
      type: "precleaning",
      modeSetting: { duration: "short" },
      deviceSettings: null,
    });
  });

  it("refuses a machine step that lacks a setting", () => {
    const input = sample();
    const broken = { kind: "customized", title: "Kochen", temperature: 0, minutes: 1, seconds: 0 };
    input.servingSize.steps = [broken as RecipeInput["servingSize"]["steps"][number]];
    expect(() => buildMcPayload(input, limits, { locale: de, status: "draft" })).toThrow(
      "customized has no value for speed",
    );
    const eggs = { kind: "cooking_eggs", title: "Eier", size: "small" };
    input.servingSize.steps = [eggs as RecipeInput["servingSize"]["steps"][number]];
    expect(() => buildMcPayload(input, limits, { locale: de, status: "draft" })).toThrow(
      "cooking_eggs has no value for texture",
    );
  });
});

describe("formatAmount", () => {
  it.each<[string | number, string]>([
    [500, "500"],
    [0.5, "0.5"],
    [1 / 3, "0.333"],
    [0.1 + 0.2, "0.3"],
    ["1-2", "1-2"],
    ["", ""],
  ])("%j -> %j", (amount, expected) => {
    expect(formatAmount(amount)).toBe(expected);
  });
});
