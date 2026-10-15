import { afterEach, describe, expect, it, vi } from "vitest";
import { McNetworkError, McSessionError } from "../mc/index.js";
import { ConverterNotConfiguredError } from "../pipeline/converter-port.js";
import { LoginThrottle } from "./admin-auth.js";
import { loadConfig } from "../config.js";
import { effectiveConfig } from "../config-reference.js";
import { TOKEN_MASK, relativeTime } from "./admin-views.js";
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
    expect(page.body).toContain("signed in as admin");
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
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
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
  it("shows the session, the queue and recent jobs, with titles escaped", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({
      recipeId: RECIPE_ID,
      scale: 1,
      title: "<script>alert(1)</script>",
    });
    svc.store.jobs.finish(job.id, "failed", { error: 'boom "quoted" <b>' });
    const body = (await get("/admin")).body;
    expect(body).toContain("Monsieur Cuisine session");
    expect(body).toContain('<span class="badge muted">unknown</span>');
    expect(body).toMatch(/aria-current="page"\s*>Overview</);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("boom &quot;quoted&quot; &lt;b&gt;");
    expect(body).toContain(`name="_csrf" value="${SESSION_CSRF}"`);
    expect(body).toMatch(/href="\/admin\/jobs\?status=failed"\s*><span class="count">1<\/span>/);
    // The newest failed job is the last error.
    expect(body).toContain("Failed job at");
  });

  it("says on the settings page what the recipe status means", async () => {
    svc = testService();
    expect((await get("/admin/settings")).body).toContain("saved privately on your device");
    await svc.dispose();
    svc = testService({ config: { MC_RECIPE_STATUS: "draft" } });
    expect((await get("/admin/settings")).body).toContain("do not show up on the machine");
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
    expect(body).not.toContain("(expired)");
    expect(body).toContain("since the login");
    await svc.dispose();

    // An expired cookie: it was not a 14-day login when stored, so the age counts from then.
    svc = testService({ seedCookie: loginCookie("2020-01-15T10:00:00.000Z") });
    body = (await get("/admin/settings")).body;
    expect(body).toMatch(/2020-01-15 \d\d:00:00 [^<]* \(expired\)/);
    expect(body).toContain("since it was stored in the bridge");
    await svc.dispose();

    // A login that ends long after it was stored here: its start is unknown.
    svc = testService({ seedCookie: loginCookie("2099-01-15T10:00:00.000Z") });
    body = (await get("/admin/settings")).body;
    expect(body).toMatch(/2099-01-1\d \d\d:00:00/);
    expect(body).not.toContain("(expired)");
    expect(body).toContain("h since it was stored in the bridge");
  });

  it("shows a known notice and ignores unknown ones", async () => {
    svc = testService();
    expect((await get("/admin?notice=session-saved")).body).toContain("Session saved.");
    expect((await get("/admin?notice=%3Cscript%3E")).body).not.toContain("<script>");
  });

  it("shows the worker state", async () => {
    svc = testService({ seedCookie: "a=1" });
    expect((await get("/admin")).body).toContain("stopped");
    svc.worker.start();
    expect((await get("/admin")).body).toContain(">running<");
    await svc.session.onSessionError("expired");
    expect((await get("/admin")).body).toContain("paused until the session works");
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
    });
    const dashboard = (await get("/admin")).body;
    expect(dashboard).toContain('<html lang="de">');
    expect(dashboard).toContain("Monsieur-Cuisine-Sitzung");
    expect(dashboard).toContain('<span class="badge muted">unbekannt</span>');
    expect(dashboard).toContain("Erste Schritte");
    expect(dashboard).toContain("Letzte 10 Aufträge");
    const settings = (await get("/admin/settings")).body;
    expect(settings).toContain("<code>Cookie</code>");
    expect(settings).toContain("Drei Wege, die Sitzung zu erneuern");
    expect((await get("/admin?notice=job-cancelled")).body).toContain("Auftrag abgebrochen.");
    const detail = (await get(`/admin/jobs/${job.id}`)).body;
    expect(detail).toContain("Neu senden erzwingen");
    expect(detail).toContain("3 aus dem Katalog, 1 aus dem Cache, 0 aus der Suche, 2 ohne ID");
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
});

