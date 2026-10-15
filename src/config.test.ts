import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MissingApiKeyError,
  isSettingsKey,
  loadConfig,
  loadServiceConfig,
  parseTrustProxy,
  resolveLlmConfig,
} from "./config.js";

const defaults = {
  PORT: 3000,
  HOST: "127.0.0.1",
  ADMIN_AUTH: "on",
  TRUST_PROXY: false,
  SMTP_ALLOW_INSECURE: false,
  JOB_DAILY_LIMIT: 50,
  JOB_DAILY_COST_LIMIT_USD: 10,
  LLM_MAX_RECIPE_KB: 40,
  MC_UPLOAD_HOSTS: ["*.googleapis.com", "*.tecpal.com"],
  LIDL_LOGIN_HOSTS: ["accounts.lidl.com"],
  LOG_LEVEL: "info",
  DEVICE_PROGRAMS_PATH: "./knowledge/device-programs.json",
  LLM_PROVIDER: "openai",
  OPENAI_MODEL: "gpt-6.1-sol",
  OPENAI_REASONING_EFFORT: "medium",
  ANTHROPIC_MODEL: "claude-opus-5-5",
  LLM_MAX_CORRECTIONS: 3,
  KNOWLEDGE_DIR: "./knowledge",
  DATA_DIR: "./data",
  MEALIE_GROUP_SLUG: "home",
  MC_RECIPE_STATUS: "private-publish",
  MC_RESOLVE_INGREDIENTS: "exact",
  SESSION_CHECK_MINUTES: 60,
  WORKER_POLL_SECONDS: 2,
  TAG_NAME: "Monsieur Cuisine",
  MC_LOCALE: "de-DE",
  UI_LANGUAGE: "de",
};

const knowledgeDir = fileURLToPath(new URL("../knowledge", import.meta.url));

