// Anthropic generator: structured output through messages.parse with the recipe's zod
// schema. The system prompt is one cached block, so correction rounds read it from the
// prompt cache. Thinking stays at the model's adaptive default; the effort is set
// explicitly. Server-side fallbacks are switched on for the models that support them, so
// a policy decline is retried on the provider's fallback model inside the same call.
//
// Fallbacks live on the beta messages namespace, so the beta parse() and the matching
// betaZodOutputFormat() are used. Its parse callback is replaced by a lenient one: a
// recipe that breaks a schema refinement must reach the validator, which turns it into a
// correction round, instead of failing inside the SDK.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ParsedBetaMessage } from "@anthropic-ai/sdk/lib/beta-parser";
import { RecipeInputSchema } from "../../recipe/schema.js";
import { LlmOutputTruncatedError, LlmRefusalError } from "../errors.js";
import { withFeedback } from "../prompt.js";
import { DEFAULT_ANTHROPIC_EFFORT, type AnthropicEffort } from "../settings.js";
import type { GenerationInput, GenerationOutput, RecipeGenerator } from "../types.js";

export const ANTHROPIC_MAX_TOKENS = 16000;
export { ANTHROPIC_EFFORTS, type AnthropicEffort } from "../settings.js";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Models that accept fallbacks: "default" on the Claude API.
export const FALLBACK_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
] as const;

export function supportsFallbacks(model: string): boolean {
  const base = model.replace(/-\d{8}$/, "");
  return (FALLBACK_MODELS as readonly string[]).includes(base);
}

export type AnthropicParseParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type AnthropicParsedMessage = Pick<
  ParsedBetaMessage<unknown>,
  "content" | "parsed_output" | "stop_reason" | "stop_details" | "usage" | "model"
>;

// The part of the SDK client the generator calls. Tests pass a fake.
export interface AnthropicMessagesClient {
  beta: {
    messages: {
      parse(
        params: AnthropicParseParams,
        options?: { signal?: AbortSignal },
      ): PromiseLike<AnthropicParsedMessage>;
    };
  };
}

export interface AnthropicGeneratorOptions {
  model: string;
  apiKey?: string;
  effort?: AnthropicEffort;
  maxTokens?: number;
  client?: AnthropicMessagesClient;
}

let format: ReturnType<typeof recipeOutputFormat> | undefined;

// The recipe schema as an output format whose parse never throws: invalid JSON gives null.
export function recipeOutputFormat() {
  return {
    ...betaZodOutputFormat(RecipeInputSchema),
    parse: (content: string): unknown => {
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return null;
      }
    },
  };
}

export class AnthropicGenerator implements RecipeGenerator {
  readonly provider = "anthropic";
  readonly model: string;
  private readonly client: AnthropicMessagesClient;
  private readonly effort: AnthropicEffort;
  private readonly maxTokens: number;

  constructor(options: AnthropicGeneratorOptions) {
    this.model = options.model;
    this.effort = options.effort ?? DEFAULT_ANTHROPIC_EFFORT;
    this.maxTokens = options.maxTokens ?? ANTHROPIC_MAX_TOKENS;
    if (options.client) {
      this.client = options.client;
    } else {
      // The key goes to the SDK and nowhere else.
      const sdk = new Anthropic({ apiKey: options.apiKey ?? null });
      this.client = {
        beta: {
          messages: {
            parse: (params, requestOptions) => sdk.beta.messages.parse(params, requestOptions),
          },
        },
      };
    }
  }

  async generate(
    input: GenerationInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GenerationOutput> {
    format ??= recipeOutputFormat();
    const params: AnthropicParseParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: withFeedback(input.user, input.feedback) }],
      output_config: { format, effort: this.effort },
      ...(supportsFallbacks(this.model)
        ? { betas: [FALLBACK_BETA], fallbacks: "default" as const }
        : {}),
    };
    const message = await this.client.beta.messages.parse(
      params,
      opts.signal ? { signal: opts.signal } : {},
    );
    const cacheRead = message.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
    const usage: GenerationOutput["usage"] = {
      inputTokens: message.usage.input_tokens + cacheRead + cacheWrite,
      outputTokens: message.usage.output_tokens,
      cachedInputTokens: cacheRead,
    };
    if (cacheWrite > 0) usage.cacheWriteInputTokens = cacheWrite;

    if (message.stop_reason === "refusal") {
      throw new LlmRefusalError(
        this.provider,
        message.stop_details?.explanation ?? null,
        message.stop_details?.category ?? null,
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new LlmOutputTruncatedError(this.provider, this.maxTokens, usage);
    }
    // After a fallback the answer can span text blocks; joined, they still form the JSON.
    const json =
      message.parsed_output !== null && message.parsed_output !== undefined
        ? JSON.stringify(message.parsed_output)
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return { json, usage, model: message.model };
  }
}
