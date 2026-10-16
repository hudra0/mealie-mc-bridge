import { afterEach, describe, expect, it, vi } from "vitest";
import { conversionResult, convertedRecipe, RECIPE_ID, WEBP } from "../testing/fakes.js";
import { TEST_ASSET_FILES } from "../testing/assets.js";
import {
  SESSION_CSRF,
  adminCookie,
  form,
  testService,
  type TestService,
} from "../testing/service.js";
import { CONTENT_SECURITY_POLICY, THUMBNAIL_PLACEHOLDER } from "./admin.js";

let svc: TestService | null = null;
afterEach(async () => {
  await svc?.dispose();
  svc = null;
});

const auth = { cookie: adminCookie() };
const get = (url: string, headers: Record<string, string> = auth) =>
  svc!.app.inject({ method: "GET", url, headers });
const post = (
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = auth,
) =>
  svc!.app.inject({
    method: "POST",
    url,
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    payload: form(fields),
  });

// Markup that must arrive as text wherever it is shown.
const EVIL = `<script>alert(1)</script>" onmouseover="alert(2)`;

// Every tag of a page, with its attribute values emptied: what is left are tag and
// attribute names.
function tags(body: string): string[] {
  return [...body.matchAll(/<[a-zA-Z][^>]*>/g)].map((match) => match[0].replace(/"[^"]*"/g, '""'));
}

function expectSafe(body: string, url: string) {
  expect(body, url).not.toContain("<script>alert(1)");
  expect(body, url).not.toContain('" onmouseover="alert(2)');
  for (const tag of tags(body)) {
    expect(tag, `${url}: event handler`).not.toMatch(/\son[a-z]+\s*=/i);
    expect(tag, `${url}: style attribute`).not.toMatch(/\sstyle\s*=/i);
  }
  expect(body, url).not.toMatch(/<style/i);
  expect(body, url).not.toMatch(/javascript:/i);
  // The only script is the external one, empty.
  const scripts = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  expect(scripts, url).toHaveLength(1);
  expect(scripts[0]?.[0], url).toMatch(/^<script src="\/admin\/assets\/app\.[0-9a-f]+\.js" defer>/);
  expect(scripts[0]?.[1]?.trim(), url).toBe("");
}

function hostileService() {
  svc = testService({
    mealieCheck: () => Promise.resolve({ username: EVIL }),
    mealie: { search: [{ id: "r9", slug: "evil", name: EVIL }] },
  });
  const recipe = convertedRecipe();
  recipe.servingSize.steps = [
    { kind: "text", title: EVIL, description: EVIL },
    { kind: "turbo", title: EVIL, description: EVIL, seconds: 5 },
    {
      kind: "customized",
      title: EVIL,
      temperature: 90,
      minutes: 3,
      seconds: 0,
      speed: 2,
      rotation: "left",
    },
  ];
  recipe.servingSize.ingredientGroups = [
    { name: EVIL, ingredients: [{ name: EVIL, amount: EVIL, unit: EVIL, isOptional: true }] },
  ];
  const { job } = svc.store.jobs.enqueue({
    recipeId: RECIPE_ID,
    scale: 1,
    title: EVIL,
    slug: EVIL,
  });
  svc.store.jobs.appendEvent(job.id, "info", {
    code: "recipe_loaded",
    params: { name: EVIL, slug: EVIL },
  });
  svc.store.jobs.appendEvent(job.id, "warn", { code: "converter_warning", params: { text: EVIL } });
  svc.store.jobs.appendEvent(job.id, "error", {
    code: "failed",
    params: { stage: "convert", error: EVIL },
  });
  svc.store.jobs.appendEvent(job.id, "info", EVIL);
  svc.store.jobs.finish(job.id, "failed", {
    error: EVIL,
    servingUnit: EVIL,
    servings: 2,
    provider: EVIL,
    model: EVIL,
    mcRecipeId: 1,
    mcRecipeUrl: `javascript:alert(3)`,
    conversion: {
      sourceHash: "abc",
      result: conversionResult({ recipe, reviewHints: [EVIL], warnings: [EVIL] }),
    },
    ingredients: {
      catalog: 0,
      cache: 0,
      search: 0,
      unresolved: 1,
      unresolvedNames: [EVIL],
      enabled: true,
    },
  });
  svc.autoLogin.saveCredentials("cook@example.com", "not-a-real-password");
  svc.store.settings.setJson("autologin.last_attempt", {
    at: "2026-10-15T10:00:00.000Z",
    ok: false,
    manual: true,
    code: "not_logged_in",
    detail: EVIL,
    screenshot: EVIL,
    progress: {
      reached: ["page_reached"],
      consentDismissals: 0,
      browser: { userAgent: EVIL, headless: "new" },
    },
  });
  return job.id;
}

describe("admin page safety", () => {
  it("sends the exact content security policy and the other headers on every page", async () => {
    svc = testService();
    for (const url of [
      "/admin",
      "/admin/jobs",
      "/admin/dry-run",
      "/admin/settings",
      "/admin/nope",
    ]) {
      const response = await get(url);
      expect(response.headers["content-security-policy"], url).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers["x-frame-options"], url).toBe("DENY");
      expect(response.headers["x-content-type-options"], url).toBe("nosniff");
      expect(response.headers["referrer-policy"], url).toBe("same-origin");
      expect(response.headers["cache-control"], url).toBe("no-store");
    }
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it("escapes hostile values on every page and tab and has no inline code", async () => {
    const id = hostileService();
    const pages = [
      "/admin",
      "/admin/jobs",
      `/admin/jobs?q=${encodeURIComponent(EVIL)}`,
      `/admin/jobs/${id}`,
      `/admin/jobs/${id}?tab=steps`,
      `/admin/jobs/${id}?tab=ingredients`,
      `/admin/jobs/${id}?tab=events`,
      "/admin/dry-run",
      `/admin/dry-run?recipe=${encodeURIComponent(EVIL)}`,
      "/admin/settings",
      "/admin/settings?tab=lidl",
      "/admin/settings?tab=mealie",
      "/admin/settings?tab=ai",
      "/admin/settings?tab=notify",
      "/admin/settings?tab=system",
      `/admin/${encodeURIComponent(EVIL)}`,
    ];
    for (const url of pages) {
      const response = await get(url);
      expect(response.statusCode, url).toBeLessThan(500);
      expectSafe(response.body, url);
    }
    const steps = (await get(`/admin/jobs/${id}?tab=steps`)).body;
    expect(steps).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;&quot; onmouseover=&quot;alert(2)",
    );
    // A link to anything but http or https is defused.
    expect((await get(`/admin/jobs/${id}`)).body).not.toContain("javascript:alert(3)");
    const login = await get("/admin/login", {});
    expectSafe(login.body, "/admin/login");
  });

  it("escapes a hostile dry-run conversion and search answer", async () => {
    svc = testService({ mealie: { search: [{ id: "r9", slug: EVIL, name: EVIL }] } });
    const matches = await get(`/admin/dry-run?recipe=${encodeURIComponent("nothing")}`);
    expectSafe(matches.body, "matches");
    const json = await get("/admin/dry-run/recipes?q=evil");
    expect(json.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(json.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("renders a failure of the page itself as the error page, without details", async () => {
    svc = testService();
    vi.spyOn(svc.store.jobs, "listRecent").mockImplementation(() => {
      throw new Error("database is locked: secret detail");
    });
    const response = await get("/admin/jobs");
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("Something went wrong");
    expect(response.body).not.toContain("secret detail");
    expect(response.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expectSafe(response.body, "500");
  });

  it("answers an unknown page with a 404 in the frame, after the login", async () => {
    svc = testService();
    const page = await get("/admin/does-not-exist");
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain("There is no page at this address.");
    expect(page.body).toContain('aria-label="Main navigation"');
    expect((await get("/admin/does-not-exist", {})).statusCode).toBe(303);
  });

  it("answers a body it cannot read with the error page", async () => {
    svc = testService();
    const response = await svc.app.inject({
      method: "POST",
      url: "/admin/session",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload: "x".repeat(70 * 1024),
    });
    expect(response.statusCode).toBe(413);
    expect(response.body).toContain("Request refused");
  });
});

describe("admin assets", () => {
  it("serves the built files without a login, with long cache headers and their types", async () => {
    svc = testService();
    const types: Record<string, string> = {
      "app.css": "text/css; charset=utf-8",
      "app.js": "text/javascript; charset=utf-8",
      "inter-latin.woff2": "font/woff2",
      "favicon.svg": "image/svg+xml",
      "favicon-32.png": "image/png",
    };
    for (const [name, type] of Object.entries(types)) {
      const [file, content] = TEST_ASSET_FILES[name]!;
      const response = await get(`/admin/assets/${file}`, {});
      expect(response.statusCode, name).toBe(200);
      expect(response.headers["content-type"], name).toBe(type);
      expect(response.headers["cache-control"], name).toBe("public, max-age=31536000, immutable");
      expect(response.headers["x-content-type-options"], name).toBe("nosniff");
      expect(response.headers["cross-origin-resource-policy"], name).toBe("same-origin");
      expect(response.body, name).toBe(content);
    }
    // The pages link the hashed names.
    const page = (await get("/admin/login", {})).body;
    expect(page).toContain('href="/admin/assets/app.0123456789.css"');
    expect(page).toContain('src="/admin/assets/app.abcdef0123.js"');
    expect(page).toContain('href="/admin/assets/favicon.3333333333.svg"');
  });

  it("serves nothing but the files of the manifest, and nothing else without a login", async () => {
    svc = testService();
    expect((await get("/admin/assets/manifest.json", {})).statusCode).toBe(404);
    expect((await get("/admin/assets/app.css", {})).statusCode).toBe(404);
    expect((await get("/admin/assets/..%2F..%2Fpackage.json", {})).statusCode).not.toBe(200);
    // A path that only starts like an asset still needs the login.
    for (const url of ["/admin/assets/../jobs", "/admin/assets/x/y", "/admin/assetsx"]) {
      const response = await svc.app.inject({ method: "GET", url, headers: {} });
      expect(response.statusCode, url).toBe(response.statusCode === 404 ? 404 : 303);
      expect(response.body, url).not.toContain("Main navigation");
    }
    // A POST to an asset path needs the login like any other address under /admin.
    const posted = await post("/admin/assets/app.0123456789.css", {}, {});
    expect(posted.statusCode).toBe(303);
    expect(posted.body).not.toContain("body{");
  });
});

describe("recipe thumbnails", () => {
  it("passes on Mealie's WebP image to a logged-in admin only and caches it", async () => {
    svc = testService();
    const url = `/admin/recipes/${RECIPE_ID}/thumbnail`;
    expect((await get(url, {})).statusCode).toBe(303);
    const image = await get(url);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/webp");
    expect(image.headers["cache-control"]).toBe("private, max-age=3600");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.rawPayload.equals(WEBP)).toBe(true);
    await get(url);
    expect(svc.mealie.getRecipeThumbnail).toHaveBeenCalledTimes(1);
  });

  it("answers with the placeholder for a missing image, anything that is not WebP or an error", async () => {
    for (const thumbnail of [
      null,
      Buffer.from("<html><script>x</script></html>"),
      new Error("down"),
    ]) {
      svc = testService({ mealie: { thumbnail } });
      const response = await get(`/admin/recipes/${RECIPE_ID}/thumbnail`);
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/svg+xml");
      expect(response.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(response.body).toBe(THUMBNAIL_PLACEHOLDER);
      await svc.dispose();
      svc = null;
    }
  });

  it("never asks Mealie for an id that is not a UUID", async () => {
    svc = testService();
    for (const id of ["../users/self", "abc-def", "00000000-0000-4000-8000-00000000000g"]) {
      const response = await get(`/admin/recipes/${encodeURIComponent(id)}/thumbnail`);
      expect(response.headers["content-type"], id).toBe("image/svg+xml");
    }
    expect(svc.mealie.getRecipeThumbnail).not.toHaveBeenCalled();
  });
});

describe("configuration privacy", () => {
  it("answers a visitor without a login alike, whatever is configured", async () => {
    const urls = [
      "/admin/settings/notify/test",
      "/admin/settings/credentials",
      "/admin/settings/credentials/delete",
      "/admin/settings/login",
      "/admin/no-such-form",
    ];
    const answers: string[] = [];
    for (const options of [
      { noAutoLogin: true },
      { config: { SMTP_URL: "smtps://u:p@mail.example.com", NOTIFY_EMAIL: "cook@example.com" } },
    ]) {
      svc = testService(options);
      for (const url of urls) {
        const response = await post(url, { _csrf: SESSION_CSRF }, {});
        answers.push(`${url} ${response.statusCode} ${String(response.headers.location)}`);
      }
      for (const method of ["PUT", "DELETE"] as const) {
        const response = await svc.app.inject({ method, url: "/admin/settings", headers: {} });
        answers.push(`${method} ${response.statusCode}`);
      }
      const shot = await get("/admin/settings/screenshots/x.png", {});
      answers.push(`shot ${shot.statusCode}`);
      await svc.dispose();
      svc = null;
    }
    expect(answers.slice(0, answers.length / 2)).toEqual(answers.slice(answers.length / 2));
    expect(answers.every((answer) => / 303 /.test(`${answer} `))).toBe(true);
  });

  it("says after the login that mail or the automatic login is not set up", async () => {
    svc = testService({ noAutoLogin: true });
    const mail = await post("/admin/settings/notify/test", { _csrf: SESSION_CSRF });
    expect(mail.statusCode).toBe(404);
    expect(mail.body).toContain("Mail is not set up");
    expect(svc.notifier.sent).toEqual([]);
    for (const url of ["/admin/settings/credentials", "/admin/settings/login"]) {
      const response = await post(url, { _csrf: SESSION_CSRF });
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).toContain("The automatic login is not available in this setup.");
    }
    expect((await get("/admin/settings/screenshots/x.png")).statusCode).toBe(404);
    const unknown = await post("/admin/no-such-form", { _csrf: SESSION_CSRF });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toContain("There is no page at this address.");
  });
});

describe("automatic reload", () => {
  it("reloads a page that answers a GET to its own GET address, never a response to a POST", async () => {
    svc = testService();
    svc.autoLogin.saveCredentials("cook@example.com", "not-a-real-password");
    const status = svc.autoLogin.status();
    vi.spyOn(svc.autoLogin, "status").mockReturnValue({ ...status, running: true });
    const page = await get("/admin/settings?tab=lidl&notice=login-started");
    expect(page.body).toMatch(/data-refresh="5"\s+data-refresh-url="\/admin\/settings\?tab=lidl"/);
    const invalid = await post("/admin/settings/credentials", {
      _csrf: SESSION_CSRF,
      email: "nope",
      password: "x",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("data-refresh");
    expect(invalid.body).not.toContain('http-equiv="refresh"');
    const job = svc.store.jobs.enqueue({ recipeId: RECIPE_ID, scale: 1 }).job;
    const list = await get("/admin/jobs?notice=job-queued&status=active");
    expect(list.body).toContain('data-refresh-url="/admin/jobs?status=active"');
    const detail = await get(`/admin/jobs/${job.id}?tab=events`);
    expect(detail.body).toContain(`data-refresh-url="/admin/jobs/${job.id}?tab=events"`);
  });
});

describe("theme", () => {
  it("stores the theme in a cookie with the form token and renders it", async () => {
    svc = testService();
    expect((await post("/admin/theme", { theme: "dark" })).statusCode).toBe(403);
    const response = await post("/admin/theme", {
      _csrf: SESSION_CSRF,
      theme: "dark",
      next: "/admin/jobs",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin/jobs");
    expect(String(response.headers["set-cookie"])).toBe(
      "mcb_theme=dark; Path=/admin; Max-Age=31536000; SameSite=Lax",
    );
    const page = await get("/admin", { cookie: `${auth.cookie}; mcb_theme=dark` });
    expect(page.body).toContain('data-theme="dark"');
    expect(page.body).toMatch(/aria-pressed="true"[^>]*>[\s\S]*?<\/button>/);
    // Anything else is the system theme, and the next page stays on the admin pages.
    const odd = await post("/admin/theme", {
      _csrf: SESSION_CSRF,
      theme: '"><script>',
      next: "https://evil.example.com",
    });
    expect(String(odd.headers["set-cookie"])).toContain("mcb_theme=system;");
    expect(odd.headers.location).toBe("/admin");
    const hostile = await get("/admin", { cookie: `${auth.cookie}; mcb_theme="><script>` });
    expect(hostile.body).toContain('data-theme="system"');
  });
});
