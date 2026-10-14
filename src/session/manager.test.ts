import { afterEach, describe, expect, it, vi } from "vitest";
import { McNetworkError, McSessionError, type McUser, type SessionErrorKind } from "../mc/index.js";
import { SettingsStore } from "../store/settings.js";
import { RECIPE_ID, fakeNotifier, silentLogger, type FakeNotifier } from "../testing/fakes.js";
import { steppingClock, tempStore, type TempStore } from "../testing/temp.js";
import {
  InvalidCookieError,
  SESSION_KEYS,
  SessionManager,
  SessionRejectedError,
  WORDPRESS_LOGIN_DAYS,
  cookieIssuedAt,
  wordpressLoginExpiry,
  type SessionManagerOptions,
} from "./manager.js";

const COOKIE = "wordpress_logged_in_abc=one; lidl_sso_id_token=two";
const USER: McUser = { id: 1, displayName: "test-user" };

const rejected = (kind: SessionErrorKind) =>
  new McSessionError({
    kind,
    status: 401,
    code: kind === "expired" ? 110002 : 110001,
    serverMessage: null,
    endpoint: "GET api/v1/users",
  });

let store: TempStore;
let manager: SessionManager | null = null;
afterEach(() => {
  manager?.stop();
  manager = null;
  vi.useRealTimers();
  store?.dispose();
});

interface Built {
  manager: SessionManager;
  validate: ReturnType<typeof vi.fn<(cookie: string) => Promise<McUser>>>;
  notifier: FakeNotifier;
}

function build(options: Partial<SessionManagerOptions> = {}, clock = steppingClock()): Built {
  store ??= tempStore({ now: clock.now });
  const validate = vi.fn<(cookie: string) => Promise<McUser>>(() => Promise.resolve(USER));
  const notifier = fakeNotifier();
  manager = new SessionManager({
    settings: store.settings,
    jobs: store.jobs,
    validate,
    notifier,
    logger: silentLogger(),
    now: clock.now,
    ...options,
  });
  return {
    manager,
    validate: (options.validate as Built["validate"] | undefined) ?? validate,
    notifier: (options.notifier as FakeNotifier | undefined) ?? notifier,
  };
}

describe("seeding from MC_COOKIE", () => {
  it("stores the env cookie encrypted on the first start", async () => {
    store = tempStore();
    const { manager } = build({ seedCookie: `Cookie: ${COOKIE}` });
    await expect(manager.getCookie()).resolves.toBe(COOKIE);
    expect(store.settings.get(SESSION_KEYS.cookie)).not.toContain("one");
    expect(manager.status()).toMatchObject({ state: "unknown", cookieAgeHours: 0 });
  });

  it("keeps a cookie pasted later when the env value is unchanged, and takes a changed one", async () => {
    store = tempStore();
    const first = build({ seedCookie: COOKIE });
    await first.manager.setCookie("a=pasted");
    first.manager.stop();

    const restarted = build({ seedCookie: COOKIE });
    await expect(restarted.manager.getCookie()).resolves.toBe("a=pasted");

    const changed = build({ seedCookie: "b=new-from-env" });
    await expect(changed.manager.getCookie()).resolves.toBe("b=new-from-env");
    expect(changed.manager.status().state).toBe("unknown");
  });

  it("ignores an empty seed", async () => {
    store = tempStore();
    const { manager } = build({ seedCookie: "  \n# comment\n" });
    await expect(manager.getCookie()).resolves.toBeNull();
  });
});

