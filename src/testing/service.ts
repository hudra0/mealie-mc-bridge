// Builds the whole service on a temp store with fake clients, for route and admin tests.

import { vi } from "vitest";
import type { McUser } from "../mc/index.js";
import type { Converter } from "../pipeline/converter-port.js";
import type { IngredientResolverPort } from "../pipeline/ingredient-resolver.js";
import { buildService, type Service, type ServiceConfig } from "../service/app.js";
import { SessionManager } from "../session/manager.js";
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

export interface TestService extends Service {
  store: TempStore;
  mealie: FakeMealie;
  mc: FakeMc;
  converter: Converter;
  notifier: FakeNotifier;
  session: SessionManager;
  validate: ReturnType<typeof vi.fn<(cookie: string) => Promise<McUser>>>;
  config: ServiceConfig;
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
  logger?: Parameters<typeof buildService>[0]["server"];
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
  const session = new SessionManager({
    settings: store.settings,
    jobs: store.jobs,
    validate,
    notifier,
    logger: silentLogger(),
    seedCookie: options.seedCookie,
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
    dispose: async () => {
      await service.stop();
      store.dispose();
    },
  };
}

export function basicAuth(user = ADMIN.user, password = ADMIN.password): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

export function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
