import { describe, expect, it } from "vitest";
import { html, SafeHtml } from "../html.js";
import {
  badge,
  button,
  buttonClass,
  callout,
  card,
  confirmAttributes,
  confirmDialog,
  copyField,
  csrfField,
  descriptionList,
  emptyState,
  field,
  helpPopover,
  icon,
  iconButton,
  linkButton,
  linkTabs,
  menu,
  menuForm,
  menuLink,
  pageHeader,
  pageTabs,
  segmented,
  statCard,
  statusDot,
  table,
  thumbnail,
  timeline,
  toasts,
  usageBar,
} from "./components.js";
import { ICONS } from "./icons.generated.js";

// The asset build must not scan tests: rotate-[17deg] appears only here.
const EVIL = `<img src=x onerror="alert(1)">`;
const ESCAPED = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;";

const text = (value: SafeHtml) => value.html;

describe("icon", () => {
  it("inlines a decorative Lucide icon", () => {
    const svg = text(icon("chef-hat", "size-5"));
    expect(svg).toMatch(/^<svg class="size-5 shrink-0" viewBox="0 0 24 24"/);
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain(ICONS["chef-hat"]);
    expect(Object.keys(ICONS).length).toBeGreaterThan(50);
  });
});

describe("status and badges", () => {
  it("escape their labels and pick the tone", () => {
    expect(text(statusDot("ok", EVIL))).toContain(ESCAPED);
    expect(text(statusDot("ok", "x"))).toContain("bg-ok");
    expect(text(statusDot("info", "x", { pulse: true }))).toContain("animate-pulse-dot");
    expect(text(badge("warn", EVIL))).toContain(ESCAPED);
    expect(text(badge("warn", "x"))).toContain("bg-warn-soft text-warn-fg");
  });
});

describe("buttons", () => {
  it("render each variant and size with escaped labels and values", () => {
    expect(buttonClass("primary", "sm")).toContain("bg-accent");
    expect(buttonClass("danger")).toContain("bg-danger");
    expect(buttonClass()).toContain("border-line-strong");
    const submit = text(
      button({
        label: EVIL,
        name: "force",
        value: '1"x',
        icon: "play",
        disabled: true,
        busyLabel: true,
      }),
    );
    expect(submit).toContain('type="submit"');
    expect(submit).toContain(ESCAPED);
    expect(submit).toContain('value="1&quot;x"');
    expect(submit).toContain("disabled");
    expect(submit).toContain("data-busy-label");
    expect(text(button({ label: "x", type: "button", size: "sm", icon: "play" }))).toContain(
      "size-3.5",
    );
  });

  it("link outside only to http and https, in a new tab without referrer", () => {
    const outside = text(
      linkButton({ href: "https://example.com/a", label: "Go", external: true }),
    );
    expect(outside).toContain('target="_blank" rel="noopener noreferrer"');
    expect(
      text(linkButton({ href: "javascript:alert(1)", label: "Go", external: true })),
    ).toContain('href="#"');
    expect(
      text(linkButton({ href: "/admin", label: "Back", icon: "arrow-left", size: "sm" })),
    ).toContain('href="/admin"');
  });

  it("names an icon button for screen readers and marks its state", () => {
    const pressed = text(
      iconButton({ icon: "sun", label: EVIL, pressed: true, name: "theme", value: "light" }),
    );
    expect(pressed).toContain(`aria-label="${ESCAPED}"`);
    expect(pressed).toContain('aria-pressed="true"');
    expect(text(iconButton({ icon: "sun", label: "x" }))).not.toContain('aria-pressed="');
  });
});

