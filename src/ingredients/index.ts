export {
  parseIngredientLine,
  isHeaderLine,
  mentionsOptional,
  cleanIngredientText,
} from "./parse.js";
export type { ParsedIngredient, ParseOptions } from "./parse.js";
export { normalizeIngredients, MIN_CONFIDENCE } from "./normalize.js";
export type {
  IngredientRow,
  IngredientSource,
  IngredientUnit,
  NormalizedIngredient,
} from "./normalize.js";
export {
  scaleIngredients,
  servingsFor,
  scalerBase,
  ROUNDING,
  DEFAULT_SERVINGS,
  PINCH_MIN_FACTOR,
} from "./scale.js";
export type { ScaledIngredient, ScaleFlag, ServingsInfo, ServingsRange } from "./scale.js";
export {
  UNIT_CODES,
  UNITS,
  UNIT_CONVERSIONS,
  normalizeUnit,
  unitKind,
  isUnitCode,
  unitLabel,
} from "./units.js";
export type { UnitCode, UnitKind, UnitMatch } from "./units.js";
