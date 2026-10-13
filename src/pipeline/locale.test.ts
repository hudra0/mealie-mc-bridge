import { describe, expect, it } from "vitest";
import { KNOWLEDGE_DIR, dePack, enPack } from "../testing/locale.js";
import { loadPipelineLocale, pipelineLocale } from "./locale.js";

describe("pipeline locale", () => {
  it("loads the pack of MC_LOCALE with the category words of every pack", async () => {
    const locale = await loadPipelineLocale(KNOWLEDGE_DIR, "en-US");
    expect(locale.pack.locale).toBe("en-US");
    expect(locale.labels).toMatchObject({ ingredients: "Ingredients", decimalSeparator: "." });
    expect(locale.categoryWords.joiners).toEqual(expect.arrayContaining(["und", "and"]));
    expect(locale.categoryWords.stopwords).toEqual(expect.arrayContaining(["küche", "cuisine"]));
  });

  it("works with the output pack alone", () => {
    const locale = pipelineLocale(dePack);
    expect(locale.labels.ingredients).toBe("Zutaten");
    expect(locale.categoryWords.joiners).toEqual(["und"]);
    expect(pipelineLocale(enPack, [enPack, dePack]).categoryWords.stemEndings).toEqual([
      "es",
      "s",
      "en",
      "er",
      "e",
      "n",
    ]);
  });

  it("fails for a locale without a pack", async () => {
    await expect(loadPipelineLocale(KNOWLEDGE_DIR, "fr-FR")).rejects.toThrow(
      "there is no locale pack for fr-FR",
    );
  });
});
