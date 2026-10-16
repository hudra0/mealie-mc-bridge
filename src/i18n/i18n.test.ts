import { describe, expect, it } from "vitest";
import {
  MAIL_ERROR_CODES,
  MAIL_EVENTS,
  MAIL_SECURITY,
  MAX_RECIPIENTS,
} from "../notify/mail-settings.js";
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
  servingUnit: "Portionen",
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
      expect(catalog.admin.settings.lidl.facts).toHaveLength(
        CATALOGS.de.admin.settings.lidl.facts.length,
      );
      expect(Object.keys(catalog.admin.notices).sort()).toEqual(
        Object.keys(CATALOGS.de.admin.notices).sort(),
      );
      for (const stage of FAILURE_STAGES) {
        expect(catalog.timeline.failureReasons[stage], `${language} ${stage}`).toBeTruthy();
      }
    }
  });

  it("explain every problem of the mail form and name the recipient limit", () => {
    for (const language of UI_LANGUAGES) {
      const notify = CATALOGS[language].admin.settings.notify;
      expect(Object.keys(notify.errors).sort(), language).toEqual([...MAIL_ERROR_CODES].sort());
      for (const code of MAIL_ERROR_CODES) expect(notify.errors[code], code).toBeTruthy();
      expect(notify.errors.to_too_many).toContain(String(MAX_RECIPIENTS));
      expect(notify.toHint).toContain(String(MAX_RECIPIENTS));
      expect(Object.keys(notify.securityNames).sort()).toEqual([...MAIL_SECURITY].sort());
      expect(Object.keys(notify.eventNames).sort()).toEqual([...MAIL_EVENTS].sort());
    }
  });

  it("keep the page texts short and free of dashes as punctuation", () => {
    const strings = (value: unknown, path = ""): Array<[string, string]> => {
      if (typeof value === "string") return [[path, value]];
      if (Array.isArray(value))
        return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
      if (value !== null && typeof value === "object") {
        return Object.entries(value).flatMap(([key, child]) =>
          strings(child, path ? `${path}.${key}` : key),
        );
      }
      return [];
    };
    for (const language of UI_LANGUAGES) {
      for (const [path, text] of strings(CATALOGS[language].admin)) {
        expect(text, `${language} ${path}`).not.toMatch(/—|\s–\s/);
        // About two lines of a card at most.
        expect(text.length, `${language} ${path}`).toBeLessThanOrEqual(220);
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
      expect(admin.errors.testMailFailed("nope")).toContain("nope");
      expect(admin.errors.credentialsInvalid("email")).not.toBe(
        admin.errors.credentialsInvalid("password"),
      );
      expect(admin.login.tooMany(1)).toContain("1");
      expect(admin.mealieTimeout(4)).toContain("4");
      expect(admin.shell.signedIn("cook")).toContain("cook");
      expect(admin.jobs.recipeLink(7, "draft")).toContain("7");
      expect(admin.jobs.recipeLink(7, "draft")).not.toBe(
        admin.jobs.recipeLink(7, "private-publish"),
      );
      expect(admin.jobs.scale("2")).toContain("2");
      expect(admin.jobs.servings(10, "Scheiben")).toBe("10 Scheiben");
      expect(admin.jobs.servings(4, null)).toMatch(/^4 \S/);
      expect(admin.jobs.range(1, 50)).toContain("50");
      expect(admin.settings.mc.ageValue(2, "login")).toMatch(/^2 h /);
      expect(admin.settings.mc.ageValue(330, "stored")).toMatch(/^13[.,]8 /);
      expect(admin.dashboard.health.asUser("cook")).toContain("cook");
      expect(admin.dashboard.health.checked(true)).not.toBe(admin.dashboard.health.checked(false));
      expect(admin.dashboard.kpi.sentHint(5, 2)).toMatch(/5.*2/);
      expect(admin.dashboard.kpi.failed(3)).toContain("3");
      expect(admin.dashboard.kpi.costToday("$1", "$10")).toMatch(/\$1.*\$10/);
      expect(admin.dashboard.kpi.costTodayNoLimit("$1")).toContain("$1");
      expect(admin.dashboard.setup.progress(3, 5)).toMatch(/3.*5/);
      expect(admin.jobDetail.openEditor("draft")).not.toBe(
        admin.jobDetail.openEditor("private-publish"),
      );
      expect(admin.jobDetail.tokenCounts("100", "20", "50")).toContain("20");
      expect(admin.jobDetail.tokenCounts("100", null, "50")).not.toContain("(");
      expect(admin.jobDetail.resolutionOff(3)).toContain("3");
      expect(admin.jobDetail.resolution(7, 0, 2, 1, 2)).toContain("7");
      expect(admin.jobDetail.resolution(7, 3, 2, 1, 2)).toContain("3");
      expect(admin.jobDetail.resolution(7, 0, 2, 1, 2)).not.toContain("(");
      expect(admin.jobDetail.ingredientCounts(4, 5)).toMatch(/4.*5/);
      expect(admin.steps.speed(3)).toContain("3");
      expect(admin.steps.servings(4, "Portionen")).toBe("4 Portionen");
      expect(admin.steps.preparation(10)).toContain("10");
      expect(admin.steps.ready(35)).toContain("35");
      expect(admin.dryRun.tokenCounts(1, 2)).toContain("2");
      expect(admin.dryRun.droppedIds("9")).toContain("9");
      expect(admin.dryRun.errors(2)).toContain("2");
      expect(admin.dryRun.errors(1)).toContain("1");
      expect(admin.settings.lidl.consentSteps(2)).toContain("2");
      expect(admin.settings.lidl.browserMissing("x")).toContain("x");
      expect(admin.settings.lidl.browserUsed(null, "window")).toBeTruthy();
      expect(admin.settings.ai.tokens("1", "2")).toMatch(/1.*2/);
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
