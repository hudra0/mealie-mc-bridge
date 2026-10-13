// Builds knowledge/device-programs.json: the automatic programs of the Monsieur Cuisine smart
// (MC3.0) and its recipe limits. Each value is recorded in layers: editor, server, assumed,
// corpus and effective (see the layers block in the output).
//
// Sources, all transcribed by hand:
//   editor   a logged-in capture of the recipe editor on monsieur-cuisine.com. The program table
//            is static data in the page JavaScript; no API call delivers modes or limits.
//   server   live probes of the recipe API with a member account, one changed value per update.
//   assumed  SmartRecipe's limits from its mode converter and constants.
//   corpus   numbers from the corpus analysis (scripts/corpus/analyze-*.ts).
//
// This generator reads no input files, so it runs without the private captures. Updating the
// editor or server layers needs your own logged-in capture; the maintainer's capture notes live
// in local/, which is gitignored.
//
// `npm run corpus:build-knowledge` runs it: scripts/corpus/build-knowledge.ts imports this module
// and writes the file. The module itself has no side effects.

// ---------------------------------------------------------------------------
// Types

export type DeviceCode = "MC0.5" | "MC1.1" | "MC2.0" | "MC3.0" | "MC4.0";

/** A parameter value: a number, an enum string (egg size, rinse duration) or a flag (clockwise). */
export type ParamValue = number | string | boolean;

export type ConditionOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** When the `when` parameters match, the fields in `set` override the layer (for example max). */
export interface Condition {
  when: Record<string, Partial<Record<ConditionOp, ParamValue>>>;
  set: Record<string, number | boolean>;
  /** device = editor or device rule, accessory = depends on an attachment, sanity = bridge only. */
  kind: "device" | "accessory" | "sanity";
}

/** One layer of a numeric or enumerated parameter. min and max are derived from numeric lists. */
export interface ParamLayer {
  unit: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  default: ParamValue | null;
  values: readonly ParamValue[] | null;
  conditions: Condition[];
  note?: string;
}

/** What the recipe API did with probe values for one parameter. */
export interface ServerProbe {
  rangeEnforced: boolean;
  clamped: boolean;
  accepted: readonly ParamValue[];
  rejected: readonly ParamValue[];
  note?: string;
}

/** Observed values in public recipes of one origin (official or member). */
export interface CorpusStats {
  min?: number;
  max?: number;
  median?: number;
  p10?: number;
  p90?: number;
  /** A list of observed values, or a count per value. */
  values?: readonly number[] | Readonly<Record<string, number>>;
  offGrid?: number;
  missing?: number;
  heatedMax?: number;
  exceptions?: string;
  reverseShare?: number;
  temperature?: number;
  note?: string;
}

export interface CorpusObservation {
  official: CorpusStats | null;
  member: CorpusStats | null;
  note?: string;
}

export interface ProgramParam {
  unit: string | null;
  editor: ParamLayer;
  /** null means not probed. */
  server: ServerProbe | null;
  /** null means SmartRecipe does not support it. */
  assumed: ParamLayer | null;
  corpus: CorpusObservation | null;
  effective: ParamLayer;
  notes: string[];
}

export interface Label {
  de: string;
  en: string;
}

export interface ProgramMode {
  /** The snake_case mode.type sent to the recipe API. */
  id: string;
  /** The camelCase id the web editor uses internally. */
  editorId: string;
  label: Label;
  devices: DeviceCode[];
  editorOrder: number;
  memberVisible: boolean;
  payload: {
    deviceSettingsKeys: string[] | null;
    modeSettingKeys: string[] | null;
    deviceControlled: string[];
    note?: string;
  };
  stepDescription: "cleared" | "required";
  server: { typeAccepted: boolean | null; note?: string };
  assumed: { supported: boolean; smartRecipeType?: string; note?: string };
  corpus: { officialSteps: number; memberSteps: number };
  effective: { allowed: boolean; reason?: string; requires?: string[] };
  params: Record<string, ProgramParam>;
  notes: string[];
  evidence: string[];
}

/** A program that exists only on another device (MC4.0). */
export interface OtherDeviceMode {
  id: string;
  editorId: string;
  label: Label;
  devices: DeviceCode[];
  editor: string;
  server: null;
  effective: { allowed: false; reason: string };
}

export type RecipeLimits = ReturnType<typeof buildRecipeLimits>;

export interface DeviceProgramsDoc {
  $comment: string;
  schemaVersion: number;
  generatedAt: string;
  device: { code: DeviceCode; deviceTypeId: number; slug: string; name: string };
  sources: {
    editor: string;
    server: string;
    assumed: string;
    corpus: string;
    officialGuide: string;
  };
  layers: { editor: string; server: string; assumed: string; corpus: string; effective: string };
  conditionFormat: string;
  labels: string;
  payloadRules: string[];
  deviceTables: { precedence: DeviceCode[]; note: string; tables: Record<DeviceCode, string> };
  recipeLimits: RecipeLimits;
  modes: ProgramMode[];
  otherDeviceModes: OtherDeviceMode[];
  openQuestions: string[];
}

// ---------------------------------------------------------------------------
// Shared grids, conditions and layer helpers

/** Fixed date so the output only changes when the data changes. */
const GENERATED_AT = "2026-10-13";

function range(from: number, to: number, step: number): number[] {
  const values: number[] = [];
  for (let v = from; v <= to; v += step) values.push(v);
  return values;
}

/** Temperature lists in °C. No value exists between 0 and 37 or between 37 and 40. */
const HEATING_TEMPS: readonly number[] = [0, 37, ...range(40, 130, 5)];
const SLOW_COOKING_TEMPS: readonly number[] = [37, ...range(40, 95, 5)];
const FERMENTATION_TEMPS: readonly number[] = [37, ...range(40, 65, 5)];
const ROASTING_TEMPS: readonly number[] = range(100, 130, 5);

const SPEED_HEAT: Condition = {
  when: { temperature: { ne: 0 } },
  set: { max: 3 },
  kind: "device",
};
const SPEED_REVERSE: Condition = {
  when: { clockwise: { eq: false } },
  set: { max: 3 },
  kind: "device",
};
const SPEED_WHISK: Condition = {
  when: { accessory: { eq: "butterfly_whisk" } },
  set: { max: 4 },
  kind: "accessory",
};
const TIME_HIGH_SPEED: Condition = {
  when: { speed: { gte: 6 } },
  set: { max: 600 },
  kind: "sanity",
};
const READY_BEFORE_PREPARATION: Condition = {
  when: { readyInTime: { lt: "preparationTime" } },
  set: { invalid: true },
  kind: "sanity",
};

interface LayerInput {
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  default?: ParamValue;
  values?: readonly ParamValue[];
  conditions?: Condition[];
  note?: string;
}

