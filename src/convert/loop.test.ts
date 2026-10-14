import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { normalizeIngredients, scaleIngredients } from "../ingredients/index.js";
import { mealieRecipeSchema, renderRecipeForLlm } from "../mealie/index.js";
import { loggerOptions } from "../logger.js";
import { loadDeviceLimits } from "../recipe/limits.js";
import { ConversionFailedError, LlmRefusalError } from "./errors.js";
import { deLabels } from "../testing/locale.js";
import { loadKnowledge } from "./knowledge.js";
import { createConverter, type ConverterLogger } from "./loop.js";
import type {
  ConversionRequest,
  GenerationInput,
  GenerationOutput,
  RecipeGenerator,
} from "./types.js";

const knowledge = await loadKnowledge(fileURLToPath(new URL("../../knowledge", import.meta.url)));
const limits = await loadDeviceLimits(
  fileURLToPath(new URL("../../knowledge/device-programs.json", import.meta.url)),
);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const categories = (
  JSON.parse(read("../../test/fixtures/mc/categories.json")) as {
    data: { categories: { id: number; name: string }[] };
  }
).data.categories;
const soup = read("../../test/fixtures/convert/soup.recipe-input.json");

const mealie = mealieRecipeSchema.parse(
  JSON.parse(read("../../test/fixtures/mealie/recipe-structured-v3.28.json")),
);
const ingredients = scaleIngredients(normalizeIngredients(mealie), 1);
const request: ConversionRequest = {
  title: mealie.name,
  rendered: renderRecipeForLlm(mealie, { scale: 1, servings: 4, ingredients, labels: deLabels }),
  servings: 4,
  locale: "de-DE",
  ingredients,
  categoryHints: ["Suppe"],
};

const usage = { inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 5_000 };

type Json = Record<string, unknown>;
interface SoupJson {
  categoryIds: number[];
  servingSize: { steps: Json[] };
}

// A recipe JSON with one change applied to the soup fixture.
function soupWith(change: (recipe: SoupJson, step: (index: number) => Json) => void): string {
  const recipe = JSON.parse(soup) as SoupJson;
  const step = (index: number): Json => {
    const found = recipe.servingSize.steps[index];
    if (!found) throw new Error(`the fixture has no step ${index}`);
    return found;
  };
  change(recipe, step);
  return JSON.stringify(recipe);
}

function fakeGenerator(answers: (string | Error | GenerationOutput)[], model = "gpt-5.5") {
  const calls: GenerationInput[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const generate = vi.fn((input: GenerationInput, opts?: { signal?: AbortSignal }) => {
    calls.push(input);
    signals.push(opts?.signal);
    const next = answers.shift();
    if (next === undefined) return Promise.reject(new Error("no more answers"));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === "string" ? { json: next, usage } : next);
  });
  const generator: RecipeGenerator = { provider: "fake", model, generate };
  return { generator, calls, signals, generate };
}

function logger() {
  const info = vi.fn();
  const warn = vi.fn();
  const log: ConverterLogger = { info, warn };
  return { log, info, warn };
}

const converter = (
  generator: RecipeGenerator,
  extra: Partial<Parameters<typeof createConverter>[0]> = {},
) => createConverter({ generator, knowledge, limits, categories, ...extra });