describe("setCookie", () => {
  it("rejects an empty cookie", async () => {
    store = tempStore();
    const { manager, validate } = build();
    await expect(manager.setCookie(" \n ")).rejects.toThrow(InvalidCookieError);
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects a cookie Monsieur Cuisine does not accept and keeps the old one", async () => {
    store = tempStore();
    const { manager, validate } = build({ seedCookie: COOKIE });
    validate.mockRejectedValueOnce(rejected("expired"));
    const attempt = manager.setCookie("a=stale");
    await expect(attempt).rejects.toThrow(SessionRejectedError);
    await expect(manager.getCookie()).resolves.toBe(COOKIE);
    validate.mockRejectedValueOnce(rejected("invalid"));
    await expect(manager.setCookie("a=junk")).rejects.toThrow("does not accept this cookie");
  });

  it("does not store a cookie it could not check", async () => {
    store = tempStore();
    const { manager, validate } = build();
    validate.mockRejectedValueOnce(
      new McNetworkError({ endpoint: "x", timedOut: true, reason: "slow" }),
    );
    await expect(manager.setCookie("a=1")).rejects.toThrow(McNetworkError);
    await expect(manager.getCookie()).resolves.toBeNull();
  });

  it("stores a valid cookie and resumes the jobs waiting for a session", async () => {
    store = tempStore();
    const { manager, validate } = build();
    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    await manager.onSessionError("expired");
    expect(store.jobs.get(job.id)?.status).toBe("session_expired");
    expect(manager.isPaused()).toBe(true);

    const status = await manager.setCookie("Cookie: a=1;b=2");
    expect(validate).toHaveBeenCalledWith("a=1; b=2");
    expect(status).toMatchObject({ state: "valid", lastError: null });
    expect(store.jobs.get(job.id)?.status).toBe("queued");
    expect(manager.isPaused()).toBe(false);
    await expect(manager.getCookie()).resolves.toBe("a=1; b=2");
  });

  it("ignores a late session error for a cookie that was replaced", async () => {
    store = tempStore();
    const { manager } = build({ seedCookie: COOKIE });
    await manager.setCookie("a=fresh");
    await manager.onSessionError("expired", COOKIE);
    expect(manager.status().state).toBe("valid");
    expect(manager.isPaused()).toBe(false);

    await manager.onSessionError("expired", "a=fresh");
    expect(manager.status().state).toBe("expired");
  });
});

