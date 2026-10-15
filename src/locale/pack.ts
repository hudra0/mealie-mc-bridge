// Locale packs: everything language-specific about one output language, as data under
// knowledge/locales/<locale>/. A pack holds the Monsieur Cuisine settings of the locale
// (mc.json), the unit vocabulary and unit rules (units.json), the standard phrases and the
// words the plausibility checks read in step texts (phrases.json), the wording per cooking
// technique (technique-aliases.json), the ingredient catalog of that language
// (ingredient-catalog.json) and the language-specific prompt rules (prompt-rules.md).
//
// The language-neutral knowledge files (device limits, techniques, timing model) name
// standard phrases and units by placeholder; fillPlaceholders replaces them with the
// pack's wording. A pack is checked when it is loaded: a missing file, a missing field or
// a placeholder the pack cannot fill fails the load, so a broken pack never reaches a
// conversion.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { isUnitCode } from "../ingredients/units.js";
import { validPhraseEntry } from "./matcher.js";

export const LOCALES_DIR = "locales";
export const DEFAULT_LOCALE = "de-DE";

export const PACK_FILES = {
  mc: "mc.json",
  units: "units.json",
  phrases: "phrases.json",
  techniqueAliases: "technique-aliases.json",
  ingredientCatalog: "ingredient-catalog.json",
  promptRules: "prompt-rules.md",
} as const;

// The unit concepts a pack names. Placeholders such as {{unit:teaspoon}} use them, so the
// neutral files can say "teaspoon" whatever the language writes ("Tl", "tsp").
export const UNIT_CONCEPTS = [
  "gram",
  "kilogram",
  "millilitre",
  "litre",
  "teaspoon",
  "tablespoon",
  "pinch",
  "knifeTip",
  "piece",
] as const;
export type UnitConcept = (typeof UNIT_CONCEPTS)[number];

// The labels of the recipe as the converter reads it (src/mealie/render.ts).
export const SECTION_LABEL_KEYS = [
  "untitled",
  "servings",
  "servingsNotGiven",
  "fromYield",
  "factor",
  "yield",
  "prepTime",
  "cookTime",
  "performTime",
  "totalTime",
  "categories",
  "tags",
  "ingredients",
  "noIngredients",
  "steps",
  "noSteps",
  "notes",
  "nutrition",
  "nutritionNote",
  "original",
  "check",
  "unparsed",
  "unscaled",
  "fractionalCount",
  "optional",
] as const;
export type SectionLabelKey = (typeof SECTION_LABEL_KEYS)[number];

export class LocalePackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalePackError";
  }
}

export const LOCALE_PATTERN = /^[a-z]{2,3}-[A-Z]{2}$/;
const localeId = z.string().regex(LOCALE_PATTERN, "must look like de-DE");
const text = z.string().min(1);
const textList = z.array(text);
// A word-list entry read in step texts: "^" or "$" alone would match almost every text.
const phrase = z.string().refine(validPhraseEntry, "needs text between ^ and $");
const phraseList = z.array(phrase);

export const mcLocaleSchema = z.strictObject({
  locale: localeId,
  // The language name the prompt asks for, in English: "German".
  language: text,
  // The "lang" field of the website proxy envelope.
  proxyLang: text,
  acceptLanguage: text,
  // Path of the web editor, which is also the Referer of every proxy call.
  editorPath: z.string().startsWith("/", "must start with /"),
  complexityIds: z.strictObject({
    easy: z.number().int().positive(),
    medium: z.number().int().positive(),
    hard: z.number().int().positive(),
  }),
  // The name the web editor gives an unnamed ingredient group.
  defaultGroupName: text,
  // True once a recipe built with this pack showed up and cooked on a device.
  verifiedOnDevice: z.boolean(),
  notes: textList,
});

