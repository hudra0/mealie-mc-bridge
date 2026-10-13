// Technique rulebook: assigns a cooking technique to every machine step of a
// normalized recipe, using German keywords in the step title and the text
// steps around it. All rules are data in this file; analyze-techniques.ts only
// aggregates.
//
// Classification runs in two stages:
//   1. Family: what kind of action the step performs (chop, simmer, knead ...).
//      Sources, in order: device mode for the fixed programs, keywords in the
//      step title, a repeat marker ("run the next step if needed"), keywords in
//      the text after and before the step, then bowl contents plus a binary
//      heat flag (heated or not).
//   2. Technique: the family is refined with context (ingredients, accessories,
//      recipe title), for example simmer + pasta -> "nudeln_garen".
//
// Numeric settings (temperature value, time, speed) are never used, so the
// statistics computed per technique are not circular. The only setting-derived
// input is the heat flag: temperature > 0, or a heating program mode.

import type { NormalizedStep } from "./types.js";

// ---------------------------------------------------------------------------
// Vocabulary

export const techniques = {
  waage: "Waage / abwiegen",
  zerkleinern: "Zerkleinern / hacken",
  fein_mahlen: "Fein mahlen / pulverisieren",
  puerieren: "Pürieren (kalt)",
  suppe_puerieren_heiss: "Suppe/Sauce heiß pürieren",
  mixen_smoothie: "Mixen / Smoothie / Shake",
  eis_gefrorenes: "Eis / gefrorene Früchte / Crushed Ice",
  schlagen: "Schlagen (Sahne, Eiweiß)",
  emulgieren: "Emulgieren (Mayonnaise, Dressing)",
  anschwitzen: "Anschwitzen / andünsten",
  anbraten: "Anbraten (Fleisch, Gemüse)",
  roesten: "Rösten (Nüsse, Gewürze, Zucker)",
  aufkochen: "Aufkochen",
  koecheln_garen: "Köcheln / garen (Sauce, Suppe, Eintopf)",
  eindicken_binden: "Eindicken / binden",
  risotto_reis: "Risotto / Reis garen",
  nudeln_garen: "Nudeln garen",
  milchreis_pudding_brei: "Milchreis / Pudding / Brei / Creme",
  marmelade_einkochen: "Marmelade einkochen",
  schmelzen: "Schmelzen (Butter, Schokolade)",
  erwaermen_temperieren: "Erwärmen / temperieren",
  hefe_aktivieren: "Hefe in Flüssigkeit auflösen",
  hefeteig_kneten: "Hefeteig kneten",
  muerbteig_kneten: "Mürbteig / fester Teig ohne Hefe kneten",
  ruehrteig_biskuit: "Rührteig / Biskuit / flüssiger Teig",
  daempfen_gareinsatz: "Dämpfen/garen im Gareinsatz",
  daempfen_dampfgaraufsatz: "Dämpfen im Dampfgaraufsatz",
  daempfen_unbestimmt: "Dämpfen, Zubehör nicht genannt",
  ruehren_kalt: "Rühren ohne Hitze (unterheben, vermengen)",
  sous_vide: "Sous-vide",
  slow_cooking: "Slow Cooking",
  fermentieren: "Fermentieren (Joghurt, Teig)",
  eier_kochen: "Eier kochen",
  food_processor: "Food Processor (hobeln, raspeln)",
  vorreinigen: "Vorreinigen",
  unclassified: "Nicht klassifiziert",
} as const;

export type Technique = keyof typeof techniques;

export type Family =
  | "weigh"
  | "chop"
  | "grind"
  | "puree"
  | "mix"
  | "frozen"
  | "whip"
  | "emulsify"
  | "saute"
  | "fry"
  | "roast"
  | "boil"
  | "simmer"
  | "thicken"
  | "melt"
  | "warm"
  | "yeast"
  | "knead"
  | "batter"
  | "steam"
  | "stir"
  | "sousvide"
  | "slowcook"
  | "ferment"
  | "eggs"
  | "foodprocessor"
  | "clean";

export const ingredientClasses = [
  "meat",
  "fish",
  "onion_garlic",
  "chocolate",
  "nuts",
  "pasta",
  "rice_grain",
  "egg",
  "flour_dough",
  "fruit",
  "vegetables",
  "dairy",
  "liquid",
  "unknown",
] as const;

export type IngredientClass = (typeof ingredientClasses)[number];

// Word boundaries that respect German umlauts (\b treats "ü" as a non-word char).
const B = "(?<![a-zäöüß])";
const E = "(?![a-zäöüß])";
const re = (source: string) => new RegExp(source, "u");

