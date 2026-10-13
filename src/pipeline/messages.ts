// The texts the bridge writes into the Mealie timeline, from the message catalog of
// UI_LANGUAGE (src/i18n). Subjects are plain text; messages are Markdown. Text that comes
// from the converter or from an error is escaped, so it cannot add links or markup.

import { escapeMarkdown, formatDate } from "../i18n/format.js";
import { messages, type TimelineMessages, type UiLanguage } from "../i18n/index.js";

export { escapeMarkdown };
export type { CreatedText, FailureStage, UiLanguage } from "../i18n/index.js";
export type TimelineTexts = TimelineMessages;

export function timelineTexts(language: UiLanguage): TimelineTexts {
  return messages(language).timeline;
}

export function formatDateTime(iso: string, language: UiLanguage = "de"): string {
  return formatDate(iso, messages(language).intlLocale);
}
