// The login page and the error pages (404, 500, a form that expired).

import type { AdminMessages } from "../../i18n/index.js";
import { html, SafeHtml } from "../html.js";
import {
  button,
  callout,
  csrfField,
  field,
  icon,
  INPUT_CLASS,
  linkButton,
} from "../ui/components.js";
import type { IconName } from "../ui/icons.generated.js";
import { logoMarkup } from "../ui/logo.js";
import { APP_NAME } from "../ui/shell.js";

export function loginView(
  data: {
    formToken: string;
    next: string;
    user: string;
    error?: string | null;
    notice?: string | null;
  },
  t: AdminMessages,
): SafeHtml {
  const l = t.login;
  return html`<div class="flex min-h-[calc(100dvh-4rem)] items-center justify-center">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center gap-3 text-center">
        ${new SafeHtml(logoMarkup("size-12"))}
        <div>
          <h1 class="text-lg font-semibold tracking-tight">${APP_NAME}</h1>
          <p class="text-fg-muted">${l.subtitle}</p>
        </div>
      </div>
      <div class="rounded-xl border border-line bg-surface p-6 shadow-sm">
        ${data.error ? html`<div class="mb-4">${callout({ tone: "danger", body: data.error, alert: true })}</div>` : ""}
        ${data.notice ? html`<div class="mb-4">${callout({ tone: "ok", body: data.notice })}</div>` : ""}
        <form method="post" action="/admin/login" class="space-y-4">
          ${csrfField(data.formToken)}
          <input type="hidden" name="next" value="${data.next}" />
          ${field({
            id: "login-user",
            label: l.user,
            control: html`<input
              id="login-user"
              type="text"
              name="user"
              value="${data.user}"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              required
              class="${INPUT_CLASS}"
            />`,
          })}
          ${field({
            id: "login-password",
            label: l.password,
            control: html`<input
              id="login-password"
              type="password"
              name="password"
              autocomplete="current-password"
              required
              class="${INPUT_CLASS}"
            />`,
          })}
          ${button({ label: l.submit, variant: "primary", className: "w-full" })}
        </form>
      </div>
      <p class="mt-4 text-center text-xs text-fg-muted">${l.hint}</p>
    </div>
  </div>`;
}

export function errorView(options: {
  icon: IconName;
  code: string;
  title: string;
  text: string;
  back: { href: string; label: string };
}): SafeHtml {
  return html`<div class="flex min-h-[60dvh] items-center justify-center">
    <div class="max-w-md text-center">
      <span class="mx-auto grid size-12 place-items-center rounded-full bg-subtle text-fg-subtle"
        >${icon(options.icon, "size-6")}</span
      >
      <p class="mt-4 text-sm font-semibold text-accent-fg tabular-nums">${options.code}</p>
      <h1 class="mt-1 text-xl font-semibold tracking-tight">${options.title}</h1>
      <p class="mt-2 text-fg-muted">${options.text}</p>
      <div class="mt-6 flex justify-center">
        ${linkButton({ href: options.back.href, label: options.back.label, icon: "arrow-left" })}
      </div>
    </div>
  </div>`;
}
