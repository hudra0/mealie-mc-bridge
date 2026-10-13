import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanIngredientText, isHeaderLine, numberValue, parseIngredientLine } from "./parse.js";
import type { ParsedIngredient } from "./parse.js";

interface FixtureLine {
  id: string;
  lang: "de" | "en";
  input: string;
  expected: {
    quantity: number | null;
    quantityMax: number | null;
    unit: string | null;
    food: string;
    note: string;
    optional: boolean;
    parsed: boolean;
    weightGrams?: number;
  };
  tags: string[];
}

const fixtureFile = new URL(
  "../../test/fixtures/ingredients/ingredient-lines.jsonl",
  import.meta.url,
);
const fixtures: FixtureLine[] = readFileSync(fixtureFile, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as FixtureLine);

const sameNumber = (a: number | null, b: number | null | undefined): boolean =>
  a === null || b === null || b === undefined ? a === (b ?? null) : Math.abs(a - b) <= 0.001;
const foodKey = (food: string): string => food.trim().replace(/\s+/g, " ").toLowerCase();

// The acceptance rule from SPEC.md: quantity, quantityMax, unit and food must all match.
function passes(line: FixtureLine, got: ParsedIngredient): boolean {
  const want = line.expected;
  if (!want.parsed) return !got.parsed;
  return (
    got.parsed &&
    sameNumber(want.quantity, got.quantity) &&
    sameNumber(want.quantityMax, got.quantityMax) &&
    want.unit === got.unit &&
    foodKey(want.food) === foodKey(got.food)
  );
}

function noteRecall(expected: string, got: string): number | null {
  const words = expected.toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
  if (words.length === 0) return null;
  const have = new Set(got.toLowerCase().match(/[\p{L}\d]+/gu) ?? []);
  return words.filter((word) => have.has(word)).length / words.length;
}

describe("ingredient fixture gate", () => {
  const results = fixtures.map((line) => ({ line, got: parseIngredientLine(line.input) }));
  const failures = results.filter(({ line, got }) => !passes(line, got));
  const nullLines = results.filter(({ line }) => line.expected.quantity === null);
  const phantoms = nullLines.filter(({ got }) => got.quantity !== null);
  const failureReport = failures
    .map(
      ({ line, got }) =>
        `FAIL ${line.id} ${JSON.stringify(line.input)}\n  want ${JSON.stringify(pick(line.expected))}\n  got  ${JSON.stringify(pick(got))}`,
    )
    .join("\n");

  it("prints a report", () => {
    const weighted = results.filter(({ line }) => line.expected.weightGrams !== undefined);
    const weightHits = weighted.filter(({ line, got }) =>
      sameNumber(line.expected.weightGrams ?? null, got.weightGrams),
    );
    const extraWeights = results.filter(
      ({ line, got }) => line.expected.weightGrams === undefined && got.weightGrams !== undefined,
    );
    const optionalHits = results.filter(({ line, got }) => line.expected.optional === got.optional);
    const parsedHits = results.filter(({ line, got }) => line.expected.parsed === got.parsed);
    const recalls = results
      .map(({ line, got }) => noteRecall(line.expected.note, got.note))
      .filter((value): value is number => value !== null);
    const recall = recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
    const pct = (part: number, whole: number): string => `${((100 * part) / whole).toFixed(1)} %`;

    const report = [
      `Gate 1 (exact match): ${results.length - failures.length}/${results.length} = ${pct(results.length - failures.length, results.length)}, needs >= 95 %`,
      `Gate 2 (phantom quantities): ${phantoms.length} on ${nullLines.length} lines with null quantity, needs 0`,
      `optional accuracy: ${pct(optionalHits.length, results.length)}`,
      `weightGrams: ${weightHits.length}/${weighted.length} correct, ${extraWeights.length} unexpected`,
      `parsed accuracy: ${pct(parsedHits.length, results.length)}`,
      `note recall: ${(100 * recall).toFixed(1)} %`,
      failureReport,
    ];
    console.info(report.filter(Boolean).join("\n"));
    expect(results).toHaveLength(260);
  });

  it("passes gate 1: at least 95 % of the lines match exactly", () => {
    const rate = (results.length - failures.length) / results.length;
    expect(rate, `failing lines:\n${failureReport}`).toBeGreaterThanOrEqual(0.95);
  });

  it("passes gate 2: no phantom quantities", () => {
    expect(nullLines).toHaveLength(28);
    expect(
      phantoms.map(
        ({ line, got }) => `${line.id} ${JSON.stringify(line.input)} -> ${got.quantity}`,
      ),
    ).toEqual([]);
  });

  it("gives the same answers when the language is known", () => {
    const differing = fixtures.filter((line) => {
      const auto = parseIngredientLine(line.input);
      const withLang = parseIngredientLine(line.input, { lang: line.lang });
      return JSON.stringify(auto) !== JSON.stringify(withLang);
    });
    expect(differing.map((line) => line.id)).toEqual([]);
  });
});