const ingredientPatterns: Record<Exclude<IngredientClass, "unknown">, RegExp> = {
  meat: re(
    "hähnchen|huhn|hühner|pute|truthahn|rind|schwein|kalb|lamm|hackfleisch|hack(?:bällchen|masse)|" +
      "fleisch|speck|schinken|wurst|würstchen|salami|chorizo|bacon|gulasch|geschnetzelt|leberkäs|" +
      "frikadell|ente|gans|wild|kassler|mett|roulade|steak|schnitzel|keule|bratwurst",
  ),
  fish: re(
    "fisch|lachs|thunfisch|kabeljau|forelle|garnele|shrimp|scampi|krabbe|muschel|tintenfisch|" +
      "calamar|dorsch|zander|hering|sardelle|sardine|makrele|scholle|pangasius|meeresfrücht|rotbarsch",
  ),
  onion_garlic: re("zwiebel|schalotte|knoblauch"),
  chocolate: re("schokolade|kuvertüre|kakao|nougat|schoko"),
  nuts: re(
    "nuss|nüsse|mandel|cashew|pistazie|pinienkern|sonnenblumenkern|kürbiskern|sesam|leinsa|" +
      "kokosraspel|kokosflocken|chiasamen|macadamia|pekan",
  ),
  pasta: re(
    "nudel|spaghetti|pasta|penne|fusilli|makkaroni|maccheroni|tagliatelle|farfalle|rigatoni|" +
      "lasagne|tortellini|ravioli|gnocchi|spätzle|orzo|linguine|conchiglie",
  ),
  rice_grain: re(
    `${B}(?:milch|basmati|jasmin|risotto|langkorn|vollkorn|natur|sushi|klebe|wild)?reis${E}|risotto|` +
      "quinoa|bulgur|couscous|hirse|polenta|graupen|getreide|buchweizen|amaranth|haferflocken|grieß",
  ),
  egg: re(`${B}eier?${E}|${B}eiern${E}|eigelb|eiweiß|eiweiss|eischnee|eidotter|eiklar`),
  flour_dough: re(
    "mehl|teig|stärke|backpulver|hefe|paniermehl|semmelbrösel|brot|brötchen|toast|knödel|zwieback|keks",
  ),
  fruit: re(
    "apfel|äpfel|birne|banane|erdbeer|himbeer|heidelbeer|blaubeer|kirsch|pfirsich|aprikose|mango|" +
      "ananas|orange|zitrone|limette|beeren|traube|pflaume|zwetsch|rhabarber|kiwi|melone|maracuja|" +
      "johannisbeer|brombeer|feige|dattel|rosine|cranberr|grapefruit|quitte|früchte|obst",
  ),
  vegetables: re(
    "möhre|karotte|kartoffel|zucchini|paprika|tomate|gurke|kürbis|brokkoli|blumenkohl|spinat|lauch|" +
      "porree|sellerie|kohl|aubergine|erbsen|bohnen|champignon|pilz|spargel|rote bete|rübe|pastinake|" +
      "fenchel|salat|rucola|avocado|linsen|kichererbse|ingwer|chili|peperoni|oliven|artischocke|" +
      "radieschen|kräuter|petersilie|basilikum|schnittlauch|dill|koriandergrün|minze|gemüse|" +
      `${B}mais${E}`,
  ),
  dairy: re(
    "(?<!kokos|mandel|hafer|soja|reis)milch|sahne|butter|käse|parmesan|quark|joghurt|jogurt|schmand|" +
      "crème|creme fraiche|mascarpone|mozzarella|ricotta|feta|kefir|emmentaler|gouda|cheddar|skyr",
  ),
  liquid: re(
    `${B}wasser|brühe|fond${E}|${B}wein|saft${E}|${B}bier${E}|kokosmilch|passierte tomaten|passata|` +
      `${B}sud${E}|(?:hafer|mandel|soja)milch|${B}essig`,
  ),
};

// Weight per context field when picking the main ingredient class.
const ingredientFieldWeight = { title: 3, before: 2, bowl: 1 } as const;

// ---------------------------------------------------------------------------
// Step context

export interface StepContext {
  step: NormalizedStep;
  /** The step's own title/text, empty when it is a generic editor default. */
  title: string;
  /** Text and scale steps since the previous non-scale machine step (max 8). */
  before: string;
  /** Text steps after the step, until the next machine step (max 2). */
  after: string;
  /** Everything added since the bowl was last emptied or rinsed (max 25 steps). */
  bowl: string;
  recipeTitle: string;
  /** Heating: temperature > 0, or a heating program mode. */
  hot: boolean;
  /** Previous non-scale machine step in the same bowl, if any. */
  prev: { technique: Technique; family: Family | null; hot: boolean } | null;
}

export type Field = "title" | "before" | "after" | "bowl" | "recipe";

const heatingModes = new Set([
  "roasting",
  "steaming",
  "slow_cooking",
  "sous_vide",
  "fermentation",
  "cooking_eggs",
  "rice_cooking",
]);

export function isHot(step: Pick<NormalizedStep, "mode" | "temperature">): boolean {
  return (step.temperature ?? 0) > 0 || heatingModes.has(step.mode);
}

// Titles that are editor defaults and say nothing about the action.
const genericTitle = re(
  "^(?:manuelles kochen|rampe|step|schritt ?\\d*|zubereitung|preparation|füllung|teig|masse|" +
    "deckel schließen|food processor)\\.?$",
);

export function cleanTitle(text: string): string {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  return genericTitle.test(t) ? "" : t;
}

// Text that empties the bowl: the next ingredients start a new mixture.
export const bowlReset = re(
  "umfüllen|umgefüllt|ausspülen|ausgespült|" +
    "(?:mixbehälter|mixtopf|topf|behälter)[^|]{0,60}(?:reinigen|säubern|leeren|spülen|wischen|waschen)",
);

// ---------------------------------------------------------------------------
// Rules

export interface Pattern {
  label: string;
  re: RegExp;
}

export interface Group {
  fields: readonly Field[];
  patterns: readonly Pattern[];
}

export type Evidence = "mode" | "title" | "repeat" | "after" | "before" | "context";

export interface FamilyRule {
  family: Family;
  evidence: Evidence;
  /** Modes the rule applies to. Default: every non-scale mode without a fixed family. */
  modes?: readonly string[];
  heat?: "hot" | "cold";
  /** Previous machine step in the same bowl was heated / not heated. */
  prevHot?: boolean;
  /** Only housekeeping text (spatula, lid, measuring cup) since the previous machine step. */
  beforeHousekeeping?: boolean;
  all: readonly Group[];
  none?: readonly Group[];
}

export interface RefineRule {
  technique: Technique;
  heat?: "hot" | "cold";
  prevHot?: boolean;
  /** Main ingredient class must be one of these. */
  main?: readonly IngredientClass[];
  all?: readonly Group[];
  none?: readonly Group[];
}

const p = (label: string, source: string): Pattern => ({ label, re: re(source) });
const g = (fields: readonly Field[], ...patterns: Pattern[]): Group => ({ fields, patterns });

const T: readonly Field[] = ["title"];
const TAB: readonly Field[] = ["title", "after", "before"];
const AB: readonly Field[] = ["after", "before"];
const BE: readonly Field[] = ["before"];
const BOWL: readonly Field[] = ["before", "bowl"];
const ALL: readonly Field[] = ["title", "after", "before", "bowl", "recipe"];

// Modes with a fixed family: the program itself names the action.
export const modeFamily: Record<string, Family> = {
  scale: "weigh",
  steaming: "steam",
  sous_vide: "sousvide",
  slow_cooking: "slowcook",
  fermentation: "ferment",
  cooking_eggs: "eggs",
  precleaning: "clean",
  food_processor: "foodprocessor",
  rice_cooking: "simmer",
};

