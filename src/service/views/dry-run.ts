// The dry run: a form on the left (recipe picker, scale, convert now), the result on the
// right in tabs: the steps as the machine would show them, the converter input, the parsed
// ingredients and the checks. Nothing is sent to Monsieur Cuisine.

import type { SavedStatus } from "../../i18n/index.js";
import type { ScaledIngredient } from "../../ingredients/index.js";
import type { MealieRecipeSummary } from "../../mealie/index.js";
import type { ConversionResult } from "../../pipeline/converter-port.js";
import type { CategoryPlan, CheckedRecipe, PreparedRecipe } from "../../pipeline/prepare.js";
import { formatServingSize } from "../../pipeline/serving-size.js";
import type { SentRecipe } from "../../store/mc-recipes.js";
import { html, safeHref, type SafeHtml } from "../html.js";
import {
  badge,
  button,
  callout,
  card,
  CHECKBOX_CLASS,
  csrfField,
  descriptionList,
  emptyState,
  field,
  helpPopover,
  icon,
  INPUT_CLASS,
  pageHeader,
  pageTabs,
  statusDot,
  table,
} from "../ui/components.js";
import { readRecipe, recipeSteps } from "../ui/steps.js";
import { dateTag, money, type ViewContext } from "./context.js";

export interface DryRunData {
  recipeStatus: SavedStatus;
  recipeParam: string;
  scale: number;
  title?: string;
  prepared?: PreparedRecipe;
  sent?: SentRecipe | null;
  conversion?: { plan: CategoryPlan; result: ConversionResult; checked: CheckedRecipe };
  conversionError?: string;
  loadError?: string;
  // Recipes whose name matched when the entry was no id or slug.
  matches?: MealieRecipeSummary[];
}

function dryRunForm(data: DryRunData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  return html`<form
    method="post"
    action="/admin/dry-run"
    class="space-y-4"
    data-busy="${l.working}"
  >
    ${csrfField(ctx.csrf)}
    ${field({
      id: "dry-recipe",
      label: l.recipe,
      hint: l.recipeHint,
      control: html`<div class="relative">
        <input
          id="dry-recipe"
          type="text"
          name="recipe"
          value="${data.recipeParam}"
          placeholder="${l.recipePlaceholder}"
          required
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="false"
          aria-controls="dry-recipe-options"
          aria-describedby="dry-recipe-hint"
          data-recipe-search="/admin/dry-run/recipes"
          class="${INPUT_CLASS}"
        />
        <ul
          id="dry-recipe-options"
          role="listbox"
          hidden
          class="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
          data-option-class="cursor-pointer rounded-md px-2.5 py-1.5 aria-selected:bg-subtle hover:bg-subtle"
        ></ul>
      </div>`,
    })}
    ${field({
      id: "dry-scale",
      label: l.scale,
      hint: l.scaleHint,
      control: html`<input
        id="dry-scale"
        type="number"
        name="scale"
        value="${data.scale}"
        min="0.25"
        max="10"
        step="0.25"
        class="${INPUT_CLASS} w-28"
      />`,
    })}
    <label class="flex gap-2.5">
      <input type="checkbox" name="convert" value="1" class="${CHECKBOX_CLASS}" />
      <span>
        <span class="block font-medium">${l.convertNow}</span>
        <span class="block text-xs text-fg-muted">${l.convertNowHint}</span>
      </span>
    </label>
    ${button({ label: l.preview, variant: "primary", icon: "play", busyLabel: true })}
  </form>`;
}

function sourceFacts(data: DryRunData, prepared: PreparedRecipe, ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  return descriptionList([
    [
      l.servings,
      html`${formatServingSize(prepared.servingSize)}${
        prepared.servingSize.source === "estimate"
          ? html` ${helpPopover(l.estimated, l.estimatedHelp)}`
          : ""
      }`,
    ],
    [l.sourceHash, html`<code class="text-xs">${prepared.hash.slice(0, 12)}</code>`],
    [
      l.alreadySent,
      data.sent
        ? html`<a
              href="${safeHref(data.sent.mcRecipeUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="font-medium text-accent-fg hover:underline"
              >${ctx.t.jobs.recipeLink(data.sent.mcRecipeId, data.recipeStatus)}</a
            >
            <span class="text-fg-muted">· ${dateTag(data.sent.createdAt, ctx)}</span>
            <p class="text-xs text-fg-muted">${l.wouldSkip}</p>`
        : l.notSent,
    ],
  ]);
}

