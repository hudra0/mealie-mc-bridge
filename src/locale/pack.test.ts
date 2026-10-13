import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_DIR, dePack, enPack } from "../testing/locale.js";
import { tempDir } from "../testing/temp.js";
import { phraseRegex, phraseSource, validPhraseEntry } from "./matcher.js";
import {
  LocalePackError,
  PACK_FILES,
  availableLocales,
  loadLocalePack,
  packDir,
  parseLocalePack,
  unitEntry,
  unknownLocaleMessage,
  vocabularyFor,
  type PackTexts,
} from "./pack.js";
import {
  fillPlaceholders,
  missingPlaceholders,
  placeholdersIn,
  placeholderValue,
} from "./placeholders.js";

const read = (locale: string, file: string) =>
  readFileSync(join(packDir(KNOWLEDGE_DIR, locale), file), "utf8");

function texts(locale = "de-DE"): PackTexts {
  return {
    mc: read(locale, PACK_FILES.mc),
    units: read(locale, PACK_FILES.units),
    phrases: read(locale, PACK_FILES.phrases),
    techniqueAliases: read(locale, PACK_FILES.techniqueAliases),
    promptRules: read(locale, PACK_FILES.promptRules),
  };
}

const edit = (json: string, change: (value: Record<string, unknown>) => void) => {
  const value = JSON.parse(json) as Record<string, unknown>;
  change(value);
  return JSON.stringify(value);
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("loadLocalePack", () => {
  it("loads the verified de-DE pack and the unverified en-US pack", () => {
    expect(dePack.mc).toMatchObject({
      locale: "de-DE",
      language: "German",
      complexityIds: { easy: 142, medium: 99, hard: 104 },
      defaultGroupName: "Allgemeine Zutaten",
      verifiedOnDevice: true,
    });
    expect(enPack.mc).toMatchObject({
      locale: "en-US",
      complexityIds: { easy: 22, medium: 16, hard: 20 },
      editorPath: "/en/create-recipe?devices=mc-smart",
      verifiedOnDevice: false,
    });
    expect(dePack.dir).toBe(packDir(KNOWLEDGE_DIR, "de-DE"));
    expect(enPack.promptRules.startsWith("# English wording")).toBe(true);
  });

  it("lists the locales that have a pack and names them for an unknown one", async () => {
    expect(availableLocales(KNOWLEDGE_DIR)).toEqual(["de-DE", "en-US"]);
    expect(availableLocales("/nonexistent")).toEqual([]);
    expect(unknownLocaleMessage("fr-FR", [])).toBe(
      "there is no locale pack for fr-FR (available: none)",
    );
    await expect(loadLocalePack(KNOWLEDGE_DIR, "fr-FR")).rejects.toThrow(
      "there is no locale pack for fr-FR (available: de-DE, en-US)",
    );
  });

  it("names a missing pack file", async () => {
    const temp = tempDir();
    cleanup = temp.cleanup;
    mkdirSync(join(temp.dir, "locales", "xx-XX"), { recursive: true });
    writeFileSync(join(temp.dir, "locales", "xx-XX", PACK_FILES.mc), "{}");
    await expect(loadLocalePack(temp.dir, "xx-XX")).rejects.toThrow(
      /Cannot read the locale pack file .*units\.json/,
    );
  });
});

describe("parseLocalePack", () => {
  it("rejects invalid JSON, a wrong shape and a missing heading", () => {
    const base = texts();
    expect(() => parseLocalePack({ ...base, mc: "{" }, "de-DE")).toThrow(
      "locales/de-DE/mc.json is not valid JSON",
    );
    expect(() =>
      parseLocalePack({ ...base, mc: edit(base.mc, (v) => delete v.complexityIds) }, "de-DE"),
    ).toThrow(/mc\.json does not have the expected shape: complexityIds/);
    expect(() => parseLocalePack({ ...base, promptRules: "no heading" }, "de-DE")).toThrow(
      'locales/de-DE/prompt-rules.md must start with a "# " heading',
    );
  });

  it("rejects a file that names another locale", () => {
    const base = texts();
    const phrases = edit(base.phrases, (v) => (v.locale = "de-AT"));
    expect(() => parseLocalePack({ ...base, phrases }, "de-DE")).toThrow(
      "locales/de-DE/phrases.json names the locale de-AT, not de-DE",
    );
  });

  it("needs every unit concept once, with a known unit code", () => {
    const base = texts();
    type Entry = { concept: string; code: string };
    const units = (change: (vocabulary: Entry[]) => Entry[]) =>
      edit(base.units, (v) => (v.vocabulary = change(v.vocabulary as Entry[])));
    expect(() =>
      parseLocalePack(
        { ...base, units: units((list) => list.filter((e) => e.concept !== "pinch")) },
        "de-DE",
      ),
    ).toThrow("the unit concept pinch is missing");
    expect(() =>
      parseLocalePack({ ...base, units: units((list) => [...list, list[0] as Entry]) }, "de-DE"),
    ).toThrow("each unit concept may appear only once");
    expect(() =>
      parseLocalePack(
        { ...base, units: units((list) => list.map((e) => ({ ...e, code: "bogus" }))) },
        "de-DE",
      ),
    ).toThrow("must be a unit code of src/ingredients/units.ts");
  });
});

describe("unit vocabulary", () => {
  it("finds entries by concept and by spelling", () => {
    expect(unitEntry(dePack, "teaspoon").singular).toBe("Tl");
    expect(unitEntry(enPack, "knifeTip").plural).toBe("big pinches");
    expect(vocabularyFor(dePack, "Msp")?.code).toBe("Msp");
    expect(vocabularyFor(dePack, "prisen")?.code).toBe("Prise");
    expect(vocabularyFor(enPack, "tablespoons")?.code).toBe("tbsp");
    expect(vocabularyFor(enPack, " ")).toBeNull();
    expect(vocabularyFor(enPack, "Tl")).toBeNull();
    const empty = { ...enPack, units: { ...enPack.units, vocabulary: [] } };
    expect(() => unitEntry(empty, "gram")).toThrow(LocalePackError);
  });
});

describe("placeholders", () => {
  it("fills language, phrases, title lists and units from a pack", () => {
    const text =
      '{{language}} / {{languageName}}: "{{phrase:pushDown}}", {{phrases:workingStepTitles}}, {{unit:teaspoon}}, {{unitPlural:pinch}}, "{{phrase:turboTitle}}"';
    expect(fillPlaceholders(text, dePack)).toBe(
      'German (de-DE) / German: "mit dem Spatel nach unten schieben", "Zerkleinern", "Andünsten", "Köcheln", "Pürieren", Tl, Prisen, "Turbo-Taste für 2 Sekunden"',
    );
    expect(fillPlaceholders("{{phrase:bowl}} and {{unit:knifeTip}}.", enPack)).toBe(
      "blender jug and big pinch.",
    );
    expect(fillPlaceholders("in {{unit:knifeTip}}.", dePack)).toBe("in Msp.");
  });

  it("names the placeholders a pack cannot fill", () => {
    const text =
      "{{phrase:nope}} {{unit:cup}} {{language:x}} {{phrases:turboTitle}} {{other}} {{phrase}}";
    expect(placeholdersIn(text)).toEqual([
      "phrase:nope",
      "unit:cup",
      "language:x",
      "phrases:turboTitle",
      "other",
      "phrase",
    ]);
    expect(missingPlaceholders(text, dePack)).toHaveLength(6);
    expect(placeholderValue(dePack, "languageName", "x")).toBeNull();
    expect(placeholderValue(dePack, "unit")).toBeNull();
    expect(() => fillPlaceholders(text, dePack, "a test")).toThrow(
      "a test uses {{phrase:nope}}, {{unit:cup}}",
    );
  });
});

describe("phrase lists", () => {
  it("matches inside words, at word starts and whole words", () => {
    expect(phraseRegex(["schüssel"]).test("in eine Rührschüssel geben")).toBe(true);
    expect(phraseRegex(["^heiß"]).test("heißes Wasser")).toBe(true);
    expect(phraseRegex(["^heiß"]).test("vorheizen")).toBe(false);
    expect(phraseRegex(["^geben$"]).test("abgeben")).toBe(false);
    expect(phraseRegex(["^geben$"]).test("dazu geben")).toBe(true);
    expect(phraseRegex(["x$"], { anchored: true }).test("x 30 cm")).toBe(true);
    expect(phraseRegex(["x$"], { anchored: true }).test("xylit")).toBe(false);
    expect(phraseRegex([]).test("anything")).toBe(false);
    expect(phraseSource("min.$")).toBe("min\\.(?!\\p{L})");
    expect(validPhraseEntry("^$")).toBe(false);
    expect(validPhraseEntry("^add$")).toBe(true);
  });
});
