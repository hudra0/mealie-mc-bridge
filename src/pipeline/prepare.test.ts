import { describe, expect, it } from "vitest";
import type { NormalizedIngredient } from "../ingredients/index.js";
import { catalogNameHints } from "./prepare.js";

const line = (index: number, food: string): NormalizedIngredient => ({
  index,
  section: null,
  quantity: null,
  quantityMax: null,
  unit: null,
  food,
  note: "",
  optional: false,
  source: "structured",
  original: food,
  referenceId: null,
});

const known = new Set(["Salz", "Mehl"]);
const resolver = {
  suggest: (names: readonly string[]) => names.map((name) => [`${name} (catalog)`]),
  knows: (name: string) => known.has(name),
};

describe("catalogNameHints", () => {
  it("offers near names when the catalog knows enough of the source lines", () => {
    const lines = [line(0, "Salz"), line(1, "Mehl"), line(2, "Butternusskürbis")];
    expect(catalogNameHints(lines, resolver)).toEqual([
      { index: 0, names: ["Salz (catalog)"] },
      { index: 1, names: ["Mehl (catalog)"] },
      { index: 2, names: ["Butternusskürbis (catalog)"] },
    ]);
  });

  it("offers nothing for a recipe in another language than the catalog", () => {
    const english = [line(0, "olive oil"), line(1, "salt"), line(2, "red onion")];
    expect(catalogNameHints(english, resolver)).toEqual([]);
    // One known line out of six is below MIN_KNOWN_SHARE.
    const mostlyEnglish = [...english, line(3, "Salz"), line(4, "pasta"), line(5, "lemon")];
    expect(catalogNameHints(mostlyEnglish, resolver)).toEqual([]);
  });

  it("offers every line without a language check when the resolver cannot tell", () => {
    const english = [line(0, "olive oil")];
    expect(catalogNameHints(english, { suggest: resolver.suggest })).toHaveLength(1);
    expect(catalogNameHints(english, undefined)).toEqual([]);
  });
});
