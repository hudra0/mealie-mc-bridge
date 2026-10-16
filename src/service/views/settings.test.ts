import { describe, expect, it } from "vitest";
import { messages } from "../../i18n/index.js";
import { ALL_EVENTS } from "../../notify/mail-settings.js";
import type { MailStatus } from "../../notify/mailer.js";
import type { ViewContext } from "./context.js";
import { settingsView, type NotifyViewData, type SettingsViewData } from "./settings.js";

const catalog = messages("de");
const ctx: ViewContext = {
  m: catalog,
  t: catalog.admin,
  now: new Date("2026-10-16T10:00:00.000Z"),
  timeZone: "UTC",
  csrf: "form-token",
};

function page(notify: NotifyViewData | null): string {
  const data: SettingsViewData = {
    tab: "notify",
    session: {
      state: "valid",
      checkedAt: null,
      cookieSetAt: null,
      cookieExpiresAt: null,
      cookieIssuedAt: null,
      cookieAgeHours: null,
      cookieAgeFrom: null,
      lastError: null,
    },
    autoLogin: null,
    config: null,
    locale: { mcLocale: "de-DE", verified: true, uiLanguage: "de", recipeStatus: "draft" },
    mealie: {
      url: null,
      check: { state: "unchecked", error: null, checkedAt: null, user: null },
      webhook: null,
    },
    ai: null,
    limits: { jobs: 0, costUsd: 0 },
    usage: {
      month: {
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        avgDurationMs: null,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      today: { jobs: 0, costUsd: 0 },
    },
    notify,
    system: { version: "0.0.0", uptimeMs: 0, dataDir: null },
  };
  return settingsView(data, ctx).toString();
}

const off: MailStatus = { source: "off", summary: null, unreadable: false };

describe("notifications tab", () => {
  it("offers an empty form with STARTTLS on port 587 and every mail switched on", () => {
    const body = page({ status: off, form: null });
    expect(body).toContain("Trage hier einen Mailserver ein");
    expect(body).toMatch(/name="port"\s+value="587"/);
    expect(body).toMatch(/<option value="starttls"\s+selected/);
    expect(body.match(/name="event_\w+"\s+value="1"\s+checked/g)).toHaveLength(3);
    expect(body).not.toContain('action="/admin/settings/notify/test"');
    expect(body).not.toContain('action="/admin/settings/notify/delete"');
    expect(body).toContain('name="_csrf" value="form-token"');
  });

  it("warns about stored settings it cannot read and offers to delete them", () => {
    const body = page({ status: { ...off, unreadable: true }, form: null });
    expect(body).toContain("lassen sich nicht lesen");
    expect(body).toContain('action="/admin/settings/notify/delete"');
  });

  it("marks unencrypted sending and lists only the mails that are on", () => {
    const body = page({
      status: {
        source: "ui",
        unreadable: false,
        summary: {
          host: "relay.example.com",
          port: 25,
          security: "none",
          allowInsecure: true,
          username: null,
          passwordSet: false,
          from: "cook@example.com",
          configuredFrom: "",
          to: ["cook@example.com"],
          events: { ...ALL_EVENTS, health: false },
        },
      },
      form: null,
    });
    expect(body).toContain("relay.example.com:25");
    expect(body).toContain("unverschlüsselt erlaubt");
    expect(body).toContain("<li>Auftrag endgültig fehlgeschlagen</li>");
    expect(body).not.toContain("<li>Sitzungsprüfung scheitert</li>");
    expect(body).toMatch(/name="from"\s+value=""/);
    expect(body).toMatch(/name="allow_insecure"\s+value="1"\s+checked/);
    expect(body).toMatch(/name="password"\s+value=""\s+autocomplete="new-password"/);
    expect(body).toContain('placeholder=""');
  });

  it("escapes what was typed into the form", () => {
    const evil = `"><script>alert(1)</script>`;
    const body = page({
      status: off,
      form: {
        values: {
          host: evil,
          port: evil,
          security: evil,
          allowInsecure: false,
          username: evil,
          from: evil,
          to: evil,
          events: ALL_EVENTS,
        },
        errors: { host: "host_invalid", to: "to_invalid" },
      },
    });
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("Nur Host-Name oder IP-Adresse");
  });

  it("says when the service runs without mail settings", () => {
    expect(page(null)).toContain("Mail-Einstellungen sind in dieser Installation nicht verfügbar.");
  });
});