describe("forms", () => {
  it("carry the form token and the confirmation texts as data attributes", () => {
    expect(text(csrfField('a"b'))).toBe('<input type="hidden" name="_csrf" value="a&quot;b" />');
    expect(confirmAttributes(undefined)).toBe("");
    const attributes = text(
      confirmAttributes({ title: "T", message: EVIL, ok: "Yes" }) as SafeHtml,
    );
    expect(attributes).toContain(`data-confirm="${ESCAPED}"`);
    expect(attributes).toContain('data-confirm-tone="danger"');
    const control = html`<input id="f" />`;
    const rendered = text(
      field({
        id: "f",
        label: EVIL,
        control,
        hint: EVIL,
        error: EVIL,
        help: helpPopover("More", EVIL),
      }),
    );
    expect(rendered).toContain('for="f"');
    expect(rendered).toContain('id="f-hint"');
    expect(rendered.split(ESCAPED)).toHaveLength(5);
    expect(text(field({ id: "g", label: "x", control }))).not.toContain("g-hint");
  });

  it("copies a value and hides a secret until revealed", () => {
    const labels = { copy: "Copy", copied: "Copied", reveal: "Show" };
    const plain = text(copyField({ id: "c", value: EVIL, masked: null, labels }));
    expect(plain).toContain('id="c-value"');
    expect(plain).toContain('data-copy="c-value"');
    expect(plain).toContain(ESCAPED);
    expect(plain).not.toContain("<details");
    const secret = text(copyField({ id: "s", value: "secret-token", masked: "••••", labels }));
    const outside = secret.replace(/<details[\s\S]*<\/details>/, "");
    expect(outside).not.toContain("secret-token");
    expect(outside).toContain("••••");
    expect(secret).toContain('<code\n        id="s-value"');
  });
});

