import { afterEach, describe, expect, it, vi } from "vitest";
import { McNetworkError, McSessionError } from "../mc/index.js";
import { ConverterNotConfiguredError } from "../pipeline/converter-port.js";
import { CONTENT_SECURITY_POLICY } from "./admin.js";
import { LoginThrottle } from "./admin-auth.js";
import { loadConfig } from "../config.js";
import { effectiveConfig } from "../config-reference.js";
import { TOKEN_MASK } from "./views/settings.js";
import {
  RECIPE_ID,
  conversionResult,
  convertedRecipe,
  fakeConverter,
  mealieRecipe,
} from "../testing/fakes.js";
import {
  ADMIN,
  FORM_TOKEN,
  LOGIN_CSRF,
  SESSION_CSRF,
  adminCookie,
  basicAuth,
  form,
  WEBHOOK_TOKEN,
  testService,
  type TestService,
} from "../testing/service.js";

let svc: TestService | null = null;
afterEach(async () => {
  await svc?.dispose();
  svc = null;
});

const auth = { cookie: adminCookie() };
const formHeaders = { ...auth, "content-type": "application/x-www-form-urlencoded" };

function get(url: string, headers: Record<string, string> = auth) {
  return svc!.app.inject({ method: "GET", url, headers });
}

function post(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = formHeaders,
) {
  return svc!.app.inject({ method: "POST", url, headers, payload: form(fields) });
}

