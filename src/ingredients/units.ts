// Unit vocabulary for ingredient lines. Every unit the bridge understands, its aliases and
// its conversion factor live in this one table, so the parser, the normalizer and the
// scaler agree on what a unit is.

export const UNIT_CODES = [
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
] as const;

export type UnitCode = (typeof UNIT_CODES)[number];

// How a unit behaves when a recipe is scaled.
// metric: g and ml. metricLarge: kg and l. spoon: EL, TL, tbsp, tsp.
// pinch: amounts that do not scale linearly. cup: cups. ounce and pound: US weights.
// count: everything that is counted in whole or half pieces.
export type UnitKind =
  "metric" | "metricLarge" | "spoon" | "pinch" | "cup" | "ounce" | "pound" | "count";

interface UnitDefinition {
  kind: UnitKind;
  // Lower-case spellings without a trailing dot, singular and plural.
  aliases: readonly string[];
}

export const UNITS: Readonly<Record<UnitCode, UnitDefinition>> = {
  g: { kind: "metric", aliases: ["g", "gr", "gramm", "gram", "grams", "gramme", "grammes"] },
  kg: {
    kind: "metricLarge",
    aliases: ["kg", "kilo", "kilos", "kilogramm", "kilogram", "kilograms", "kilogramme"],
  },
  ml: {
    kind: "metric",
    aliases: ["ml", "milliliter", "millilitre", "milliliters", "millilitres"],
  },
  l: { kind: "metricLarge", aliases: ["l", "liter", "litre", "liters", "litres", "ltr"] },
  EL: { kind: "spoon", aliases: ["el", "esslöffel", "eßlöffel", "essl", "esslöffeln"] },
  TL: { kind: "spoon", aliases: ["tl", "teelöffel", "teel", "teelöffeln"] },
  Msp: { kind: "pinch", aliases: ["msp", "messerspitze", "messerspitzen"] },
  Prise: { kind: "pinch", aliases: ["prise", "prisen"] },
  Spritzer: { kind: "count", aliases: ["spritzer"] },
  Tropfen: { kind: "count", aliases: ["tropfen"] },
  Schuss: { kind: "count", aliases: ["schuss", "schüsse"] },
  Stueck: { kind: "count", aliases: ["stück", "stücke", "stk", "st", "stck"] },
  Zehe: { kind: "count", aliases: ["zehe", "zehen"] },
  Scheibe: { kind: "count", aliases: ["scheibe", "scheiben"] },
  Blatt: { kind: "count", aliases: ["blatt", "blätter"] },
  Bund: { kind: "count", aliases: ["bund", "bunde", "bünde", "bd", "bunch", "bunches"] },
  Stange: { kind: "count", aliases: ["stange", "stangen"] },
  Kopf: { kind: "count", aliases: ["kopf", "köpfe", "head", "heads"] },
  Knolle: { kind: "count", aliases: ["knolle", "knollen"] },
  Dose: { kind: "count", aliases: ["dose", "dosen"] },
  Glas: { kind: "count", aliases: ["glas", "gläser", "jar", "jars"] },
  Packung: {
    kind: "count",
    aliases: [
      "packung",
      "packungen",
      "pkg",
      "pck",
      "pkt",
      "päckchen",
      "packerl",
      "package",
      "packages",
      "packet",
      "packets",
    ],
  },
  Becher: { kind: "count", aliases: ["becher"] },
  Tasse: { kind: "cup", aliases: ["tasse", "tassen"] },
  Wuerfel: { kind: "count", aliases: ["würfel"] },
  Tuete: { kind: "count", aliases: ["tüte", "tüten"] },
  Beutel: { kind: "count", aliases: ["beutel"] },
  Flasche: { kind: "count", aliases: ["flasche", "flaschen", "bottle", "bottles"] },
  cup: { kind: "cup", aliases: ["cup", "cups"] },
  tbsp: {
    kind: "spoon",
    aliases: ["tbsp", "tbsps", "tbs", "tbl", "tblsp", "tablespoon", "tablespoons"],
  },
  tsp: { kind: "spoon", aliases: ["tsp", "tsps", "teaspoon", "teaspoons"] },
  oz: { kind: "ounce", aliases: ["oz", "ozs", "ounce", "ounces"] },
  lb: { kind: "pound", aliases: ["lb", "lbs", "pound", "pounds"] },
  pinch: { kind: "pinch", aliases: ["pinch", "pinches"] },
  can: { kind: "count", aliases: ["can", "cans", "tin", "tins"] },
  clove: { kind: "count", aliases: ["clove", "cloves"] },
  slice: { kind: "count", aliases: ["slice", "slices"] },
};

// Units that map onto another code with a factor. The quantity is multiplied and the
// original unit is not kept: 5 dag become 50 g.
export const UNIT_CONVERSIONS: Readonly<Record<string, { code: UnitCode; factor: number }>> = {
  dag: { code: "g", factor: 10 },
  dkg: { code: "g", factor: 10 },
  deka: { code: "g", factor: 10 },
  dekagramm: { code: "g", factor: 10 },
  cl: { code: "ml", factor: 10 },
  centiliter: { code: "ml", factor: 10 },
  zentiliter: { code: "ml", factor: 10 },
  dl: { code: "ml", factor: 100 },
  deziliter: { code: "ml", factor: 100 },
};

// Units that state a weight or a volume. Only these can describe a container size
// such as "400 g" in "2x 400 g Dosen" or "1,5 l" in "1,5 l-Flasche".
export const SIZE_UNIT_CODES: ReadonlySet<UnitCode> = new Set(["g", "kg", "ml", "l", "oz", "lb"]);

// Containers and pieces that carry a size, as in "400-g-Dose".
export const CONTAINER_UNIT_CODES: ReadonlySet<UnitCode> = new Set([
  "Dose",
  "Glas",
  "Packung",
  "Becher",
  "Beutel",
  "Flasche",
  "Tuete",
  "Wuerfel",
  "can",
]);

export interface UnitMatch {
  code: UnitCode;
  factor: number;
}

// German umlauts are often typed as ae, oe, ue and ss. Both spellings match.
function asciiFold(text: string): string {
  return text.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

function buildLookup(): Map<string, UnitMatch> {
  const lookup = new Map<string, UnitMatch>();
  const add = (alias: string, match: UnitMatch): void => {
    for (const spelling of new Set([alias, asciiFold(alias)])) {
      const existing = lookup.get(spelling);
      if (existing && existing.code !== match.code) {
        throw new Error(`Unit alias "${spelling}" maps to ${existing.code} and ${match.code}`);
      }
      lookup.set(spelling, match);
    }
  };
  for (const code of UNIT_CODES) {
    add(code.toLowerCase(), { code, factor: 1 });
    for (const alias of UNITS[code].aliases) add(alias, { code, factor: 1 });
  }
  for (const [alias, conversion] of Object.entries(UNIT_CONVERSIONS)) add(alias, conversion);
  return lookup;
}

const lookup = buildLookup();

// Maps a unit word to its code, or null when the word is not a known unit. Case, a
// trailing dot and the plural forms listed above are ignored.
export function normalizeUnit(word: string | null | undefined): UnitMatch | null {
  if (!word) return null;
  const key = word.normalize("NFC").trim().replace(/\.$/, "").toLowerCase();
  if (key === "") return null;
  return lookup.get(key) ?? null;
}

export function unitKind(code: string | null): UnitKind {
  if (code === null) return "count";
  return isUnitCode(code) ? UNITS[code].kind : "count";
}

export function isUnitCode(value: string): value is UnitCode {
  return (UNIT_CODES as readonly string[]).includes(value);
}