function isNumberList(values: readonly ParamValue[] | undefined): values is readonly number[] {
  return values !== undefined && values.every((v) => typeof v === "number");
}

/** One parameter layer. Unset fields become null; min and max fall back to a numeric list. */
function layer(o: LayerInput): ParamLayer {
  const numbers = isNumberList(o.values) ? o.values : null;
  return {
    unit: o.unit ?? null,
    min: o.min ?? (numbers ? Math.min(...numbers) : null),
    max: o.max ?? (numbers ? Math.max(...numbers) : null),
    step: o.step ?? null,
    default: o.default ?? null,
    values: o.values ?? null,
    conditions: o.conditions ?? [],
    ...(o.note ? { note: o.note } : {}),
  };
}

/** Server probe result for one parameter. rangeEnforced is false everywhere a range was probed. */
function probe(
  accepted: readonly ParamValue[],
  rejected: readonly ParamValue[] = [],
  note?: string,
): ServerProbe {
  return { rangeEnforced: false, clamped: false, accepted, rejected, ...(note ? { note } : {}) };
}

function observed(
  official: CorpusStats | null,
  member: CorpusStats | null,
  note?: string,
): CorpusObservation {
  return { official, member, ...(note ? { note } : {}) };
}

interface TimeParamInput {
  editor: LayerInput;
  server: ServerProbe | null;
  assumed: LayerInput | null;
  corpus: CorpusObservation | null;
  effective: LayerInput;
  notes?: string[];
}

