// The log of a job as a timeline: each event code as a sentence in the language of the
// pages with an icon, the raw error of a failure below it, the parameters collapsed under
// "technical details". Events written before codes existed show their stored message.

import { jobEventText } from "../../i18n/index.js";
import type { JobEventCode } from "../../store/job-events.js";
import type { JobEvent } from "../../store/jobs.js";
import { html, type SafeHtml } from "../html.js";
import { descriptionList, timeline, type Tone } from "../ui/components.js";
import type { IconName } from "../ui/icons.generated.js";
import { timeTag, type ViewContext } from "./context.js";

// The icon and colour of each code; the level of the event decides for warnings and errors.
export const EVENT_STYLE: Readonly<Record<JobEventCode, readonly [IconName, Tone]>> = {
  queued: ["clock", "neutral"],
  requeued: ["rotate-ccw", "neutral"],
  cancelled: ["ban", "neutral"],
  paused: ["pause", "warn"],
  resumed: ["play", "info"],
  recovered_done: ["power", "warn"],
  recovered_failed: ["power", "danger"],
  recovered_queued: ["power", "neutral"],
  attempt_started: ["play", "info"],
  recipe_loaded: ["utensils", "neutral"],
  prepared: ["list-ordered", "neutral"],
  forced_unchanged: ["refresh-cw", "neutral"],
  skip_exists: ["circle-check", "neutral"],
  skip_gone: ["refresh-cw", "warn"],
  skip_unchecked: ["circle-alert", "warn"],
  image_loaded: ["image", "neutral"],
  image_none: ["image", "neutral"],
  image_load_failed: ["image", "warn"],
  categories: ["tag", "neutral"],
  conversion_reused: ["sparkles", "neutral"],
  converting: ["sparkles", "accent"],
  still_converting: ["loader-circle", "accent"],
  converted: ["sparkles", "accent"],
  converter_warning: ["triangle-alert", "warn"],
  categories_dropped: ["tag", "warn"],
  servings_estimated: ["utensils", "neutral"],
  servings_changed: ["utensils", "warn"],
  validation_passed: ["shield-check", "ok"],
  ingredients_resolved: ["carrot", "neutral"],
  ingredients_off: ["carrot", "neutral"],
  image_skipped: ["image", "warn"],
  image_uploaded: ["image", "neutral"],
  draft_created: ["send", "ok"],
  status_private: ["lock", "neutral"],
  status_failed: ["lock", "warn"],
  tag_unavailable: ["tag", "warn"],
  writeback_done: ["link", "neutral"],
  writeback_forbidden: ["link", "warn"],
  writeback_failed: ["link", "warn"],
  timeline_posted: ["message-square", "neutral"],
  timeline_failed: ["message-square", "warn"],
  done: ["circle-check", "ok"],
  interrupted: ["power", "warn"],
  session_unusable: ["key-round", "warn"],
  temporary_failure: ["triangle-alert", "warn"],
  failed: ["circle-x", "danger"],
  crashed: ["circle-x", "danger"],
  retry_scheduled: ["refresh-cw", "neutral"],
};

const LEVEL_STYLE: Readonly<Record<JobEvent["level"], readonly [IconName, Tone]>> = {
  info: ["circle-dot", "neutral"],
  warn: ["triangle-alert", "warn"],
  error: ["circle-x", "danger"],
};

function paramValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(paramValue).join(", ");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value === null || value === undefined ? "–" : JSON.stringify(value);
}

export function eventItem(event: JobEvent, ctx: ViewContext) {
  const coded = event.code !== null && event.params !== null;
  const text = coded
    ? (jobEventText(ctx.m, event.code!, event.params!) ?? event.message)
    : event.message;
  let [iconName, tone] = coded ? EVENT_STYLE[event.code!] : LEVEL_STYLE[event.level];
  if (event.level === "error") tone = "danger";
  else if (event.level === "warn" && tone !== "danger") tone = "warn";
  const error = coded && typeof event.params!.error === "string" ? event.params!.error : null;
  const params = coded ? Object.entries(event.params!) : [];
  const details: SafeHtml | null =
    coded && params.length > 0
      ? html`<div class="rounded-md bg-subtle px-3 py-2 text-xs">
          ${descriptionList([
            [ctx.t.events.code, html`<code>${event.code}</code>`],
            ...params.map(
              ([key, value]) =>
                [key, html`<span class="font-mono">${paramValue(value)}</span>`] as const,
            ),
          ])}
        </div>`
      : null;
  if (iconName === undefined) [iconName, tone] = LEVEL_STYLE[event.level];
  return { icon: iconName, tone, text, time: html`${timeTag(event.ts, ctx)}`, sub: error, details };
}

export function eventTimeline(events: readonly JobEvent[], ctx: ViewContext): SafeHtml {
  // Newest first, as people read a log they come back to.
  return timeline(
    [...events].reverse().map((event) => eventItem(event, ctx)),
    ctx.t.events.details,
  );
}
