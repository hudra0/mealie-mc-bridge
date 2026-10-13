import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedIngredient } from "../ingredients/index.js";
import {
  ALWAYS_SELECTED,
  INGREDIENT_CLASS_WORDS,
  KNOWLEDGE_FILES,
  KnowledgeError,
  buildKnowledge,
  loadKnowledge,
  massLimit,
  ruleValue,
  selectTechniques,
  techniqueById,
  techniqueSummaryLine,
  type KnowledgeTexts,
} from "./knowledge.js";

const dir = fileURLToPath(new URL("../../knowledge", import.meta.url));
const knowledge = await loadKnowledge(dir);

async function texts(): Promise<KnowledgeTexts> {
  const read = (file: string) => readFile(join(dir, file), "utf8");
  const F = KNOWLEDGE_FILES;
  return {
    techniques: await read(F.techniques),
    timing: await read(F.timing),
    units: await read(F.units),
    recommended: await read(F.recommended),
    promptRules: await read(F.promptRules),
    stepPatterns: await read(F.stepPatterns),
  };
}

const food = (name: string): NormalizedIngredient => ({
  index: 0,
  section: null,
  quantity: 1,
  quantityMax: null,
  unit: null,
  food: name,
  note: "",
  optional: false,
  source: "structured",
  original: name,
  referenceId: null,
});

describe("loadKnowledge", () => {
  it("loads the knowledge base of the repository", () => {
    expect(knowledge.techniques).toHaveLength(45);
    expect(knowledge.heatUp).toEqual({ errorFactor: 0.5, warningFactor: 0.87, minTemperature: 90 });
    expect(massLimit(knowledge, "bowl_max").grams).toBe(3000);
    expect(massLimit(knowledge, "steaming_liquid_min").grams).toBe(500);
    expect(ruleValue(knowledge, "speed_max_whisk")).toBe(4);
    expect(ruleValue(knowledge, "turbo_content_temperature")).toBe(60);
    expect(knowledge.promptRules.startsWith("# ")).toBe(true);
    expect(techniqueById(knowledge, "sear_roast")?.device.mode).toBe("roasting");
    expect(techniqueById(knowledge, "nope")).toBeUndefined();
  });

  describe("with a broken copy", () => {
    let broken: string;

    beforeAll(async () => {
      broken = await mkdtemp(join(tmpdir(), "knowledge-"));
    });

    afterAll(async () => {
      await rm(broken, { recursive: true, force: true });
    });

    it("names a missing file", async () => {
      await writeFile(join(broken, KNOWLEDGE_FILES.techniques), "{}");
      await expect(loadKnowledge(broken)).rejects.toThrow(
        /Cannot read the knowledge file .*timing-model\.json/,
      );
      await expect(loadKnowledge(broken)).rejects.toBeInstanceOf(KnowledgeError);
    });
  });

  it("rejects invalid JSON and a wrong shape", async () => {
    const base = await texts();
    expect(() => buildKnowledge({ ...base, units: "{" })).toThrow("units.json is not valid JSON");
    expect(() => buildKnowledge({ ...base, timing: "{}" })).toThrow(
      /timing-model\.json does not have the expected shape/,
    );
  });

  it("rejects missing entries the checks depend on", async () => {
    const base = await texts();
    const techniques = JSON.parse(base.techniques) as { techniques: { id: string }[] };
    const without = (id: string) =>
      JSON.stringify({
        ...techniques,
        techniques: techniques.techniques.filter((t) => t.id !== id),
      });
    expect(() => buildKnowledge({ ...base, techniques: without("sear_roast") })).toThrow(
      "technique sear_roast is missing",
    );
    const doubled = JSON.stringify({
      ...techniques,
      techniques: [...techniques.techniques, techniques.techniques[0]],
    });
    expect(() => buildKnowledge({ ...base, techniques: doubled })).toThrow("is listed twice");

    const timing = JSON.parse(base.timing) as {
      massLimits: { id: string }[];
      heatUpRules: { id: string; condition: string }[];
    };
    const noBowl = {
      ...timing,
      massLimits: timing.massLimits.filter((limit) => limit.id !== "bowl_max"),
    };
    expect(() => buildKnowledge({ ...base, timing: JSON.stringify(noBowl) })).toThrow(
      "mass limit bowl_max",
    );
    const vague = {
      ...timing,
      heatUpRules: timing.heatUpRules.map((rule) =>
        rule.id === "heatup_short" ? { ...rule, condition: "too short" } : rule,
      ),
    };
    expect(() => buildKnowledge({ ...base, timing: JSON.stringify(vague) })).toThrow(
      "heatup_short",
    );

    const recommended = JSON.parse(base.recommended) as { rules: { id: string }[] };
    const noWhisk = {
      ...recommended,
      rules: recommended.rules.filter((rule) => rule.id !== "speed_max_whisk"),
    };
    expect(() => buildKnowledge({ ...base, recommended: JSON.stringify(noWhisk) })).toThrow(
      "speed_max_whisk",
    );

    expect(() => buildKnowledge({ ...base, promptRules: "no heading" })).toThrow(
      'prompt-rules.md must start with a "# " heading',
    );
  });
});

describe("INGREDIENT_CLASS_WORDS", () => {
  it("has words for every ingredient class the techniques use", () => {
    const classes = new Set(knowledge.techniques.flatMap((t) => t.ingredientClasses));
    classes.delete("any");
    for (const name of classes)
      expect(INGREDIENT_CLASS_WORDS[name]?.length, name).toBeGreaterThan(0);
  });
});

describe("selectTechniques", () => {
  const select = (title: string, rendered: string, foods: string[] = [], max?: number) =>
    selectTechniques(
      { title, rendered, ingredients: foods.map(food) },
      knowledge,
      max,
    ).techniques.map((technique) => technique.id);

  it("always carries the base techniques", () => {
    expect(select("Platte", "Anrichten.")).toEqual([...ALWAYS_SELECTED]);
  });

  it("matches German and English aliases", () => {
    expect(select("Dessert", "Die Sahne steif schlagen.")).toContain("whip");
    expect(select("Steak", "Sear the meat.")).toContain("sear_roast");
    expect(select("Brot", "Den Hefeteig kneten.")).toContain("knead_yeast_dough");
  });

  it("uses ingredient classes to pick between techniques that share a verb", () => {
    const ids = select("Pasta", "Den Käse fein hacken.", ["Parmesan"]);
    expect(ids).toContain("grate_hard_cheese");
    expect(ids).not.toContain("chop_fruit");
  });

  it("respects the maximum and keeps the knowledge-file order", () => {
    const ids = select(
      "Alles",
      "zerkleinern pürieren dämpfen kneten schlagen anbraten rösten",
      [],
      6,
    );
    expect(ids).toHaveLength(6);
    const order = knowledge.techniques.map((t) => t.id);
    expect([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(ids);
  });

  it("returns a summary line for every technique", () => {
    const selection = selectTechniques({ title: "", rendered: "", ingredients: [] }, knowledge);
    expect(selection.summary).toHaveLength(45);
    expect(techniqueSummaryLine(techniqueById(knowledge, "chop_onion_garlic")!)).toBe(
      "chop_onion_garlic: Chop onions, shallots, garlic or ginger | customized, 6 (5-10) s, speed 6 (max 8)",
    );
    expect(techniqueSummaryLine(techniqueById(knowledge, "cook_eggs")!)).toContain("size medium");
    expect(techniqueSummaryLine(techniqueById(knowledge, "fold_in_reverse")!)).toContain("reverse");
  });
});