/** A time parameter in seconds; every layer defaults to whole seconds. */
function timeParam({
  editor,
  server,
  assumed,
  corpus,
  effective,
  notes = [],
}: TimeParamInput): ProgramParam {
  return {
    unit: "s",
    editor: layer({ unit: "s", step: 1, ...editor }),
    server,
    assumed: assumed === null ? null : layer({ unit: "s", step: 1, ...assumed }),
    corpus,
    effective: layer({ unit: "s", step: 1, ...effective }),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Document

export function buildDevicePrograms(): DeviceProgramsDoc {
  const recipeLimits = buildRecipeLimits();
  const modes = buildModes();
  const otherDeviceModes = buildOtherDeviceModes();
  return {
    $comment:
      "Monsieur Cuisine smart (MC3.0) automatic programs and recipe limits, in four layers. Maintained by hand; see the sources block.",
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    device: { code: "MC3.0", deviceTypeId: 13, slug: "mc-smart", name: "Monsieur Cuisine smart" },
    sources: {
      editor:
        "Recipe editor on www.monsieur-cuisine.com, web app version 1.138.0. The program catalog is a static table per device in the page's JavaScript; no API call delivers modes or limits.",
      server:
        "Live probes on 2026-10-13 from a member account: 80 updates of a private draft, each changing one value. The server checks enumerations only; every out-of-range number was stored unchanged.",
      assumed:
        "SmartRecipe (MIT) limits in its mode converter and constants, as analysed on 2026-10-12.",
      corpus:
        "Numbers derived from 2,221 public MC3.0 recipes (1,094 official, 1,127 member). Official recipes are the reference.",
      officialGuide:
        "The official recipe-creation guide for members (speed 1-10, butterfly whisk at most speed 4, step description shown on the device for only two programs, drawn as icons that match scale and turbo).",
    },
    layers: {
      editor: "What the website editor lets a member enter for MC3.0.",
      server:
        "What the recipe API did with probe values. null means not probed. rangeEnforced false means out-of-range numbers were stored unchanged.",
      assumed: "What SmartRecipe assumes. null means SmartRecipe does not support it.",
      corpus: "Observed values in public recipes, split into official and member.",
      effective:
        "What the bridge validator enforces: the editor limit, tightened where SmartRecipe, the official guide or official recipes give a stricter rule that no official recipe breaks. Editor minimums of 0 s are replaced by the smallest value in official recipes.",
    },
    conditionFormat:
      "Each condition is { when: { <param>: { <op>: value } }, set: { <field>: value }, kind }. Ops: eq, ne, gt, gte, lt, lte. kind device = editor or device rule, accessory = depends on an attachment, sanity = enforced by the bridge only.",
    labels:
      "label.de is the website's German label (our translation for MC4.0-only modes, which the site shows in English). label.en is our translation.",
    payloadRules: [
      "mode.type is the snake_case id; the editor uses camelCase internally.",
      "deviceSettings is an array with one object per phase (one for every mode except ramp), keys as listed in payload.deviceSettingsKeys. Keys of device-controlled values are not sent.",
      "cooking_eggs and precleaning send modeSetting instead of deviceSettings.",
      "Unknown mode types are rejected with HTTP 400 code 40004.",
    ],
    deviceTables: {
      precedence: ["MC1.1", "MC2.0", "MC3.0", "MC0.5", "MC4.0"],
      note: "The editor uses the first device in this order that the recipe lists.",
      tables: {
        "MC3.0": "19 programs, 2 of them editors only (kneading, ramp)",
        "MC2.0":
          "kneading, steaming, roasting with free temperature 0-130 °C, scale, customized, turbo, ramp (editors only)",
        "MC1.1": "like MC2.0 without ramp; kneading default 90 s",
        "MC0.5":
          "kneading 45-90 s, roasting 100-130 °C, scale 1-3000 g, customized up to 5400 s with speed max 6 above 600 s, turbo without parameter",
        "MC4.0":
          "half speeds, defaults for every program, attachments as modules, nine extra programs (see otherDeviceModes)",
      },
    },
    recipeLimits,
    modes,
    otherDeviceModes,
    openQuestions: [
      "What does the MC3.0 do with values outside the editor limits?",
      "Does the device play kneading and ramp from a member recipe?",
      "Does duration on a text step become a timer on the device?",
      "Which program values can be changed on the device before starting, and which defaults does it show?",
      "Does the server reject an official category from a member account?",
    ],
  };
}

// MC3.0 programs in the order of the editor table.
function buildModes(): ProgramMode[] {
  return [
    {
      id: "kneading",
      editorId: "kneading",
      label: { de: "Einfaches Kneten", en: "Simple kneading" },
      devices: ["MC0.5", "MC1.1", "MC2.0", "MC3.0"],
      editorOrder: 0,
      memberVisible: false,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: {
        typeAccepted: true,
        note: "accepted from a member account (60 s), although the MC3.0 editor shows it only to editors",
      },
      assumed: { supported: false, note: "SmartRecipe has no simple kneading mode" },
      corpus: { officialSteps: 188, memberSteps: 0 },
      effective: {
        allowed: false,
        reason:
          "Hidden from members in the MC3.0 editor and untested on the device for member recipes. Use kneading_solid_dough, kneading_soft_dough or kneading_liquid_dough.",
      },
      params: {
        time: timeParam({
          editor: {
            min: 45,
            max: 120,
            note: "entered as minutes + seconds; starts at 0, which is invalid",
          },
          server: probe([60]),
          assumed: null,
          corpus: observed({ min: 45, max: 120, values: [45, 60, 90, 120] }, null),
          effective: {
            min: 45,
            max: 120,
            note: "applies only if the mode is enabled after a device test",
          },
        }),
      },
      notes: [
        "Official recipes use it often; members cannot pick it on MC3.0.",
        "MC2.0 and MC1.1 offer it to everyone (45-120 s, MC1.1 default 90 s); MC0.5 allows 45-90 s.",
      ],
      evidence: [
        "editor: MC3.0 table entry kneading, adminOnly, time 45-120 s",
        "server: kneading with 60 s stored from a member account",
        "corpus: 188 official steps, 45-120 s",
      ],
    },
    {
      id: "kneading_solid_dough",
      editorId: "kneadingSolidDough",
      label: { de: "Fester Teig", en: "Firm dough" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 1,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "solidDoughKnead" },
      corpus: { officialSteps: 0, memberSteps: 171 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: {
            min: 45,
            max: 240,
            note: "entered as minutes + seconds; starts at 0, which is invalid",
          },
          server: probe([44, 45, 240, 241]),
          assumed: { min: 45, max: 240 },
          corpus: observed(null, { min: 45, max: 240, median: 120 }),
          effective: { min: 45, max: 240 },
        }),
      },
      notes: [
        "The editor tip names bread and pasta dough and recommends at least 2 minutes.",
        "MC4.0: 1-360 s, default 120 s.",
      ],
      evidence: [
        "editor: MC3.0 table entry kneadingSolidDough, time 45-240 s",
        "server: 44 s and 241 s stored unchanged",
        "corpus: 171 member steps, 45-240 s",
      ],
    },
    {
      id: "kneading_soft_dough",
      editorId: "kneadingSoftDough",
      label: { de: "Weicher Teig", en: "Soft dough" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 2,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "softDoughKnead" },
      corpus: { officialSteps: 0, memberSteps: 162 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: {
            min: 45,
            max: 240,
            note: "entered as minutes + seconds; starts at 0, which is invalid",
          },
          server: null,
          assumed: { min: 45, max: 240 },
          corpus: observed(null, { min: 45, max: 240, median: 120 }),
          effective: { min: 45, max: 240 },
        }),
      },
      notes: [
        "The editor tip names yeast dough, brioche and soft rolls and recommends at least 2 minutes.",
        "MC4.0: 1-240 s, default 120 s.",
      ],
      evidence: [
        "editor: MC3.0 table entry kneadingSoftDough, time 45-240 s",
        "corpus: 162 member steps, 45-240 s",
      ],
    },
    {
      id: "kneading_liquid_dough",
      editorId: "kneadingLiquidDough",
      label: { de: "Flüssiger Teig", en: "Batter" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 3,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "liquidDoughKnead" },
      corpus: { officialSteps: 0, memberSteps: 16 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: {
            min: 45,
            max: 360,
            note: "entered as minutes + seconds; starts at 0, which is invalid",
          },
          server: probe([360, 361]),
          assumed: { min: 45, max: 360 },
          corpus: observed(null, { min: 45, max: 180 }),
          effective: { min: 45, max: 360 },
        }),
      },
      notes: ["The editor tip names pancake and crêpe batter.", "MC4.0: 1-600 s, default 120 s."],
      evidence: [
        "editor: MC3.0 table entry kneadingLiquidDough, time 45-360 s",
        "server: 361 s stored unchanged",
        "corpus: 16 member steps, 45-180 s",
      ],
    },
    {
      id: "steaming",
      editorId: "steaming",
      label: { de: "Dampfgaren", en: "Steaming" },
      devices: ["MC0.5", "MC1.1", "MC2.0", "MC3.0", "MC4.0"],
      editorOrder: 4,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "steam" },
      corpus: { officialSteps: 240, memberSteps: 69 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: { min: 0, max: 3600, note: "0 s is valid in the editor" },
          server: probe([0, 3600, 3601]),
          assumed: { min: 0, max: 3600 },
          corpus: observed(
            { min: 180, max: 3600, p10: 480, median: 900, p90: 2400 },
            { min: 120, max: 3000 },
          ),
          effective: {
            min: 180,
            max: 3600,
            note: "editor minimum 0 replaced by the smallest official value",
          },
        }),
      },
      notes: [
        "Physical preconditions (water in the bowl, steamer attachment) are outside this file.",
        "MC4.0: 1-3600 s, default 1200 s.",
      ],
      evidence: [
        "editor: MC3.0 table entry steaming, time 0-3600 s",
        "server: 0 s and 3601 s stored unchanged",
        "corpus: official 180-3600 s",
      ],
    },
    {
      id: "roasting",
      editorId: "roasting",
      label: { de: "Anbraten", en: "Roasting" },
      devices: ["MC0.5", "MC1.1", "MC2.0", "MC3.0"],
      editorOrder: 5,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "temperature", "time"],
        modeSettingKeys: null,
        deviceControlled: ["speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "roast" },
      corpus: { officialSteps: 399, memberSteps: 307 },
      effective: { allowed: true },
      params: {
        temperature: {
          unit: "°C",
          editor: layer({
            unit: "°C",
            values: HEATING_TEMPS,
            default: 0,
            note: "slider over the list; starts at the first value (0)",
          }),
          server: probe([60, 130, 135]),
          assumed: layer({ unit: "°C", values: HEATING_TEMPS }),
          corpus: observed(
            { values: { 0: 1, 100: 40, 110: 52, 115: 2, 120: 77, 130: 227 } },
            { min: 0, max: 130, note: "13 steps at 80-95 °C, 3 at 0 °C" },
          ),
          effective: layer({
            unit: "°C",
            values: ROASTING_TEMPS,
            note: "official recipes roast at 100-130 °C (398 of 399 steps); MC0.5 and the MC4.0 roast modes also start at 100 °C",
          }),
          notes: [],
        },
        time: timeParam({
          editor: { min: 0, max: 840, note: "0 s is valid in the editor" },
          server: probe([0, 840, 841]),
          assumed: { min: 0, max: 840 },
          corpus: observed({ min: 60, max: 840, median: 240 }, { min: 2, max: 840, median: 180 }),
          effective: {
            min: 60,
            max: 840,
            note: "editor minimum 0 replaced by the smallest official value",
          },
        }),
      },
      notes: ["MC2.0 and MC1.1 take any whole degree 0-130 °C; MC0.5 only 100-130 °C."],
      evidence: [
        "editor: MC3.0 table entry roasting, temperature list 0/37-130, time 0-840 s",
        "server: 135 °C and 841 s stored unchanged",
        "corpus: official 100-130 °C (one step at 0 °C), 60-840 s",
      ],
    },
    {
      id: "scale",
      editorId: "scale",
      label: { de: "Waage", en: "Scale" },
      devices: ["MC0.5", "MC1.1", "MC2.0", "MC3.0", "MC4.0"],
      editorOrder: 6,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "weight"],
        modeSettingKeys: null,
        deviceControlled: [],
      },
      stepDescription: "required",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "scale" },
      corpus: { officialSteps: 7026, memberSteps: 4919 },
      effective: { allowed: true },
      params: {
        weight: {
          unit: "g",
          editor: layer({
            unit: "g",
            min: 5,
            max: 5000,
            default: 5,
            note: "parsed as float, so decimals pass; clamped to 5 when the field is created",
          }),
          server: probe([4, 5, 5000, 5001]),
          assumed: layer({ unit: "g", min: 5, max: 5000, step: 1 }),
          corpus: observed(
            { min: 5, max: 2500, median: 150 },
            { min: 5, max: 2000, median: 150 },
            "no decimal weights",
          ),
          effective: layer({ unit: "g", min: 5, max: 5000, step: 1 }),
          notes: [],
        },
      },
      notes: [
        "The step description is required and shown on the device.",
        "MC0.5: 1-3000 g. MC4.0 links scale steps to recipe ingredients instead of one weight.",
      ],
      evidence: [
        "editor: MC3.0 table entry scale, weight 5-5000 g, showDescription and requireDescription",
        "server: 4 g and 5001 g stored unchanged",
        "corpus: 11,945 steps, 5-2500 g, all with a description",
      ],
    },
    {
      id: "customized",
      editorId: "customized",
      label: { de: "Manuelles Kochen", en: "Manual cooking" },
      devices: ["MC0.5", "MC1.1", "MC2.0", "MC3.0", "MC4.0"],
      editorOrder: 7,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "temperature", "speed", "time", "clockwise"],
        modeSettingKeys: null,
        deviceControlled: [],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "manualCooking" },
      corpus: { officialSteps: 4119, memberSteps: 2731 },
      effective: { allowed: true },
      params: {
        temperature: {
          unit: "°C",
          editor: layer({
            unit: "°C",
            values: HEATING_TEMPS,
            default: 0,
            note: "slider over the list; 0 means no heating",
          }),
          server: probe([36, 37, 38, 130, 135]),
          assumed: layer({ unit: "°C", values: HEATING_TEMPS }),
          corpus: observed({ min: 0, max: 130, offGrid: 0 }, { min: 0, max: 130, offGrid: 0 }),
          effective: layer({ unit: "°C", values: HEATING_TEMPS }),
          notes: [],
        },
        time: timeParam({
          editor: {
            min: 1,
            max: 5940,
            note: "entered as minutes (0-99) + seconds (0-59); starts at 0, which is invalid",
          },
          server: probe([0, 1, 5940, 5941, 6000]),
          assumed: { min: 1, max: 5940 },
          corpus: observed(
            { min: 2, max: 5940, missing: 2 },
            { min: 2, max: 5940 },
            "at speed 6 or higher the longest step is 600 s (1,874 steps)",
          ),
          effective: { min: 1, max: 5940, conditions: [TIME_HIGH_SPEED] },
          notes: [
            "The 600 s cap at speed 6+ comes from the MC4.0 and MC0.5 tables, not from MC3.0. The corpus never breaks it, so the bridge enforces it as a sanity rule.",
          ],
        }),
        speed: {
          unit: "level",
          editor: layer({
            unit: "level",
            min: 1,
            max: 10,
            step: 1,
            conditions: [SPEED_HEAT, SPEED_REVERSE],
            note: "slider 0-10, starts at 0, which is invalid; the cap of 3 is a slider bound that clamps a higher value when heat or reverse is switched on",
          }),
          server: probe([0, 4, 10, 11], [], "speed 4 was stored both at 100 °C and in reverse"),
          assumed: layer({
            unit: "level",
            min: 0,
            max: 10,
            step: 1,
            conditions: [SPEED_HEAT, SPEED_REVERSE],
          }),
          corpus: observed(
            {
              min: 1,
              max: 10,
              heatedMax: 3,
              exceptions: "1 step at speed 4 and 50 °C; 1 step above 3 in reverse",
            },
            {
              min: 1,
              max: 10,
              heatedMax: 3,
              exceptions: "4 steps at speed 4-8 in reverse at 0 °C",
            },
            "no speed 0, no half speeds",
          ),
          effective: layer({
            unit: "level",
            min: 1,
            max: 10,
            step: 1,
            conditions: [SPEED_HEAT, SPEED_REVERSE, SPEED_WHISK],
          }),
          notes: ["Speed 0 is not a waiting step. A pause is a text step."],
        },
        clockwise: {
          unit: null,
          editor: layer({
            values: [true, false],
            default: true,
            note: "stored as clockwise = not reverse; Linkslauf (reverse) is false",
          }),
          server: { rangeEnforced: false, clamped: false, accepted: [true, false], rejected: [] },
          assumed: layer({ values: [true, false], note: "rotationDirection right maps to true" }),
          corpus: observed({ reverseShare: 0.162 }, { reverseShare: 0.257 }),
          effective: layer({ values: [true, false], default: true, note: "always sent" }),
          notes: ["Reverse stirs without cutting."],
        },
      },
      notes: [
        "MC3.0 has no time limit tied to speed in the editor.",
        "MC0.5: up to 5400 s, speed max 6 above 600 s. MC4.0: half speeds, max 4 with heat or reverse, up to 5999 s and 600 s from speed 6.",
      ],
      evidence: [
        "editor: MC3.0 table entry customized, temperature list, time 1-5940 s, speed 1-10 with temperatureDependentUpperBoundaries [10, 3]",
        "editor: speed bound set to 3 when temperature is not 0 or reverse is on",
        "official guide: butterfly whisk at most speed 4",
        "server: speed 0, 11, and 4 at 100 °C stored unchanged",
        "corpus: 6,850 steps, all temperatures on the grid, no speed 0",
      ],
    },
    {
      id: "sous_vide",
      editorId: "sousVide",
      label: { de: "Sous-vide", en: "Sous vide" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 8,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "temperature", "time"],
        modeSettingKeys: null,
        deviceControlled: ["speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "sousVide" },
      corpus: { officialSteps: 6, memberSteps: 1 },
      effective: { allowed: true },
      params: {
        temperature: {
          unit: "°C",
          editor: layer({
            unit: "°C",
            min: 40,
            max: 85,
            step: 1,
            default: 40,
            note: "free number field, whole degrees; clamped to 40 when created",
          }),
          server: probe([39, 40, 85, 86]),
          assumed: layer({ unit: "°C", min: 40, max: 85, step: 1 }),
          corpus: observed({ min: 50, max: 85 }, { min: 55, max: 55 }),
          effective: layer({ unit: "°C", min: 40, max: 85, step: 1 }),
          notes: [],
        },
        time: timeParam({
          editor: {
            min: 900,
            max: 43200,
            step: 60,
            note: "15-720 min, entered as hours + minutes, so whole minutes only",
          },
          server: probe([840, 930, 43200, 43260], [], "930 s is not a whole minute"),
          assumed: { min: 900, max: 43200, step: 1, note: "minutes + seconds" },
          corpus: observed({ min: 1500, max: 5400 }, { min: 5400, max: 5400 }),
          effective: { min: 900, max: 43200, step: 60 },
        }),
      },
      notes: ["MC4.0: 1-720 min, default 40 °C for 120 min."],
      evidence: [
        "editor: MC3.0 table entry sousVide, temperature 40-85, time type minutes 15-720",
        "server: 39 °C, 86 °C, 840 s, 930 s, 43260 s stored unchanged",
      ],
    },
    {
      id: "slow_cooking",
      editorId: "slowCooking",
      label: { de: "Slow Cook", en: "Slow cooking" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 9,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "temperature", "time"],
        modeSettingKeys: null,
        deviceControlled: ["speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "slowCooking" },
      corpus: { officialSteps: 4, memberSteps: 4 },
      effective: { allowed: true },
      params: {
        temperature: {
          unit: "°C",
          editor: layer({
            unit: "°C",
            values: SLOW_COOKING_TEMPS,
            default: 37,
            note: "starts at the first list value",
          }),
          server: probe([36, 95, 96]),
          assumed: layer({ unit: "°C", values: SLOW_COOKING_TEMPS }),
          corpus: observed({ values: { 90: 4 } }, { min: 70, max: 95 }),
          effective: layer({ unit: "°C", values: SLOW_COOKING_TEMPS }),
          notes: [],
        },
        time: timeParam({
          editor: { min: 900, max: 28800, step: 60, note: "15-480 min, whole minutes only" },
          server: probe([28800, 28860]),
          assumed: { min: 900, max: 28800, step: 1 },
          corpus: observed({ min: 10800, max: 14400 }, { min: 1800, max: 7200 }),
          effective: { min: 900, max: 28800, step: 60 },
        }),
      },
      notes: ["MC4.0: 1-480 min, default 90 °C for 360 min."],
      evidence: [
        "editor: MC3.0 table entry slowCooking, temperature list 37/40-95, time type minutes 15-480",
        "server: 36 °C, 96 °C and 28860 s stored unchanged",
      ],
    },
    {
      id: "cooking_eggs",
      editorId: "cookingEggs",
      label: { de: "Eier kochen", en: "Egg cooking" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 10,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: null,
        modeSettingKeys: ["size", "texture"],
        deviceControlled: ["temperature", "speed", "time"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "cookingEggs" },
      corpus: { officialSteps: 1, memberSteps: 2 },
      effective: { allowed: true },
      params: {
        size: {
          unit: null,
          editor: layer({
            values: ["small", "medium", "large"],
            default: "",
            note: "empty until chosen; the step validator does not check it, so an empty choice can be saved",
          }),
          server: {
            rangeEnforced: true,
            clamped: false,
            accepted: ["medium"],
            rejected: ["huge"],
            note: "HTTP 400, code 40004, must be a valid enum value",
          },
          assumed: layer({ values: ["small", "medium", "large"] }),
          corpus: observed({ values: { medium: 1 } }, { values: { medium: 2 } }),
          effective: layer({ values: ["small", "medium", "large"], note: "required" }),
          notes: [],
        },
        texture: {
          unit: null,
          editor: layer({
            values: ["soft", "waxy_soft", "hard"],
            default: "",
            note: "editor id waxySoft, snake_cased on save",
          }),
          server: {
            rangeEnforced: true,
            clamped: false,
            accepted: ["hard"],
            rejected: ["raw"],
            note: "HTTP 400, code 40004, must be a valid enum value",
          },
          assumed: layer({ values: ["soft", "waxy_soft", "hard"] }),
          corpus: observed({ values: { hard: 1 } }, { values: { soft: 1, hard: 1 } }),
          effective: layer({ values: ["soft", "waxy_soft", "hard"], note: "required" }),
          notes: [],
        },
      },
      notes: [
        "No deviceSettings. The editor shows cooking times in minutes for display only: small 8/9/15, medium 10/12/18, large 11/13/18 (soft/waxy soft/hard).",
      ],
      evidence: [
        "editor: MC3.0 table entry cookingEggs, sizeOptions and textureOptions, beStoredParameters null",
        "server: size huge and texture raw rejected with HTTP 400",
      ],
    },
    {
      id: "precleaning",
      editorId: "precleaning",
      label: { de: "Vorspülen", en: "Pre-rinse" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 11,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: null,
        modeSettingKeys: ["duration"],
        deviceControlled: ["temperature", "speed", "time"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "precleaning" },
      corpus: { officialSteps: 0, memberSteps: 17 },
      effective: { allowed: true },
      params: {
        duration: {
          unit: null,
          editor: layer({
            values: ["short", "long"],
            default: "short",
            note: "display only: short 1.5 min, long 5 min",
          }),
          server: {
            rangeEnforced: true,
            clamped: false,
            accepted: ["short"],
            rejected: ["medium"],
            note: "HTTP 400, code 40004, must be a valid enum value",
          },
          assumed: layer({ values: ["short", "long"] }),
          corpus: observed(
            null,
            { values: { short: 14, long: 3 } },
            "the read API calls the field cleaningMode",
          ),
          effective: layer({ values: ["short", "long"] }),
          notes: [],
        },
      },
      notes: ["MC4.0 offers short, dough and intense (2, 5, 10 min)."],
      evidence: [
        "editor: MC3.0 table entry precleaning, cleaningOptions short and long",
        "server: duration medium rejected with HTTP 400",
      ],
    },
    {
      id: "fermentation",
      editorId: "fermentation",
      label: { de: "Fermentieren", en: "Fermenting" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 12,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "temperature", "time"],
        modeSettingKeys: null,
        deviceControlled: ["speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "fermentation" },
      corpus: { officialSteps: 5, memberSteps: 5 },
      effective: { allowed: true },
      params: {
        temperature: {
          unit: "°C",
          editor: layer({
            unit: "°C",
            values: FERMENTATION_TEMPS,
            default: 37,
            note: "starts at the first list value",
          }),
          server: probe([65, 66]),
          assumed: layer({ unit: "°C", values: FERMENTATION_TEMPS }),
          corpus: observed({ values: { 40: 5 } }, { values: { 37: 5 } }),
          effective: layer({ unit: "°C", values: FERMENTATION_TEMPS }),
          notes: [],
        },
        time: timeParam({
          editor: { min: 1800, max: 43200, step: 60, note: "30-720 min, whole minutes only" },
          server: probe([43200, 43260]),
          assumed: { min: 1800, max: 43200, step: 1 },
          corpus: observed({ min: 3600, max: 43200 }, { min: 2700, max: 28800 }),
          effective: { min: 1800, max: 43200, step: 60 },
        }),
      },
      notes: ["MC4.0: 37-70 °C, 1-720 min, default 40 °C for 480 min."],
      evidence: [
        "editor: MC3.0 table entry fermentation, temperature list 37/40-65, time type minutes 30-720",
        "server: 66 °C and 43260 s stored unchanged",
      ],
    },
    {
      id: "turbo",
      editorId: "turbo",
      label: { de: "Turbo", en: "Turbo" },
      devices: ["MC0.5", "MC1.1", "MC2.0", "MC3.0", "MC4.0"],
      editorOrder: 13,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "required",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "turbo" },
      corpus: { officialSteps: 244, memberSteps: 169 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: {
            min: 1,
            max: 20,
            note: "dropdown of whole seconds 0-20; a fresh field reports valid at 0 without checking",
          },
          server: probe([0, 1, 20, 21]),
          assumed: { min: 1, max: 20 },
          corpus: observed({ min: 1, max: 12, median: 2 }, { min: 1, max: 20, median: 4 }),
          effective: { min: 1, max: 20 },
        }),
      },
      notes: [
        "The step description is required and shown on the device.",
        "Physical limits (liquid volume, temperature of the contents) are outside this file.",
        "MC0.5 turbo has no parameter; MC4.0 allows 2-20 s, default 2 s.",
      ],
      evidence: [
        "editor: MC3.0 table entry turbo, time 1-20 s, showDescription and requireDescription",
        "server: 0 s and 21 s stored unchanged",
        "corpus: official 1-12 s",
      ],
    },
    {
      id: "rice_cooking",
      editorId: "riceCooking",
      label: { de: "Reis kochen", en: "Rice cooking" },
      devices: ["MC3.0"],
      editorOrder: 14,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "riceCooking" },
      corpus: { officialSteps: 0, memberSteps: 0 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: { min: 1200, max: 2400 },
          server: probe([1199, 1200, 2400, 2401]),
          assumed: { min: 1200, max: 2400 },
          corpus: null,
          effective: { min: 1200, max: 2400 },
        }),
      },
      notes: ["No recipe in the corpus uses it, so there is no reference for quantities or setup."],
      evidence: [
        "editor: MC3.0 table entry riceCooking, time 1200-2400 s",
        "server: 1199 s and 2401 s stored unchanged",
      ],
    },
    {
      id: "food_processor",
      editorId: "foodProcessor",
      label: { de: "Food Processor", en: "Food processor" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 15,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: {
        typeAccepted: null,
        note: "not part of any probe; the type exists in official and member recipes",
      },
      assumed: {
        supported: true,
        smartRecipeType: "foodProcessor",
        note: "excluded unless MC_HAS_FOOD_PROCESSOR=true",
      },
      corpus: { officialSteps: 13, memberSteps: 15 },
      effective: { allowed: true, requires: ["food_processor_attachment"] },
      params: {
        time: timeParam({
          editor: { min: 1, max: 300 },
          server: null,
          assumed: { min: 1, max: 300 },
          corpus: observed({ min: 120, max: 300 }, { min: 15, max: 120 }),
          effective: { min: 1, max: 300 },
        }),
      },
      notes: [
        "Needs the food processor attachment; the bridge offers it only when the deployment says the attachment is present.",
        "MC4.0 adds speed 1-6 in half steps, default 4.5.",
      ],
      evidence: ["editor: MC3.0 table entry foodProcessor, time 1-300 s"],
    },
    {
      id: "ramp",
      editorId: "ramp",
      label: { de: "Rampe", en: "Speed ramp" },
      devices: ["MC2.0", "MC3.0", "MC4.0"],
      editorOrder: 16,
      memberVisible: false,
      payload: {
        deviceSettingsKeys: ["order", "speed", "temperature", "weight", "time"],
        modeSettingKeys: null,
        deviceControlled: [],
        note: "one deviceSettings entry per phase",
      },
      stepDescription: "cleared",
      server: { typeAccepted: true, note: "two phases accepted from a member account" },
      assumed: { supported: false, note: "SmartRecipe has no speed ramps" },
      corpus: { officialSteps: 60, memberSteps: 0 },
      effective: {
        allowed: false,
        reason:
          "Editors only in every table, untested on the device for member recipes, and official recipes break the editor's 20 s phase limit.",
      },
      params: {
        phaseCount: {
          unit: "phases",
          editor: layer({ unit: "phases", min: 1, note: "sortable list of phases, no maximum" }),
          server: { rangeEnforced: false, clamped: false, accepted: [2], rejected: [] },
          assumed: null,
          corpus: observed({ min: 3, max: 7 }, null),
          effective: layer({ unit: "phases", min: 1 }),
          notes: [],
        },
        phaseTime: timeParam({
          editor: { min: 1, max: 20, note: "dropdown of whole seconds 0-20" },
          server: { rangeEnforced: false, clamped: false, accepted: [10, 20], rejected: [] },
          assumed: null,
          corpus: observed({ min: 2, max: 30, note: "7 phases at 30 s" }, null),
          effective: { min: 1, max: 20 },
        }),
        phaseSpeed: {
          unit: "level",
          editor: layer({ unit: "level", min: 1, max: 10, step: 1 }),
          server: { rangeEnforced: false, clamped: false, accepted: [4, 8], rejected: [] },
          assumed: null,
          corpus: observed({ min: 2, max: 10, temperature: 0 }, null),
          effective: layer({ unit: "level", min: 1, max: 10, step: 1 }),
          notes: [],
        },
      },
      notes: ["Official ramps climb in speed, for example 4 to 8, at 0 °C."],
      evidence: [
        "editor: MC3.0 table entry ramp, adminOnly, per phase speed 1-10 and time 1-20 s",
        "server: two phases stored from a member account",
        "corpus: 60 official steps, 3-7 phases, phase time 2-30 s",
      ],
    },
    {
      id: "puree",
      editorId: "puree",
      label: { de: "Pürieren", en: "Puree" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 17,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "puree" },
      corpus: { officialSteps: 3, memberSteps: 80 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: { min: 30, max: 120 },
          server: probe([29, 30, 120, 121]),
          assumed: { min: 30, max: 120 },
          corpus: observed({ min: 30, max: 30 }, { min: 30, max: 120, median: 30 }),
          effective: { min: 30, max: 120 },
        }),
      },
      notes: ["MC4.0: 1-300 s, default 120 s."],
      evidence: [
        "editor: MC3.0 table entry puree, time 30-120 s",
        "server: 29 s and 121 s stored unchanged",
      ],
    },
    {
      id: "smoothie",
      editorId: "smoothie",
      label: { de: "Smoothie", en: "Smoothie" },
      devices: ["MC3.0", "MC4.0"],
      editorOrder: 18,
      memberVisible: true,
      payload: {
        deviceSettingsKeys: ["order", "time"],
        modeSettingKeys: null,
        deviceControlled: ["temperature", "speed"],
      },
      stepDescription: "cleared",
      server: { typeAccepted: true },
      assumed: { supported: true, smartRecipeType: "smoothie" },
      corpus: { officialSteps: 4, memberSteps: 19 },
      effective: { allowed: true },
      params: {
        time: timeParam({
          editor: { min: 30, max: 120 },
          server: null,
          assumed: { min: 30, max: 120 },
          corpus: observed({ min: 60, max: 60 }, { min: 30, max: 120, median: 60 }),
          effective: { min: 30, max: 120 },
        }),
      },
      notes: ["MC4.0: 1-120 s, default 45 s."],
      evidence: ["editor: MC3.0 table entry smoothie, time 30-120 s"],
    },
  ];
}

