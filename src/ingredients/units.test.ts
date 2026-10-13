import { describe, expect, it } from "vitest";
import {
  CONTAINER_UNIT_CODES,
  SIZE_UNIT_CODES,
  UNITS,
  UNIT_CODES,
  UNIT_CONVERSIONS,
  isUnitCode,
  normalizeUnit,
  unitKind,
} from "./units.js";

// The unit codes from test/fixtures/ingredients/SPEC.md, in the order listed there.
const SPEC_CODES = [
  "g",
  "kg",
  "ml",
  "l",
  "EL",
  "TL",
  "Msp",
  "Prise",
  "Spritzer",
  "Tropfen",
  "Schuss",
  "Stueck",
  "Zehe",
  "Scheibe",
  "Blatt",
  "Bund",
  "Stange",
  "Kopf",
  "Knolle",
  "Dose",
  "Glas",
  "Packung",
  "Becher",
  "Tasse",
  "Wuerfel",
  "Tuete",
  "Beutel",
  "Flasche",
  "cup",
  "tbsp",
  "tsp",
  "oz",
  "lb",
  "pinch",
  "can",
  "clove",
  "slice",
];

describe("unit vocabulary", () => {
  it("has exactly the codes from the spec", () => {
    expect([...UNIT_CODES]).toEqual(SPEC_CODES);
    expect(Object.keys(UNITS).sort()).toEqual([...SPEC_CODES].sort());
  });

  it.each(SPEC_CODES)("maps the code %s to itself in any case and with a dot", (code) => {
    expect(normalizeUnit(code)).toEqual({ code, factor: 1 });
    expect(normalizeUnit(code.toUpperCase())?.code).toBe(code);
    expect(normalizeUnit(`${code.toLowerCase()}.`)?.code).toBe(code);
  });

  it("maps every alias back to its own code", () => {
    for (const code of UNIT_CODES) {
      for (const alias of UNITS[code].aliases) expect(normalizeUnit(alias)?.code, alias).toBe(code);
    }
  });

  it.each([
    ["Gramm", "g"],
    ["gr", "g"],
    ["Kilo", "kg"],
    ["Milliliter", "ml"],
    ["Liter", "l"],
    ["Esslöffel", "EL"],
    ["Essl.", "EL"],
    ["Teelöffel", "TL"],
    ["Msp.", "Msp"],
    ["Messerspitze", "Msp"],
    ["Prisen", "Prise"],
    ["Stück", "Stueck"],
    ["Stk.", "Stueck"],
    ["St.", "Stueck"],
    ["Zehen", "Zehe"],
    ["Scheiben", "Scheibe"],
    ["Blätter", "Blatt"],
    ["Gläser", "Glas"],
    ["Pkg.", "Packung"],
    ["Päckchen", "Packung"],
    ["Pck.", "Packung"],
    ["Würfel", "Wuerfel"],
    ["Tüte", "Tuete"],
    ["Tassen", "Tasse"],
    ["Dosen", "Dose"],
    ["Flaschen", "Flasche"],
    ["tablespoon", "tbsp"],
    ["Tbsp", "tbsp"],
    ["TBSP", "tbsp"],
    ["tbsp.", "tbsp"],
    ["teaspoons", "tsp"],
    ["cups", "cup"],
    ["ounces", "oz"],
    ["lbs", "lb"],
    ["lb.", "lb"],
    ["pinches", "pinch"],
    ["cans", "can"],
    ["cloves", "clove"],
    ["slices", "slice"],
    ["bunch", "Bund"],
    ["head", "Kopf"],
    ["jar", "Glas"],
    ["bottle", "Flasche"],
    ["package", "Packung"],
  ])("maps %j to %s", (word, code) => {
    expect(normalizeUnit(word)).toEqual({ code, factor: 1 });
  });

  it("matches umlauts typed as ae, oe, ue and ss", () => {
    expect(normalizeUnit("Stueck")?.code).toBe("Stueck");
    expect(normalizeUnit("Essloeffel")?.code).toBe("EL");
    expect(normalizeUnit("Glaeser")?.code).toBe("Glas");
    expect(normalizeUnit("Tueten")?.code).toBe("Tuete");
  });

  it("ignores surrounding whitespace and decomposed umlauts", () => {
    expect(normalizeUnit("  EL  ")?.code).toBe("EL");
    expect(normalizeUnit("Stück")?.code).toBe("Stueck");
  });

  it.each([
    ["dag", "g", 10],
    ["dkg", "g", 10],
    ["Deka", "g", 10],
    ["Dekagramm", "g", 10],
    ["cl", "ml", 10],
    ["dl", "ml", 100],
  ])("converts %s to %s with factor %i", (word, code, factor) => {
    expect(normalizeUnit(word)).toEqual({ code, factor });
  });

  it("keeps kg and l as their own codes", () => {
    expect(normalizeUnit("kg")).toEqual({ code: "kg", factor: 1 });
    expect(normalizeUnit("l")).toEqual({ code: "l", factor: 1 });
  });

  it("converts only into codes of the vocabulary", () => {
    for (const conversion of Object.values(UNIT_CONVERSIONS)) {
      expect(isUnitCode(conversion.code)).toBe(true);
    }
  });

  it.each(["Handvoll", "Zweige", "Stiele", "sticks", "sprigs", "handful", "Mehl", "", "."])(
    "does not treat %j as a unit",
    (word) => {
      expect(normalizeUnit(word)).toBeNull();
    },
  );

  it("returns null for a missing word", () => {
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
  });
});

describe("unit kinds", () => {
  it.each([
    ["g", "metric"],
    ["ml", "metric"],
    ["kg", "metricLarge"],
    ["l", "metricLarge"],
    ["EL", "spoon"],
    ["TL", "spoon"],
    ["tbsp", "spoon"],
    ["tsp", "spoon"],
    ["Prise", "pinch"],
    ["Msp", "pinch"],
    ["pinch", "pinch"],
    ["cup", "cup"],
    ["Tasse", "cup"],
    ["oz", "ounce"],
    ["lb", "pound"],
    ["Stueck", "count"],
    ["Zehe", "count"],
    ["Dose", "count"],
    ["can", "count"],
  ])("treats %s as %s", (code, kind) => {
    expect(unitKind(code)).toBe(kind);
  });

  it("counts lines without a unit and units outside the vocabulary", () => {
    expect(unitKind(null)).toBe("count");
    expect(unitKind("Handvoll")).toBe("count");
  });

  it("knows which units state a size and which are containers", () => {
    expect([...SIZE_UNIT_CODES].sort()).toEqual(["g", "kg", "l", "lb", "ml", "oz"]);
    for (const code of CONTAINER_UNIT_CODES) expect(unitKind(code)).toBe("count");
  });

  it("recognizes unit codes", () => {
    expect(isUnitCode("Stueck")).toBe(true);
    expect(isUnitCode("Stück")).toBe(false);
  });
});
