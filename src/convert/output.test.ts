import { describe, expect, it } from "vitest";
import {
  deriveTextStepTitles,
  extractJson,
  parseJsonOutput,
  setServingUnit,
  textStepTitle,
} from "./output.js";

describe("extractJson", () => {
  it("takes plain JSON, fenced JSON and JSON inside a sentence", () => {
    expect(extractJson(' {"a":1} ')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Here it is: {"a":{"b":2}} Enjoy.')).toBe('{"a":{"b":2}}');
    expect(extractJson("no json")).toBe("no json");
  });
});

describe("text step titles", () => {
  it("takes the description, cut at the last space within the length", () => {
    expect(textStepTitle("Zwiebel schälen.", 80)).toBe("Zwiebel schälen.");
    const long = `${"Wort ".repeat(16)}Ende und noch mehr Text.`;
    const title = textStepTitle(long, 80);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(title)).toBe(true);
    expect(title.endsWith(" ")).toBe(false);
    expect(textStepTitle("x".repeat(100), 80)).toBe("x".repeat(80));
  });

  it("fills empty text step titles from the description and keeps the model's titles", () => {
    const answer = {
      servingSize: {
        steps: [
          { kind: "text", title: "Kurz", description: "Die Zwiebel schälen und halbieren." },
          { kind: "text", title: " ", description: "Die Zwiebel schälen und halbieren." },
          { kind: "text", description: "Servieren." },
          { kind: "scale", title: "200 g Sahne", description: "Einwiegen.", grams: 200 },
          { kind: "text", title: "Leer", description: "" },
          "kaputt",
        ],
      },
    };
    deriveTextStepTitles(answer, 80);
    expect(answer.servingSize.steps.map((step) => (step as { title?: string }).title)).toEqual([
      "Kurz",
      "Die Zwiebel schälen und halbieren.",
      "Servieren.",
      "200 g Sahne",
      "Leer",
      undefined,
    ]);
    expect(() => deriveTextStepTitles(null, 80)).not.toThrow();
    expect(() => deriveTextStepTitles({ servingSize: {} }, 80)).not.toThrow();
  });
});

describe("setServingUnit", () => {
  it("sets the unit of the serving size and ignores other shapes", () => {
    const answer = { servingSize: { amount: 10, unit: "Portionen" } };
    setServingUnit(answer, "Scheiben");
    expect(answer.servingSize.unit).toBe("Scheiben");
    setServingUnit(answer, undefined);
    expect(answer.servingSize.unit).toBe("Scheiben");
    expect(() => setServingUnit({ servingSize: [] }, "x")).not.toThrow();
    expect(() => setServingUnit(null, "x")).not.toThrow();
  });
});

describe("parseJsonOutput", () => {
  it("parses the JSON and reports what is wrong otherwise", () => {
    expect(parseJsonOutput('```json\n{"a":1}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
      text: '{"a":1}',
    });
    expect(parseJsonOutput("")).toEqual({
      ok: false,
      message: "the answer is empty; return the recipe as one JSON object",
    });
    const broken = parseJsonOutput('{"a":');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.message).toMatch(/^the answer is not valid JSON/);
  });
});
