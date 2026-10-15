// Logs in to monsieur-cuisine.com in a browser on your computer and hands the session to
// the bridge, for when the automatic login on the settings page cannot get through (a
// captcha, a second factor) or no account is stored.
//
//   npm run mc:login -- --bridge http://bridge.example.com:3000 [--user admin]
//   npm run mc:login -- --bridge http://bridge.example.com:3000 --headless
//   npm run mc:login -- --self-test
//
// The browser keeps its profile in local/mc-login-profile (or --profile), so the Lidl login
// survives between runs. With a window, you log in yourself (up to 10 minutes). With
// --headless, the saved profile logs in on its own if the Lidl login is still valid; a cron
// job or the Task Scheduler can run it to keep the session fresh.
//
// The cookie is checked against api/v1/users and sent to POST /admin/api/session with the
// admin user and password (ADMIN_PASSWORD, or a prompt that does not echo). The script never
// prints the cookie.
//
// The browser: an installed Google Chrome when one is found, else Playwright's Chromium
// (`npx playwright install chromium`). --chromium forces Playwright's Chromium.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadLocalePack } from "../src/locale/pack.js";
import { McClient, McTransport, StaticSessionProvider, type FetchLike } from "../src/mc/index.js";
import {
  MC_BASE_URL,
  browserLogin,
  siteLanguage,
  type BrowserLoginOptions,
  type BrowserLoginResult,
  type LoginBrowser,
} from "../src/session/browser-login.js";
import { PlaywrightBrowser } from "../src/session/playwright-browser.js";

export const EXIT = { ok: 0, failed: 1, bridge: 2, usage: 64 } as const;

export const VISIBLE_TIMEOUT_MS = 10 * 60_000;
export const HEADLESS_TIMEOUT_MS = 60_000;
export const DEFAULT_PROFILE = join("local", "mc-login-profile");

export const USAGE = `Usage: npm run mc:login -- --bridge <url> [options]

  --bridge <url>     the bridge, for example http://bridge.example.com:3000
  --user <name>      the admin user (default: admin, or ADMIN_USER)
  --headless         no window: reuse the saved browser profile; fails when it needs input
  --profile <dir>    the browser profile (default: ${DEFAULT_PROFILE})
  --locale <locale>  the Monsieur Cuisine site language (default: MC_LOCALE or de-DE)
  --chromium         use Playwright's Chromium even when Google Chrome is installed
  --timeout <s>      how long to wait for the login (default: 600, headless 60)
  --self-test        open the public recipe list in the browser and exit

The admin password comes from ADMIN_PASSWORD or a prompt.`;

export interface LoginArgs {
  bridge: string | null;
  user: string;
  headless: boolean;
  profile: string;
  locale: string;
  chromium: boolean;
  timeoutMs: number;
  selfTest: boolean;
}

export class UsageError extends Error {}

export function parseLoginArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): LoginArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        bridge: { type: "string" },
        user: { type: "string" },
        headless: { type: "boolean", default: false },
        profile: { type: "string" },
        locale: { type: "string" },
        chromium: { type: "boolean", default: false },
        timeout: { type: "string" },
        "self-test": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const selfTest = values["self-test"] === true;
  const headless = values.headless === true;
  let bridge: string | null = null;
  if (!selfTest) {
    if (!values.bridge) throw new UsageError("--bridge is missing");
    try {
      const url = new URL(values.bridge);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      bridge = url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
      throw new UsageError(`--bridge is not an http or https URL: ${values.bridge}`);
    }
  }
  const seconds = values.timeout === undefined ? null : Number(values.timeout);
  if (seconds !== null && !(Number.isFinite(seconds) && seconds > 0)) {
    throw new UsageError("--timeout must be a number of seconds");
  }
  return {
    bridge,
    user: values.user ?? env.ADMIN_USER ?? "admin",
    headless,
    profile: resolve(values.profile ?? DEFAULT_PROFILE),
    locale: values.locale ?? env.MC_LOCALE ?? "de-DE",
    chromium: values.chromium === true,
    timeoutMs:
      seconds === null ? (headless ? HEADLESS_TIMEOUT_MS : VISIBLE_TIMEOUT_MS) : seconds * 1000,
    selfTest,
  };
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

