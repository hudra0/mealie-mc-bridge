// A job error as people read it: a short summary in the language of the pages, derived
// from the stage of the failure event or, for older jobs, from the kind of error; the raw
// English text of the error stays available in a collapsed details element.

import { FAILURE_STAGES, type AdminMessages, type FailureStage } from "../../i18n/index.js";
import type { JobStatus } from "../../store/jobs.js";
import { html, type SafeHtml } from "../html.js";

// What the raw text of an error says about its kind, first match wins. The texts are the
// messages of the bridge's own error classes and of the Mealie client.
const KINDS: ReadonlyArray<readonly [RegExp, keyof Omit<AdminMessages["failures"], "stages">]> = [
  [/failed validation|still has \d+ errors? after/i, "limits"],
  [/converter not configured|is not set\. Put the key into/i, "converterMissing"],
  [/model refused the request/i, "modelRefused"],
  [/Interrupted while the draft was being created/i, "interrupted"],
  [/^Mealie \S+ .*no response from Mealie/i, "mealieUnreachable"],
  [/^Mealie /, "mealieRefused"],
];

function isStage(value: unknown): value is FailureStage {
  return typeof value === "string" && (FAILURE_STAGES as readonly string[]).includes(value);
}

export function failureSummary(
  error: string | null,
  options: { status?: JobStatus; stage?: string | null },
  t: AdminMessages,
): string {
  const f = t.failures;
  if (options.status === "session_expired") return f.session;
  const text = error ?? "";
  const kind = KINDS.find(([pattern]) => pattern.test(text))?.[1];
  if (kind) return f[kind];
  if (isStage(options.stage)) return f.stages[options.stage];
  return f.generic;
}

// The raw error text, collapsed.
export function failureDetails(error: string, t: AdminMessages): SafeHtml {
  return html`<details class="mt-1">
    <summary class="text-xs text-fg-muted hover:text-fg">${t.failures.details}</summary>
    <p class="mt-1 font-mono text-xs text-fg-muted [overflow-wrap:anywhere]">${error}</p>
  </details>`;
}
