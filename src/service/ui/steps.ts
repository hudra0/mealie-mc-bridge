// The converted recipe as the machine would show it: numbered steps, text steps as text,
// program steps with their mode and chips for temperature, time, speed, rotation and
// weight, and the ingredient groups with amounts. The job page and the dry run use it.
//
// The input is read loosely: a stored conversion from an older release, or a step kind this
// release does not know, still renders, with what can be read.

import type { AdminMessages } from "../../i18n/index.js";
import { MODES, type MachineStepKind } from "../../recipe/modes.js";
import { html, type SafeHtml } from "../html.js";
import { emptyState, icon } from "./components.js";
import type { IconName } from "./icons.generated.js";

// The icon per program, as the device draws a similar symbol. One entry per kind.
export const MODE_ICONS: Readonly<Record<MachineStepKind | "text", IconName>> = {
  text: "hand",
  customized: "cooking-pot",
  roasting: "flame",
  steaming: "cloud",
  kneading_solid_dough: "wheat",
  kneading_soft_dough: "wheat",
  kneading_liquid_dough: "wheat",
  puree: "blender",
  smoothie: "cup-soda",
  turbo: "zap",
  scale: "scale",
  slow_cooking: "hourglass",
  sous_vide: "waves",
  fermentation: "flask-round",
  rice_cooking: "bean",
  cooking_eggs: "egg",
  precleaning: "sparkles",
  food_processor: "carrot",
};

type Loose = Record<string, unknown>;

export interface ViewRecipe {
  servings: { amount: number | null; unit: string };
  preparationTime: number | null;
  readyInTime: number | null;
  steps: Loose[];
  groups: Array<{ name: string; ingredients: Loose[] }>;
}

const isRecord = (value: unknown): value is Loose =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

// The parts of a converted recipe the view needs; null when it has no steps.
export function readRecipe(value: unknown): ViewRecipe | null {
  if (!isRecord(value) || !isRecord(value.servingSize)) return null;
  const size = value.servingSize;
  const steps = Array.isArray(size.steps) ? size.steps.filter(isRecord) : [];
  if (steps.length === 0) return null;
  const groups = (Array.isArray(size.ingredientGroups) ? size.ingredientGroups : [])
    .filter(isRecord)
    .map((group) => ({
      name: str(group.name),
      ingredients: Array.isArray(group.ingredients) ? group.ingredients.filter(isRecord) : [],
    }));
  return {
    servings: { amount: num(size.amount), unit: str(size.unit) },
    preparationTime: num(size.preparationTime),
    readyInTime: num(size.readyInTime),
    steps,
    groups,
  };
}

// The converted recipe stored on a job: its result.recipe.
export function storedRecipe(conversion: { result?: unknown } | null | undefined) {
  const result = conversion?.result;
  return isRecord(result) ? readRecipe(result.recipe) : null;
}

function isMachineKind(kind: string): kind is MachineStepKind {
  return Object.hasOwn(MODES, kind);
}