const vocabularyEntry = z.strictObject({
  concept: z.enum(UNIT_CONCEPTS),
  // The unit code of src/ingredients/units.ts this spelling stands for.
  code: z.string().refine(isUnitCode, "must be a unit code of src/ingredients/units.ts"),
  singular: text,
  plural: text,
  // More spellings that step texts or ingredient lists use, lower case.
  aliases: textList,
});

const range = z.tuple([z.number(), z.number()]);
const gramsPerUnit = z.union([z.number(), z.string(), z.record(z.string(), z.number()), z.null()]);

export const packUnitsSchema = z.looseObject({
  description: z.string(),
  locale: localeId,
  vocabulary: z
    .array(vocabularyEntry)
    .min(1)
    .superRefine((entries, ctx) => {
      const seen = new Set(entries.map((entry) => entry.concept));
      for (const concept of UNIT_CONCEPTS) {
        if (!seen.has(concept)) {
          ctx.addIssue({ code: "custom", message: `the unit concept ${concept} is missing` });
        }
      }
      if (seen.size !== entries.length) {
        ctx.addIssue({ code: "custom", message: "each unit concept may appear only once" });
      }
    }),
  // How the converter's input writes decimals: "0,5" or "0.5".
  decimalSeparator: z.enum([",", "."]),
  allowedUnits: z.array(z.looseObject({ unit: z.string(), use: z.string() })).min(1),
  notAllowed: textList,
  amountFormat: z.looseObject({ rules: textList }),
  roundingGrid: z.looseObject({
    grams: z
      .array(
        z.looseObject({ band: z.tuple([z.number(), z.number().nullable()]), step: z.number() }),
      )
      .min(1),
    spoons: z.string().optional(),
  }),
  freeTextMapping: z
    .array(
      z.looseObject({
        input: z.array(z.string()),
        target: z.string(),
        gramsPerUnit: gramsPerUnit.optional(),
        nameRule: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .min(1),
  pieceWeights: z.looseObject({
    items: z.array(
      z.looseObject({
        name: text,
        unit: z.string(),
        grams: z.number().positive(),
        range: range.optional(),
      }),
    ),
  }),
  nameConventions: textList,
  groups: z.looseObject({ style: z.string().optional() }).optional(),
  // Words for the density keys of knowledge/units.json, matched like ingredient words.
  densityWords: z.record(z.string(), textList),
  // Words for liquids. A cup of anything else is a volume of a solid, whose weight the
  // amount check cannot know. Read on the source recipe, so the words of every pack count.
  liquidWords: textList.min(1),
  // The serving size of the recipe: the word for portions, used when the Mealie recipe
  // gives a number of servings but no yield text, and how official recipes of the language
  // write the first letter of a serving unit ("Scheiben" in German, "slices" in English).
  servings: z.looseObject({
    portion: z.strictObject({ singular: text, plural: text }),
    unitCase: z.enum(["capitalize", "lower"]),
  }),
});

const sectionLabelShape = Object.fromEntries(
  SECTION_LABEL_KEYS.map((key) => [key, text]),
) as Record<SectionLabelKey, typeof text>;
const sectionLabels = z.looseObject({
  ...sectionLabelShape,
  nutrients: z.record(z.string(), text),
});

export const packPhrasesSchema = z.looseObject({
  description: z.string(),
  locale: localeId,
  // Standard device phrases by id, for the prompt ({{phrase:<id>}}) and the checks.
  standardPhrases: z.record(z.string(), text),
  stepTitleRules: z.looseObject({
    workingStepTitles: textList.min(1),
    turboTitle: text,
    scaleTitle: text,
    scaleDescription: text,
    scaleExample: text,
  }),
  // The lists below are read in step texts. An entry matches anywhere inside a word,
  // case-insensitively; a leading ^ ties it to the start of a word, a trailing $ to its end.
  additionVerbs: phraseList.min(1),
  emptyingPhrases: phraseList.min(1),
  coolingPhrases: phraseList.min(1),
  reservedPhrases: phraseList.min(1),
  reusedPhrases: phraseList,
  outsideBowlPhrases: phraseList.min(1),
  hotPhrases: phraseList,
  whiskPhrases: z.looseObject({
    accessory: phraseList.min(1),
    fit: phraseList,
    remove: phraseList,
  }),
  // A number followed by one of these is a size, a time or a setting, not an amount.
  measureWords: phraseList,
  // "plus mehr", "plus more": the source allows more than its amount. Read on the source
  // recipe, so the words of every pack count.
  moreAllowedWords: phraseList,
  ingredientWords: z.looseObject({
    foaming: textList,
    liquid: textList.min(1),
    flour: textList.min(1),
    water: textList.min(1),
  }),
  matching: z.looseObject({
    stopwords: textList,
    // Endings stripped so singular and plural meet, tried in order.
    stemEndings: textList,
    // Short last parts of compound names that still identify the ingredient ("öl").
    compoundTails: textList,
    // Regional names and the name Monsieur Cuisine recipes use for the same food.
    regionalNames: z.record(z.string(), text),
  }),
  // Trailing phrases of an ingredient name that say how it is used ("zum Garnieren"). The
  // ingredient-id lookup tries the name without them when the full name is not in the
  // catalog (src/ingredients/catalog-match.ts).
  qualifierSuffixes: textList,
  // Trailing phrases that name a buying form ("aus der Dose", "frisch"), each with the
  // words that mark the form in a catalog name. The lookup drops one only when no catalog
  // entry has the base name in that form, since canned tomatoes are another product.
  buyingFormSuffixes: z.record(z.string(), textList.min(1)).default({}),
  // Matching Mealie categories and tags with the Monsieur Cuisine catalog by name. Read on
  // Mealie names, so the lists of every pack count.
  categoryMatching: z.looseObject({
    stopwords: textList,
    joiners: textList,
    stemEndings: textList,
  }),
  sectionLabels,
});

export const techniqueAliasesSchema = z.looseObject({
  description: z.string(),
  locale: localeId,
  techniques: z.record(z.string(), z.looseObject({ aliases: textList.min(1) })),
  ingredientClassWords: z.record(z.string(), textList.min(1)),
});

export type McLocale = z.infer<typeof mcLocaleSchema>;
export type PackUnits = z.infer<typeof packUnitsSchema>;
export type PackPhrases = z.infer<typeof packPhrasesSchema>;
export type TechniqueAliases = z.infer<typeof techniqueAliasesSchema>;
export type UnitVocabularyEntry = PackUnits["vocabulary"][number];

export interface LocalePack {
  locale: string;
  // The pack directory, absolute.
  dir: string;
  mc: McLocale;
  units: PackUnits;
  phrases: PackPhrases;
  techniqueAliases: TechniqueAliases;
  // The language-specific prompt rules as written, Markdown.
  promptRules: string;
}

// The pack contents as text, one entry per file (the catalog is loaded on its own).
export interface PackTexts {
  mc: string;
  units: string;
  phrases: string;
  techniqueAliases: string;
  promptRules: string;
}

export function packDir(knowledgeDir: string, locale: string): string {
  return resolve(knowledgeDir, LOCALES_DIR, locale);
}

// The locales that have a pack: folders under <knowledgeDir>/locales with an mc.json, sorted.
export function availableLocales(knowledgeDir: string): string[] {
  const dir = resolve(knowledgeDir, LOCALES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, PACK_FILES.mc)))
    .map((entry) => entry.name)
    .sort();
}

// The error text for a locale without a pack, naming the ones there are.
export function unknownLocaleMessage(locale: string, available: readonly string[]): string {
  const list = available.length > 0 ? available.join(", ") : "none";
  return `there is no locale pack for ${locale} (available: ${list})`;
}

function parseJson<T extends z.ZodType>(schema: T, source: string, label: string): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    throw new LocalePackError(`${label} is not valid JSON`, { cause: error });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new LocalePackError(`${label} does not have the expected shape: ${issues}`);
  }
  return result.data;
}

