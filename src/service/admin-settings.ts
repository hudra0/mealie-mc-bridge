// The routes of the settings page (views/settings.ts): the page with its tabs, the Lidl
// account (save, delete, test login, screenshots of failed attempts) and the test mail. It
// runs inside the admin plugin, so the login, the form token and the host check apply.
//
// The password is never shown, logged or sent back to the browser; the field stays empty
// and an empty field keeps the stored password.

import { readFile } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errorMessage } from "../app-logger.js";
import type { ConfigEntry } from "../config-reference.js";
import type { SavedStatus } from "../i18n/index.js";
import type { Notifier } from "../notify/email.js";
import {
  InvalidCredentialsError,
  type AutoLogin,
  type AutoLoginRun,
} from "../session/auto-login.js";
import type { SessionStatus } from "../session/manager.js";
import type { JobStore } from "../store/jobs.js";
import { version } from "../version.js";
import type { AdminContext, RenderExtra } from "./admin.js";
import type { AiInfo } from "./views/dashboard.js";
import { errorView } from "./views/login.js";
import { parseSettingsTab, settingsView, type SettingsTab } from "./views/settings.js";

export type AutoLoginPort = Pick<
  AutoLogin,
  | "status"
  | "saveCredentials"
  | "deleteCredentials"
  | "browserUnavailable"
  | "screenshotFile"
  | "hasCredentials"
>;

export interface SettingsDeps {
  // Null when the service runs without the automatic login.
  autoLogin: AutoLoginPort | null;
  session: { status(): SessionStatus; loginNow(): Promise<AutoLoginRun> };
  // The effective configuration; null when the caller has none to show.
  config: readonly ConfigEntry[] | null;
  jobs: Pick<JobStore, "summarySince" | "usageSince">;
  locale: { mcLocale: string; verified: boolean; uiLanguage: string; recipeStatus: SavedStatus };
  mealieUrl: string | null;
  ai: AiInfo | null;
  limits: { jobs: number; costUsd: number };
  notifier: Pick<Notifier, "testMail"> | null;
  notifyRecipient: string | null;
  dataDir: string | null;
}

// A test mail at most this often, so the button cannot flood the mailbox.
export const TEST_MAIL_COOLDOWN_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const REFRESH_SECONDS = 5;

// Registers the settings routes and returns the function that renders the page, which
// the session forms of admin.ts use for their errors.
export function registerSettings(
  context: AdminContext,
  deps: SettingsDeps,
): (request: FastifyRequest, reply: FastifyReply, extra?: RenderExtra) => Promise<FastifyReply> {
  const { app, t, render, notice, view } = context;
  const autoLogin = deps.autoLogin;
  let lastTestMail = 0;

  const show = async (
    request: FastifyRequest,
    reply: FastifyReply,
    extra: RenderExtra = {},
    tab?: SettingsTab,
  ) => {
    const ctx = view(request);
    const status = autoLogin?.status() ?? null;
    const query = request.query as Record<string, unknown> | undefined;
    const now = ctx.now.getTime();
    const monthStart = new Date(ctx.now.getFullYear(), ctx.now.getMonth(), 1);
    return render(
      reply,
      t.settings.title,
      settingsView(
        {
          tab: tab ?? parseSettingsTab(query?.tab),
          session: deps.session.status(),
          autoLogin:
            autoLogin && status
              ? { status, browserUnavailable: await autoLogin.browserUnavailable() }
              : null,
          config: deps.config,
          locale: deps.locale,
          mealie: {
            url: deps.mealieUrl,
            check: await context.checkMealie(),
            webhook: context.webhookInfo(request),
          },
          ai: deps.ai,
          limits: deps.limits,
          usage: {
            month: deps.jobs.summarySince(monthStart),
            today: deps.jobs.usageSince(new Date(now - DAY_MS)),
          },
          notify: {
            recipient: deps.notifyRecipient,
            canTest: deps.notifier?.testMail !== undefined,
          },
          system: { version, uptimeMs: process.uptime() * 1000, dataDir: deps.dataDir },
        },
        ctx,
      ),
      {
        ...extra,
        active: "settings",
        refresh: status?.running
          ? { seconds: REFRESH_SECONDS, url: "/admin/settings?tab=lidl" }
          : null,
      },
    );
  };

  app.get("/admin/settings", (request, reply) => show(request, reply, { notice: notice(request) }));

  // The routes of mail and the automatic login exist in every setup, so a visitor without a
  // login cannot tell from the answer whether they are configured; after the login they say
  // so when they are not.
  const notifier = deps.notifier;
  const sendTestMail =
    notifier?.testMail && deps.notifyRecipient ? notifier.testMail.bind(notifier) : null;
  app.post("/admin/settings/notify/test", async (request, reply) => {
    if (sendTestMail === null) {
      return show(request, reply, { status: 404, error: t.errors.mailUnavailable }, "notify");
    }
    const at = context.now().getTime();
    if (at - lastTestMail < TEST_MAIL_COOLDOWN_MS) {
      return reply.redirect("/admin/settings?tab=notify&notice=test-mail-cooldown", 303);
    }
    lastTestMail = at;
    try {
      await sendTestMail();
    } catch (error) {
      return show(
        request,
        reply,
        { status: 502, error: t.errors.testMailFailed(errorMessage(error, 300)) },
        "notify",
      );
    }
    return reply.redirect("/admin/settings?tab=notify&notice=test-mail-sent", 303);
  });

  const unavailable = (request: FastifyRequest, reply: FastifyReply) =>
    show(request, reply, { status: 404, error: t.settings.lidl.unavailable }, "lidl");

  app.post("/admin/settings/credentials", (request, reply) => {
    if (autoLogin === null) return unavailable(request, reply);
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    try {
      autoLogin.saveCredentials(
        typeof body.email === "string" ? body.email : "",
        typeof body.password === "string" ? body.password : "",
      );
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        return show(
          request,
          reply,
          { status: 400, error: t.errors.credentialsInvalid(error.field) },
          "lidl",
        );
      }
      throw error;
    }
    return reply.redirect("/admin/settings?tab=lidl&notice=credentials-saved", 303);
  });

  app.post("/admin/settings/credentials/delete", (request, reply) => {
    if (autoLogin === null) return unavailable(request, reply);
    autoLogin.deleteCredentials();
    return reply.redirect("/admin/settings?tab=lidl&notice=credentials-deleted", 303);
  });

  // Starts the login in the background; the page reloads until it is done.
  app.post("/admin/settings/login", (request, reply) => {
    if (autoLogin === null) return unavailable(request, reply);
    const back = (key: string) => reply.redirect(`/admin/settings?tab=lidl&notice=${key}`, 303);
    if (!autoLogin.hasCredentials()) return back("login-no-credentials");
    const status = autoLogin.status();
    if (status.running) return back("login-running");
    if (status.manualAvailableAt) return back("login-cooldown");
    void deps.session.loginNow().catch(() => undefined);
    return back("login-started");
  });

  app.get<{ Params: { name: string } }>(
    "/admin/settings/screenshots/:name",
    async (request, reply) => {
      const file = autoLogin?.screenshotFile(request.params.name) ?? null;
      if (file === null) {
        return render(
          reply,
          t.titles.notFound,
          errorView({
            icon: "image",
            code: "404",
            title: t.titles.notFound,
            text: t.errors.noSuchScreenshot,
            back: { href: "/admin/settings?tab=lidl", label: t.links.backToSettings },
          }),
          { status: 404, active: "settings" },
        );
      }
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .send(await readFile(file));
    },
  );

  return show;
}