describe("jobs", () => {
  it("lists jobs with filters and paging", async () => {
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
    const done = (await get("/admin/jobs?status=done")).body;
    expect(done).toContain("Tomato soup");
    expect(done).not.toContain("Bread");
    expect(done).toContain('<option value="done" selected>');
    const searched = (await get("/admin/jobs?q=bread&status=bogus&offset=-5")).body;
    expect(searched).toContain("Bread");
    expect(searched).not.toContain("Tomato soup");
    expect((await get("/admin/jobs?offset=50")).body).toContain("Newer");
  });

  it("shows a job with its events, links, usage and actions", async () => {
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
    expect(body).toContain("100 input (20 cached), 50 output tokens");
    expect(body).toContain("$0.5000");
    expect(body).toContain("Queued with scale 1");
    expect(body).toContain("Force rebuild");
    expect(body).not.toContain(">Cancel<");
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
    expect((await get(`/admin/jobs/${id}`)).body).toContain("Rezept 4242 im Editor öffnen");
    expect((await get("/admin/jobs")).body).toContain(">Rezept 4242</a");
    expect((await get("/admin/jobs")).body).not.toContain("Entwurf 4242");
    await svc.dispose();

    svc = testService({ config: { UI_LANGUAGE: "de", MC_RECIPE_STATUS: "draft" } });
    id = finishedJob(svc);
    expect((await get(`/admin/jobs/${id}`)).body).toContain("Entwurf 4242 im Editor öffnen");
    expect((await get("/admin")).body).toContain(">Entwurf 4242</a");
  });

  it("shows where the ingredient ids came from and the names without one", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    expect((await get(`/admin/jobs/${job.id}`)).body).not.toContain("Without id");
    svc.store.jobs.finish(job.id, "done", {
      ingredients: {
        catalog: 7,
        cache: 2,
        search: 1,
        unresolved: 2,
        unresolvedNames: ["Testzutat <Z>", "Testzutat Y"],
        enabled: true,
      },
    });
    const body = (await get(`/admin/jobs/${job.id}`)).body;
    expect(body).toContain("7 catalog, 2 cache, 1 search, 2 without id");
    expect(body).toContain("Without id");
    expect(body).toContain("<li>Testzutat &lt;Z&gt;</li>");
    expect(body).toContain("<li>Testzutat Y</li>");

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
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain("resolution off (3 without id)");
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
    expect(body).toContain("<h3>Review hints</h3>");
    expect(body).toContain("<li>Garzeit &lt;b&gt;prüfen&lt;/b&gt;</li>");
    expect(body.split("<li>Menge, Salz</li>")).toHaveLength(2);
    expect(body).toContain("<li>Brühe heiß zugeben</li>");
    expect(body).toContain("<h3>Converter warnings</h3>");
    expect(body).toContain('<li class="warn">Fill level close to the limit</li>');
  });

  it("offers only the forced rebuild for a skipped job", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.finish(job.id, "skipped", {
      mcRecipeId: 4242,
      mcRecipeUrl: "https://example.com/r",
    });
    const body = (await get(`/admin/jobs/${job.id}`)).body;
    expect(body).toContain(">Force rebuild<");
    expect(body).not.toContain(">Retry<");
    svc.store.jobs.update(job.id, { status: "failed" });
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain(">Retry<");
  });

  it("answers 404 for an unknown job", async () => {
    svc = testService();
    expect((await get("/admin/jobs/unknown")).statusCode).toBe(404);
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

  it("refuses to retry a running job", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.claimNext();
    const response = await post(`/admin/jobs/${job.id}/retry`, { _csrf: SESSION_CSRF });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("The job is running");
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain("Running jobs cannot be changed.");
  });

  it("cancels a queued job but not a finished one", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain(">Cancel<");
    const cancelled = await post(`/admin/jobs/${job.id}/cancel`, { _csrf: SESSION_CSRF });
    expect(cancelled.statusCode).toBe(303);
    expect(svc.store.jobs.get(job.id)?.status).toBe("cancelled");
    const again = await post(`/admin/jobs/${job.id}/cancel`, { _csrf: SESSION_CSRF });
    expect(again.statusCode).toBe(409);
  });
});