// Programs that exist only on other devices, listed so the converter can name and refuse them.
function buildOtherDeviceModes(): OtherDeviceMode[] {
  // id, editor id, German label, English label, MC4.0 editor limits
  const rows: readonly (readonly [string, string, string, string, string])[] = [
    [
      "kneading_prove_dough",
      "kneadingProveDough",
      "Teig gehen lassen",
      "Proving dough",
      "37-40 °C, 30-60 min, default 37 °C for 45 min",
    ],
    [
      "roasting_gentle",
      "roastingGentle",
      "Sanft anbraten",
      "Gentle roast",
      "100-145 °C in 5-degree steps, 1-1200 s, default 145 °C for 420 s",
    ],
    [
      "roasting_intense",
      "roastingIntense",
      "Intensiv anbraten",
      "Intense roast",
      "100-165 °C in 5-degree steps, 1-1200 s, default 165 °C for 420 s",
    ],
    [
      "heat_water",
      "heatWater",
      "Wasser erhitzen",
      "Heat water",
      "37-100 °C, no time, default 100 °C",
    ],
    [
      "heating_up",
      "heatingUp",
      "Aufwärmen",
      "Heating up",
      "37-90 °C, 0-20 min, speed 0.5-2, default 70 °C, speed 1",
    ],
    [
      "open_cooking",
      "openCooking",
      "Offenes Kochen",
      "Open cooking",
      "37-165 °C, 1-120 min, default 100 °C for 15 min",
    ],
    [
      "citrus_juicer",
      "citrusJuicer",
      "Zitruspresse",
      "Citrus juicer",
      "1-1200 s, default 300 s, fixed speed 0.5 clockwise, citrus juicer module",
    ],
    [
      "air_fryer",
      "airFryer",
      "Heißluftfritteuse",
      "Air fryer",
      "1-3600 s, fixed 200 °C, air fryer module",
    ],
    [
      "contact_grill",
      "contactGrill",
      "Kontaktgrill",
      "Contact grill",
      "1-3600 s, fixed 180 °C, contact grill module",
    ],
  ];
  return rows.map(([id, editorId, de, en, editor]) => ({
    id,
    editorId,
    label: { de, en },
    devices: ["MC4.0"],
    editor,
    server: null,
    effective: { allowed: false, reason: "not an MC3.0 program" },
  }));
}