function markdown(source: string, label: string): string {
  const trimmed = source.replace(/\r\n?/g, "\n").trim();
  if (!trimmed.startsWith("# "))
    throw new LocalePackError(`${label} must start with a "# " heading`);
  return trimmed;
}

// Checks the file contents of a pack and builds it. Every file must name the same locale
// as the folder.
export function parseLocalePack(files: PackTexts, locale: string, dir = locale): LocalePack {
  const label = (file: string) => `${LOCALES_DIR}/${locale}/${file}`;
  const mc = parseJson(mcLocaleSchema, files.mc, label(PACK_FILES.mc));
  const units = parseJson(packUnitsSchema, files.units, label(PACK_FILES.units));
  const phrases = parseJson(packPhrasesSchema, files.phrases, label(PACK_FILES.phrases));
  const techniqueAliases = parseJson(
    techniqueAliasesSchema,
    files.techniqueAliases,
    label(PACK_FILES.techniqueAliases),
  );
  const named = [
    [PACK_FILES.mc, mc.locale],
    [PACK_FILES.units, units.locale],
    [PACK_FILES.phrases, phrases.locale],
    [PACK_FILES.techniqueAliases, techniqueAliases.locale],
  ] as const;
  for (const [file, value] of named) {
    if (value !== locale) {
      throw new LocalePackError(`${label(file)} names the locale ${value}, not ${locale}`);
    }
  }
  return {
    locale,
    dir,
    mc,
    units,
    phrases,
    techniqueAliases,
    promptRules: markdown(files.promptRules, label(PACK_FILES.promptRules)),
  };
}