const convertDryRun = () =>
  post("/admin/dry-run", { recipe: "kurbis-linsen-suppe", convert: "1", _csrf: SESSION_CSRF });

describe("dry run", () => {
  it("shows the form without a recipe", async () => {
    svc = testService();
    const body = (await get("/admin/dry-run")).body;
    expect(body).toContain('name="recipe"');
    expect(body).not.toContain("Converter input");
  });

  it("previews the Markdown input and the ingredients without calling the converter", async () => {
    const converter = fakeConverter();
    svc = testService({ converter });
    const body = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe&scale=2")).body;
    expect(body).toContain("Converter input (Markdown)");
    expect(body).toContain("# Kürbis-Linsen-Suppe");
    expect(body).toContain("Portionen: 4 → 8");
    expect(body).toContain("Convert without uploading");
    expect(body).toContain('<input type="hidden" name="convert" value="1" />');
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
    const input = body.slice(body.indexOf("<pre>"), body.indexOf("</pre>"));
    expect(input).toContain("Tags: Vegetarisch");
    expect(input).not.toContain("Monsieur Cuisine");
  });

  it("escapes a recipe title with markup", async () => {
    svc = testService({ mealie: { recipe: mealieRecipe({ name: "<script>alert(1)</script>" }) } });
    const body = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe")).body;
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("says when the recipe cannot be loaded", async () => {
    svc = testService();
    const response = await get("/admin/dry-run?recipe=missing&scale=abc");
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain("The recipe could not be loaded: no recipe missing");
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

  it("converts without uploading and shows steps, validation and review hints", async () => {
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
    expect(body).toContain("fake / fake-model, 1 attempt<");
    expect(body).toContain('<span class="ok">passed</span>');
    expect(body).toContain("228 Suppen &amp; Eintöpfe, 588 Vegetarisch, 260 Hauptgerichte");
    expect(body).toContain("&lt;b&gt;Garzeit&lt;/b&gt; prüfen");
    expect(body).toContain("Fill level close to the limit");
    expect(body).toContain("20 min 0 s, 100 °C, speed 1, rotation left");
    expect(body).toContain("customized");
    expect(body).toContain("800 g Kürbis");
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
    expect(body).toContain("dropped unknown ids 9999");
  });

  it("shows a converter failure", async () => {
    svc = testService({ converter: fakeConverter(new ConverterNotConfiguredError()) });
    const body = (await convertDryRun()).body;
    expect(body).toContain("The conversion failed: converter not configured");
  });

  it("tells whether the recipe was already sent", async () => {
    svc = testService();
    const first = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe")).body;
    expect(first).toMatch(/<dd>\s*no\s*<\/dd>/);
    const hash = /<code>([0-9a-f]{16})<\/code>/.exec(first)?.[1] ?? "";
    // Record a draft for the same content and check the page again.
    const { sourceHash } = await import("../pipeline/source-hash.js");
    const { normalizeIngredients } = await import("../ingredients/index.js");
    const recipe = svc.mealie.recipe;
    const fullHash = sourceHash(recipe, normalizeIngredients(recipe), 1);
    expect(fullHash.startsWith(hash)).toBe(true);
    svc.store.mcRecipes.record({
      mealieRecipeId: recipe.id,
      scale: 1,
      sourceHash: fullHash,
      mcRecipeId: 7,
      mcRecipeUrl: "https://www.monsieur-cuisine.com/de/create-recipe?recipe-id=7",
    });
    const second = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe")).body;
    expect(second).toContain("a job would be skipped unless forced");
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
});

describe("page layout", () => {
  it("shows the Monsieur Cuisine session state in the header", async () => {
    svc = testService({ seedCookie: "a=1" });
    await svc.session.check();
    const body = (await get("/admin/jobs")).body;
    expect(body).toMatch(/MC session\s*<span class="badge ok"\s*>valid<\/span/);
    expect(body).toContain('href="/admin/settings"');
  });

  it("reloads the job list and a job page while a job is queued or running", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const list = (await get("/admin/jobs?status=queued&notice=job-queued")).body;
    expect(list).toContain('http-equiv="refresh"');
    expect(list).toContain('content="5; url=/admin/jobs?status=queued"');
    expect(list).toContain("reloads every 5 seconds");
    const detail = (await get(`/admin/jobs/${job.id}`)).body;
    expect(detail).toContain(`content="5; url=/admin/jobs/${job.id}"`);
    svc.store.jobs.finish(job.id, "done", {});
    expect((await get(`/admin/jobs/${job.id}`)).body).not.toContain('http-equiv="refresh"');
    expect((await get("/admin/jobs")).body).not.toContain('http-equiv="refresh"');
  });

  it("shows event times relative and absolute", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    const body = (await get(`/admin/jobs/${job.id}`)).body;
    expect(body).toContain('<ol class="timeline">');
    expect(body).toMatch(/<time datetime="[^"]+">(now|\d+ seconds? ago)<\/time>/);
    expect(body).toMatch(/class="abs muted">\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
  });

  it("offers scale and an immediate conversion in the dry-run form", async () => {
    svc = testService();
    const body = (await get("/admin/dry-run")).body;
    expect(body).toContain('name="scale"');
    expect(body).toContain('type="checkbox" name="convert" value="1"');
    expect(body).toContain(`name="_csrf" value="${SESSION_CSRF}"`);
  });
});

describe("relativeTime", () => {
  it("picks seconds, minutes, hours or days", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    expect(relativeTime("2026-10-15T11:59:30.000Z", now, "en")).toBe("30 seconds ago");
    expect(relativeTime("2026-10-15T11:57:00.000Z", now, "en")).toBe("3 minutes ago");
    expect(relativeTime("2026-10-15T09:00:00.000Z", now, "de")).toBe("vor 3 Stunden");
    expect(relativeTime("2026-10-13T12:00:00.000Z", now, "en")).toBe("2 days ago");
    expect(relativeTime("not a date", now, "en")).toBe("not a date");
  });
});

describe("settings page", () => {
  const PASSWORD = "not-a-real-password";

  it("stores the Lidl account and never shows the password", async () => {
    svc = testService();
    const empty = await get("/admin/settings");
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain("No account stored.");
    expect(empty.body).toContain("headless Chromium available");
    const saved = await post("/admin/settings/credentials", {
      _csrf: SESSION_CSRF,
      email: "cook@example.com",
      password: PASSWORD,
    });
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe("/admin/settings?notice=credentials-saved");
    const body = (await get("/admin/settings?notice=credentials-saved")).body;
    expect(body).toContain("Stored account: cook@example.com");
    expect(body).toContain("Lidl account saved, encrypted.");
    expect(body).toContain("stored; leave empty to keep it");
    expect(body).not.toContain(PASSWORD);
    expect(body).toContain('action="/admin/settings/login"');
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
    expect(response.headers.location).toBe("/admin/settings?notice=credentials-deleted");
    expect(svc.autoLogin.hasCredentials()).toBe(false);
  });

  it("tests the login in the background and stores the new session", async () => {
    svc = testService();
    expect((await post("/admin/settings/login", { _csrf: SESSION_CSRF })).headers.location).toBe(
      "/admin/settings?notice=login-no-credentials",
    );
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    const response = await post("/admin/settings/login", { _csrf: SESSION_CSRF });
    expect(response.headers.location).toBe("/admin/settings?notice=login-started");
    await vi.waitFor(() => expect(svc?.session.status().state).toBe("valid"));
    expect(svc.validate).toHaveBeenCalledWith(
      expect.stringContaining("lidl_sso_id_token=id-token"),
    );
    const body = (await get("/admin/settings")).body;
    expect(body).toMatch(/succeeded \(manual test\)/);
    expect(body).not.toContain('http-equiv="refresh"');
    // The next manual test waits three minutes.
    expect(body).toContain("Next manual test from");
    const again = await post("/admin/settings/login", { _csrf: SESSION_CSRF });
    expect(again.headers.location).toBe("/admin/settings?notice=login-cooldown");
  });

  it("shows a failed attempt with its reason and serves the screenshot", async () => {
    svc = testService({ browser: { form: "none" } });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings")).body;
    expect(body).toContain("failed (manual test)");
    expect(body).toContain("No login form showed up");
    const link = /href="(\/admin\/settings\/screenshots\/[^"]+)"/.exec(body)?.[1];
    expect(link).toBeDefined();
    const image = await get(link ?? "");
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect((await get("/admin/settings/screenshots/..%2Fbridge.db")).statusCode).toBe(404);
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
    const body = (await get("/admin/settings")).body;
    expect(body).toContain("The site reported a wrong password.");
    expect(body).toContain("wrong password reported by the site");
    expect(body).toContain("stuck after: password entered");
    expect(body).toContain("Steps reached:");
    const steps = [...body.matchAll(/<li>([^<]+)<\/li>/g)].map((match) => match[1]);
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
      progress: { reached: ["page_reached", "future_step"], consentDismissals: 0 },
    });
    const body = (await get("/admin/settings")).body;
    expect(body).toContain("<li>login page reached</li>");
    expect(body).not.toContain("future_step");
    expect(body).not.toContain("<li>undefined</li>");
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
    const body = (await get("/admin/settings")).body;
    expect(body).toContain("Erreichte Schritte:");
    expect(body).toContain("<li>Zustimmungsdialog abgelehnt (2×)</li>");
    expect(body).toContain("<li>Weiter geklickt</li>");
  });

  it("says when the login confirmed the terms and chose the device", async () => {
    svc = testService({
      config: { UI_LANGUAGE: "de" },
      browser: { form: "continue", loginWorks: true, terms: true, deviceChooser: true },
    });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings")).body;
    expect(body).toContain("Nutzungsbedingungen wurden in deinem Namen bestätigt.");
    expect(body).toContain("Als Gerät wurde MC Smart gewählt.");
  });

  it("names an e-mail address the site does not know", async () => {
    svc = testService({
      browser: { form: "continue", unknownAccount: "Konto nicht gefunden." },
    });
    svc.autoLogin.saveCredentials("cook@example.com", PASSWORD);
    await svc.session.loginNow();
    const body = (await get("/admin/settings")).body;
    expect(body).toContain("The site does not know the stored e-mail address.");
    expect(body).not.toContain("terms of use were confirmed");
  });

  it("says when the browser is missing", async () => {
    svc = testService({ browser: { unavailable: "Playwright is not installed" } });
    expect((await get("/admin/settings")).body).toContain(
      "not available: Playwright is not installed",
    );
  });
});

