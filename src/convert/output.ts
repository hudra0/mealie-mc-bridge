// Reading the model's answer: the JSON object, with or without a Markdown code fence or a
// stray sentence around it.

export type ParsedOutput =
  { ok: true; value: unknown; text: string } | { ok: false; message: string };

// The JSON text inside an answer: the content of a ```json fence when there is one,
// otherwise everything from the first "{" to the last "}".
export function extractJson(answer: string): string {
  const trimmed = answer.trim();
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
  const inner = (fence?.[1] ?? trimmed).trim();
  if (inner.startsWith("{")) return inner;
  const start = inner.indexOf("{");
  const end = inner.lastIndexOf("}");
  return start >= 0 && end > start ? inner.slice(start, end + 1) : inner;
}

// A text step's title the way the device editor derives it from the description: the
// whole text when it fits, otherwise cut at the last space within maxLength characters.
// Official text steps carry the same text in both fields.
export function textStepTitle(description: string, maxLength: number): string {
  const text = description.trim();
  if (text.length <= maxLength) return text;
  const head = text.slice(0, maxLength + 1);
  const space = head.lastIndexOf(" ");
  const cut = space > maxLength / 2 ? head.slice(0, space) : text.slice(0, maxLength);
  return cut.replace(/[\s,;:–-]+$/u, "");
}

// Sets the title of every text step of a parsed answer from its description, in place, so
// the title follows the official style whatever the model wrote. Anything that is not a
// text step with a description is left for the validator.
export function deriveTextStepTitles(value: unknown, maxLength: number): void {
  if (typeof value !== "object" || value === null) return;
  const steps = (value as { servingSize?: { steps?: unknown } }).servingSize?.steps;
  if (!Array.isArray(steps)) return;
  for (const step of steps as unknown[]) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    const description = record.description;
    if (record.kind !== "text" || typeof description !== "string" || description.trim() === "")
      continue;
    record.title = textStepTitle(description, maxLength);
  }
}

export function parseJsonOutput(answer: string): ParsedOutput {
  const text = extractJson(answer);
  if (text === "")
    return { ok: false, message: "the answer is empty; return the recipe as one JSON object" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown, text };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `the answer is not valid JSON (${reason}); return the recipe as one JSON object`,
    };
  }
}

// Sets the locale of a parsed answer, in place: the converter writes recipes for one
// locale, so the code decides it, not the model.
export function setLocale(value: unknown, locale: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  (value as Record<string, unknown>).locale = locale;
}
