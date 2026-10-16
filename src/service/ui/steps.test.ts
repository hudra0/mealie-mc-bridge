import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOGS } from "../../i18n/index.js";
import { MACHINE_STEP_KINDS } from "../../recipe/modes.js";
import { convertedRecipe } from "../../testing/fakes.js";
import { ICONS } from "./icons.generated.js";
import { MODE_ICONS, programTime, readRecipe, recipeSteps, storedRecipe } from "./steps.js";

const t = CATALOGS.en.admin.steps;

describe("device programs", () => {
  it("have an icon and a label in every language for every program", () => {
    for (const kind of MACHINE_STEP_KINDS) {
      expect(ICONS[MODE_ICONS[kind]], kind).toBeTruthy();
      for (const catalog of Object.values(CATALOGS)) {
        expect(catalog.admin.steps.modes[kind], `${catalog.language} ${kind}`).toBeTruthy();
      }
    }
  });

  it("use the editor's German labels and our English ones from the knowledge file", () => {
    const programs = JSON.parse(
      readFileSync(new URL("../../../knowledge/device-programs.json", import.meta.url), "utf8"),
    ) as { modes?: unknown; programs?: unknown };
    const text = JSON.stringify(programs);
    for (const kind of MACHINE_STEP_KINDS) {
      const match = new RegExp(
        `"id":"${kind}"[^}]*?"label":\\{"de":"([^"]+)","en":"([^"]+)"\\}`,
      ).exec(text);
      expect(match, kind).not.toBeNull();
      expect(CATALOGS.de.admin.steps.modes[kind], kind).toBe(match?.[1]);
      expect(CATALOGS.en.admin.steps.modes[kind], kind).toBe(match?.[2]);
    }
  });

  it("show the program time in the unit the device takes", () => {
    expect(programTime("customized", { minutes: 20, seconds: 0 })).toBe("20:00");
    expect(programTime("customized", { minutes: 75, seconds: 5 })).toBe("1:15:05");
    expect(programTime("turbo", { seconds: 3 })).toBe("3 s");
    expect(programTime("scale", { grams: 100 })).toBeNull();
    expect(programTime("puree", {})).toBeNull();
    expect(programTime("slow_cooking", { minutes: 240 })).toBe("4:00:00");
  });
});

describe("recipe steps", () => {
  it("render text steps, programs with chips and the ingredient groups", () => {
    const recipe = convertedRecipe();
    recipe.servingSize.steps.push(
      { kind: "cooking_eggs", title: "Eier", size: "medium", texture: "waxy_soft" },
      { kind: "precleaning", title: "Spülen", duration: "short" },
      { kind: "scale", title: "Wiegen", description: "Mehl abwiegen", grams: 250 },
      {
        kind: "customized",
        title: "Schlagen",
        temperature: 0,
        minutes: 2,
        seconds: 0,
        speed: 4,
        rotation: "right",
        accessory: "butterfly_whisk",
      },
    );
    recipe.servingSize.ingredientGroups.push({
      name: "Garnitur",
      ingredients: [{ name: "Petersilie", amount: "1-2", unit: "EL", isOptional: true }],
    });
    const html = recipeSteps(readRecipe(recipe), t).html;
    expect(html).toContain("Zutaten einfüllen");
    expect(html).toContain("Manual cooking");
    expect(html).toContain("100 °C");
    expect(html).toContain("Reverse");
    expect(html).toContain("Forward");
    expect(html).toContain("Whisk");
    expect(html).toContain("Size M");
    expect(html).toContain("Medium");
    expect(html).toContain("Short");
    expect(html).toContain("250 g");
    expect(html).toContain("Mehl abwiegen");
    expect(html).not.toMatch(/[^0-9]0 °C/);
    expect(html).toContain("Garnitur");
    expect(html).toContain("1-2 EL");
    expect(html).toContain("optional");
    expect(html).toContain("10 min preparation");
    expect(html).toContain("ready in 35 min");
    expect(html).toContain("4 Portionen");
  });

  it("read a stored conversion loosely and render unknown steps as text", () => {
    expect(readRecipe(null)).toBeNull();
    expect(readRecipe({ servingSize: { steps: [] } })).toBeNull();
    expect(storedRecipe(null)).toBeNull();
    expect(storedRecipe({ result: "broken" })).toBeNull();
    const loose = readRecipe({
      servingSize: {
        steps: [{ kind: "future_program", title: "Neu", description: "Etwas" }, "junk"],
        ingredientGroups: [{ ingredients: [{ name: "Salz", amount: { odd: true } }] }, "junk"],
      },
    });
    expect(loose?.steps).toHaveLength(1);
    expect(loose?.servings.amount).toBeNull();
    const html = recipeSteps(loose, t).html;
    expect(html).toContain("Neu");
    expect(html).toContain("Etwas");
    expect(html).toContain("Salz");
    expect(html).not.toContain("min preparation");
    expect(recipeSteps(null, t).html).toContain("No steps to show.");
  });
});