describe("layout blocks", () => {
  it("render cards, stats, callouts, lists and empty states with escaped content", () => {
    const withHeader = text(
      card({
        id: "x",
        title: EVIL,
        subtitle: EVIL,
        icon: "info",
        actions: "a",
        body: EVIL,
        footer: EVIL,
        flush: true,
      }),
    );
    expect(withHeader).toContain('aria-labelledby="x-title"');
    expect(withHeader.split(ESCAPED)).toHaveLength(5);
    expect(text(card({ body: "b" }))).not.toContain("<header");
    const stat = text(
      statCard({
        label: EVIL,
        value: 3,
        icon: "coins",
        hint: "h",
        meter: { value: 0.5, label: "L" },
      }),
    );
    expect(stat).toContain(ESCAPED);
    expect(stat).toContain('role="meter"');
    expect(
      text(
        callout({ tone: "danger", title: EVIL, body: EVIL, alert: true, id: "c", actions: "x" }),
      ),
    ).toContain('role="alert"');
    expect(text(callout({ tone: "info" }))).not.toContain("role=");
    const list = text(descriptionList([[EVIL, EVIL]]));
    expect(list.split(ESCAPED)).toHaveLength(3);
    const empty = text(emptyState({ icon: "inbox", title: EVIL, text: EVIL, action: "a" }));
    expect(empty.split(ESCAPED)).toHaveLength(3);
  });

  it("fills the usage bar in steps of 5 % and turns amber and red near the limit", () => {
    expect(text(usageBar(0, "L"))).toContain("w-0");
    expect(text(usageBar(0.01, "L"))).toContain("w-[5%]");
    expect(text(usageBar(0.5, "L"))).toContain('w-[50%]"');
    expect(text(usageBar(0.5, "L"))).toContain("bg-brand");
    expect(text(usageBar(0.85, "L"))).toContain("bg-warn");
    expect(text(usageBar(2, "L"))).toContain("w-full");
    expect(text(usageBar(2, "L"))).toContain("bg-danger");
    expect(text(usageBar(Number.NaN, "L"))).toContain('aria-valuenow="0"');
  });

  it("render link tabs, page tabs and segments with the current one marked", () => {
    const links = text(
      linkTabs(EVIL, [
        { href: "/a", label: "A", active: true, count: 3, icon: "info" },
        { href: "/b?x=1&y=2", label: EVIL, active: false, count: null },
      ]),
    );
    expect(links).toContain(`aria-label="${ESCAPED}"`);
    expect(links).toMatch(/aria-current="page"\s*>/);
    expect(links).toContain('href="/b?x=1&amp;y=2"');
    const panels = text(
      pageTabs("Result", [
        { id: "one", label: "One", body: EVIL, selected: true, count: 2, icon: "info" },
        { id: "two", label: "Two", body: "b" },
      ]),
    );
    expect(panels).toContain("data-tabs");
    expect(panels).toContain('href="#one"');
    expect(panels).toContain('data-selected="true"');
    expect(panels).toContain('<section id="two"');
    expect(panels).toContain(ESCAPED);
    const segments = text(
      segmented("Filter", [
        { href: "/a", label: "All", count: 2, active: true },
        { href: "/b", label: "B", active: false },
      ]),
    );
    expect(segments).toMatch(/aria-current="true"\s*>All<span/);
  });

  it("render menus with links and forms, and a confirmation for dangerous ones", () => {
    const items = [
      menuLink({ href: "/admin/jobs/1", label: EVIL, icon: "arrow-right" }),
      menuLink({ href: "javascript:x", label: "out", icon: "external-link", external: true }),
      menuForm({
        action: "/admin/jobs/1/cancel",
        csrf: "tok",
        label: "Cancel",
        icon: "ban",
        danger: true,
        fields: { force: "1" },
        confirm: { title: "T", message: "M", ok: "OK" },
      }),
    ];
    const rendered = text(menu("Actions", items));
    expect(rendered).toContain("data-menu");
    expect(rendered).toContain(ESCAPED);
    expect(rendered).toContain('href="#"');
    expect(rendered).toContain('name="_csrf" value="tok"');
    expect(rendered).toContain('<input type="hidden" name="force" value="1" />');
    expect(rendered).toContain('data-confirm="M"');
    expect(rendered).toContain("text-danger-fg");
  });

  it("render page headers, thumbnails and tables", () => {
    const header = text(
      pageHeader({
        title: EVIL,
        subtitle: EVIL,
        back: { href: "/admin/jobs", label: "Jobs" },
        media: thumbnail("/admin/recipes/x/thumbnail", "lg"),
        meta: EVIL,
        actions: "a",
      }),
    );
    expect(header.split(ESCAPED)).toHaveLength(4);
    expect(header).toContain('width="64"');
    expect(text(thumbnail("/t"))).toContain('loading="lazy"');
    const rendered = text(
      table({
        head: ["A", EVIL],
        rows: [
          html`<tr>
            <td>1</td>
          </tr>`,
        ],
        numeric: [1],
      }),
    );
    expect(rendered).toContain(ESCAPED);
    expect(rendered).toContain("text-right");
  });

  it("render the timeline with errors and collapsed details", () => {
    const rendered = text(
      timeline(
        [
          {
            icon: "circle-x",
            tone: "danger",
            text: EVIL,
            time: html`now`,
            sub: EVIL,
            details: html`<dl></dl>`,
          },
          { icon: "circle-dot", tone: "warn", text: "b", time: html`then`, sub: "w" },
          { icon: "circle-dot", tone: "neutral", text: "c", time: html`then` },
        ],
        "Details",
      ),
    );
    expect(rendered.split(ESCAPED)).toHaveLength(3);
    expect(rendered).toContain("<details");
    expect(rendered).toContain("text-danger-fg");
    expect(rendered).toContain("text-warn-fg");
  });

  it("render notices and the confirmation dialog", () => {
    expect(toasts([], "Close")).toBe("");
    const rendered = text(
      toasts(
        [
          { tone: "ok", text: EVIL },
          { tone: "danger", text: "x" },
          { tone: "info", text: "y" },
        ],
        "Close",
      ) as SafeHtml,
    );
    expect(rendered).toContain(ESCAPED);
    expect(rendered).toContain("animate-toast");
    expect(rendered).toContain("data-toast-close");
    const dialog = text(confirmDialog({ cancel: "No", confirm: "Yes" }));
    expect(dialog).toContain('id="confirm-dialog"');
    expect(dialog).toContain('method="dialog"');
    expect(dialog).toContain('value="ok"');
  });
});
