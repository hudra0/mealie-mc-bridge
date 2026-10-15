import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDeviceLimits } from "../recipe/limits.js";
import { STEP_KINDS } from "../recipe/schema.js";
import { testKnowledge } from "../testing/locale.js";
import { loadKnowledge, ruleValue, selectTechniques, techniqueById } from "./knowledge.js";
import {
  SYSTEM_SECTIONS,
  MIN_FORMULA_R2,
  buildSystemPrompt,
  MAX_CATALOG_NAMES_CHARS,
  buildUserMessage,
  catalogNameLines,
  compactValues,
  documentBody,
  formatDuration,
  formatFeedback,
  hasIngredientIndices,
  ingredientIndexLines,
  promptText,
  servingsLines,
  stepFields,
  techniqueDetail,
  usableModes,
  withFeedback,
} from "./prompt.js";
import type { NormalizedIngredient } from "../ingredients/index.js";
import type { ConversionRequest } from "./types.js";

const food = (name: string): NormalizedIngredient => ({
  index: 0,
  section: null,
  quantity: 1,
  quantityMax: null,
  unit: null,
  food: name,
  note: "",
  optional: false,
  source: "structured",
  original: "",
  referenceId: null,
});

const knowledge = await loadKnowledge(fileURLToPath(new URL("../../knowledge", import.meta.url)));
const limits = await loadDeviceLimits(
  fileURLToPath(new URL("../../knowledge/device-programs.json", import.meta.url)),
);
const categories = (
  JSON.parse(
    readFileSync(new URL("../../test/fixtures/mc/categories.json", import.meta.url), "utf8"),
  ) as { data: { categories: { id: number; name: string }[] } }
).data.categories;

const request: ConversionRequest = {
  title: "Kürbissuppe",
  rendered:
    "# Kürbissuppe\n\n## Zutaten\n\n- 500 g Kürbis\n\n## Zubereitung\n\n1. Kürbis würfeln und köcheln.\n",
  servings: 4,
  locale: "de-DE",
  ingredients: [],
  categoryHints: ["Suppe", " "],
};

const system = buildSystemPrompt(knowledge, limits);
const usable = usableModes(limits);
const { techniques } = selectTechniques(request, knowledge, undefined, usable);

