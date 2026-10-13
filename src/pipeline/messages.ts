// The texts the bridge writes into the Mealie timeline, per TIMELINE_LANGUAGE. Subjects
// are plain text; messages are Markdown. Text that comes from the converter or from an
// error is escaped, so it cannot add links or markup.

export type TimelineLanguage = "de";

export type FailureStage =
  "load" | "prepare" | "categories" | "convert" | "validate" | "upload" | "unexpected";

export interface CreatedText {
  url: string;
  servings: number;
  status: "draft" | "private-publish";
  // The status change to private-publish failed; the recipe stayed a draft.
  statusFailed: boolean;
  provider: string;
  model: string;
  reviewHints: readonly string[];
  imageSkipped: boolean;
}

export interface TimelineTexts {
  createdSubject: string;
  created(text: CreatedText): string;
  unchangedSubject: string;
  unchanged(text: { sentAt: string; url: string }): string;
  failedSubject(stage: FailureStage): string;
  failed(text: { stage: FailureStage; detail: string }): string;
  sessionSubject: string;
  session(): string;
}

const MAX_DETAIL = 400;

const de: TimelineTexts = {
  createdSubject: "Monsieur Cuisine: Entwurf erstellt",
  created(text) {
    const status =
      text.status === "draft"
        ? "Entwurf, am Gerät erst nach „Nur auf meinem Gerät speichern“ im Editor sichtbar"
        : text.statusFailed
          ? "Entwurf; das private Speichern ist fehlgeschlagen, bitte im Editor „Nur auf meinem Gerät speichern“ wählen"
          : "Privat gespeichert, nur auf deinem Gerät sichtbar";
    const lines = [
      `Das Rezept liegt in deinem Monsieur-Cuisine-Konto: [Im Editor öffnen](${text.url})`,
      "",
      `- Portionen: ${text.servings}`,
      `- Status: ${status}`,
      `- Umgewandelt mit: ${escapeMarkdown(text.provider)}, ${escapeMarkdown(text.model)}`,
    ];
    if (text.imageSkipped) lines.push("- Bild: nicht übernommen, bitte im Editor ergänzen");
    if (text.reviewHints.length > 0) {
      lines.push(
        "",
        "**Bitte prüfen:**",
        ...text.reviewHints.map((hint) => `- ${escapeMarkdown(hint)}`),
      );
    }
    lines.push(
      "",
      "Die Schritte hat ein Sprachmodell erstellt. Prüfe Mengen, Garzeiten und Temperaturen im Editor, bevor du mit dem Rezept kochst.",
    );
    return lines.join("\n");
  },
  unchangedSubject: "Monsieur Cuisine: unverändert",
  unchanged(text) {
    return `Unverändert, bereits gesendet am ${formatDateTime(text.sentAt)}: [Entwurf öffnen](${text.url})`;
  },
  failedSubject(stage) {
    return `Monsieur Cuisine: Fehler – ${FAILURE_REASONS_DE[stage]}`;
  },
  failed(text) {
    return [
      `${FAILURE_REASONS_DE[text.stage]}: ${escapeMarkdown(shorten(text.detail, MAX_DETAIL))}`,
      "",
      "Details stehen auf der Admin-Seite der Bridge. Dort lässt sich der Auftrag erneut starten.",
    ].join("\n");
  },
  sessionSubject: "Monsieur Cuisine: Sitzung abgelaufen",
  session() {
    return "Die Bridge ist gerade nicht bei Monsieur Cuisine angemeldet. Der Auftrag wartet und läuft automatisch weiter, sobald auf der Admin-Seite eine neue Sitzung hinterlegt ist.";
  },
};

const FAILURE_REASONS_DE: Readonly<Record<FailureStage, string>> = {
  load: "Rezept nicht lesbar",
  prepare: "Aufbereitung fehlgeschlagen",
  categories: "Kategorien nicht verfügbar",
  convert: "Umwandlung fehlgeschlagen",
  validate: "Prüfung nicht bestanden",
  upload: "Hochladen fehlgeschlagen",
  unexpected: "Unerwarteter Fehler",
};

export const TIMELINE_TEXTS: Readonly<Record<TimelineLanguage, TimelineTexts>> = { de };

export function timelineTexts(language: TimelineLanguage): TimelineTexts {
  return TIMELINE_TEXTS[language];
}

// Backslash-escapes the characters that start Markdown links, emphasis, code, headings or
// HTML, and folds the text onto one line.
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#|!]/g, (char) => `\\${char}`);
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}