// Recipe-level limits. The type is inferred from the literals and exported as RecipeLimits.
function buildRecipeLimits() {
  return {
    deviceTypeIds: {
      editor: {
        note: "the editor picks one device table per recipe; first match wins in the order MC1.1, MC2.0, MC3.0, MC0.5, MC4.0",
      },
      server: null,
      assumed: { values: [13] },
      effective: {
        values: [13],
        note: "MC3.0 only; adding MC2.0 makes the web editor open the recipe with the smaller MC2.0 table",
      },
    },
    temperatureGrid: {
      heating: { values: HEATING_TEMPS, usedBy: ["customized", "roasting (editor)"] },
      roastingEffective: { values: ROASTING_TEMPS, usedBy: ["roasting (effective)"] },
      slowCooking: { values: SLOW_COOKING_TEMPS, usedBy: ["slow_cooking"] },
      fermentation: { values: FERMENTATION_TEMPS, usedBy: ["fermentation"] },
      sousVide: { min: 40, max: 85, step: 1, usedBy: ["sous_vide"] },
      notes: [
        "0 °C means no heating. No value exists between 0 and 37 or between 37 and 40.",
        "The server stores off-grid values (36, 38, 135 °C) unchanged, so the bridge must check the grid itself.",
      ],
    },
    speedRules: {
      range: {
        editor: { min: 1, max: 10, step: 1 },
        server: { rangeEnforced: false, accepted: [0, 4, 10, 11] },
        assumed: { min: 0, max: 10, step: 1 },
        corpus: { min: 1, max: 10, halfSpeeds: 0, zero: 0 },
        effective: { min: 1, max: 10, step: 1 },
      },
      rules: [
        {
          id: "heat-cap",
          text: "With any temperature above 0 °C, speed is at most 3.",
          ...SPEED_HEAT,
          layers: { editor: true, server: false, assumed: true, effective: true },
          corpus: "one official step breaks it (speed 4 at 50 °C)",
        },
        {
          id: "reverse-cap",
          text: "In reverse (clockwise false), speed is at most 3.",
          ...SPEED_REVERSE,
          layers: { editor: true, server: false, assumed: true, effective: true },
          corpus: "5 steps at 0 °C break it (speed 4-8), one of them official",
        },
        {
          id: "whisk-cap",
          text: "With the butterfly whisk, speed is at most 4.",
          ...SPEED_WHISK,
          layers: { editor: false, server: false, assumed: true, effective: true },
          source: "official recipe-creation guide; SmartRecipe prompt",
        },
        {
          id: "high-speed-time",
          text: "At speed 6 or higher, a manual step lasts at most 600 s.",
          ...TIME_HIGH_SPEED,
          appliesTo: "time",
          layers: { editor: false, server: false, assumed: false, effective: true },
          source: "MC4.0 and MC0.5 editor tables; corpus maximum is exactly 600 s",
        },
        {
          id: "no-speed-zero",
          text: "Speed 0 is invalid. A pause or wait is a text step, not a manual step at 0 °C and speed 0.",
          layers: { editor: true, server: false, assumed: false, effective: true },
          corpus: "no step with speed 0",
        },
      ],
    },
    text: {
      recipeTitle: {
        editor: { minLength: 1, maxLength: 86 },
        server: { rangeEnforced: false, accepted: [87] },
        assumed: { minLength: 1, maxLength: 120 },
        corpus: { maxLength: 86 },
        effective: { minLength: 1, maxLength: 86 },
      },
      recipeDescription: {
        editor: { maxLength: 240, required: false },
        server: null,
        assumed: { maxLength: 2000 },
        corpus: null,
        effective: { maxLength: 240 },
      },
      stepTitle: {
        editor: { minLength: 1, maxLength: 80 },
        server: { rangeEnforced: false, accepted: [80, 81] },
        assumed: { minLength: 1, maxLength: 80 },
        corpus: {
          official: { maxLength: 86 },
          member: { maxLength: 80 },
          note: "official titles above 80 come from devices whose editor derives the title from the description",
        },
        effective: { minLength: 1, maxLength: 80 },
      },
      stepDescription: {
        editor: {
          maxLength: 240,
          requiredOn: ["text", "scale", "turbo"],
          clearedOn: "every other mode",
        },
        server: {
          rangeEnforced: false,
          accepted: [240, 241, 300],
          note: "a description on a roasting step was stored too",
        },
        assumed: {
          maxLength: 240,
          allowedOn: ["text", "scale", "turbo"],
          note: "blanked for every other mode",
        },
        corpus: {
          official: { maxLength: 243 },
          member: { maxLength: 240 },
          note: "text, scale and turbo steps always have one; other programs almost never",
        },
        effective: {
          minLength: 1,
          maxLength: 240,
          requiredOn: ["text", "scale", "turbo"],
          emptyOn: "every other mode",
        },
      },
      countedAs: "characters (the editor fields are named WordLimit but count characters)",
    },
    textStep: {
      duration: {
        editor: { available: false, note: "the web editor has no timer field for text steps" },
        server: { accepted: [60], note: "stored and returned" },
        assumed: { value: null },
        effective: {
          value: null,
          note: "send null until a device test shows what the device does with it",
        },
      },
    },
    servings: {
      amount: {
        editor: { min: 1, max: null, note: "no upper limit" },
        server: { rangeEnforced: false, accepted: [0, 25] },
        assumed: { min: 1, max: 24, step: 1 },
        corpus: {
          official: { min: 1, max: 100 },
          member: { min: 1, max: 400 },
          note: "49 official recipes above 24, all counted in pieces or slices",
        },
        effective: {
          min: 1,
          max: 100,
          step: 1,
          note: "SmartRecipe's 24 contradicts official recipes; 100 is the largest official value",
        },
      },
      servingSizes: {
        editor: { min: 1, max: 4 },
        server: null,
        assumed: { min: 1, max: 1 },
        effective: { min: 1, max: 1 },
      },
    },
    categories: {
      editor: {
        min: 1,
        max: null,
        note: "members can pick only categories flagged as not official",
      },
      server: { rangeEnforced: false, accepted: [9] },
      assumed: { min: 0, max: 8 },
      corpus: { max: 14, above8: 4 },
      effective: { min: 1, max: 8, note: "ids from GET api/v1/categories" },
    },
    times: {
      preparationTime: {
        unit: "min",
        editor: { min: 1, max: 5940 },
        server: null,
        assumed: { min: 1, max: 1440 },
        corpus: { official: { max: 1440 }, member: { max: 3600 } },
        effective: { min: 1, max: 1440 },
      },
      readyInTime: {
        unit: "min",
        editor: { min: 1, max: 18000 },
        server: null,
        assumed: { min: 1, max: 2880 },
        corpus: { official: { max: 14426, above2880: 10 } },
        effective: { min: 1, max: 18000, conditions: [READY_BEFORE_PREPARATION] },
        notes: [
          "SmartRecipe's 2880 contradicts 10 official recipes. No official recipe has a total time below its preparation time.",
        ],
      },
    },
    required: {
      editor: [
        "title",
        "complexity",
        "category (at least one)",
        "cover photo",
        "ingredient (at least one)",
        "step (at least one)",
        "step title",
      ],
      effective: [
        "title",
        "complexityId",
        "categoryIds (at least one)",
        "cover photo",
        "ingredient (at least one)",
        "step (at least one)",
        "step title",
      ],
    },
    coverPhoto: {
      editor: { types: ["image/jpeg", "image/png"], crop: "16:9", exportedAs: "image/jpeg" },
      effective: { type: "image/jpeg", aspect: "16:9" },
    },
    nutrients: {
      editor: {
        names: [
          "calories",
          "carbohydrate",
          "fat",
          "protein",
          "saturates",
          "sugar",
          "salt",
          "roughage",
        ],
        units: { calories: "kCal", other: "g" },
        note: "numeric checks only for MC4.0 (at most 99999, 2 decimals); empty values are dropped",
      },
      server: null,
      assumed: { names: ["calories", "carbohydrate", "fat", "protein"], step: 1, min: 0 },
      effective: {
        names: [
          "calories",
          "carbohydrate",
          "fat",
          "protein",
          "saturates",
          "sugar",
          "salt",
          "roughage",
        ],
        min: 0,
        max: 99999,
        step: 1,
        note: "optional; omit unknown values",
      },
    },
    notInMemberEditor: [
      "step video (editors only, mp4 up to 100 MB)",
      "modules (MC4.0 only)",
      "timer on text steps",
    ],
  };
}

