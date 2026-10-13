import { describe, expect, it, vi } from "vitest";
import { LlmOutputTruncatedError, LlmRefusalError } from "../errors.js";
import {
  AnthropicGenerator,
  FALLBACK_BETA,
  recipeOutputFormat,
  supportsFallbacks,
  type AnthropicMessagesClient,
  type AnthropicParsedMessage,
  type AnthropicParseParams,
} from "./anthropic.js";

const message = (overrides: Partial<AnthropicParsedMessage> = {}): AnthropicParsedMessage =>
  ({
    content: [
      {
        type: "text",
        text: '{"title":"Suppe"}',
        citations: null,
        parsed_output: { title: "Suppe" },
      },
    ],
    parsed_output: { title: "Suppe" },
    stop_reason: "end_turn",
    stop_details: null,
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 2_000,
      output_tokens: 4_000,
      cache_read_input_tokens: 15_000,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  }) as AnthropicParsedMessage;

function fakeClient(answer: AnthropicParsedMessage) {
  const parse = vi.fn<AnthropicMessagesClient["beta"]["messages"]["parse"]>(() =>
    Promise.resolve(answer),
  );
  return { client: { beta: { messages: { parse } } }, parse };
}

const input = { system: "SYSTEM", user: "USER", jsonSchema: {} };

describe("AnthropicGenerator", () => {
  it("sends a cached system block, the user message and the structured output format", async () => {
    const { client, parse } = fakeClient(message());
    const generator = new AnthropicGenerator({ model: "claude-opus-5-5", client });
    const signal = new AbortController().signal;
    const output = await generator.generate(input, { signal });

    const [params, options] = parse.mock.calls[0] as [
      AnthropicParseParams,
      { signal?: AbortSignal },
    ];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "USER" }],
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });
    expect(params.output_config?.effort).toBe("high");
    expect(params.output_config?.format).toMatchObject({ type: "json_schema" });
    expect(params.output_config?.format?.schema).toHaveProperty("properties.servingSize");
    for (const key of ["thinking", "tool_choice", "tools", "temperature"])
      expect(params).not.toHaveProperty(key);
    expect(options.signal).toBe(signal);
    expect(output).toEqual({
      json: '{"title":"Suppe"}',
      usage: { inputTokens: 17_000, outputTokens: 4_000, cachedInputTokens: 15_000 },
      model: "claude-opus-5-5",
    });
    expect(generator.provider).toBe("anthropic");
  });

  it("appends the correction section and maps cache writes", async () => {
    const { client, parse } = fakeClient(
      message({
        usage: {
          ...message().usage,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: 15_000,
        },
      }),
    );
    const feedback = { errors: [{ path: "title", message: "too long" }], previousJson: "{}" };
    const output = await new AnthropicGenerator({
      model: "claude-opus-5-5",
      effort: "max",
      client,
    }).generate({
      ...input,
      feedback,
    });
    const params = parse.mock.calls[0]?.[0];
    expect(params?.messages[0]?.content).toContain("USER\n\n# Correction\n");
    expect(params?.output_config?.effort).toBe("max");
    expect(output.usage).toEqual({
      inputTokens: 17_000,
      outputTokens: 4_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 15_000,
    });
  });

  it("leaves fallbacks out for models that do not support them", async () => {
    const { client, parse } = fakeClient(message({ model: "claude-haiku-5-5" }));
    await new AnthropicGenerator({ model: "claude-haiku-5-5", client }).generate(input);
    expect(parse.mock.calls[0]?.[0]).not.toHaveProperty("fallbacks");
    expect(parse.mock.calls[0]?.[0]).not.toHaveProperty("betas");
    expect(supportsFallbacks("claude-sonnet-5-5")).toBe(true);
    expect(supportsFallbacks("claude-opus-5-5-20260401")).toBe(true);
    expect(supportsFallbacks("claude-haiku-5-5")).toBe(false);
  });

  it("joins the text blocks when the answer did not parse", async () => {
    const { client } = fakeClient(
      message({
        parsed_output: null,
        content: [
          { type: "text", text: '{"title":', citations: null, parsed_output: null },
          { type: "text", text: '"Suppe"}', citations: null, parsed_output: null },
        ],
      }),
    );
    const output = await new AnthropicGenerator({ model: "claude-opus-5-5", client }).generate(
      input,
    );
    expect(output.json).toBe('{"title":"Suppe"}');
  });

  it("turns a refusal and a cut-off answer into errors", async () => {
    const refused = fakeClient(
      message({
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      } as Partial<AnthropicParsedMessage>),
    );
    const generator = new AnthropicGenerator({ model: "claude-opus-5-5", client: refused.client });
    await expect(generator.generate(input)).rejects.toThrow(LlmRefusalError);
    await expect(generator.generate(input)).rejects.toThrow("(cyber): declined");
    const truncated = fakeClient(message({ stop_reason: "max_tokens" }));
    await expect(
      new AnthropicGenerator({ model: "claude-opus-5-5", client: truncated.client }).generate(
        input,
      ),
    ).rejects.toThrow(LlmOutputTruncatedError);
  });

  it("builds its own SDK client when none is passed", () => {
    expect(new AnthropicGenerator({ model: "claude-opus-5-5", apiKey: "test-key" }).model).toBe(
      "claude-opus-5-5",
    );
  });
});

describe("recipeOutputFormat", () => {
  it("carries the recipe schema and parses leniently", () => {
    const format = recipeOutputFormat();
    expect(format.type).toBe("json_schema");
    expect(format.schema).toHaveProperty("type", "object");
    expect(format.schema).toHaveProperty("additionalProperties", false);
    expect(format.parse('{"title":""}')).toEqual({ title: "" });
    expect(format.parse("{")).toBeNull();
  });
});