// Modes with a default family when no keyword says otherwise.
export const modeDefaultFamily: Record<string, Family> = {
  turbo: "chop",
  kneading: "knead",
  kneading_solid_dough: "knead",
  kneading_soft_dough: "knead",
  kneading_liquid_dough: "batter",
  puree: "puree",
  smoothie: "mix",
  ramp: "puree",
  roasting: "fry",
};

// Shared keyword sets.
const kw = {
  grind: [
    p("mahlen", `${B}mahlen|vermahlen|zermahlen|mehl selbst`),
    p("pulverisieren", "pulveris|puderzucker|staubfein"),
  ],
  chop: [
    p("zerkleinern", "zerkleiner|zerhack|hacken|gehackt|schroten|geschrotet"),
    p("raspeln/reiben", "raspeln|reiben|gerieben|geraspelt"),
    p("grob/klein", "grob (?:hacken|zerkleinern)|klein hacken|kleinhacken|würfeln lassen"),
  ],
  puree: [
    p("pürieren", "pürier|püree|stampf"),
    p("glatt/cremig", "glatte(?! petersilie)|glatten(?! petersilie)|samtig|feincremig|homogen"),
  ],
  mix: [
    p("mixen", `${B}mixen|gemixt|durchmixen|aufmixen|smoothie|shake|${B}lassi|cocktail|frozen`),
  ],
  frozen: [
    p(
      "gefroren/Eis",
      `gefroren|tiefgekühlt|tk-|${B}tk ${E}|eiswürfel|crushed ice|${B}eis${E}|eis herstellen|sorbet|frozen`,
    ),
  ],
  whip: [
    p("schlagen", "schlagen|aufschlag|geschlagen|steif|schaumig|eischnee|luftig"),
    p("Sahnesteif", "sahnesteif"),
  ],
  emulsify: [
    p("Mayonnaise/Aioli", "mayonnaise|mayo|aioli|remoulade|hollandaise|emulg|vinaigrette"),
    p("Öl langsam zugießen", "öl (?:langsam|nach und nach|in einem dünnen strahl)"),
  ],
  saute: [
    p("anschwitzen/andünsten", "anschwitz|andünst|dünsten|gedünstet|glasig|anlaufen|anrösten"),
  ],
  fry: [p("anbraten", "anbraten|angebraten|braten|bräunen|anbräunen|scharf an")],
  roast: [p("rösten", "rösten|geröstet|karamell")],
  boil: [p("aufkochen", "aufkochen|aufgekocht|zum kochen bringen|aufwallen")],
  simmer: [
    p("köcheln/garen", "köcheln|simmer|garen|gar sind|gar ist|garzeit|weich kochen|weiterkochen"),
    p("kochen", `${B}kochen${E}|kochen lassen|einkochen|reduzier|schmoren|ziehen lassen`),
  ],
  thicken: [
    p(
      "binden/andicken",
      "binden|andicken|eindicken|angedickt|mehlschwitze|einbrenne|roux|b[ée]chamel|soßenbinder|saucenbinder|" +
        "speisestärke|stärke",
    ),
  ],
  melt: [p("schmelzen", "schmelz|zerlassen|geschmolzen|zerlaufen")],
  warm: [
    p(
      "erwärmen/erhitzen",
      `${B}erwärm|${B}erhitz|temperier|warm halten` +
        "|warmhalten|aufwärm|auftauen|lauwarm|warm machen",
    ),
  ],
  yeast: [p("Hefe aktivieren", "hefe (?:aktivieren|auflösen|anrühren)|hefe.*auflösen|vorteig")],
  knead: [p("kneten", "kneten|geknetet|knetteig")],
  batter: [
    p(
      "Rührteig",
      "rührteig|teig[a-zäöüß]* (?:rühren|verrühren)|teig zubereiten|biskuit|pfannkuchen|waffel|crêpe|crepe|" +
        "muffin|rührkuchen|flüssiger teig",
    ),
  ],
  steam: [p("dämpfen", "dampfgar|dämpf|gedämpft")],
  stir: [
    p(
      "verrühren/vermengen",
      "verrühr|vermeng|vermisch|mischen|mengen|unterheb|unterrühr|umrühren|durchrühren|rühren|verbinden",
    ),
  ],
  repeat: [
    p(
      "Wiederholung bei Bedarf",
      "nächsten schritt (?:ausführen|wiederholen|durchführen)|vorgang (?:wiederholen|verlängern)|" +
        "schritt wiederholen",
    ),
  ],
  hefe: [p("Hefe", `hefe|${B}germ${E}|germwürfel`)],
  fat: [
    p(
      "Fett",
      `${B}[a-zäöüß]*öl${E}|butter(?!milch)|butterschmalz|schmalz|ghee|kokosfett|margarine`,
    ),
  ],
  flour: [p("Mehl", "(?<!panier)mehl(?!schwitze)")],
  flourAdded: [
    p(
      "Mehl zugegeben",
      "[0-9][^|]{0,30}(?<!panier)mehl(?!schwitze)|(?<!panier)mehl[^|]{0,40}(?:dazu|hinzu|in den mix|zugeben|einwiegen)",
    ),
  ],
  liquidAdded: [
    p(
      "Flüssigkeit",
      `(?<!eis)wasser(?!melone)|brühe|fond${E}|wein(?!stein|säure|beer|traube)|milch|sahne|passierte tomaten|passata|` +
        `tomatenmark|gehackte tomaten|saft${E}`,
    ),
  ],
  chocolateOrButter: [
    p("Schokolade/Butter", "schokolade|kuvertüre|butter(?!milch)|kokosöl|kokosfett"),
  ],
  ruehraufsatz: [p("Rühraufsatz", "r(?:ü|ue|u)hrs?(?:aufsatz|einsatz)|schmetterling")],
  creamOrWhite: [p("Sahne/Eiweiß", "sahne|eiweiß|eiweiss|eiklar|aquafaba|schlagcreme")],
  gareinsatz: [p("Gareinsatz", "(?<!dampf|damf)gar(?:einsatz|korb)|kocheinsatz")],
  aufsatz: [p("Dampfgaraufsatz", "dam?pfgar(?:auf|ein|beh)|dampfaufsatz|einlegeboden")],
  seasoning: [p("abschmecken/würzen", "abschmecken|würzen|nachwürzen")],
  cut: [
    p(
      "Stücke in den Mixbehälter",
      "halbier|viertel|achteln|stücke|grob würfel|in würfel|in scheiben|grob schneiden|" +
        "schälen|dritteln|zerteilen|zerbrechen|brechen|zupfen",
    ),
  ],
  chopTargets: [
    p(
      "festes Gut",
      "zwiebel|schalotte|knoblauch|ingwer|parmesan|käse|emmentaler|gouda|cheddar|pecorino|grana|nüsse|nuss|mandel|schokolade|kuvertüre|" +
        "kräuter|petersilie|basilikum|schnittlauch|möhre|karotte|sellerie|paprika|chili|keks|zwieback|" +
        "brot|brötchen|toast|gurke|apfel(?!essig|saft|mus)|äpfel|zucchini|kohl|beeren|früchte|mango|ananas|" +
        "birne|pfirsich|aprikose|pflaume|kirsche|minze|dill|koriander|thymian|rosmarin|" +
        "salbei|oregano|blättchen|blätter|lachs|thunfisch|forelle|schinken|salami|speck|oliven|kapern|" +
        "tomate",
    ),
  ],
  grindTargets: [
    p(
      "Zucker/Körner",
      `${B}zucker${E}|rohrzucker|getreide|körner|weizen|dinkel|roggen|${B}hafer${E}|leinsamen|mohn|` +
        `kaffeebohnen|gewürze|pfefferkörner|${B}reis${E}`,
    ),
  ],
  soupRecipe: [
    p(
      "Suppe/Sauce/Püree",
      "suppe|cremesuppe|velouté|sauce|soße|püree|brei|creme|dip|mus|pesto|hummus|aufstrich|gazpacho",
    ),
  ],
  pureeRecipe: [
    p(
      "Suppe/Püree/Pesto",
      `suppe|velouté|püree|pesto|hummus|${B}mus${E}|aufstrich|gazpacho|brei|${B}dip${E}`,
    ),
  ],
  pureeProduct: [
    p(
      "Püree/Pesto als Ergebnis",
      `pesto|hummus|püree|mus${E}|${B}brei${E}|glatte masse|cremige masse`,
    ),
  ],
  eggsSugar: [
    p("Eier + Zucker", `(?:${B}eier?${E}|eigelb).*zucker|zucker.*(?:${B}eier?${E}|eigelb)`),
  ],
  byHand: [p("von Hand", "hand|hände|arbeitsfläche|arbeitsplatte|bemehlt")],
  eggWhite: [p("Eiweiß", "eiweiß|eiweiss|eiklar|aquafaba")],
  mincedMeat: [p("Hackmasse", "hackfleisch|rinderhack|hack |brät|mett|hackmasse|frikadell")],
  splashGuard: [p("Spritzschutz", "spritzschutz")],
  fryContext: [p("anbraten", "anbraten|angebraten|anbräunen|scharf an")],
  custard: [p("Eigelb + Milch/Sahne", "eigelb.*(?:milch|sahne)|(?:milch|sahne).*eigelb")],
  crumble: [p("Streusel/Mürbteig", "streusel|mürbteig|plätzchen|kekse|tarte|quiche|boden")],
  batterRecipe: [
    p(
      "Rührteig-Rezept",
      "muffin|waffel|pfannkuchen|biskuit|brownie|rührkuchen|marmorkuchen|gugelhupf|spätzle|crêpe|" +
        "crepe|pancake|cupcake|sandkuchen",
    ),
  ],
  batterIngredients: [
    p("Backpulver + Ei/Milch", "backpulver.*(?:eier?|milch)|(?:eier?|milch).*backpulver"),
  ],
  drinkRecipe: [
    p("Getränk", "smoothie|shake|drink|cocktail|lassi|limonade|punsch|frappé|frappe|milchmix"),
  ],
  dessertBase: [
    p(
      "Milchreis/Pudding/Brei",
      "milchreis|grießbrei|milchgrieß|grieß[^|]*milch|milch[^|]*grieß|pudding|porridge|haferbrei|brei|polenta|vanillecreme|konditorcreme|custard|" +
        "creme brûlée|crème pâtissière|panna cotta|pannacotta|flammeri",
    ),
  ],
  jam: [p("Marmelade", "marmelade|konfitüre|gelee|gelierzucker|fruchtaufstrich|chutney")],
  risotto: [
    p("Risotto/Reis", `risotto|${B}(?:basmati|jasmin|langkorn|natur|sushi|klebe|wild)?reis${E}`),
  ],
  pasta: [
    p(
      "Nudeln",
      "nudel|spaghetti|pasta|penne|fusilli|makkaroni|maccheroni|tagliatelle|farfalle|rigatoni|" +
        "tortellini|ravioli|orzo|linguine|conchiglie|spätzle|gnocchi",
    ),
  ],
  nutsSpices: [
    p(
      "Nüsse/Gewürze/Zucker",
      "nüsse|nuss|mandel|pinienkern|kerne|sesam|kreuzkümmel|kümmel|koriandersaat|senfsaat|" +
        `pfefferkörner|gewürz|${B}zucker${E}|haferflocken|kokosraspel`,
    ),
  ],
  doughRise: [p("Teig gehen lassen", "gehen lassen|aufgehen|volumen verdoppel|gehzeit")],
} satisfies Record<string, readonly Pattern[]>;