describe("buildSystemPrompt", () => {
  it("has the sections in their fixed order", () => {
    const headings = system.split("\n").filter((line) => /^#{1,2} /.test(line));
    expect(headings).toMatchSnapshot();
    const positions = SYSTEM_SECTIONS.map((title) => system.indexOf(`\n# ${title}\n`));
    expect(system.startsWith("# Role and goal\n")).toBe(true);
    expect(positions.slice(1).every((position, i) => position > (positions[i] ?? 0))).toBe(true);
  });

  it("states every mode of the device limits and the recipe limits", () => {
    for (const id of limits.modes.keys()) expect(system).toContain(`\n- ${id}: `);
    expect(system).toContain("customized: temperature °C one of 0, 37, 40-130 in steps of 5");
    expect(system).toContain("at most 3 when temperature is not 0");
    expect(system).toContain("at most 3 when rotation is left");
    expect(system).toContain("at most 4 when the butterfly whisk is fitted");
    expect(system).toContain("at most 10 min when speed is at least 6");
    expect(system).toContain(
      "sous_vide: temperature 40-85 °C; time (minutes + seconds) 15 min to 12 h, whole minutes only",
    );
    expect(system).toContain("- kneading: do not use.");
    expect(system).toContain("food_processor: do not use; it needs the food processor attachment");
    expect(system).toContain("title 1-86 characters; description at most 240 characters");
    expect(system).toContain("required on text, scale, turbo steps");
    expect(system).toContain("servingSize.amount 1-100 (whole numbers)");
    expect(system).toContain("categoryIds: 1-8 ids");
  });

  it("carries the rule documents, the technique table and the timing and unit rules", () => {
    expect(system).toContain(documentBody(knowledge.promptRules));
    expect(system).toContain("## Typical sequences");
    expect(system).not.toContain("# Prompt rules for the converter");
    expect(system).toContain("- simmer_cook: Simmer or cook in liquid");
    expect(system).not.toContain("### puree_hot_soup");
    expect(system).toContain("about 457 s per kg");
    expect(system).toContain("at least 0.87 × tMin; below 0.5 × tMin the recipe is rejected");
    expect(system).toContain("Official first heatings of cold contents run about 2.3 × tMin");
    expect(system).toContain("do not pad them");
    expect(system).toContain(
      "Gram grid for weighed amounts (under 5 g nothing is weighed): 5-10 g",
    );
    expect(system).toContain("- bowl_max (error): at most 3000 g");
    expect(system).toContain("- Densities in g per ml: water 1, milk 1.03");
    expect(system).toContain("- EL, El, Esslöffel, tbsp, tablespoon → g, 15 g each");
    expect(system).toContain("Answer with exactly one JSON object");
  });

  it("is the same for every recipe and allows the food processor with the attachment", () => {
    expect(buildSystemPrompt(knowledge, limits, {})).toBe(system);
    expect(system).not.toContain("Kürbis");
    expect(system).not.toContain("food_processor_slice");
    const withAttachment = buildSystemPrompt(knowledge, limits, {
      attachments: ["food_processor_attachment"],
    });
    expect(withAttachment).toContain("- food_processor: time (minutes + seconds) 1 s to 5 min");
    expect(withAttachment).toContain("- food_processor_slice:");
  });

  it("names no knowledge file, no source project and no forbidden mode in a technique", () => {
    const user = buildUserMessage(request, categories, {
      techniques: knowledge.techniques,
      usable,
    });
    for (const text of [system, user]) {
      expect(text).not.toMatch(/\.json|\.md\b|SmartRecipe/);
    }
    expect(system).not.toMatch(/^- preclean:/m);
    expect(user).not.toContain("- Alternative: ramp");
    expect(promptText("never on hot contents (SmartRecipe rule: at most 60 °C)")).toBe(
      "never on hot contents (at most 60 °C)",
    );
    expect(promptText("see timing-model.json and units.json pieceWeights")).toBe(
      "see the Timing section and the piece weights of the Units section",
    );
  });
});

// The sections of a prompt that change with the output language.
function languageSections(prompt: string): string {
  const sections = prompt.split(/\n(?=# )/);
  const keep = ["# Role and goal", "# Conversion rules", "# Wording", "# Output contract"];
  return sections.filter((part) => keep.some((title) => part.startsWith(title))).join("\n");
}

const english = await testKnowledge("en-US");

describe("prompts per locale", () => {
  const englishRequest: ConversionRequest = {
    title: "Pumpkin soup",
    rendered:
      "# Pumpkin soup\n\n## Ingredients\n\n- [0] 500 g pumpkin\n- [1] 1 onion\n\n## Instructions\n\n1. Dice the pumpkin and simmer.\n",
    servings: 4,
    locale: "en-US",
    ingredients: [
      { ...food("pumpkin"), quantity: 500, unit: "g" },
      { ...food("onion"), quantity: 1, unit: null },
    ],
    categoryHints: ["Soup"],
  };

  it("keeps the language sections of the de-DE prompt", () => {
    expect(languageSections(system)).toMatchSnapshot();
  });

  it("keeps the language sections of the en-US prompt", () => {
    const englishSystem = buildSystemPrompt(english, limits);
    expect(languageSections(englishSystem)).toMatchSnapshot();
    expect(englishSystem).not.toMatch(/Mixbehälter|Messbecher|Rühraufsatz|German/);
    expect(englishSystem).toContain('locale is "en-US"');
    // The title length comes from the text_step_title rule of the knowledge base.
    expect(englishSystem).toContain(
      `A text step title is a short imperative of at most ${ruleValue(knowledge, "text_step_title")} characters`,
    );
  });

  it("keeps the en-US user message", () => {
    const { techniques: picked } = selectTechniques(englishRequest, english, undefined, usable);
    const user = buildUserMessage(englishRequest, categories, {
      techniques: picked,
      usable,
      aliases: english.aliases,
      languageName: english.pack.mc.language,
    });
    expect(user).toMatchSnapshot();
    expect(user).toContain("- English wording: sauté, sweat, soften");
    expect(user).toContain("The source ingredient lines carry their index [0] to [1]");
    expect(user).not.toContain("# Source ingredient indices");
  });

  it("lists the source indices when the recipe text does not carry them", () => {
    const plain = { ...englishRequest, rendered: "# Pumpkin soup\n\n- 500 g pumpkin\n- 1 onion\n" };
    expect(hasIngredientIndices(plain)).toBe(false);
    expect(hasIngredientIndices(englishRequest)).toBe(true);
    const user = buildUserMessage(plain, categories);
    expect(user).toContain("# Source ingredient indices\n\n- [0] 500 g pumpkin\n- [1] 1 onion");
    expect(ingredientIndexLines({ ingredients: [{ ...food("salt"), original: " " }] })).toEqual([
      "- [0] 1 salt",
    ]);
  });
});

describe("prompt helpers", () => {
  it("shortens evenly spaced values", () => {
    expect(compactValues([0, 37, 40, 45, 50])).toBe("0, 37, 40-50 in steps of 5");
    expect(compactValues([1, 2, 3, 7])).toBe("1-3, 7");
    expect(compactValues([5, 10])).toBe("5, 10");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(90)).toBe("1 min 30 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(7200)).toBe("2 h");
  });

  it("drops the document title and tightens tables", () => {
    expect(documentBody("# Title\n\nText\n\n| A    | B  |\n| ---- | -- |\n| x    | y  |")).toBe(
      "Text\n\n| A | B |\n|-|-|\n| x | y |",
    );
  });

  it("reads the fields of every step kind from the schema", () => {
    const fields = stepFields();
    expect([...fields.keys()].sort()).toEqual([...STEP_KINDS].sort());
    expect(fields.get("customized")).toContain("accessory (optional)");
    expect(fields.get("turbo")).toEqual(["title", "description", "seconds"]);
  });

  it("renders a technique with alternatives, formula and load times", () => {
    const steam = techniqueDetail(techniqueById(knowledge, "steam_in_steamer")!);
    expect(steam).toContain("- Program: steaming; temperature 0 °C; time 900 s (480-2100)");
    expect(steam).toContain(
      "- Alternative: customized, 120 °C (100-120), 600 s (180-1500), speed 1 (max 1)",
    );
    expect(steam).toContain("- Time by load: vegetables 900 s (372-3600)");
    const boil = techniqueById(knowledge, "bring_to_boil")!;
    expect(techniqueDetail(boil)).toContain(
      "- Time formula: max(tMinSeconds(massGrams, 100), 300)",
    );
    const soup = techniqueById(knowledge, "puree_hot_soup")!;
    expect(techniqueDetail(soup)).toContain("- Alternative: ramp");
    expect(techniqueDetail(soup, usable)).not.toContain("- Alternative: ramp");
    const saute = techniqueDetail(techniqueById(knowledge, "saute_onions")!);
    expect(saute).toContain("- Program: roasting; temperature 130 °C (100-130)");
    expect(saute).toContain("- Alternative: customized, 100 °C (80-120)");
    expect(saute).toContain("reverse when diced vegetables must keep their shape");
  });

  it("leaves out fitted time formulas without predictive power", () => {
    for (const id of ["simmer_cook", "puree_hot_soup", "knead_yeast_dough"]) {
      const technique = techniqueById(knowledge, id)!;
      expect(technique.device.timeSeconds?.formulaR2).toBeLessThan(MIN_FORMULA_R2);
      expect(techniqueDetail(technique)).not.toContain("- Time formula");
    }
  });
});

describe("buildUserMessage", () => {
  it("lists the categories, the servings, the techniques and the recipe, recipe last", () => {
    const user = buildUserMessage(request, categories, { techniques, usable });
    expect(user).toContain("# Techniques for this recipe");
    expect(user).toContain("### simmer_cook: Simmer or cook in liquid");
    expect(user.indexOf("# Techniques for this recipe")).toBeLessThan(user.indexOf("# Recipe"));
    expect(user.startsWith("# Categories\n")).toBe(true);
    expect(user).toContain("- 228: Suppen & Eintöpfe");
    const ids = [...user.matchAll(/^- (\d+): /gm)].map((match) => Number(match[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(user).toContain(
      "The serving size is 4 servings; the amounts below are scaled to it. Set servingSize.amount to 4.",
    );
    expect(user).toContain("# Mealie categories\n\nSuppe\n");
    expect(user.trimEnd().endsWith(request.rendered.trim())).toBe(true);
  });

  it("states the serving size with its unit", () => {
    const user = buildUserMessage(
      { ...request, servings: 10, servingUnit: "Scheiben", servingsSource: "yield" },
      categories,
    );
    expect(user).toContain(
      'The serving size is 10 Scheiben; the amounts below are scaled to it. Set servingSize.amount to 10 and servingSize.unit to "Scheiben".',
    );
  });

  it("asks for an estimate flagged in a review hint when the recipe states no serving size", () => {
    const lines = servingsLines({
      servings: 4,
      servingUnit: "Portionen",
      servingsSource: "estimate",
    });
    expect(lines.join("\n")).toContain("states neither servings nor a yield");
    expect(lines.join("\n")).toContain("keep 4 Portionen when nothing points elsewhere");
    expect(lines.join("\n")).toContain("add a review hint that says the serving size is estimated");
    expect(lines.join("\n")).not.toContain("Set servingSize.amount to");
  });

  it("refuses to ask for category ids without a list", () => {
    expect(() => buildUserMessage(request, [])).toThrow(RangeError);
    const user = buildUserMessage({ ...request, categoryHints: [] }, categories);
    expect(user).not.toContain("# Mealie categories");
    expect(user).not.toContain("# Techniques for this recipe");
  });

  it("appends the errors and the previous answer on a correction round", () => {
    const feedback = {
      errors: [
        { path: "servingSize.steps[2].speed", message: "speed 5 is above the maximum of 3" },
        { path: "title", message: "title must not be empty" },
      ],
      previousJson: '{"title":""}\n',
    };
    const user = buildUserMessage(request, categories, { feedback });
    expect(user).toContain(formatFeedback(feedback));
    expect(formatFeedback(feedback)).toMatchInlineSnapshot(`
      "# Correction

      Your previous answer did not pass the checks. These are the errors:

      1. servingSize.steps[2].speed: speed 5 is above the maximum of 3
      2. title: title must not be empty

      Fix every error and return the full corrected recipe as one JSON object. Keep everything that was not wrong.

      Your previous answer:

      \`\`\`json
      {"title":""}
      \`\`\`"
    `);
    expect(withFeedback(buildUserMessage(request, categories), feedback)).toBe(user);
    expect(withFeedback("plain")).toBe("plain");
  });
});

describe("catalog names in the user message", () => {
  const withNames: ConversionRequest = {
    ...request,
    ingredients: [food("Butternusskürbis"), food("Salz"), food("Zwiebeln (rot)")],
    catalogNames: [
      { index: 0, names: ["Butternutkürbis"] },
      { index: 1, names: [" "] },
      { index: 2, names: ["Zwiebeln, rot", "Zwiebeln"] },
      { index: 9, names: ["Gibt es nicht"] },
    ],
  };

  it("lists the names by source index after the recipe and asks for them verbatim", () => {
    const user = buildUserMessage(withNames, categories);
    expect(user).toContain(
      "# Catalog names\n\nMonsieur Cuisine catalog names close to source ingredient lines, by index. When one names the same product, write it verbatim as the ingredient-list name",
    );
    expect(user).toContain(
      "- [0] Butternusskürbis: Butternutkürbis\n- [2] Zwiebeln (rot): Zwiebeln, rot | Zwiebeln\n",
    );
    expect(user).not.toContain("[1] Salz");
    expect(user).not.toContain("Gibt es nicht");
    expect(user.indexOf("# Recipe")).toBeLessThan(user.indexOf("# Catalog names"));
  });

  it("leaves the section out without names", () => {
    expect(buildUserMessage(request, categories)).not.toContain("# Catalog names");
    expect(catalogNameLines({ ingredients: [food("Salz")] })).toEqual([]);
  });

  it("caps the section size", () => {
    const many: ConversionRequest = {
      ...request,
      ingredients: Array.from({ length: 200 }, (_, i) => food(`Zutat ${i}`)),
      catalogNames: Array.from({ length: 200 }, (_, index) => ({
        index,
        names: ["Ein ziemlich langer Katalogname", "Noch ein langer Katalogname"],
      })),
    };
    const lines = catalogNameLines(many);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.length).toBeLessThan(200);
    expect(lines.join("\n").length).toBeLessThanOrEqual(MAX_CATALOG_NAMES_CHARS);
  });

  it("asks for catalog names in the language rules of both packs", () => {
    expect(system).toContain("When the user message lists catalog names for an ingredient line");
    expect(buildSystemPrompt(english, limits)).toContain(
      '"yeast, fresh", "tomatoes, chopped, from a tin/jar"',
    );
  });
});