function convertButton(data: DryRunData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  return html`<form method="post" action="/admin/dry-run" data-busy="${l.working}">
    ${csrfField(ctx.csrf)}
    <input type="hidden" name="recipe" value="${data.recipeParam}" />
    <input type="hidden" name="scale" value="${data.scale}" />
    <input type="hidden" name="convert" value="1" />
    ${button({ label: l.convert, variant: "primary", icon: "sparkles", busyLabel: true })}
  </form>`;
}

function preview(data: DryRunData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  if (data.conversion) return recipeSteps(readRecipe(data.conversion.checked.recipe), ctx.t.steps);
  if (data.conversionError) {
    return callout({ tone: "danger", title: l.conversionFailed, body: data.conversionError });
  }
  return emptyState({
    icon: "sparkles",
    title: l.notConverted,
    text: l.notConvertedHint,
    action: convertButton(data, ctx),
  });
}

function ingredientsTable(items: readonly ScaledIngredient[], ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  if (items.length === 0) return emptyState({ icon: "carrot", text: l.noIngredients });
  return html`<div class="rounded-lg border border-line">
    ${table({
      head: [l.amount, l.food, l.note, l.source],
      rows: items.map(
        (item) =>
          html`<tr title="${item.original}">
            <td class="px-4 py-2 whitespace-nowrap tabular-nums">
              ${item.quantity ?? ""}${item.quantityMax === null ? "" : `–${item.quantityMax}`}
              ${item.unit ?? ""}
            </td>
            <td class="px-4 py-2 font-medium [overflow-wrap:anywhere]">
              ${item.food}${
                item.section
                  ? html` <span class="text-xs font-normal text-fg-muted">· ${item.section}</span>`
                  : ""
              }
            </td>
            <td class="px-4 py-2 text-fg-muted [overflow-wrap:anywhere]">
              ${item.note}${item.optional ? ` ${l.optional}` : ""}
            </td>
            <td class="px-4 py-2 whitespace-nowrap">
              ${
                item.source === "unparsed"
                  ? badge("warn", l.unparsed)
                  : html`<span class="text-xs text-fg-muted">${item.source}</span>`
              }
            </td>
          </tr>`,
      ),
    })}
  </div>`;
}

function checks(data: DryRunData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  const conversion = data.conversion;
  if (!conversion) {
    return emptyState({ icon: "shield-check", text: data.conversionError ?? l.notConvertedHint });
  }
  const { result, checked, plan } = conversion;
  const names = new Map(plan.catalog.categories.map((category) => [category.id, category.name]));
  const list = (items: readonly string[]) =>
    html`<ul class="mt-1 list-disc space-y-1 pl-5">
      ${items.map((item) => html`<li>${item}</li>`)}
    </ul>`;
  return html`<div class="space-y-4">
    ${
      checked.validation.ok
        ? callout({ tone: "ok", title: l.passed })
        : callout({
            tone: "danger",
            title: l.errors(checked.validation.errors.length),
            body: html`<ul class="mt-1 space-y-1">
              ${checked.validation.errors.map(
                (issue) =>
                  html`<li><code class="text-xs">${issue.path}</code> ${issue.message}</li>`,
              )}
            </ul>`,
          })
    }
    ${
      checked.reviewHints.length > 0 || result.warnings.length > 0
        ? callout({
            tone: "warn",
            title: ctx.t.jobDetail.checkTitle,
            body: html`${
              checked.reviewHints.length > 0
                ? html`<p class="font-medium">${l.reviewHints}</p>
                    ${list(checked.reviewHints)}`
                : ""
            }${
              result.warnings.length > 0
                ? html`<p class="mt-3 font-medium">${l.warnings}</p>
                    ${list(result.warnings)}`
                : ""
            }`,
          })
        : ""
    }
    ${card({
      title: l.conversion,
      icon: "sparkles",
      body: descriptionList([
        [l.model, `${result.provider} / ${result.model}`],
        [l.attempts, String(result.attempts)],
        [l.tokens, l.tokenCounts(result.usage.inputTokens, result.usage.outputTokens)],
        [l.cost, money(result.usage.costUsd, ctx, { precise: true })],
        [
          l.categories,
          html`${
            checked.categories.ids.map((id) => `${id} ${names.get(id) ?? "?"}`).join(", ") || "–"
          }${
            checked.categories.dropped.length > 0
              ? html`<p class="text-xs text-warn-fg">
                  ${l.droppedIds(checked.categories.dropped.join(", "))}
                </p>`
              : ""
          }`,
        ],
      ]),
    })}
  </div>`;
}

