// Renders a Mealie recipe as Markdown for the language model: title, meta data, the
// scaled ingredients grouped by section, the steps, notes and nutrition. The output is
// deterministic for the same input and contains no HTML. Headings are German because the
// generated Monsieur Cuisine recipe is German.

import {
  mentionsOptional,
  scalerBase,
  unitLabel,
  type ScaledIngredient,
  type ScaleFlag,
} from "../ingredients/index.js";
import { NUTRITION_KEYS, type MealieRecipe, type NutritionKey } from "./types.js";

export interface RenderOptions {
  scale: number;
  servings: number;
  ingredients: readonly ScaledIngredient[];
}

function unitText(item: ScaledIngredient): string {
  if (item.unit === null) return "";
  const plural = item.quantityMax !== null || (item.quantity !== null && item.quantity > 1);
  return unitLabel(item.unit, plural);
}

const NUTRITION_LABELS: Readonly<Record<NutritionKey, string>> = {
  calories: "Kalorien",
  carbohydrateContent: "Kohlenhydrate",
  cholesterolContent: "Cholesterin",
  fatContent: "Fett",
  fiberContent: "Ballaststoffe",
  proteinContent: "Eiweiß",
  saturatedFatContent: "Gesättigte Fettsäuren",
  sodiumContent: "Natrium",
  sugarContent: "Zucker",
  transFatContent: "Transfette",
  unsaturatedFatContent: "Ungesättigte Fettsäuren",
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// German number format with up to three decimals: 0.5 becomes "0,5".
export function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace(".", ",");
}

