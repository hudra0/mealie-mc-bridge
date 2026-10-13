// OpenAI generator: the Responses API with strict structured output. The recipe JSON
// Schema is prepared for strict mode once per schema object and sent as text.format; the
// system prompt goes into instructions, the user message (with the correction section on
// a correction round) into input.

import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";
import { LlmOutputTruncatedError, LlmRefusalError } from "../errors.js";
import { extractJson } from "../output.js";
import { withFeedback } from "../prompt.js";
import type { OpenAIReasoningEffort } from "../settings.js";
import type { GenerationInput, GenerationOutput, RecipeGenerator } from "../types.js";

export { OPENAI_REASONING_EFFORTS, type OpenAIReasoningEffort } from "../settings.js";

export const OPENAI_MAX_OUTPUT_TOKENS = 16000;
export const OPENAI_SCHEMA_NAME = "mc_recipe";

export type OpenAIResponse = Pick<
  Response,
  "output_text" | "output" | "status" | "incomplete_details" | "error" | "usage" | "model"
>;

// The part of the SDK client the generator calls. Tests pass a fake.
export interface OpenAIResponsesClient {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<OpenAIResponse>;
  };
}

export interface OpenAIGeneratorOptions {
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
  apiKey?: string;
  maxOutputTokens?: number;
  client?: OpenAIResponsesClient;
}

type JsonNode = Record<string, unknown>;

// Keywords strict mode rejects or ignores. Validation of what they expressed happens in
// the validator, so nothing is lost by dropping them here.
const DROPPED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "$comment",
  "default",
  "examples",
  "uniqueItems",
  "if",
  "then",
  "else",
  "patternProperties",
]);

const isNode = (value: unknown): value is JsonNode =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Prepares a JSON Schema for OpenAI strict mode: inlines $ref, turns const into a
// one-value enum and oneOf into anyOf, drops unsupported keywords, and makes every object
// closed with all properties required. A property that was optional becomes nullable, so
// the model can still leave it out by sending null (stripNulls removes it again).
export function prepareStrictSchema(schema: object): JsonNode {
  const root = structuredClone(schema) as JsonNode;
  const defs: Record<string, unknown> = {
    ...(isNode(root.definitions) ? root.definitions : {}),
    ...(isNode(root.$defs) ? root.$defs : {}),
  };

  const transform = (value: unknown, refs: readonly string[]): unknown => {
    if (Array.isArray(value)) return value.map((item) => transform(item, refs));
    if (!isNode(value)) return value;
    const { $ref, ...rest } = value;
    if (typeof $ref === "string") {
      const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec($ref)?.[1];
      const target = name === undefined ? undefined : defs[name];
      if (name === undefined || !isNode(target)) throw new Error(`Cannot resolve $ref ${$ref}`);
      if (refs.includes(name)) throw new Error(`Recursive $ref ${$ref} cannot be inlined`);
      return transform({ ...target, ...rest }, [...refs, name]);
    }
    const out: JsonNode = {};
    for (const [key, item] of Object.entries(rest)) {
      if (DROPPED_KEYWORDS.has(key)) continue;
      if (key === "const") {
        if (!("enum" in rest)) out.enum = [item];
      } else if (key === "oneOf") {
        out.anyOf = transform(item, refs);
      } else if (key === "properties" && isNode(item)) {
        out.properties = Object.fromEntries(
          Object.entries(item).map(([name, property]) => [name, transform(property, refs)]),
        );
      } else {
        out[key] = transform(item, refs);
      }
    }
    if (out.type === "object" || isNode(out.properties)) {
      const properties = isNode(out.properties) ? out.properties : {};
      const required = new Set(Array.isArray(rest.required) ? (rest.required as unknown[]) : []);
      for (const [name, property] of Object.entries(properties)) {
        if (!required.has(name)) properties[name] = { anyOf: [property, { type: "null" }] };
      }
      out.properties = properties;
      out.required = Object.keys(properties);
      out.additionalProperties = false;
    }
    return out;
  };
  return transform(root, []) as JsonNode;
}

// Removes object properties whose value is null: the strict schema's stand-in for an
// optional field the model left out.
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isNode(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, stripNulls(item)]),
  );
}

function refusalOf(response: OpenAIResponse): string | null {
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "refusal") return part.refusal;
    }
  }
  return null;
}

export class OpenAIGenerator implements RecipeGenerator {
  readonly provider = "openai";
  readonly model: string;
  private readonly client: OpenAIResponsesClient;
  private readonly reasoningEffort: OpenAIReasoningEffort;
  private readonly maxOutputTokens: number;
  private readonly schemas = new WeakMap<object, JsonNode>();

  constructor(options: OpenAIGeneratorOptions) {
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.maxOutputTokens = options.maxOutputTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
    if (options.client) {
      this.client = options.client;
    } else {
      // The key goes to the SDK and nowhere else.
      const sdk = new OpenAI({ apiKey: options.apiKey ?? null });
      this.client = {
        responses: { create: (body, requestOptions) => sdk.responses.create(body, requestOptions) },
      };
    }
  }

  private strictSchema(schema: object): JsonNode {
    let prepared = this.schemas.get(schema);
    if (!prepared) {
      prepared = prepareStrictSchema(schema);
      this.schemas.set(schema, prepared);
    }
    return prepared;
  }

  async generate(
    input: GenerationInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GenerationOutput> {
    const body: ResponseCreateParamsNonStreaming = {
      model: this.model,
      instructions: input.system,
      input: withFeedback(input.user, input.feedback),
      text: {
        format: {
          type: "json_schema",
          name: OPENAI_SCHEMA_NAME,
          strict: true,
          schema: this.strictSchema(input.jsonSchema),
        },
      },
      reasoning: { effort: this.reasoningEffort },
      max_output_tokens: this.maxOutputTokens,
      // The bridge never reads a response back, so OpenAI need not keep it.
      store: false,
    };
    const response = await this.client.responses.create(
      body,
      opts.signal ? { signal: opts.signal } : {},
    );
    const details = response.usage?.input_tokens_details;
    const usage: GenerationOutput["usage"] = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cachedInputTokens: details?.cached_tokens ?? 0,
    };
    if (details?.cache_write_tokens) usage.cacheWriteInputTokens = details.cache_write_tokens;

    const refusal = refusalOf(response);
    if (refusal !== null) throw new LlmRefusalError(this.provider, refusal);
    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason;
      if (reason === "content_filter")
        throw new LlmRefusalError(this.provider, null, "content_filter");
      throw new LlmOutputTruncatedError(this.provider, this.maxOutputTokens, usage);
    }
    if (response.status === "failed") {
      throw new Error(
        `The OpenAI response failed: ${response.error?.message ?? "no reason given"}`,
      );
    }

    const text = extractJson(response.output_text);
    let json = text;
    try {
      json = JSON.stringify(stripNulls(JSON.parse(text)));
    } catch {
      // Not JSON: the loop reports it to the model as an error.
    }
    return { json, usage, model: response.model };
  }
}
