// Parses the body Mealie posts when a user clicks a recipe action of type "post".
// Mealie dumps that body without aliases, so its keys are snake_case:
// {"action": {...}, "content": <recipe>, "recipe_scale": 1.5}. A camelCase variant
// (recipeScale) is accepted as well. Only the recipe id, the scale and the action title
// are read; the recipe itself is fetched again over the REST API.

import { z } from "zod";

export interface RecipeAction {
  recipeId: string;
  scale: number;
  actionTitle?: string;
}

export const MAX_SCALE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\s*\d+(?:\.\d+)?\s*$/;

export class InvalidRecipeActionError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid recipe action body: ${issues.join("; ")}`);
    this.name = "InvalidRecipeActionError";
    this.issues = issues;
  }
}

const bodySchema = z.looseObject({
  action: z.looseObject({ title: z.string().nullish() }).nullish(),
  content: z.looseObject({
    id: z.string().regex(UUID, "must be a UUID"),
  }),
  recipe_scale: z.unknown().optional(),
  recipeScale: z.unknown().optional(),
});

// A number, a numeric string, or nothing. Range checks happen afterwards.
function readScale(value: unknown): number | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && NUMERIC.test(value)) return Number(value);
  return "invalid";
}

export function parseRecipeActionBody(body: unknown): RecipeAction {
  const result = bodySchema.safeParse(body);
  if (!result.success) {
    throw new InvalidRecipeActionError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`),
    );
  }
  const data = result.data;
  // recipe_scale wins when both spellings are present.
  const [key, raw] =
    data.recipe_scale !== undefined && data.recipe_scale !== null
      ? ["recipe_scale", data.recipe_scale]
      : ["recipeScale", data.recipeScale];
  const read = readScale(raw);
  if (read === "invalid") throw new InvalidRecipeActionError([`${key}: must be a number`]);
  // Mealie sends 1 when the servings scaler was not touched; treat a missing value the same.
  const scale = read ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_SCALE) {
    throw new InvalidRecipeActionError([`${key}: must be above 0 and at most ${MAX_SCALE}`]);
  }
  const action: RecipeAction = { recipeId: data.content.id.toLowerCase(), scale };
  const title = data.action?.title?.trim();
  if (title) action.actionTitle = title;
  return action;
}
