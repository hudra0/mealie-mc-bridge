import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDeviceLimits } from "../recipe/limits.js";
import { STEP_KINDS } from "../recipe/schema.js";
import { loadKnowledge, selectTechniques, techniqueById } from "./knowledge.js";
import {
  SYSTEM_SECTIONS,
  buildSystemPrompt,
  buildUserMessage,
  compactValues,
  documentBody,
  formatDuration,
  formatFeedback,
  stepFields,
  techniqueDetail,
  withFeedback,
} from "./prompt.js";
import type { ConversionRequest } from "./types.js";

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

const system = buildSystemPrompt(knowledge, limits, {
  techniques: selectTechniques(request, knowledge),
});

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
    expect(system).toContain("## 2. A text or scale step before every working step");
    expect(system).not.toContain("# Prompt rules for the converter");
    expect(system).toContain("- simmer_cook: Simmer or cook in liquid");
    expect(system).toContain("### puree_hot_soup: Purée a hot soup");
    expect(system).toContain("about 457 s per kg");
    expect(system).toContain("at least 0.87 × tMin; below 0.5 × tMin the recipe is rejected");
    expect(system).toContain("- bowl_max (error): at most 3000 g");
    expect(system).toContain("- Densities in g per ml: water 1, milk 1.03");
    expect(system).toContain("- EL, El, Esslöffel, tbsp, tablespoon → g, 15 g each");
    expect(system).toContain("Answer with exactly one JSON object");
  });

  it("is deterministic and allows the food processor when the attachment is there", () => {
    const options = { techniques: selectTechniques(request, knowledge) };
    expect(buildSystemPrompt(knowledge, limits, options)).toBe(system);
    const withAttachment = buildSystemPrompt(knowledge, limits, {
      ...options,
      attachments: ["food_processor_attachment"],
    });
    expect(withAttachment).toContain("- food_processor: time (minutes + seconds) 1 s to 5 min");
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
    expect(techniqueDetail(techniqueById(knowledge, "puree_hot_soup")!)).toContain(
      "- Time formula: clamp(30, 120, 33 + 0.009 * massGrams)",
    );
    expect(techniqueDetail(techniqueById(knowledge, "saute_onions")!)).toContain(
      "reverse: true when diced vegetables",
    );
  });
});

describe("buildUserMessage", () => {
  it("lists the categories, the servings and the recipe, recipe last", () => {
    const user = buildUserMessage(request, categories);
    expect(user.startsWith("# Categories\n")).toBe(true);
    expect(user).toContain("- 228: Suppen & Eintöpfe");
    const ids = [...user.matchAll(/^- (\d+): /gm)].map((match) => Number(match[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(user).toContain("scaled to 4 servings. Set servingSize.amount to 4.");
    expect(user).toContain("# Mealie categories\n\nSuppe\n");
    expect(user.trimEnd().endsWith(request.rendered.trim())).toBe(true);
  });

  it("says when no category list is available", () => {
    const user = buildUserMessage({ ...request, categoryHints: [] }, []);
    expect(user).toContain("No category list is available");
    expect(user).not.toContain("# Mealie categories");
  });

  it("appends the errors and the previous answer on a correction round", () => {
    const feedback = {
      errors: [
        { path: "servingSize.steps[2].speed", message: "speed 5 is above the maximum of 3" },
        { path: "title", message: "title must not be empty" },
      ],
      previousJson: '{"title":""}\n',
    };
    const user = buildUserMessage(request, categories, feedback);
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
