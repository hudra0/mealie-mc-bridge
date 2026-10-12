import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    expect(loadConfig({})).toEqual({ PORT: 3000, HOST: "0.0.0.0", LOG_LEVEL: "info" });
  });

  it("reads values from the environment", () => {
    const config = loadConfig({ PORT: "8080", HOST: "127.0.0.1", LOG_LEVEL: "debug" });
    expect(config).toEqual({ PORT: 8080, HOST: "127.0.0.1", LOG_LEVEL: "debug" });
  });

  it("treats empty values as unset", () => {
    expect(loadConfig({ PORT: "", HOST: "", LOG_LEVEL: "" })).toEqual({
      PORT: 3000,
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
    });
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "not-a-number" })).toThrow(/Invalid configuration: PORT/);
  });
});