describe("createConverter", () => {
  it("returns a recipe that passes on the first try", async () => {
    const { generator, calls } = fakeGenerator([soup]);
    const { log, info, warn } = logger();
    const result = await converter(generator, { logger: log }).convert(request);
    expect(result.recipe.title).toBe("Kürbis-Linsen-Suppe");
    // Text step titles come from the description, cut at the title length.
    expect(result.recipe.servingSize.steps[0]?.title).toBe(
      "Zwiebel schälen und halbieren, Knoblauch schälen und beides in den Mixbehälter",
    );
    expect(result.attempts).toBe(1);
    expect(result.provider).toBe("fake");
    expect(result.model).toBe("gpt-5.5");
    expect(result.warnings).toEqual([]);
    expect(result.reviewHints).toEqual(["Croûtons nach Belieben, Menge nicht angegeben."]);
    // 20k input × 5 + 5k output × 30 per million on gpt-5.5.
    expect(result.usage).toEqual({ ...usage, costUsd: 0.25 });
    expect(calls[0]?.system).toContain("# Role and goal");
    expect(calls[0]?.user).toContain("# Kürbis-Linsen-Suppe");
    expect(calls[0]?.jsonSchema).toHaveProperty("properties.servingSize");
    expect(calls[0]?.feedback).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("feeds the errors back and accepts the corrected recipe", async () => {
    const wrong = soupWith((_, step) => {
      step(4).speed = 5;
    });
    const { generator, calls } = fakeGenerator([wrong, soup]);
    const result = await converter(generator).convert(request);
    expect(result.attempts).toBe(2);
    expect(calls[1]?.system).toBe(calls[0]?.system);
    expect(calls[1]?.user).toBe(calls[0]?.user);
    expect(calls[1]?.feedback?.errors).toEqual([
      expect.objectContaining({ path: "servingSize.steps[4].speed" }),
    ]);
    expect(calls[1]?.feedback?.previousJson).toBe(wrong);
    expect(result.usage.inputTokens).toBe(40_000);
    expect(result.usage.outputTokens).toBe(10_000);
    expect(result.usage.costUsd).toBe(0.5);
    expect(result.corrections).toEqual([
      {
        attempt: 1,
        errors: [expect.objectContaining({ path: "servingSize.steps[4].speed" })],
      },
    ]);
  });

  it("reports plausibility errors and keeps warnings apart from the review hints", async () => {
    const tooShort = soupWith((recipe, step) => {
      const steps = recipe.servingSize.steps;
      // Fill 1000 g of stock first, so the first heating has to bring it to the boil.
      steps.splice(3, 0, {
        kind: "scale",
        title: "1000 g Gemüsebrühe",
        description: "1000 g Gemüsebrühe einwiegen.",
        grams: 1000,
      });
      steps.splice(7, 1);
      step(5).minutes = 1;
    });
    const roastLow = soupWith((recipe) => {
      recipe.servingSize.steps[4] = {
        kind: "roasting",
        title: "Anbraten",
        temperature: 100,
        minutes: 3,
        seconds: 0,
      };
    });
    const { generator, calls } = fakeGenerator([tooShort, roastLow]);
    const result = await converter(generator).convert(request);
    expect(calls[1]?.feedback?.errors.map((error) => error.path)).toContain(
      "servingSize.steps[5].minutes",
    );
    expect(result.warnings).toEqual([expect.stringContaining("110-130 °C")]);
    // The review hints are the model's German notes as the recipe carries them.
    expect(result.reviewHints).toEqual(["Croûtons nach Belieben, Menge nicht angegeben."]);
  });

  it("asks again when the answer is not JSON and checks category ids", async () => {
    const unknownCategory = soupWith((recipe) => {
      recipe.categoryIds = [999999];
    });
    const { generator, calls } = fakeGenerator(["Here is your recipe!", unknownCategory, soup]);
    const result = await converter(generator).convert(request);
    expect(result.attempts).toBe(3);
    expect(calls[1]?.feedback?.errors[0]?.path).toBe("(answer)");
    expect(calls[1]?.feedback?.previousJson).toBe("Here is your recipe!");
    expect(calls[2]?.feedback?.errors[0]?.path).toBe("categoryIds[0]");
  });

  it("offers only the default category ids without a catalog", async () => {
    const unknownCategory = soupWith((recipe) => {
      recipe.categoryIds = [999999];
    });
    const { generator, calls } = fakeGenerator([unknownCategory, soup]);
    const result = await converter(generator, {
      categories: [],
      defaultCategoryIds: [228],
    }).convert(request);
    expect(result.attempts).toBe(2);
    expect(calls[0]?.user).toContain("- 228: Default category");
    expect(calls[1]?.feedback?.errors[0]?.path).toBe("categoryIds[0]");
    expect(result.warnings[0]).toContain("No category list was available");
  });

  it("refuses to start without a catalog or default category ids", () => {
    const { generator } = fakeGenerator([]);
    expect(() => converter(generator, { categories: [] })).toThrow(/must not guess category ids/);
  });

  it("sends the same system prompt for every recipe", async () => {
    const { generator, calls } = fakeGenerator([soup, soup]);
    const convert = converter(generator);
    await convert.convert(request);
    await convert.convert({ ...request, title: "Linsensuppe", rendered: "# Linsensuppe\n" });
    expect(calls[1]?.system).toBe(calls[0]?.system);
    expect(calls[1]?.user).not.toBe(calls[0]?.user);
  });

  it("prices each attempt of a server-side fallback at its own model", async () => {
    const part = { inputTokens: 10_000, outputTokens: 1_000 };
    const { generator } = fakeGenerator([
      {
        json: soup,
        usage: { inputTokens: 20_000, outputTokens: 2_000 },
        model: "claude-opus-4-8",
        attempts: [
          { model: "claude-opus-5-5", usage: part },
          { model: "claude-opus-4-8", usage: part },
        ],
      },
    ]);
    const result = await converter(generator).convert(request);
    // 10k × 4 + 1k × 20 on Opus 5.5, 10k × 5 + 1k × 25 on Opus 4.8, per million.
    expect(result.usage.costUsd).toBe(0.135);
  });

  it("throws ConversionFailedError with the last errors when the rounds are used up", async () => {
    const wrong = soupWith((_, step) => {
      step(4).speed = 5;
    });
    const { generator, generate } = fakeGenerator([wrong, wrong, wrong]);
    const { log, info, warn } = logger();
    const failure = await converter(generator, { maxCorrections: 2, logger: log })
      .convert(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    const error = failure as ConversionFailedError;
    expect(generate).toHaveBeenCalledTimes(3);
    expect(error.attempts).toBe(3);
    expect(error.errors[0]?.path).toBe("servingSize.steps[4].speed");
    expect(error.usage).toEqual({
      inputTokens: 60_000,
      cachedInputTokens: 0,
      outputTokens: 15_000,
      costUsd: 0.75,
    });
    expect(error.lastJson).toBe(wrong);
    expect(error.message).toContain("after 3 attempts");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(info).not.toHaveBeenCalled();
  });

  it("aggregates cache usage and leaves the cost out for an unpriced model", async () => {
    const { generator } = fakeGenerator([
      { json: "nope", usage: { inputTokens: 100, outputTokens: 10 } },
      {
        json: soup,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          cacheWriteInputTokens: 20,
          outputTokens: 10,
        },
        model: "home-model",
      },
    ]);
    const result = await converter(generator).convert(request);
    expect(result.usage).toEqual({
      inputTokens: 200,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 20,
      outputTokens: 20,
    });
    expect(result.model).toBe("home-model");
  });

  it("stops on an aborted signal", async () => {
    const { generator, generate } = fakeGenerator([soup]);
    const controller = new AbortController();
    controller.abort(new Error("job cancelled"));
    await expect(
      converter(generator).convert(request, { signal: controller.signal }),
    ).rejects.toThrow("job cancelled");
    expect(generate).not.toHaveBeenCalled();
  });

  it("passes the signal to the generator and stops when it fires during a call", async () => {
    const controller = new AbortController();
    const generator: RecipeGenerator = {
      provider: "fake",
      model: "m",
      generate: (_input, opts) => {
        expect(opts?.signal).toBe(controller.signal);
        controller.abort();
        return Promise.reject(new Error("request aborted by the SDK"));
      },
    };
    const failure = await converter(generator)
      .convert(request, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toHaveProperty("name", "AbortError");
  });

  it("lets provider errors through and logs them", async () => {
    const { generator } = fakeGenerator([new LlmRefusalError("fake", "no")]);
    const { log, info, warn } = logger();
    await expect(converter(generator, { logger: log }).convert(request)).rejects.toThrow(
      LlmRefusalError,
    );
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      "conversion stopped by a provider error",
    );
  });

  it("names the job in its log lines", async () => {
    const { generator } = fakeGenerator([soup]);
    const { log, info } = logger();
    await converter(generator, { logger: log }).convert(request, { jobId: "job-7" });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-7", attempt: 1 }),
      "recipe converted",
    );
    const plain = logger();
    await converter(fakeGenerator([soup]).generator, { logger: plain.log }).convert(request);
    expect(plain.info.mock.calls[0]?.[0]).not.toHaveProperty("jobId");
  });

  it("takes the bridge logger", async () => {
    const { generator } = fakeGenerator([soup]);
    const log: ConverterLogger = pino(loggerOptions("silent"));
    expect((await converter(generator, { logger: log }).convert(request)).attempts).toBe(1);
  });

  it("rejects a negative number of correction rounds", () => {
    const { generator } = fakeGenerator([]);
    expect(() => converter(generator, { maxCorrections: -1 })).toThrow(RangeError);
  });
});
