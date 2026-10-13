export {
  parseIngredientLine,
  isHeaderLine,
  mentionsOptional,
  cleanIngredientText,
} from "./parse.js";
export type { ParsedIngredient, ParseOptions } from "./parse.js";
export { normalizeIngredients, MIN_CONFIDENCE } from "./normalize.js";
export type { IngredientSource, NormalizedIngredient } from "./normalize.js";
export {
  scaleIngredients,
  servingsFor,
  ROUNDING,
  DEFAULT_SERVINGS,
  MIN_SERVINGS,
  MAX_SERVINGS,
  PINCH_MIN_FACTOR,
} from "./scale.js";
export type { ScaledIngredient, ScaleFlag } from "./scale.js";
export {
  UNIT_CODES,
  UNITS,
  UNIT_CONVERSIONS,
  normalizeUnit,
  unitKind,
  isUnitCode,
} from "./units.js";
export type { UnitCode, UnitKind, UnitMatch } from "./units.js";
