// The conversion loop: build the prompts, ask the generator, check the answer with the
// validator and the plausibility rules, and feed the errors back until the recipe passes
// or the correction rounds are used up. Warnings never trigger a correction; they reach
// the cook as review hints.

import type { DeviceLimits } from "../recipe/limits.js";
import { RecipeInputSchema, recipeInputJsonSchema } from "../recipe/schema.js";
import { validateRecipeInput, type ValidationIssue } from "../recipe/validate.js";
import { DEFAULT_PRICES, estimateCost, type PriceTable } from "./cost.js";
import { ConversionFailedError } from "./errors.js";
import { selectTechniques, type Knowledge } from "./knowledge.js";
import { deriveTextStepTitles, parseJsonOutput, setLocale, setServingUnit } from "./output.js";
import { buildSystemPrompt, buildUserMessage, usableModes, type Category } from "./prompt.js";
import { checkSanity } from "./sanity.js";
import type {
  ConversionRequest,
  ConversionResult,
  Converter,
  CorrectionRound,
  GenerationFeedback,
  RecipeGenerator,
  TokenUsage,
} from "./types.js";

// The logger calls the loop makes; a pino logger fits.
export interface ConverterLogger {
  info(object: object, message?: string): void;
  warn(object: object, message?: string): void;
}

export interface ConverterOptions {
  generator: RecipeGenerator;
  knowledge: Knowledge;
  limits: DeviceLimits;
  // The live category catalog. Ids outside it are errors. The model cannot know category
  // ids, so an empty catalog needs defaultCategoryIds.
  categories: readonly Category[];
  // Category ids to offer when the catalog is empty (for example a cached or configured
  // default). The model then picks among these ids only, and a warning says so.
  defaultCategoryIds?: readonly number[];
  // Correction rounds after the first attempt.
  maxCorrections?: number;
  logger?: ConverterLogger;
  // Attachments this installation has, for example "food_processor_attachment".
  attachments?: readonly string[];
  maxTechniques?: number;
  prices?: PriceTable;
}

export const DEFAULT_MAX_CORRECTIONS = 3;

const silent: ConverterLogger = { info: () => undefined, warn: () => undefined };

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The conversion was aborted", "AbortError");
}

