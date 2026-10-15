// The settings page: the Monsieur Cuisine session (state, check, cookie paste), the Lidl
// account for the automatic login (test, deletion, the last attempt with its screenshot),
// language and recipe status, and a read-only view of the effective configuration. It runs
// inside the admin plugin, so the login, the form token and the host check apply.
//
// The password is never shown, logged or sent back to the browser; the field stays empty
// and an empty field keeps the stored password. Secrets of the configuration arrive here
// already reduced to "set" or "unset" (src/config-reference.ts).

import { readFile } from "node:fs/promises";
import type { FastifyReply } from "fastify";
import type { ConfigEntry } from "../config-reference.js";
import { REQUIRED_DEFAULT } from "../config-reference.js";
import type { AdminMessages, SavedStatus } from "../i18n/index.js";
import {
  InvalidCredentialsError,
  type AutoLogin,
  type AutoLoginRun,
  type AutoLoginStatus,
} from "../session/auto-login.js";
import type { LoginProgress } from "../session/browser-login.js";
import type { SessionStatus } from "../session/manager.js";
import type { AdminContext, RenderExtra } from "./admin.js";
import {
  REFRESH_SECONDS,
  csrfField,
  formatTime,
  pageHead,
  sessionBadge,
  withCode,
} from "./admin-views.js";
import { html, type SafeHtml } from "./html.js";

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
  locale: { mcLocale: string; verified: boolean; uiLanguage: string; recipeStatus: SavedStatus };
  now: () => Date;
}

export interface SettingsViewData {
  session: SessionStatus;
  now: Date;
  autoLogin: { status: AutoLoginStatus; browserUnavailable: string | null } | null;
  formToken: string;
  config: readonly ConfigEntry[] | null;
  locale: SettingsDeps["locale"];
}

function sessionSection(data: SettingsViewData, t: AdminMessages): SafeHtml {
  const l = t.settings.session;
  const d = t.dashboard;
  const { session } = data;
  return html`<section class="card" id="session" aria-labelledby="session-title">
    <h2 id="session-title">${l.title}</h2>
    <p class="lead">${withCode(l.lead)}</p>
    <dl class="facts">
      <dt>${d.state}</dt>
      <dd>${sessionBadge(session.state, t)}</dd>
      <dt>${d.lastCheck}</dt>
      <dd>${formatTime(session.checkedAt)}</dd>
      <dt>${d.cookieAge}</dt>
      <dd>
        ${
          session.cookieAgeHours === null
            ? d.noCookie
            : d.age(session.cookieAgeHours, session.cookieAgeFrom ?? "stored")
        }
      </dd>
      ${
        session.cookieExpiresAt
          ? html`<dt>${d.cookieExpires}</dt>
              <dd>
                ${d.expiresAt(
                  formatTime(session.cookieExpiresAt),
                  Date.parse(session.cookieExpiresAt) <= data.now.getTime(),
                )}
              </dd>`
          : ""
      }
      <dt>${d.lastError}</dt>
      <dd>${session.lastError ? html`<span class="bad">${session.lastError}</span>` : "–"}</dd>
    </dl>
    <form class="buttons" method="post" action="/admin/session/check">
      ${csrfField(data.formToken)}
      <button type="submit">${d.checkNow}</button>
      <span class="help">${withCode(l.checkHelp)}</span>
    </form>
    <h3>${l.renewTitle}</h3>
    <ol>
      ${l.renewWays.map((way) => html`<li>${withCode(way)}</li>`)}
    </ol>
    <form method="post" action="/admin/session">
      ${csrfField(data.formToken)}
      <label class="field"
        ><span class="label">${l.cookieLabel}</span>
        <textarea
          id="cookie"
          name="cookie"
          rows="4"
          autocomplete="off"
          spellcheck="false"
          required
        ></textarea>
        <span class="help">${withCode(d.cookieLabel)}</span></label
      >
      <button type="submit" class="primary">${d.saveSession}</button>
    </form>
  </section>`;
}

// The steps an attempt reached, in order, the dismissed dialogs with their count. A stored
// step this version does not know is left out.
function progressList(progress: LoginProgress, l: AdminMessages["settings"]): SafeHtml {
  const known = (Array.isArray(progress.reached) ? progress.reached : []).filter((name) =>
    Object.hasOwn(l.steps, name),
  );
  const items = known.map((name) =>
    name === "consent_dismissed" && progress.consentDismissals > 1
      ? l.consentSteps(progress.consentDismissals)
      : l.steps[name],
  );
  if (items.length === 0) return html``;
  return html`<br /><span class="muted">${l.progressTitle}</span>
    <ol class="small steps">
      ${items.map((item) => html`<li>${item}</li>`)}
    </ol>`;
}

