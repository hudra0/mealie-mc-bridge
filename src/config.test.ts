import { describe, expect, it } from "vitest";
import { isSettingsKey, loadConfig, loadServiceConfig } from "./config.js";

const defaults = {
  PORT: 3000,
  HOST: "0.0.0.0",
  LOG_LEVEL: "info",
  DEVICE_PROGRAMS_PATH: "./knowledge/device-programs.json",
  DATA_DIR: "./data",
  MEALIE_GROUP_SLUG: "home",
  MC_RECIPE_STATUS: "private-publish",
  SESSION_CHECK_MINUTES: 60,
  WORKER_POLL_SECONDS: 2,
  TAG_NAME: "Monsieur Cuisine",
  TIMELINE_LANGUAGE: "de",
};

const settingsKey = Buffer.alloc(32, 7).toString("base64");
const service = {
  WEBHOOK_TOKEN: "w".repeat(40),
  MEALIE_URL: "http://mealie:9000",
  MEALIE_API_TOKEN: "test-token-not-a-secret",
  SETTINGS_KEY: settingsKey,
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
      DATA_DIR: "/data",
      MC_RECIPE_STATUS: "draft",
      SESSION_CHECK_MINUTES: 30,
      WORKER_POLL_SECONDS: 0.5,
    });
  });

  it("treats empty values as unset", () => {
    expect(
      loadConfig({ PORT: "", HOST: "", LOG_LEVEL: "", DEVICE_PROGRAMS_PATH: "", MC_COOKIE: "" }),
    ).toEqual(defaults);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow(/Invalid configuration: PORT/);
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
});

describe("isSettingsKey", () => {
  it("accepts base64 of 32 bytes only", () => {
    expect(isSettingsKey(settingsKey)).toBe(true);
    expect(isSettingsKey(Buffer.alloc(31).toString("base64"))).toBe(false);
    expect(isSettingsKey("not base64 at all!")).toBe(false);
  });
});

describe("loadServiceConfig", () => {
  it("accepts a complete service configuration", () => {
    expect(loadServiceConfig(service)).toMatchObject(service);
  });

  it("names every missing required setting", () => {
    expect(() => loadServiceConfig({})).toThrow(
      "Invalid configuration: WEBHOOK_TOKEN: is required; MEALIE_URL: is required; MEALIE_API_TOKEN: is required; SETTINGS_KEY: is required",
    );
  });

  it("wants both admin credentials or neither", () => {
    expect(
      loadServiceConfig({ ...service, ADMIN_HOSTS: " Bridge.example.com, ,mc.example.com" })
        .ADMIN_HOSTS,
    ).toEqual(["bridge.example.com", "mc.example.com"]);
    expect(() => loadServiceConfig({ ...service, ADMIN_USER: "admin" })).toThrow(
      /ADMIN_USER, ADMIN_PASSWORD: set both or neither/,
    );
    expect(
      loadServiceConfig({ ...service, ADMIN_USER: "admin", ADMIN_PASSWORD: "pw" }),
    ).toBeTruthy();
  });

  it("wants a recipient when mail is configured", () => {
    expect(() =>
      loadServiceConfig({ ...service, SMTP_URL: "smtp://mail.example.com:587" }),
    ).toThrow(/NOTIFY_EMAIL: is required when SMTP_URL is set/);
  });
});
