// Links the ingredient list of a converted recipe to the source ingredients through the
// recipe's ingredientMapping, so the plausibility checks can compare coverage and amounts
// whatever the languages of source and recipe. Names are not compared across languages:
// the mapping says which source line [i] each list entry comes from.
//
// The list is read as items, one per distinct name (the same name in two groups is one
// item with two entries). Items and source lines that the mapping connects form clusters:
// one item from one source line in the usual case, one item from two source lines when the
// converter merged them, two items from one line when it split it. Amounts are compared
// per cluster.

import { normalizeIngredientName } from "../ingredients/catalog.js";
import type { NormalizedIngredient } from "../ingredients/index.js";
import type { Ingredient, RecipeInput } from "../recipe/schema.js";
import type { TextRules } from "./text.js";

export interface ListEntry {
  path: string;
  entry: Ingredient;
}

export interface OutputItem {
  // The name as first written in the list.
  name: string;
  // normalizeIngredientName(name).
  key: string;
  entries: ListEntry[];
  // Source positions the mapping links to this item.
  inputs: number[];
  // Whether the mapping has an entry for this item, with an index or null.
  mapped: boolean;
}

export interface Cluster {
  items: number[];
  inputs: number[];
}

export interface MappingProblem {
  // The mapping entry, for the error path.
  position: number;
  name: string;
  inputIndex: number | null;
}

export interface IngredientLinks {
  items: OutputItem[];
  // The name keys of each item, for finding it in step texts.
  keys: string[][];
  clusters: Cluster[];
  clusterOfItem: number[];
  // Source position to cluster, for the positions the mapping links.
  clusterOfInput: ReadonlyMap<number, number>;
  // False when the recipe has no ingredientMapping at all (a recipe written by hand).
  hasMapping: boolean;
  // Mapping entries whose name is not in the list.
  unknownNames: MappingProblem[];
  // Mapping entries whose index points past the source list.
  badIndices: MappingProblem[];
  // Items the mapping does not mention.
  unmappedItems: number[];
  // Source positions no mapping entry links.
  unmappedInputs: number[];
}

// The keys of an ingredient name without its qualifiers in parentheses: steps use the name
// without them, and "Auflaufform (ca. 20 x 30 cm)" or "Spaghetti (Kochzeit 9 Minuten)"
// would otherwise match "30 cm" or "9 Minuten" in a step. A name that is only a
// parenthesis keeps its keys.
export function ingredientKeys(text: TextRules, name: string): string[] {
  const keys = text.nameKeys(name.replace(/\([^)]*\)/gu, " "));
  return keys.length > 0 ? keys : text.nameKeys(name);
}

function listItems(recipe: RecipeInput): OutputItem[] {
  const items: OutputItem[] = [];
  const byKey = new Map<string, OutputItem>();
  recipe.servingSize.ingredientGroups.forEach((group, g) => {
    group.ingredients.forEach((entry, k) => {
      const key = normalizeIngredientName(entry.name);
      const path = `servingSize.ingredientGroups[${g}].ingredients[${k}]`;
      let item = byKey.get(key);
      if (!item) {
        item = { name: entry.name, key, entries: [], inputs: [], mapped: false };
        byKey.set(key, item);
        items.push(item);
      }
      item.entries.push({ path, entry });
    });
  });
  return items;
}

// The item a mapping name stands for: the same name after normalization, else the one item
// whose keys all occur in the mapping name and whose name keys it covers (a qualifier left
// out or added). Null when there is none or more than one.
function itemFor(
  name: string,
  items: readonly OutputItem[],
  keys: readonly string[][],
  text: TextRules,
): number | null {
  const key = normalizeIngredientName(name);
  const exact = items.findIndex((item) => item.key === key);
  if (exact >= 0) return exact;
  const wanted = ingredientKeys(text, name);
  if (wanted.length === 0) return null;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value) => b.includes(value));
  const found = keys.flatMap((itemKeys, position) => (same(itemKeys, wanted) ? [position] : []));
  return found.length === 1 ? (found[0] ?? null) : null;
}

