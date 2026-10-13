import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const defaults = {
  PORT: 3000,
  HOST: "0.0.0.0",
  LOG_LEVEL: "info",
  DEVICE_PROGRAMS_PATH: "./knowledge/device-programs.json",
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
    });
    expect(config).toEqual({
      PORT: 8080,
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      DEVICE_PROGRAMS_PATH: "/etc/bridge/device-programs.json",
      MC_COOKIE: "a=1; b=2",
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
});
