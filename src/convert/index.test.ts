import { describe, expect, it, vi } from "vitest";
import { MissingApiKeyError, loadConfig } from "../config.js";
import { AnthropicGenerator, OpenAIGenerator, createGenerator } from "./index.js";

describe("createGenerator", () => {
  it("builds the generator of the configured provider", () => {
    const openai = createGenerator(
      loadConfig({ OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-5.4" }),
    );
    expect(openai).toBeInstanceOf(OpenAIGenerator);
    expect(openai.model).toBe("gpt-5.4");
    const anthropic = createGenerator(
      loadConfig({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key" }),
    );
    expect(anthropic).toBeInstanceOf(AnthropicGenerator);
    expect(anthropic.model).toBe("claude-opus-5-5");
  });

  it("takes a provider override and injected clients", async () => {
    const parse = vi.fn(() =>
      Promise.resolve({
        content: [],
        parsed_output: { title: "x" },
        stop_reason: "end_turn" as const,
        stop_details: null,
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    const config = loadConfig({ OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" });
    const generator = createGenerator(config, {
      provider: "anthropic",
      clients: { anthropic: { beta: { messages: { parse } } } as never },
    });
    await generator.generate({ system: "s", user: "u", jsonSchema: { type: "object" } });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("fails with a clear message when the provider's key is missing", () => {
    expect(() => createGenerator(loadConfig({}))).toThrow(MissingApiKeyError);
    expect(() =>
      createGenerator(loadConfig({ OPENAI_API_KEY: "a" }), { provider: "anthropic" }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});