// ---------------------------------------------------------------------------
// Output

/**
 * Serializes the document as pretty JSON that keeps arrays of primitives and small flat objects
 * on one line, followed by a newline. Throws if the result does not parse back to the same data.
 */
export function formatDevicePrograms(doc: DeviceProgramsDoc): string {
  const out = format(doc) + "\n";
  const reparsed: unknown = JSON.parse(out);
  if (JSON.stringify(reparsed) !== JSON.stringify(doc)) {
    throw new Error("formatter changed the data");
  }
  return out;
}

function format(value: unknown, indent = ""): string {
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (items.every((x) => x === null || typeof x !== "object")) {
      return "[" + items.map((x) => JSON.stringify(x)).join(", ") + "]";
    }
    return "[\n" + items.map((x) => inner + format(x, inner)).join(",\n") + "\n" + indent + "]";
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) return "{}";
    const flat = keys.every((k) => record[k] === null || typeof record[k] !== "object");
    const oneLine =
      "{ " +
      keys.map((k) => JSON.stringify(k) + ": " + JSON.stringify(record[k])).join(", ") +
      " }";
    if (flat && oneLine.length <= 110) return oneLine;
    const lines = keys.map((k) => inner + JSON.stringify(k) + ": " + format(record[k], inner));
    return "{\n" + lines.join(",\n") + "\n" + indent + "}";
  }
  return JSON.stringify(value);
}
