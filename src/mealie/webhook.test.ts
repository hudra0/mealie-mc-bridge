import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  InvalidRecipeActionError,
  MAX_SCALE,
  MIN_SCALE,
  SCALE_STEP,
  parseRecipeActionBody,
  quantizeScale,
} from "./webhook.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/mealie/${name}`, import.meta.url), "utf8"));

const recipeId = "00000000-0000-4000-8000-000000000001";

function issuesOf(body: unknown): string[] {
  try {
    parseRecipeActionBody(body);
  } catch (error) {
    if (error instanceof InvalidRecipeActionError) return error.issues;
    throw error;
  }
  throw new Error("expected the body to be rejected");
}

describe("parseRecipeActionBody", () => {
  it("reads the snake_case body Mealie sends", () => {
    expect(parseRecipeActionBody(fixture("action-body-v3.28.json"))).toEqual({
      recipeId,
      scale: 1.5,
      actionTitle: "An Monsieur Cuisine senden",
    });
  });

  it("reads a camelCase variant", () => {
    const body = { action: { title: "Send" }, content: { id: recipeId }, recipeScale: 2 };
    expect(parseRecipeActionBody(body)).toEqual({ recipeId, scale: 2, actionTitle: "Send" });
  });

  it("prefers recipe_scale when both spellings are present", () => {
    const body = { content: { id: recipeId }, recipe_scale: 0.5, recipeScale: 3 };
    expect(parseRecipeActionBody(body).scale).toBe(0.5);
  });

  it("defaults the scale to 1 and leaves out a missing title", () => {
    expect(parseRecipeActionBody({ content: { id: recipeId } })).toEqual({ recipeId, scale: 1 });
    expect(parseRecipeActionBody({ content: { id: recipeId }, recipe_scale: null })).toEqual({
      recipeId,
      scale: 1,
    });
    expect(parseRecipeActionBody({ action: { title: "  " }, content: { id: recipeId } })).toEqual({
      recipeId,
      scale: 1,
    });
  });

  it("accepts a numeric string as scale and normalizes the id to lower case", () => {
    const body = { content: { id: recipeId.toUpperCase() }, recipe_scale: "1.25" };
    expect(parseRecipeActionBody(body)).toEqual({ recipeId, scale: 1.25 });
  });

  it("ignores the rest of the recipe content", () => {
    const body = { content: { id: recipeId, recipe_ingredient: "not a list", name: 42 } };
    expect(parseRecipeActionBody(body).recipeId).toBe(recipeId);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a %s scale", (_name, scale) => {
    expect(issuesOf({ content: { id: recipeId }, recipe_scale: scale })).toEqual([
      "recipe_scale: must be a number above 0",
    ]);
  });

  it.each([
    [1.01, 1],
    [1.13, 1.25],
    [1.12, 1],
    [0.6, 0.5],
    [0.1, 0.25],
    [10, 10],
    [10.2, 10],
    [100, 10],
  ])("rounds the scale %s to %s: quarter steps from 0.25 to 10", (given, expected) => {
    expect(parseRecipeActionBody({ content: { id: recipeId }, recipe_scale: given }).scale).toBe(
      expected,
    );
  });

  it("quantizes in one place", () => {
    expect([MIN_SCALE, MAX_SCALE, SCALE_STEP]).toEqual([0.25, 10, 0.25]);
    expect(quantizeScale(2.374)).toBe(2.25);
    expect(quantizeScale(2.375)).toBe(2.5);
  });

  it("rejects a non-numeric scale", () => {
    expect(issuesOf({ content: { id: recipeId }, recipe_scale: "lots" })).toEqual([
      "recipe_scale: must be a number",
    ]);
  });

  it("rejects a missing or malformed recipe id", () => {
    expect(issuesOf({ content: { id: "kurbis-linsen-suppe" } })).toEqual([
      "content.id: must be a UUID",
    ]);
    expect(issuesOf({ content: {} })[0]).toMatch(/^content\.id: /);
    expect(issuesOf({ recipe_scale: 1 })[0]).toMatch(/^content: /);
  });

  it("rejects a body that is not an object", () => {
    expect(issuesOf(null)[0]).toMatch(/^body: /);
    expect(issuesOf("text")[0]).toMatch(/^body: /);
  });

  it("names the issues in the error message", () => {
    expect(() => parseRecipeActionBody({ content: { id: "x" } })).toThrow(
      "Invalid recipe action body: content.id: must be a UUID",
    );
  });
});
