import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mealieRecipeSchema, type MealieRecipe } from "../mealie/types.js";
import { normalizeIngredients } from "./normalize.js";

const fixture = (name: string): MealieRecipe =>
  mealieRecipeSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../test/fixtures/mealie/${name}`, import.meta.url), "utf8"),
    ),
  );

// A recipe with the given ingredient rows, filled up the way Mealie returns them.
const recipeWith = (...rows: Record<string, unknown>[]): MealieRecipe =>
  mealieRecipeSchema.parse({
    id: "00000000-0000-4000-8000-000000000009",
    slug: "test",
    recipeIngredient: rows.map((row, position) => ({
      quantity: 0,
      unit: null,
      food: null,
      note: "",
      display: "",
      title: null,
      originalText: null,
      referenceId: `00000000-0000-4000-8000-00000000010${position}`,
      ...row,
    })),
  });

describe("normalizeIngredients with structured ingredients", () => {
  const items = normalizeIngredients(fixture("recipe-structured-v3.28.json"));
  const byFood = (food: string) => items.find((item) => item.food === food);

  it("keeps every ingredient in order with its reference id", () => {
    expect(items.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(items.every((item) => item.source === "structured")).toBe(true);
    expect(items[0]?.referenceId).toBe("00000000-0000-4000-8000-000000000101");
  });

  it("takes quantity, unit code, food and note from the structured fields", () => {
    expect(byFood("Hokkaido-Kürbis")).toMatchObject({
      quantity: 500,
      quantityMax: null,
      unit: "g",
      note: "entkernt, gewürfelt",
      original: "500 g Hokkaido-Kürbis entkernt, gewürfelt",
    });
    expect(byFood("Gemüsebrühe")).toMatchObject({ quantity: 1, unit: "l" });
    expect(byFood("Zwiebel")).toMatchObject({ quantity: 1, unit: null, note: "fein gewürfelt" });
  });

  it("falls back to the unit name when the abbreviation is empty", () => {
    expect(byFood("Knoblauch")).toMatchObject({ quantity: 2, unit: "Zehe" });
  });

  it("converts Austrian units into grams", () => {
    expect(byFood("Kürbiskerne")).toMatchObject({ quantity: 30, unit: "g", note: "geröstet" });
  });

  it("keeps a unit outside the vocabulary by its Mealie name", () => {
    expect(byFood("Croûtons")).toMatchObject({ quantity: 1, unit: "Handvoll" });
  });

  it("treats a zero quantity as no quantity", () => {
    expect(byFood("Salz")).toMatchObject({
      quantity: null,
      unit: "Prise",
      note: "nach Geschmack",
      optional: false,
      original: "Salz nach Geschmack",
    });
  });

  it("marks optional ingredients from the note", () => {
    expect(byFood("Koriander")).toMatchObject({ optional: true, note: "nach Belieben" });
  });

  it("carries section titles forward, ignoring empty titles", () => {
    expect(items.map((item) => item.section)).toEqual([
      ...Array<string>(7).fill("Für die Suppe"),
      ...Array<string>(4).fill("Zum Servieren"),
    ]);
  });

  it("uses the note as food when Mealie only matched a unit", () => {
    const [item] = normalizeIngredients(
      recipeWith({ quantity: 2, unit: { name: "Esslöffel", abbreviation: "EL" }, note: "Honig" }),
    );
    expect(item).toMatchObject({
      quantity: 2,
      unit: "EL",
      food: "Honig",
      note: "",
      source: "structured",
    });
  });

  it("finds the unit by its plural when name and abbreviation are unknown", () => {
    const [item] = normalizeIngredients(
      recipeWith({
        quantity: 3,
        unit: { name: "Stk", abbreviation: "x", pluralName: "Stück" },
        food: { name: "Eier" },
      }),
    );
    expect(item).toMatchObject({ quantity: 3, unit: "Stueck", food: "Eier" });
  });
});

describe("normalizeIngredients with free-text ingredients", () => {
  const items = normalizeIngredients(fixture("recipe-freetext-v3.25.json"));
  const byIndex = (index: number) => items.find((item) => item.index === index);

  it("parses amounts out of the note", () => {
    expect(byIndex(0)).toMatchObject({
      section: "Teig",
      quantity: 500,
      unit: "g",
      food: "Mehl",
      note: "Type 550",
      source: "parsed",
      original: "500 g Mehl (Type 550)",
    });
    expect(byIndex(6)).toMatchObject({ quantity: 80, unit: "g", food: "Butter" });
    expect(byIndex(11)).toMatchObject({ quantity: 3, quantityMax: 4, unit: "EL" });
  });

  it("keeps the gram weight of a piece", () => {
    expect(byIndex(1)).toMatchObject({
      quantity: 1,
      unit: "Wuerfel",
      food: "Hefe",
      weightGrams: 42,
    });
  });

  it("reads originalText when note and display are empty", () => {
    expect(byIndex(10)).toMatchObject({
      quantity: 2,
      unit: "EL",
      food: "Zimt",
      original: "2 EL Zimt",
    });
  });

  it("turns a header line into the next section and drops it", () => {
    expect(byIndex(8)).toBeUndefined();
    expect(byIndex(9)).toMatchObject({ section: "Für die Füllung", food: "Butter", note: "weich" });
  });

  it("starts a new section at the next title", () => {
    expect(byIndex(14)).toMatchObject({ section: "Zum Bestreichen", food: "Eigelb" });
  });

  it("keeps a line it cannot read as unparsed, with its full text", () => {
    expect(byIndex(12)).toMatchObject({
      quantity: null,
      quantityMax: null,
      unit: null,
      food: "50 g/ ¼ Tasse gehackte Haselnüsse",
      note: "",
      source: "unparsed",
      original: "50 g/ ¼ Tasse gehackte Haselnüsse",
    });
  });

  it("keeps qualifier-only lines without inventing a quantity", () => {
    expect(byIndex(7)).toMatchObject({ quantity: null, food: "Mehl Type 405", source: "parsed" });
    expect(byIndex(15)).toMatchObject({ quantity: null, food: "Milch", note: "etwas" });
    expect(byIndex(16)).toMatchObject({ quantity: null, optional: true, food: "Hagelzucker" });
  });
});

describe("normalizeIngredients choosing the text to parse", () => {
  it("prefers the display when only it carries the amount", () => {
    const [item] = normalizeIngredients(
      recipeWith({ quantity: 2, note: "Eier, verquirlt", display: "2 Eier, verquirlt" }),
    );
    expect(item).toMatchObject({ quantity: 2, food: "Eier", note: "verquirlt", source: "parsed" });
  });

  it("ignores a leftover default quantity in the display", () => {
    const [item] = normalizeIngredients(
      recipeWith({ quantity: 1, note: "500 g Mehl", display: "1 500 g Mehl" }),
    );
    expect(item).toMatchObject({
      quantity: 500,
      unit: "g",
      food: "Mehl",
      original: "1 500 g Mehl",
    });
  });

  it("prefers the original text over a shortened note", () => {
    const [item] = normalizeIngredients(
      recipeWith({
        quantity: 1,
        note: "fein gewürfelt",
        originalText: "1 Zwiebel, fein gewürfelt",
      }),
    );
    expect(item).toMatchObject({ quantity: 1, food: "Zwiebel", note: "fein gewürfelt" });
  });

  it("skips rows without any text", () => {
    expect(normalizeIngredients(recipeWith({ note: null, display: "  " }))).toEqual([]);
  });

  it("lets a header line replace a title on the same row", () => {
    const items = normalizeIngredients(
      recipeWith({ title: "Teig", note: "## Für den Belag" }, { note: "200 g Schinken" }),
    );
    expect(items).toEqual([
      expect.objectContaining({ section: "Für den Belag", food: "Schinken" }),
    ]);
  });

  it("keeps the section of a title when the header row has no title text", () => {
    const items = normalizeIngredients(
      recipeWith({ title: "Teig", note: "200 g Mehl" }, { note: "**:**" }, { note: "1 Ei" }),
    );
    expect(items.map((item) => item.section)).toEqual(["Teig", "Teig"]);
  });
});
