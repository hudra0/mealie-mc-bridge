import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../src/mc/index.js";
import { browserLogin, buildCookieHeader } from "../src/session/browser-login.js";
import {
  LOGIN_COOKIES,
  fakeBrowser,
  loopClock,
  type FakeBrowserScript,
} from "../src/testing/browser.js";
import {
  EXIT,
  HEADLESS_TIMEOUT_MS,
  VISIBLE_TIMEOUT_MS,
  UsageError,
  parseLoginArgs,
  publicListUrl,
  runLogin,
  sendToBridge,
} from "./mc-login.js";

const PASSWORD = "not-a-real-password";

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

// A stand-in for the bridge's /admin/api/session.
async function fakeBridge(
  answer: (request: Received) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { saved: true, session: { state: "valid" } },
  }),
): Promise<{ url: string; received: Received[]; server: Server }> {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const entry: Received = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      };
      received.push(entry);
      const reply = answer(entry);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, server };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

// Real fetch for the fake bridge; Monsieur Cuisine's account endpoint answers from here.
function fetchWith(mcAccepts = true): FetchLike {
  return (url, init) => {
    if (url.startsWith("https://www.monsieur-cuisine.com/")) {
      const body = mcAccepts
        ? { code: 0, message: "OK", data: { user: { id: 1, displayName: "test-user" } } }
        : { code: 110002, message: "ExpiredAuthCookieException", data: null };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: mcAccepts ? 200 : 401,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return fetch(url, init);
  };
}

function context(script: FakeBrowserScript, extra: { mcAccepts?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ctx: {
      env: { ADMIN_PASSWORD: PASSWORD },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      fetch: fetchWith(extra.mcAccepts ?? true),
      browser: fakeBrowser(script),
      login: (options: Parameters<typeof browserLogin>[0]) =>
        browserLogin({ ...options, ...loopClock() }),
      knowledgeDir: "./knowledge",
    },
  };
}

describe("parseLoginArgs", () => {
  it("needs the bridge and picks the timeouts per mode", () => {
    expect(() => parseLoginArgs([])).toThrow(UsageError);
    expect(() => parseLoginArgs(["--bridge", "ftp://x"])).toThrow(/http or https/);
    expect(() => parseLoginArgs(["--bridge", "http://b", "--nope"])).toThrow(UsageError);
    expect(() => parseLoginArgs(["--bridge", "http://b", "--timeout", "x"])).toThrow(/seconds/);
    const visible = parseLoginArgs(["--bridge", "http://bridge.example.com:3000/"]);
    expect(visible).toMatchObject({
      bridge: "http://bridge.example.com:3000",
      user: "admin",
      headless: false,
      locale: "de-DE",
      timeoutMs: VISIBLE_TIMEOUT_MS,
    });
    expect(visible.profile).toMatch(/local[\\/]mc-login-profile$/);
    const headless = parseLoginArgs(["--bridge", "http://b", "--headless", "--user", "root"], {
      MC_LOCALE: "en-US",
    });
    expect(headless).toMatchObject({ headless: true, user: "root", locale: "en-US" });
    expect(headless.timeoutMs).toBe(HEADLESS_TIMEOUT_MS);
    expect(parseLoginArgs(["--self-test"])).toMatchObject({ selfTest: true, bridge: null });
  });
});

describe("cookie header", () => {
  it("is built from every cookie of the site, as the prototype did", () => {
    expect(buildCookieHeader(LOGIN_COOKIES, "de")).toBe(
      "PHPSESSID=php-session; wordpress_logged_in_0123=someone%7C1790000000%7Ctoken%7Chmac; lidl_sso_id_token=id-token; wp-wpml_current_language=de",
    );
  });
});

describe("sendToBridge", () => {
  it("posts the cookie as JSON with Basic Auth and reads the session state", async () => {
    const bridge = await fakeBridge();
    const answer = await sendToBridge(bridge.url, { user: "admin", password: PASSWORD }, "a=1");
    expect(answer).toEqual({ ok: true, status: 200, state: "valid", message: null });
    expect(bridge.received[0]).toEqual({
      method: "POST",
      url: "/admin/api/session",
      authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`,
      contentType: "application/json",
      body: JSON.stringify({ cookie: "a=1" }),
    });
  });

  it("passes on what the bridge says when it refuses", async () => {
    const bridge = await fakeBridge(() => ({
      status: 422,
      body: {
        saved: false,
        message: "Monsieur Cuisine does not accept this cookie",
        session: { state: "expired" },
      },
    }));
    expect(await sendToBridge(bridge.url, { user: "admin", password: "x" }, "a=1")).toEqual({
      ok: false,
      status: 422,
      state: "expired",
      message: "Monsieur Cuisine does not accept this cookie",
    });
  });
});

describe("runLogin", () => {
  it("waits for the login, checks the cookie and hands it to the bridge without printing it", async () => {
    const bridge = await fakeBridge();
    // The person logs in by hand; the fake site has the login cookies right away.
    const { ctx, out, err } = context({ loggedInProfile: true });
    const code = await runLogin(["--bridge", bridge.url], ctx);
    expect(err).toEqual([]);
    expect(code).toBe(EXIT.ok);
    expect(bridge.received.map((entry) => entry.method)).toEqual(["GET", "POST"]);
    const sent = JSON.parse(bridge.received[1]?.body ?? "{}") as { cookie: string };
    expect(sent.cookie).toContain("lidl_sso_id_token=id-token");
    expect(out.join("\n")).toContain("The bridge stored the session; its state is now valid.");
    expect(out.join("\n")).not.toContain("id-token");
    expect(out.join("\n")).toContain("Log in to your Lidl account in the browser window.");
  });

  it("stops before the browser when the bridge refuses the password", async () => {
    const bridge = await fakeBridge(() => ({ status: 401, body: { error: "Unauthorized" } }));
    const { ctx, err } = context({ loggedInProfile: true });
    expect(await runLogin(["--bridge", bridge.url], ctx)).toBe(EXIT.bridge);
    expect(err.join("\n")).toContain("refused the admin user or password");
    expect(ctx.browser.opened).toEqual([]);
  });

  it("asks for the password when ADMIN_PASSWORD is not set", async () => {
    const bridge = await fakeBridge();
    const { ctx } = context({ loggedInProfile: true });
    const asked: string[] = [];
    const code = await runLogin(["--bridge", bridge.url, "--user", "cook"], {
      ...ctx,
      env: {},
      askPassword: (question) => {
        asked.push(question);
        return Promise.resolve("typed");
      },
    });
    expect(code).toBe(EXIT.ok);
    expect(asked).toEqual(["Password for cook on the bridge: "]);
    expect(bridge.received[0]?.authorization).toBe(
      `Basic ${Buffer.from("cook:typed").toString("base64")}`,
    );
  });

  it("asks for a login with a window when the headless profile needs input", async () => {
    const bridge = await fakeBridge();
    const { ctx, err } = context({ form: "both" });
    expect(await runLogin(["--bridge", bridge.url, "--headless"], ctx)).toBe(EXIT.failed);
    expect(err.join("\n")).toContain("log in once with a window");
    expect(ctx.browser.opened[0]).toMatchObject({ headless: true });
    expect(bridge.received.map((entry) => entry.method)).toEqual(["GET"]);
  });

  it("refuses a session Monsieur Cuisine does not accept", async () => {
    const bridge = await fakeBridge();
    const { ctx, err } = context({ loggedInProfile: true }, { mcAccepts: false });
    expect(await runLogin(["--bridge", bridge.url, "--headless"], ctx)).toBe(EXIT.failed);
    expect(err.join("\n")).toContain("does not accept the new session");
    expect(bridge.received.map((entry) => entry.method)).toEqual(["GET"]);
  });

  it("explains a missing browser", async () => {
    const bridge = await fakeBridge();
    const { ctx, err } = context({ unavailable: "Playwright is not installed" });
    expect(await runLogin(["--bridge", bridge.url], ctx)).toBe(EXIT.failed);
    expect(err.join("\n")).toContain("npx playwright install chromium");
  });

  it("shows the usage for bad arguments", async () => {
    const { ctx, err } = context({});
    expect(await runLogin(["--headless"], ctx)).toBe(EXIT.usage);
    expect(err.join("\n")).toContain("Usage: npm run mc:login");
  });
});

describe("self-test", () => {
  it("opens the public recipe list with a throwaway profile", async () => {
    const { ctx, out } = context({ url: "https://www.monsieur-cuisine.com/de/rezepte" });
    expect(await runLogin(["--self-test"], ctx)).toBe(EXIT.ok);
    expect(ctx.browser.steps).toEqual(["goto https://www.monsieur-cuisine.com/de/rezepte"]);
    expect(ctx.browser.closed).toBe(1);
    expect(out.join("\n")).toContain("Self-test passed");
    expect(publicListUrl("/en/create-recipe?devices=mc-smart")).toBe(
      "https://www.monsieur-cuisine.com/en/",
    );
  });

  it("fails without a browser or on another site", async () => {
    const missing = context({ unavailable: "Playwright is not installed" });
    expect(await runLogin(["--self-test"], missing.ctx)).toBe(EXIT.failed);
    const elsewhere = context({ url: "https://accounts.lidl.com/" });
    expect(await runLogin(["--self-test"], elsewhere.ctx)).toBe(EXIT.failed);
    expect(elsewhere.err.join("\n")).toContain("ended on https://accounts.lidl.com/");
  });
});
