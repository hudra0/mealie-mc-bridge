import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { SECRET_SETTINGS, effectiveConfig } from "./config-reference.js";

describe("effectiveConfig", () => {
  const env = {
    PORT: "3100",
    MEALIE_URL: "http://mealie.example.com:9000",
    MEALIE_API_TOKEN: "mealie-token-value",
    OPENAI_API_KEY: "sk-test-value",
    ADMIN_HOSTS: "Bridge.example.com, other.example.com",
    TZ: "Europe/Berlin",
  };
  const entries = effectiveConfig(loadConfig(env), env);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  it("lists every variable of the reference with its description", () => {
    expect(byName.size).toBe(entries.length);
    expect(entries.every((entry) => entry.description.length > 0)).toBe(true);
    expect(byName.get("PORT")).toMatchObject({ source: "env", value: "3100", secret: false });
    expect(byName.get("HOST")).toMatchObject({ source: "default", value: "0.0.0.0" });
    expect(byName.get("ADMIN_HOSTS")?.value).toBe("bridge.example.com,other.example.com");
    expect(byName.get("TZ")).toMatchObject({ source: "env", value: "Europe/Berlin" });
    expect(byName.get("SMTP_URL")).toMatchObject({ source: "unset", value: null });
    expect(byName.get("UI_LANGUAGE")).toMatchObject({ source: "default", value: "de" });
  });

  it("never carries the value of a secret", () => {
    expect(byName.get("MEALIE_API_TOKEN")).toMatchObject({ source: "env", value: null });
    expect(byName.get("OPENAI_API_KEY")).toMatchObject({ source: "env", secret: true });
    expect(byName.get("ANTHROPIC_API_KEY")).toMatchObject({ source: "unset", secret: true });
    for (const name of SECRET_SETTINGS) expect(byName.get(name)?.value, name).toBeNull();
    const text = JSON.stringify(entries);
    expect(text).not.toContain("mealie-token-value");
    expect(text).not.toContain("sk-test-value");
  });
});
