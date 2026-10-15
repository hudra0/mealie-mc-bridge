import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser, loopClock, type FakeBrowserScript } from "../testing/browser.js";
import { silentLogger } from "../testing/fakes.js";
import { steppingClock, tempStore, type TempStore } from "../testing/temp.js";
import {
  AUTO_LOGIN_KEYS,
  AutoLogin,
  InvalidCredentialsError,
  KEEP_SCREENSHOTS,
  MANUAL_COOLDOWN_MS,
  type AutoLoginOptions,
} from "./auto-login.js";
import {
  browserLogin,
  type BrowserLoginOptions,
  type BrowserLoginResult,
} from "./browser-login.js";

const PASSWORD = "not-a-real-password";
const HOUR = 60 * 60_000;

let store: TempStore | null = null;
afterEach(() => {
  store?.dispose();
  store = null;
});

function setup(
  options: {
    script?: FakeBrowserScript;
    login?: (options: BrowserLoginOptions) => Promise<BrowserLoginResult>;
    credentials?: boolean;
  } = {},
) {
  const clock = steppingClock("2026-10-15T08:00:00.000Z");
  store = tempStore({ now: clock.now });
  const browser = fakeBrowser(options.script ?? { form: "both", loginWorks: true });
  const autoOptions: AutoLoginOptions = {
    settings: store.settings,
    browser,
    profileDir: join(store.dir, "browser-profile"),
    screenshotDir: join(store.dir, "login-screenshots"),
    editorPath: "/de/create-recipe?devices=mc-smart",
    logger: silentLogger(),
    now: clock.now,
    timeoutMs: 30_000,
    // The real flow on a clock that jumps with every poll.
    login: options.login ?? ((login) => browserLogin({ ...login, ...loopClock() })),
  };
  const autoLogin = new AutoLogin(autoOptions);
  if (options.credentials !== false) autoLogin.saveCredentials("cook@example.com", PASSWORD);
  const accept = vi.fn<(cookie: string) => Promise<void>>(() => Promise.resolve());
  return { autoLogin, browser, clock, accept, settings: store.settings, dir: store.dir };
}

// A login that fails at once, with a screenshot, without the polling loop.
const failing = (options: BrowserLoginOptions): Promise<BrowserLoginResult> => {
  const path = options.screenshotPath?.() ?? null;
  if (path) writeFileSync(path, "png");
  return Promise.resolve({
    ok: false,
    code: "not_logged_in",
    detail: "the login form was sent, but no session followed",
    screenshot: path,
  });
};

describe("credentials", () => {
  it("stores e-mail and password encrypted and never reveals the password", () => {
    const { autoLogin, settings } = setup();
    expect(autoLogin.hasCredentials()).toBe(true);
    expect(autoLogin.email()).toBe("cook@example.com");
    expect(settings.get(AUTO_LOGIN_KEYS.password)).not.toContain(PASSWORD);
    expect(settings.get(AUTO_LOGIN_KEYS.email)).not.toContain("cook@example.com");
    expect(settings.getSecret(AUTO_LOGIN_KEYS.password)).toBe(PASSWORD);
    expect(JSON.stringify(autoLogin.status())).not.toContain(PASSWORD);
  });

  it("keeps the stored password when the field stays empty", () => {
    const { autoLogin, settings } = setup();
    autoLogin.saveCredentials(" other@example.com ", "");
    expect(autoLogin.email()).toBe("other@example.com");
    expect(settings.getSecret(AUTO_LOGIN_KEYS.password)).toBe(PASSWORD);
  });

  it("refuses an invalid address and a missing first password", () => {
    const { autoLogin } = setup({ credentials: false });
    expect(() => autoLogin.saveCredentials("no-address", "x")).toThrow(InvalidCredentialsError);
    expect(() => autoLogin.saveCredentials("cook@example.com", "")).toThrow(/password/);
    expect(autoLogin.hasCredentials()).toBe(false);
  });

  it("deletes both", () => {
    const { autoLogin, settings } = setup();
    autoLogin.deleteCredentials();
    expect(autoLogin.hasCredentials()).toBe(false);
    expect(autoLogin.status()).toMatchObject({ configured: false, email: null });
    expect(settings.get(AUTO_LOGIN_KEYS.password)).toBeNull();
  });
});

