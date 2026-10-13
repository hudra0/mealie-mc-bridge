import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingredientCatalogSchema } from "../../src/ingredients/catalog.js";
import {
  CATALOG_GENERATED_FROM,
  buildIngredientCatalog,
  readCatalogSource,
} from "./build-ingredient-catalog.js";

// Three invented recipes: two official, one member.
const fixture = path.join(import.meta.dirname, "..", "..", "test", "fixtures", "corpus");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function corpusWith(parts: ("details" | "derived")[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-catalog-test-"));
  temps.push(dir);
  for (const part of parts)
    cpSync(path.join(fixture, part), path.join(dir, part), { recursive: true });
  return dir;
}

const expectedEntries = [
  {
    name: "Testzutat A",
    systemIngredientId: 9001,
    officialRecipes: 2,
    memberRecipes: 0,
    category: "Testkategorie",
    alternatives: [{ systemIngredientId: 9005, officialRecipes: 0, memberRecipes: 1 }],
  },
  {
    name: "Testzutat B",
    systemIngredientId: 9003,
    officialRecipes: 1,
    memberRecipes: 1,
    category: null,
    alternatives: [{ systemIngredientId: 9002, officialRecipes: 1, memberRecipes: 0 }],
  },
  {
    name: "Testzutat D (Sorte 1)",
    systemIngredientId: 9004,
    officialRecipes: 1,
    memberRecipes: 0,
    category: null,
    alternatives: [],
  },
];

describe("buildIngredientCatalog from the synthetic corpus", () => {
  it("reads recipes.jsonl, takes categories from details and groups names", () => {
    const source = readCatalogSource(fixture);
    expect(source?.from).toBe("recipes.jsonl");
    const catalog = buildIngredientCatalog(source!.recipes, source!.categories);
    expect(catalog.generatedFrom).toBe(CATALOG_GENERATED_FROM);
    expect(catalog.entries).toEqual(expectedEntries);
    expect(ingredientCatalogSchema.parse(catalog)).toEqual(catalog);
  });

  it("falls back to the detail files when recipes.jsonl is missing", () => {
    const source = readCatalogSource(corpusWith(["details"]));
    expect(source?.from).toBe("details");
    expect(buildIngredientCatalog(source!.recipes, source!.categories).entries).toEqual(
      expectedEntries,
    );
  });

  it("leaves categories null without the detail files", () => {
    const source = readCatalogSource(corpusWith(["derived"]));
    const entries = buildIngredientCatalog(source!.recipes, source!.categories).entries;
    expect(entries.map((entry) => entry.category)).toEqual([null, null, null]);
  });

  it("returns null when the corpus has neither input", () => {
    expect(readCatalogSource(corpusWith([]))).toBeNull();
  });

  it("keeps names, ids and counts only", () => {
    const source = readCatalogSource(fixture)!;
    const text = JSON.stringify(buildIngredientCatalog(source.recipes, source.categories));
    expect(text).not.toContain("Testrezept");
    expect(text).not.toContain("Testzutat C");
    expect(text).not.toContain("Testzutat E");
    expect(text).not.toContain('"amount"');
  });
});

describe("buildIngredientCatalog rules", () => {
  const official = (...ingredients: [string, number | null][]) => ({
    source: "official",
    ingredients: ingredients.map(([name, systemIngredientId]) => ({ name, systemIngredientId })),
  });
  const member = (...ingredients: [string, number | null][]) => ({
    ...official(...ingredients),
    source: "member",
  });

  it("weighs an official recipe three times a member recipe for the primary id", () => {
    const three = [member(["X", 2]), member(["X", 2]), member(["X", 2])];
    expect(buildIngredientCatalog([official(["X", 1]), ...three]).entries[0]).toMatchObject({
      systemIngredientId: 1,
      alternatives: [{ systemIngredientId: 2, memberRecipes: 3 }],
    });
    const four = [...three, member(["X", 2])];
    expect(buildIngredientCatalog([official(["X", 1]), ...four]).entries[0]).toMatchObject({
      systemIngredientId: 2,
      alternatives: [{ systemIngredientId: 1, officialRecipes: 1 }],
    });
  });

  it("breaks a tie by official count, then by the lower id", () => {
    // Both weigh 3: one official recipe against three member recipes.
    const tie = buildIngredientCatalog([
      member(["X", 5]),
      member(["X", 5]),
      member(["X", 5]),
      official(["X", 7]),
    ]);
    expect(tie.entries[0]?.systemIngredientId).toBe(7);
    const even = buildIngredientCatalog([official(["X", 8]), official(["X", 6])]);
    expect(even.entries[0]?.systemIngredientId).toBe(6);
  });

  it("takes the most used spelling as the entry name", () => {
    const catalog = buildIngredientCatalog([
      official(["Testzutat F", 1]),
      official(["testzutat f", 1]),
      official(["testzutat f", 1]),
    ]);
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["testzutat f"]);
  });

  it("sorts by official count, then by name", () => {
    const catalog = buildIngredientCatalog([
      official(["Zeta", 1], ["Beta", 2]),
      official(["Alpha", 3], ["Beta", 2]),
      member(["Gamma", 4]),
    ]);
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["Beta", "Alpha", "Zeta", "Gamma"]);
  });

  it("skips names without a positive id and empty names", () => {
    const catalog = buildIngredientCatalog([
      official(["A", -1], ["B", null], ["C", 0], ["  ", 5], ["D", 1.5]),
      { source: null, ingredients: [{ name: null, systemIngredientId: 3 }] },
    ]);
    expect(catalog.entries).toEqual([]);
  });
});