describe("admin authentication", () => {
  it("sends visitors without a login to the login form", async () => {
    svc = testService();
    const response = await get("/admin/jobs?status=failed", {});
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `/admin/login?next=${encodeURIComponent("/admin/jobs?status=failed")}`,
    );
    // Basic Auth no longer opens the pages.
    expect((await get("/admin", { authorization: basicAuth() })).statusCode).toBe(303);
    const posted = await post(
      "/admin/session",
      { _csrf: SESSION_CSRF, cookie: "a=1" },
      {
        "content-type": "application/x-www-form-urlencoded",
      },
    );
    expect(posted.statusCode).toBe(303);
    expect(posted.headers.location).toBe("/admin/login");
    expect(svc.validate).not.toHaveBeenCalled();
    const login = await get("/admin/login", {});
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('name="password"');
    // The login page carries its own token, never the one of a session or the secret.
    expect(login.body).toContain(`name="_csrf" value="${LOGIN_CSRF}"`);
    expect(login.body).not.toContain(SESSION_CSRF);
    expect(login.body).not.toContain(FORM_TOKEN);
    expect(login.body).not.toContain('action="/admin/logout"');
  });

  it("logs in with the right credentials and sets a signed session cookie", async () => {
    svc = testService();
    const response = await post(
      "/admin/login",
      { _csrf: LOGIN_CSRF, user: ADMIN.user, password: ADMIN.password, next: "/admin/jobs" },
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/jobs");
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toMatch(/^mcb_admin=v2\.\d+\.[\w-]+\.[\w-]+; Path=\/admin; Max-Age=43200;/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";")[0] ?? "";
    const page = await get("/admin", { cookie });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Signed in as admin");
    expect(page.body).toContain('action="/admin/logout"');
    // Already signed in: the login form sends you on.
    expect((await get("/admin/login", { cookie })).headers.location).toBe("/admin");
  });

  it("marks the cookie Secure and sends HSTS behind a trusted HTTPS proxy", async () => {
    svc = testService({ trustProxy: true });
    const response = await post(
      "/admin/login",
      {
        _csrf: LOGIN_CSRF,
        user: ADMIN.user,
        password: ADMIN.password,
        next: "//evil.example.com/admin",
      },
      { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
    );
    expect(response.headers.location).toBe("/admin");
    expect(String(response.headers["set-cookie"])).toContain("Secure");
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
  });

  it("ignores X-Forwarded-Proto unless TRUST_PROXY names the sender", async () => {
    for (const trustProxy of [undefined, ["192.0.2.1"]]) {
      svc = testService(trustProxy ? { trustProxy } : {});
      const response = await post(
        "/admin/login",
        { _csrf: LOGIN_CSRF, user: ADMIN.user, password: ADMIN.password },
        { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
      );
      expect(response.statusCode).toBe(303);
      expect(String(response.headers["set-cookie"])).not.toContain("Secure");
      expect(response.headers["strict-transport-security"]).toBeUndefined();
      await svc.dispose();
      svc = null;
    }
  });

  it("refuses a wrong password or user without setting a cookie", async () => {
    svc = testService();
    for (const [user, password] of [
      [ADMIN.user, "wrong"],
      ["root", ADMIN.password],
      ["", ""],
    ] as const) {
      const response = await post(
        "/admin/login",
        { _csrf: LOGIN_CSRF, user, password },
        { "content-type": "application/x-www-form-urlencoded" },
      );
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).toContain("User or password is wrong.");
      expect(response.body).not.toContain(ADMIN.password);
    }
  });

  it("needs the login form's own token on the login form", async () => {
    svc = testService();
    for (const fields of [{}, { _csrf: SESSION_CSRF }, { _csrf: FORM_TOKEN }]) {
      const response = await post(
        "/admin/login",
        { ...fields, user: ADMIN.user, password: ADMIN.password },
        { "content-type": "application/x-www-form-urlencoded" },
      );
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("binds the form token to the login session", async () => {
    svc = testService();
    // Another session's token, the bare secret and the login token open no form.
    for (const token of [FORM_TOKEN, LOGIN_CSRF, "x".repeat(64)]) {
      expect((await post("/admin/session/check", { _csrf: token })).statusCode).toBe(403);
    }
    expect((await post("/admin/session/check", { _csrf: SESSION_CSRF })).statusCode).toBe(303);
    expect((await get("/admin")).body).toContain(`name="_csrf" value="${SESSION_CSRF}"`);
  });

  it("locks an address out after five failed logins in 15 minutes", async () => {
    let now = Date.parse("2026-10-15T10:00:00.000Z");
    const clock = () => now;
    svc = testService({ throttle: new LoginThrottle({ now: clock }) });
    const attempt = (password: string) =>
      post(
        "/admin/login",
        { _csrf: LOGIN_CSRF, user: ADMIN.user, password },
        { "content-type": "application/x-www-form-urlencoded" },
      );
    for (let round = 0; round < 5; round++) expect((await attempt("wrong")).statusCode).toBe(401);
    const locked = await attempt(ADMIN.password);
    expect(locked.statusCode).toBe(429);
    expect(locked.body).toContain("Too many failed logins");
    expect(locked.headers["set-cookie"]).toBeUndefined();
    // Basic Auth on the API counts and is refused the same way.
    const api = await svc.app.inject({
      method: "GET",
      url: "/admin/api/session",
      headers: { authorization: basicAuth() },
    });
    expect(api.statusCode).toBe(429);
    expect(api.headers["retry-after"]).toBeDefined();
    now += 15 * 60_000 + 1000;
    expect((await attempt(ADMIN.password)).statusCode).toBe(303);
  });

  it("throttles each client behind a trusted proxy on its own", async () => {
    svc = testService({ trustProxy: ["127.0.0.1"], throttle: new LoginThrottle({ max: 2 }) });
    const attempt = (client: string, password: string) =>
      post(
        "/admin/login",
        { _csrf: LOGIN_CSRF, user: ADMIN.user, password },
        { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": client },
      );
    expect((await attempt("198.51.100.7", "wrong")).statusCode).toBe(401);
    expect((await attempt("198.51.100.7", "wrong")).statusCode).toBe(401);
    expect((await attempt("198.51.100.7", ADMIN.password)).statusCode).toBe(429);
    // The operator behind the same proxy is not locked out.
    expect((await attempt("203.0.113.9", ADMIN.password)).statusCode).toBe(303);
  });

  it("does not believe X-Forwarded-For without TRUST_PROXY", async () => {
    svc = testService({ throttle: new LoginThrottle({ max: 2 }) });
    const attempt = (client: string, password: string) =>
      post(
        "/admin/login",
        { _csrf: LOGIN_CSRF, user: ADMIN.user, password },
        { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": client },
      );
    expect((await attempt("198.51.100.7", "wrong")).statusCode).toBe(401);
    expect((await attempt("198.51.100.8", "wrong")).statusCode).toBe(401);
    expect((await attempt("198.51.100.9", ADMIN.password)).statusCode).toBe(429);
  });

  it("counts wrong Basic Auth on the API as failed logins", async () => {
    svc = testService({ throttle: new LoginThrottle({ max: 2 }) });
    const call = (password: string) =>
      svc!.app.inject({
        method: "GET",
        url: "/admin/api/session",
        headers: { authorization: basicAuth(ADMIN.user, password) },
      });
    expect((await call("wrong")).statusCode).toBe(401);
    expect((await call("wrong")).statusCode).toBe(401);
    expect((await call(ADMIN.password)).statusCode).toBe(429);
  });

  it("logs out with a POST only, clears the cookie and ends the session on the server", async () => {
    svc = testService();
    // The logout button needs the form token like every other form.
    expect((await post("/admin/logout", {})).statusCode).toBe(403);
    // There is no GET logout that a link or an image could trigger.
    expect((await get("/admin/logout")).statusCode).toBe(404);
    const response = await post("/admin/logout", { _csrf: SESSION_CSRF });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/login?notice=logged-out");
    expect(String(response.headers["set-cookie"])).toMatch(/^mcb_admin=; Path=\/admin; Max-Age=0;/);
    expect((await get("/admin/login?notice=logged-out", {})).body).toContain("Logged out.");
    // The old cookie, copied before the logout, no longer opens anything.
    expect((await get("/admin")).statusCode).toBe(303);
    // A new login works again.
    const login = await post(
      "/admin/login",
      { _csrf: LOGIN_CSRF, user: ADMIN.user, password: ADMIN.password },
      { "content-type": "application/x-www-form-urlencoded" },
    );
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    expect((await get("/admin", { cookie })).statusCode).toBe(200);
  });

  it("rejects a tampered, foreign or expired session cookie", async () => {
    svc = testService();
    const value = adminCookie().slice("mcb_admin=".length);
    const [version, expiry, nonce, signature] = value.split(".");
    const later = String(Number(expiry) + 86_400_000);
    const status = async (cookie: string) => (await get("/admin", { cookie })).statusCode;
    expect(await status(`mcb_admin=${version}.${later}.${nonce}.${signature}`)).toBe(303);
    expect(await status(`mcb_admin=${version}.${expiry}.${nonce}.${"A".repeat(43)}`)).toBe(303);
    expect(await status(`mcb_admin=${version}.${expiry}.${nonce}`)).toBe(303);
    expect(await status("mcb_admin=garbage")).toBe(303);
    expect(await status(`mcb_admin=${value}`)).toBe(200);
    // Issued 13 hours ago: past the 12-hour lifetime.
    expect(await status(adminCookie(new Date(Date.now() - 13 * 3_600_000)))).toBe(303);
    // A new password ends every session.
    await svc.dispose();
    svc = testService({ config: { ADMIN_PASSWORD: "another password" } });
    expect(await status(`mcb_admin=${value}`)).toBe(303);
  });

  it("lets the right credentials in", async () => {
    svc = testService();
    const response = await get("/admin");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(response.body).not.toContain("have no password");
  });

  it("is open with a warning when no credentials are configured", async () => {
    svc = testService({ auth: false });
    const response = await get("/admin", {});
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("The admin pages have no password");
  });

  it("refuses unknown host names without credentials, against DNS rebinding", async () => {
    svc = testService({ auth: false });
    const status = async (host: string) => (await get("/admin", { host })).statusCode;
    expect(await status("rebind.example.com")).toBe(403);
    expect(await status("rebind.example.com:3000")).toBe(403);
    expect(await status("localhost:3000")).toBe(200);
    expect(await status("127.0.0.1:3000")).toBe(200);
    expect(await status("[::1]:3000")).toBe(200);
    expect(await status("192.0.2.5")).toBe(200);
    // The webhook does not depend on the admin host check.
    expect(
      (await svc.app.inject({ method: "GET", url: "/health", headers: { host: "mc-bridge:3000" } }))
        .statusCode,
    ).toBe(200);
  });

  it("lets listed host names in, and checks them with credentials only when listed", async () => {
    svc = testService({ auth: false, config: { ADMIN_HOSTS: ["bridge.example.com"] } });
    expect((await get("/admin", { host: "Bridge.example.com:3000" })).statusCode).toBe(200);
    expect((await get("/admin", { host: "other.example.com" })).statusCode).toBe(403);
    await svc.dispose();

    svc = testService();
    expect((await get("/admin", { ...auth, host: "bridge.example.com" })).statusCode).toBe(200);
    await svc.dispose();

    svc = testService({ config: { ADMIN_HOSTS: ["bridge.example.com"] } });
    expect((await get("/admin", { ...auth, host: "other.example.com" })).statusCode).toBe(403);
  });

  it("refuses form posts without the form token", async () => {
    svc = testService();
    const missing = await post("/admin/session", { cookie: "a=1" });
    expect(missing.statusCode).toBe(403);
    expect(missing.body).toContain("The form has expired");
    const wrong = await post("/admin/session", { cookie: "a=1", _csrf: "x".repeat(64) });
    expect(wrong.statusCode).toBe(403);
    expect(svc.validate).not.toHaveBeenCalled();
  });

  it("refuses form posts from another origin", async () => {
    svc = testService();
    const response = await post(
      "/admin/session",
      { cookie: "a=1", _csrf: SESSION_CSRF },
      { ...formHeaders, origin: "https://evil.example.com" },
    );
    expect(response.statusCode).toBe(403);
    const same = await post(
      "/admin/session/check",
      { _csrf: SESSION_CSRF },
      { ...formHeaders, origin: "http://localhost:80", host: "localhost:80" },
    );
    expect(same.statusCode).toBe(303);
    const garbage = await post(
      "/admin/session/check",
      { _csrf: SESSION_CSRF },
      { ...formHeaders, origin: "::" },
    );
    expect(garbage.statusCode).toBe(403);
  });
});

describe("dashboard", () => {
  it("shows health, figures and recent jobs, with titles escaped", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({
      recipeId: RECIPE_ID,
      scale: 1,
      title: "<script>alert(1)</script>",
    });
    svc.store.jobs.finish(job.id, "failed", { error: 'boom "quoted" <b>' });
    const body = (await get("/admin")).body;
    expect(body).toMatch(/aria-current="page"\s*>.*Overview<\/a/s);
    expect(body).toContain("Monsieur Cuisine");
    expect(body).toContain("Recipes sent (30 days)");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
    // The newest failed job of the week is the last error, its message escaped.
    expect(body).toContain("Last failed job");
    expect(body).toContain("boom &quot;quoted&quot; &lt;b&gt;");
    expect(body).toContain(`name="_csrf" value="${SESSION_CSRF}"`);
    expect(body).toContain(`/admin/recipes/${RECIPE_ID}/thumbnail`);
  });

  it("shows the setup card until every step is done or it is dismissed", async () => {
    svc = testService({ mealieCheck: () => Promise.reject(new Error("no answer")) });
    let body = (await get("/admin")).body;
    expect(body).toContain("Finish the setup");
    expect(body).toMatch(/0 of 5 done/);
    expect(body).toContain('href="/admin/settings?tab=mealie"');
    // The Mealie check failed: the chip says so with the error.
    expect(body).toContain("no answer");
    const dismissed = await post("/admin/setup/dismiss", { _csrf: SESSION_CSRF });
    expect(dismissed.statusCode).toBe(303);
    body = (await get("/admin")).body;
    expect(body).not.toContain("Finish the setup");
    await svc.dispose();

    // Everything in place: no card.
    svc = testService({ seedCookie: "a=1", mealieCheck: () => Promise.resolve({ username: "u" }) });
    await svc.session.check();
    svc.autoLogin.saveCredentials("cook@example.com", "not-a-real-password");
    const done = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 }).job;
    svc.store.jobs.finish(done.id, "done", { costUsd: 0.0123 });
    body = (await get("/admin")).body;
    expect(body).not.toContain("Finish the setup");
    expect(body).toContain("as u");
    expect(body).toContain("Session valid");
  });

  it("caches the Mealie check and says when there is none", async () => {
    const probe = vi.fn(() => Promise.resolve({ username: "bridge-user" }));
    svc = testService({ mealieCheck: probe });
    await get("/admin");
    expect((await get("/admin")).body).toContain("as bridge-user");
    expect(probe).toHaveBeenCalledTimes(1);
    await svc.dispose();
    svc = testService();
    expect((await get("/admin")).body).toContain("Not checked");
  });

  it("counts the last 30 days and the cost against the daily limit", async () => {
    svc = testService({ config: { JOB_DAILY_COST_LIMIT_USD: 2 } });
    for (const [status, cost] of [
      ["done", 0.25],
      ["done", 0.25],
      ["failed", 0.5],
      ["skipped", 0],
    ] as const) {
      const job = svc.store.jobs.enqueue({ recipeId: `r-${Math.random()}`, scale: 1 }).job;
      svc.store.jobs.finish(job.id, status, {
        costUsd: cost,
        ...(status === "failed" ? { error: "x" } : {}),
      });
    }
    const body = (await get("/admin")).body;
    expect(body).toMatch(/>\s*2\s*<\/p>/);
    expect(body).toMatch(/67\s?%/);
    expect(body).toContain("$1.00");
    expect(body).toContain("Today $1.00 of $2.00");
    expect(body).toContain('role="meter"');
    expect(body).toContain('aria-valuenow="50"');
  });

  it("shows a known notice and ignores unknown ones", async () => {
    svc = testService();
    expect((await get("/admin?notice=session-saved")).body).toContain("Session saved.");
    expect((await get("/admin?notice=%3Cscript%3E")).body).not.toContain("<script>");
    expect((await get("/admin?notice=toString")).body).not.toContain("function");
  });

  it("shows the worker state", async () => {
    svc = testService({ seedCookie: "a=1" });
    expect((await get("/admin")).body).toContain("Worker stopped");
    svc.worker.start();
    expect((await get("/admin")).body).not.toContain("Worker stopped");
    await svc.session.onSessionError("expired");
    expect((await get("/admin")).body).toContain("Queue paused until the session works");
  });

  it("reloads while a recent job runs", async () => {
    svc = testService();
    svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const body = (await get("/admin?notice=job-queued")).body;
    expect(body).toContain('data-refresh="5"');
    expect(body).toMatch(/<noscript\s*><meta\s+http-equiv="refresh"\s+content="5; url=\/admin"/);
  });
});

describe("admin pages in German", () => {
  it("speaks UI_LANGUAGE on every page", async () => {
    svc = testService({ config: { UI_LANGUAGE: "de" } });
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1, force: false });
    svc.store.jobs.update(job.id, {
      title: "Suppe",
      ingredients: {
        catalog: 3,
        cache: 1,
        search: 0,
        unresolved: 2,
        unresolvedNames: ["X"],
        enabled: true,
      },
      provider: "fake",
      model: "m",
    });
    const dashboard = (await get("/admin")).body;
    expect(dashboard).toContain('<html lang="de" data-theme="system">');
    expect(dashboard).toContain("Einrichtung abschließen");
    expect(dashboard).toContain("Neueste Aufträge");
    expect(dashboard).toContain("Rezepte gesendet (30 Tage)");
    const settings = (await get("/admin/settings")).body;
    expect(settings).toContain("Cookie manuell setzen");
    expect(settings).toContain("Sitzung erneuern");
    expect((await get("/admin?notice=job-cancelled")).body).toContain("Auftrag abgebrochen.");
    const detail = (await get(`/admin/jobs/${job.id}`)).body;
    expect(detail).toContain("Neu senden erzwingen");
    expect(detail).toContain("3 aus dem Katalog, 1 aus dem Cache, 0 aus der Suche, 2 ohne ID");
    // The log speaks German too, though the store keeps English.
    const log = (await get(`/admin/jobs/${job.id}?tab=events`)).body;
    expect(log).toContain("In die Warteschlange gestellt, Faktor 1");
    expect(log).not.toContain("Queued with scale");
    expect((await get("/admin/jobs/nope")).body).toContain("Diesen Auftrag gibt es nicht.");
    expect((await get("/admin/dry-run")).body).toContain("Probelauf");
  });

  it("refuses an unknown host name in German", async () => {
    svc = testService({ auth: false, config: { UI_LANGUAGE: "de" } });
    const response = await svc.app.inject({
      method: "GET",
      url: "/admin",
      headers: { host: "evil.example.com" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("Unbekannter Hostname");
  });
});

describe("session form", () => {
  it("validates and stores a pasted cookie, then redirects", async () => {
    svc = testService();
    const response = await post("/admin/session", {
      _csrf: SESSION_CSRF,
      cookie: "Cookie: a=1; b=2",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/settings?notice=session-saved");
    expect(svc.validate).toHaveBeenCalledWith("a=1; b=2");
    expect(svc.session.status().state).toBe("valid");
  });

  it("refuses an empty cookie", async () => {
    svc = testService();
    const response = await post("/admin/session", { _csrf: SESSION_CSRF, cookie: "  " });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("The cookie field is empty.");
    expect(response.body).toContain('role="alert"');
  });

  it("refuses a cookie Monsieur Cuisine rejects and never echoes it", async () => {
    svc = testService();
    svc.validate.mockRejectedValueOnce(
      new McSessionError({
        kind: "expired",
        status: 401,
        code: 110002,
        serverMessage: null,
        endpoint: "GET api/v1/users",
      }),
    );
    const response = await post("/admin/session", {
      _csrf: SESSION_CSRF,
      cookie: "a=very-secret-value",
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("Monsieur Cuisine says this session has expired");
    expect(response.body).not.toContain("very-secret-value");
  });

  it("explains when the cookie could not be checked", async () => {
    svc = testService();
    svc.validate.mockRejectedValueOnce(
      new McNetworkError({ endpoint: "GET api/v1/users", timedOut: true, reason: "slow" }),
    );
    const response = await post("/admin/session", { _csrf: SESSION_CSRF, cookie: "a=1" });
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain("could not be checked");
  });

  it("runs the session check on request", async () => {
    svc = testService({ seedCookie: "a=1" });
    const response = await post("/admin/session/check", { _csrf: SESSION_CSRF });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/settings?notice=session-checked");
    expect(svc.validate).toHaveBeenCalledTimes(1);
  });

  it("shows when the login behind the cookie expires and counts its age from the login", async () => {
    const loginCookie = (expiresAt: string) =>
      `wordpress_logged_in_0123=someone%7C${Date.parse(expiresAt) / 1000}%7Ctoken%7Chmac`;
    // A 14-day login from two hours ago.
    const expiry = new Date(Date.now() + 14 * 86_400_000 - 2 * 3_600_000);
    expiry.setUTCMinutes(0, 0, 0);
    svc = testService({ seedCookie: loginCookie(expiry.toISOString()) });
    let body = (await get("/admin/settings")).body;
    expect(body).toContain("Login expires");
    expect(body).toContain("in 14 days");
    expect(body).toContain("since the login");
    await svc.dispose();

    // An expired cookie: it was not a 14-day login when stored, so the age counts from then.
    svc = testService({ seedCookie: loginCookie("2020-01-15T10:00:00.000Z") });
    body = (await get("/admin/settings")).body;
    expect(body).toContain('datetime="2020-01-15T10:00:00.000Z"');
    expect(body).toMatch(/text-danger-fg"\s*>· <time/);
    expect(body).toContain("since it was stored in the bridge");
    await svc.dispose();

    // A login that ends long after it was stored here: its start is unknown.
    svc = testService({ seedCookie: loginCookie("2099-01-15T10:00:00.000Z") });
    body = (await get("/admin/settings")).body;
    expect(body).toContain('datetime="2099-01-15T10:00:00.000Z"');
    expect(body).toContain("h since it was stored in the bridge");
  });
});

describe("jobs", () => {
  it("lists jobs with filter groups, counts, search and paging", async () => {
    svc = testService();
    const a = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1, title: "Tomato soup" }).job;
    svc.store.jobs.enqueue({
      recipeId: "00000000-0000-4000-8000-000000000002",
      scale: 1,
      title: "Bread",
    });
    svc.store.jobs.finish(a.id, "done");
    const all = (await get("/admin/jobs")).body;
    expect(all).toContain("Tomato soup");
    expect(all).toContain("Bread");
    expect(all).toMatch(/aria-current="true"\s*>All<span[^>]*>2<\/span>/);
    const done = (await get("/admin/jobs?status=done")).body;
    expect(done).toContain("Tomato soup");
    expect(done).not.toContain("Bread");
    expect(done).toMatch(/aria-current="true"\s*>Done<span/);
    expect(done).toContain('<input type="hidden" name="status" value="done" />');
    const active = (await get("/admin/jobs?status=active")).body;
    expect(active).toContain("Bread");
    expect(active).not.toContain("Tomato soup");
    // A single status from an older link still filters.
    const queued = (await get("/admin/jobs?status=queued")).body;
    expect(queued).toContain("Bread");
    expect(queued).not.toContain("Tomato soup");
    const searched = (await get("/admin/jobs?q=bread&status=bogus&offset=-5")).body;
    expect(searched).toContain("Bread");
    expect(searched).not.toContain("Tomato soup");
    expect(searched).toMatch(/>Done<span[^>]*>0<\/span>/);
    const later = (await get("/admin/jobs?offset=50")).body;
    expect(later).toContain("No older jobs.");
    expect(later).toContain("Newer");
  });

  it("pages through more than one page of jobs", async () => {
    svc = testService();
    for (let index = 0; index < 51; index++) {
      svc.store.jobs.enqueue({ recipeId: `r-${index}`, scale: 1, title: `Recipe ${index}` });
    }
    const first = (await get("/admin/jobs")).body;
    expect(first).toContain("1 to 50");
    expect(first).toContain('href="/admin/jobs?offset=50"');
    const second = (await get("/admin/jobs?offset=50")).body;
    expect(second).toContain("51 to 51");
    expect(second).toContain('href="/admin/jobs"');
  });

  it("shows empty states with what to do next", async () => {
    svc = testService();
    expect((await get("/admin")).body).toContain("No jobs yet");
    const jobs = (await get("/admin/jobs")).body;
    expect(jobs).toContain("No jobs yet");
    expect(jobs).toContain("pick the bridge&#39;s action from the three-dot menu");
    expect((await get("/admin/jobs?status=failed")).body).toContain("No job matches this filter.");
  });

  it("shows a job with its links, usage and actions", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.finish(job.id, "done", {
      title: "Kürbis-Linsen-Suppe",
      mealieSlug: "kurbis-linsen-suppe",
      mcRecipeId: 4242,
      mcRecipeUrl:
        "https://www.monsieur-cuisine.com/de/create-recipe?devices=mc-smart&recipe-id=4242",
      provider: "fake",
      model: "fake-model",
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 },
      costUsd: 0.5,
    });
    const response = await get(`/admin/jobs/${job.id}`);
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('href="https://mealie.example.com/g/home/r/kurbis-linsen-suppe"');
    expect(body).toContain("recipe-id=4242");
    expect(body).toContain('target="_blank" rel="noopener noreferrer"');
    expect(body).toContain("Open in MC editor");
    expect(body).toContain("100 in (20 cached), 50 out");
    expect(body).toContain("$0.5000");
    expect(body).toContain("Force rebuild");
    expect(body).not.toContain("Cancel job");
    expect(body).toContain(`/admin/recipes/${RECIPE_ID}/thumbnail`);
    const log = (await get(`/admin/jobs/${job.id}?tab=events`)).body;
    expect(log).toContain("Queued with scale 1");
    expect(log).toMatch(
      /<time\s+datetime="[^"]+"\s+title="[^"]+"\s+data-relative\s*>(now|\d+ seconds? ago)<\/time/,
    );
  });

  it("calls the result a recipe when it is saved on the device and a draft otherwise", async () => {
    const finishedJob = (s: TestService) => {
      const { job } = s.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
      s.store.jobs.finish(job.id, "done", {
        mcRecipeId: 4242,
        mcRecipeUrl: "https://www.monsieur-cuisine.com/de/create-recipe?recipe-id=4242",
      });
      return job.id;
    };
    svc = testService({ config: { UI_LANGUAGE: "de" } });
    let id = finishedJob(svc);
    expect((await get(`/admin/jobs/${id}`)).body).toContain("Im MC-Editor öffnen");
    expect((await get(`/admin/jobs/${id}`)).body).not.toContain("Entwurf im MC-Editor öffnen");
    await svc.dispose();

    svc = testService({ config: { UI_LANGUAGE: "de", MC_RECIPE_STATUS: "draft" } });
    id = finishedJob(svc);
    expect((await get(`/admin/jobs/${id}`)).body).toContain("Entwurf im MC-Editor öffnen");
  });

  it("shows the converted steps as the device would", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    expect((await get(`/admin/jobs/${job.id}?tab=steps`)).body).toContain(
      "No converted recipe is stored for this job.",
    );
    svc.store.jobs.finish(job.id, "done", {
      conversion: { sourceHash: "abc", result: conversionResult() },
    });
    const body = (await get(`/admin/jobs/${job.id}?tab=steps`)).body;
    expect(body).toMatch(/aria-current="page"[^>]*>.*Steps/s);
    expect(body).toContain("Manual cooking");
    expect(body).toContain("100 °C");
    expect(body).toContain("20:00");
    expect(body).toContain("Speed 1");
    expect(body).toContain("Reverse");
    expect(body).toContain("Zutaten einfüllen");
    expect(body).toContain("Kürbis");
    expect(body).toContain("800 g");
  });

  it("shows where the ingredient ids came from and the names without one", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    expect((await get(`/admin/jobs/${job.id}?tab=ingredients`)).body).toContain(
      "No converted ingredients are stored for this job.",
    );
    svc.store.jobs.finish(job.id, "done", {
      conversion: { sourceHash: "abc", result: conversionResult() },
      ingredients: {
        catalog: 7,
        cache: 2,
        search: 1,
        unresolved: 1,
        unresolvedNames: ["Rote Linsen"],
        enabled: true,
      },
    });
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain(
      "7 catalog, 2 cache, 1 search, 1 without id",
    );
    const body = (await get(`/admin/jobs/${job.id}?tab=ingredients`)).body;
    expect(body).toContain("1 with catalog id, 1 without");
    expect(body).toMatch(/Kürbis<\/td>[\s\S]*?With id/);
    expect(body).toMatch(/Rote Linsen<\/td>[\s\S]*?Without id/);

    // Without a stored recipe, the names without an id still show; with the lookup off, no
    // name gets a state.
    svc.store.jobs.update(job.id, {
      conversion: null,
      ingredients: {
        catalog: 0,
        cache: 0,
        search: 0,
        unresolved: 1,
        unresolvedNames: ["Testzutat <Z>"],
        enabled: true,
      },
    });
    expect((await get(`/admin/jobs/${job.id}?tab=ingredients`)).body).toContain(
      "Testzutat &lt;Z&gt;",
    );
    svc.store.jobs.update(job.id, {
      ingredients: {
        catalog: 0,
        cache: 0,
        search: 0,
        unresolved: 3,
        unresolvedNames: [],
        enabled: false,
      },
    });
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain("Lookup off, 3 without id");
  });

  it("lists the review hints and converter warnings of the stored conversion", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    expect((await get(`/admin/jobs/${job.id}`)).body).not.toContain("Review hints");
    svc.store.jobs.finish(job.id, "done", {
      conversion: {
        sourceHash: "abc",
        result: conversionResult({
          reviewHints: ["Garzeit <b>prüfen</b>", "Menge, Salz"],
          warnings: ["Fill level close to the limit"],
          recipe: convertedRecipe({ reviewHints: ["Menge, Salz", "Brühe heiß zugeben"] }),
        }),
      },
    });
    const body = (await get(`/admin/jobs/${job.id}`)).body;
    expect(body).toContain("Check before cooking");
    expect(body).toContain("Review hints");
    expect(body).toContain("<li>Garzeit &lt;b&gt;prüfen&lt;/b&gt;</li>");
    expect(body.split("<li>Menge, Salz</li>")).toHaveLength(2);
    expect(body).toContain("<li>Brühe heiß zugeben</li>");
    expect(body).toContain("Converter warnings");
    expect(body).toContain("<li>Fill level close to the limit</li>");
  });

  it("offers only the forced rebuild for a skipped job, behind a confirmation", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.finish(job.id, "skipped", {
      mcRecipeId: 4242,
      mcRecipeUrl: "https://example.com/r",
    });
    const body = (await get(`/admin/jobs/${job.id}`)).body;
    expect(body).toContain("Force rebuild");
    expect(body).toContain('data-confirm="Converts the recipe again');
    expect(body).toContain('<input type="hidden" name="force" value="1" />');
    expect(body).not.toMatch(/>\s*Retry\s*</);
    svc.store.jobs.update(job.id, { status: "failed", error: "boom" });
    const failed = (await get(`/admin/jobs/${job.id}`)).body;
    expect(failed).toMatch(/>\s*Retry\s*</);
    expect(failed).toContain("boom");
  });

  it("answers 404 for an unknown job", async () => {
    svc = testService();
    const page = await get("/admin/jobs/unknown");
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain("No such job.");
    expect((await post("/admin/jobs/unknown/retry", { _csrf: SESSION_CSRF })).statusCode).toBe(404);
  });

  it("retries and force-rebuilds a finished job", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.finish(job.id, "failed", { error: "boom" });
    const retry = await post(`/admin/jobs/${job.id}/retry`, { _csrf: SESSION_CSRF });
    expect(retry.statusCode).toBe(303);
    expect(retry.headers.location).toBe(`/admin/jobs/${job.id}?notice=job-queued`);
    expect(svc.store.jobs.get(job.id)).toMatchObject({ status: "queued", force: false });

    svc.store.jobs.finish(job.id, "skipped");
    const forced = await post(`/admin/jobs/${job.id}/retry`, { _csrf: SESSION_CSRF, force: "1" });
    expect(forced.headers.location).toBe(`/admin/jobs/${job.id}?notice=job-forced`);
    expect(svc.store.jobs.get(job.id)).toMatchObject({ status: "queued", force: true });
  });

  it("refuses to retry a running job and offers no actions for it", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.claimNext();
    const response = await post(`/admin/jobs/${job.id}/retry`, { _csrf: SESSION_CSRF });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("The job is running");
    const body = (await get(`/admin/jobs/${job.id}`)).body;
    expect(body).not.toContain(`/admin/jobs/${job.id}/retry`);
    expect(body).toContain('data-refresh="5"');
  });

  it("cancels a queued job but not a finished one", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain("Cancel job");
    const cancelled = await post(`/admin/jobs/${job.id}/cancel`, { _csrf: SESSION_CSRF });
    expect(cancelled.statusCode).toBe(303);
    expect(svc.store.jobs.get(job.id)?.status).toBe("cancelled");
    const again = await post(`/admin/jobs/${job.id}/cancel`, { _csrf: SESSION_CSRF });
    expect(again.statusCode).toBe(409);
  });

  it("reloads the job list and a job page while a job is queued or running", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const list = (await get("/admin/jobs?status=active&notice=job-queued")).body;
    expect(list).toContain('data-refresh="5"');
    expect(list).toContain('content="5; url=/admin/jobs?status=active"');
    const detail = (await get(`/admin/jobs/${job.id}?tab=events`)).body;
    expect(detail).toContain(`content="5; url=/admin/jobs/${job.id}?tab=events"`);
    expect(detail).toContain("Updates every 5 seconds");
    svc.store.jobs.finish(job.id, "done", {});
    expect((await get(`/admin/jobs/${job.id}`)).body).not.toContain("data-refresh");
    expect((await get("/admin/jobs")).body).not.toContain('http-equiv="refresh"');
  });
});

