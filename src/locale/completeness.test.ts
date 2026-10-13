// Every folder under knowledge/locales must be a complete locale pack: valid files, the
// wording for every technique and ingredient class of the neutral knowledge base, every
// placeholder the neutral files use, units the pack's own phrases name, and an ingredient
// catalog of its language. A new language passes this test before it is tried on a device.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_PHRASES, loadKnowledge } from "../convert/knowledge.js";
import { parseIngredientCatalog } from "../ingredients/catalog.js";
import { NUTRITION_KEYS } from "../mealie/types.js";
import { KNOWLEDGE_DIR } from "../testing/locale.js";
import { validPhraseEntry } from "./matcher.js";
import { LOCALES_DIR, PACK_FILES, loadLocalePack, packDir } from "./pack.js";
import { missingPlaceholders, placeholdersIn } from "./placeholders.js";

const folders = readdirSync(join(KNOWLEDGE_DIR, LOCALES_DIR), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const neutral = (file: string) => readFileSync(join(KNOWLEDGE_DIR, file), "utf8");
const techniques = (
  JSON.parse(neutral("techniques.json")) as {
    techniques: { id: string; ingredientClasses: string[] }[];
  }
).techniques;
// Texts of the neutral knowledge base that reach the prompt with placeholders filled.
const neutralTexts = {
  "prompt-rules.md": neutral("prompt-rules.md"),
  "techniques.json": neutral("techniques.json"),
};

describe("locale packs", () => {
  it("has the reference pack and the English template", () => {
    expect(folders).toEqual(expect.arrayContaining(["de-DE", "en-US"]));
  });

  describe.each(folders)("%s", (locale) => {
    it("loads and names its folder's locale", async () => {
      const pack = await loadLocalePack(KNOWLEDGE_DIR, locale);
      expect(pack.mc.locale).toBe(locale);
      expect(pack.mc.editorPath.startsWith("/")).toBe(true);
      if (!pack.mc.verifiedOnDevice) {
        expect(pack.mc.notes.join(" "), "an unverified pack says what is unverified").toMatch(
          /not verified|unverified/i,
        );
      }
    });

    it("words every technique and every ingredient class of techniques.json", async () => {
      const pack = await loadLocalePack(KNOWLEDGE_DIR, locale);
      const ids = new Set(techniques.map((technique) => technique.id));
      for (const id of Object.keys(pack.techniqueAliases.techniques)) {
        expect(ids.has(id), `${id} is not in techniques.json`).toBe(true);
      }
      for (const technique of techniques) {
        expect(
          pack.techniqueAliases.techniques[technique.id]?.aliases.length,
          technique.id,
        ).toBeGreaterThan(0);
      }
      const classes = new Set(techniques.flatMap((technique) => technique.ingredientClasses));
      classes.delete("any");
      for (const name of classes) {
        expect(pack.techniqueAliases.ingredientClassWords[name]?.length, name).toBeGreaterThan(0);
      }
    });

    it("fills every placeholder of the neutral files and of its own prompt rules", async () => {
      const pack = await loadLocalePack(KNOWLEDGE_DIR, locale);
      for (const [file, text] of Object.entries({
        ...neutralTexts,
        [PACK_FILES.promptRules]: pack.promptRules,
      })) {
        expect(missingPlaceholders(text, pack), file).toEqual([]);
      }
      for (const id of REQUIRED_PHRASES) expect(pack.phrases.standardPhrases[id], id).toBeDefined();
    });

    it("names only units its vocabulary has", async () => {
      const pack = await loadLocalePack(KNOWLEDGE_DIR, locale);
      const concepts = new Set(pack.units.vocabulary.map((entry) => entry.concept));
      const all = [...Object.values(neutralTexts), pack.promptRules];
      for (const placeholder of all.flatMap(placeholdersIn)) {
        const [kind, id] = placeholder.split(":");
        if (kind === "unit" || kind === "unitPlural")
          expect(concepts.has(id as never), placeholder).toBe(true);
      }
      const spellings = new Set(
        pack.units.vocabulary.flatMap((entry) =>
          [entry.singular, entry.plural, ...entry.aliases].map((form) => form.toLowerCase()),
        ),
      );
      const titles = pack.phrases.stepTitleRules;
      for (const phrase of [titles.scaleTitle, titles.scaleDescription, titles.scaleExample]) {
        const unit = /(?:<n>|\d+)\s+(\S+)/u.exec(phrase)?.[1];
        expect(unit, phrase).toBeDefined();
        expect(spellings.has((unit ?? "").toLowerCase()), `${phrase}: ${unit}`).toBe(true);
      }
      for (const entry of pack.units.allowedUnits) {
        if (entry.unit !== "")
          expect(spellings.has(entry.unit.toLowerCase()), entry.unit).toBe(true);
      }
    });

    it("has well-formed word lists and every label", async () => {
      const pack = await loadLocalePack(KNOWLEDGE_DIR, locale);
      const p = pack.phrases;
      const lists = [
        p.additionVerbs,
        p.emptyingPhrases,
        p.coolingPhrases,
        p.reservedPhrases,
        p.reusedPhrases,
        p.outsideBowlPhrases,
        p.hotPhrases,
        p.whiskPhrases.accessory,
        p.whiskPhrases.fit,
        p.whiskPhrases.remove,
        p.measureWords,
        p.moreAllowedWords,
      ];
      for (const entry of lists.flat()) expect(validPhraseEntry(entry), entry).toBe(true);
      for (const key of NUTRITION_KEYS) expect(p.sectionLabels.nutrients[key], key).toBeDefined();
      expect(p.sectionLabels.unscaled).toContain("{factor}");
    });

    it("carries an ingredient catalog of its language", async () => {
      const pack = await loadLocalePack(KNOWLEDGE_DIR, locale);
      const catalog = parseIngredientCatalog(
        JSON.parse(
          readFileSync(join(packDir(KNOWLEDGE_DIR, locale), PACK_FILES.ingredientCatalog), "utf8"),
        ),
      );
      expect(catalog.generatedFrom).toContain(pack.locale);
      expect(catalog.entries.length).toBeGreaterThan(100);
    });

    it("builds a knowledge base for the converter", async () => {
      const knowledge = await loadKnowledge(KNOWLEDGE_DIR, locale);
      expect(knowledge.locale).toBe(locale);
      expect(knowledge.promptRules).not.toContain("{{");
      expect(
        knowledge.techniques.some((technique) => technique.structure.join(" ").includes("{{")),
      ).toBe(false);
    });
  });
});
