import { describe, expect, it } from "vitest";
import { limits, silentLogger } from "../testing/fakes.js";
import {
  CONVERTER_MODULE,
  ConverterNotConfiguredError,
  loadConverter,
  placeholderConverter,
  type Converter,
} from "./converter-port.js";

const context = { env: {}, limits, logger: silentLogger() };

const notFound = (path: string) =>
  Object.assign(
    new Error(`Cannot find module '${path}' imported from /app/dist/pipeline/converter-port.js`),
    {
      code: "ERR_MODULE_NOT_FOUND",
    },
  );

describe("placeholderConverter", () => {
  it("rejects every request with a clear message", async () => {
    await expect(
      placeholderConverter.convert({
        title: "x",
        rendered: "",
        servings: 1,
        locale: "de-DE",
        ingredients: [],
      }),
    ).rejects.toThrow(ConverterNotConfiguredError);
    await expect(
      placeholderConverter.convert({
        title: "x",
        rendered: "",
        servings: 1,
        locale: "de-DE",
        ingredients: [],
      }),
    ).rejects.toThrow("converter not configured");
  });
});

describe("loadConverter", () => {
  it("imports the converter module and calls its factory", async () => {
    const real: Converter = { convert: () => Promise.reject(new Error("unused")) };
    let asked = "";
    const converter = await loadConverter(context, (specifier) => {
      asked = specifier;
      return Promise.resolve({ createConverter: () => real });
    });
    expect(asked).toBe(CONVERTER_MODULE);
    expect(converter).toBe(real);
  });

  it("falls back to the placeholder when the module does not exist", async () => {
    const converter = await loadConverter(context, () =>
      Promise.reject(notFound("/app/dist/convert/index.js")),
    );
    expect(converter).toBe(placeholderConverter);
  });

  it("does not hide a missing dependency inside the converter", async () => {
    const inner = Object.assign(
      new Error("Cannot find module 'openai' imported from /app/dist/convert/index.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    await expect(loadConverter(context, () => Promise.reject(inner))).rejects.toBe(inner);
  });

  it("does not hide other load errors", async () => {
    const broken = new SyntaxError("Unexpected token");
    await expect(loadConverter(context, () => Promise.reject(broken))).rejects.toBe(broken);
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    await expect(loadConverter(context, () => Promise.reject(denied))).rejects.toBe(denied);
  });

  it("refuses a module without a factory", async () => {
    await expect(loadConverter(context, () => Promise.resolve({ other: 1 }))).rejects.toThrow(
      /does not export createConverter/,
    );
  });
});