// Stage 1, title keywords. Order matters: more specific actions first.
const titleRules: readonly FamilyRule[] = [
  { family: "yeast", evidence: "title", all: [g(T, ...kw.yeast)] },
  { family: "emulsify", evidence: "title", all: [g(T, ...kw.emulsify)] },
  { family: "thicken", evidence: "title", all: [g(T, ...kw.thicken)] },
  { family: "whip", evidence: "title", all: [g(T, ...kw.whip)] },
  { family: "batter", evidence: "title", all: [g(T, ...kw.batter)] },
  { family: "knead", evidence: "title", all: [g(T, ...kw.knead)] },
  { family: "grind", evidence: "title", all: [g(T, ...kw.grind)] },
  { family: "frozen", evidence: "title", all: [g(T, ...kw.frozen)] },
  { family: "puree", evidence: "title", all: [g(T, ...kw.puree)] },
  { family: "chop", evidence: "title", all: [g(T, ...kw.chop)] },
  { family: "mix", evidence: "title", all: [g(T, ...kw.mix)] },
  { family: "melt", evidence: "title", all: [g(T, ...kw.melt)] },
  { family: "roast", evidence: "title", all: [g(T, ...kw.roast)] },
  { family: "saute", evidence: "title", all: [g(T, ...kw.saute)] },
  { family: "fry", evidence: "title", all: [g(T, ...kw.fry)] },
  { family: "boil", evidence: "title", all: [g(T, ...kw.boil)] },
  { family: "steam", evidence: "title", all: [g(T, ...kw.steam)] },
  { family: "simmer", evidence: "title", all: [g(T, ...kw.simmer)] },
  { family: "warm", evidence: "title", all: [g(T, ...kw.warm)] },
  { family: "stir", evidence: "title", all: [g(T, ...kw.stir)] },
];