// Mealie text is Markdown, but imported recipes sometimes carry HTML. Tags are dropped,
// line breaks and paragraphs become newlines, common entities are decoded.
export function plainText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6])(?:\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function amountText(item: ScaledIngredient): string {
  if (item.quantity === null) return "";
  const max = item.quantityMax === null ? "" : `–${formatNumber(item.quantityMax)}`;
  return `${formatNumber(item.quantity)}${max}`;
}

function flagText(flags: readonly ScaleFlag[], item: ScaledIngredient, scale: number): string[] {
  const texts: string[] = [];
  if (item.source === "unparsed") {
    texts.push(
      flags.includes("unscaled")
        ? `ungeparst, Menge nicht skaliert (Faktor ${formatNumber(scale)} anwenden)`
        : "ungeparst",
    );
  }
  if (flags.includes("checkRounding")) texts.push("Stückzahl nicht ganzzahlig");
  return texts;
}

function ingredientLine(item: ScaledIngredient, scale: number): string {
  const parts: string[] = [];
  if (item.source === "unparsed") {
    parts.push(`[Original: ${item.original || item.food}]`);
  } else {
    const main = [amountText(item), unitText(item), item.food]
      .filter((part) => part !== "")
      .join(" ");
    parts.push(main);
    let note = item.note;
    if (item.optional && !mentionsOptional(note)) note = note ? `${note}, optional` : "optional";
    if (note) parts.push(`(${note})`);
    if (item.source === "parsed" && item.original) parts.push(`[Original: ${item.original}]`);
  }
  const flags = flagText(item.flags, item, scale);
  const line = parts.join(" ");
  return `- ${line}${flags.length > 0 ? ` — prüfen: ${flags.join("; ")}` : ""}`;
}

function metaLine(recipe: MealieRecipe, options: RenderOptions): string {
  const parts: string[] = [];
  // The same base as Mealie's servings scaler: servings, else the yield quantity.
  const base = scalerBase(recipe);
  const fromYield = base !== null && !(recipe.recipeServings > 0);
  const source = fromYield ? " (aus der Ergibt-Menge)" : "";
  if (base === null) {
    parts.push(`Portionen: ${options.servings} (im Rezept nicht angegeben)`);
  } else if (base !== options.servings) {
    parts.push(`Portionen: ${formatNumber(base)} → ${options.servings}${source}`);
  } else {
    parts.push(`Portionen: ${options.servings}${source}`);
  }
  if (options.scale !== 1) parts.push(`Faktor: ${formatNumber(options.scale)}`);
  const yieldText = [
    recipe.recipeYieldQuantity > 0 ? formatNumber(recipe.recipeYieldQuantity) : "",
    plainText(recipe.recipeYield),
  ]
    .filter(Boolean)
    .join(" ");
  if (yieldText) parts.push(`Ergibt: ${yieldText}`);
  const times: Array<[string, string | null]> = [
    ["Vorbereitung", recipe.prepTime],
    ["Kochzeit", recipe.cookTime],
    ["Garzeit", recipe.performTime],
    ["Gesamtzeit", recipe.totalTime],
  ];
  for (const [label, value] of times) {
    const text = plainText(value);
    if (text) parts.push(`${label}: ${text}`);
  }
  const categories = recipe.recipeCategory.map((category) => category.name).filter(Boolean);
  if (categories.length > 0) parts.push(`Kategorien: ${categories.join(", ")}`);
  const tags = recipe.tags.map((tag) => tag.name).filter(Boolean);
  if (tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);
  return parts.join(" · ");
}

function ingredientsSection(options: RenderOptions): string[] {
  const lines: string[] = ["## Zutaten", ""];
  if (options.ingredients.length === 0) return [...lines, "Keine Zutaten angegeben."];
  let section: string | null = null;
  for (const item of options.ingredients) {
    if (item.section !== section && item.section !== null) {
      if (lines[lines.length - 1] !== "") lines.push("");
      lines.push(`### ${plainText(item.section)}`, "");
    }
    section = item.section;
    lines.push(ingredientLine(item, options.scale));
  }
  return lines;
}

function stepsSection(recipe: MealieRecipe): string[] {
  const lines: string[] = ["## Zubereitung", ""];
  let number = 0;
  for (const step of recipe.recipeInstructions) {
    const text = plainText(step.text);
    const summary = plainText(step.summary);
    const title = plainText(step.title);
    if (title) {
      if (lines[lines.length - 1] !== "") lines.push("");
      lines.push(`### ${title}`, "");
    }
    if (!text && !summary) continue;
    number++;
    const prefix = `${number}. `;
    const body = summary ? `**${summary}**${text ? `: ${text}` : ""}` : text;
    const indent = " ".repeat(prefix.length);
    lines.push(prefix + body.replace(/\n+/g, `\n${indent}`));
  }
  if (number === 0) lines.push("Keine Schritte angegeben.");
  return lines;
}

function notesSection(recipe: MealieRecipe): string[] {
  const notes = recipe.notes
    .map((note) => ({ title: plainText(note.title), text: plainText(note.text) }))
    .filter((note) => note.title || note.text);
  if (notes.length === 0) return [];
  const lines: string[] = ["## Notizen"];
  for (const note of notes) {
    lines.push("");
    if (note.title) lines.push(`### ${note.title}`, "");
    if (note.text) lines.push(note.text);
  }
  return lines;
}

function nutritionSection(recipe: MealieRecipe): string[] {
  const nutrition = recipe.nutrition;
  if (!nutrition) return [];
  const entries = NUTRITION_KEYS.map((key) => [key, plainText(nutrition[key])] as const).filter(
    ([, value]) => value !== "",
  );
  if (entries.length === 0) return [];
  return [
    "## Nährwerte",
    "",
    "Laut Rezept, nicht skaliert.",
    "",
    ...entries.map(([key, value]) => `- ${NUTRITION_LABELS[key]}: ${value}`),
  ];
}

export function renderRecipeForLlm(recipe: MealieRecipe, options: RenderOptions): string {
  const blocks: string[][] = [[`# ${plainText(recipe.name) || "Ohne Titel"}`]];
  const description = plainText(recipe.description);
  if (description) blocks.push([description]);
  blocks.push([metaLine(recipe, options)]);
  blocks.push(ingredientsSection(options));
  blocks.push(stepsSection(recipe));
  const notes = notesSection(recipe);
  if (notes.length > 0) blocks.push(notes);
  const nutrition = nutritionSection(recipe);
  if (nutrition.length > 0) blocks.push(nutrition);
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}
