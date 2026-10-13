import { fileURLToPath } from "node:url";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { describe, expect, it, vi } from "vitest";
import { loadDeviceLimits } from "../../recipe/limits.js";
import { recipeInputJsonSchema } from "../../recipe/schema.js";
import { LlmOutputTruncatedError, LlmRefusalError } from "../errors.js";
import {
  OPENAI_SCHEMA_NAME,
  OpenAIGenerator,
  prepareStrictSchema,
  stripNulls,
  type OpenAIResponse,
  type OpenAIResponsesClient,
} from "./openai.js";

const limits = await loadDeviceLimits(
  fileURLToPath(new URL("../../../knowledge/device-programs.json", import.meta.url)),
);

type Node = Record<string, unknown>;

// Every node of a schema, so a test can check a property on all of them.
function nodes(value: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(value)) value.forEach((item) => nodes(item, found));
  else if (value !== null && typeof value === "object") {
    found.push(value as Node);
    Object.values(value).forEach((item) => nodes(item, found));
  }
  return found;
}

describe("prepareStrictSchema", () => {
  it("closes every object and makes every property required", () => {
    const strict = prepareStrictSchema(recipeInputJsonSchema(limits));
    const objects = nodes(strict).filter((node) => node.type === "object");
    expect(objects.length).toBeGreaterThan(10);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as Node));
    }
    const keys = new Set(nodes(strict).flatMap((node) => Object.keys(node)));
    for (const dropped of ["$schema", "$ref", "const", "oneOf", "default"]) {
      expect(keys.has(dropped), dropped).toBe(false);
    }
  });

  it("makes optional properties nullable, turns const into enum and oneOf into anyOf", () => {
    const strict = prepareStrictSchema({
      type: "object",
      properties: {
        kind: { const: "text" },
        note: { type: "string", default: "", examples: ["x"] },
        list: { type: "array", items: { type: "string" }, uniqueItems: true },
        choice: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["kind", "list", "choice"],
      if: {},
      then: {},
      else: {},
      patternProperties: {},
    });
    expect(strict).toEqual({
      type: "object",
      properties: {
        kind: { enum: ["text"] },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        list: { type: "array", items: { type: "string" } },
        choice: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["kind", "note", "list", "choice"],
      additionalProperties: false,
    });
  });

  it("inlines $ref from $defs and definitions", () => {
    const strict = prepareStrictSchema({
      $defs: {
        step: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
      definitions: { name: { type: "string", minLength: 1 } },
      type: "object",
      properties: {
        step: { $ref: "#/$defs/step" },
        name: { $ref: "#/definitions/name", description: "d" },
      },
      required: ["step", "name"],
    });
    expect(strict.properties).toEqual({
      step: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      name: { type: "string", minLength: 1, description: "d" },
    });
    expect(JSON.stringify(strict)).not.toContain("$ref");
  });

  it("refuses references it cannot inline", () => {
    expect(() => prepareStrictSchema({ $ref: "#/$defs/missing" })).toThrow("Cannot resolve $ref");
    expect(() =>
      prepareStrictSchema({
        $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
        $ref: "#/$defs/node",
      }),
    ).toThrow("Recursive $ref");
  });
});

describe("stripNulls", () => {
  it("removes null properties at any depth", () => {
    expect(stripNulls({ a: null, b: [{ c: null, d: 1 }], e: { f: null } })).toEqual({
      b: [{ d: 1 }],
      e: {},
    });
  });
});

// Overrides may set a field to undefined, as the API leaves usage out on some responses.
const response = (
  overrides: { [K in keyof OpenAIResponse]?: OpenAIResponse[K] | undefined } = {},
): OpenAIResponse =>
  ({
    output_text: '{"title":"Suppe","reviewHints":null}',
    output: [],
    status: "completed",
    incomplete_details: null,
    error: null,
    model: "gpt-5.5-2026-04-23",
    usage: {
      input_tokens: 12_000,
      input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 0 },
      output_tokens: 3_000,
      output_tokens_details: { reasoning_tokens: 1_000 },
      total_tokens: 15_000,
    },
    ...overrides,
  }) as OpenAIResponse;

function fakeClient(answer: OpenAIResponse) {
  const create = vi.fn<OpenAIResponsesClient["responses"]["create"]>(() => Promise.resolve(answer));
  return { client: { responses: { create } }, create };
}

