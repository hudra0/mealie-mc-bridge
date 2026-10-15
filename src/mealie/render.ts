// Renders a Mealie recipe as Markdown for the language model: title, meta data, the
// scaled ingredients grouped by section, the steps, notes and nutrition. The output is
// deterministic for the same input and contains no HTML. The labels and the decimal
// separator come from the locale pack of the output language (phrases.json sectionLabels,
// units.json decimalSeparator). Every ingredient line carries its index [i] in the
// ingredient list, which the converter's ingredientMapping refers to.

import {
  mentionsOptional,
  scalerBase,
  unitLabel,
  type ScaledIngredient,
  type ScaleFlag,
} from "../ingredients/index.js";
import type { LocalePack, SectionLabelKey } from "../locale/pack.js";
import { NUTRITION_KEYS, type MealieRecipe } from "./types.js";

export type RenderLabels = Readonly<Record<SectionLabelKey, string>> & {
  nutrients: Readonly<Record<string, string>>;
  decimalSeparator: "," | ".";
};

export function renderLabels(pack: LocalePack): RenderLabels {
  return { ...pack.phrases.sectionLabels, decimalSeparator: pack.units.decimalSeparator };
}

export interface RenderOptions {
  scale: number;
  servings: number;
  ingredients: readonly ScaledIngredient[];
  labels: RenderLabels;
  // The unit of the serving size and where it came from (src/pipeline/serving-size.ts).
  // A yield with a text puts the unit into the meta line: "Portionen: 5 → 10 Scheiben".
  servingSize?: { unit: string; source: "yield" | "servings" | "estimate" };
  // Tags left out of the meta line, compared without case: the bridge's own TAG_NAME,
  // which says nothing about the dish.
  excludeTags?: readonly string[];
}