// Stage 1, context keywords for steps without a telling title. Order matters.
const contextRules: readonly FamilyRule[] = [
  // Explicit action words right after or before the step.
  { family: "emulsify", evidence: "before", all: [g(TAB, ...kw.emulsify)] },
  { family: "yeast", evidence: "before", heat: "hot", all: [g(BE, ...kw.yeast)] },
  { family: "thicken", evidence: "after", heat: "hot", all: [g(AB, ...kw.thicken)] },
  {
    family: "whip",
    evidence: "context",
    heat: "cold",
    all: [g(BE, ...kw.ruehraufsatz), g(ALL, ...kw.creamOrWhite, ...kw.whip)],
  },
  { family: "whip", evidence: "after", heat: "cold", all: [g(AB, ...kw.whip)] },
  { family: "grind", evidence: "after", heat: "cold", all: [g(AB, ...kw.grind)] },
  { family: "frozen", evidence: "before", heat: "cold", all: [g(AB, ...kw.frozen)] },
  { family: "puree", evidence: "after", heat: "cold", all: [g(AB, ...kw.puree)] },
  { family: "puree", evidence: "after", heat: "cold", all: [g(["after"], ...kw.pureeProduct)] },
  { family: "chop", evidence: "after", heat: "cold", all: [g(AB, ...kw.chop)] },
  { family: "melt", evidence: "after", heat: "hot", all: [g(AB, ...kw.melt)] },
  { family: "boil", evidence: "after", heat: "hot", all: [g(["after"], ...kw.boil)] },
  { family: "saute", evidence: "after", heat: "hot", all: [g(AB, ...kw.saute)] },
  { family: "fry", evidence: "after", heat: "hot", all: [g(AB, ...kw.fryContext)] },
  { family: "roast", evidence: "after", heat: "hot", all: [g(AB, ...kw.roast)] },
  {
    family: "knead",
    evidence: "after",
    heat: "cold",
    all: [g(AB, ...kw.knead)],
    none: [g(AB, ...kw.byHand)],
  },
  { family: "batter", evidence: "after", heat: "cold", all: [g(AB, ...kw.batter)] },
  { family: "mix", evidence: "after", heat: "cold", all: [g(AB, ...kw.mix)] },
  // Accessories in the bowl decide steaming before liquid decides simmering.
  {
    family: "steam",
    evidence: "context",
    heat: "hot",
    all: [g(["before"], ...kw.aufsatz, ...kw.gareinsatz)],
    none: [g(["before"], ...kw.splashGuard)],
  },
  { family: "steam", evidence: "after", heat: "hot", all: [g(["after"], ...kw.aufsatz)] },
  // Measuring cup out, basket on the lid as splash guard: open reduction.
  { family: "simmer", evidence: "context", heat: "hot", all: [g(BE, ...kw.splashGuard)] },
  // Eggs or egg white with the whisk, also warm (sponge batter, Swiss meringue).
  {
    family: "whip",
    evidence: "context",
    all: [g(BE, ...kw.ruehraufsatz), g(BE, ...kw.eggsSugar, ...kw.eggWhite)],
    none: [g(BE, ...kw.liquidAdded)],
  },
  // Bowl contents plus heat.
  {
    family: "yeast",
    evidence: "context",
    heat: "hot",
    all: [g(BE, ...kw.hefe)],
    none: [g(BE, ...kw.flour)],
  },
  {
    family: "melt",
    evidence: "context",
    heat: "hot",
    all: [g(BE, ...kw.chocolateOrButter)],
    none: [g(BE, ...kw.liquidAdded, ...kw.flour)],
  },
  {
    family: "saute",
    evidence: "context",
    heat: "hot",
    all: [g(BE, ...kw.fat), g(BOWL, p("Zwiebel/Knoblauch", "zwiebel|schalotte|knoblauch|lauch"))],
    none: [g(BE, ...kw.liquidAdded)],
  },
  {
    family: "fry",
    evidence: "context",
    heat: "hot",
    all: [g(BE, ...kw.fat), g(BOWL, p("Fleisch/Gemüse", ingredientPatterns.meat.source))],
    none: [g(BE, ...kw.liquidAdded)],
  },
  {
    family: "saute",
    evidence: "context",
    heat: "hot",
    all: [g(BE, ...kw.fat), g(BOWL, p("Gemüse", ingredientPatterns.vegetables.source))],
    none: [g(BE, ...kw.liquidAdded)],
  },
  { family: "thicken", evidence: "context", heat: "hot", all: [g(BE, ...kw.thicken)] },
  // Flour into hot fat: roux.
  {
    family: "thicken",
    evidence: "context",
    heat: "hot",
    all: [g(BE, ...kw.flourAdded)],
    none: [g(BE, ...kw.hefe)],
  },
  {
    family: "fry",
    evidence: "context",
    heat: "hot",
    all: [g(BE, p("Fleisch", ingredientPatterns.meat.source))],
    none: [g(BE, ...kw.liquidAdded)],
  },
  {
    family: "saute",
    evidence: "context",
    heat: "hot",
    all: [g(BE, p("Gemüse", ingredientPatterns.vegetables.source))],
    none: [g(BE, ...kw.liquidAdded)],
  },
  { family: "simmer", evidence: "after", heat: "hot", all: [g(AB, ...kw.simmer)] },
  // Fruit with sugar on heat: compote or fruit sauce.
  {
    family: "simmer",
    evidence: "context",
    heat: "hot",
    all: [g(BE, p("Obst", ingredientPatterns.fruit.source))],
  },
  { family: "warm", evidence: "after", heat: "hot", all: [g(AB, ...kw.warm)] },
  {
    family: "simmer",
    evidence: "context",
    heat: "hot",
    all: [g(BOWL, ...kw.liquidAdded)],
  },
  {
    family: "simmer",
    evidence: "context",
    heat: "hot",
    all: [g(["recipe"], ...kw.soupRecipe, ...kw.dessertBase, ...kw.jam, ...kw.risotto)],
  },
  // Cold steps.
  {
    family: "frozen",
    evidence: "context",
    heat: "cold",
    all: [g(BOWL, ...kw.frozen)],
  },
  { family: "mix", evidence: "context", heat: "cold", all: [g(["recipe"], ...kw.drinkRecipe)] },
  {
    family: "knead",
    evidence: "context",
    heat: "cold",
    all: [g(BE, ...kw.flourAdded), g(BOWL, ...kw.hefe)],
  },
  {
    family: "batter",
    evidence: "context",
    heat: "cold",
    all: [
      g(BE, ...kw.flourAdded),
      g(BOWL, p("Ei/Milch/Backpulver", `${B}eier?${E}|milch|backpulver|natron|buttermilch`)),
    ],
  },
  {
    family: "knead",
    evidence: "context",
    heat: "cold",
    all: [g(BE, ...kw.flourAdded)],
    none: [g(BE, ...kw.liquidAdded)],
  },
  {
    family: "stir",
    evidence: "after",
    heat: "cold",
    all: [g(["after"], ...kw.stir, ...kw.seasoning)],
  },
  { family: "stir", evidence: "before", heat: "cold", all: [g(BE, ...kw.seasoning)] },
  { family: "stir", evidence: "context", heat: "cold", all: [g(BE, ...kw.mincedMeat)] },
  {
    family: "puree",
    evidence: "context",
    heat: "cold",
    prevHot: true,
    beforeHousekeeping: true,
    all: [g(["recipe"], ...kw.pureeRecipe)],
  },
  {
    family: "grind",
    evidence: "context",
    heat: "cold",
    all: [g(BE, ...kw.grindTargets)],
    none: [
      g(
        BE,
        ...kw.liquidAdded,
        ...kw.chopTargets,
        ...kw.fat,
        ...kw.eggWhite,
        p("Ei", `${B}eier?${E}|eigelb`),
      ),
    ],
  },
  {
    family: "chop",
    evidence: "context",
    heat: "cold",
    all: [g(BE, ...kw.chopTargets, ...kw.cut)],
    none: [g(BE, ...kw.liquidAdded)],
  },
  {
    family: "puree",
    evidence: "context",
    heat: "cold",
    all: [g(["recipe"], ...kw.pureeRecipe)],
  },
  {
    family: "chop",
    evidence: "context",
    heat: "cold",
    all: [g(BE, ...kw.cut), g(BE, ...kw.chopTargets)],
  },
  {
    family: "stir",
    evidence: "context",
    heat: "cold",
    all: [g(BE, p("Zutaten zugeben", "dazu|hinzu|in den mix"))],
  },
];