export function linkIngredients(
  recipe: RecipeInput,
  inputs: readonly NormalizedIngredient[],
  text: TextRules,
): IngredientLinks {
  const items = listItems(recipe);
  const keys = items.map((item) => ingredientKeys(text, item.name));
  const mapping = recipe.ingredientMapping;
  const unknownNames: MappingProblem[] = [];
  const badIndices: MappingProblem[] = [];
  const linkedInputs = new Set<number>();
  (mapping ?? []).forEach((entry, position) => {
    // Providers drop null fields, so a missing index means null.
    const inputIndex = entry.inputIndex ?? null;
    const problem = { position, name: entry.name, inputIndex };
    const item = itemFor(entry.name, items, keys, text);
    if (item === null) {
      unknownNames.push(problem);
      // The entry covers its source line; the only problem to report is the name.
      if (inputIndex !== null && inputIndex < inputs.length) linkedInputs.add(inputIndex);
      return;
    }
    const target = items[item];
    if (!target) return;
    target.mapped = true;
    if (inputIndex === null) return;
    if (inputIndex >= inputs.length) {
      badIndices.push(problem);
      return;
    }
    if (!target.inputs.includes(inputIndex)) target.inputs.push(inputIndex);
    linkedInputs.add(inputIndex);
  });

  // Clusters: items joined through the source lines they share.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const firstItemOfInput = new Map<number, number>();
  items.forEach((item, i) => {
    for (const input of item.inputs) {
      const other = firstItemOfInput.get(input);
      if (other === undefined) firstItemOfInput.set(input, i);
      else parent[find(i)] = find(other);
    }
  });
  const clusters: Cluster[] = [];
  const clusterOfRoot = new Map<number, number>();
  const clusterOfItem = items.map((_, i) => {
    const root = find(i);
    let cluster = clusterOfRoot.get(root);
    if (cluster === undefined) {
      cluster = clusters.length;
      clusterOfRoot.set(root, cluster);
      clusters.push({ items: [], inputs: [] });
    }
    clusters[cluster]?.items.push(i);
    return cluster;
  });
  const clusterOfInput = new Map<number, number>();
  items.forEach((item, i) => {
    const cluster = clusters[clusterOfItem[i] ?? -1];
    if (!cluster) return;
    for (const input of item.inputs) {
      if (!cluster.inputs.includes(input)) cluster.inputs.push(input);
      clusterOfInput.set(input, clusterOfItem[i] ?? -1);
    }
  });
  for (const cluster of clusters) cluster.inputs.sort((a, b) => a - b);

  return {
    items,
    keys,
    clusters,
    clusterOfItem,
    clusterOfInput,
    hasMapping: mapping !== undefined,
    unknownNames,
    badIndices,
    unmappedItems:
      mapping === undefined ? [] : items.flatMap((item, i) => (item.mapped ? [] : [i])),
    unmappedInputs: inputs.flatMap((_, position) => (linkedInputs.has(position) ? [] : [position])),
  };
}

// Positions of the items a text names, best matches only.
export function mentionedItems(text: TextRules, source: string, links: IngredientLinks): number[] {
  const stems = text.words(source).map(text.stem);
  const scores = links.keys.map((keys) => text.matchScore(keys, stems));
  const best = Math.max(0, ...scores);
  if (best === 0) return [];
  return scores.flatMap((score, position) => (score === best ? [position] : []));
}

// The one item a phrase names, or null when it names none or several equally.
export function attributeItem(
  text: TextRules,
  phrase: string,
  links: IngredientLinks,
): number | null {
  const found = mentionedItems(text, phrase, links);
  return found.length === 1 ? (found[0] ?? null) : null;
}

// The source ingredients a name matches by name, for recipes without a mapping and for
// source lines the mapping left out. Only reliable when source and recipe share a language.
export function inputsNamedIn(
  text: TextRules,
  inputs: readonly NormalizedIngredient[],
  names: readonly string[],
): Set<number> {
  const nameStems = names.map((name) => text.words(name).map(text.stem));
  const found = new Set<number>();
  inputs.forEach((ingredient, position) => {
    const keys = ingredientKeys(text, ingredient.food);
    if (keys.length > 0 && nameStems.some((stems) => text.matchScore(keys, stems) > 0)) {
      found.add(position);
    }
  });
  return found;
}