function unitText(item: ScaledIngredient): string {
  if (item.unit === null) return "";
  const plural = item.quantityMax !== null || (item.quantity !== null && item.quantity > 1);
  return unitLabel(item.unit, plural);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// A number with up to three decimals: 0.5 becomes "0,5" with a decimal comma.
export function formatNumber(value: number, separator: "," | "." = ","): string {
  return String(Math.round(value * 1000) / 1000).replace(".", separator);
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

function amountText(item: ScaledIngredient, labels: RenderLabels): string {
  if (item.quantity === null) return "";
  const number = (value: number) => formatNumber(value, labels.decimalSeparator);
  const max = item.quantityMax === null ? "" : `–${number(item.quantityMax)}`;
  return `${number(item.quantity)}${max}`;
}

function flagText(
  flags: readonly ScaleFlag[],
  item: ScaledIngredient,
  scale: number,
  labels: RenderLabels,
): string[] {
  const texts: string[] = [];
  if (item.source === "unparsed") {
    texts.push(
      flags.includes("unscaled")
        ? `${labels.unparsed}, ${labels.unscaled.replace("{factor}", formatNumber(scale, labels.decimalSeparator))}`
        : labels.unparsed,
    );
  }
  if (flags.includes("checkRounding")) texts.push(labels.fractionalCount);
  return texts;
}

function ingredientLine(
  item: ScaledIngredient,
  index: number,
  scale: number,
  labels: RenderLabels,
): string {
  const parts: string[] = [];
  if (item.source === "unparsed") {
    parts.push(`[${labels.original}: ${item.original || item.food}]`);
  } else {
    const main = [amountText(item, labels), unitText(item), item.food]
      .filter((part) => part !== "")
      .join(" ");
    parts.push(main);
    let note = item.note;
    if (item.optional && !mentionsOptional(note)) {
      note = note ? `${note}, ${labels.optional}` : labels.optional;
    }
    if (note) parts.push(`(${note})`);
    if (item.source === "parsed" && item.original) {
      parts.push(`[${labels.original}: ${item.original}]`);
    }
  }
  const flags = flagText(item.flags, item, scale, labels);
  const line = parts.join(" ");
  return `- [${index}] ${line}${flags.length > 0 ? ` — ${labels.check}: ${flags.join("; ")}` : ""}`;
}

function metaLine(recipe: MealieRecipe, options: RenderOptions): string {
  const { labels } = options;
  const number = (value: number) => formatNumber(value, labels.decimalSeparator);
  const parts: string[] = [];
  const yieldUnit = options.servingSize?.source === "yield" ? options.servingSize.unit : null;
  // The same base as Mealie's servings scaler: servings, else the yield quantity. A yield
  // with a text is the serving size itself.
  const base = yieldUnit !== null ? recipe.recipeYieldQuantity : scalerBase(recipe);
  const fromYield = base !== null && (yieldUnit !== null || !(recipe.recipeServings > 0));
  const source = fromYield ? ` (${labels.fromYield})` : "";
  const target = yieldUnit === null ? String(options.servings) : `${options.servings} ${yieldUnit}`;
  if (base === null) {
    parts.push(`${labels.servings}: ${target} (${labels.servingsNotGiven})`);
  } else if (base !== options.servings) {
    parts.push(`${labels.servings}: ${number(base)} → ${target}${source}`);
  } else {
    parts.push(`${labels.servings}: ${target}${source}`);
  }
  if (options.scale !== 1) parts.push(`${labels.factor}: ${number(options.scale)}`);
  const yieldText = [
    recipe.recipeYieldQuantity > 0 ? number(recipe.recipeYieldQuantity) : "",
    plainText(recipe.recipeYield),
  ]
    .filter(Boolean)
    .join(" ");
  if (yieldText) parts.push(`${labels.yield}: ${yieldText}`);
  const times: Array<[string, string | null]> = [
    [labels.prepTime, recipe.prepTime],
    [labels.cookTime, recipe.cookTime],
    [labels.performTime, recipe.performTime],
    [labels.totalTime, recipe.totalTime],
  ];
  for (const [label, value] of times) {
    const text = plainText(value);
    if (text) parts.push(`${label}: ${text}`);
  }
  const categories = recipe.recipeCategory.map((category) => category.name).filter(Boolean);
  if (categories.length > 0) parts.push(`${labels.categories}: ${categories.join(", ")}`);
  const excluded = new Set((options.excludeTags ?? []).map((tag) => tag.trim().toLowerCase()));
  const tags = recipe.tags
    .map((tag) => tag.name)
    .filter((name) => name && !excluded.has(name.trim().toLowerCase()));
  if (tags.length > 0) parts.push(`${labels.tags}: ${tags.join(", ")}`);
  return parts.join(" · ");
}

function ingredientsSection(options: RenderOptions): string[] {
  const { labels } = options;
  const lines: string[] = [`## ${labels.ingredients}`, ""];
  if (options.ingredients.length === 0) return [...lines, labels.noIngredients];
  let section: string | null = null;
  options.ingredients.forEach((item, index) => {
    if (item.section !== section && item.section !== null) {
      if (lines[lines.length - 1] !== "") lines.push("");
      lines.push(`### ${plainText(item.section)}`, "");
    }
    section = item.section;
    lines.push(ingredientLine(item, index, options.scale, labels));
  });
  return lines;
}

function stepsSection(recipe: MealieRecipe, labels: RenderLabels): string[] {
  const lines: string[] = [`## ${labels.steps}`, ""];
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
  if (number === 0) lines.push(labels.noSteps);
  return lines;
}

function notesSection(recipe: MealieRecipe, labels: RenderLabels): string[] {
  const notes = recipe.notes
    .map((note) => ({ title: plainText(note.title), text: plainText(note.text) }))
    .filter((note) => note.title || note.text);
  if (notes.length === 0) return [];
  const lines: string[] = [`## ${labels.notes}`];
  for (const note of notes) {
    lines.push("");
    if (note.title) lines.push(`### ${note.title}`, "");
    if (note.text) lines.push(note.text);
  }
  return lines;
}

function nutritionSection(recipe: MealieRecipe, labels: RenderLabels): string[] {
  const nutrition = recipe.nutrition;
  if (!nutrition) return [];
  const entries = NUTRITION_KEYS.map((key) => [key, plainText(nutrition[key])] as const).filter(
    ([, value]) => value !== "",
  );
  if (entries.length === 0) return [];
  return [
    `## ${labels.nutrition}`,
    "",
    labels.nutritionNote,
    "",
    ...entries.map(([key, value]) => `- ${labels.nutrients[key] ?? key}: ${value}`),
  ];
}

export function renderRecipeForLlm(recipe: MealieRecipe, options: RenderOptions): string {
  const { labels } = options;
  const blocks: string[][] = [[`# ${plainText(recipe.name) || labels.untitled}`]];
  const description = plainText(recipe.description);
  if (description) blocks.push([description]);
  blocks.push([metaLine(recipe, options)]);
  blocks.push(ingredientsSection(options));
  blocks.push(stepsSection(recipe, labels));
  const notes = notesSection(recipe, labels);
  if (notes.length > 0) blocks.push(notes);
  const nutrition = nutritionSection(recipe, labels);
  if (nutrition.length > 0) blocks.push(nutrition);
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}