function result(data: DryRunData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  if (data.loadError)
    return callout({ tone: "danger", title: l.loadFailed, body: data.loadError, alert: true });
  if (data.matches && data.matches.length > 0) {
    return card({
      title: l.matches,
      icon: "search",
      flush: true,
      body: html`<ul class="divide-y divide-line">
        ${data.matches.map(
          (match) =>
            html`<li>
              <a
                href="/admin/dry-run?recipe=${encodeURIComponent(match.slug)}&amp;scale=${data.scale}"
                class="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-subtle"
              >
                <span class="min-w-0">
                  <span class="block truncate font-medium">${match.name}</span>
                  <span class="block truncate text-xs text-fg-muted">${match.slug}</span>
                </span>
                ${icon("chevron-right", "size-4 text-fg-subtle")}
              </a>
            </li>`,
        )}
      </ul>`,
    });
  }
  const prepared = data.prepared;
  if (!prepared) {
    return card({
      body: emptyState({ icon: "flask-conical", title: l.emptyTitle, text: l.empty }),
    });
  }
  const conversion = data.conversion;
  return card({
    title: data.title ?? "",
    icon: "utensils",
    actions: conversion
      ? conversion.checked.validation.ok
        ? statusDot("ok", l.passed)
        : statusDot("danger", l.errors(conversion.checked.validation.errors.length))
      : undefined,
    body: pageTabs(l.tabsLabel, [
      { id: "dry-preview", label: l.tabs.preview, icon: "list-ordered", body: preview(data, ctx) },
      {
        id: "dry-input",
        label: l.tabs.input,
        icon: "file-text",
        body: html`<pre
          class="max-h-[32rem] overflow-auto rounded-lg border border-line bg-subtle p-3 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
${prepared.rendered}</pre>`,
      },
      {
        id: "dry-ingredients",
        label: l.tabs.ingredients,
        icon: "carrot",
        count: prepared.scaled.length,
        body: ingredientsTable(prepared.scaled, ctx),
      },
      {
        id: "dry-checks",
        label: l.tabs.checks,
        icon: "shield-check",
        ...(conversion
          ? { count: conversion.checked.reviewHints.length + conversion.result.warnings.length }
          : {}),
        body: checks(data, ctx),
      },
    ]),
  });
}

export function dryRunView(data: DryRunData, ctx: ViewContext): SafeHtml {
  const l = ctx.t.dryRun;
  return html`${pageHeader({ title: ctx.t.titles.dryRun, subtitle: l.subtitle })}
    <div class="grid items-start gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div class="space-y-4 lg:sticky lg:top-6">
        ${card({ title: l.formTitle, icon: "flask-conical", body: dryRunForm(data, ctx) })}
        ${
          data.prepared
            ? card({
                title: l.sourceTitle,
                icon: "utensils",
                body: sourceFacts(data, data.prepared, ctx),
              })
            : ""
        }
      </div>
      <div class="min-w-0">${result(data, ctx)}</div>
    </div>`;
}
