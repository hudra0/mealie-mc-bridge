// English texts for the timeline, mails and admin pages.

import { escapeMarkdown, formatDate, formatNumber, shorten } from "./format.js";
import type { FailureStage, Messages } from "./index.js";

const MAX_DETAIL = 400;
const INTL = "en-US";

const FAILURE_REASONS: Readonly<Record<FailureStage, string>> = {
  load: "recipe not readable",
  prepare: "preparation failed",
  categories: "categories not available",
  convert: "conversion failed",
  validate: "checks not passed",
  ingredients: "ingredient lookup failed",
  upload: "upload failed",
  unexpected: "unexpected error",
};

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const en: Messages = {
  language: "en",
  intlLocale: INTL,
  timeline: {
    createdSubject: (status) =>
      status === "draft"
        ? "Monsieur Cuisine: draft created"
        : "Monsieur Cuisine: recipe saved to the device",
    created(text) {
      const status =
        text.status === "draft"
          ? "draft; it shows up on the device only after “Save on my device only” in the editor"
          : text.statusFailed
            ? "draft; saving it privately failed, please choose “Save on my device only” in the editor"
            : "saved privately, visible on your device only";
      const lines = [
        `The recipe is in your Monsieur Cuisine account: [Open in the editor](${text.url})`,
        "",
        `- Serving size: ${text.servings} ${escapeMarkdown(text.servingUnit)}`,
        `- Status: ${status}`,
        `- Converted with: ${escapeMarkdown(text.provider)}, ${escapeMarkdown(text.model)}`,
      ];
      if (text.imageSkipped) lines.push("- Photo: not transferred, please add it in the editor");
      if (text.reviewHints.length > 0) {
        lines.push(
          "",
          "**Please check:**",
          ...text.reviewHints.map((hint) => `- ${escapeMarkdown(hint)}`),
        );
      }
      lines.push(
        "",
        "A language model wrote the steps. Check amounts, cooking times and temperatures in the editor before you cook the recipe.",
      );
      return lines.join("\n");
    },
    unchangedSubject: "Monsieur Cuisine: unchanged",
    unchanged(text) {
      const link = text.status === "draft" ? "Open the draft" : "Open the recipe";
      return `Unchanged, already sent on ${formatDate(text.sentAt, INTL)}: [${link}](${text.url})`;
    },
    failedSubject(stage) {
      return `Monsieur Cuisine: error – ${FAILURE_REASONS[stage]}`;
    },
    failed(text) {
      return [
        `${capitalized(FAILURE_REASONS[text.stage])}: ${escapeMarkdown(shorten(text.detail, MAX_DETAIL))}`,
        "",
        "The details are on the bridge's admin page, where the job can be started again.",
      ].join("\n");
    },
    sessionSubject: "Monsieur Cuisine: session expired",
    session() {
      return "The bridge is not logged in to Monsieur Cuisine right now. The job waits and continues on its own as soon as a new session is saved on the admin page.";
    },
    limitSubject: "Monsieur Cuisine: not sent, daily limit reached",
    limit(text) {
      return text.kind === "jobs"
        ? `The bridge accepts at most ${formatNumber(text.limit, INTL)} recipes in 24 hours, and that many arrived. Please try again later; the operator can raise JOB_DAILY_LIMIT.`
        : `The language model costs of the last 24 hours have reached the limit of ${formatNumber(text.limit, INTL)} USD. Please try again later; the operator can raise JOB_DAILY_COST_LIMIT_USD.`;
    },
    failureReasons: FAILURE_REASONS,
  },
  jobEvents: {
    converting: "Conversion started",
    stillConverting: (seconds) => `Still converting, ${seconds} s`,
  },
  email: {
    subjectPrefix: "Monsieur Cuisine bridge",
    session: {
      expired: {
        subject: "Session expired",
        lead: "The bridge's Monsieur Cuisine session has expired.",
      },
      invalid: {
        subject: "Session invalid",
        lead: "Monsieur Cuisine refuses the stored session cookie, or there is none.",
      },
    },
    sessionWaiting:
      "New jobs from Mealie wait until a valid session is saved, then they continue on their own.",
    sessionNextSteps: [
      "What to do, one of three ways:",
      "1. Store the Lidl account on the admin page under Settings (/admin/settings); the bridge then logs in by itself.",
      "2. Run the login helper on your computer: npm run mc:login -- --bridge <bridge address> (see the README, section “Monsieur Cuisine session”).",
      "3. Log in on www.monsieur-cuisine.com, copy the cookie from the browser's developer tools and paste it on the admin page (/admin).",
    ],
    autoLoginWaiting: (time) =>
      `The automatic login with the stored Lidl account tries again after ${time}; it waits that long after earlier attempts. To continue sooner, use "Test login now" on the settings page, the login helper or the cookie form.`,
    autoLoginFailed: (reason) =>
      `The automatic login with the stored Lidl account did not work (${reason}). Please log in by hand once: with the login helper or by pasting the cookie.`,
    lastChecked: (when) => `Last checked: ${when}`,
    never: "never",
    lastMessage: (message) => `Last message: ${message}`,
    jobFailedSubject: (title) => `“${title}” not sent`,
    jobFailedLead: (title) => `The recipe “${title}” could not be sent to Monsieur Cuisine.`,
    error: (message) => `Error: ${message}`,
    job: (id) => `Job: ${id}`,
    attempts: (count) => `Attempts: ${count}`,
    recipeInMealie: (url) => `Recipe in Mealie: ${url}`,
    jobRetry: "The job can be started again on the bridge's admin page (/admin/jobs).",
    healthSubject: "Session check failed",
    healthLead:
      "The regular check of the Monsieur Cuisine session failed. Monsieur Cuisine did not refuse the session; usually the website is briefly unreachable.",
    healthOutro: "The bridge keeps checking. If the error persists, look at the logs.",
  },
  admin: {
    htmlLang: "en",
    nav: {
      dashboard: "Dashboard",
      jobs: "Jobs",
      dryRun: "Dry run",
      settings: "Settings",
      logout: "Log out",
    },
    header: {
      mcSession: "MC session",
      signedIn: (user) => `signed in as ${user}`,
      noPassword: "no password",
    },
    login: {
      title: "Log in",
      intro: "Log in with ADMIN_USER and ADMIN_PASSWORD. The login lasts 12 hours.",
      user: "User",
      password: "Password",
      submit: "Log in",
      wrongCredentials: "User or password is wrong.",
      tooMany: (minutes) =>
        `Too many failed logins from this address. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
    },
    autoRefresh: "This page reloads every 5 seconds while a job is queued or running.",
    authBanner: "The admin pages have no password. Set ADMIN_USER and ADMIN_PASSWORD.",
    notices: {
      "session-saved": "Session saved. Jobs that were waiting for it are queued again.",
      "session-checked": "Session checked.",
      "job-queued": "Job queued again.",
      "job-forced": "Job queued again; it will be sent even if the recipe is unchanged.",
      "job-cancelled": "Job cancelled.",
      "logged-out": "Logged out.",
      "credentials-saved": "Lidl account saved, encrypted.",
      "credentials-deleted": "Lidl account deleted.",
      "login-started": "Login started. This page reloads until it is done.",
      "login-running": "A login is already running.",
      "login-no-credentials": "Store the Lidl account first.",
      "login-cooldown": "A manual test runs at most every 3 minutes. Try again shortly.",
    },
    plain: {
      unknownHost: "Unknown host name. Add it to ADMIN_HOSTS or use the IP address.",
      authRequired: "Authentication required",
      crossOrigin: "Cross-origin request refused",
    },
    titles: {
      dashboard: "Dashboard",
      jobs: "Jobs",
      job: "Job",
      notFound: "Not found",
      notPossible: "Not possible",
      formExpired: "Form expired",
      dryRun: "Dry run",
    },
    errors: {
      formExpired:
        "The form has expired (the bridge restarted, or the page came from elsewhere). Reload the page and try again.",
      cookieEmpty: "The cookie field is empty.",
      cookieRejected: (reason) =>
        `${reason}. The cookie was not stored. Log in again and copy a fresh one.`,
      cookieUnchecked: (reason) =>
        `The cookie could not be checked, so it was not stored: ${reason}`,
      noSuchJob: "No such job.",
      recipeNotLoaded: (reason) => `The recipe could not be loaded: ${reason}`,
      conversionLinkExpired:
        "The conversion link has expired (the bridge restarted, or the link came from elsewhere). Use the button below.",
      conversionFailed: (reason) => `The conversion failed: ${reason}`,
      credentialsInvalid: (field) =>
        field === "email"
          ? "The account was not saved: the e-mail address is not valid."
          : "The account was not saved: the password is empty.",
    },
    links: {
      backToDashboard: "Back to the dashboard",
      backToJobs: "Back to the jobs",
      allJobs: "All jobs",
    },
    jobStatus: {
      queued: "queued",
      running: "running",
      done: "done",
      skipped: "skipped",
      failed: "failed",
      session_expired: "session expired",
      cancelled: "cancelled",
    },
    sessionState: {
      valid: "valid",
      invalid: "invalid",
      expired: "expired",
      unknown: "unknown",
    },
    jobsTable: {
      empty: "No jobs yet.",
      created: "Created",
      recipe: "Recipe",
      scale: "Scale",
      status: "Status",
      attempts: "Attempts",
      result: "Result",
      recipeLink: (id, status) => `${status === "draft" ? "draft" : "recipe"} ${id}`,
    },
    dashboard: {
      session: "Monsieur Cuisine session",
      state: "State",
      lastCheck: "Last check",
      cookieAge: "Cookie age",
      noCookie: "no cookie",
      age: (hours, from) => {
        const value =
          hours < 48 ? `${formatNumber(hours, INTL)} h` : `${formatNumber(hours / 24, INTL)} days`;
        return `${value} ${from === "login" ? "since the login" : "since it was stored in the bridge"}`;
      },
      cookieExpires: "Login expires",
      expiresAt: (time, expired) => `${time}${expired ? " (expired)" : ""}`,
      lastError: "Last error",
      newRecipes: "New recipes",
      privatePublish: "saved on the device only",
      draftOnly: "kept as drafts, not shown on the device",
      checkNow: "Check now",
      cookieLabel:
        "Paste the `Cookie` request header of a logged-in www.monsieur-cuisine.com tab (DevTools, Network, any `proxy-api` request). It is checked against your account before it is stored, encrypted.",
      saveSession: "Save session",
      queue: "Queue",
      worker: "Worker:",
      unknown: "unknown",
      paused: "paused until the session works",
      running: "running",
      stopped: "stopped",
      lastWorkerError: (time) => `Last worker error (${time}):`,
      recentJobs: "Recent jobs",
      dryRun: "Dry run",
    },
    jobList: {
      status: "Status",
      all: "all",
      recipe: "Recipe",
      searchPlaceholder: "title, slug or id",
      filter: "Filter",
      newer: "Newer",
      older: "Older",
    },
    jobDetail: {
      status: "Status",
      job: "Job",
      mealieRecipe: "Mealie recipe",
      monsieurCuisine: "Monsieur Cuisine",
      openRecipe: (id, status) =>
        `open ${status === "draft" ? "draft" : "recipe"} ${id} in the editor`,
      scale: "Scale",
      servingSize: (amount, unit) => ` (${amount} ${unit ?? "servings"})`,
      attempts: "Attempts",
      forced: " · forced",
      created: "Created",
      started: "Started",
      finished: "Finished",
      model: "Model",
      usage: "Usage",
      tokens: (input, cached, output) =>
        `${input} input${cached ? ` (${cached} cached)` : ""}, ${output} output tokens`,
      ingredientIds: "Ingredient ids",
      resolutionOff: (unresolved) => `resolution off (${unresolved} without id)`,
      resolution: (catalog, relaxed, cache, search, unresolved) =>
        `${catalog} catalog${relaxed > 0 ? ` (${relaxed} without qualifiers in the name)` : ""}, ${cache} cache, ${search} search, ${unresolved} without id`,
      withoutId: "Without id",
      reviewHints: "Review hints",
      warnings: "Converter warnings",
      error: "Error",
      runningLocked: "Running jobs cannot be changed.",
      retry: "Retry",
      forceRebuild: "Force rebuild",
      cancel: "Cancel",
      events: "Events",
      time: "Time",
      level: "Level",
      message: "Message",
    },
    settings: {
      title: "Settings",
      account: "Automatic login",
      intro:
        "With the e-mail address and password of your Lidl account for monsieur-cuisine.com, the bridge logs in by itself in a headless browser whenever the session has expired. Both are stored encrypted with SETTINGS_KEY and never shown again. A login runs at most once per hour and three times a day; after a failure it waits longer. A captcha or a second factor stops it, and you get the session mail.",
      email: "E-mail address",
      password: "Password",
      passwordStored: "stored; leave empty to keep it",
      save: "Save account",
      testNow: "Test login now",
      remove: "Delete account",
      notConfigured: "No account stored.",
      configuredAs: (email) => `Stored account: ${email}`,
      browser: "Browser",
      browserReady: "headless Chromium available",
      browserMissing: (reason) => `not available: ${reason}`,
      lastAttempt: "Last login attempt",
      never: "none yet",
      attempt: (time, ok, manual) =>
        `${time}: ${ok ? "succeeded" : "failed"}${manual ? " (manual test)" : ""}`,
      failure: {
        browser_unavailable: "The browser is not available.",
        no_login_form:
          "No login form showed up: the page changed, or a captcha or consent screen came first.",
        not_logged_in:
          "The form was sent, but no session followed: a wrong password, a captcha or a second factor.",
        unexpected_page:
          "A login form showed up on a page that is not the Lidl login; nothing was typed into it.",
        verify_failed: "The site logged in, but Monsieur Cuisine refused the new session.",
        error: "The browser failed.",
      },
      screenshot: "Screenshot of the page",
      nextAttempt: "Next automatic attempt not before",
      running: "A login is running.",
      manualCooldown: (time) => `Next manual test from ${time}`,
      otherWays:
        "Other ways to renew the session: the login helper on your computer (npm run mc:login) or pasting the cookie on the dashboard.",
    },
    dryRun: {
      recipe: "Recipe",
      recipePlaceholder: "id or slug",
      scale: "Scale",
      preview: "Preview",
      alsoConvert: "Convert right away (calls the language model; this costs money)",
      servings: "Serving size",
      servingsEstimated:
        "default, not stated in the recipe; the model estimates it and flags it as a review hint",
      sourceHash: "Source hash",
      alreadySent: "Already sent",
      sentAt: (time) => `yes, ${time}:`,
      wouldSkip: "(a job would be skipped unless forced)",
      no: "no",
      convert: "Convert without uploading",
      costsMoney: "Calls the language model; this costs money.",
      ingredients: "Ingredients",
      section: "Section",
      amount: "Amount",
      unit: "Unit",
      food: "Food",
      note: "Note",
      source: "Source",
      original: "Original",
      optional: "(optional)",
      converterInput: "Converter input (Markdown)",
      conversion: "Conversion",
      model: "Model",
      attempts: (count) => `${count} ${count === 1 ? "attempt" : "attempts"}`,
      usage: "Usage",
      tokens: (input, output) => `${input} input, ${output} output tokens`,
      title: "Title",
      times: "Times",
      timesValue: (preparation, ready) =>
        `${preparation} min preparation, ${ready} min until ready`,
      categories: "Categories",
      none: "none",
      droppedIds: (ids) => `· dropped unknown ids ${ids}`,
      validation: "Validation",
      passed: "passed",
      errors: (count) => `${count} ${count === 1 ? "error" : "errors"}`,
      field: "Field",
      problem: "Problem",
      reviewHints: "Review hints",
      noHints: "None.",
      warnings: "Converter warnings",
      steps: "Steps",
      kind: "Kind",
      settings: "Settings",
      text: "Text",
      ingredientGroups: "Ingredient groups",
    },
  },
};
