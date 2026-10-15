// The settings page: the Lidl account for the automatic login, a manual test, deletion,
// and the last attempt with its screenshot. It runs inside the admin plugin (see
// AdminOptions.extend), so the login, the form token and the host check apply.
//
// The password is never shown, logged or sent back to the browser; the field stays empty
// and an empty field keeps the stored password.

import { readFile } from "node:fs/promises";
import type { FastifyReply } from "fastify";
import type { AdminMessages } from "../i18n/index.js";
import {
  InvalidCredentialsError,
  type AutoLogin,
  type AutoLoginRun,
  type AutoLoginStatus,
} from "../session/auto-login.js";
import type { AdminContext } from "./admin.js";
import { REFRESH_SECONDS } from "./admin.js";
import { csrfField, formatTime } from "./admin-views.js";
import { html, type SafeHtml } from "./html.js";

export interface SettingsDeps {
  autoLogin: Pick<
    AutoLogin,
    | "status"
    | "saveCredentials"
    | "deleteCredentials"
    | "browserUnavailable"
    | "screenshotFile"
    | "hasCredentials"
  >;
  session: { loginNow(): Promise<AutoLoginRun> };
}

export interface SettingsViewData {
  status: AutoLoginStatus;
  browserUnavailable: string | null;
  formToken: string;
}

export function settingsView(data: SettingsViewData, t: AdminMessages): SafeHtml {
  const l = t.settings;
  const { status } = data;
  const last = status.last;
  return html`<h1>${l.title}</h1>
    <section>
      <h2>${l.account}</h2>
      <p class="muted">${l.intro}</p>
      <dl>
        <dt>${l.account}</dt>
        <dd>
          ${status.configured && status.email ? l.configuredAs(status.email) : l.notConfigured}
        </dd>
        <dt>${l.browser}</dt>
        <dd>
          ${
            data.browserUnavailable === null
              ? html`<span class="badge ok">${l.browserReady}</span>`
              : html`<span class="badge bad">${l.browserMissing(data.browserUnavailable)}</span>`
          }
        </dd>
        <dt>${l.lastAttempt}</dt>
        <dd>
          ${
            last
              ? html`<span class="badge ${last.ok ? "ok" : "bad"}"
                    >${l.attempt(formatTime(last.at), last.ok, last.manual)}</span
                  >
                  ${last.code ? html`<br />${l.failure[last.code]}` : ""}
                  ${last.detail ? html`<br /><span class="muted">${last.detail}</span>` : ""}
                  ${
                    last.screenshot
                      ? html`<br /><a
                            href="/admin/settings/screenshots/${encodeURIComponent(last.screenshot)}"
                            >${l.screenshot}</a
                          >`
                      : ""
                  }`
              : l.never
          }
        </dd>
        ${
          status.running
            ? html`<dt></dt>
                <dd><span class="badge info">${l.running}</span></dd>`
            : ""
        }
        ${
          status.nextAttemptAt
            ? html`<dt>${l.nextAttempt}</dt>
                <dd>${formatTime(status.nextAttemptAt)}</dd>`
            : ""
        }
      </dl>
    </section>
    <section>
      <form class="fields" method="post" action="/admin/settings/credentials">
        ${csrfField(data.formToken)}
        <label
          >${l.email}
          <input
            type="email"
            name="email"
            value="${status.email ?? ""}"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            required
        /></label>
        <label
          >${l.password}
          <input
            type="password"
            name="password"
            autocomplete="new-password"
            placeholder="${status.configured ? l.passwordStored : ""}"
            ${status.configured ? "" : html`required`}
        /></label>
        <button type="submit">${l.save}</button>
      </form>
      ${
        status.configured
          ? html`<div>
              <form class="inline" method="post" action="/admin/settings/login">
                ${csrfField(data.formToken)}
                <button
                  type="submit"
                  ${status.running || status.manualAvailableAt ? html`disabled` : ""}
                >
                  ${l.testNow}
                </button>
              </form>
              ${
                status.manualAvailableAt
                  ? html`<span class="muted"
                      >${l.manualCooldown(formatTime(status.manualAvailableAt))}</span
                    >`
                  : ""
              }
              <form class="inline" method="post" action="/admin/settings/credentials/delete">
                ${csrfField(data.formToken)}
                <button type="submit">${l.remove}</button>
              </form>
            </div>`
          : ""
      }
      <p class="muted">${l.otherWays}</p>
    </section>`;
}

export function registerSettings(context: AdminContext, deps: SettingsDeps): void {
  const { app, t, csrf, render, notice } = context;

  const show = async (
    reply: FastifyReply,
    extra: { status?: number; notice?: string | null; error?: string | null } = {},
  ) => {
    const status = deps.autoLogin.status();
    return render(
      reply,
      t.settings.title,
      settingsView(
        {
          status,
          browserUnavailable: await deps.autoLogin.browserUnavailable(),
          formToken: csrf(reply.request),
        },
        t,
      ),
      {
        ...extra,
        refresh: status.running ? { seconds: REFRESH_SECONDS, url: "/admin/settings" } : null,
      },
    );
  };

  app.get("/admin/settings", (request, reply) => show(reply, { notice: notice(request) }));

  app.post("/admin/settings/credentials", (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    try {
      deps.autoLogin.saveCredentials(
        typeof body.email === "string" ? body.email : "",
        typeof body.password === "string" ? body.password : "",
      );
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        return show(reply, { status: 400, error: t.errors.credentialsInvalid(error.field) });
      }
      throw error;
    }
    return reply.redirect("/admin/settings?notice=credentials-saved", 303);
  });

  app.post("/admin/settings/credentials/delete", (_request, reply) => {
    deps.autoLogin.deleteCredentials();
    return reply.redirect("/admin/settings?notice=credentials-deleted", 303);
  });

  // Starts the login in the background; the page reloads until it is done.
  app.post("/admin/settings/login", (_request, reply) => {
    if (!deps.autoLogin.hasCredentials()) {
      return reply.redirect("/admin/settings?notice=login-no-credentials", 303);
    }
    const status = deps.autoLogin.status();
    if (status.running) {
      return reply.redirect("/admin/settings?notice=login-running", 303);
    }
    if (status.manualAvailableAt) {
      return reply.redirect("/admin/settings?notice=login-cooldown", 303);
    }
    void deps.session.loginNow().catch(() => undefined);
    return reply.redirect("/admin/settings?notice=login-started", 303);
  });

  app.get<{ Params: { name: string } }>(
    "/admin/settings/screenshots/:name",
    async (request, reply) => {
      const file = deps.autoLogin.screenshotFile(request.params.name);
      if (file === null) {
        return render(reply, t.titles.notFound, html`<p>${t.titles.notFound}</p>`, {
          status: 404,
        });
      }
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .send(await readFile(file));
    },
  );
}