function pick(value: Omit<FixtureLine["expected"], "optional">) {
  return {
    quantity: value.quantity,
    quantityMax: value.quantityMax,
    unit: value.unit,
    food: value.food,
    note: value.note,
    parsed: value.parsed,
  };
}

describe("parseIngredientLine", () => {
  const parse = (text: string) => parseIngredientLine(text);

  it("reads metric amounts with decimal comma and point", () => {
    expect(parse("0,5 l Milch")).toMatchObject({ quantity: 0.5, unit: "l", food: "Milch" });
    expect(parse("1.5 kg Kartoffeln")).toMatchObject({ quantity: 1.5, unit: "kg" });
  });

  it("reads unicode, text and mixed fractions", () => {
    expect(parse("½ TL Salz").quantity).toBe(0.5);
    expect(parse("⅔ cup sugar").quantity).toBe(0.667);
    expect(parse("1 1/2 EL Honig").quantity).toBe(1.5);
    expect(parse("1½ TL Zimt").quantity).toBe(1.5);
    expect(parse("2 ½ EL Butter").quantity).toBe(2.5);
    expect(parse("1/0 TL Salz").quantity).toBeNull();
  });

  it("reads Mealie display fractions written with super- and subscript digits", () => {
    expect(parse("¹/₂ TL Salz")).toMatchObject({ quantity: 0.5, unit: "TL", food: "Salz" });
  });

  it("reads ranges with dash, en dash and words", () => {
    expect(parse("2-3 EL Öl")).toMatchObject({ quantity: 2, quantityMax: 3, unit: "EL" });
    expect(parse("2 bis 3 Zwiebeln")).toMatchObject({ quantity: 2, quantityMax: 3, unit: null });
    expect(parse("1 to 1 1/2 cups water")).toMatchObject({ quantity: 1, quantityMax: 1.5 });
    expect(parse("100 g bis 150 g Zucker")).toMatchObject({ quantity: 100, quantityMax: 150 });
    expect(parse("2 oder 3 Eier")).toMatchObject({ quantity: 2, quantityMax: 3, food: "Eier" });
  });

  it("drops an upper bound that is not above the lower bound", () => {
    expect(parse("3-2 EL Öl")).toMatchObject({ quantity: 3, quantityMax: null });
  });

  it("converts dag, dkg, Deka, cl and dl", () => {
    expect(parse("10-15 dag Schinken")).toMatchObject({
      quantity: 100,
      quantityMax: 150,
      unit: "g",
    });
    expect(parse("4 cl Rum")).toMatchObject({ quantity: 40, unit: "ml" });
    expect(parse("2 dl Sahne")).toMatchObject({ quantity: 200, unit: "ml" });
  });

  it("keeps approximation words in the note", () => {
    expect(parse("ca. 500 g Mehl")).toMatchObject({ quantity: 500, food: "Mehl", note: "ca." });
    expect(parse("about 2 cups broth")).toMatchObject({ quantity: 2, note: "about" });
  });

  it("never invents a quantity for vague amounts", () => {
    expect(parse("ein paar Tropfen Zitronensaft")).toMatchObject({
      quantity: null,
      unit: "Tropfen",
      food: "Zitronensaft",
    });
    expect(parse("etwas Salz")).toMatchObject({ quantity: null, unit: null, food: "Salz" });
    expect(parse("a few sprigs thyme")).toMatchObject({ quantity: null, food: "sprigs thyme" });
  });

  it("keeps a unit that has no number, without inventing a quantity", () => {
    expect(parse("Prise Salz")).toMatchObject({ quantity: null, unit: "Prise", food: "Salz" });
    expect(parse("Bund Petersilie, gehackt")).toMatchObject({ unit: "Bund", note: "gehackt" });
    expect(parse("g Mehl")).toMatchObject({ unit: null, food: "g Mehl" });
    expect(parse("Dose")).toMatchObject({ unit: null, food: "Dose" });
  });

  it("reads the weight of containers and pieces", () => {
    expect(parse("1 Dose (400 g) Tomaten")).toMatchObject({ unit: "Dose", weightGrams: 400 });
    expect(parse("1 Kürbis (1,2 kg)")).toMatchObject({ food: "Kürbis", weightGrams: 1200 });
    expect(parse("2 Dosen à 400 g Tomaten")).toMatchObject({ quantity: 2, weightGrams: 400 });
    expect(parse("2 Dosen Tomaten à 400 g")).toMatchObject({ food: "Tomaten", weightGrams: 400 });
    expect(parse("1 Glas (720 ml) Sauerkraut").weightGrams).toBeUndefined();
    expect(parse("2 x 200 g Hähnchenbrust")).toMatchObject({
      quantity: 2,
      unit: null,
      food: "Hähnchenbrust",
      weightGrams: 200,
    });
  });

  it("reads sized containers without a count", () => {
    expect(parse("400-g-Dose Tomaten")).toMatchObject({
      quantity: 1,
      unit: "Dose",
      weightGrams: 400,
    });
    expect(parse("1,5 l-Flasche Wasser")).toMatchObject({
      quantity: 1,
      unit: "Flasche",
      note: "1,5 l",
    });
    expect(parse("2x 400 g Dosen Tomaten")).toMatchObject({
      quantity: 2,
      unit: "Dose",
      food: "Tomaten",
    });
  });

  it("reads lines that start with the food", () => {
    expect(parse("Mehl 500 g")).toMatchObject({ quantity: 500, unit: "g", food: "Mehl" });
    expect(parse("Mehl: 500 g")).toMatchObject({ quantity: 500, food: "Mehl" });
    expect(parse("Wasser, lauwarm 250 ml")).toMatchObject({ quantity: 250, note: "lauwarm" });
    expect(parse("Butter, 250 g, weich")).toMatchObject({
      quantity: 250,
      unit: "g",
      note: "weich",
    });
    expect(parse("Eier, 3")).toMatchObject({ quantity: 3, food: "Eier" });
  });

  it("does not read a type number as a quantity", () => {
    expect(parse("Mehl Type 405")).toMatchObject({ quantity: null, food: "Mehl Type 405" });
    expect(parse("Weizenmehl Type 405 500 g")).toMatchObject({ quantity: 500, unit: "g" });
  });

  it("does not take an unknown word after a trailing number as a unit", () => {
    expect(parse("Zwiebeln 2 rote").quantity).toBeNull();
  });

  it("splits purpose phrases and dash comments off the food", () => {
    expect(parse("2 EL Öl zum Braten")).toMatchObject({ food: "Öl", note: "zum Braten" });
    expect(parse("½ Tasse Mandelmehl – oder gemahlene Mandeln")).toMatchObject({
      quantity: 0.5,
      unit: "Tasse",
      food: "Mandelmehl",
      note: "oder gemahlene Mandeln",
    });
    expect(parse("1 1/2 Tassen Brühe plus mehr zum Verdünnen")).toMatchObject({ food: "Brühe" });
  });

  it("moves an extra amount after a plus sign to the note", () => {
    expect(parse("125 g Butter + etwas zum Einfetten")).toMatchObject({
      quantity: 125,
      food: "Butter",
      note: "+ etwas zum Einfetten",
    });
    expect(parse("200 g Mehl + 2 EL für die Form")).toMatchObject({ food: "Mehl", confidence: 1 });
    expect(parse("Salz + Pfeffer")).toMatchObject({ food: "Salz + Pfeffer", note: "" });
  });

  it("reports low confidence for lines with a second amount it cannot place", () => {
    expect(parse("1 EL + 1 TL Zucker").confidence).toBe(0.3);
    expect(parse("1 TL Salz und 2 Prisen Pfeffer").confidence).toBe(0.3);
    expect(parse("Mehl Type 405 für die Arbeitsfläche").confidence).toBe(0.85);
  });

  it("keeps size words in the food unless a unit follows", () => {
    expect(parse("2 große Zwiebeln")).toMatchObject({ unit: null, food: "große Zwiebeln" });
    expect(parse("1 große Dose Tomaten")).toMatchObject({ unit: "Dose", note: "große" });
    expect(parse("1 gr. Zwiebel")).toMatchObject({ unit: null, food: "gr. Zwiebel" });
    expect(parse("100 gr. Mehl")).toMatchObject({ unit: "g", food: "Mehl" });
  });

  it("reads number words in both languages", () => {
    expect(parse("eine Prise Zucker")).toMatchObject({ quantity: 1, unit: "Prise" });
    expect(parse("zwei Eier")).toMatchObject({ quantity: 2, food: "Eier" });
    expect(parse("Half a lemon, juiced")).toMatchObject({ quantity: 0.5, food: "lemon" });
    expect(parse("a pinch of nutmeg")).toMatchObject({
      quantity: 1,
      unit: "pinch",
      food: "nutmeg",
    });
  });

  it("limits number words to the given language", () => {
    expect(parseIngredientLine("a pinch of salt", { lang: "de" }).quantity).toBeNull();
    expect(parseIngredientLine("ein Ei", { lang: "en" }).quantity).toBeNull();
  });

  it("marks optional ingredients and keeps the phrase in the note", () => {
    expect(parse("nach Belieben Chili")).toMatchObject({ optional: true, food: "Chili" });
    expect(parse("2 EL Rosinen nach Belieben")).toMatchObject({ optional: true, food: "Rosinen" });
    expect(parse("Salz nach Geschmack").optional).toBe(false);
  });

  it("reads juice and zest of a fruit as the fruit", () => {
    expect(parse("Saft von 1 Zitrone")).toMatchObject({
      quantity: 1,
      food: "Zitrone",
      note: "Saft von",
    });
    expect(parse("Saft einer halben Zitrone")).toMatchObject({
      quantity: 0.5,
      food: "Zitrone",
      note: "Saft einer halben",
    });
  });

  it("reports headers as not parsed", () => {
    for (const line of ["Für den Teig:", "ZUTATEN", "For the sauce:", "## Teig", "**Füllung**"]) {
      expect(parse(line)).toMatchObject({ parsed: false, quantity: null });
    }
    expect(parse("Für 4 Portionen")).toMatchObject({ parsed: false });
    expect(isHeaderLine("Zutaten für 4 Portionen:")).toBe(true);
    expect(isHeaderLine("500 g Mehl")).toBe(false);
    expect(isHeaderLine("   ")).toBe(false);
  });

  it("returns an empty result for an empty line", () => {
    expect(parse("  ")).toMatchObject({ parsed: false, food: "", confidence: 0 });
  });

  it("ignores bullets, checkboxes and non-breaking spaces", () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(cleanIngredientText(`${String.fromCharCode(0x25a2)} 2${nbsp}EL  Öl.`)).toBe("2 EL Öl");
    expect(parse("• 2 Eier")).toMatchObject({ quantity: 2, food: "Eier" });
  });

  it("scores its confidence", () => {
    expect(parse("500 g Mehl").confidence).toBe(1);
    expect(parse("3 Eier").confidence).toBe(0.9);
    expect(parse("Salz").confidence).toBe(0.85);
    expect(parse("etwas Salz").confidence).toBe(0.7);
    expect(parse("Mehl 500 g").confidence).toBe(0.95);
    expect(parse("1 Dose (400 g)").confidence).toBe(0.2);
    expect(parse("Mehl Type 405").confidence).toBe(0.85);
    expect(parse("250g/ 1 Tasse Zucker").confidence).toBe(0.3);
    expect(parse("Zucker 2/3 von").confidence).toBe(0.3);
  });

  it("parses number values", () => {
    expect(numberValue("3/4")).toBe(0.75);
    expect(numberValue("abc")).toBeNull();
  });
});