const settingsKey = Buffer.alloc(32, 7).toString("base64");
const service = {
  WEBHOOK_TOKEN: "w".repeat(40),
  MEALIE_URL: "http://mealie:9000",
  MEALIE_API_TOKEN: "test-token-not-a-secret",
  SETTINGS_KEY: settingsKey,
  ADMIN_USER: "admin",
  ADMIN_PASSWORD: "a-long-test-password",
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
      KNOWLEDGE_DIR: knowledgeDir,
      LLM_PRICES_JSON: '{"gpt-5.4": {"input": 2.5, "output": 15}}',
      DATA_DIR: "/data",
      MC_RECIPE_STATUS: "draft",
      SESSION_CHECK_MINUTES: "30",
      WORKER_POLL_SECONDS: "0.5",
      SMTP_URL: "smtps://user:pass@mail.example.com:465",
      NOTIFY_EMAIL: "cook@example.com",
    });
    expect(config).toMatchObject({
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
      KNOWLEDGE_DIR: knowledgeDir,
      LLM_PRICES_JSON: '{"gpt-5.4": {"input": 2.5, "output": 15}}',
      DATA_DIR: "/data",
      MC_RECIPE_STATUS: "draft",
      SESSION_CHECK_MINUTES: 30,
      WORKER_POLL_SECONDS: 0.5,
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

  it("checks MC_LOCALE against the locale packs and derives UI_LANGUAGE from it", () => {
    expect(loadConfig({ MC_LOCALE: "en-US" })).toMatchObject({
      MC_LOCALE: "en-US",
      UI_LANGUAGE: "en",
    });
    expect(loadConfig({ MC_LOCALE: "en-US", UI_LANGUAGE: "de" }).UI_LANGUAGE).toBe("de");
    expect(() => loadConfig({ MC_LOCALE: "fr-FR" })).toThrow(
      "MC_LOCALE: there is no locale pack for fr-FR (available: de-DE, en-US)",
    );
    expect(() => loadConfig({ MC_LOCALE: "german" })).toThrow("MC_LOCALE: must look like de-DE");
    expect(() => loadConfig({ UI_LANGUAGE: "fr" })).toThrow(/UI_LANGUAGE/);
    expect(() => loadConfig({ KNOWLEDGE_DIR: "/nonexistent" })).toThrow("(available: none)");
  });

  it("binds to localhost outside the container and to every interface inside", () => {
    expect(loadConfig({}).HOST).toBe("127.0.0.1");
    expect(loadConfig({ BRIDGE_IN_CONTAINER: "1" }).HOST).toBe("0.0.0.0");
    expect(loadConfig({ BRIDGE_IN_CONTAINER: "0" }).HOST).toBe("127.0.0.1");
    expect(loadConfig({ BRIDGE_IN_CONTAINER: "1", HOST: "192.0.2.10" }).HOST).toBe("192.0.2.10");
  });

  it("reads the limits, the host lists and the flags", () => {
    expect(
      loadConfig({
        JOB_DAILY_LIMIT: "0",
        JOB_DAILY_COST_LIMIT_USD: "2.5",
        LLM_MAX_RECIPE_KB: "80",
        MC_UPLOAD_HOSTS: "Storage.Example.com, *.cdn.example.com",
        LIDL_LOGIN_HOSTS: "accounts.lidl.com,login.example.com",
        SMTP_ALLOW_INSECURE: "true",
      }),
    ).toMatchObject({
      JOB_DAILY_LIMIT: 0,
      JOB_DAILY_COST_LIMIT_USD: 2.5,
      LLM_MAX_RECIPE_KB: 80,
      MC_UPLOAD_HOSTS: ["storage.example.com", "*.cdn.example.com"],
      LIDL_LOGIN_HOSTS: ["accounts.lidl.com", "login.example.com"],
      SMTP_ALLOW_INSECURE: true,
    });
    expect(() => loadConfig({ JOB_DAILY_LIMIT: "-1" })).toThrow(/JOB_DAILY_LIMIT/);
    expect(() => loadConfig({ SMTP_ALLOW_INSECURE: "sometimes" })).toThrow(/SMTP_ALLOW_INSECURE/);
  });

  it("reads TRUST_PROXY as false, true or a list of proxy addresses", () => {
    expect(loadConfig({ TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "192.0.2.2, 198.51.100.0/24,::1" }).TRUST_PROXY).toEqual([
      "192.0.2.2",
      "198.51.100.0/24",
      "::1",
    ]);
    expect(() => loadConfig({ TRUST_PROXY: "proxy.example.com" })).toThrow(/TRUST_PROXY/);
    expect(parseTrustProxy("192.0.2.0/33")).toBeNull();
    expect(parseTrustProxy("fd00::/64")).toEqual(["fd00::/64"]);
    expect(parseTrustProxy("1.2.3.4/8/1")).toBeNull();
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

  it("rejects a short webhook token without quoting it", () => {
    const attempt = () => loadConfig({ WEBHOOK_TOKEN: "short-secret-value" });
    expect(attempt).toThrow(/WEBHOOK_TOKEN: must be at least 32 characters/);
    expect(attempt).not.toThrow(/short-secret-value/);
  });

  it("rejects a webhook token with characters that do not belong in a path", () => {
    expect(() => loadConfig({ WEBHOOK_TOKEN: `${"a".repeat(32)}/x` })).toThrow(/WEBHOOK_TOKEN/);
  });

  it("rejects a settings key that is not 32 bytes", () => {
    expect(() => loadConfig({ SETTINGS_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /SETTINGS_KEY: must be the base64 encoding of 32 bytes/,
    );
  });

  it("rejects a Mealie URL with another scheme", () => {
    expect(() => loadConfig({ MEALIE_URL: "ftp://mealie.example.com" })).toThrow(/MEALIE_URL/);
  });

  it("rejects an unknown recipe status", () => {
    expect(() => loadConfig({ MC_RECIPE_STATUS: "pending" })).toThrow(/MC_RECIPE_STATUS/);
  });

  it("switches ingredient resolution off and rejects other modes", () => {
    expect(loadConfig({ MC_RESOLVE_INGREDIENTS: "off" }).MC_RESOLVE_INGREDIENTS).toBe("off");
    expect(() => loadConfig({ MC_RESOLVE_INGREDIENTS: "fuzzy" })).toThrow(/MC_RESOLVE_INGREDIENTS/);
  });
});

describe("isSettingsKey", () => {
  it("accepts base64 of 32 bytes only", () => {
    expect(isSettingsKey(settingsKey)).toBe(true);
    expect(isSettingsKey(Buffer.alloc(31).toString("base64"))).toBe(false);
    expect(isSettingsKey("not base64 at all!")).toBe(false);
  });
});

// The service configuration without the given settings.
const without = (...keys: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(service).filter(([key]) => !keys.includes(key)));

describe("loadServiceConfig", () => {
  it("accepts a complete service configuration", () => {
    expect(loadServiceConfig(service)).toMatchObject(service);
  });

  it("names every missing required setting", () => {
    expect(() => loadServiceConfig({ ADMIN_AUTH: "off" })).toThrow(
      "Invalid configuration: WEBHOOK_TOKEN: is required; MEALIE_URL: is required; MEALIE_API_TOKEN: is required; SETTINGS_KEY: is required",
    );
  });

  it("wants both admin credentials or neither", () => {
    expect(
      loadServiceConfig({ ...service, ADMIN_HOSTS: " Bridge.example.com, ,mc.example.com" })
        .ADMIN_HOSTS,
    ).toEqual(["bridge.example.com", "mc.example.com"]);
    expect(() => loadServiceConfig(without("ADMIN_PASSWORD"))).toThrow(
      /ADMIN_USER, ADMIN_PASSWORD: set both or neither/,
    );
  });

  it("requires admin credentials unless ADMIN_AUTH=off", () => {
    const open = without("ADMIN_USER", "ADMIN_PASSWORD");
    expect(() => loadServiceConfig(open)).toThrow(
      /ADMIN_USER, ADMIN_PASSWORD: are required .*set ADMIN_AUTH=off/,
    );
    expect(loadServiceConfig({ ...open, ADMIN_AUTH: "off" }).ADMIN_AUTH).toBe("off");
    expect(() => loadServiceConfig({ ...open, ADMIN_AUTH: "maybe" })).toThrow(/ADMIN_AUTH/);
  });

  it("wants an admin password of at least 12 characters", () => {
    expect(() => loadServiceConfig({ ...service, ADMIN_PASSWORD: "short-pw" })).toThrow(
      "ADMIN_PASSWORD: must be at least 12 characters",
    );
    expect(() => loadServiceConfig({ ...service, ADMIN_PASSWORD: "short-pw" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("short-pw") as unknown }),
    );
    expect(loadServiceConfig({ ...service, ADMIN_PASSWORD: "x".repeat(12) })).toBeTruthy();
  });

  it("wants a recipient when mail is configured", () => {
    expect(() =>
      loadServiceConfig({ ...service, SMTP_URL: "smtp://mail.example.com:587" }),
    ).toThrow(/NOTIFY_EMAIL: is required when SMTP_URL is set/);
  });
});

describe("resolveLlmConfig", () => {
  it("returns the settings of the selected provider", () => {
    expect(resolveLlmConfig(loadConfig({ OPENAI_API_KEY: "k1" }))).toEqual({
      provider: "openai",
      apiKey: "k1",
      model: "gpt-6.1-sol",
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
