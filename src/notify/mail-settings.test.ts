import { afterEach, describe, expect, it } from "vitest";
import { tempStore, type TempStore } from "../testing/temp.js";
import {
  ALL_EVENTS,
  MAIL_SETTINGS_KEY,
  MAIL_TIMEOUTS,
  MAX_RECIPIENTS,
  envMail,
  parseMailForm,
  readMailSettings,
  settingsTransportOptions,
  smtpTransportOptions,
  storedMail,
  summaryValues,
  writeMailSettings,
  type MailSettings,
} from "./mail-settings.js";

const MARKER = "MARKER-PASSWORD-SMTP-31";

const valid = {
  host: "mail.example.com",
  port: "587",
  security: "starttls",
  username: "bridge@example.com",
  password: MARKER,
  from: "Bridge <bridge@example.com>",
  to: "cook@example.com, other@example.com",
  event_session: "1",
  event_job: "1",
  event_health: "1",
};

const settings = (overrides: Partial<MailSettings> = {}): MailSettings => ({
  host: "mail.example.com",
  port: 587,
  security: "starttls",
  allowInsecure: false,
  username: "bridge@example.com",
  password: MARKER,
  from: "",
  to: ["cook@example.com"],
  events: ALL_EVENTS,
  ...overrides,
});

describe("parseMailForm", () => {
  it("accepts a complete form", () => {
    const result = parseMailForm(valid, null);
    expect(result).toEqual({
      ok: true,
      settings: {
        host: "mail.example.com",
        port: 587,
        security: "starttls",
        allowInsecure: false,
        username: "bridge@example.com",
        password: MARKER,
        from: "Bridge <bridge@example.com>",
        to: ["cook@example.com", "other@example.com"],
        events: { session: true, job: true, health: true },
      },
    });
  });

  it("names every invalid field and never hands the password back", () => {
    const result = parseMailForm(
      {
        host: "mail example.com",
        port: "70000",
        security: "rot13",
        username: "a\u0000b",
        password: MARKER,
        from: "not an address",
        to: "cook@example.com, nope",
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      host: "host_invalid",
      port: "port_invalid",
      security: "security_invalid",
      username: "username_invalid",
      from: "from_invalid",
      to: "to_invalid",
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(result.values).toMatchObject({ host: "mail example.com", port: "70000" });
  });

  it("needs a host, a port in range, a recipient and a password for a user name", () => {
    const result = parseMailForm(
      { host: " ", port: "0", security: "tls", username: "bridge", password: "", to: " , " },
      null,
    );
    expect(result.ok ? null : result.errors).toEqual({
      host: "host_required",
      port: "port_invalid",
      password: "password_required",
      to: "to_required",
    });
    for (const port of ["", "1.5", "-1", "65536", "abc"]) {
      const answer = parseMailForm({ ...valid, port }, null);
      expect(answer.ok ? null : answer.errors.port, port).toBe("port_invalid");
    }
    for (const port of ["1", "25", "465", "65535"]) {
      expect(parseMailForm({ ...valid, port }, null).ok, port).toBe(true);
    }
  });

  it("accepts host names, IPv4 and IPv6 addresses", () => {
    for (const host of ["localhost", "mail.example.com", "192.0.2.10", "2001:db8::1"]) {
      expect(parseMailForm({ ...valid, host }, null).ok, host).toBe(true);
    }
    for (const host of ["smtp://mail.example.com", "mail.example.com:587", "-mail.example.com"]) {
      const result = parseMailForm({ ...valid, host }, null);
      expect(result.ok ? null : result.errors.host, host).toBe("host_invalid");
    }
  });

  it("allows no encryption only with the explicit checkbox", () => {
    const refused = parseMailForm({ ...valid, security: "none" }, null);
    expect(refused.ok ? null : refused.errors).toEqual({ security: "security_insecure" });
    const allowed = parseMailForm({ ...valid, security: "none", allow_insecure: "1" }, null);
    expect(allowed.ok && allowed.settings).toMatchObject({
      security: "none",
      allowInsecure: true,
    });
  });

  it("keeps the stored password when the field is empty, for the same host and user", () => {
    const previous = settings();
    const kept = parseMailForm({ ...valid, password: "", port: "2525" }, previous);
    expect(kept.ok && kept.settings).toMatchObject({ password: MARKER, port: 2525 });
    const replaced = parseMailForm({ ...valid, password: "new-secret" }, previous);
    expect(replaced.ok && replaced.settings.password).toBe("new-secret");
    // A stored password never goes to a server or account it was not typed for.
    for (const change of [{ host: "other.example.com" }, { username: "someone@example.com" }]) {
      const result = parseMailForm({ ...valid, ...change, password: "" }, previous);
      expect(result.ok ? null : result.errors, JSON.stringify(change)).toEqual({
        password: "password_reenter",
      });
    }
    expect(parseMailForm({ ...valid, host: "MAIL.example.com", password: "" }, previous).ok).toBe(
      true,
    );
  });

  it("sends without login when the user name is empty, and drops the password then", () => {
    const result = parseMailForm({ ...valid, username: "", password: "" }, settings());
    expect(result.ok && result.settings).toMatchObject({ username: "", password: "" });
  });

  it("checks the sender and every recipient, and caps the recipients", () => {
    for (const from of ["", "bridge@example.com", "Mealie Bridge <bridge@example.com>"]) {
      expect(parseMailForm({ ...valid, from }, null).ok, from).toBe(true);
    }
    for (const from of ["bridge", "Bridge <nope>", "a@example.com\r\nBcc: x@example.com"]) {
      const result = parseMailForm({ ...valid, from }, null);
      expect(result.ok ? null : result.errors.from, from).toBe("from_invalid");
    }
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `c${i}@example.com`);
    const tooMany = parseMailForm({ ...valid, to: many.join(",") }, null);
    expect(tooMany.ok ? null : tooMany.errors.to).toBe("to_too_many");
    const list = parseMailForm(
      { ...valid, to: "a@example.com;\nB@example.com, a@example.com" },
      null,
    );
    expect(list.ok && list.settings.to).toEqual(["a@example.com", "B@example.com"]);
  });

  it("reads the notification types from the checkboxes", () => {
    const result = parseMailForm(
      { ...valid, event_session: undefined, event_job: "1", event_health: undefined },
      null,
    );
    expect(result.ok && result.settings.events).toEqual({
      session: false,
      job: true,
      health: false,
    });
  });

  it("ignores values that are not strings", () => {
    const result = parseMailForm({ ...valid, host: ["a", "b"], to: { x: 1 } }, null);
    expect(result.ok ? null : result.errors).toMatchObject({
      host: "host_required",
      to: "to_required",
    });
  });
});

describe("stored mail settings", () => {
  let store: TempStore | null = null;
  afterEach(() => {
    store?.dispose();
    store = null;
  });

  it("round-trips encrypted, with no field readable in the database", () => {
    store = tempStore();
    expect(readMailSettings(store.settings)).toBeNull();
    writeMailSettings(store.settings, settings());
    const raw = store.settings.get(MAIL_SETTINGS_KEY) ?? "";
    expect(raw).toMatch(/^v1:/);
    for (const plain of [MARKER, "bridge@example.com", "mail.example.com", "cook@example.com"]) {
      expect(raw).not.toContain(plain);
    }
    expect(readMailSettings(store.settings)).toEqual(settings());
  });

  it("refuses settings stored under another key or in another shape", () => {
    store = tempStore();
    writeMailSettings(store.settings, settings());
    const other = tempStore({ key: Buffer.alloc(32, 2) });
    try {
      other.settings.set(MAIL_SETTINGS_KEY, store.settings.get(MAIL_SETTINGS_KEY) ?? "");
      expect(() => readMailSettings(other.settings)).toThrow(/SETTINGS_KEY differs/);
    } finally {
      other.dispose();
    }
    store.settings.setSecret(MAIL_SETTINGS_KEY, JSON.stringify({ host: 1 }));
    expect(() => readMailSettings(store!.settings)).toThrow(/not valid/);
    store.settings.setSecret(MAIL_SETTINGS_KEY, "{");
    expect(() => readMailSettings(store!.settings)).toThrow(/not valid/);
  });
});

describe("transport options", () => {
  it("requires STARTTLS on smtp:// unless SMTP_ALLOW_INSECURE is set", () => {
    expect(smtpTransportOptions("smtp://user:pw@mail.example.com:587")).toEqual({
      url: "smtp://user:pw@mail.example.com:587",
      requireTLS: true,
      ...MAIL_TIMEOUTS,
    });
    expect(smtpTransportOptions("smtp://mail.example.com:25", true).requireTLS).toBe(false);
    expect(smtpTransportOptions("smtps://user:pw@mail.example.com:465").requireTLS).toBe(false);
  });

  it("mirrors the environment for the stored settings", () => {
    expect(settingsTransportOptions(settings())).toEqual({
      host: "mail.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      auth: { user: "bridge@example.com", pass: MARKER },
      ...MAIL_TIMEOUTS,
    });
    expect(
      settingsTransportOptions(settings({ security: "starttls", allowInsecure: true })),
    ).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: false });
    expect(settingsTransportOptions(settings({ security: "tls", port: 465 }))).toMatchObject({
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    });
    expect(
      settingsTransportOptions(settings({ security: "none", allowInsecure: true, port: 25 })),
    ).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
    expect(settingsTransportOptions(settings({ username: "", password: "" }))).not.toHaveProperty(
      "auth",
    );
  });

  it("gives up on a silent server within seconds, not minutes", () => {
    expect(MAIL_TIMEOUTS.connectionTimeout).toBeLessThanOrEqual(30_000);
    expect(MAIL_TIMEOUTS.greetingTimeout).toBeLessThanOrEqual(30_000);
    expect(MAIL_TIMEOUTS.socketTimeout).toBeLessThanOrEqual(120_000);
  });
});

