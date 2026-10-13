import { afterEach, describe, expect, it } from "vitest";
import { McNetworkError, McSessionError } from "../mc/index.js";
import { ConverterNotConfiguredError } from "../pipeline/converter-port.js";
import {
  RECIPE_ID,
  conversionResult,
  convertedRecipe,
  fakeConverter,
  mealieRecipe,
} from "../testing/fakes.js";
import { FORM_TOKEN, basicAuth, form, testService, type TestService } from "../testing/service.js";

let svc: TestService | null = null;
afterEach(async () => {
  await svc?.dispose();
  svc = null;
});

const auth = { authorization: basicAuth() };
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
  it("asks for credentials", async () => {
    svc = testService();
    const response = await get("/admin", {});
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe(
      'Basic realm="mc-bridge admin", charset="UTF-8"',
    );
    expect((await get("/admin", { authorization: basicAuth("admin", "wrong") })).statusCode).toBe(
      401,
    );
    expect(
      (await get("/admin", { authorization: basicAuth("root", "correct horse") })).statusCode,
    ).toBe(401);
    expect((await get("/admin/jobs", {})).statusCode).toBe(401);
    expect(
      (await post("/admin/session", { _csrf: FORM_TOKEN, cookie: "a=1" }, {})).statusCode,
    ).toBe(401);
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
      { cookie: "a=1", _csrf: FORM_TOKEN },
      { ...formHeaders, origin: "https://evil.example.com" },
    );
    expect(response.statusCode).toBe(403);
    const same = await post(
      "/admin/session/check",
      { _csrf: FORM_TOKEN },
      { ...formHeaders, origin: "http://localhost:80", host: "localhost:80" },
    );
    expect(same.statusCode).toBe(303);
    const garbage = await post(
      "/admin/session/check",
      { _csrf: FORM_TOKEN },
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
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("boom &quot;quoted&quot; &lt;b&gt;");
    expect(body).toContain(`name="_csrf" value="${FORM_TOKEN}"`);
    expect(body).toContain('href="/admin/jobs?status=failed">1</a>');
    expect(body).toContain("saved on the device only");
  });

  it("says that drafts do not show up on the device", async () => {
    svc = testService({ config: { MC_RECIPE_STATUS: "draft" } });
    expect((await get("/admin")).body).toContain("kept as drafts, not shown on the device");
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
    expect(dashboard).toContain("<code>Cookie</code>");
    expect(dashboard).toContain("Letzte Aufträge");
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
      _csrf: FORM_TOKEN,
      cookie: "Cookie: a=1; b=2",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin?notice=session-saved");
    expect(svc.validate).toHaveBeenCalledWith("a=1; b=2");
    expect(svc.session.status().state).toBe("valid");
  });

  it("refuses an empty cookie", async () => {
    svc = testService();
    const response = await post("/admin/session", { _csrf: FORM_TOKEN, cookie: "  " });
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
      _csrf: FORM_TOKEN,
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
    const response = await post("/admin/session", { _csrf: FORM_TOKEN, cookie: "a=1" });
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain("could not be checked");
  });

  it("runs the session check on request", async () => {
    svc = testService({ seedCookie: "a=1" });
    const response = await post("/admin/session/check", { _csrf: FORM_TOKEN });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin?notice=session-checked");
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
    expect(body).toContain("Testzutat &lt;Z&gt;, Testzutat Y");

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

  it("answers 404 for an unknown job", async () => {
    svc = testService();
    expect((await get("/admin/jobs/unknown")).statusCode).toBe(404);
    expect((await post("/admin/jobs/unknown/retry", { _csrf: FORM_TOKEN })).statusCode).toBe(404);
  });

  it("retries and force-rebuilds a finished job", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.finish(job.id, "failed", { error: "boom" });
    const retry = await post(`/admin/jobs/${job.id}/retry`, { _csrf: FORM_TOKEN });
    expect(retry.statusCode).toBe(303);
    expect(retry.headers.location).toBe(`/admin/jobs/${job.id}?notice=job-queued`);
    expect(svc.store.jobs.get(job.id)).toMatchObject({ status: "queued", force: false });

    svc.store.jobs.finish(job.id, "skipped");
    const forced = await post(`/admin/jobs/${job.id}/retry`, { _csrf: FORM_TOKEN, force: "1" });
    expect(forced.headers.location).toBe(`/admin/jobs/${job.id}?notice=job-forced`);
    expect(svc.store.jobs.get(job.id)).toMatchObject({ status: "queued", force: true });
  });

  it("refuses to retry a running job", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    svc.store.jobs.claimNext();
    const response = await post(`/admin/jobs/${job.id}/retry`, { _csrf: FORM_TOKEN });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("The job is running");
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain("Running jobs cannot be changed.");
  });

  it("cancels a queued job but not a finished one", async () => {
    svc = testService();
    const { job } = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 });
    expect((await get(`/admin/jobs/${job.id}`)).body).toContain(">Cancel<");
    const cancelled = await post(`/admin/jobs/${job.id}/cancel`, { _csrf: FORM_TOKEN });
    expect(cancelled.statusCode).toBe(303);
    expect(svc.store.jobs.get(job.id)?.status).toBe("cancelled");
    const again = await post(`/admin/jobs/${job.id}/cancel`, { _csrf: FORM_TOKEN });
    expect(again.statusCode).toBe(409);
  });
});

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

  it("refuses to convert without the form token", async () => {
    const converter = fakeConverter();
    svc = testService({ converter });
    const body = (await get("/admin/dry-run?recipe=kurbis-linsen-suppe&convert=1")).body;
    expect(body).toContain("The conversion link has expired");
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
    const response = await get(
      `/admin/dry-run?recipe=kurbis-linsen-suppe&scale=1&convert=1&_csrf=${FORM_TOKEN}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(converter.requests).toHaveLength(1);
    expect(svc.mc.calls).toEqual(["mc.getCategories"]);
    expect(svc.mc.payloads).toEqual([]);
    expect(body).toContain("fake / fake-model, 1 attempt(s)");
    expect(body).toContain('<span class="ok">passed</span>');
    expect(body).toContain("228 Suppen &amp; Eintöpfe, 588 Vegetarisch, 260 Hauptgerichte");
    expect(body).toContain("&lt;b&gt;Garzeit&lt;/b&gt; prüfen");
    expect(body).toContain("Fill level close to the limit");
    expect(body).toContain("20 min 0 s, 100 °C, speed 1, rotation left");
    expect(body).toContain("customized");
    expect(body).toContain("800 g Kürbis");
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
    const body = (
      await get(`/admin/dry-run?recipe=kurbis-linsen-suppe&convert=1&_csrf=${FORM_TOKEN}`)
    ).body;
    expect(body).toContain("error(s)");
    expect(body).toContain("servingSize.steps[2]");
    expect(body).toContain("dropped unknown ids 9999");
  });

  it("shows a converter failure", async () => {
    svc = testService({ converter: fakeConverter(new ConverterNotConfiguredError()) });
    const body = (
      await get(`/admin/dry-run?recipe=kurbis-linsen-suppe&convert=1&_csrf=${FORM_TOKEN}`)
    ).body;
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
