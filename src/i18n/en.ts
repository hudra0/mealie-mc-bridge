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
    queued: ({ scale, force }) => `Queued with scale ${scale}${force ? ", forced" : ""}`,
    requeued: ({ force }) => (force ? "Queued again, forced" : "Queued again"),
    cancelled: () => "Cancelled",
    paused: () => "Waiting for a valid Monsieur Cuisine session",
    resumed: () => "Session renewed, queued again",
    recovered_done: () =>
      "Interrupted by a restart after the draft was created; the Mealie write-back may be incomplete",
    recovered_failed: () =>
      "Interrupted while the draft was being created. The draft may exist on monsieur-cuisine.com: check your drafts before you retry this job.",
    recovered_queued: () => "Interrupted by a restart, queued again",
    attempt_started: ({ attempt }) => `Attempt ${attempt} started`,
    recipe_loaded: ({ name }) => `Loaded recipe "${name}" from Mealie`,
    prepared: ({ ingredients, unparsed, servings, estimated, scale }) =>
      `Prepared ${ingredients} ingredients (${unparsed} unparsed) for ${servings}${estimated ? " (not stated in the recipe; the converter may estimate)" : ""} at scale ${scale}`,
    forced_unchanged: () => "Forced: sending again although the recipe is unchanged",
    skip_exists: ({ since, recipeId }) =>
      `Unchanged since ${formatDate(since, INTL)}; recipe ${recipeId} still exists on Monsieur Cuisine, skipped`,
    skip_gone: ({ since, recipeId }) =>
      `Unchanged since ${formatDate(since, INTL)}, but recipe ${recipeId} no longer exists on Monsieur Cuisine; converting again`,
    skip_unchecked: ({ since, recipeId }) =>
      `Unchanged since ${formatDate(since, INTL)}; recipe ${recipeId} could not be checked on Monsieur Cuisine, skipped`,
    image_loaded: ({ kb }) => `Loaded the image (${kb} KB)`,
    image_none: () => "The recipe has no image",
    image_load_failed: () => "Image not loaded, continuing without",
    categories: ({ count, matched }) =>
      `${count} categories available; matched: ${matched.length > 0 ? matched.join(", ") : "none"}`,
    conversion_reused: ({ provider, model }) =>
      `Reusing the conversion of an earlier attempt (${provider}/${model}); no new model call`,
    converting: () => "Conversion started",
    still_converting: ({ seconds }) => `Still converting, ${seconds} s`,
    converted: ({ provider, model, attempts, inputTokens, outputTokens, costUsd }) =>
      `Converted with ${provider}/${model} in ${attempts} ${attempts === 1 ? "attempt" : "attempts"} (${inputTokens} input, ${outputTokens} output tokens${costUsd === null ? "" : `, $${costUsd.toFixed(4)}`})`,
    converter_warning: ({ text }) => `Converter: ${text}`,
    categories_dropped: ({ ids }) =>
      `Dropped category ids the catalog does not know: ${ids.join(", ")}`,
    servings_estimated: ({ servings }) => `The converter estimated the serving size: ${servings}`,
    servings_changed: ({ requested, converted }) =>
      `The converter set ${converted} instead of ${requested}`,
    validation_passed: () => "Checks passed",
    ingredients_resolved: ({ catalog, relaxed, cache, search, unresolved }) =>
      `Ingredients resolved: ${catalog} catalog${relaxed > 0 ? ` (${relaxed} relaxed)` : ""}, ${cache} cache, ${search} search, ${unresolved} without id`,
    ingredients_off: ({ unresolved }) =>
      `Ingredient ids not resolved (MC_RESOLVE_INGREDIENTS=off): ${unresolved} without id`,
    image_skipped: () => "Image skipped",
    image_uploaded: () => "Uploaded the image",
    draft_created: ({ recipeId }) => `Created recipe ${recipeId} on Monsieur Cuisine`,
    status_private: () => "Saved on the device only",
    status_failed: () =>
      "Status change failed; the recipe stays a draft and does not show up on the device",
    tag_unavailable: ({ tag }) => `Tag "${tag}" not available`,
    writeback_done: ({ tagged }) =>
      tagged ? "Tagged the Mealie recipe and stored the link" : "Stored the link in Mealie",
    writeback_forbidden: () =>
      "Mealie refused to update the recipe (403): the bridge user needs edit rights on it",
    writeback_failed: () => "Updating the Mealie recipe failed",
    timeline_posted: () => "Posted the timeline entry in Mealie",
    timeline_failed: () => "Timeline entry in Mealie failed",
    done: () => "Done",
    interrupted: () => "Interrupted by shutdown; the job runs again after the restart",
    session_unusable: ({ kind }) =>
      `Monsieur Cuisine session not usable (${kind}); waiting for a new one`,
    temporary_failure: ({ stage }) => `Temporary error: ${FAILURE_REASONS[stage]}`,
    failed: ({ stage }) => capitalized(FAILURE_REASONS[stage]),
    crashed: () => "Crashed",
    retry_scheduled: ({ retry, max, seconds }) => `Retry ${retry} of ${max} in ${seconds} s`,
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
      "3. Log in on www.monsieur-cuisine.com, copy the cookie from the browser's developer tools and paste it on the admin settings page (/admin/settings).",
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
    testSubject: "Test mail",
    testText:
      "This is a test mail from the settings page. Mails about an expired session and failed jobs go to this address.",
  },
  admin: {
    htmlLang: "en",
    nav: {
      dashboard: "Overview",
      jobs: "Jobs",
      dryRun: "Dry run",
      settings: "Settings",
      logout: "Log out",
      label: "Main navigation",
    },
    header: {
      mcSession: "MC session",
      signedIn: (user) => `signed in as ${user}`,
      noPassword: "no password",
    },
    authBanner: "The admin pages have no password. Set ADMIN_USER and ADMIN_PASSWORD.",
    skipToContent: "Skip to content",
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
      dashboard: "Overview",
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
      noSuchJob: "No such job. It may have been removed, or the link is wrong.",
      recipeNotLoaded: (reason) => `The recipe could not be loaded: ${reason}`,
      conversionFailed: (reason) => `The conversion failed: ${reason}`,
      credentialsInvalid: (field) =>
        field === "email"
          ? "The account was not saved: the e-mail address is not valid."
          : "The account was not saved: the password is empty.",
    },
    links: {
      backToDashboard: "Back to the overview",
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
    jobStatusHelp: {
      queued: "Waiting for the worker. It starts within seconds unless another job runs.",
      running: "The bridge is converting or uploading the recipe right now.",
      done: "The recipe is in your Monsieur Cuisine account.",
      skipped:
        "The same recipe with the same scale was sent before and has not changed, so nothing was uploaded.",
      failed: "Stopped with an error. The job page names it and lets you start the job again.",
      session_expired:
        "Waiting for a valid Monsieur Cuisine session. It continues by itself once the session works again.",
      cancelled: "Cancelled by hand. It will not run.",
    },
    sessionState: {
      valid: "valid",
      invalid: "invalid",
      expired: "expired",
      unknown: "unknown",
    },
    jobsTable: {
      empty: "No jobs yet.",
      emptyHint:
        "Open a recipe in Mealie, pick the bridge's recipe action from the three-dot menu, and the job shows up here. The overview shows how to set up that action.",
      created: "Created",
      recipe: "Recipe",
      scale: "Scale",
      status: "Status",
      duration: "Duration",
      cost: "Cost",
      result: "Result",
      recipeLink: (id, status) => `${status === "draft" ? "draft" : "recipe"} ${id}`,
    },
    setup: {
      title: "Getting started",
      lead: "Five steps from a fresh install to the first recipe on the machine. The marks show what the bridge can see right now.",
      stepState: { done: "done", open: "to do", failed: "problem", unknown: "unknown" },
      mealie: {
        title: "Mealie reachable with the API token",
        ok: (url) => `Mealie at \`${url}\` answers and accepts the API token.`,
        failed: (url) => `Mealie at \`${url}\` did not accept the request.`,
        unchecked: (url) => `Not checked. Mealie address: \`${url}\`.`,
        fix: "Check `MEALIE_URL` (how the bridge reaches Mealie, for example `http://mealie:9000` on a shared Docker network) and `MEALIE_API_TOKEN` in `.env`, then restart the bridge.",
        timeout: (seconds) => `no answer within ${seconds} s`,
      },
      session: {
        title: "Monsieur Cuisine session",
        valid: "Valid. The bridge can upload recipes.",
        validUntil: (time, expired) =>
          expired
            ? `Valid at the last check, but the login behind it ended on ${time}.`
            : `Valid. The login ends on ${time}; the bridge renews it or tells you before then.`,
        notValid: (state) =>
          `State: ${state}. Without a valid session nothing can be uploaded; jobs wait until it works.`,
        fix: "Renew the session on the settings page",
      },
      autoLogin: {
        title: "Automatic login (recommended)",
        configured: (email) =>
          `Configured with ${email}. When the session expires, the bridge logs in again by itself.`,
        notConfigured:
          "Not configured. Without it you renew the session by hand about every two weeks.",
        fix: "Store the Lidl account on the settings page",
        unavailable: "Not available in this setup.",
      },
      action: {
        title: "Recipe action in Mealie",
        seen: (jobs) =>
          `Mealie has called the bridge: ${jobs} ${jobs === 1 ? "job" : "jobs"} so far.`,
        notSeen: "Mealie has not called the bridge yet.",
        where:
          "In Mealie open Settings › Data Management › Recipe Actions and add an action. Title: for example `Send to Monsieur Cuisine`. Type: `post`. URL:",
        reveal: "Show the URL with the token",
        dockerLabel:
          "Mealie and the bridge on one Docker network (the compose service is called mc-bridge):",
        pageLabel: "Or the address you opened this page with, if Mealie reaches the bridge there:",
        secret:
          "The token is the only protection of the webhook. Do not share the URL; to change it, set a new WEBHOOK_TOKEN and update the action.",
        noToken: "The webhook token is not known to this page.",
        network:
          'Mealie 3.26 and newer post only to hosts on its allow list: add `HTTP_ALLOW_LIST: "mc-bridge"` to Mealie\'s environment. Every household that wants the button needs its own action.',
      },
      firstJob: {
        title: "First recipe sent",
        done: (count) =>
          `${count} ${count === 1 ? "recipe" : "recipes"} sent. Find them on the machine under your own recipes.`,
        notYet:
          "Open a recipe in Mealie, set the servings, pick the action from the three-dot menu and follow the job under Jobs. A conversion takes one to a few minutes.",
      },
    },
    dashboard: {
      lead: "The state of the bridge at a glance: what is set up, what is waiting, and what went wrong last.",
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
      checkNow: "Check now",
      cookieLabel:
        "Paste the `Cookie` request header of a logged-in www.monsieur-cuisine.com tab (DevTools, Network, any `proxy-api` request). It is checked against your account before it is stored, encrypted.",
      saveSession: "Save session",
      queue: "Queue",
      queueLead:
        "Jobs per status. The worker runs one job at a time and pauses while the session does not work.",
      worker: "Worker:",
      unknown: "unknown",
      paused: "paused until the session works",
      running: "running",
      stopped: "stopped",
      workerError: (time) => `Worker error at ${time}`,
      jobError: (time) => `Failed job at ${time}`,
      noErrors: "No errors so far.",
      recentJobs: "Last 10 jobs",
    },
    jobList: {
      lead: "Every recipe Mealie sent to the bridge, newest first. Open a job for its timeline, the points to check before cooking and the retry buttons.",
      status: "Status",
      all: "all",
      recipe: "Recipe",
      searchPlaceholder: "title, slug or id",
      filter: "Filter",
      reset: "Show all jobs",
      noMatch: "No jobs match this filter.",
      noMore: "No older jobs.",
      newer: "Newer",
      older: "Older",
      legend: "What the statuses mean",
    },
    jobDetail: {
      lead: "One recipe from Mealie on its way to the machine: what happened, what to check, and what you can do with it.",
      facts: "Details",
      job: "Job",
      mealieRecipe: "Mealie recipe",
      monsieurCuisine: "Monsieur Cuisine",
      openRecipe: (id, status) =>
        `open ${status === "draft" ? "draft" : "recipe"} ${id} in the editor`,
      openInMealie: "open in Mealie",
      scale: "Scale",
      servingSize: (amount, unit) => ` (${amount} ${unit ?? "servings"})`,
      attempts: "Attempts",
      forced: " · forced",
      created: "Created",
      started: "Started",
      finished: "Finished",
      duration: "Duration",
      model: "Model",
      usage: "Usage",
      tokens: (input, cached, output) =>
        `${input} input${cached ? ` (${cached} cached)` : ""}, ${output} output tokens`,
      ingredientIds: "Ingredient ids",
      resolutionOff: (unresolved) => `resolution off (${unresolved} without id)`,
      resolution: (catalog, relaxed, cache, search, unresolved) =>
        `${catalog} catalog${relaxed > 0 ? ` (${relaxed} without qualifiers in the name)` : ""}, ${cache} cache, ${search} search, ${unresolved} without id`,
      checkTitle: "Check before cooking",
      checkLead:
        "A language model wrote the steps. Open the recipe in the editor and check amounts, times, temperatures and speeds before you cook with it.",
      noHints: "The converter flagged nothing in particular.",
      reviewHints: "Review hints",
      warnings: "Converter warnings",
      error: "Error",
      actions: "Actions",
      runningLocked: "Running jobs cannot be changed. Wait until it is done.",
      retry: "Retry",
      retryHelp:
        "Queues the job again. It reuses the stored conversion if the recipe has not changed, and skips the upload if this version was already sent.",
      forceRebuild: "Force rebuild",
      forceRebuildHelp:
        "Converts the recipe again and uploads it even if it is unchanged. Costs a language model call and creates another recipe in your account.",
      cancel: "Cancel",
      cancelHelp: "Takes the job out of the queue. Nothing is uploaded.",
      events: "Timeline",
      noEvents: "No events yet.",
      ingredients: "Ingredients and Monsieur Cuisine ids",
      ingredientsLead:
        "The Monsieur Cuisine app uses an ingredient id for its shopping list. Ingredients without one still appear in the recipe, but not on the list.",
      ingredientsOff:
        "Resolution is off (MC_RESOLVE_INGREDIENTS=off): every ingredient went out without an id.",
      resolved: (count) => `With id (${count})`,
      withoutId: (count) => `Without id (${count})`,
      noneResolved: "None.",
      noneUnresolved: "None. Every ingredient got an id.",
    },
    settings: {
      title: "Settings",
      lead: "How the bridge stays logged in to Monsieur Cuisine, and the configuration it runs with.",
      session: {
        title: "Monsieur Cuisine session",
        lead: "Monsieur Cuisine has no public API for writing recipes. The bridge uses the recipe editor's API with the cookie of a logged-in browser session. It stores that cookie encrypted with `SETTINGS_KEY`. A login lasts 14 days; then the cookie expires and has to be renewed.",
        checkHelp:
          "Asks Monsieur Cuisine whether the stored cookie still works. The bridge does this by itself every `SESSION_CHECK_MINUTES` minutes.",
        renewTitle: "Three ways to renew the session",
        renewWays: [
          "Automatic login (below): store your Lidl account once, and the bridge logs in by itself when the session expires.",
          "Login helper on a computer with a browser: `npm run mc:login -- --bridge http://<bridge address>:3000` opens the login page and sends the session to the bridge.",
          "Paste the cookie by hand: log in on www.monsieur-cuisine.com, copy the `Cookie` request header from the browser's developer tools and paste it below.",
        ],
        cookieLabel: "Cookie header",
      },
      account: "Lidl account for the automatic login",
      intro:
        "With the e-mail address and password of your Lidl account for monsieur-cuisine.com, the bridge logs in by itself in a headless browser whenever the session has expired.",
      facts: [
        "When: only after the session turned out expired or rejected, at a regular check or during a job. A working session is left alone.",
        "How often: an automatic login runs at most once per hour and three times in 24 hours. After a failure it waits 1 hour, after two in a row 4 hours, after three 24 hours.",
        "Storage: e-mail and password live in `bridge.db`, encrypted with `SETTINGS_KEY`. The password is never shown, logged or sent back to the browser.",
        "Limits: a captcha or a second factor stops the login. You then get the session mail and renew the session another way.",
        "Lidl throttles repeated logins and runs bot detection. When it reports that its capacity is exceeded, the bridge waits at least an hour before the next attempt, a manual test included. If that keeps happening, renew the session with the login helper and a visible browser.",
        "On failure the bridge keeps a screenshot of the login page (the last five), linked below, so you can see what got in the way.",
        "Delete the account with the button below. That also removes the screenshots and the browser profile.",
      ],
      unavailable: "The automatic login is not available in this setup.",
      accountState: "Account",
      storeAccount: "Store the account",
      changeAccount: "Change the account",
      email: "E-mail address",
      emailHelp: "The address you log in with on www.monsieur-cuisine.com (a Lidl account).",
      password: "Password",
      passwordHelp:
        "Stored encrypted with `SETTINGS_KEY`. Leave the field empty to keep the stored password.",
      passwordStored: "stored; leave empty to keep it",
      save: "Save account",
      testNow: "Test login now",
      testHelp:
        "Logs in once right now, whatever the state of the session, and stores the new session if it works. At most every 3 minutes; it does not count toward the hourly and daily limits.",
      remove: "Delete account",
      removeHelp:
        "Deletes e-mail, password, screenshots and the browser profile. The current session stays until it expires.",
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
        unknown_account:
          "The site does not know the stored e-mail address. Check the stored account.",
        wrong_password: "The site reported a wrong password. Check the stored account.",
        rate_limited:
          "Lidl has temporarily throttled the login. Wait at least an hour before you test again: every attempt in the meantime can make the throttle last longer. The stored account is not the problem.",
        verification_required:
          "The site asked for a captcha or a verification code. Log in by hand once with the login helper.",
        not_logged_in:
          "The form was sent, but no session followed: a wrong password, a captcha or a second factor.",
        unexpected_page:
          "A login form showed up on a page that is not the Lidl login; nothing was typed into it.",
        verify_failed: "The site logged in, but Monsieur Cuisine refused the new session.",
        error: "The browser failed.",
      },
      consentDismissed: "A consent dialog was declined on the way.",
      termsAccepted: "The terms of use were confirmed on your behalf.",
      deviceChosen: "MC Smart was chosen as the device.",
      progressTitle: "Steps reached:",
      steps: {
        page_reached: "login page reached",
        consent_dismissed: "consent dialog declined",
        email_entered: "e-mail address entered",
        continue_clicked: "continue clicked",
        password_page: "password page reached",
        password_entered: "password entered",
        redirect_reached: "redirect to Monsieur Cuisine reached",
        terms_confirmed: "terms of use confirmed",
        device_chosen: "device chosen",
        cookies_received: "session cookies received",
      },
      consentSteps: (count) => `consent dialog declined (${count}×)`,
      browserUsed: (name, mode) =>
        `Browser: ${name ?? "unknown"}, ${
          { new: "headless (new mode)", shell: "headless shell", window: "visible window" }[mode]
        }`,
      screenshot: "Screenshot of the page",
      nextAttempt: "Next automatic attempt not before",
      running: "A login is running.",
      manualCooldown: (time) => `Next manual test from ${time}`,
      locale: {
        title: "Language and recipe status",
        lead: "Set in the environment; change them in .env and restart the bridge.",
        unverified: "not verified on a device",
        mcLocale:
          "Language of the recipes the bridge writes, and the Monsieur Cuisine settings that go with it (categories, difficulty, editor address).",
        uiLanguage: "Language of these pages, the Mealie timeline entries and the mails.",
        recipeStatus: {
          "private-publish":
            "New recipes are saved privately on your device: they show up on the machine, and nobody else sees them.",
          draft:
            "New recipes stay drafts in the web editor and do not show up on the machine. Meant for debugging.",
        },
      },
      config: {
        title: "Effective configuration",
        lead: "What the bridge read from its environment (`.env` or the compose file) at start. Read-only: change a value there and restart the bridge. Secrets show only whether they are set.",
        unavailable: "The configuration is not available on this page.",
        name: "Variable",
        value: "Current value",
        description: "Meaning",
        hidden: "set (hidden)",
        unset: "not set",
        isDefault: "default",
        defaultLabel: "Default:",
        required: "required",
        valuesLabel: "values:",
      },
    },
    dryRun: {
      lead: "Try a Mealie recipe without sending anything to Monsieur Cuisine. The preview shows what the converter would get. With the conversion it also shows what it would make; that calls the language model and costs money, but nothing is uploaded.",
      formTitle: "Recipe",
      recipe: "Recipe",
      recipePlaceholder: "id or slug",
      recipeHelp:
        "The slug is the last part of the recipe URL in Mealie, for example `pumpkin-soup` in `/g/home/r/pumpkin-soup`.",
      scale: "Scale",
      scaleHelp:
        "Multiplies the servings, as the scale in Mealie does, in quarter steps from 0.25 to 10. 1 keeps the recipe as it is.",
      preview: "Preview",
      alsoConvert: "Convert right away",
      alsoConvertHelp:
        "Calls the language model, which costs money, and shows the steps it would upload. Nothing is uploaded.",
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
      ingredientsLead:
        "How the bridge read the ingredients from Mealie, scaled. Rows marked unparsed go to the model as plain text.",
      noIngredients: "The recipe has no ingredients.",
      section: "Section",
      amount: "Amount",
      unit: "Unit",
      food: "Food",
      note: "Note",
      source: "Source",
      original: "Original",
      optional: "(optional)",
      converterInput: "Converter input (Markdown)",
      converterInputLead: "The recipe as the language model receives it.",
      conversion: "Conversion",
      conversionLead:
        "What the model made, after the checks against the device limits and cooking rules.",
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
      noHints: "The converter flagged nothing in particular.",
      warnings: "Converter warnings",
      steps: "Steps",
      kind: "Kind",
      settings: "Settings",
      text: "Text",
      ingredientGroups: "Ingredient groups",
    },
  },
};