describe("effective mail setup", () => {
  it("reads SMTP_URL with host, port, user and the security it implies", () => {
    expect(envMail({})).toBeNull();
    expect(envMail({ SMTP_URL: "smtps://mail.example.com" })).toBeNull();
    const tls = envMail({
      SMTP_URL: `smtps://bridge%40example.com:${MARKER}@mail.example.com`,
      NOTIFY_EMAIL: "cook@example.com",
    });
    expect(tls?.summary).toEqual({
      host: "mail.example.com",
      port: 465,
      security: "tls",
      allowInsecure: false,
      username: "bridge@example.com",
      passwordSet: true,
      from: "cook@example.com",
      configuredFrom: "",
      to: ["cook@example.com"],
      events: ALL_EVENTS,
    });
    expect(tls?.secrets).toEqual(["bridge@example.com", MARKER]);
    expect(JSON.stringify(tls?.summary)).not.toContain(MARKER);
    const plain = envMail({
      SMTP_URL: "smtp://mail.example.com",
      NOTIFY_EMAIL: "cook@example.com",
      SMTP_FROM: "Bridge <bridge@example.com>",
      SMTP_ALLOW_INSECURE: true,
    });
    expect(plain?.summary).toMatchObject({
      port: 587,
      security: "starttls",
      allowInsecure: true,
      username: null,
      passwordSet: false,
      from: "Bridge <bridge@example.com>",
      configuredFrom: "Bridge <bridge@example.com>",
    });
    expect(plain?.transport).toMatchObject({ url: "smtp://mail.example.com", requireTLS: false });
  });

  it("builds the stored setup with the sender defaulting to the first recipient", () => {
    const mail = storedMail(settings({ to: ["cook@example.com", "other@example.com"] }));
    expect(mail.from).toBe("cook@example.com");
    // The form keeps the sender empty, so it follows the recipients.
    expect(summaryValues(mail.summary)).toMatchObject({
      from: "",
      to: "cook@example.com, other@example.com",
      port: "587",
    });
    expect(mail.to).toEqual(["cook@example.com", "other@example.com"]);
    expect(mail.secrets).toEqual(["bridge@example.com", MARKER]);
    expect(mail.summary).toMatchObject({ username: "bridge@example.com", passwordSet: true });
    expect(JSON.stringify(mail.summary)).not.toContain(MARKER);
    expect(storedMail(settings({ from: "Bridge <b@example.com>" })).from).toBe(
      "Bridge <b@example.com>",
    );
  });
});