describe("run", () => {
  it("logs in headless with the stored account and hands the cookie over", async () => {
    const { autoLogin, accept, browser } = setup();
    const run = await autoLogin.run({ manual: false, accept });
    expect(run.status).toBe("ok");
    expect(accept).toHaveBeenCalledWith(expect.stringContaining("wordpress_logged_in_0123="));
    expect(browser.opened[0]).toMatchObject({ headless: true });
    expect(browser.filled['input[type="password"]']).toBe(PASSWORD);
    expect(autoLogin.status().last).toMatchObject({ ok: true, manual: false, code: null });
  });

  it("records a consent dialog the login declined", async () => {
    const { autoLogin, accept } = setup({
      script: { form: "both", loginWorks: true, consent: ["Ablehnen"] },
    });
    const run = await autoLogin.run({ manual: true, accept });
    expect(run).toMatchObject({ status: "ok", attempt: { consentDismissed: true } });
    expect(autoLogin.status().last).toMatchObject({ ok: true, consentDismissed: true });
  });

  it("records a wrong password the site reported", async () => {
    const { autoLogin, accept } = setup({
      script: { form: "both", siteError: "Passwort ist falsch." },
    });
    const run = await autoLogin.run({ manual: false, accept });
    expect(run).toMatchObject({ status: "failed", attempt: { code: "wrong_password" } });
    expect(run.status === "skipped" ? null : run.attempt).not.toHaveProperty("consentDismissed");
  });

  it("skips without an account", async () => {
    const { autoLogin, accept } = setup({ credentials: false });
    expect(await autoLogin.run({ manual: true, accept })).toEqual({
      status: "skipped",
      reason: "no_credentials",
    });
  });

  it("records a refused session as a failure", async () => {
    const { autoLogin } = setup();
    const run = await autoLogin.run({
      manual: false,
      accept: () => Promise.reject(new Error("Monsieur Cuisine does not accept this cookie")),
    });
    expect(run).toMatchObject({ status: "failed", attempt: { code: "verify_failed" } });
  });

  it("keeps a screenshot of a failed login, and only the last five", async () => {
    const { autoLogin, accept, clock, dir } = setup({ login: failing });
    const shots = join(dir, "login-screenshots");
    mkdirSync(shots, { recursive: true });
    for (let day = 1; day <= 6; day++)
      writeFileSync(join(shots, `2026-10-0${day}T00-00-00-000Z.png`), "old");
    const run = await autoLogin.run({ manual: true, accept });
    expect(run.status).toBe("failed");
    const name = run.status === "failed" ? run.attempt.screenshot : null;
    expect(name).toMatch(/^2026-10-15T08-00-0\d-000Z\.png$/);
    const files = readdirSync(shots);
    expect(files).toHaveLength(KEEP_SCREENSHOTS);
    expect(files).toContain(name);
    expect(autoLogin.screenshotFile(name ?? "")).toBe(join(shots, name ?? ""));
    expect(autoLogin.screenshotFile("../bridge.db")).toBeNull();
    expect(autoLogin.screenshotFile("2026-10-01T00-00-00-000Z.png")).toBeNull();
    clock.advance(0);
  });

  it("runs one login at a time, a manual one included", async () => {
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<BrowserLoginResult>((resolve) => {
        release = () =>
          resolve({ ok: true, cookie: "wordpress_logged_in_1=a; lidl_sso_id_token=b" });
      });
    const { autoLogin, accept } = setup({ login: slow });
    const first = autoLogin.run({ manual: false, accept });
    expect(autoLogin.status().running).toBe(true);
    expect(await autoLogin.run({ manual: true, accept })).toEqual({
      status: "skipped",
      reason: "running",
    });
    release();
    expect((await first).status).toBe("ok");
    expect(autoLogin.status().running).toBe(false);
  });
});

