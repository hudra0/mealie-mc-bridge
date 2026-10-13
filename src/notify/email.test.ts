import { createTransport } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../session/manager.js";
import type { Job } from "../store/jobs.js";
import { silentLogger } from "../testing/fakes.js";
import {
  EmailNotifier,
  NullNotifier,
  createNotifier,
  type MailMessage,
  type MailTransport,
} from "./email.js";

const status = (overrides: Partial<SessionStatus> = {}): SessionStatus => ({
  state: "expired",
  checkedAt: "2026-10-13T10:00:00.000Z",
  cookieSetAt: "2026-10-01T10:00:00.000Z",
  cookieAgeHours: 288,
  lastError: "Monsieur Cuisine reported the session as expired",
  ...overrides,
});

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  mealieRecipeId: "00000000-0000-4000-8000-000000000001",
  mealieSlug: "kurbis-linsen-suppe",
  title: "Kürbis-Linsen-Suppe",
  scale: 1,
  servings: 4,
  status: "failed",
  attempts: 2,
  error: "boom",
  mcRecipeId: null,
  mcRecipeUrl: null,
  provider: null,
  model: null,
  usage: null,
  costUsd: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  force: false,
  conversion: null,
  createStartedAt: null,
  ...overrides,
});

function stub(): MailTransport & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    sendMail: vi.fn((message: MailMessage) => {
      sent.push(message);
      return Promise.resolve({});
    }),
  };
}

function notifier(transport: MailTransport = stub()) {
  return new EmailNotifier({
    transport,
    to: "cook@example.com",
    from: "bridge@example.com",
    logger: silentLogger(),
    recipeUrl: (j) => `https://mealie.example.com/g/home/r/${j.mealieSlug ?? ""}`,
  });
}

