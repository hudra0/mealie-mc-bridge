import { describe, expect, it } from "vitest";
import { MissingApiKeyError, loadConfig, resolveLlmConfig } from "./config.js";

const defaults = {
  PORT: 3000,
  HOST: "0.0.0.0",
  LOG_LEVEL: "info",
  DEVICE_PROGRAMS_PATH: "./knowledge/device-programs.json",
  LLM_PROVIDER: "openai",
  OPENAI_MODEL: "gpt-5.5",
  OPENAI_REASONING_EFFORT: "medium",
  ANTHROPIC_MODEL: "claude-opus-5-5",
  LLM_MAX_CORRECTIONS: 3,
  KNOWLEDGE_DIR: "./knowledge",
};

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    expect(loadConfig({})).toEqual(defaults);
  });

  it("reads values from the environment", () => {
    const config = loadConfig({
      PORT: "8080",
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      DEVICE_PROGRAMS_PATH: "/etc/bridge/device-programs.json",
      MC_COOKIE: "a=1; b=2",
      LLM_PROVIDER: "anthropic",
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_MODEL: "gpt-5.4",
      OPENAI_REASONING_EFFORT: "high",
      ANTHROPIC_API_KEY: "anthropic-test-key",
      ANTHROPIC_MODEL: "claude-sonnet-5-5",
      LLM_MAX_CORRECTIONS: "1",
      KNOWLEDGE_DIR: "/srv/knowledge",
      LLM_PRICES_JSON: '{"gpt-5.4": {"input": 2.5, "output": 15}}',
    });
    expect(config).toEqual({
      PORT: 8080,
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      DEVICE_PROGRAMS_PATH: "/etc/bridge/device-programs.json",
      MC_COOKIE: "a=1; b=2",
      LLM_PROVIDER: "anthropic",
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_MODEL: "gpt-5.4",
      OPENAI_REASONING_EFFORT: "high",
      ANTHROPIC_API_KEY: "anthropic-test-key",
      ANTHROPIC_MODEL: "claude-sonnet-5-5",
      LLM_MAX_CORRECTIONS: 1,
      KNOWLEDGE_DIR: "/srv/knowledge",
      LLM_PRICES_JSON: '{"gpt-5.4": {"input": 2.5, "output": 15}}',
    });
  });

  it("treats empty values as unset", () => {
    expect(
      loadConfig({
        PORT: "",
        HOST: "",
        LOG_LEVEL: "",
        DEVICE_PROGRAMS_PATH: "",
        MC_COOKIE: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        LLM_PRICES_JSON: "",
      }),
    ).toEqual(defaults);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow(/Invalid configuration: PORT/);
  });

  it("rejects an unknown provider, effort, correction count or price table", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "gemini" })).toThrow(/LLM_PROVIDER/);
    expect(() => loadConfig({ OPENAI_REASONING_EFFORT: "extreme" })).toThrow(
      /OPENAI_REASONING_EFFORT/,
    );
    expect(() => loadConfig({ LLM_MAX_CORRECTIONS: "11" })).toThrow(/LLM_MAX_CORRECTIONS/);
    expect(() => loadConfig({ LLM_PRICES_JSON: "{" })).toThrow(
      /LLM_PRICES_JSON: LLM_PRICES_JSON is not valid JSON/,
    );
  });

  it("never quotes a key in an error", () => {
    expect(() => loadConfig({ OPENAI_API_KEY: "secret-value", PORT: "x" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-value") as unknown }),
    );
  });
});

describe("resolveLlmConfig", () => {
  it("returns the settings of the selected provider", () => {
    expect(resolveLlmConfig(loadConfig({ OPENAI_API_KEY: "k1" }))).toEqual({
      provider: "openai",
      apiKey: "k1",
      model: "gpt-5.5",
      reasoningEffort: "medium",
    });
    const both = loadConfig({ OPENAI_API_KEY: "k1", ANTHROPIC_API_KEY: "k2" });
    expect(resolveLlmConfig(both, "anthropic")).toEqual({
      provider: "anthropic",
      apiKey: "k2",
      model: "claude-opus-5-5",
    });
  });

  it("requires the key of the provider that is used", () => {
    expect(() => resolveLlmConfig(loadConfig({}))).toThrow(MissingApiKeyError);
    expect(() => resolveLlmConfig(loadConfig({}))).toThrow(
      "LLM_PROVIDER is openai, but OPENAI_API_KEY is not set",
    );
    expect(() =>
      resolveLlmConfig(loadConfig({ LLM_PROVIDER: "anthropic", OPENAI_API_KEY: "k" })),
    ).toThrow("ANTHROPIC_API_KEY is not set");
  });
});