// Stage 2: refine a family into a technique. First matching rule wins; the
// last entry of each list has no condition and acts as the default.
const refineRules: Record<Family, readonly RefineRule[]> = {
  weigh: [{ technique: "waage" }],
  chop: [{ technique: "fein_mahlen", all: [g(TAB, ...kw.grind)] }, { technique: "zerkleinern" }],
  grind: [{ technique: "fein_mahlen" }],
  puree: [
    { technique: "eis_gefrorenes", heat: "cold", all: [g(["before", "bowl"], ...kw.frozen)] },
    { technique: "mixen_smoothie", heat: "cold", all: [g(["recipe"], ...kw.drinkRecipe)] },
    { technique: "suppe_puerieren_heiss", heat: "hot" },
    { technique: "suppe_puerieren_heiss", prevHot: true },
    { technique: "puerieren" },
  ],
  mix: [
    { technique: "eis_gefrorenes", all: [g(["title", "before", "bowl"], ...kw.frozen)] },
    { technique: "suppe_puerieren_heiss", heat: "hot" },
    { technique: "mixen_smoothie" },
  ],
  frozen: [{ technique: "eis_gefrorenes" }],
  whip: [{ technique: "schlagen" }],
  emulsify: [{ technique: "emulgieren" }],
  saute: [{ technique: "anbraten", main: ["meat", "fish"] }, { technique: "anschwitzen" }],
  fry: [
    { technique: "anschwitzen", main: ["onion_garlic"] },
    { technique: "roesten", main: ["nuts"] },
    { technique: "roesten", all: [g(["title", "before"], ...kw.roast)] },
    {
      technique: "roesten",
      all: [g(["before"], ...kw.nutsSpices)],
      none: [g(BOWL, ingredientGroup("meat"), ingredientGroup("vegetables"))],
    },
    { technique: "anbraten" },
  ],
  roast: [{ technique: "anschwitzen", main: ["onion_garlic"] }, { technique: "roesten" }],
  boil: [
    { technique: "marmelade_einkochen", all: [g(["recipe", "bowl"], ...kw.jam)] },
    { technique: "aufkochen" },
  ],
  simmer: [
    // Steamer on top while the bowl cooks: the steamer sets the program.
    {
      technique: "daempfen_dampfgaraufsatz",
      all: [g(["title", "before"], ...kw.aufsatz)],
      none: [g(["before"], ...kw.splashGuard)],
    },
    { technique: "marmelade_einkochen", all: [g(["recipe", "bowl"], ...kw.jam)] },
    { technique: "milchreis_pudding_brei", all: [g(["title", "before"], ...kw.dessertBase)] },
    { technique: "milchreis_pudding_brei", all: [g(["before"], ...kw.custard)] },
    { technique: "risotto_reis", all: [g(["recipe"], p("Risotto", "risotto"))] },
    { technique: "risotto_reis", all: [g(["title", "before", "after"], ...kw.risotto)] },
    { technique: "nudeln_garen", all: [g(["title", "before"], ...kw.pasta)] },
    { technique: "eindicken_binden", all: [g(["title", "before", "after"], ...kw.thicken)] },
    { technique: "aufkochen", all: [g(["title", "after"], ...kw.boil)] },
    { technique: "koecheln_garen" },
  ],
  thicken: [{ technique: "eindicken_binden" }],
  melt: [{ technique: "schmelzen" }],
  warm: [
    { technique: "hefe_aktivieren", all: [g(["before"], ...kw.hefe)], none: [g(BE, ...kw.flour)] },
    { technique: "milchreis_pudding_brei", all: [g(["title", "before"], ...kw.dessertBase)] },
    { technique: "milchreis_pudding_brei", all: [g(["before"], ...kw.custard)] },
    {
      technique: "schmelzen",
      all: [g(["title", "before"], ...kw.chocolateOrButter)],
      none: [g(["before"], ...kw.liquidAdded)],
    },
    { technique: "erwaermen_temperieren" },
  ],
  yeast: [{ technique: "hefe_aktivieren" }],
  knead: [
    { technique: "ruehrteig_biskuit", all: [g(["title", "after"], ...kw.batter)] },
    {
      technique: "hefeteig_kneten",
      all: [g(["before", "bowl", "after"], ...kw.hefe, ...kw.doughRise)],
    },
    {
      technique: "muerbteig_kneten",
      all: [g(["title", "before", "after", "recipe"], ...kw.crumble)],
    },
    {
      technique: "ruehrteig_biskuit",
      all: [g(["recipe", "before", "bowl"], ...kw.batterRecipe, ...kw.batterIngredients)],
    },
    // Kneading a mass without flour (minced meat, bulgur) is mixing, not dough.
    {
      technique: "ruehren_kalt",
      main: ["meat", "fish", "vegetables", "onion_garlic"],
      none: [g(["before", "bowl"], ...kw.flour)],
    },
    { technique: "muerbteig_kneten" },
  ],
  batter: [{ technique: "ruehrteig_biskuit" }],
  steam: [
    {
      technique: "daempfen_dampfgaraufsatz",
      all: [g(["title", "before", "after"], ...kw.aufsatz)],
    },
    {
      technique: "daempfen_gareinsatz",
      all: [g(["title", "before", "after"], ...kw.gareinsatz)],
      none: [g(["before"], ...kw.splashGuard)],
    },
    { technique: "daempfen_dampfgaraufsatz", all: [g(["bowl"], ...kw.aufsatz)] },
    { technique: "daempfen_gareinsatz", all: [g(["bowl"], ...kw.gareinsatz)] },
    { technique: "daempfen_unbestimmt" },
  ],
  stir: [
    {
      technique: "hefe_aktivieren",
      heat: "hot",
      all: [g(["before"], ...kw.hefe)],
      none: [g(BE, ...kw.flour)],
    },
    { technique: "marmelade_einkochen", heat: "hot", all: [g(["recipe", "bowl"], ...kw.jam)] },
    { technique: "milchreis_pudding_brei", heat: "hot", all: [g(["before"], ...kw.custard)] },
    {
      technique: "milchreis_pudding_brei",
      heat: "hot",
      all: [g(["title", "before"], ...kw.dessertBase)],
    },
    { technique: "risotto_reis", heat: "hot", all: [g(["recipe"], p("Risotto", "risotto"))] },
    { technique: "eindicken_binden", heat: "hot", all: [g(["title", "before"], ...kw.thicken)] },
    { technique: "koecheln_garen", heat: "hot", all: [g(["before"], ...kw.liquidAdded)] },
    { technique: "erwaermen_temperieren", heat: "hot" },
    { technique: "ruehren_kalt" },
  ],
  sousvide: [{ technique: "sous_vide" }],
  slowcook: [{ technique: "slow_cooking" }],
  ferment: [{ technique: "fermentieren" }],
  eggs: [{ technique: "eier_kochen" }],
  foodprocessor: [{ technique: "food_processor" }],
  clean: [{ technique: "vorreinigen" }],
};

