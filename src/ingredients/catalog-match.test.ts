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
    // The fresh form has entries of its own, so it is never stripped to the base name.
    ["Ingwer, frisch", "frischer Ingwer"],
    ["Hefe frisch", "Hefe, frisch"],
    ["Zwiebeln (rot, gewürfelt)", "Zwiebeln, rot"],
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
    // A parenthesis that names another product stays: oat milk is not milk.
    "Milch (Hafer)",
    "Sahne (Kokos)",
    "Butter (vegan)",
    "Hackfleisch (vegan)",
    "Mehl (Dinkel)",
    // Canned tomatoes have entries of their own; fresh tomatoes are another product.
    "Tomaten aus der Dose",
    "Tomaten, aus der Dose",
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
    ["onions (red, diced)", "onions, red"],
    // No catalog entry has fresh ginger, so the buying form goes.
    ["ginger, fresh", "ginger"],
  ])("finds %s as %s", (name, expected) => {
    expect(en.relaxedLookup(name)?.name).toBe(expected);
  });
});

describe("relaxedLookup with the en-US pack, negatives", () => {
  it.each(["butter (vegan)", "tomatoes (canned)", "tomatoes from a tin"])(
    "gives no id for %s",
    (name) => {
      expect(en.relaxedLookup(name)).toBeNull();
    },
  );
});

const entry = (name: string, systemIngredientId: number, officialRecipes = 1) => ({
  name,
  systemIngredientId,
  officialRecipes,
  memberRecipes: 0,
  category: null,
  alternatives: [],
});
const synthetic = (names: string[]) =>
  createCatalogMatcher(
    createIngredientCatalog({
      generatedFrom: "test",
      entries: names.map((name, index) => entry(name, index + 1)),
    }),
    catalogMatchRules(dePack),
  );

describe("relaxedLookup on a small catalog", () => {
  it("prefers the specific entry over the generic one", () => {
    const m = synthetic(["Zwiebeln", "Zwiebeln, rote"]);
    expect(m.relaxedLookup("Zwiebeln (rot)")?.name).toBe("Zwiebeln, rote");
    expect(m.relaxedLookup("rote Zwiebeln")?.name).toBe("Zwiebeln, rote");
    expect(m.relaxedLookup("Zwiebeln (gewürfelt)")?.name).toBe("Zwiebeln");
  });

  it("folds qualifier words of any length", () => {
    const m = synthetic(["Paprika", "gelbe Paprika", "Zwiebeln, rot"]);
    expect(m.relaxedLookup("Paprika (gelb)")?.name).toBe("gelbe Paprika");
    expect(m.relaxedLookup("Paprika, gelb")?.name).toBe("gelbe Paprika");
    expect(m.relaxedLookup("Zwiebeln, rote")?.name).toBe("Zwiebeln, rot");
    expect(m.relaxedLookup("rote Zwiebeln")?.name).toBe("Zwiebeln, rot");
  });

  it("keeps a content word in a parenthesis and drops only the qualifiers", () => {
    const m = synthetic(["Milch", "Zwiebeln", "Zwiebeln, rot"]);
    expect(m.relaxedLookup("Milch (Hafer)")).toBeNull();
    expect(m.relaxedLookup("Zwiebeln (rot, gewürfelt)")?.name).toBe("Zwiebeln, rot");
    expect(m.relaxedLookup("Milch (frisch)")?.name).toBe("Milch");
    expect(m.relaxedLookup("Milch (optional)")?.name).toBe("Milch");
  });

  it("removes a buying form only when the catalog has no entry in that form", () => {
    expect(synthetic(["Tomaten"]).relaxedLookup("Tomaten aus der Dose")?.name).toBe("Tomaten");
    expect(
      synthetic(["Tomaten", "Tomaten, stückig aus der Dose"]).relaxedLookup("Tomaten aus der Dose"),
    ).toBeNull();
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

  it("ranks the forms official recipes use first", () => {
    expect(de.suggest("Ei")[0]).toBe("Eier (Größe M)");
    expect(de.suggest("Ei")).not.toContain("Ei-Ersatz-Pulver");
    expect(de.suggest("rote Zwiebel")[0]).toBe("Zwiebeln, rot");
    expect(en.suggest("eggs")[0]).toBe("eggs (medium)");
  });

  it("looks up the catalog word for a regional name", () => {
    expect(de.suggest("Karotten")[0]).toBe("Möhren");
  });

  it("offers nothing when only one of two words matches", () => {
    expect(de.suggest("olive oil")).toEqual([]);
    expect(de.suggest("Butter (vegan)")).toEqual([]);
  });

  it("puts names with an amount or another number behind the others", () => {
    expect(de.suggest("Salz").indexOf("½ Tl Salz")).not.toBe(0);
    expect(de.suggest("Mehl (Type 550)")[0]).toBe("Mehl (Type 550)");
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