describe("admin UI guidance", () => {
  const PAGES = ["/admin", "/admin/jobs", "/admin/dry-run", "/admin/settings"];

  it("puts navigation, a lead paragraph and the theme on every page, without scripts", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    for (const url of [...PAGES, `/admin/jobs/${job.id}`]) {
      const body = (await get(url)).body;
      expect(body, url).toContain('<nav aria-label="Main navigation">');
      expect(body, url).toContain('<p class="lead">');
      expect(body, url).toContain("@media (prefers-color-scheme: dark)");
      expect(body, url).toContain("@media print");
      // No JavaScript: no script elements, no inline event handlers, no javascript: links.
      expect(body, url).not.toMatch(/<script/i);
      expect(body, url).not.toMatch(/\son[a-z]+\s*=/i);
      expect(body, url).not.toMatch(/javascript:/i);
    }
  });

  it("shows the getting-started checklist with an unreachable Mealie", async () => {
    svc = testService({
      mealieCheck: () => Promise.reject(new Error("Mealie GET /api/users/self failed: no answer")),
    });
    const body = (await get("/admin")).body;
    expect(body).toContain("Getting started");
    for (const step of [
      "Mealie reachable with the API token",
      "Monsieur Cuisine session",
      "Automatic login (recommended)",
      "Recipe action in Mealie",
      "First recipe sent",
    ]) {
      expect(body, step).toContain(step);
    }
    expect(body).toContain("Mealie at <code>http://mealie:9000</code> did not accept the request.");
    expect(body).toContain("Mealie GET /api/users/self failed: no answer");
    expect(body).toContain("<code>MEALIE_API_TOKEN</code>");
    expect(body).toContain("Not configured.");
    expect(body).toContain('href="/admin/settings#autologin"');
    expect(body).toContain("Mealie has not called the bridge yet.");
    expect(body).toContain("Settings › Data Management › Recipe Actions");
  });

  it("reports a reachable Mealie and caches the answer", async () => {
    const check = vi.fn(() => Promise.resolve({ username: "bridge" }));
    svc = testService({ mealieCheck: check });
    expect((await get("/admin")).body).toContain(
      "Mealie at <code>http://mealie:9000</code> answers and accepts the API token.",
    );
    await get("/admin");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("says when Mealie was not checked", async () => {
    svc = testService();
    expect((await get("/admin")).body).toContain("Not checked. Mealie address:");
  });

  it("masks the webhook token until the details element is opened", async () => {
    svc = testService();
    const body = (await get("/admin")).body;
    const masked = `http://mc-bridge:3000/hooks/mealie/${TOKEN_MASK}`;
    expect(body).toContain(`<code class="url">${masked}</code>`);
    const details = /<details>([\s\S]*?)<\/details>/.exec(body)?.[1] ?? "";
    expect(details).toContain("<summary>Show the URL with the token</summary>");
    expect(details).toContain(`http://mc-bridge:3000/hooks/mealie/${WEBHOOK_TOKEN}`);
    // The address the page was opened with, as the second choice.
    expect(details).toContain(`http://localhost:80/hooks/mealie/${WEBHOOK_TOKEN}`);
    // Outside the details element the token does not appear.
    expect(body.replace(details, "")).not.toContain(WEBHOOK_TOKEN);
  });

  it("ticks the recipe action and the first job once jobs arrived", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.finish(job.id, "done", { mcRecipeId: 4242, costUsd: 0.0123 });
    const body = (await get("/admin")).body;
    expect(body).toContain("Mealie has called the bridge: 1 job so far.");
    expect(body).toContain("1 recipe sent.");
    expect(body).toContain("$0.0123");
    expect(body).toContain("No errors so far.");
  });

  it("explains every section of the settings page and masks secrets", async () => {
    const env = {
      MEALIE_URL: "http://mealie.example.com:9000",
      MEALIE_API_TOKEN: "mealie-token-secret-value",
      OPENAI_API_KEY: "sk-secret-value",
    };
    svc = testService({ configEntries: effectiveConfig(loadConfig(env), env) });
    const body = (await get("/admin/settings")).body;
    expect(body).toMatch(/aria-current="page"\s*>Settings</);
    for (const text of [
      'id="session"',
      "Three ways to renew the session",
      "npm run mc:login -- --bridge",
      "Asks Monsieur Cuisine whether the stored cookie still works.",
      'id="autologin"',
      "How often: an automatic login runs at most once per hour",
      "encrypted with <code>SETTINGS_KEY</code>",
      "Delete the account with the button below.",
      "keeps a screenshot of the login page",
      "The address you log in with on www.monsieur-cuisine.com",
      'id="language"',
      "Language of the recipes the bridge writes",
      'id="config"',
      "Effective configuration",
    ]) {
      expect(body, text).toContain(text);
    }
    // Every variable with the description from the configuration reference.
    expect(body).toContain("<code>SESSION_CHECK_MINUTES</code>");
    expect(body).toContain("Minutes between session checks. Each check is a cheap account call.");
    expect(body).toContain(">http://mealie.example.com:9000</code>");
    expect(body).toContain("set (hidden)");
    expect(body).not.toContain("mealie-token-secret-value");
    expect(body).not.toContain("sk-secret-value");
  });

  it("says when the automatic login is not part of the service", async () => {
    svc = testService({ noAutoLogin: true });
    expect((await get("/admin/settings")).body).toContain(
      "The automatic login is not available in this setup.",
    );
    expect((await get("/admin")).body).toContain("Not available in this setup.");
    const posted = await post("/admin/settings/credentials", {
      _csrf: SESSION_CSRF,
      email: "a@example.com",
    });
    expect(posted.statusCode).toBe(404);
  });

  it("shows empty states with what to do next", async () => {
    svc = testService();
    expect((await get("/admin")).body).toContain("No jobs yet.");
    const jobs = (await get("/admin/jobs")).body;
    expect(jobs).toContain("No jobs yet.");
    expect(jobs).toContain("pick the bridge&#39;s recipe action from the three-dot menu");
    expect(jobs).toContain("What the statuses mean");
    expect(jobs).toContain("Waiting for a valid Monsieur Cuisine session.");
    expect((await get("/admin/jobs?status=failed")).body).toContain("No jobs match this filter.");
    expect((await get("/admin/jobs?offset=50")).body).toContain("No older jobs.");
  });

  it("highlights what to check before cooking and lists the ingredient ids", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1, slug: "kurbis-suppe" });
    svc.store.jobs.update(job.id, { startedAt: "2026-10-15T10:00:00.000Z" });
    svc.store.jobs.finish(job.id, "done", {
      mcRecipeId: 4242,
      mcRecipeUrl: "https://www.monsieur-cuisine.com/de/create-recipe?recipe-id=4242",
      conversion: {
        sourceHash: "abc",
        result: conversionResult({ reviewHints: ["Garzeit prüfen"] }),
      },
      ingredients: {
        catalog: 1,
        cache: 0,
        search: 0,
        unresolved: 1,
        unresolvedNames: ["Rote Linsen"],
        enabled: true,
      },
    });
    const body = (await get(`/admin/jobs/${job.id}`)).body;
    expect(body).toContain('<section class="callout" aria-labelledby="check">');
    expect(body).toContain("Check before cooking");
    expect(body).toContain("<li>Garzeit prüfen</li>");
    expect(body).toContain("With id (1)");
    expect(body).toContain("<li>Kürbis</li>");
    expect(body).toContain("Without id (1)");
    expect(body).toContain("<li>Rote Linsen</li>");
    expect(body).toContain("Converts the recipe again and uploads it even if it is unchanged.");
    expect(body).toContain("It reuses the stored conversion if the recipe has not changed");
    expect(body).toContain('class="button primary"');
    expect(body).toContain("open in Mealie");
  });

  it("explains the dry run and what it costs", async () => {
    svc = testService();
    const body = (await get("/admin/dry-run")).body;
    expect(body).toContain("without sending anything to Monsieur Cuisine");
    expect(body).toContain("Calls the language model, which costs money");
    expect(body).toMatch(/aria-current="page"\s*>Dry run</);
  });
});