const input = {
  system: "SYSTEM",
  user: "USER",
  jsonSchema: recipeInputJsonSchema(limits),
};

describe("OpenAIGenerator", () => {
  it("sends instructions, input and the strict schema through the Responses API", async () => {
    const { client, create } = fakeClient(response());
    const generator = new OpenAIGenerator({ model: "gpt-5.5", reasoningEffort: "medium", client });
    const signal = new AbortController().signal;
    const output = await generator.generate(input, { signal });

    const [body, options] = create.mock.calls[0] as [
      ResponseCreateParamsNonStreaming,
      { signal?: AbortSignal },
    ];
    expect(body).toMatchObject({
      model: "gpt-5.5",
      instructions: "SYSTEM",
      input: "USER",
      reasoning: { effort: "medium" },
      max_output_tokens: 16000,
      store: false,
    });
    expect(body.text?.format).toMatchObject({
      type: "json_schema",
      name: OPENAI_SCHEMA_NAME,
      strict: true,
    });
    expect(body.text?.format).toHaveProperty("schema", prepareStrictSchema(input.jsonSchema));
    expect(options.signal).toBe(signal);
    expect(output).toEqual({
      json: '{"title":"Suppe"}',
      usage: { inputTokens: 12_000, outputTokens: 3_000, cachedInputTokens: 8_000 },
      model: "gpt-5.5-2026-04-23",
    });
    expect(generator.provider).toBe("openai");
  });

  it("appends the correction section and reuses the prepared schema", async () => {
    const { client, create } = fakeClient(response());
    const generator = new OpenAIGenerator({ model: "gpt-5.5", reasoningEffort: "high", client });
    const feedback = { errors: [{ path: "title", message: "too long" }], previousJson: "{}" };
    await generator.generate({ ...input, feedback });
    await generator.generate(input);
    const first = create.mock.calls[0]?.[0];
    const second = create.mock.calls[1]?.[0];
    expect(first?.input).toContain("USER\n\n# Correction");
    expect(first?.input).toContain("1. title: too long");
    const schemaOf = (body: ResponseCreateParamsNonStreaming | undefined) =>
      (body?.text?.format as { schema?: unknown } | undefined)?.schema;
    expect(schemaOf(first)).toBe(schemaOf(second));
  });

  it("tolerates a code fence and maps cache writes", async () => {
    const usage = response().usage;
    const { client } = fakeClient(
      response({
        output_text: '```json\n{"a":1}\n```',
        usage: usage && {
          ...usage,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 500 },
        },
      }),
    );
    const output = await new OpenAIGenerator({
      model: "m",
      reasoningEffort: "low",
      client,
    }).generate(input);
    expect(output.json).toBe('{"a":1}');
    expect(output.usage).toEqual({
      inputTokens: 12_000,
      outputTokens: 3_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 500,
    });
  });

  it("passes text that is not JSON through for the loop to report", async () => {
    const { client } = fakeClient(response({ output_text: "sorry", usage: undefined }));
    const output = await new OpenAIGenerator({
      model: "m",
      reasoningEffort: "low",
      client,
    }).generate(input);
    expect(output).toMatchObject({ json: "sorry", usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("turns refusals, truncation and failures into errors", async () => {
    const generate = (answer: OpenAIResponse) =>
      new OpenAIGenerator({
        model: "m",
        reasoningEffort: "low",
        client: fakeClient(answer).client,
      }).generate(input);
    const refusal = response({
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "cannot help" }],
        },
      ],
    });
    await expect(generate(refusal)).rejects.toThrow(LlmRefusalError);
    await expect(generate(refusal)).rejects.toThrow("cannot help");
    await expect(
      generate(
        response({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
      ),
    ).rejects.toThrow(LlmOutputTruncatedError);
    await expect(
      generate(
        response({ status: "incomplete", incomplete_details: { reason: "content_filter" } }),
      ),
    ).rejects.toThrow(/refused the request \(content_filter\)/);
    await expect(
      generate(response({ status: "failed", error: { code: "server_error", message: "boom" } })),
    ).rejects.toThrow("The OpenAI response failed: boom");
  });

  it("builds its own SDK client when none is passed", () => {
    const generator = new OpenAIGenerator({
      model: "gpt-5.5",
      reasoningEffort: "medium",
      apiKey: "test-key",
    });
    expect(generator.model).toBe("gpt-5.5");
  });
});