export interface BridgeAnswer {
  ok: boolean;
  status: number;
  state: string | null;
  message: string | null;
}

async function answerOf(response: Response): Promise<BridgeAnswer> {
  let body: { session?: { state?: unknown }; message?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Not JSON: an old bridge or a proxy page.
  }
  return {
    ok: response.ok,
    status: response.status,
    state: typeof body.session?.state === "string" ? body.session.state : null,
    message: typeof body.message === "string" ? body.message : null,
  };
}

// Asks the bridge for the session state, to find a wrong address or password before the
// browser opens.
export async function checkBridge(
  bridge: string,
  auth: { user: string; password: string },
  fetchImpl: FetchLike = fetch,
): Promise<BridgeAnswer> {
  const response = await fetchImpl(`${bridge}/admin/api/session`, {
    method: "GET",
    headers: { authorization: basic(auth.user, auth.password), accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  return answerOf(response);
}

// Sends the cookie to the bridge, which checks it against the account and stores it.
export async function sendToBridge(
  bridge: string,
  auth: { user: string; password: string },
  cookie: string,
  fetchImpl: FetchLike = fetch,
): Promise<BridgeAnswer> {
  const response = await fetchImpl(`${bridge}/admin/api/session`, {
    method: "POST",
    headers: {
      authorization: basic(auth.user, auth.password),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ cookie }),
    signal: AbortSignal.timeout(60_000),
  });
  return answerOf(response);
}

// Reads a line from the terminal without showing it.
export function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(
      new UsageError("no terminal for the password prompt; set ADMIN_PASSWORD"),
    );
  }
  process.stderr.write(question);
  return new Promise((resolvePrompt, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolvePrompt(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new UsageError("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

// An installed Google Chrome, which logs in like your everyday browser.
export function findChrome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const candidates = [
    ...[env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
      .filter((base): base is string => Boolean(base))
      .map((base) => join(base, "Google", "Chrome", "Application", "chrome.exe")),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
  ];
  return candidates.some((path) => existsSync(path));
}

export interface LoginContext {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  // For tests; the real ones otherwise.
  fetch?: FetchLike;
  browser?: LoginBrowser;
  login?: (options: BrowserLoginOptions) => Promise<BrowserLoginResult>;
  askPassword?: (question: string) => Promise<string>;
  knowledgeDir?: string;
}

// The public recipe list of the site, for the self-test.
export function publicListUrl(editorPath: string): string {
  const language = siteLanguage(editorPath);
  return language === "de" ? `${MC_BASE_URL}/de/rezepte` : `${MC_BASE_URL}/${language}/`;
}

export async function runLogin(argv: readonly string[], ctx: LoginContext): Promise<number> {
  let args: LoginArgs;
  try {
    args = parseLoginArgs(argv, ctx.env);
  } catch (error) {
    ctx.err(error instanceof Error ? error.message : String(error));
    ctx.err(USAGE);
    return EXIT.usage;
  }
  const pack = await loadLocalePack(
    ctx.knowledgeDir ?? ctx.env.KNOWLEDGE_DIR ?? "./knowledge",
    args.locale,
  );
  const editorPath = pack.mc.editorPath;
  const chrome = !args.chromium && findChrome(ctx.env);
  const browser = ctx.browser ?? new PlaywrightBrowser(chrome ? { channel: "chrome" } : {});
  const label = ctx.browser ? "test browser" : chrome ? "Google Chrome" : "Playwright Chromium";

  if (args.selfTest) return selfTest(browser, label, editorPath, ctx);
  const bridge = args.bridge as string;

  const password =
    ctx.env.ADMIN_PASSWORD ??
    (await (ctx.askPassword ?? promptHidden)(`Password for ${args.user} on the bridge: `));
  const auth = { user: args.user, password };
  const fetchImpl = ctx.fetch ?? fetch;

  let reachable: BridgeAnswer;
  try {
    reachable = await checkBridge(bridge, auth, fetchImpl);
  } catch (error) {
    ctx.err(
      `The bridge at ${bridge} does not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.bridge;
  }
  if (reachable.status === 401) {
    ctx.err("The bridge refused the admin user or password.");
    return EXIT.bridge;
  }
  if (!reachable.ok) {
    ctx.err(
      `The bridge answered HTTP ${reachable.status}; is ${bridge} the bridge, version 0.2 or newer?`,
    );
    return EXIT.bridge;
  }

  ctx.out(`Browser: ${label}${args.headless ? ", headless" : ""}; profile ${args.profile}`);
  if (!args.headless) {
    ctx.out(
      "Log in to your Lidl account in the browser window. The window closes by itself afterwards.",
    );
  }
  const result = await (ctx.login ?? browserLogin)({
    browser,
    profileDir: args.profile,
    headless: args.headless,
    editorPath,
    credentials: null,
    timeoutMs: args.timeoutMs,
    onStep: (message) => ctx.out(`- ${message}`),
  });
  if (!result.ok) {
    if (result.code === "browser_unavailable") {
      ctx.err(`No browser: ${result.detail}. Install one with: npx playwright install chromium`);
    } else if (args.headless) {
      ctx.err(
        `No session without input (${result.detail}). The saved Lidl login is gone or needs a confirmation: log in once with a window, without --headless.`,
      );
    } else {
      ctx.err(`No session: ${result.detail}.`);
    }
    return EXIT.failed;
  }

  // The same check the bridge runs, so a broken cookie is reported here, before it travels.
  try {
    const transport = new McTransport({
      locale: pack.mc,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    await new McClient(transport, new StaticSessionProvider(result.cookie), {
      editorPath,
    }).getCurrentUser();
    ctx.out("Monsieur Cuisine accepts the new session.");
  } catch (error) {
    ctx.err(
      `Monsieur Cuisine does not accept the new session: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.failed;
  }

  let answer: BridgeAnswer;
  try {
    answer = await sendToBridge(bridge, auth, result.cookie, fetchImpl);
  } catch (error) {
    ctx.err(
      `Sending the session to the bridge failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.bridge;
  }
  if (!answer.ok) {
    ctx.err(
      `The bridge did not store the session (HTTP ${answer.status}${answer.message ? `: ${answer.message}` : ""}).`,
    );
    return EXIT.bridge;
  }
  ctx.out(`The bridge stored the session; its state is now ${answer.state ?? "unknown"}.`);
  return EXIT.ok;
}

async function selfTest(
  browser: LoginBrowser,
  label: string,
  editorPath: string,
  ctx: LoginContext,
): Promise<number> {
  const unavailable = await browser.unavailable();
  if (unavailable !== null) {
    ctx.err(
      `Self-test failed: ${unavailable}. Install a browser with: npx playwright install chromium`,
    );
    return EXIT.failed;
  }
  // A throwaway profile: the self-test logs in nowhere and keeps nothing.
  const profile = mkdtempSync(join(tmpdir(), "mc-login-self-test-"));
  const url = publicListUrl(editorPath);
  try {
    const context = await browser.open({ profileDir: profile, headless: true });
    try {
      await context.page.goto(url);
      const reached = context.page.url();
      if (!new URL(reached).hostname.endsWith("monsieur-cuisine.com")) {
        ctx.err(`Self-test failed: the browser ended on ${reached}.`);
        return EXIT.failed;
      }
      ctx.out(`Self-test passed: ${label} opened ${reached}.`);
      return EXIT.ok;
    } finally {
      await context.close();
    }
  } catch (error) {
    ctx.err(`Self-test failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = await runLogin(process.argv.slice(2), {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