async function readPackFile(dir: string, file: string): Promise<string> {
  const path = join(dir, file);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new LocalePackError(`Cannot read the locale pack file ${path}`, { cause: error });
  }
}

// Reads and checks the pack of one locale. A locale without a pack fails with the list of
// the locales that have one.
export async function loadLocalePack(knowledgeDir: string, locale: string): Promise<LocalePack> {
  const dir = packDir(knowledgeDir, locale);
  if (!existsSync(join(dir, PACK_FILES.mc))) {
    throw new LocalePackError(unknownLocaleMessage(locale, availableLocales(knowledgeDir)));
  }
  const names = ["mc", "units", "phrases", "techniqueAliases", "promptRules"] as const;
  // Every read settles before an error is thrown: the first missing file in this order is
  // reported, and no read is left open.
  const results = await Promise.allSettled(
    names.map((name) => readPackFile(dir, PACK_FILES[name])),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const contents = results.map((result) => (result.status === "fulfilled" ? result.value : ""));
  const files = Object.fromEntries(names.map((name, i) => [name, contents[i] ?? ""]));
  return parseLocalePack(files as unknown as PackTexts, locale, dir);
}

// Every pack under <knowledgeDir>/locales, sorted by locale.
export async function loadAllLocalePacks(knowledgeDir: string): Promise<LocalePack[]> {
  return Promise.all(
    availableLocales(knowledgeDir).map((locale) => loadLocalePack(knowledgeDir, locale)),
  );
}

// The vocabulary entry of a unit concept. Every pack has all of them (packUnitsSchema).
export function unitEntry(pack: LocalePack, concept: UnitConcept): UnitVocabularyEntry {
  const entry = pack.units.vocabulary.find((item) => item.concept === concept);
  if (!entry) throw new LocalePackError(`${pack.locale}: the unit concept ${concept} is missing`);
  return entry;
}

// The vocabulary entry a unit spelling stands for: its singular, plural or one of its
// aliases, compared without case and without a trailing dot.
export function vocabularyFor(pack: LocalePack, spelling: string): UnitVocabularyEntry | null {
  const key = spelling.trim().toLowerCase().replace(/\.$/, "");
  if (key === "") return null;
  return (
    pack.units.vocabulary.find((entry) =>
      [entry.singular, entry.plural, ...entry.aliases].some(
        (form) => form.toLowerCase().replace(/\.$/, "") === key,
      ),
    ) ?? null
  );
}
