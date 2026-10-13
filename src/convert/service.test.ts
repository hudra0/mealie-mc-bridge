import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MissingApiKeyError } from "../config.js";
import { loadConverter } from "../pipeline/converter-port.js";
import { loadDeviceLimits } from "../recipe/limits.js";
import * as convertModule from "./index.js";
import { categoriesFromHints, createServiceConverter } from "./service.js";
import type { ConversionRequest, GenerationInput, RecipeGenerator } from "./types.js";

const knowledgeDir = fileURLToPath(new URL("../../knowledge", import.meta.url));
const limits = await loadDeviceLimits(
  fileURLToPath(new URL("../../knowledge/device-programs.json", import.meta.url)),
);
// The soup fixture without its mapping: the requests here carry no source ingredients.
const soup = JSON.stringify({
  ...(JSON.parse(
    readFileSync(
      new URL("../../test/fixtures/convert/soup.recipe-input.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>),
  ingredientMapping: undefined,
});
const logger = { info: vi.fn(), warn: vi.fn() };
const env = { KNOWLEDGE_DIR: knowledgeDir, LLM_PRICES_JSON: '{"m": {"input": 1, "output": 1}}' };

const request: ConversionRequest = {
  title: "Kürbis-Linsen-Suppe",
  rendered: "# Kürbis-Linsen-Suppe\n\n## Zutaten\n\n- 500 g Kürbis\n",
  servings: 4,
  locale: "de-DE",
  ingredients: [],
  categoryHints: ["228: Suppen & Eintöpfe", "12: Hauptgerichte", "228: Suppen & Eintöpfe"],
};

function fakeGenerator() {
  const calls: GenerationInput[] = [];
  const generator: RecipeGenerator = {
    provider: "fake",
    model: "m",
    generate: (input) => {
      calls.push(input);
      return Promise.resolve({ json: soup, usage: { inputTokens: 1000, outputTokens: 1000 } });
    },
  };
  return { generator, calls };
}

describe("categoriesFromHints", () => {
  it("reads the catalog lines and keeps other hints", () => {
    expect(
      categoriesFromHints(["228: Suppen & Eintöpfe", " 12:Hauptgerichte ", "Suppe", " "]),
    ).toEqual({
      categories: [
        { id: 228, name: "Suppen & Eintöpfe" },
        { id: 12, name: "Hauptgerichte" },
      ],
      hints: ["Suppe"],
    });
  });
});

describe("createServiceConverter", () => {
  it("converts with the catalog from the request and the configured prices", async () => {
    const { generator, calls } = fakeGenerator();
    const converter = await createServiceConverter({ env, limits, logger }, () => generator);
    const result = await converter.convert(request);
    expect(result.recipe.categoryIds).toEqual([228]);
    expect(calls[0]?.user).toContain("- 12: Hauptgerichte\n- 228: Suppen & Eintöpfe");
    expect(calls[0]?.user).not.toContain("# Mealie categories");
    expect(result.usage.costUsd).toBe(0.002);
  });

  it("writes recipes for MC_LOCALE and refuses requests for another locale", async () => {
    const { generator, calls } = fakeGenerator();
    const converter = await createServiceConverter(
      { env: { ...env, MC_LOCALE: "en-US" }, limits, logger },
      () => generator,
    );
    await expect(converter.convert(request)).rejects.toThrow(
      "This converter writes en-US recipes; the request asks for de-DE",
    );
    const result = await converter.convert({ ...request, locale: "en-US" });
    expect(result.recipe.locale).toBe("en-US");
    expect(calls[0]?.system).toContain("Write every text of the recipe in English (en-US)");
  });

  it("fails the conversion, not the start, when the API key is missing", async () => {
    const converter = await createServiceConverter({
      env: { KNOWLEDGE_DIR: knowledgeDir },
      limits,
      logger,
    });
    await expect(converter.convert(request)).rejects.toThrow(MissingApiKeyError);
  });

  it("refuses a request without a category catalog", async () => {
    const { generator } = fakeGenerator();
    const converter = await createServiceConverter({ env, limits, logger }, () => generator);
    await expect(converter.convert({ ...request, categoryHints: [] })).rejects.toThrow(
      /must not guess category ids/,
    );
  });

  it("is what the service's converter port loads from src/convert", async () => {
    const converter = await loadConverter(
      {
        env: { KNOWLEDGE_DIR: knowledgeDir },
        limits,
        logger: { ...logger, debug: vi.fn(), error: vi.fn() },
      },
      () => Promise.resolve(convertModule),
    );
    await expect(converter.convert(request)).rejects.toThrow(MissingApiKeyError);
  });
});