describe("health check", () => {
  it("marks a missing cookie as invalid and notifies once", async () => {
    store = tempStore();
    const { manager, notifier, validate } = build();
    const status = await manager.check();
    expect(status).toMatchObject({
      state: "invalid",
      lastError: "No Monsieur Cuisine session cookie is configured",
    });
    await manager.check();
    expect(validate).not.toHaveBeenCalled();
    expect(notifier.sent.filter((entry) => entry.kind === "session")).toHaveLength(1);
  });

  it("moves through valid, expired and valid again, pausing and resuming jobs", async () => {
    store = tempStore();
    const { manager, validate, notifier } = build({ seedCookie: COOKIE });
    expect((await manager.check()).state).toBe("valid");

    const { job } = store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    validate.mockRejectedValue(rejected("expired"));
    const expired = await manager.check();
    expect(expired).toMatchObject({
      state: "expired",
      lastError: "Monsieur Cuisine reported the session as expired",
    });
    expect(store.jobs.get(job.id)?.status).toBe("session_expired");
    await manager.check();
    expect(notifier.sent.filter((entry) => entry.kind === "session")).toHaveLength(1);
    expect(notifier.sent[0]?.detail).toMatchObject({ state: "expired" });

    validate.mockResolvedValue(USER);
    expect((await manager.check()).state).toBe("valid");
    expect(store.jobs.get(job.id)?.status).toBe("queued");
  });

  it("treats an unauthorized answer as an invalid session", async () => {
    store = tempStore();
    const { manager } = build({ seedCookie: COOKIE });
    await manager.onSessionError("unauthorized");
    expect(manager.status()).toMatchObject({
      state: "invalid",
      lastError: "Monsieur Cuisine rejected the session (unauthorized)",
    });
  });

  it("reports a failing check once without touching the session state", async () => {
    store = tempStore();
    const { manager, validate, notifier } = build({ seedCookie: COOKIE });
    await manager.check();
    validate.mockRejectedValue(
      new McNetworkError({ endpoint: "GET api/v1/users", timedOut: false, reason: "ECONNREFUSED" }),
    );
    const status = await manager.check();
    await manager.check();
    expect(status.state).toBe("valid");
    expect(status.lastError).toMatch(/network error/);
    expect(notifier.sent.filter((entry) => entry.kind === "health")).toHaveLength(1);
    expect(manager.isPaused()).toBe(false);

    validate.mockResolvedValue(USER);
    await manager.check();
    validate.mockRejectedValue(new Error("down again"));
    await manager.check();
    expect(notifier.sent.filter((entry) => entry.kind === "health")).toHaveLength(2);
  });

  it("shares one check between concurrent callers", async () => {
    store = tempStore();
    const { manager, validate } = build({ seedCookie: COOKIE });
    await Promise.all([manager.check(), manager.check(), manager.check()]);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("survives a notifier that throws", async () => {
    store = tempStore();
    const notifier = fakeNotifier();
    (notifier.sessionExpired as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("smtp down"));
    const { manager } = build({ notifier });
    await expect(manager.onSessionError("expired")).resolves.toBeUndefined();
    expect(manager.status().state).toBe("expired");
  });

  it("does not throw from onSessionError when the store fails", async () => {
    store = tempStore();
    const { manager } = build();
    store.close();
    await expect(manager.onSessionError("expired")).resolves.toBeUndefined();
  });

  it("asks for a new cookie when the stored one cannot be decrypted", async () => {
    store = tempStore();
    build({ seedCookie: COOKIE }).manager.stop();
    const otherKey = new SettingsStore(store.db, { key: Buffer.alloc(32, 9) });
    const { manager, validate } = build({ settings: otherKey });
    await expect(manager.getCookie()).resolves.toBeNull();
    const status = await manager.check();
    expect(status.state).toBe("invalid");
    expect(status.lastError).toMatch(/cannot be decrypted/);
    expect(validate).not.toHaveBeenCalled();
  });

  it("reports the cookie age in hours since it was stored without a login expiry", () => {
    store = tempStore();
    const clock = steppingClock("2026-10-13T00:00:00.000Z");
    const { manager } = build({ seedCookie: COOKIE }, clock);
    clock.set("2026-10-14T12:00:00.000Z");
    expect(manager.status()).toMatchObject({
      cookieAgeHours: 36,
      cookieAgeFrom: "stored",
      cookieExpiresAt: null,
      cookieIssuedAt: null,
    });
  });

  it("reads the login expiry from the cookie and counts the age from the login", () => {
    store = tempStore();
    // Logged in on 2026-10-13 09:15:00 UTC, so the login lasts until 2026-10-27.
    const expiry = Date.parse("2026-10-27T09:15:00.000Z") / 1000;
    const cookie = `PHPSESSID=x; wordpress_logged_in_0123abc=someone%7C${expiry}%7Ctoken%7Chmac; lidl_sso_id_token=two`;
    const clock = steppingClock("2026-10-13T23:00:00.000Z");
    const { manager } = build({ seedCookie: cookie }, clock);
    clock.set("2026-10-14T09:15:00.000Z");
    expect(manager.status()).toMatchObject({
      cookieSetAt: "2026-10-13T23:00:00.000Z",
      cookieExpiresAt: "2026-10-27T09:15:00.000Z",
      cookieIssuedAt: "2026-10-13T09:15:00.000Z",
      cookieAgeHours: 24,
      cookieAgeFrom: "login",
    });
  });

  it("checks on start and then on the interval", async () => {
    vi.useFakeTimers();
    store = tempStore();
    const { manager, validate } = build({ seedCookie: COOKIE, checkIntervalMs: 60_000 });
    manager.start();
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(validate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(validate).toHaveBeenCalledTimes(2);
    manager.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("falls back to unknown for a state it does not know", () => {
    store = tempStore();
    const { manager } = build();
    store.settings.set(SESSION_KEYS.state, "weird");
    expect(manager.status().state).toBe("unknown");
    expect(manager.isPaused()).toBe(false);
  });
});

describe("wordpressLoginExpiry", () => {
  const at = new Date("2026-10-27T09:15:00.000Z");
  const seconds = at.getTime() / 1000;

  it("reads the second field of the login cookie, encoded or not", () => {
    expect(wordpressLoginExpiry(`wordpress_logged_in_ab=u%7C${seconds}%7Ct%7Ch`)).toEqual(at);
    expect(wordpressLoginExpiry(`a=1; wordpress_logged_in_ab=u|${seconds}|t|h; b=2`)).toEqual(at);
  });

  it("gives up on a missing or odd cookie", () => {
    expect(wordpressLoginExpiry(null)).toBeNull();
    expect(wordpressLoginExpiry("a=1; b")).toBeNull();
    expect(wordpressLoginExpiry("wordpress_logged_in_ab=synthetic")).toBeNull();
    expect(wordpressLoginExpiry("wordpress_logged_in_ab=u|soon|t|h")).toBeNull();
    expect(wordpressLoginExpiry("wordpress_logged_in_ab=u%E0%A4%A|123|t")).toBeNull();
  });
});

describe("cookieIssuedAt", () => {
  const expires = new Date("2026-10-27T09:15:00.000Z");
  const login = new Date(expires.getTime() - WORDPRESS_LOGIN_DAYS * 24 * 3_600_000);

  it("is the expiry minus the WordPress login length", () => {
    expect(cookieIssuedAt(expires, new Date("2026-10-14T00:00:00.000Z"))).toEqual(login);
    expect(cookieIssuedAt(expires, null)).toEqual(login);
  });

  it("stays unknown without an expiry or when the cookie was stored before that time", () => {
    expect(cookieIssuedAt(null, null)).toBeNull();
    expect(cookieIssuedAt(expires, new Date("2026-10-12T00:00:00.000Z"))).toBeNull();
  });
});
