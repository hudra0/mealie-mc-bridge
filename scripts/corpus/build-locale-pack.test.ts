import path from "node:path";
import { describe, expect, it } from "vitest";
import { STAGES } from "./analyze.js";
import {
  MIN_PHRASE_RECIPES,
  buildPackPhrases,
  buildPackUnits,
  frequentTextSteps,
} from "./build-locale-pack.js";
import type { IngredientsAnalysis } from "./build-timing-units.js";
import { parseOptions } from "./crawl.js";
import { REFERENCE_LOCALE, corpusDirFor, parseCorpusArgs } from "./locale.js";
import type { NormalizedStep } from "./types.js";

const analysis = {
  meta: { recipes: 3, official: 2 },
  units: {
    bySource: {
      official: {
        ingredients: 30,
        unitExact: [
          { key: '"g"', count: 20 },
          { key: '"tsp"', count: 5 },
        ],
      },
    },
  },
  groups: { official: { normalized: [{ key: "FOR THE DOUGH", count: 4 }] } },
  servings: [{ units: { portions: 2, pieces: 1 } }],
  pieceWeights: [
    { name: "onions", concept: "Stück", n: 10, gramsPerUnit: 70, spread: { p10: 50, p90: 80 } },
    { name: "onion", concept: "Stück", n: 3, gramsPerUnit: 60, spread: { p10: 50, p90: 70 } },
    { name: "sachet", concept: "Pkg", n: 5, gramsPerUnit: 8, spread: { p10: 7, p90: 9 } },
  ],
} as unknown as IngredientsAnalysis;

const step = (recipeId: number, text: string, kind = "text", source = "official") =>
  ({ recipeId, text, kind, source }) as unknown as NormalizedStep;

describe("locale corpora", () => {
  it("keeps the reference corpus in local/corpus and the others below it", () => {
    expect(REFERENCE_LOCALE).toBe("de-DE");
    expect(corpusDirFor("de-DE")).toBe(path.join("local", "corpus"));
    expect(corpusDirFor("en-US")).toBe(path.join("local", "corpus", "en-US"));
    expect(parseCorpusArgs(["--locale", "en-US", "--x"], {})).toEqual({
      locale: "en-US",
      corpusDir: path.join("local", "corpus", "en-US"),
      rest: ["--x"],
    });
    expect(parseCorpusArgs([], { CORPUS_DIR: "c" }).corpusDir).toBe("c");
    expect(() => parseCorpusArgs(["--locale"], {})).toThrow("--locale needs a value");
    expect(() => parseCorpusArgs(["--locale", "en"], {})).toThrow("must look like de-DE");
  });

  it("lets the crawler take --locale over LOCALE", () => {
    expect(parseOptions({ LOCALE: "fr-FR" }, ["--locale", "en-US"])).toMatchObject({
      locale: "en-US",
      corpusDir: path.join("local", "corpus", "en-US"),
    });
    expect(parseOptions({ LOCALE: "fr-FR" }).corpusDir).toBe(path.join("local", "corpus", "fr-FR"));
    expect(() => parseOptions({}, ["--nope"])).toThrow("unknown argument: --nope");
  });

  it("runs the normalizer before the five analyzers", () => {
    expect(STAGES.map(([name]) => name)).toEqual([
      "normalize",
      "analyze-modes",
      "analyze-techniques",
      "analyze-structure",
      "analyze-ingredients",
      "analyze-timing",
    ]);
  });
});

describe("buildPackUnits", () => {
  it("refreshes the piece weights and the corpus tables and keeps the hand-written fields", () => {
    const existing = {
      description: "hand",
      locale: "en-US",
      vocabulary: [{ concept: "piece", singular: "piece" }],
      pieceWeights: { note: "kept", items: [] },
    };
    const units = buildPackUnits("en-US", analysis, existing) as {
      description: string;
      pieceWeights: { note: string; items: { name: string; unit: string; grams: number }[] };
      corpus: { unitSpellings: Record<string, number>; groupNames: Record<string, number> };
    };
    expect(units.description).toBe("hand");
    expect(units.pieceWeights.note).toBe("kept");
    expect(units.pieceWeights.items).toEqual([
      { name: "onions", unit: "piece", grams: 70, range: [50, 80], n: 10 },
      { name: "sachet", unit: "Pkg", grams: 8, range: [7, 9], n: 5 },
    ]);
    expect(units.corpus.unitSpellings).toEqual({ g: 20, tsp: 5 });
    expect(units.corpus.groupNames).toEqual({ "FOR THE DOUGH": 4 });
  });

  it("starts a new pack file with the generated parts", () => {
    const units = buildPackUnits("fr-FR", analysis, null) as Record<string, unknown>;
    expect(units.locale).toBe("fr-FR");
    expect(String(units.description)).toContain("Adding a language");
  });
});

describe("frequentTextSteps and buildPackPhrases", () => {
  it("keeps short text steps that official recipes repeat, numbers as <n>", () => {
    const steps = [
      ...Array.from({ length: MIN_PHRASE_RECIPES }, (_, i) => step(i, "Add 2 eggs.")),
      ...Array.from({ length: MIN_PHRASE_RECIPES }, (_, i) => step(i, "Add 3 eggs.")),
      ...Array.from({ length: MIN_PHRASE_RECIPES - 1 }, (_, i) => step(i, "Rare phrase.")),
      step(1, "x".repeat(100)),
      step(1, "Member phrase.", "text", "member"),
      step(1, "Mode", "machine"),
    ];
    const { textSteps, phrases } = frequentTextSteps(steps);
    expect(textSteps).toBe(MIN_PHRASE_RECIPES * 3 - 1 + 1);
    expect(phrases).toEqual([{ text: "Add <n> eggs.", recipes: MIN_PHRASE_RECIPES }]);
    const pack = buildPackPhrases("en-US", steps, { locale: "en-US", standardPhrases: {} }) as {
      standardPhrases: object;
      corpus: { frequentTextSteps: unknown[] };
    };
    expect(pack.standardPhrases).toEqual({});
    expect(pack.corpus.frequentTextSteps).toHaveLength(1);
    expect(buildPackPhrases("fr-FR", [], null)).toMatchObject({ locale: "fr-FR" });
  });
});