function ingredientGroup(cls: Exclude<IngredientClass, "unknown">): Pattern {
  return { label: cls, re: ingredientPatterns[cls] };
}

// Housekeeping text that adds nothing to the bowl.
const housekeeping = re(
  "spatel|messbecher|deckel|nächsten schritt|sichtkontakt|bei bedarf|überspringen|abschmecken|" +
    "beiseite|prüfen|kontrollieren|vorgang|während",
);

// ---------------------------------------------------------------------------
// Matching

export interface Classification {
  technique: Technique;
  family: Family | null;
  evidence: Evidence | null;
  keywords: string[];
  mainIngredient: IngredientClass;
}

function fieldText(ctx: StepContext, field: Field): string {
  switch (field) {
    case "title":
      return ctx.title;
    case "before":
      return ctx.before;
    case "after":
      return ctx.after;
    case "bowl":
      return ctx.bowl;
    case "recipe":
      return ctx.recipeTitle;
  }
}

function matchGroup(ctx: StepContext, group: Group): string | null {
  for (const field of group.fields) {
    const text = fieldText(ctx, field);
    if (!text) continue;
    for (const pattern of group.patterns) {
      if (pattern.re.test(text)) return `${pattern.label}@${field}`;
    }
  }
  return null;
}

interface Gates {
  heat?: "hot" | "cold";
  prevHot?: boolean;
  beforeHousekeeping?: boolean;
  all?: readonly Group[];
  none?: readonly Group[];
}

function matchGates(ctx: StepContext, rule: Gates): string[] | null {
  if (rule.heat === "hot" && !ctx.hot) return null;
  if (rule.heat === "cold" && ctx.hot) return null;
  if (rule.prevHot !== undefined && (ctx.prev?.hot ?? false) !== rule.prevHot) return null;
  if (rule.beforeHousekeeping && !onlyHousekeeping(ctx.before)) return null;
  const hits: string[] = [];
  for (const group of rule.all ?? []) {
    const hit = matchGroup(ctx, group);
    if (!hit) return null;
    hits.push(hit);
  }
  for (const group of rule.none ?? []) {
    if (matchGroup(ctx, group)) return null;
  }
  return hits;
}