describe("limits", () => {
  it("runs automatically at most once per hour", async () => {
    const { autoLogin, accept, clock } = setup();
    expect((await autoLogin.run({ manual: false, accept })).status).toBe("ok");
    clock.advance(30 * 60_000);
    expect(await autoLogin.run({ manual: false, accept })).toMatchObject({
      status: "skipped",
      reason: "too_soon",
    });
    // A manual test skips the hourly limit.
    expect((await autoLogin.run({ manual: true, accept })).status).toBe("ok");
    clock.advance(HOUR);
    expect((await autoLogin.run({ manual: false, accept })).status).toBe("ok");
  });

  it("waits 1, 4 and 24 hours after failures", async () => {
    const { autoLogin, accept, clock } = setup({ login: failing });
    expect((await autoLogin.run({ manual: false, accept })).status).toBe("failed");
    clock.advance(HOUR - 5000);
    expect(await autoLogin.run({ manual: false, accept })).toMatchObject({ reason: "backoff" });
    clock.advance(10_000);
    expect((await autoLogin.run({ manual: false, accept })).status).toBe("failed");
    clock.advance(3 * HOUR);
    expect(await autoLogin.run({ manual: false, accept })).toMatchObject({ reason: "backoff" });
    clock.advance(HOUR);
    expect((await autoLogin.run({ manual: false, accept })).status).toBe("failed");
    expect(autoLogin.status().failures).toBe(3);
    const next = Date.parse(autoLogin.status().nextAttemptAt ?? "");
    const last = Date.parse(autoLogin.status().last?.at ?? "");
    expect(next - last).toBe(24 * HOUR);
  });

  it("never runs automatically more than three times in 24 hours", async () => {
    const { autoLogin, accept, clock } = setup();
    for (let round = 0; round < 3; round++) {
      expect((await autoLogin.run({ manual: false, accept })).status).toBe("ok");
      clock.advance(HOUR + 1000);
    }
    expect(await autoLogin.run({ manual: false, accept })).toMatchObject({
      status: "skipped",
      reason: "daily_limit",
    });
    clock.advance(22 * HOUR);
    expect((await autoLogin.run({ manual: false, accept })).status).toBe("ok");
  });

  it("starts over after new credentials", async () => {
    const { autoLogin, accept } = setup({ login: failing });
    await autoLogin.run({ manual: false, accept });
    expect(autoLogin.status().failures).toBe(1);
    autoLogin.saveCredentials("cook@example.com", "another-password");
    expect(autoLogin.status().failures).toBe(0);
  });

  it("reports a missing browser as a failed attempt", async () => {
    const { autoLogin, accept, dir } = setup({
      script: { unavailable: "Playwright is not installed" },
    });
    const run = await autoLogin.run({ manual: true, accept });
    expect(run).toMatchObject({
      status: "failed",
      attempt: { code: "browser_unavailable", screenshot: null },
    });
    expect(await autoLogin.browserUnavailable()).toBe("Playwright is not installed");
    expect(existsSync(join(dir, "login-screenshots"))).toBe(false);
  });
});

describe("manual tests", () => {
  it("run at most every three minutes", async () => {
    const { autoLogin, accept, clock } = setup();
    expect((await autoLogin.run({ manual: true, accept })).status).toBe("ok");
    clock.advance(60_000);
    expect(await autoLogin.run({ manual: true, accept })).toMatchObject({
      status: "skipped",
      reason: "cooldown",
    });
    expect(autoLogin.status().manualAvailableAt).not.toBeNull();
    clock.advance(2 * 60_000);
    expect(autoLogin.status().manualAvailableAt).toBeNull();
    expect((await autoLogin.run({ manual: true, accept })).status).toBe("ok");
  });

  it("count neither toward the daily limit nor toward the backoff", async () => {
    const { autoLogin, accept, clock } = setup({ login: failing });
    for (let round = 0; round < 4; round++) {
      expect((await autoLogin.run({ manual: true, accept })).status).toBe("failed");
      clock.advance(MANUAL_COOLDOWN_MS + 1000);
    }
    expect(autoLogin.status()).toMatchObject({ failures: 0, nextAttemptAt: null });
    expect((await autoLogin.run({ manual: false, accept })).status).toBe("failed");
  });
});

describe("deleting the account", () => {
  it("removes the browser profile and the screenshots", async () => {
    const { autoLogin, accept, dir } = setup({ login: failing });
    await autoLogin.run({ manual: true, accept });
    const profile = join(dir, "browser-profile");
    writeFileSync(join(profile, "Cookies"), "lidl session");
    autoLogin.deleteCredentials();
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(join(dir, "login-screenshots"))).toBe(false);
    expect(autoLogin.status()).toMatchObject({ configured: false, last: null });
  });

  it("keeps the profile while a login is using it", async () => {
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<BrowserLoginResult>((resolve) => {
        release = () => resolve({ ok: false, code: "error", detail: "stopped", screenshot: null });
      });
    const { autoLogin, accept, dir } = setup({ login: slow });
    const running = autoLogin.run({ manual: false, accept });
    autoLogin.deleteCredentials();
    expect(existsSync(join(dir, "browser-profile"))).toBe(true);
    release();
    await running;
  });

  it.skipIf(process.platform === "win32")(
    "creates the profile for the bridge user only",
    async () => {
      const { autoLogin, accept, dir } = setup();
      await autoLogin.run({ manual: false, accept });
      expect(statSync(join(dir, "browser-profile")).mode & 0o777).toBe(0o700);
    },
  );
});