function autoLoginSection(data: SettingsViewData, t: AdminMessages): SafeHtml {
  const l = t.settings;
  const intro = html`<h2 id="autologin-title">${l.account}</h2>
    <p class="lead">${withCode(l.intro)}</p>
    <ul class="small">
      ${l.facts.map((fact) => html`<li>${withCode(fact)}</li>`)}
    </ul>`;
  if (data.autoLogin === null) {
    return html`<section class="card" id="autologin" aria-labelledby="autologin-title">
      ${intro}
      <p class="muted">${l.unavailable}</p>
    </section>`;
  }
  const { status, browserUnavailable } = data.autoLogin;
  const last = status.last;
  return html`<section class="card" id="autologin" aria-labelledby="autologin-title">
    ${intro}
    <dl class="facts">
      <dt>${l.accountState}</dt>
      <dd>${status.configured && status.email ? l.configuredAs(status.email) : l.notConfigured}</dd>
      <dt>${l.browser}</dt>
      <dd>
        ${
          browserUnavailable === null
            ? html`<span class="badge ok">${l.browserReady}</span>`
            : html`<span class="badge bad">${l.browserMissing(browserUnavailable)}</span>`
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
                ${last.progress ? progressList(last.progress, l) : ""}
                ${last.consentDismissed && !last.progress ? html`<br /><span class="muted">${l.consentDismissed}</span>` : ""}
                ${last.termsAccepted ? html`<br /><span class="muted">${l.termsAccepted}</span>` : ""}
                ${last.deviceChosen ? html`<br /><span class="muted">${l.deviceChosen}</span>` : ""}
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
    <h3>${status.configured ? l.changeAccount : l.storeAccount}</h3>
    <form method="post" action="/admin/settings/credentials">
      ${csrfField(data.formToken)}
      <label class="field"
        ><span class="label">${l.email}</span>
        <input
          type="email"
          name="email"
          value="${status.email ?? ""}"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          required
        />
        <span class="help">${l.emailHelp}</span></label
      >
      <label class="field"
        ><span class="label">${l.password}</span>
        <input
          type="password"
          name="password"
          autocomplete="new-password"
          placeholder="${status.configured ? l.passwordStored : ""}"
          ${status.configured ? "" : html`required`}
        />
        <span class="help">${withCode(l.passwordHelp)}</span></label
      >
      <button type="submit" class="primary">${l.save}</button>
    </form>
    ${
      status.configured
        ? html`<dl class="actions spaced">
            <dt>
              <form method="post" action="/admin/settings/login">
                ${csrfField(data.formToken)}
                <button
                  type="submit"
                  ${status.running || status.manualAvailableAt ? html`disabled` : ""}
                >
                  ${l.testNow}
                </button>
              </form>
            </dt>
            <dd>
              ${l.testHelp}
              ${
                status.manualAvailableAt
                  ? html`<br /><span
                        >${l.manualCooldown(formatTime(status.manualAvailableAt))}</span
                      >`
                  : ""
              }
            </dd>
            <dt>
              <form method="post" action="/admin/settings/credentials/delete">
                ${csrfField(data.formToken)}
                <button type="submit" class="danger">${l.remove}</button>
              </form>
            </dt>
            <dd>${l.removeHelp}</dd>
          </dl>`
        : ""
    }
  </section>`;
}

function localeSection(data: SettingsViewData, t: AdminMessages): SafeHtml {
  const l = t.settings.locale;
  const { locale } = data;
  return html`<section class="card" id="language" aria-labelledby="language-title">
    <h2 id="language-title">${l.title}</h2>
    <p class="lead">${l.lead}</p>
    <dl class="facts">
      <dt><code>MC_LOCALE</code></dt>
      <dd>
        <code>${locale.mcLocale}</code>
        ${locale.verified ? "" : html`<span class="badge warn">${l.unverified}</span>`}
        <span class="help">${l.mcLocale}</span>
      </dd>
      <dt><code>UI_LANGUAGE</code></dt>
      <dd>
        <code>${locale.uiLanguage}</code>
        <span class="help">${l.uiLanguage}</span>
      </dd>
      <dt><code>MC_RECIPE_STATUS</code></dt>
      <dd>
        <code>${locale.recipeStatus}</code>
        <span class="help">${l.recipeStatus[locale.recipeStatus]}</span>
      </dd>
    </dl>
  </section>`;
}