export function mainIngredient(
  ctx: Pick<StepContext, "title" | "before" | "bowl">,
): IngredientClass {
  let best: IngredientClass = "unknown";
  let bestScore = 0;
  for (const cls of ingredientClasses) {
    if (cls === "unknown") continue;
    const pattern = ingredientPatterns[cls];
    let score = 0;
    for (const field of ["title", "before", "bowl"] as const) {
      const text = ctx[field];
      if (!text) continue;
      const matches = text.match(new RegExp(pattern.source, "gu"));
      if (matches) score += matches.length * ingredientFieldWeight[field];
    }
    if (cls === "liquid") score *= 0.5;
    // Strictly greater: earlier classes in the list win ties.
    if (score > bestScore) {
      best = cls;
      bestScore = score;
    }
  }
  return best;
}

function detectFamily(
  ctx: StepContext,
): { family: Family; evidence: Evidence; keywords: string[] } | null {
  const mode = ctx.step.mode;
  const fixed = modeFamily[mode];
  if (fixed) return { family: fixed, evidence: "mode", keywords: [`mode:${mode}`] };

  for (const rule of titleRules) {
    const hits = matchGates(ctx, rule);
    if (hits) {
      // A title verb that contradicts a program mode (e.g. "kochen" on a kneading
      // program) loses against the mode.
      const modeDefault = modeDefaultFamily[mode];
      if (modeDefault && !compatible(modeDefault, rule.family)) continue;
      return { family: rule.family, evidence: "title", keywords: hits };
    }
  }

  const modeDefault = modeDefaultFamily[mode];
  if (modeDefault) return { family: modeDefault, evidence: "mode", keywords: [`mode:${mode}`] };

  // "Run the next step if needed": the step repeats the previous action.
  const repeatHits = matchGroup(ctx, g(BE, ...kw.repeat));
  if (repeatHits && ctx.prev?.family && ctx.prev.hot === ctx.hot) {
    return { family: ctx.prev.family, evidence: "repeat", keywords: [repeatHits] };
  }
  // Only housekeeping since the previous step, same heat: a continuation.
  if (ctx.prev?.family && ctx.prev.hot === ctx.hot && onlyHousekeeping(ctx.before)) {
    return { family: ctx.prev.family, evidence: "repeat", keywords: ["continues previous step"] };
  }

  for (const rule of contextRules) {
    const hits = matchGates(ctx, rule);
    if (hits) return { family: rule.family, evidence: rule.evidence, keywords: hits };
  }
  return null;
}

const compatibleFamilies: Partial<Record<Family, readonly Family[]>> = {
  chop: ["chop", "grind", "puree", "mix", "frozen"],
  knead: ["knead", "batter", "stir"],
  batter: ["batter", "knead", "stir"],
  puree: ["puree", "mix", "frozen", "chop", "grind"],
  mix: ["mix", "puree", "frozen", "chop"],
  fry: ["fry", "saute", "roast", "simmer", "boil", "warm", "melt", "thicken", "stir"],
};

function compatible(modeDefault: Family, titleFamily: Family): boolean {
  const allowed = compatibleFamilies[modeDefault];
  return !allowed || allowed.includes(titleFamily);
}

function onlyHousekeeping(before: string): boolean {
  if (!before) return true;
  return before
    .split(" | ")
    .every((part) => housekeeping.test(part) && !/dazu|hinzu|zugeben/u.test(part));
}

export function classify(ctx: StepContext): Classification {
  const main = mainIngredient(ctx);
  const found = detectFamily(ctx);
  if (!found) {
    return {
      technique: "unclassified",
      family: null,
      evidence: null,
      keywords: [],
      mainIngredient: main,
    };
  }
  for (const rule of refineRules[found.family]) {
    if (rule.main && !rule.main.includes(main)) continue;
    const hits = matchGates(ctx, rule);
    if (hits) {
      return {
        technique: rule.technique,
        family: found.family,
        evidence: found.evidence,
        keywords: [...found.keywords, ...hits],
        mainIngredient: main,
      };
    }
  }
  // Unreachable while every refine list ends with an unconditional rule.
  return {
    technique: "unclassified",
    family: found.family,
    evidence: found.evidence,
    keywords: found.keywords,
    mainIngredient: main,
  };
}

// ---------------------------------------------------------------------------
// Context building over one recipe

export interface RecipeInput {
  title: string;
  /** Steps of one recipe in any order. */
  steps: readonly NormalizedStep[];
}

export interface ClassifiedStep {
  step: NormalizedStep;
  context: StepContext;
  result: Classification;
}

const MAX_BEFORE = 8;
const MAX_AFTER = 2;
const MAX_BOWL = 25;

const lower = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function classifyRecipe(recipe: RecipeInput): ClassifiedStep[] {
  const steps = [...recipe.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const recipeTitle = lower(recipe.title);
  const out: ClassifiedStep[] = [];
  let prev: StepContext["prev"] = null;
  let bowlStart = 0;

  steps.forEach((step, i) => {
    const text = lower(step.text);
    if (step.kind === "text" && bowlReset.test(text)) {
      bowlStart = i + 1;
      prev = null;
    }
    if (step.kind !== "machine") return;

    const before: string[] = [];
    for (let j = i - 1; j >= 0 && before.length < MAX_BEFORE; j--) {
      const s = steps[j];
      if (!s || (s.kind === "machine" && s.mode !== "scale")) break;
      const t = lower(s.text);
      // Text from before the bowl was emptied describes another mixture.
      if (s.kind === "text" && bowlReset.test(t)) break;
      before.unshift(t);
    }
    const after: string[] = [];
    for (let j = i + 1; j < steps.length && after.length < MAX_AFTER; j++) {
      const s = steps[j];
      if (!s || s.kind === "machine") break;
      const t = lower(s.text);
      after.push(t);
      if (bowlReset.test(t)) break;
    }
    const bowl = steps
      .slice(Math.max(bowlStart, i - MAX_BOWL), i)
      .map((s) => lower(s.text))
      .join(" | ");

    const context: StepContext = {
      step,
      title: step.mode === "scale" ? text : cleanTitle(step.text),
      before: before.join(" | "),
      after: after.join(" | "),
      bowl,
      recipeTitle,
      hot: isHot(step),
      prev,
    };
    const result = classify(context);
    out.push({ step, context, result });
    if (step.mode !== "scale") {
      prev = { technique: result.technique, family: result.family, hot: context.hot };
    }
  });
  return out;
}
