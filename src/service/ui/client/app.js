// The script of the admin pages. Every page works without it; it adds conveniences on top:
// theme switch without a reload, copy buttons, live relative times, a confirmation dialog
// for destructive forms, closing menus, in-page tabs, the recipe search of the dry run,
// dismissible notices and the reload of pages that follow a running job.
//
// Served from /admin/assets under a content security policy that allows no inline script,
// so it reads its settings from data attributes and builds markup with DOM methods only.

(() => {
  "use strict";

  const root = document.documentElement;
  root.classList.add("js");
  const lang = root.lang || "en";

  const ready = (fn) => {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  };

  // Theme: the forms post to /admin/theme without JS; here the cookie is set directly.
  function setupTheme() {
    for (const form of document.querySelectorAll("form[data-theme-form]")) {
      form.addEventListener("submit", (event) => {
        const button = event.submitter;
        if (!button || !button.value) return;
        event.preventDefault();
        const theme = button.value;
        const secure = location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `mcb_theme=${theme}; Path=/admin; Max-Age=31536000; SameSite=Lax${secure}`;
        root.dataset.theme = theme;
        for (const other of form.querySelectorAll("button[value]")) {
          other.setAttribute("aria-pressed", String(other === button));
        }
      });
    }
  }

  // Copy buttons: data-copy names the element whose text is copied.
  function setupCopy() {
    document.addEventListener("click", async (event) => {
      const button = event.target instanceof Element && event.target.closest("[data-copy]");
      if (!button) return;
      const source = document.getElementById(button.dataset.copy || "");
      if (!source) return;
      const text = source.textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("copy");
        selection.removeAllRanges();
      }
      const label = button.querySelector("[data-copy-label]");
      if (label) {
        const before = label.textContent;
        label.textContent = button.dataset.copied || before;
        button.dataset.state = "copied";
        setTimeout(() => {
          label.textContent = before;
          delete button.dataset.state;
        }, 1500);
      }
    });
  }

  // Relative times ("vor 3 Minuten"), updated every 30 seconds; the title keeps the date.
  function relative(iso, now) {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return null;
    const seconds = Math.round((then - now) / 1000);
    const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    const abs = Math.abs(seconds);
    if (abs < 60) return format.format(seconds, "second");
    if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
    if (abs < 86400) return format.format(Math.round(seconds / 3600), "hour");
    return format.format(Math.round(seconds / 86400), "day");
  }

  function setupTimes() {
    const update = () => {
      const now = Date.now();
      for (const time of document.querySelectorAll("time[data-relative]")) {
        const text = relative(time.getAttribute("datetime"), now);
        if (text) time.textContent = text;
      }
    };
    update();
    setInterval(update, 30000);
  }

  // Forms with data-confirm ask first, in the dialog of the page.
  function setupConfirm() {
    const dialog = document.getElementById("confirm-dialog");
    if (!dialog || typeof dialog.showModal !== "function") return;
    const title = dialog.querySelector("[data-confirm-title]");
    const message = dialog.querySelector("[data-confirm-message]");
    const ok = dialog.querySelector("[data-confirm-ok]");
    let pending = null;
    document.addEventListener(
      "submit",
      (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || !form.dataset.confirm) return;
        if (form.dataset.confirmed === "1") {
          delete form.dataset.confirmed;
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        pending = { form, submitter: event.submitter };
        title.textContent = form.dataset.confirmTitle || "";
        message.textContent = form.dataset.confirm;
        ok.textContent = form.dataset.confirmOk || ok.dataset.default;
        ok.dataset.tone = form.dataset.confirmTone || "danger";
        dialog.showModal();
      },
      true,
    );
    dialog.addEventListener("close", () => {
      const current = pending;
      pending = null;
      if (!current || dialog.returnValue !== "ok") return;
      current.form.dataset.confirmed = "1";
      if (current.submitter) current.form.requestSubmit(current.submitter);
      else current.form.requestSubmit();
    });
  }

  // Menus (details[data-menu]): one open at a time, closed by Escape or a click outside.
  function setupMenus() {
    const menus = () => document.querySelectorAll("details[data-menu][open]");
    document.addEventListener("click", (event) => {
      for (const menu of menus()) {
        if (!menu.contains(event.target)) menu.removeAttribute("open");
      }
    });
    document.addEventListener(
      "toggle",
      (event) => {
        const opened = event.target;
        if (!(opened instanceof HTMLDetailsElement) || !opened.open) return;
        if (!opened.matches("[data-menu]")) return;
        for (const menu of menus()) if (menu !== opened) menu.removeAttribute("open");
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      for (const menu of menus()) {
        menu.removeAttribute("open");
        menu.querySelector("summary")?.focus();
      }
      const drawer = document.getElementById("nav-open");
      if (drawer && drawer.checked) drawer.checked = false;
    });
  }

  // In-page tabs: without the script every panel shows, one below the other.
  function setupTabs() {
    for (const container of document.querySelectorAll("[data-tabs]")) {
      const links = [...container.querySelectorAll("[data-tab]")];
      const panels = links.map((link) => document.getElementById(link.dataset.tab));
      if (links.length === 0 || panels.some((panel) => !panel)) continue;
      const list = links[0].parentElement;
      list.setAttribute("role", "tablist");
      const select = (index, focus) => {
        links.forEach((link, i) => {
          const selected = i === index;
          link.setAttribute("aria-selected", String(selected));
          link.tabIndex = selected ? 0 : -1;
          panels[i].hidden = !selected;
        });
        if (focus) links[index].focus();
      };
      links.forEach((link, i) => {
        link.setAttribute("role", "tab");
        link.setAttribute("aria-controls", panels[i].id);
        panels[i].setAttribute("role", "tabpanel");
        panels[i].setAttribute("aria-labelledby", link.id);
        panels[i].querySelector("[data-tab-heading]")?.classList.add("sr-only");
        link.addEventListener("click", (event) => {
          event.preventDefault();
          select(i, false);
        });
        link.addEventListener("keydown", (event) => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
          if (!step) return;
          event.preventDefault();
          select((i + step + links.length) % links.length, true);
        });
      });
      const initial = links.findIndex((link) => link.dataset.selected === "true");
      select(initial < 0 ? 0 : initial, false);
    }
  }

  // The recipe field of the dry run asks the bridge for recipes by name while typing.
  function setupRecipeSearch() {
    for (const input of document.querySelectorAll("input[data-recipe-search]")) {
      const endpoint = input.dataset.recipeSearch;
      const list = document.getElementById(input.getAttribute("aria-controls") || "");
      if (!endpoint || !list) continue;
      let items = [];
      let active = -1;
      let timer;
      let request = 0;
      const close = () => {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        active = -1;
      };
      const choose = (item) => {
        input.value = item.slug;
        close();
      };
      const highlight = (index) => {
        active = index;
        [...list.children].forEach((option, i) => {
          option.setAttribute("aria-selected", String(i === index));
        });
        if (index >= 0) input.setAttribute("aria-activedescendant", list.children[index].id);
      };
      const render = () => {
        list.replaceChildren();
        if (items.length === 0) return close();
        items.forEach((item, index) => {
          const option = document.createElement("li");
          option.id = `${list.id}-${index}`;
          option.setAttribute("role", "option");
          option.className = list.dataset.optionClass || "";
          const name = document.createElement("span");
          name.className = "block truncate font-medium";
          name.textContent = item.name;
          const slug = document.createElement("span");
          slug.className = "block truncate text-xs text-fg-muted";
          slug.textContent = item.slug;
          option.append(name, slug);
          option.addEventListener("mousedown", (event) => {
            event.preventDefault();
            choose(item);
          });
          list.append(option);
          if (index === active) option.setAttribute("aria-selected", "true");
        });
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
      };
      const search = async () => {
        const query = input.value.trim();
        if (query.length < 2) {
          items = [];
          return close();
        }
        const mine = ++request;
        try {
          const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
            headers: { accept: "application/json" },
            credentials: "same-origin",
          });
          if (!response.ok || mine !== request) return;
          const body = await response.json();
          items = Array.isArray(body.recipes) ? body.recipes.slice(0, 10) : [];
          active = -1;
          render();
        } catch {
          // The plain text field still works.
        }
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(search, 250);
      });
      input.addEventListener("keydown", (event) => {
        if (list.hidden) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          highlight(Math.min(items.length - 1, active + 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          highlight(Math.max(0, active - 1));
        } else if (event.key === "Enter" && active >= 0) {
          event.preventDefault();
          choose(items[active]);
        } else if (event.key === "Escape") {
          close();
        }
      });
      input.addEventListener("blur", () => setTimeout(close, 100));
    }
  }

  // Notices close on a click; the stylesheet fades them out after a while anyway.
  function setupToasts() {
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element && event.target.closest("[data-toast-close]");
      if (button) button.closest("[data-toast]")?.remove();
    });
  }

  // Forms with data-busy disable their button while the request runs.
  function setupBusy() {
    document.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-busy")) return;
      if (event.defaultPrevented) return;
      const button = event.submitter;
      if (!button) return;
      setTimeout(() => {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        const label = button.querySelector("[data-busy-label]");
        if (label && form.dataset.busy) label.textContent = form.dataset.busy;
      }, 0);
    });
  }

  // Pages that follow a running job reload, unless the person is busy on the page.
  function setupRefresh() {
    const seconds = Number(document.body.dataset.refresh);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const busy = () =>
      document.hidden ||
      document.querySelector("details[data-menu][open], dialog[open]") !== null ||
      (document.activeElement && document.activeElement.matches("input, textarea, select")) ||
      String(getSelection()).trim() !== "";
    const tick = () => {
      if (busy()) setTimeout(tick, 2000);
      else location.reload();
    };
    setTimeout(tick, seconds * 1000);
  }

  ready(() => {
    setupTheme();
    setupCopy();
    setupTimes();
    setupConfirm();
    setupMenus();
    setupTabs();
    setupRecipeSearch();
    setupToasts();
    setupBusy();
    setupRefresh();
  });
})();
