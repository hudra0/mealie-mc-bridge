// The steps between loading a Mealie recipe and uploading the converted one, shared by the
// job pipeline and the admin dry run: ingredients, servings and Markdown; categories;
// the converter request; validation of the converter's answer.

import {
  normalizeIngredients,
  scaleIngredients,
  servingsFor,
  type NormalizedIngredient,
  type ScaledIngredient,
} from "../ingredients/index.js";
import type { McRecipeSink } from "../mc/index.js";
import { renderRecipeForLlm, type MealieRecipe } from "../mealie/index.js";
import type { DeviceLimits } from "../recipe/limits.js";
import type { RecipeInput } from "../recipe/schema.js";
import { validateRecipeInput, type ValidationResult } from "../recipe/validate.js";
import type { SettingsStore } from "../store/settings.js";
import {
  categoryHints,
  loadCategories,
  matchCategories,
  mergeCategoryIds,
  type CategoryCatalog,
  type CategoryMatch,
  type MergedCategories,
} from "./categories.js";
import type { ConversionRequest, ConversionResult } from "./converter-port.js";
import type { IngredientResolverPort } from "./ingredient-resolver.js";
import type { PipelineLocale } from "./locale.js";
import { sourceHash } from "./source-hash.js";

export interface PreparedRecipe {
  normalized: NormalizedIngredient[];
  scaled: ScaledIngredient[];
  servings: number;
  rendered: string;
  hash: string;
}

export function prepareRecipe(
  recipe: MealieRecipe,
  scale: number,
  limits: DeviceLimits,
  locale: Pick<PipelineLocale, "labels" | "pack">,
): PreparedRecipe {
  const normalized = normalizeIngredients(recipe);
  const scaled = scaleIngredients(normalized, scale);
  const servings = servingsFor(recipe, scale, limits.recipe.servings);
  const rendered = renderRecipeForLlm(recipe, {
    scale,
    servings,
    ingredients: scaled,
    labels: locale.labels,
  });
  const hash = sourceHash(recipe, normalized, scale, locale.pack.locale);
  return { normalized, scaled, servings, rendered, hash };
}

export interface CategoryPlan {
  catalog: CategoryCatalog;
  matches: CategoryMatch[];
  hints: string[];
}

export async function planCategories(
  recipe: MealieRecipe,
  mc: Pick<McRecipeSink, "getCategories">,
  settings: SettingsStore,
  locale: Pick<PipelineLocale, "pack" | "categoryWords">,
  options: { now?: () => Date; isSessionError?: (error: unknown) => boolean } = {},
): Promise<CategoryPlan> {
  const catalog = await loadCategories(mc, settings, { ...options, locale: locale.pack.locale });
  const names = [...recipe.recipeCategory, ...recipe.tags].map((item) => item.name);
  const matches = matchCategories(names, catalog.categories, locale.categoryWords);
  return { catalog, matches, hints: categoryHints(catalog.categories, matches) };
}

export function conversionRequest(
  recipe: MealieRecipe,
  prepared: PreparedRecipe,
  plan: CategoryPlan,
  locale: string,
  options: { ingredients?: Pick<IngredientResolverPort, "suggest"> | undefined } = {},
): ConversionRequest {
  const catalogNames = catalogNameHints(prepared.scaled, options.ingredients);
  return {
    title: recipe.name,
    rendered: prepared.rendered,
    servings: prepared.servings,
    locale,
    ingredients: prepared.scaled,
    categoryHints: plan.hints,
    ...(catalogNames.length > 0 ? { catalogNames } : {}),
  };
}

// Catalog names close to each source ingredient, for the source lines that have some.
export function catalogNameHints(
  ingredients: readonly NormalizedIngredient[],
  resolver: Pick<IngredientResolverPort, "suggest"> | undefined,
): { index: number; names: string[] }[] {
  if (!resolver?.suggest || ingredients.length === 0) return [];
  const suggestions = resolver.suggest(ingredients.map((item) => item.food || item.original));
  return suggestions.flatMap((names, index) => (names.length > 0 ? [{ index, names }] : []));
}

export interface CheckedRecipe {
  // The converter's recipe with the merged categories.
  recipe: RecipeInput;
  categories: MergedCategories;
  validation: ValidationResult;
  // The converter's hints and the recipe's own, without duplicates.
  reviewHints: string[];
}

// Puts the matched categories in, drops ids the catalog does not know and validates the
// result against the schema and the device limits.
export function checkConverted(
  result: ConversionResult,
  plan: CategoryPlan,
  limits: DeviceLimits,
): CheckedRecipe {
  const categories = mergeCategoryIds(
    plan.matches.map((match) => match.category.id),
    result.recipe.categoryIds,
    plan.catalog.categories,
    limits.recipe.categories.max,
  );
  const recipe: RecipeInput = { ...result.recipe, categoryIds: categories.ids };
  const validation = validateRecipeInput(recipe, limits, {
    knownCategoryIds: plan.catalog.categories.map((category) => category.id),
  });
  const reviewHints = [
    ...new Set(
      [...result.reviewHints, ...(result.recipe.reviewHints ?? [])]
        .map((hint) => hint.trim())
        .filter(Boolean),
    ),
  ];
  return { recipe: validation.recipe ?? recipe, categories, validation, reviewHints };
}

export function summarizeValidation(validation: ValidationResult, max = 5): string {
  const shown = validation.errors.slice(0, max).map((issue) => `${issue.path}: ${issue.message}`);
  const more = validation.errors.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}
