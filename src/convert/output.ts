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
