import { describe, expect, it } from "vitest";
import { dePack, enPack, KNOWLEDGE_DIR } from "../testing/locale.js";
import { createIngredientCatalog, loadIngredientCatalog } from "./catalog.js";
import { catalogMatchRules, createCatalogMatcher } from "./catalog-match.js";

const deCatalog = await loadIngredientCatalog(`${KNOWLEDGE_DIR}/locales/de-DE`);
const enCatalog = await loadIngredientCatalog(`${KNOWLEDGE_DIR}/locales/en-US`);
const de = createCatalogMatcher(deCatalog, catalogMatchRules(dePack));
const en = createCatalogMatcher(enCatalog, catalogMatchRules(enPack));

// The names the converter wrote in the first end-to-end run, which got no id.
describe("relaxedLookup with the de-DE pack", () => {
  it.each([
    ["Zwiebeln (rot)", "Zwiebeln, rot"],
    ["Knoblauchknollen", "Knoblauchknolle"],
    ["Rosmarin, getrocknet", "getrockneter Rosmarin"],
    ["Gemüsebrühe zum Verdünnen", "Gemüsebrühe"],
    ["Kokosmilch aus der Dose/Glas", "Kokosmilch"],
    ["Kokosmilch zum Garnieren", "Kokosmilch"],
    ["Ingwer, frisch", "Ingwer"],
    ["Zitronen, unbehandelt (optional)", "Zitronen, unbehandelt"],
    ["Eier, Größe L", "Eier (Größe L)"],
  ])("finds %s as %s", (name, expected) => {
    expect(de.relaxedLookup(name)?.name).toBe(expected);
  });

  it.each([
    // A spelling variant is a suggestion for the model, never an id.
    "Butternusskürbis",
    // Short words keep their endings: "Butt" is not "Butter", "Eis" is not "Ei".
    "Butt",
    "Eis zum Servieren",
    // Numbers must match: another flour type is another product.
    "Mehl, Type 1050",
    "Chiliöl oder Chili-Crisp zum Garnieren",
    "Sauerteigbrot zum Servieren",
  ])("gives no id for %s", (name) => {
    expect(de.relaxedLookup(name)).toBeNull();
  });

  it("returns the id of the entry it found", () => {
    expect(de.relaxedLookup("Zwiebeln (rot)")).toEqual({
      name: "Zwiebeln, rot",
      systemIngredientId: deCatalog.byName.get("zwiebeln, rot"),
    });
  });
});

describe("relaxedLookup with the en-US pack", () => {
  it.each([
    ["onions (red)", "onions, red"],
    ["ginger, fresh", "ginger"],
    ["parsley for garnish", "parsley"],
  ])("finds %s as %s", (name, expected) => {
    expect(en.relaxedLookup(name)?.name).toBe(expected);
  });
});

describe("suggest", () => {
  it("offers the catalog spelling of a variant", () => {
    expect(de.suggest("Butternusskürbis")).toEqual(["Butternutkürbis"]);
  });

  it("ranks names with the same qualifiers first", () => {
    expect(de.suggest("Zwiebeln (rot)")[0]).toBe("Zwiebeln, rot");
    expect(de.suggest("Rosmarin, getrocknet")).toContain("getrockneter Rosmarin");
  });

  it("matches on the food, not on a usage or buying note", () => {
    expect(de.suggest("Kokosmilch aus der Dose/Glas")[0]).toBe("Kokosmilch");
    expect(de.suggest("Gemüsebrühe zum Verdünnen")[0]).toBe("Gemüsebrühe");
  });

  it("returns at most the limit, and nothing for qualifiers alone or a zero limit", () => {
    expect(de.suggest("Zwiebeln")).toHaveLength(3);
    expect(de.suggest("Zwiebeln", 1)).toHaveLength(1);
    expect(de.suggest("Zwiebeln", 0)).toEqual([]);
    expect(de.suggest("frisch")).toEqual([]);
    expect(de.suggest("")).toEqual([]);
  });

  it("does not offer a product that only shares the start of the word", () => {
    expect(de.suggest("Butternusskürbis")).not.toContain("Butter");
    expect(de.suggest("Sauerteigbrot")).toEqual([]);
  });

  it("puts names with an amount behind the plain name", () => {
    const names = en.suggest("onions (red)");
    expect(names[0]).toBe("onions, red");
    expect(names.indexOf("onions")).toBeGreaterThan(-1);
  });

  it("still suggests without qualifier suffixes, but strips nothing for an id", () => {
    const catalog = createIngredientCatalog({
      generatedFrom: "test",
      entries: [
        {
          name: "Ingwer",
          systemIngredientId: 1,
          officialRecipes: 1,
          memberRecipes: 0,
          category: null,
          alternatives: [],
        },
      ],
    });
    const bare = createCatalogMatcher(catalog, {
      stopwords: ["frisch"],
      stemEndings: [],
      qualifierSuffixes: [],
    });
    expect(bare.suggest("Ingwer, frisch")).toEqual(["Ingwer"]);
    expect(bare.relaxedLookup("Ingwer, frisch")).toBeNull();
  });
});