// "20:00", "1:05:00"; whole minutes for the programs set in minutes.
export function programTime(kind: MachineStepKind, step: Loose): string | null {
  const minutes = num(step.minutes) ?? 0;
  const seconds = num(step.seconds) ?? 0;
  if (kind === "turbo") return `${seconds} s`;
  if (MODES[kind].timeUnit === null) return null;
  if (!("minutes" in step) && !("seconds" in step)) return null;
  const total = minutes * 60 + seconds;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function chip(name: IconName, text: string, title: string): SafeHtml {
  return html`<span
    class="inline-flex items-center gap-1 rounded-md border border-line bg-subtle px-2 py-0.5 text-xs font-medium tabular-nums"
    title="${title}"
    >${icon(name, "size-3.5 text-fg-subtle")}${text}</span
  >`;
}

function chips(kind: MachineStepKind, step: Loose, t: AdminMessages["steps"]): SafeHtml[] {
  const out: SafeHtml[] = [];
  const temperature = num(step.temperature);
  if (temperature !== null && temperature > 0) {
    out.push(chip("thermometer", `${temperature} °C`, t.temperature));
  }
  const time = programTime(kind, step);
  if (time) out.push(chip("timer", time, t.time));
  const speed = num(step.speed);
  if (speed !== null) out.push(chip("gauge", t.speed(speed), t.speedTitle));
  if (step.rotation === "left") out.push(chip("rotate-ccw", t.reverse, t.rotation));
  else if (step.rotation === "right") out.push(chip("rotate-cw", t.forward, t.rotation));
  if (step.accessory === "butterfly_whisk") out.push(chip("utensils", t.whisk, t.accessory));
  const grams = num(step.grams);
  if (grams !== null) out.push(chip("scale", `${grams} g`, t.weight));
  if (typeof step.size === "string" && Object.hasOwn(t.eggSize, step.size)) {
    out.push(chip("egg", t.eggSize[step.size as keyof typeof t.eggSize], t.eggSizeTitle));
  }
  if (typeof step.texture === "string" && Object.hasOwn(t.eggTexture, step.texture)) {
    out.push(
      chip("egg", t.eggTexture[step.texture as keyof typeof t.eggTexture], t.eggTextureTitle),
    );
  }
  if (typeof step.duration === "string" && Object.hasOwn(t.cleaning, step.duration)) {
    out.push(chip("timer", t.cleaning[step.duration as keyof typeof t.cleaning], t.time));
  }
  return out;
}

const ELLIPSIS = /(…|\.{3})\s*$/;
const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// Whether a step title only repeats its description: older conversions cut titles from the
// start of the text, often mid-sentence and with an ellipsis. Such a title is left out.
export function redundantTitle(title: string, description: string): boolean {
  if (title.trim() === "" || description.trim() === "") return false;
  if (ELLIPSIS.test(title)) return true;
  const head = fold(title.replace(ELLIPSIS, "")).replace(/[\s.,:;!?-]+$/, "");
  return head === "" || fold(description).startsWith(head);
}

function stepItem(step: Loose, index: number, t: AdminMessages["steps"]): SafeHtml {
  const kind = str(step.kind);
  const description = str(step.description);
  const title = redundantTitle(str(step.title), description) ? "" : str(step.title);
  const number = html`<span
    class="grid size-7 shrink-0 place-items-center rounded-full bg-subtle text-xs font-semibold text-fg-muted tabular-nums"
    >${index + 1}</span
  >`;
  if (!isMachineKind(kind)) {
    return html`<li class="flex gap-3 rounded-lg border border-line bg-surface p-3">
      ${number}
      <div class="min-w-0 flex-1 space-y-0.5 pt-0.5">
        ${title ? html`<p class="font-medium [overflow-wrap:anywhere]">${title}</p>` : ""}
        ${
          description
            ? html`<p class="${title ? "text-fg-muted" : ""} [overflow-wrap:anywhere]">
                ${description}
              </p>`
            : ""
        }
      </div>
    </li>`;
  }
  const list = chips(kind, step, t);
  return html`<li class="flex gap-3 rounded-lg border border-line bg-surface p-3">
    ${number}
    <div class="min-w-0 flex-1 pt-0.5">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          class="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent-fg"
          >${icon(MODE_ICONS[kind], "size-3.5")}${t.modes[kind]}</span
        >
        ${title ? html`<span class="font-medium [overflow-wrap:anywhere]">${title}</span>` : ""}
      </div>
      ${list.length > 0 ? html`<div class="mt-2 flex flex-wrap gap-1.5">${list}</div>` : ""}
      ${
        description
          ? html`<p class="mt-2 text-fg-muted [overflow-wrap:anywhere]">${description}</p>`
          : ""
      }
    </div>
  </li>`;
}

function amount(item: Loose): string {
  const value = item.amount;
  const text = typeof value === "number" ? String(value) : str(value);
  return [text, str(item.unit)].filter(Boolean).join(" ");
}

export function ingredientGroups(recipe: ViewRecipe, t: AdminMessages["steps"]): SafeHtml {
  const servings =
    recipe.servings.amount === null ? "" : t.servings(recipe.servings.amount, recipe.servings.unit);
  return html`<div class="rounded-lg border border-line bg-surface shadow-xs">
    <div class="flex items-baseline justify-between gap-2 border-b border-line px-4 py-3">
      <h3 class="text-sm font-semibold">${t.ingredients}</h3>
      <span class="text-xs text-fg-muted">${servings}</span>
    </div>
    <div class="space-y-3 py-3">
      ${recipe.groups.map(
        (group) =>
          html`<div>
            ${
              group.name
                ? html`<p class="px-4 pb-1 text-xs font-semibold text-fg-muted">${group.name}</p>`
                : ""
            }
            <ul>
              ${group.ingredients.map(
                (item) =>
                  html`<li class="flex items-baseline justify-between gap-3 px-4 py-1">
                    <span class="min-w-0 [overflow-wrap:anywhere]"
                      >${str(item.name)}${
                        item.isOptional === true
                          ? html` <span class="text-xs text-fg-muted">${t.optional}</span>`
                          : ""
                      }</span
                    >
                    <span class="shrink-0 text-fg-muted tabular-nums">${amount(item)}</span>
                  </li>`,
              )}
            </ul>
          </div>`,
      )}
    </div>
  </div>`;
}

// Steps beside the ingredients on wide screens, below them on narrow ones.
export function recipeSteps(recipe: ViewRecipe | null, t: AdminMessages["steps"]): SafeHtml {
  if (!recipe) return emptyState({ icon: "list-ordered", text: t.none });
  const times =
    recipe.preparationTime === null || recipe.readyInTime === null
      ? ""
      : html`<p class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
          <span class="inline-flex items-center gap-1"
            >${icon("timer", "size-3.5")}${t.preparation(recipe.preparationTime)}</span
          >
          <span class="inline-flex items-center gap-1"
            >${icon("clock", "size-3.5")}${t.ready(recipe.readyInTime)}</span
          >
        </p>`;
  return html`<div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <div class="min-w-0">
      ${times}
      <ol class="space-y-2">
        ${recipe.steps.map((step, index) => stepItem(step, index, t))}
      </ol>
    </div>
    <div class="order-first lg:sticky lg:top-6 lg:order-none">${ingredientGroups(recipe, t)}</div>
  </div>`;
}
