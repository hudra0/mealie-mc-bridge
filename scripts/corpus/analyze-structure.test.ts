import { describe, expect, it } from "vitest";
import {
  accessoryActions,
  amountFormatRe,
  classifyAction,
  coarseToken,
  compoundPartUsed,
  fineToken,
  fit2,
  numberFormat,
  phrases,
  speedBand,
  tempBand,
  unitClass,
} from "./analyze-structure.js";

const step = (
  kind: "text" | "machine",
  mode: string,
  temperature: number | null = null,
  speed: number | null = null,
  reverse = false,
) => ({ kind, mode, temperature, speed, reverse });

describe("step tokens", () => {
  it("bands temperature and speed", () => {
    expect([0, 37, 60, 65, 95, 100, 105, 130].map(tempBand)).toEqual([
      "0",
      "37-60",
      "37-60",
      "65-95",
      "65-95",
      "100",
      "105-130",
      "105-130",
    ]);
    expect([null, 0, 1, 2, 3, 4, 5, 7, 8, 10].map(speedBand)).toEqual([
      "-",
      "0",
      "1-2",
      "1-2",
      "3-4",
      "3-4",
      "5-7",
      "5-7",
      "8-10",
      "8-10",
    ]);
  });

  it("builds fine and coarse tokens", () => {
    expect(fineToken(step("text", "text"))).toBe("T");
    expect(fineToken(step("machine", "scale", 0))).toBe("S");
    expect(fineToken(step("machine", "customized", 100, 1, true))).toBe("C100/1-2/R");
    expect(fineToken(step("machine", "customized", 0, 6))).toBe("C0/5-7");
    expect(fineToken(step("machine", "roasting", 130))).toBe("roasting");
    expect(coarseToken(step("machine", "customized", 100, 1, true))).toBe("C100");
  });
});

describe("accessory actions", () => {
  it("classifies remove before insert", () => {
    expect(classifyAction("den messbecher aus dem deckel entfernen", false)).toBe("remove");
    expect(classifyAction("messbecher nicht einsetzen", false)).toBe("remove");
    expect(classifyAction("den messbecher in den deckel einsetzen", false)).toBe("insert");
    expect(classifyAction("den kocheinsatz als spritzschutz auf den deckel stellen", true)).toBe(
      "splash",
    );
  });

  it("splits a step into one action per clause", () => {
    const text = "Messbecher entfernen und Rühraufsatz einsetzen.";
    expect(accessoryActions(text, "messbecher")).toEqual(["remove"]);
    expect(accessoryActions(text, "ruehraufsatz")).toEqual(["insert"]);
  });

  it("does not read a cup action as a lid action", () => {
    expect(accessoryActions("Den Messbecher aus dem Deckel entfernen.", "deckel")).toEqual([]);
  });

  it("finds the spatula phrase", () => {
    const spatel = phrases.find((p) => p.key === "spatel_nach_unten");
    expect(spatel?.test("Mit dem Spatel nach unten schieben.")).toBe(true);
    expect(spatel?.test("Mit dem Spatel unterheben.")).toBe(false);
  });
});

describe("amount formats", () => {
  it("names number formats", () => {
    expect(numberFormat("500", undefined)).toBe("integer");
    expect(numberFormat("½", undefined)).toBe("unicode_fraction");
    expect(numberFormat("1 ½", undefined)).toBe("mixed_unicode_fraction");
    expect(numberFormat("1/2", undefined)).toBe("ascii_fraction");
    expect(numberFormat("1 1/2", undefined)).toBe("mixed_ascii_fraction");
    expect(numberFormat("1,5", undefined)).toBe("decimal_comma");
    expect(numberFormat("1", "-2")).toBe("range");
  });

  it("captures the space between number and unit", () => {
    const spaces = (text: string) => [...text.matchAll(amountFormatRe)].map((m) => [m[1], m[3]]);
    expect(spaces("200 g Wasser")).toEqual([["200", " "]]);
    expect(spaces("200g Wasser")).toEqual([["200", ""]]);
    expect(spaces("1 ½ Tl Salz")).toEqual([["1 ½", " "]]);
  });

  it("groups unit spellings", () => {
    expect(
      ["g", "Gramm", "Tl", "Teelöffel", "El", "Prisen", "Msp.", "Stk."].map(unitClass),
    ).toEqual(["g", "g", "TL", "TL", "EL", "Prise", "Msp", "Stück"]);
  });
});

describe("ingredient references", () => {
  it("accepts the leading part of a compound name", () => {
    expect(compoundPartUsed("knoblauchzehen", new Set(["knoblauch", "schälen"]))).toBe(true);
    expect(compoundPartUsed("petersilienstiele", new Set(["petersilie"]))).toBe(true);
    expect(compoundPartUsed("knoblauchzehen", new Set(["zwiebel"]))).toBe(false);
  });
});

describe("fit2", () => {
  it("recovers an exact linear relation", () => {
    const rows: [number, number, number][] = [
      [1, 2, 3 + 2 * 1 + 4 * 2],
      [2, 1, 3 + 2 * 2 + 4 * 1],
      [3, 5, 3 + 2 * 3 + 4 * 5],
      [4, 3, 3 + 2 * 4 + 4 * 3],
    ];
    expect(fit2(rows)).toEqual({ b0: 3, b1: 2, b2: 4, r2: 1 });
  });
});
