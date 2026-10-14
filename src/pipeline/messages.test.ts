import { describe, expect, it } from "vitest";
import { escapeMarkdown, timelineTexts } from "./messages.js";

const de = timelineTexts("de");

describe("timeline texts", () => {
  it("escapes converter text so it cannot add links or markup", () => {
    const message = de.created({
      url: "https://www.monsieur-cuisine.com/de/create-recipe?recipe-id=1",
      servings: 2,
      status: "draft",
      statusFailed: false,
      provider: "x",
      model: "y",
      reviewHints: ["[klick](https://evil.example.com) <b>fett</b>\nzweite Zeile"],
      imageSkipped: false,
    });
    expect(message).toContain(
      "- \\[klick\\](https://evil.example.com) \\<b\\>fett\\</b\\> zweite Zeile",
    );
    expect(message).not.toContain("**Bitte prüfen:**\n\n");
  });

  it("leaves out the review section without hints", () => {
    const message = de.created({
      url: "https://example.com",
      servings: 2,
      status: "private-publish",
      statusFailed: false,
      provider: "x",
      model: "y",
      reviewHints: [],
      imageSkipped: false,
    });
    expect(message).not.toContain("Bitte prüfen");
  });

  it("keeps failure details short and on one line", () => {
    const message = de.failed({ stage: "convert", detail: `${"x".repeat(1000)}\n    at stack` });
    const first = message.split("\n")[0] ?? "";
    expect(first.startsWith("Umwandlung fehlgeschlagen: ")).toBe(true);
    expect(first.length).toBeLessThan(450);
  });

  it("formats the date of an unchanged recipe in German", () => {
    expect(
      de.unchanged({
        sentAt: "2026-10-13T08:05:00.000Z",
        url: "https://example.com",
        status: "draft",
      }),
    ).toMatch(
      /^Unverändert, bereits gesendet am 13\.10\.2026, \d{2}:\d{2}: \[Entwurf öffnen\]\(https:\/\/example\.com\)$/,
    );
  });

  it("says draft only for a draft and saved for a private recipe", () => {
    const en = timelineTexts("en");
    expect(de.createdSubject("private-publish")).toBe(
      "Monsieur Cuisine: Rezept privat gespeichert",
    );
    expect(de.createdSubject("draft")).toBe("Monsieur Cuisine: Entwurf erstellt");
    expect(en.createdSubject("private-publish")).toBe(
      "Monsieur Cuisine: recipe saved to the device",
    );
    expect(en.createdSubject("draft")).toBe("Monsieur Cuisine: draft created");
    const sent = { sentAt: "2026-10-13T08:05:00.000Z", url: "https://example.com" };
    expect(de.unchanged({ ...sent, status: "private-publish" })).toContain("[Rezept öffnen]");
    expect(de.unchanged({ ...sent, status: "private-publish" })).not.toContain("Entwurf");
    expect(en.unchanged({ ...sent, status: "private-publish" })).toContain("[Open the recipe]");
    expect(en.unchanged({ ...sent, status: "draft" })).toContain("[Open the draft]");
  });

  it("escapes Markdown characters", () => {
    expect(escapeMarkdown("a*b_c`d#e|f!g\\h")).toBe("a\\*b\\_c\\`d\\#e\\|f\\!g\\\\h");
  });
});
