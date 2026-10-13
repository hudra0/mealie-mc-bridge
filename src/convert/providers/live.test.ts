// Opt-in checks against the real provider APIs. They run only when the provider's key is
// in the environment and never in CI, because every run costs money:
//
//   OPENAI_API_KEY=... npx vitest run src/convert/providers/live.test.ts
//   ANTHROPIC_API_KEY=... npx vitest run src/convert/providers/live.test.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, type LlmProvider } from "../../config.js";
import { normalizeIngredients, scaleIngredients, servingsFor } from "../../ingredients/index.js";
import { mealieRecipeSchema, renderRecipeForLlm } from "../../mealie/index.js";
import { loadDeviceLimits } from "../../recipe/limits.js";
import { validateRecipeInput } from "../../recipe/validate.js";
import { deLabels } from "../../testing/locale.js";
import { createGenerator } from "../index.js";
import { loadKnowledge } from "../knowledge.js";
import { createConverter } from "../loop.js";

const inCi = Boolean(process.env.CI);

async function convertFixture(provider: LlmProvider) {
  const config = loadConfig(process.env);
  const knowledge = await loadKnowledge(
    fileURLToPath(new URL("../../../knowledge", import.meta.url)),
  );
  const limits = await loadDeviceLimits(
    fileURLToPath(new URL("../../../knowledge/device-programs.json", import.meta.url)),
  );
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const categories = (
    JSON.parse(read("../../../test/fixtures/mc/categories.json")) as {
      data: { categories: { id: number; name: string }[] };
    }
  ).data.categories;
  const recipe = mealieRecipeSchema.parse(
    JSON.parse(read("../../../test/fixtures/mealie/recipe-structured-v3.28.json")),
  );
  const ingredients = scaleIngredients(normalizeIngredients(recipe), 1);
  const servings = servingsFor(recipe, 1, limits.recipe.servings);
  const converter = createConverter({
    generator: createGenerator(config, { provider }),
    knowledge,
    limits,
    categories,
    maxCorrections: config.LLM_MAX_CORRECTIONS,
  });
  const result = await converter.convert({
    title: recipe.name,
    rendered: renderRecipeForLlm(recipe, { scale: 1, servings, ingredients, labels: deLabels }),
    servings,
    locale: "de-DE",
    ingredients,
  });
  const check = validateRecipeInput(result.recipe, limits, {
    knownCategoryIds: categories.map((category) => category.id),
  });
  return { result, check };
}

describe.skipIf(inCi || !process.env.OPENAI_API_KEY)("OpenAI, live", () => {
  it("converts the Mealie fixture into a valid recipe", async () => {
    const { result, check } = await convertFixture("openai");
    expect(check.errors).toEqual([]);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 600_000);
});

describe.skipIf(inCi || !process.env.ANTHROPIC_API_KEY)("Anthropic, live", () => {
  it("converts the Mealie fixture into a valid recipe", async () => {
    const { result, check } = await convertFixture("anthropic");
    expect(check.errors).toEqual([]);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 600_000);
});