function addUsage(total: TokenUsage, next: Omit<TokenUsage, "costUsd">): TokenUsage {
  const sum: TokenUsage = {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
  const cached = (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0);
  const written = (total.cacheWriteInputTokens ?? 0) + (next.cacheWriteInputTokens ?? 0);
  if (cached > 0 || total.cachedInputTokens !== undefined || next.cachedInputTokens !== undefined) {
    sum.cachedInputTokens = cached;
  }
  if (written > 0) sum.cacheWriteInputTokens = written;
  return sum;
}

// Validator errors win over a plausibility error on the same field: the model gets one
// message per problem.
function mergeErrors(validation: ValidationIssue[], sanity: ValidationIssue[]): ValidationIssue[] {
  const paths = new Set(validation.map((issue) => issue.path));
  return [...validation, ...sanity.filter((issue) => !paths.has(issue.path))];
}

export function createConverter(options: ConverterOptions): Converter {
  const {
    generator,
    knowledge,
    limits,
    categories,
    logger = silent,
    attachments = [],
    prices = DEFAULT_PRICES,
  } = options;
  const maxCorrections = options.maxCorrections ?? DEFAULT_MAX_CORRECTIONS;
  if (!Number.isInteger(maxCorrections) || maxCorrections < 0) {
    throw new RangeError(
      `maxCorrections must be a whole number of at least 0, got ${maxCorrections}`,
    );
  }
  const defaults = options.defaultCategoryIds ?? [];
  if (categories.length === 0 && defaults.length === 0) {
    throw new RangeError(
      "createConverter needs the category list or defaultCategoryIds: the model must not guess category ids",
    );
  }
  const offered: readonly Category[] =
    categories.length > 0
      ? categories
      : defaults.map((id) => ({ id, name: "Default category (no category list available)" }));
  const categoryWarning =
    categories.length > 0
      ? []
      : [
          `No category list was available; the recipe uses the default category ids ${defaults.join(", ")}. Check the categories in the app.`,
        ];
  const knownCategoryIds = offered.map((c) => c.id);
  const jsonSchema = recipeInputJsonSchema(limits, { locale: knowledge.locale });
  const usable = usableModes(limits, attachments);
  // The same for every recipe, so the providers' prompt caches reuse it across recipes.
  const system = buildSystemPrompt(knowledge, limits, { attachments });

  return {
    async convert(request: ConversionRequest, opts = {}): Promise<ConversionResult> {
      const { signal } = opts;
      const job = opts.jobId ? { jobId: opts.jobId } : {};
      if (request.locale !== knowledge.locale) {
        throw new RangeError(
          `This converter writes ${knowledge.locale} recipes; the request asks for ${request.locale}`,
        );
      }
      const { techniques } = selectTechniques(request, knowledge, options.maxTechniques, usable);
      const user = buildUserMessage(request, offered, {
        techniques,
        usable,
        aliases: knowledge.aliases,
        languageName: knowledge.pack.mc.language,
      });
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let cost: number | undefined = 0;
      let feedback: GenerationFeedback | undefined;
      let model = generator.model;
      let lastErrors: ValidationIssue[] = [];
      let lastJson = "";
      const corrections: CorrectionRound[] = [];

      for (let attempt = 1; attempt <= maxCorrections + 1; attempt++) {
        if (signal?.aborted) throw abortReason(signal);
        let output;
        try {
          output = await generator.generate(
            { system, user, jsonSchema, ...(feedback ? { feedback } : {}) },
            signal ? { signal } : {},
          );
        } catch (error) {
          if (signal?.aborted) throw abortReason(signal);
          logger.warn(
            { ...job, provider: generator.provider, model, attempt, usage },
            "conversion stopped by a provider error",
          );
          throw error;
        }
        model = output.model ?? generator.model;
        usage = addUsage(usage, output.usage);
        const attemptCost = output.attempts
          ? output.attempts.reduce<number | undefined>((sum, part) => {
              const partCost = estimateCost(part.usage, part.model, prices);
              return sum === undefined || partCost === undefined ? undefined : sum + partCost;
            }, 0)
          : estimateCost(output.usage, model, prices);
        cost = cost === undefined || attemptCost === undefined ? undefined : cost + attemptCost;
        lastJson = output.json;

        const parsed = parseJsonOutput(output.json);
        let errors: ValidationIssue[];
        let warnings: string[] = [];
        if (!parsed.ok) {
          errors = [{ path: "(answer)", message: parsed.message }];
        } else {
          lastJson = parsed.text;
          deriveTextStepTitles(parsed.value, limits.recipe.stepTitle.max);
          setLocale(parsed.value, knowledge.locale);
          if (request.servingsSource !== "estimate") {
            setServingUnit(parsed.value, request.servingUnit);
          }
          const validation = validateRecipeInput(parsed.value, limits, {
            knownCategoryIds,
            attachments,
          });
          const typed = RecipeInputSchema.safeParse(parsed.value);
          const sanity = typed.success
            ? checkSanity(typed.data, request, knowledge, limits)
            : { errors: [], warnings: [] };
          warnings = [...categoryWarning, ...sanity.warnings];
          errors = mergeErrors(validation.errors, sanity.errors);
          if (errors.length === 0 && validation.recipe) {
            const total: TokenUsage = cost === undefined ? usage : { ...usage, costUsd: cost };
            logger.info(
              {
                ...job,
                provider: generator.provider,
                model,
                attempt,
                usage: total,
                warnings: warnings.length,
              },
              "recipe converted",
            );
            return {
              recipe: validation.recipe,
              attempts: attempt,
              corrections,
              usage: total,
              warnings,
              reviewHints: [...(validation.recipe.reviewHints ?? [])],
              provider: generator.provider,
              model,
            };
          }
        }
        lastErrors = errors;
        corrections.push({ attempt, errors });
        logger.warn(
          { ...job, provider: generator.provider, model, attempt, errors: errors.length },
          attempt <= maxCorrections
            ? "recipe has errors, asking for a correction"
            : "recipe has errors, giving up",
        );
        feedback = { errors, previousJson: lastJson };
      }

      throw new ConversionFailedError({
        errors: lastErrors,
        attempts: maxCorrections + 1,
        usage: cost === undefined ? usage : { ...usage, costUsd: cost },
        provider: generator.provider,
        model,
        lastJson,
        corrections,
      });
    },
  };
}