function configValue(entry: ConfigEntry, t: AdminMessages): SafeHtml {
  const l = t.settings.config;
  if (entry.secret) {
    return entry.source === "unset"
      ? html`<span class="muted">${l.unset}</span>`
      : html`<span class="badge muted">${l.hidden}</span>`;
  }
  if (entry.value === null) return html`<span class="muted">${l.unset}</span>`;
  return html`<code class="url">${entry.value}</code>
    ${entry.source === "default" ? html` <span class="badge muted">${l.isDefault}</span>` : ""}`;
}

function configSection(data: SettingsViewData, t: AdminMessages): SafeHtml {
  const l = t.settings.config;
  return html`<section class="card" id="config" aria-labelledby="config-title">
    <h2 id="config-title">${l.title}</h2>
    <p class="lead">${withCode(l.lead)}</p>
    ${
      data.config === null
        ? html`<p class="muted">${l.unavailable}</p>`
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>${l.name}</th>
                  <th>${l.value}</th>
                  <th>${l.description}</th>
                </tr>
              </thead>
              <tbody>
                ${data.config.map(
                  (entry) =>
                    html`<tr>
                      <td><code>${entry.name}</code></td>
                      <td>${configValue(entry, t)}</td>
                      <td>
                        ${withCode(entry.description)}
                        <span class="help"
                          >${l.defaultLabel}
                          ${
                            entry.default === REQUIRED_DEFAULT
                              ? l.required
                              : entry.default === "unset"
                                ? l.unset
                                : withCode(entry.default)
                          }${entry.values ? html`; ${l.valuesLabel} ${withCode(entry.values)}` : ""}</span
                        >
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
    }
  </section>`;
}

export function settingsView(data: SettingsViewData, t: AdminMessages): SafeHtml {
  const l = t.settings;
  return html`${pageHead(
    l.title,
    l.lead,
    html`<p class="links small">
      <a href="#session">${l.session.title}</a> · <a href="#autologin">${l.account}</a> ·
      <a href="#language">${l.locale.title}</a> · <a href="#config">${l.config.title}</a>
    </p>`,
  )}
  ${sessionSection(data, t)} ${autoLoginSection(data, t)} ${localeSection(data, t)}
  ${configSection(data, t)}`;
}

// Registers the settings routes and returns the function that renders the page, which
// the session forms of admin.ts use for their errors.
export function registerSettings(
  context: AdminContext,
  deps: SettingsDeps,
): (reply: FastifyReply, extra?: RenderExtra) => Promise<FastifyReply> {
  const { app, t, csrf, render, notice } = context;
  const autoLogin = deps.autoLogin;

  const show = async (reply: FastifyReply, extra: RenderExtra = {}) => {
    const status = autoLogin?.status() ?? null;
    return render(
      reply,
      t.settings.title,
      settingsView(
        {
          session: deps.session.status(),
          now: deps.now(),
          autoLogin:
            autoLogin && status
              ? { status, browserUnavailable: await autoLogin.browserUnavailable() }
              : null,
          formToken: csrf(reply.request),
          config: deps.config,
          locale: deps.locale,
        },
        t,
      ),
      {
        ...extra,
        active: "settings",
        refresh: status?.running ? { seconds: REFRESH_SECONDS, url: "/admin/settings" } : null,
      },
    );
  };

  app.get("/admin/settings", (request, reply) => show(reply, { notice: notice(request) }));

  if (autoLogin === null) return show;

  app.post("/admin/settings/credentials", (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    try {
      autoLogin.saveCredentials(
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
    autoLogin.deleteCredentials();
    return reply.redirect("/admin/settings?notice=credentials-deleted", 303);
  });

  // Starts the login in the background; the page reloads until it is done.
  app.post("/admin/settings/login", (_request, reply) => {
    if (!autoLogin.hasCredentials()) {
      return reply.redirect("/admin/settings?notice=login-no-credentials", 303);
    }
    const status = autoLogin.status();
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
      const file = autoLogin.screenshotFile(request.params.name);
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

  return show;
}