describe("EmailNotifier", () => {
  it("sends one German mail per session state change", async () => {
    const transport = stub();
    const n = notifier(transport);
    await n.sessionExpired(status());
    await n.sessionExpired(status());
    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail).toMatchObject({ from: "bridge@example.com", to: "cook@example.com" });
    expect(mail.subject).toBe("Monsieur-Cuisine-Bridge: Sitzung abgelaufen");
    expect(mail.text).toContain("Die Monsieur-Cuisine-Sitzung der Bridge ist abgelaufen.");
    expect(mail.text).toContain("/admin");

    await n.sessionExpired(status({ state: "invalid" }));
    expect(transport.sent[1]?.subject).toBe("Monsieur-Cuisine-Bridge: Sitzung ungültig");
    // A new cookie that expires again is a new state change.
    await n.sessionExpired(status({ cookieSetAt: "2026-10-14T10:00:00.000Z" }));
    expect(transport.sent).toHaveLength(3);
  });

  it("says when the session was never checked", async () => {
    const transport = stub();
    await notifier(transport).sessionExpired(
      status({ checkedAt: null, lastError: null, cookieSetAt: null }),
    );
    expect(transport.sent[0]?.text).toContain("Zuletzt geprüft: noch nie");
  });

  it("sends one mail per failed job with a link to the recipe", async () => {
    const transport = stub();
    const n = notifier(transport);
    await n.jobFailed(job(), "The converted recipe failed validation");
    await n.jobFailed(job(), "again");
    await n.jobFailed(job({ id: "job-2", title: null }), "other");
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]?.subject).toBe(
      "Monsieur-Cuisine-Bridge: „Kürbis-Linsen-Suppe“ nicht gesendet",
    );
    expect(transport.sent[0]?.text).toContain("Fehler: The converted recipe failed validation");
    expect(transport.sent[0]?.text).toContain(
      "Rezept in Mealie: https://mealie.example.com/g/home/r/kurbis-linsen-suppe",
    );
    expect(transport.sent[1]?.subject).toContain("kurbis-linsen-suppe");
  });

  it("forgets the oldest job ids after a while", async () => {
    const transport = stub();
    const n = notifier(transport);
    for (let i = 0; i < 501; i++) await n.jobFailed(job({ id: `job-${i}` }), "x");
    await n.jobFailed(job({ id: "job-0" }), "x");
    expect(transport.sent).toHaveLength(502);
  });

  it("reports a failing session check once per message", async () => {
    const transport = stub();
    const n = notifier(transport);
    await n.healthFailed("GET api/v1/users: network error (TypeError ECONNREFUSED)");
    await n.healthFailed("GET api/v1/users: network error (TypeError ECONNREFUSED)");
    await n.healthFailed("other failure");
    expect(transport.sent.map((mail) => mail.subject)).toEqual([
      "Monsieur-Cuisine-Bridge: Sitzungsprüfung fehlgeschlagen",
      "Monsieur-Cuisine-Bridge: Sitzungsprüfung fehlgeschlagen",
    ]);
  });

  it("never puts cookies or tokens into a mail", async () => {
    const transport = stub();
    const n = notifier(transport);
    const leaky =
      "failed: Cookie: wordpress_logged_in_abc=cookie-secret; lidl_sso_id_token=sso-secret Authorization: Bearer bearer-secret token=token-secret /hooks/mealie/hook-secret";
    await n.jobFailed(job({ title: "Suppe wordpress_logged_in_x=title-secret" }), leaky);
    await n.healthFailed(leaky);
    await n.sessionExpired(status({ lastError: leaky }));
    const all = transport.sent.map((mail) => `${mail.subject}\n${mail.text}`).join("\n");
    for (const secret of [
      "cookie-secret",
      "sso-secret",
      "bearer-secret",
      "token-secret",
      "hook-secret",
      "title-secret",
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain("[redacted]");
  });

  it("builds a real message through nodemailer's stream transport", async () => {
    const transport = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    const sendMail = vi.spyOn(transport, "sendMail");
    await notifier(transport).jobFailed(job(), "boom");
    const info = (await sendMail.mock.results[0]?.value) as { message: Buffer };
    const raw = info.message.toString("utf8");
    expect(raw).toContain("To: cook@example.com");
    expect(raw).toMatch(/Subject: =\?UTF-8\?/);
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
  });

  it("logs and swallows a failing mail server", async () => {
    const warn = vi.fn();
    const n = new EmailNotifier({
      transport: { sendMail: () => Promise.reject(new Error("connection refused")) },
      to: "cook@example.com",
      from: "bridge@example.com",
      logger: { ...silentLogger(), warn },
    });
    await expect(n.healthFailed("x")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ err: "connection refused" }, "notification failed");
  });
});

describe("createNotifier", () => {
  it("returns a NullNotifier without SMTP_URL or NOTIFY_EMAIL", async () => {
    const none = createNotifier({}, silentLogger());
    expect(none).toBeInstanceOf(NullNotifier);
    await expect(none.sessionExpired(status())).resolves.toBeUndefined();
    await expect(none.jobFailed(job(), "x")).resolves.toBeUndefined();
    await expect(none.healthFailed("x")).resolves.toBeUndefined();
    expect(createNotifier({ SMTP_URL: "smtp://mail.example.com" }, silentLogger())).toBeInstanceOf(
      NullNotifier,
    );
  });

  it("returns an EmailNotifier with the sender defaulting to the recipient", async () => {
    const transport = stub();
    const n = createNotifier(
      { SMTP_URL: "smtp://mail.example.com:587", NOTIFY_EMAIL: "cook@example.com" },
      silentLogger(),
      { transport },
    );
    expect(n).toBeInstanceOf(EmailNotifier);
    await n.healthFailed("x");
    expect(transport.sent[0]?.from).toBe("cook@example.com");
  });

  it("creates an SMTP transport from the URL without connecting", () => {
    const n = createNotifier(
      {
        SMTP_URL: "smtps://user:pass@mail.example.com:465",
        NOTIFY_EMAIL: "cook@example.com",
        SMTP_FROM: "Bridge <bridge@example.com>",
      },
      silentLogger(),
      { recipeUrl: () => null },
    );
    expect(n).toBeInstanceOf(EmailNotifier);
  });
});
