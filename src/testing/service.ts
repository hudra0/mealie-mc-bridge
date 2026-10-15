// Builds the whole service on a temp store with fake clients, for route and admin tests.

import { vi } from "vitest";
import type { ConfigEntry } from "../config-reference.js";
import type { McUser } from "../mc/index.js";
import type { Converter } from "../pipeline/converter-port.js";
import type { IngredientResolverPort } from "../pipeline/ingredient-resolver.js";
import {
  ADMIN_COOKIE,
  LoginThrottle,
  adminSessions,
  formTokenFor,
  loginTokenFor,
} from "../service/admin-auth.js";
import { buildService, type Service, type ServiceConfig } from "../service/app.js";
import { join } from "node:path";
import { AutoLogin } from "../session/auto-login.js";
import {
  browserLogin,
  type BrowserLoginOptions,
  type BrowserLoginResult,
} from "../session/browser-login.js";
import { SessionManager } from "../session/manager.js";
import { fakeBrowser, loopClock, type FakeBrowser, type FakeBrowserScript } from "./browser.js";
import {
  fakeConverter,
  fakeMc,
  fakeMealie,
  fakeNotifier,
  limits,
  silentLogger,
  type FakeMc,
  type FakeMcOptions,
  type FakeMealie,
  type FakeMealieOptions,
  type FakeNotifier,
} from "./fakes.js";
import { deLocale } from "./locale.js";
import { tempStore, type TempStore } from "./temp.js";

export const WEBHOOK_TOKEN = "t".repeat(48);
export const FORM_TOKEN = "f".repeat(64);
export const ADMIN = { user: "admin", password: "correct horse" };
export const ADMIN_SESSION_KEY = Buffer.alloc(32, 7);
// The nonce of the login adminCookie() stands for, and the form tokens that go with it.
export const ADMIN_NONCE = "test-session-nonce";
export const SESSION_CSRF = formTokenFor(FORM_TOKEN, ADMIN_NONCE);
export const LOGIN_CSRF = loginTokenFor(FORM_TOKEN);

export interface TestService extends Service {
  store: TempStore;
  mealie: FakeMealie;
  mc: FakeMc;
  converter: Converter;
  notifier: FakeNotifier;
  session: SessionManager;
  validate: ReturnType<typeof vi.fn<(cookie: string) => Promise<McUser>>>;
  config: ServiceConfig;
  autoLogin: AutoLogin;
  browser: FakeBrowser;
  dispose(): Promise<void>;
}

export interface TestServiceOptions {
  auth?: boolean;
  mealie?: FakeMealieOptions;
  mc?: FakeMcOptions;
  converter?: Converter;
  ingredients?: IngredientResolverPort;
  config?: Partial<ServiceConfig>;
  seedCookie?: string;
  browser?: FakeBrowserScript;
  login?: (options: BrowserLoginOptions) => Promise<BrowserLoginResult>;
  logger?: Parameters<typeof buildService>[0]["server"];
  throttle?: LoginThrottle;
  mealieCheck?: () => Promise<unknown>;
  configEntries?: readonly ConfigEntry[];
  // Leaves the automatic login out, as a service without it.
  noAutoLogin?: boolean;
}

export function testService(options: TestServiceOptions = {}): TestService {
  const store = tempStore();
  const mealie = fakeMealie(options.mealie);
  const mc = fakeMc(options.mc);
  const converter = options.converter ?? fakeConverter();
  const notifier = fakeNotifier();
  const validate = vi.fn<(cookie: string) => Promise<McUser>>(() =>
    Promise.resolve({ id: 1, displayName: "test-user" }),
  );
  const browser = fakeBrowser(options.browser ?? { form: "both", loginWorks: true });
  const autoLogin = new AutoLogin({
    settings: store.settings,
    browser,
    profileDir: join(store.dir, "browser-profile"),
    screenshotDir: join(store.dir, "login-screenshots"),
    editorPath: "/de/create-recipe?devices=mc-smart",
    logger: silentLogger(),
    timeoutMs: 30_000,
    // The real flow on a clock that jumps with every poll.
    login: options.login ?? ((login) => browserLogin({ ...login, ...loopClock() })),
  });
  const session = new SessionManager({
    settings: store.settings,
    jobs: store.jobs,
    validate,
    notifier,
    logger: silentLogger(),
    seedCookie: options.seedCookie,
    autoLogin,
  });
  const config: ServiceConfig = {
    WEBHOOK_TOKEN,
    WORKER_POLL_SECONDS: 0.01,
    MEALIE_URL: "http://mealie:9000",
    MEALIE_PUBLIC_URL: "https://mealie.example.com",
    MEALIE_GROUP_SLUG: "home",
    MC_RECIPE_STATUS: "private-publish",
    TAG_NAME: "Monsieur Cuisine",
    UI_LANGUAGE: "en",
    ...(options.auth === false ? {} : { ADMIN_USER: ADMIN.user, ADMIN_PASSWORD: ADMIN.password }),
    ...options.config,
  };
  const service = buildService({
    config,
    store,
    session,
    mealie,
    mc,
    converter,
    limits,
    locale: deLocale,
    notifier,
    logger: silentLogger(),
    formToken: FORM_TOKEN,
    adminSessionKey: ADMIN_SESSION_KEY,
    ...(options.throttle ? { adminThrottle: options.throttle } : {}),
    ...(options.noAutoLogin ? {} : { autoLogin }),
    ...(options.mealieCheck ? { mealieCheck: options.mealieCheck } : {}),
    ...(options.configEntries ? { configEntries: options.configEntries } : {}),
    workerBackoffMs: () => 1,
    ...(options.ingredients ? { ingredients: options.ingredients } : {}),
    ...(options.logger ? { server: options.logger } : {}),
  });
  return {
    ...service,
    store,
    mealie,
    mc,
    converter,
    notifier,
    session,
    validate,
    config,
    autoLogin,
    browser,
    dispose: async () => {
      await service.stop();
      store.dispose();
    },
  };
}

export function basicAuth(user = ADMIN.user, password = ADMIN.password): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

// A Cookie header with a valid admin login, as the login form would set it.
export function adminCookie(now = new Date()): string {
  return `${ADMIN_COOKIE}=${adminSessions(ADMIN_SESSION_KEY, ADMIN).issue(now, ADMIN_NONCE)}`;
}

export function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
