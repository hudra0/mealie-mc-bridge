import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mealieRecipeSchema,
  mealieTimelineEventSchema,
  mealieUserSchema,
  paginated,
  mealieTagSchema,
} from "./types.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/mealie/${name}`, import.meta.url), "utf8"));

describe("mealieRecipeSchema", () => {
  it("parses a v3.28 recipe and keeps unknown keys", () => {
    const recipe = mealieRecipeSchema.parse(fixture("recipe-structured-v3.28.json"));
    expect(recipe.recipeServings).toBe(4);
    expect(recipe.recipeIngredient).toHaveLength(11);
    expect(recipe.recipeIngredient[1]?.unit?.pluralName).toBe("Zehen");
    expect(recipe.notes[0]?.referenceId).toBe("00000000-0000-4000-8000-000000000801");
    expect(recipe.extras).toEqual({ source: "family" });
    expect(recipe["orgURL"]).toBe("https://example.com/recipes/kuerbis-linsen-suppe");
    expect(recipe.recipeIngredient[4]?.["substitutions"]).toHaveLength(1);
  });

  it("parses a v3.25 recipe without the newer fields", () => {
    const recipe = mealieRecipeSchema.parse(fixture("recipe-freetext-v3.25.json"));
    expect(recipe.image).toBeNull();
    expect(recipe.notes[0]).toEqual({
      title: "Aufbewahrung",
      text: "Luftdicht verpackt zwei Tage frisch.",
    });
    expect(recipe.recipeInstructions[3]).toMatchObject({ title: null, summary: null, text: "" });
  });

  it("fills defaults for a minimal recipe", () => {
    const recipe = mealieRecipeSchema.parse({ id: "r1", slug: "r1", tags: null, notes: null });
    expect(recipe).toMatchObject({
      name: "",
      description: "",
      recipeServings: 0,
      recipeYield: null,
      tags: [],
      notes: [],
      recipeIngredient: [],
      nutrition: null,
      settings: null,
      extras: {},
    });
  });

  it("turns non-string extras into strings and drops empty ones", () => {
    const recipe = mealieRecipeSchema.parse({
      id: "r1",
      slug: "r1",
      image: 7,
      extras: { count: 3, flag: true, gone: null, text: "kept" },
    });
    expect(recipe.extras).toEqual({ count: "3", flag: "true", text: "kept" });
    expect(recipe.image).toBe("7");
  });

  it("rejects a recipe without id", () => {
    expect(mealieRecipeSchema.safeParse({ slug: "x" }).success).toBe(false);
  });
});

describe("other shapes", () => {
  it("parses the user, a timeline event and a tag page", () => {
    expect(
      mealieUserSchema.parse({ id: "u1", username: "bridge", tokens: [{ name: "t", id: 1 }] }),
    ).toMatchObject({ id: "u1", admin: false, fullName: null });
    expect(
      mealieTimelineEventSchema.parse({
        id: "e1",
        recipeId: "r1",
        subject: "Done",
        eventType: "info",
        eventMessage: null,
      }),
    ).toMatchObject({ eventMessage: null, timestamp: null });
    const page = paginated(mealieTagSchema).parse({
      page: 1,
      per_page: -1,
      total: 1,
      total_pages: 1,
      items: [{ id: "t1", name: "Monsieur Cuisine", slug: "monsieur-cuisine", groupId: "g1" }],
      next: null,
      previous: null,
    });
    expect(page.items[0]?.slug).toBe("monsieur-cuisine");
  });
});
