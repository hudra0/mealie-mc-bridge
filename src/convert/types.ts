// The converter's contract: what goes in (a rendered Mealie recipe with its scaled
// ingredients), what comes out (a validated RecipeInput plus usage and hints), and the
// provider interface each LLM implementation fulfils. The service layer depends on these
// names only.

import type { NormalizedIngredient } from "../ingredients/index.js";
import type { RecipeInput } from "../recipe/schema.js";
import type { ValidationIssue } from "../recipe/validate.js";

export interface ConversionRequest {
  title: string;
  // The recipe as Markdown from renderRecipeForLlm, amounts already scaled, every source
  // ingredient line numbered [i] in the order of ingredients.
  rendered: string;
  // The servings the amounts were scaled to.
  servings: number;
  // The output locale; it must be the converter's (MC_LOCALE).
  locale: string;
  // The scaled ingredients, for the plausibility checks.
  ingredients: NormalizedIngredient[];
  // Category names from Mealie, as hints for the category choice.
  categoryHints?: string[];
  // Catalog names close to source ingredients, offered to the model so it writes names
  // the Monsieur Cuisine catalog knows.
  catalogNames?: CatalogNameHint[];
}

export interface CatalogNameHint {
  // The index of the source ingredient in ingredients.
  index: number;
  // Catalog names, best first.
  names: string[];
}

export interface TokenUsage {
  // All input tokens of the request, cached ones included.
  inputTokens: number;
  outputTokens: number;
  // Input tokens served from the provider's prompt cache.
  cachedInputTokens?: number;
  // Input tokens written to the prompt cache (billed above the input price by Anthropic).
  cacheWriteInputTokens?: number;
  // Estimated from the price table; absent when the model has no price.
  costUsd?: number;
}

// The errors of one answer that went back to the model for a correction.
export interface CorrectionRound {
  // The generator call that gave the answer, 1 for the first one.
  attempt: number;
  errors: ValidationIssue[];
}

export interface ConversionResult {
  recipe: RecipeInput;
  // Generator calls, the first one included.
  attempts: number;
  // The errors of every answer before the accepted one, for tuning and the job log.
  corrections?: CorrectionRound[];
  usage: TokenUsage;
  // Plausibility warnings of the accepted recipe, in English, uncapped: for the bridge's
  // own report (log, Mealie note), not for the recipe.
  warnings: string[];
  // The model's review hints as the recipe carries them: in the output language, within the
  // recipe's limits on count and length.
  reviewHints: string[];
  provider: string;
  model: string;
}

export interface ConvertOptions {
  signal?: AbortSignal;
  // The job the conversion belongs to, for the log lines.
  jobId?: string;
}

export interface Converter {
  convert(req: ConversionRequest, opts?: ConvertOptions): Promise<ConversionResult>;
}

export interface GenerationFeedback {
  errors: ValidationIssue[];
  // The previous answer, so the model can correct it instead of starting over.
  previousJson: string;
}

export interface GenerationInput {
  system: string;
  user: string;
  // JSON Schema of the recipe (recipeInputJsonSchema with the loaded limits). Every
  // provider builds its structured-output format from it; the loop passes the same object
  // for every call, so providers may cache the converted format per object.
  jsonSchema: object;
  feedback?: GenerationFeedback;
}

export interface GenerationOutput {
  // The model's answer: one JSON object as text.
  json: string;
  usage: Omit<TokenUsage, "costUsd">;
  // The model that answered, when the provider reports it (a fallback may differ).
  model?: string;
  // Per-model usage when one call ran several models (a server-side fallback); usage is
  // then their sum, and each attempt is priced at its own model.
  attempts?: { model: string; usage: Omit<TokenUsage, "costUsd"> }[];
}

export interface RecipeGenerator {
  readonly provider: string;
  readonly model: string;
  generate(input: GenerationInput, opts?: { signal?: AbortSignal }): Promise<GenerationOutput>;
}
