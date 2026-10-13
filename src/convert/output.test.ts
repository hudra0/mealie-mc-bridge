import { describe, expect, it } from "vitest";
import { extractJson, parseJsonOutput } from "./output.js";

describe("extractJson", () => {
  it("takes plain JSON, fenced JSON and JSON inside a sentence", () => {
    expect(extractJson(' {"a":1} ')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Here it is: {"a":{"b":2}} Enjoy.')).toBe('{"a":{"b":2}}');
    expect(extractJson("no json")).toBe("no json");
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