const convertDryRun = () =>
  post("/admin/dry-run", { recipe: "kurbis-linsen-suppe", convert: "1", _csrf: SESSION_CSRF });

describe("dry run", () => {
  it("shows the form without a recipe", async () => {
    svc = testService();
    const body = (await get("/admin/dry-run")).body;
    expect(body).toMatch(/aria-current="page"\s*>.*Dry run<\/a/s);
    expect(body).toContain('name="recipe"');
    expect(body).toContain('data-recipe-search="/admin/dry-run/recipes"');
    expect(body).toContain('name="scale"');
    expect(body).toContain('type="checkbox" name="convert" value="1"');
    expect(body).toContain(`name="_csrf" value="${SESSION_CSRF}"`);
    expect(body).toContain("Calls the language model, which costs money.");
    expect(body).not.toContain("Converter input");
  });

  it("previews the Markdown input and the ingredients without calling the converter", async () => {
    const converter = fakeConverter();
    svc = testService({ converter });
    const body = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe&scale=2")).body;
    expect(body).toContain("Converter input");
    expect(body).toContain("# Kürbis-Linsen-Suppe");
    expect(body).toContain("Portionen: 4 → 8");
    expect(body).toContain("Convert without uploading");
    expect(body).toContain('<input type="hidden" name="convert" value="1" />');
    expect(body).toContain("data-tabs");
    expect(converter.requests).toEqual([]);
    expect(svc.mc.calls).toEqual([]);
  });

  it("leaves the bridge's own tag out of the converter input", async () => {
    const recipe = mealieRecipe({
      tags: [
        { id: "00000000-0000-4000-8000-000000000301", name: "Vegetarisch", slug: "vegetarisch" },
        { id: "tag-1", name: "Monsieur Cuisine", slug: "monsieur-cuisine" },
      ],
    });
    svc = testService({ mealie: { recipe } });
    const body = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe")).body;
    const input = body.slice(body.indexOf("<pre"), body.indexOf("</pre>"));
    expect(input).toContain("Tags: Vegetarisch");
    expect(input).not.toContain("Monsieur Cuisine");
  });

  it("says when the recipe cannot be loaded or found", async () => {
    svc = testService({ mealie: { search: [] } });
    const response = await get("/admin/dry-run?recipe=missing&scale=abc");
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain("The recipe could not be loaded: no recipe missing");
  });

  it("offers recipes whose name matches when the entry is no slug", async () => {
    svc = testService({
      mealie: { search: [{ id: "r2", slug: "brot", name: "Brot <mit> Saaten" }] },
    });
    const body = (await get("/admin/dry-run?recipe=bro&scale=2")).body;
    expect(body).toContain("Matching recipes");
    expect(body).toContain('href="/admin/dry-run?recipe=brot&amp;scale=2"');
    expect(body).toContain("Brot &lt;mit&gt; Saaten");
  });

  it("answers the recipe search as JSON for the picker", async () => {
    svc = testService({ mealie: { search: [{ id: "r2", slug: "brot", name: "Brot" }] } });
    const short = await get("/admin/dry-run/recipes?q=b");
    expect(short.json()).toEqual({ recipes: [] });
    const found = await get("/admin/dry-run/recipes?q=brot");
    expect(found.statusCode).toBe(200);
    expect(found.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(found.headers["cache-control"]).toBe("no-store");
    expect(found.json()).toEqual({ recipes: [{ id: "r2", slug: "brot", name: "Brot" }] });
    // Only with a login.
    expect((await get("/admin/dry-run/recipes?q=brot", {})).statusCode).toBe(303);
    await svc.dispose();
    svc = testService({ mealie: { search: new Error("Mealie down") } });
    const failed = await get("/admin/dry-run/recipes?q=brot");
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ recipes: [], error: "Mealie down" });
  });

  it("converts only on a POST with the form token, never on a link", async () => {
    const converter = fakeConverter();
    svc = testService({ converter });
    const link = await get(
      `/admin/dry-run?recipe=kurbis-linsen-suppe&convert=1&_csrf=${SESSION_CSRF}`,
    );
    expect(link.statusCode).toBe(200);
    const missing = await post("/admin/dry-run", { recipe: "kurbis-linsen-suppe", convert: "1" });
    expect(missing.statusCode).toBe(403);
    expect(converter.requests).toEqual([]);
  });

  it("converts without uploading and shows steps, checks and review hints", async () => {
    const converter = fakeConverter(
      conversionResult({
        warnings: ["Fill level close to the limit"],
        reviewHints: ["<b>Garzeit</b> prüfen"],
      }),
    );
    svc = testService({ converter });
    const response = await post("/admin/dry-run", {
      recipe: "kurbis-linsen-suppe",
      scale: "1",
      convert: "1",
      _csrf: SESSION_CSRF,
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(converter.requests).toHaveLength(1);
    expect(svc.mc.calls).toEqual(["mc.getCategories"]);
    expect(svc.mc.payloads).toEqual([]);
    expect(body).toContain("fake / fake-model");
    expect(body).toContain("Checks passed");
    expect(body).toContain("228 Suppen &amp; Eintöpfe, 588 Vegetarisch, 260 Hauptgerichte");
    expect(body).toContain("&lt;b&gt;Garzeit&lt;/b&gt; prüfen");
    expect(body).toContain("Fill level close to the limit");
    expect(body).toContain("Manual cooking");
    expect(body).toContain("Speed 1");
    expect(body).toContain("800 g");
  });

  it("offers the converter catalog names in the dry run as the job does", async () => {
    const converter = fakeConverter();
    svc = testService({
      converter,
      ingredients: {
        resolveAll: () => Promise.reject(new Error("not used in a dry run")),
        suggest: (names) => names.map((_, index) => (index === 0 ? ["Kürbis"] : [])),
      },
    });
    await convertDryRun();
    expect(converter.requests[0]?.catalogNames).toEqual([{ index: 0, names: ["Kürbis"] }]);
  });

  it("lists validation errors of a broken conversion", async () => {
    const broken = convertedRecipe({ categoryIds: [9999] });
    broken.servingSize.steps.push({
      kind: "turbo",
      title: "Turbo",
      description: "Kurz",
      seconds: 500,
    });
    svc = testService({ converter: fakeConverter(conversionResult({ recipe: broken })) });
    const body = (await convertDryRun()).body;
    expect(body).toMatch(/[0-9]+ errors?</);
    expect(body).toContain("servingSize.steps[2]");
    expect(body).toContain("Dropped unknown ids 9999");
  });

  it("shows a converter failure", async () => {
    svc = testService({ converter: fakeConverter(new ConverterNotConfiguredError()) });
    const body = (await convertDryRun()).body;
    expect(body).toContain("The conversion failed: converter not configured");
  });

  it("tells whether the recipe was already sent", async () => {
    svc = testService();
    const first = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe")).body;
    expect(first).toMatch(/Already sent<\/dt>\s*<dd[^>]*>\s*No\s*<\/dd>/);
    const hash = /<code class="text-xs">([0-9a-f]{12})<\/code>/.exec(first)?.[1] ?? "";
    const { sourceHash } = await import("../pipeline/source-hash.js");
    const { normalizeIngredients } = await import("../ingredients/index.js");
    const recipe = svc.mealie.recipe;
    const fullHash = sourceHash(recipe, normalizeIngredients(recipe), 1);
    expect(hash).not.toBe("");
    expect(fullHash.startsWith(hash)).toBe(true);
    svc.store.mcRecipes.record({
      mealieRecipeId: recipe.id,
      scale: 1,
      sourceHash: fullHash,
      mcRecipeId: 7,
      mcRecipeUrl: "https://www.monsieur-cuisine.com/de/create-recipe?recipe-id=7",
    });
    const second = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe")).body;
    expect(second).toContain("A job would skip it unless forced.");
    expect(second).toContain("Recipe 7");
  });
});

describe("session API", () => {
  const json = (body: unknown, headers: Record<string, string>) =>
    svc!.app.inject({
      method: "POST",
      url: "/admin/api/session",
      headers: { "content-type": "application/json", ...headers },
      payload: JSON.stringify(body),
    });

  it("stores a cookie sent with Basic Auth and answers with the session state", async () => {
    svc = testService();
    const response = await json({ cookie: "Cookie: a=1; b=2" }, { authorization: basicAuth() });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ saved: boolean; session: Record<string, unknown> }>();
    expect(body.saved).toBe(true);
    expect(body.session.state).toBe("valid");
    expect(JSON.stringify(body)).not.toContain("a=1");
    expect(svc.validate).toHaveBeenCalledWith("a=1; b=2");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("takes the admin session cookie as well", async () => {
    svc = testService();
    expect((await json({ cookie: "a=1" }, auth)).statusCode).toBe(200);
    const state = await svc.app.inject({ method: "GET", url: "/admin/api/session", headers: auth });
    expect(state.json<{ session: { state: string } }>().session.state).toBe("valid");
  });

  it("asks for credentials and refuses wrong ones", async () => {
    svc = testService();
    const missing = await json({ cookie: "a=1" }, {});
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Basic");
    expect(
      (await json({ cookie: "a=1" }, { authorization: basicAuth("admin", "wrong") })).statusCode,
    ).toBe(401);
    expect(svc.validate).not.toHaveBeenCalled();
  });

  it("refuses bodies that are not JSON and posts from another origin", async () => {
    svc = testService();
    const formPost = await svc.app.inject({
      method: "POST",
      url: "/admin/api/session",
      headers: { ...auth, "content-type": "text/plain" },
      payload: '{"cookie":"a=1"}',
    });
    expect(formPost.statusCode).toBe(415);
    const foreign = await json({ cookie: "a=1" }, { ...auth, origin: "https://evil.example.com" });
    expect(foreign.statusCode).toBe(403);
    expect(svc.validate).not.toHaveBeenCalled();
  });

  it("reports an empty, a rejected and an unchecked cookie", async () => {
    svc = testService();
    const headers = { authorization: basicAuth() };
    expect((await json({}, headers)).statusCode).toBe(400);
    svc.validate.mockRejectedValueOnce(
      new McSessionError({
        status: 401,
        code: 110002,
        serverMessage: "ExpiredAuthCookieException",
        endpoint: "api/v1/users",
        kind: "expired",
      }),
    );
    const rejected = await json({ cookie: "a=secret" }, headers);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.body).not.toContain("secret");
    svc.validate.mockRejectedValueOnce(
      new McNetworkError({ endpoint: "api/v1/users", timedOut: true, reason: "timeout" }),
    );
    const unchecked = await json({ cookie: "a=1" }, headers);
    expect(unchecked.statusCode).toBe(502);
    expect(unchecked.json<{ saved: boolean }>().saved).toBe(false);
  });

  it("answers a broken JSON body with the generic API error", async () => {
    svc = testService();
    const response = await svc.app.inject({
      method: "POST",
      url: "/admin/api/session",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{broken",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400, error: "Bad Request" });
  });
});

describe("settings page", () => {
  const PASSWORD = "not-a-real-password";

  it("shows the session tab by default and the sidebar session state", async () => {
    svc = testService({ seedCookie: "a=1" });
    await svc.session.check();
    const body = (await get("/admin/settings")).body;
    expect(body).toMatch(/aria-current="page"\s*>.*Settings<\/a/s);
    expect(body).toMatch(/aria-current="page"\s*>.*Monsieur Cuisine<\/a/s);
    expect(body).toContain('action="/admin/session/check"');
    expect(body).toContain('action="/admin/session"');
    expect(body).toContain("npm run mc:login -- --bridge");
    // The sidebar names the session state on every page.
    expect((await get("/admin/jobs")).body).toMatch(/MC session<\/span>[\s\S]*?Valid/);
  });

  it("says what the recipe status means", async () => {
    svc = testService();
    expect((await get("/admin/settings?tab=system")).body).toContain(
      "Saved privately on your device",
    );
    await svc.dispose();
    svc = testService({ config: { MC_RECIPE_STATUS: "draft" } });
    expect((await get("/admin/settings?tab=system")).body).toContain(
      "does not show up on the machine",
    );
  });

  it("stores the Lidl account and never shows the password", async () => {
    svc = testService();
    const empty = await get("/admin/settings?tab=lidl");
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain("No account stored");
    expect(empty.body).toContain("Headless Chromium available");
    const saved = await post("/admin/settings/credentials", {
      _csrf: SESSION_CSRF,
      email: "cook@example.com",
      password: PASSWORD,
    });
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe("/admin/settings?tab=lidl&notice=credentials-saved");
    const body = (await get("/admin/settings?tab=lidl&notice=credentials-saved")).body;
    expect(body).toContain("cook@example.com");
    expect(body).toContain("Lidl account saved, encrypted.");
    expect(body).toContain("stored; leave empty to keep it");
    expect(body).not.toContain(PASSWORD);
    expect(body).toContain('action="/admin/settings/login"');
    // Deleting asks first.
    expect(body).toContain('data-confirm="The bridge forgets the Lidl account');
    expect(svc.store.settings.get("autologin.password")).not.toContain(PASSWORD);
  });

  it("refuses an invalid address and needs the form token", async () => {
    svc = testService();
    const invalid = await post("/admin/settings/credentials", {
      _csrf: SESSION_CSRF,
      email: "nope",
      password: PASSWORD,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain("the e-mail address is not valid");
    expect(invalid.body).toMatch(/aria-current="page"\s*>.*Lidl account<\/a/s);
    const forged = await post("/admin/settings/credentials", {
      email: "a@example.com",
      password: "x",
    });
    expect(forged.statusCode).toBe(403);
    expect(svc.autoLogin.hasCredentials()).toBe(false);
  });

  it("deletes the account", async () => {
    svc = testService();
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    const response = await post("/admin/settings/credentials/delete", { _csrf: SESSION_CSRF });
    expect(response.headers.location).toBe("/admin/settings?tab=lidl&notice=credentials-deleted");
    expect(svc.autoLogin.hasCredentials()).toBe(false);
  });

  it("tests the login in the background and stores the new session", async () => {
    svc = testService();
    expect((await post("/admin/settings/login", { _csrf: SESSION_CSRF })).headers.location).toBe(
      "/admin/settings?tab=lidl&notice=login-no-credentials",
    );
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    const response = await post("/admin/settings/login", { _csrf: SESSION_CSRF });
    expect(response.headers.location).toBe("/admin/settings?tab=lidl&notice=login-started");
    await vi.waitFor(() => expect(svc?.session.status().state).toBe("valid"));
    expect(svc.validate).toHaveBeenCalledWith(
      expect.stringContaining("lidl_sso_id_token=id-token"),
    );
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("Succeeded");
    expect(body).toContain("Manual test");
    expect(body).not.toContain("data-refresh");
    // The next manual test waits three minutes; the button is off meanwhile.
    expect(body).toContain("Next manual test");
    expect(body).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Test login/);
    const again = await post("/admin/settings/login", { _csrf: SESSION_CSRF });
    expect(again.headers.location).toBe("/admin/settings?tab=lidl&notice=login-cooldown");
    expect((await get("/admin/settings?tab=lidl&notice=login-cooldown")).body).toContain(
      "A manual test runs at most every 3 minutes.",
    );
  });

  it("shows a failed attempt with its reason and serves the screenshot", async () => {
    svc = testService({ browser: { form: "none" } });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("Failed");
    expect(body).toContain("No login form showed up");
    const link = /href="(\/admin\/settings\/screenshots\/[^"]+)"/.exec(body)?.[1];
    expect(link).toBeDefined();
    const image = await get(link ?? "");
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    const missing = await get("/admin/settings/screenshots/..%2Fbridge.db");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain("This screenshot no longer exists.");
    expect((await get(link ?? "", {})).statusCode).toBe(303);
  });

  it("shows a wrong password, the steps reached and the declined consent dialogs", async () => {
    svc = testService({
      browser: {
        form: "both",
        consent: ["Ablehnen"],
        consentAgainAfterEmail: true,
        siteError: "Passwort ist falsch.",
      },
    });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("The site reported a wrong password.");
    expect(body).toContain("wrong password reported by the site");
    expect(body).toContain("stuck after: password entered");
    expect(body).toContain("Steps reached");
    const steps = [...body.matchAll(/<\/span>([a-z][^<]+)\s*<\/li>/g)].map((match) =>
      match[1]?.trim(),
    );
    expect(steps).toEqual(
      expect.arrayContaining([
        "login page reached",
        "consent dialog declined",
        "e-mail address entered",
        "password page reached",
        "password entered",
      ]),
    );
    expect(steps.indexOf("login page reached")).toBeLessThan(steps.indexOf("password entered"));
    // The list replaces the line older records show.
    expect(body).not.toContain("A consent dialog was declined on the way.");
  });

  it("says to wait after a throttled login and names the browser, in German", async () => {
    svc = testService({
      config: { UI_LANGUAGE: "de" },
      browser: {
        form: "both",
        siteError: "Die Kapazität wurde überschritten. Bitte warte einen Moment.",
        browser: {
          userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
          headless: "new",
        },
      },
    });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("Lidl hat die Anmeldung vorübergehend gedrosselt.");
    expect(body).toContain("Warte mindestens eine Stunde");
    expect(body).toContain("Browser: Chrome 141, ohne Fenster (neuer Modus)");
    expect(body).toContain("Nächster manueller Test");
    expect(svc.autoLogin.status().failures).toBe(0);
    const again = await post("/admin/settings/login", { _csrf: SESSION_CSRF });
    expect(again.headers.location).toBe("/admin/settings?tab=lidl&notice=login-cooldown");
  });

  it("leaves out a stored step it does not know", async () => {
    svc = testService();
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    svc.store.settings.setJson("autologin.last_attempt", {
      at: "2026-10-15T10:00:00.000Z",
      ok: false,
      manual: true,
      code: "not_logged_in",
      detail: "no login within the time limit",
      screenshot: null,
      consentDismissed: true,
      progress: { reached: ["page_reached", "future_step"], consentDismissals: 0 },
    });
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("login page reached");
    expect(body).not.toContain("future_step");
    expect(body).not.toContain("undefined");
  });

  it("names the declined consent dialogs of an older record without steps", async () => {
    svc = testService();
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    svc.store.settings.setJson("autologin.last_attempt", {
      at: "2026-10-15T10:00:00.000Z",
      ok: true,
      manual: false,
      code: null,
      detail: null,
      screenshot: null,
      consentDismissed: true,
    });
    expect((await get("/admin/settings?tab=lidl")).body).toContain(
      "A consent dialog was declined on the way.",
    );
  });

  it("counts the declined consent dialogs in the list, in German", async () => {
    svc = testService({
      config: { UI_LANGUAGE: "de" },
      browser: {
        form: "continue",
        consent: ["Ablehnen"],
        consentAgainAfterEmail: true,
        siteError: "Passwort ist falsch.",
      },
    });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("Erreichte Schritte");
    expect(body).toContain("Zustimmungsdialog abgelehnt (2×)");
    expect(body).toContain("Weiter geklickt");
  });

  it("says when the login confirmed the terms and chose the device", async () => {
    svc = testService({
      config: { UI_LANGUAGE: "de" },
      browser: { form: "continue", loginWorks: true, terms: true, deviceChooser: true },
    });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("Nutzungsbedingungen wurden in deinem Namen bestätigt.");
    expect(body).toContain("Als Gerät wurde MC Smart gewählt.");
  });

  it("names an e-mail address the site does not know", async () => {
    svc = testService({
      browser: { form: "continue", unknownAccount: "Konto nicht gefunden." },
    });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings?tab=lidl")).body;
    expect(body).toContain("The site does not know the stored e-mail address.");
    expect(body).not.toContain("terms of use were confirmed");
  });

  it("says when the browser is missing", async () => {
    svc = testService({ browser: { unavailable: "Playwright is not installed" } });
    expect((await get("/admin/settings?tab=lidl")).body).toContain(
      "Not available: Playwright is not installed",
    );
  });

  it("says when the automatic login is not part of the service", async () => {
    svc = testService({ noAutoLogin: true });
    expect((await get("/admin/settings?tab=lidl")).body).toContain(
      "The automatic login is not available in this setup.",
    );
    expect((await get("/admin")).body).toContain("Not available");
    const posted = await post("/admin/settings/credentials", {
      _csrf: SESSION_CSRF,
      email: "a@example.com",
    });
    expect(posted.statusCode).toBe(404);
  });

  it("masks the webhook token until it is revealed", async () => {
    svc = testService();
    const body = (await get("/admin/settings?tab=mealie")).body;
    expect(body).toContain(`http://mc-bridge:3000/hooks/mealie/${TOKEN_MASK}`);
    const details = body.slice(body.indexOf("<details"), body.lastIndexOf("</details>"));
    expect(details).toContain("Show the URL with the token");
    expect(details).toContain(`http://mc-bridge:3000/hooks/mealie/${WEBHOOK_TOKEN}`);
    expect(details).toContain(`http://localhost:80/hooks/mealie/${WEBHOOK_TOKEN}`);
    // The token appears only inside the details elements.
    const outside = body.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(outside).not.toContain(WEBHOOK_TOKEN);
    expect(body).toContain("HTTP_ALLOW_LIST: &quot;mc-bridge&quot;");
  });

  it("shows the language model and its usage, read only", async () => {
    svc = testService({
      config: {
        LLM_PROVIDER: "openai",
        OPENAI_MODEL: "gpt-test",
        OPENAI_REASONING_EFFORT: "low",
        LLM_MAX_CORRECTIONS: 2,
        JOB_DAILY_LIMIT: 10,
      },
    });
    const job = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 }).job;
    svc.store.jobs.finish(job.id, "done", {
      costUsd: 0.5,
      usage: { inputTokens: 1000, outputTokens: 200 },
    });
    const body = (await get("/admin/settings?tab=ai")).body;
    expect(body).toContain("OpenAI");
    expect(body).toContain("gpt-test");
    expect(body).toContain("low");
    expect(body).toContain("1 / 10");
    expect(body).toContain('aria-valuenow="10"');
    expect(body).toContain("1,000 in, 200 out");
    expect(body).not.toMatch(/<form[^>]*action="\/admin\/settings/);
    expect((await get("/admin")).body).toContain("gpt-test · low");
  });

  it("sends a test mail with the form token, at most once a minute, and reports a failure", async () => {
    svc = testService({
      config: { SMTP_URL: "smtps://u:p@mail.example.com", NOTIFY_EMAIL: "cook@example.com" },
    });
    const page = (await get("/admin/settings?tab=notify")).body;
    expect(page).toContain("cook@example.com");
    expect(page).toContain('action="/admin/settings/notify/test"');
    expect(page).not.toContain("mail.example.com");
    expect((await post("/admin/settings/notify/test", {})).statusCode).toBe(403);
    const sent = await post("/admin/settings/notify/test", { _csrf: SESSION_CSRF });
    expect(sent.headers.location).toBe("/admin/settings?tab=notify&notice=test-mail-sent");
    expect(svc.notifier.sent).toEqual([{ kind: "test", detail: null }]);
    const soon = await post("/admin/settings/notify/test", { _csrf: SESSION_CSRF });
    expect(soon.headers.location).toBe("/admin/settings?tab=notify&notice=test-mail-cooldown");
    expect(svc.notifier.sent).toHaveLength(1);
    await svc.dispose();

    svc = testService({
      config: { SMTP_URL: "smtps://u:p@mail.example.com", NOTIFY_EMAIL: "cook@example.com" },
      testMail: new Error("535 authentication failed"),
    });
    const failed = await post("/admin/settings/notify/test", { _csrf: SESSION_CSRF });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).toContain("The test mail did not go out: 535 authentication failed");
    await svc.dispose();

    svc = testService();
    expect((await get("/admin/settings?tab=notify")).body).toContain(
      "Set SMTP_URL and NOTIFY_EMAIL",
    );
  });

  it("lists the effective configuration under advanced and masks secrets", async () => {
    const env = {
      MEALIE_URL: "http://mealie.example.com:9000",
      MEALIE_API_TOKEN: "mealie-token-secret-value",
      OPENAI_API_KEY: "sk-secret-value",
    };
    svc = testService({
      configEntries: effectiveConfig(loadConfig(env), env),
      config: { DATA_DIR: "/data" },
    });
    const body = (await get("/admin/settings?tab=system")).body;
    expect(body).toContain("Advanced: effective configuration");
    expect(body).toContain("/data");
    expect(body).toContain("SESSION_CHECK_MINUTES");
    expect(body).toContain("Minutes between session checks. Each check is a cheap account call.");
    expect(body).toContain(">http://mealie.example.com:9000</code>");
    expect(body).toContain("set (hidden)");
    expect(body).not.toContain("mealie-token-secret-value");
    expect(body).not.toContain("sk-secret-value");
  });

  it("falls back to the session tab for an unknown tab", async () => {
    svc = testService();
    expect((await get("/admin/settings?tab=%3Cx%3E")).body).toContain(
      'action="/admin/session/check"',
    );
  });
});

describe("review polish", () => {
  const VALIDATION =
    "The converted recipe failed validation: servingSize.steps[4].temperature 130 is above the limit";

  it("summarizes job errors in the language of the pages and folds the raw text away", async () => {
    svc = testService({ config: { UI_LANGUAGE: "de" } });
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1, title: "Brot" });
    svc.store.jobs.appendEvent(job.id, "error", {
      code: "failed",
      params: { stage: "validate", error: VALIDATION },
    });
    svc.store.jobs.finish(job.id, "failed", { error: VALIDATION });
    const other = svc.store.jobs.enqueue({ recipeId: "r-2", scale: 1, title: "Suppe" }).job;
    svc.store.jobs.appendEvent(other.id, "error", {
      code: "failed",
      params: { stage: "upload", error: "HTTP 503" },
    });
    svc.store.jobs.finish(other.id, "failed", { error: "HTTP 503" });

    const dashboard = (await get("/admin")).body;
    expect(dashboard).toContain("Hochladen zu Monsieur Cuisine fehlgeschlagen");
    expect(dashboard).toMatch(
      /<details[^>]*>\s*<summary[^>]*>Technische Details<\/summary>\s*<p[^>]*>\s*HTTP 503/,
    );

    const list = (await get("/admin/jobs")).body;
    expect(list).toContain("Die Umwandlung hat die Gerätegrenzen verletzt");
    expect(list).toContain("Hochladen zu Monsieur Cuisine fehlgeschlagen");
    expect(list).not.toContain("failed validation");

    const detail = (await get(`/admin/jobs/${job.id}`)).body;
    expect(detail).toContain("Die Umwandlung hat die Gerätegrenzen verletzt");
    const folded = /<details class="mt-1">[\s\S]*?<\/details>/.exec(detail)?.[0] ?? "";
    expect(folded).toContain("Technische Details");
    expect(folded).toContain("failed validation");
  });

  it("shows the cost with a wallet, a configured model in the success colour and done setup steps plainly", async () => {
    const { ICONS } = await import("./ui/icons.generated.js");
    svc = testService({ config: { LLM_PROVIDER: "openai", OPENAI_MODEL: "gpt-test" } });
    const done = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 }).job;
    svc.store.jobs.finish(done.id, "done");
    const body = (await get("/admin")).body;
    const cost = body.slice(body.indexOf("Cost (30 days)"), body.indexOf("Cost (30 days)") + 900);
    expect(cost).toContain(ICONS.wallet);
    expect(body).not.toContain(ICONS.coins);
    expect(body).toMatch(/bg-ok\s*"\s*aria-hidden="true"\s*><\/span\s*><span[^>]*>OpenAI</);
    expect(body).toContain("Finish the setup");
    expect(body).not.toContain("line-through");
  });
});
