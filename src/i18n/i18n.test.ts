import { describe, expect, it } from "vitest";
import { escapeMarkdown, formatDate, shorten } from "./format.js";
import {
  CATALOGS,
  FAILURE_STAGES,
  UI_LANGUAGES,
  defaultUiLanguage,
  formatDateTime,
  isUiLanguage,
  messages,
  type CreatedText,
} from "./index.js";

// The key paths of a catalog; functions count as leaves.
function keys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

const created: CreatedText = {
  url: "https://www.monsieur-cuisine.com/x",
  servings: 4,
  status: "private-publish",
  statusFailed: false,
  provider: "openai",
  model: "gpt_x",
  reviewHints: ["check *this*"],
  imageSkipped: true,
};

describe("message catalogs", () => {
  it("have the same keys in every language", () => {
    const reference = keys(CATALOGS.de).sort();
    for (const language of UI_LANGUAGES) {
      expect(keys(CATALOGS[language]).sort(), language).toEqual(reference);
    }
  });

  it("have the same list lengths and notices in every language", () => {
    for (const language of UI_LANGUAGES) {
      const catalog = messages(language);
      expect(catalog.language).toBe(language);
      expect(catalog.email.sessionNextSteps).toHaveLength(
        CATALOGS.de.email.sessionNextSteps.length,
      );
      expect(Object.keys(catalog.admin.notices).sort()).toEqual(
        Object.keys(CATALOGS.de.admin.notices).sort(),
      );
      for (const stage of FAILURE_STAGES) {
        expect(catalog.timeline.failureReasons[stage], `${language} ${stage}`).toBeTruthy();
      }
    }
  });

  it("pick the UI language from the output locale", () => {
    expect(defaultUiLanguage("de-DE")).toBe("de");
    expect(defaultUiLanguage("en-US")).toBe("en");
    expect(defaultUiLanguage("fr-FR")).toBe("en");
    expect(isUiLanguage("de")).toBe(true);
    expect(isUiLanguage("fr")).toBe(false);
  });

  it("write the timeline in each language and escape what comes from outside", () => {
    for (const language of UI_LANGUAGES) {
      const t = messages(language).timeline;
      const text = t.created(created);
      expect(text).toContain("](https://www.monsieur-cuisine.com/x)");
      expect(text).toContain("gpt\\_x");
      expect(text).toContain("check \\*this\\*");
      expect(t.failed({ stage: "convert", detail: "x".repeat(500) })).toContain("x...");
      expect(
        t.unchanged({ sentAt: "2026-10-13T12:00:00.000Z", url: "u", status: "draft" }),
      ).toContain("(u)");
      for (const status of ["draft", "private-publish"] as const) {
        expect(
          t.created({ ...created, status, statusFailed: true, reviewHints: [] }),
        ).not.toContain("**");
      }
    }
    expect(messages("en").timeline.failedSubject("upload")).toBe(
      "Monsieur Cuisine: error – upload failed",
    );
    expect(messages("de").timeline.failedSubject("upload")).toBe(
      "Monsieur Cuisine: Fehler – Hochladen fehlgeschlagen",
    );
  });

  it("format mails and admin texts in each language", () => {
    for (const language of UI_LANGUAGES) {
      const { email, admin } = messages(language);
      expect(email.jobFailedSubject("Soup")).toContain("Soup");
      expect(email.jobFailedLead("Soup")).toContain("Soup");
      expect(email.lastChecked("now")).toContain("now");
      expect(email.lastMessage("m")).toContain("m");
      expect(email.error("e")).toContain("e");
      expect(email.job("j1")).toContain("j1");
      expect(email.attempts(3)).toContain("3");
      expect(email.recipeInMealie("https://x")).toContain("https://x");
      expect(admin.errors.cookieRejected("nope")).toContain("nope");
      expect(admin.errors.cookieUnchecked("nope")).toContain("nope");
      expect(admin.errors.recipeNotLoaded("nope")).toContain("nope");
      expect(admin.errors.conversionFailed("nope")).toContain("nope");
      expect(admin.jobsTable.recipeLink(7, "draft")).toContain("7");
      expect(admin.dashboard.hours(2)).toBe("2 h");
      expect(admin.dashboard.lastWorkerError("t")).toContain("t");
      expect(admin.dashboard.cookieLabel).toContain("`Cookie`");
      expect(admin.jobDetail.openRecipe(7, "private-publish")).toContain("7");
      expect(admin.jobDetail.servings(4)).toContain("4");
      expect(admin.jobDetail.tokens(100, 20, 50)).toContain("20");
      expect(admin.jobDetail.tokens(100, null, 50)).not.toContain("(");
      expect(admin.jobDetail.resolutionOff(3)).toContain("3");
      expect(admin.jobDetail.resolution(7, 0, 2, 1, 2)).toContain("7");
      expect(admin.jobDetail.resolution(7, 3, 2, 1, 2)).toContain("3");
      expect(admin.jobDetail.resolution(7, 0, 2, 1, 2)).not.toContain("(");
      expect(admin.dryRun.sentAt("t")).toContain("t");
      expect(admin.dryRun.attempts(1)).toContain("1");
      expect(admin.dryRun.attempts(2)).toContain("2");
      expect(admin.dryRun.tokens(1, 2)).toContain("2");
      expect(admin.dryRun.timesValue(10, 30)).toContain("30");
      expect(admin.dryRun.droppedIds("9")).toContain("9");
      expect(admin.dryRun.errors(2)).toContain("2");
    }
  });
});

describe("format helpers", () => {
  it("escapes Markdown, shortens lines and formats dates per catalog", () => {
    expect(escapeMarkdown("a  [b](c)\n*d*")).toBe("a \\[b\\](c) \\*d\\*");
    expect(shorten("  one   two  ", 3)).toBe("one...");
    expect(shorten("short", 10)).toBe("short");
    const iso = "2026-10-13T12:00:00.000Z";
    expect(formatDateTime(iso, messages("de"))).toBe(formatDate(iso, "de-DE"));
    expect(formatDateTime(iso, messages("en"))).toBe(formatDate(iso, "en-US"));
    expect(formatDate(iso, "en-US")).toMatch(/2026/);
  });
});
