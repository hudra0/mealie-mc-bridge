// Anthropic generator: structured output through messages.parse with the JSON Schema the
// loop passes in (recipeInputJsonSchema with the loaded limits), converted by the SDK's
// transformJSONSchema into the subset structured outputs accept. The system prompt is the
// same for every recipe and one cached block, so later recipes and correction rounds read
// it from the prompt cache. Thinking stays at the model's adaptive default; the effort is
// set explicitly. Server-side fallbacks are switched on for the models that support them,
// so a policy decline is retried on the provider's fallback model inside the same call.
//
// Fallbacks live on the beta messages namespace, so the beta parse() is used. The format's
// parse callback is lenient: a recipe that breaks a limit must reach the validator, which
// turns it into a correction round, instead of failing inside the SDK.

import Anthropic from "@anthropic-ai/sdk";
import type { ParsedBetaMessage } from "@anthropic-ai/sdk/lib/beta-parser";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
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

export interface RecipeOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
  parse(content: string): unknown;
}

// Drops the safe-integer bounds zod adds to every integer: they say nothing and would
// end up as noise in the descriptions.
function withoutSafeIntegerBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutSafeIntegerBounds);
  if (node === null || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    result[key] = withoutSafeIntegerBounds(value);
  }
  return result;
}

type SchemaNode = Record<string, unknown>;
const isNode = (value: unknown): value is SchemaNode =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Visits the subschemas transformJSONSchema keeps, with a path that names oneOf as anyOf
// (the transform renames it), so the same path finds a node before and after.
function mapSchema(
  node: SchemaNode,
  path: string,
  visit: (node: SchemaNode, path: string) => SchemaNode,
): SchemaNode {
  const copy = visit({ ...node }, path);
  for (const key of ["properties", "$defs"]) {
    const children = copy[key];
    if (isNode(children)) {
      copy[key] = Object.fromEntries(
        Object.entries(children).map(([name, child]) => [
          name,
          isNode(child) ? mapSchema(child, `${path}/${key}/${name}`, visit) : child,
        ]),
      );
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = copy[key];
    if (Array.isArray(variants)) {
      const named = key === "oneOf" ? "anyOf" : key;
      copy[key] = variants.map((child: unknown, i) =>
        isNode(child) ? mapSchema(child, `${path}/${named}/${i}`, visit) : child,
      );
    }
  }
  if (isNode(copy.items)) copy.items = mapSchema(copy.items, `${path}/items`, visit);
  return copy;
}

// transformJSONSchema moves enum and const into descriptions, but structured outputs
// enforce both: they are taken out before the transform and put back after it.
function keepEnums(schema: SchemaNode): SchemaNode {
  const kept = new Map<string, SchemaNode>();
  const stripped = mapSchema(schema, "", (node, path) => {
    const values: SchemaNode = {};
    for (const key of ["enum", "const"]) {
      if (key in node) {
        values[key] = node[key];
        delete node[key];
      }
    }
    if (Object.keys(values).length > 0) kept.set(path, values);
    return node;
  });
  const transformed = transformJSONSchema(stripped);
  return mapSchema(transformed, "", (node, path) => ({ ...node, ...kept.get(path) }));
}

// A JSON Schema as an output format whose parse never throws: invalid JSON gives null.
// Keywords structured outputs do not enforce (lengths, ranges) move into descriptions;
// enum and const stay.
export function recipeOutputFormat(jsonSchema: object): RecipeOutputFormat {
  const schema = withoutSafeIntegerBounds(jsonSchema) as SchemaNode;
  delete schema.$schema;
  return {
    type: "json_schema",
    schema: keepEnums(schema),
    parse: (content: string): unknown => {
      try {
        return JSON.parse(content) as unknown;
      } catch {
        return null;
      }
    },
  };
}

type Usage = GenerationOutput["usage"];

function usageOf(entry: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage {
  const cacheRead = entry.cache_read_input_tokens ?? 0;
  const cacheWrite = entry.cache_creation_input_tokens ?? 0;
  const usage: Usage = {
    inputTokens: entry.input_tokens + cacheRead + cacheWrite,
    outputTokens: entry.output_tokens,
    cachedInputTokens: cacheRead,
  };
  if (cacheWrite > 0) usage.cacheWriteInputTokens = cacheWrite;
  return usage;
}

function sumUsage(entries: readonly Usage[]): Usage {
  const total: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let written = 0;
  for (const entry of entries) {
    total.inputTokens += entry.inputTokens;
    total.outputTokens += entry.outputTokens;
    total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (entry.cachedInputTokens ?? 0);
    written += entry.cacheWriteInputTokens ?? 0;
  }
  if (written > 0) total.cacheWriteInputTokens = written;
  return total;
}

export class AnthropicGenerator implements RecipeGenerator {
  readonly provider = "anthropic";
  readonly model: string;
  private readonly client: AnthropicMessagesClient;
  private readonly effort: AnthropicEffort;
  private readonly maxTokens: number;
  private readonly formats = new WeakMap<object, RecipeOutputFormat>();

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

  private outputFormat(schema: object): RecipeOutputFormat {
    let format = this.formats.get(schema);
    if (!format) {
      format = recipeOutputFormat(schema);
      this.formats.set(schema, format);
    }
    return format;
  }

  async generate(
    input: GenerationInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GenerationOutput> {
    const format = this.outputFormat(input.jsonSchema);
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
    // After a server-side fallback the top-level usage covers only the attempt that
    // answered; usage.iterations lists every billed attempt with its model.
    const iterations = message.usage.iterations ?? [];
    const attempts = iterations.some((entry) => entry.type === "fallback_message")
      ? iterations.flatMap((entry) =>
          entry.type === "message" || entry.type === "fallback_message"
            ? [{ model: entry.model ?? this.model, usage: usageOf(entry) }]
            : [],
        )
      : [];
    const usage =
      attempts.length > 0
        ? sumUsage(attempts.map((attempt) => attempt.usage))
        : usageOf(message.usage);

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
    return { json, usage, model: message.model, ...(attempts.length > 0 ? { attempts } : {}) };
  }
}
