import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeIngredients,
  scaleIngredients,
  servingsFor,
  type ScaledIngredient,
} from "../ingredients/index.js";
import { loadDeviceLimits } from "../recipe/limits.js";
import { formatNumber, plainText, renderRecipeForLlm } from "./render.js";
import { mealieRecipeSchema, type MealieRecipe } from "./types.js";

const fixture = (name: string): MealieRecipe =>
  mealieRecipeSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../test/fixtures/mealie/${name}`, import.meta.url), "utf8"),
    ),
  );

const limits = await loadDeviceLimits(
  fileURLToPath(new URL("../../knowledge/device-programs.json", import.meta.url)),
);

// The pipeline the bridge runs before rendering: normalize, scale, count servings.
function render(recipe: MealieRecipe, scale: number): string {
  const ingredients = scaleIngredients(normalizeIngredients(recipe), scale);
  return renderRecipeForLlm(recipe, {
    scale,
    servings: servingsFor(recipe, scale, limits.recipe.servings),
    ingredients,
  });
}

const minimal = (overrides: Record<string, unknown> = {}): MealieRecipe =>
  mealieRecipeSchema.parse({ id: "00000000-0000-4000-8000-000000000009", slug: "x", ...overrides });

const scaled = (overrides: Partial<ScaledIngredient>): ScaledIngredient => ({
  index: 0,
  section: null,
  quantity: null,
  quantityMax: null,
  unit: null,
  food: "Zutat",
  note: "",
  optional: false,
  source: "structured",
  original: "",
  referenceId: null,
  baseQuantity: null,
  baseQuantityMax: null,
  flags: [],
  ...overrides,
});

describe("renderRecipeForLlm snapshots", () => {
  it("renders a structured v3.28 recipe scaled by 1.5", () => {
    expect(render(fixture("recipe-structured-v3.28.json"), 1.5)).toMatchSnapshot();
  });

  it("renders a free-text v3.25 recipe with sections scaled by 2", () => {
    expect(render(fixture("recipe-freetext-v3.25.json"), 2)).toMatchSnapshot();
  });

  it("gives the same output for the same input", () => {
    const recipe = fixture("recipe-freetext-v3.25.json");
    expect(render(recipe, 2)).toBe(render(recipe, 2));
  });

  it("contains no HTML", () => {
    for (const name of ["recipe-structured-v3.28.json", "recipe-freetext-v3.25.json"]) {
      expect(render(fixture(name), 1)).not.toMatch(/<[a-z/][^>]*>|&[a-z]+;/i);
    }
  });
});

describe("renderRecipeForLlm details", () => {
  it("shows the servings without an arrow when they do not change", () => {
    const text = render(fixture("recipe-structured-v3.28.json"), 1);
    expect(text).toContain("Portionen: 4 · Vorbereitung");
    expect(text).not.toContain("Faktor");
    expect(text).toContain("- 1 Zwiebel (fein gewürfelt)\n");
  });

  it("marks unparsed lines at factor 1 without asking for scaling", () => {
    const text = render(fixture("recipe-freetext-v3.25.json"), 1);
    expect(text).toContain("- [Original: 50 g/ ¼ Tasse gehackte Haselnüsse] — prüfen: ungeparst\n");
  });

  it("writes placeholders for a recipe without content", () => {
    const text = renderRecipeForLlm(minimal({ nutrition: { calories: null } }), {
      scale: 1,
      servings: 4,
      ingredients: [],
    });
    expect(text).toBe(
      [
        "# Ohne Titel",
        "",
        "Portionen: 4 (im Rezept nicht angegeben)",
        "",
        "## Zutaten",
        "",
        "Keine Zutaten angegeben.",
        "",
        "## Zubereitung",
        "",
        "Keine Schritte angegeben.",
        "",
      ].join("\n"),
    );
  });

  it("writes ranges, plural units and an optional marker", () => {
    const text = renderRecipeForLlm(minimal({ name: "Test" }), {
      scale: 1,
      servings: 2,
      ingredients: [
        scaled({ quantity: 2, quantityMax: 3, unit: "Zehe", food: "Knoblauch" }),
        scaled({ quantity: 1, unit: "Zehe", food: "Knoblauch" }),
        scaled({ quantity: 0.25, unit: "TL", food: "Chili", optional: true }),
        scaled({ quantity: 2, unit: "Prise", food: "Salz", optional: true, note: "fein" }),
        scaled({ quantity: 1, unit: "Handvoll", food: "Nüsse", optional: true, note: "optional" }),
      ],
    });
    expect(text).toContain(
      [
        "- 2–3 Zehen Knoblauch",
        "- 1 Zehe Knoblauch",
        "- 0,25 TL Chili (optional)",
        "- 2 Prisen Salz (fein, optional)",
        "- 1 Handvoll Nüsse (optional)",
      ].join("\n"),
    );
  });

  it("writes every unit with its label from the unit table", () => {
    const text = renderRecipeForLlm(minimal({ name: "Test" }), {
      scale: 1,
      servings: 2,
      ingredients: [
        scaled({ quantity: 2, unit: "Kopf", food: "Salat" }),
        scaled({ quantity: 3, unit: "Glas", food: "Gurken" }),
        scaled({ quantity: 8, unit: "floz", food: "Sahne" }),
      ],
    });
    expect(text).toContain("- 2 Köpfe Salat\n- 3 Gläser Gurken\n- 8 fl oz Sahne\n");
  });

  it("shows the parsed text as the original when the display is stale", () => {
    const recipe = minimal({
      recipeIngredient: [{ quantity: 1, note: "500 g Mehl", display: "1 500 g Mehl" }],
    });
    expect(render(recipe, 3)).toContain("- 1500 g Mehl [Original: 500 g Mehl]\n");
  });

  it("counts servings from the yield quantity like Mealie's scaler", () => {
    const recipe = minimal({ recipeServings: 0, recipeYieldQuantity: 2, recipeYield: "Brote" });
    expect(render(recipe, 2)).toContain("Portionen: 2 → 4 (aus der Ergibt-Menge) · Faktor: 2");
    expect(render(recipe, 1)).toContain("Portionen: 2 (aus der Ergibt-Menge)");
  });

  it("uses the factor as the servings when nothing is stated", () => {
    expect(render(minimal(), 3)).toContain("Portionen: 3 (im Rezept nicht angegeben)");
    expect(render(minimal(), 1)).toContain("Portionen: 4 (im Rezept nicht angegeben)");
  });

  it("names the step summary and skips empty steps", () => {
    const recipe = minimal({
      recipeInstructions: [
        { title: "Vorbereiten", summary: "", text: "" },
        { summary: "Nur Titel", text: "" },
        { text: "Erster<br/>Absatz<p>Zweiter</p>" },
      ],
    });
    const text = renderRecipeForLlm(recipe, { scale: 1, servings: 4, ingredients: [] });
    expect(text).toContain(
      "### Vorbereiten\n\n1. **Nur Titel**\n2. Erster\n   Absatz\n   Zweiter\n",
    );
  });

  it("leaves out empty notes and empty nutrition", () => {
    const recipe = minimal({
      notes: [
        { title: "", text: "" },
        { title: "", text: "Nur Text" },
      ],
      nutrition: { calories: "" },
    });
    const text = renderRecipeForLlm(recipe, { scale: 1, servings: 4, ingredients: [] });
    expect(text).toContain("## Notizen\n\nNur Text\n");
    expect(text).not.toContain("## Nährwerte");
  });

  it("reads the yield without a quantity", () => {
    const text = renderRecipeForLlm(minimal({ recipeServings: 2, recipeYield: "1 Blech" }), {
      scale: 2,
      servings: 4,
      ingredients: [],
    });
    expect(text).toContain("Portionen: 2 → 4 · Faktor: 2 · Ergibt: 1 Blech");
  });
});

describe("formatNumber", () => {
  it.each([
    [500, "500"],
    [0.5, "0,5"],
    [1 / 3, "0,333"],
    [1.25, "1,25"],
  ])("formats %d as %s", (value, text) => {
    expect(formatNumber(value)).toBe(text);
  });
});

describe("plainText", () => {
  it("strips tags and decodes entities", () => {
    expect(plainText("<p>Salz &amp; Pfeffer&nbsp;&#8211; &quot;fein&quot; &bogus;</p>")).toBe(
      'Salz & Pfeffer – "fein" &bogus;',
    );
  });

  it("collapses blank lines and keeps Markdown", () => {
    expect(plainText("**fett**\r\n\r\n\r\n\r\nweiter  \nzeile")).toBe("**fett**\n\nweiter\nzeile");
  });

  it("returns an empty string for missing text", () => {
    expect(plainText(null)).toBe("");
    expect(plainText(undefined)).toBe("");
  });
});
