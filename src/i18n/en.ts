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
      `The automatic login with the stored Lidl account tries again after ${time}; it waits that long after earlier attempts. To continue sooner, use "Test login" on the settings page, the login helper or the cookie form.`,
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
    shell: {
      tagline: "Mealie to Monsieur Cuisine",
      openMenu: "Open menu",
      closeMenu: "Close menu",
      mcSession: "MC session",
      theme: "Theme",
      themes: { system: "System", light: "Light", dark: "Dark" },
      signedIn: (user) => `Signed in as ${user}`,
      noPassword: "No password",
      dismiss: "Dismiss",
      cancel: "Cancel",
      confirm: "Confirm",
    },
    authBanner: "The admin pages have no password. Set ADMIN_USER and ADMIN_PASSWORD.",
    skipToContent: "Skip to content",
    copy: { copy: "Copy", copied: "Copied", reveal: "Show" },
    login: {
      title: "Log in",
      subtitle: "Admin pages of the bridge",
      user: "User",
      password: "Password",
      submit: "Log in",
      hint: "ADMIN_USER and ADMIN_PASSWORD from the bridge's environment. A login lasts 12 hours.",
      wrongCredentials: "User or password is wrong.",
      tooMany: (minutes) =>
        `Too many failed logins from this address. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
    },
    autoRefresh: "Updates every 5 seconds while the job runs.",
    mealieTimeout: (seconds) => `no answer within ${seconds} s`,
    notices: {
      "session-saved": "Session saved. Waiting jobs are queued again.",
      "session-checked": "Session checked.",
      "job-queued": "Job queued again.",
      "job-forced": "Job queued again; it is sent even if the recipe is unchanged.",
      "job-cancelled": "Job cancelled.",
      "logged-out": "Logged out.",
      "credentials-saved": "Lidl account saved, encrypted.",
      "credentials-deleted": "Lidl account deleted.",
      "login-started": "Login started. The page updates until it is done.",
      "login-running": "A login is already running.",
      "login-no-credentials": "Store the Lidl account first.",
      "login-cooldown": "A manual test runs at most every 3 minutes. Try again shortly.",
      "test-mail-sent": "Test mail sent. Check the inbox.",
      "test-mail-cooldown": "A test mail goes out at most once a minute.",
      "mail-saved": "Mail settings saved, encrypted. They apply right away.",
      "mail-deleted": "Mail settings deleted. No more mails go out.",
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
      dryRun: "Dry run",
      notFound: "Not found",
      notPossible: "Not possible",
      formExpired: "Form expired",
      error: "Something went wrong",
      badRequest: "Request refused",
    },
    errors: {
      formExpired:
        "The form has expired: the bridge restarted, or the page came from elsewhere. Reload the page and try again.",
      cookieEmpty: "The cookie field is empty.",
      cookieRejected: (reason) =>
        `${reason}. The cookie was not stored. Log in again and copy a fresh one.`,
      cookieUnchecked: (reason) =>
        `The cookie could not be checked, so it was not stored: ${reason}`,
      noSuchJob: "No such job. It may have been removed, or the link is wrong.",
      noSuchPage: "There is no page at this address.",
      noSuchScreenshot: "This screenshot no longer exists.",
      recipeNotLoaded: (reason) => `The recipe could not be loaded: ${reason}`,
      conversionFailed: (reason) => `The conversion failed: ${reason}`,
      credentialsInvalid: (field) =>
        field === "email"
          ? "The account was not saved: the e-mail address is not valid."
          : "The account was not saved: the password is empty.",
      testMailFailed: (reason) => `The test mail did not go out: ${reason}`,
      mailUnavailable:
        "Mail is not set up: enter a mail server on this page or set SMTP_URL and NOTIFY_EMAIL.",
      mailFromEnv:
        "The mail settings come from the environment (SMTP_URL) and cannot be changed here.",
      mailInvalid: "The mail settings were not saved. Check the marked fields.",
      server: "The bridge could not handle this request. The log has the details.",
      badRequest: "The bridge could not read this request.",
    },
    links: {
      backToDashboard: "Back to the overview",
      backToJobs: "Back to the jobs",
      backToJob: "Back to the job",
      backToSettings: "Back to the settings",
    },
    jobStatus: {
      queued: "Queued",
      running: "Running",
      done: "Done",
      skipped: "Skipped",
      failed: "Failed",
      session_expired: "Waiting for session",
      cancelled: "Cancelled",
    },
    sessionState: {
      valid: "Valid",
      invalid: "Invalid",
      expired: "Expired",
      unknown: "Unknown",
    },
    events: { details: "Technical details", code: "Code" },
    failures: {
      stages: {
        load: "Could not read the recipe from Mealie",
        prepare: "Could not prepare the recipe",
        categories: "Monsieur Cuisine categories not available",
        convert: "The language model could not convert the recipe",
        validate: "The conversion broke the device limits",
        ingredients: "Ingredient lookup failed",
        upload: "Upload to Monsieur Cuisine failed",
        unexpected: "Unexpected error",
      },
      session: "Monsieur Cuisine session expired",
      limits: "The conversion broke the device limits",
      mealieUnreachable: "Mealie not reachable",
      mealieRefused: "Mealie refused the request",
      converterMissing: "No language model set up",
      modelRefused: "The language model refused the recipe",
      interrupted: "Interrupted while the recipe was being created",
      generic: "Failed",
      details: "Technical details",
    },
    dashboard: {
      subtitle: "Connections, the last 30 days and recent jobs.",
      workerPaused: "Queue paused until the session works",
      workerStopped: "Worker stopped",
      health: {
        connected: "Connected",
        asUser: (user) => `as ${user}`,
        error: "Error",
        unchecked: "Not checked",
        sessionValid: "Session valid",
        until: "expires",
        checked: (known) => (known ? "checked" : "not checked yet"),
        renew: "Renew in the settings",
        autoLogin: "Automatic login",
        unavailable: "Not available",
        off: "Off",
        setUp: "Store a Lidl account",
        lastFailed: "Last attempt failed",
        active: "Active",
        ai: "Language model",
      },
      kpi: {
        sent: "Recipes sent (30 days)",
        sentHint: (total, skipped) =>
          `${total} ${total === 1 ? "job" : "jobs"}, ${skipped} skipped`,
        successRate: "Success rate",
        noFinished: "No finished jobs yet",
        failed: (count) => `${count} failed`,
        duration: "Average duration",
        durationHint: "per recipe sent",
        cost: "Cost (30 days)",
        costToday: (today, limit) => `Today ${today} of ${limit}`,
        costTodayNoLimit: (today) => `Today ${today}, no limit`,
        costMeter: "Share of the daily cost limit",
      },
      setup: {
        title: "Finish the setup",
        progress: (done, total) => `${done} of ${total} done`,
        dismiss: "Hide",
        fix: "Set up",
        done: "done",
        open: "open",
        mealie: "Mealie reachable",
        session: "Monsieur Cuisine session valid",
        autoLogin: "Automatic login set up",
        action: "Recipe action in Mealie",
        firstRecipe: "First recipe sent",
        firstRecipeHint:
          "Open a recipe in Mealie and pick the bridge's action from the three-dot menu.",
      },
      workerError: "Last error of the worker",
      jobError: "Last failed job",
      openJob: "Open job",
      recentJobs: "Recent jobs",
      allJobs: "All jobs",
    },
    jobs: {
      subtitle: "Every recipe Mealie sent to the bridge, newest first.",
      scale: (value) => `Scale ${value}`,
      servings: (amount, unit) => `${amount} ${unit ?? "servings"}`,
      recipeLink: (id, status) => `${status === "draft" ? "Draft" : "Recipe"} ${id}`,
      image: "Picture",
      recipe: "Recipe",
      status: "Status",
      created: "Created",
      duration: "Duration",
      cost: "Cost",
      actions: "Actions",
      open: "Open",
      openEditor: "Open in the MC editor",
      retry: "Retry",
      forceRebuild: "Force rebuild",
      forceConfirm:
        "Converts the recipe again and uploads it even if it is unchanged. That costs a model call and creates another recipe in your account.",
      cancel: "Cancel job",
      cancelConfirm: "The job leaves the queue. Nothing is uploaded.",
      filterLabel: "Filter by status",
      filters: {
        all: "All",
        active: "Active",
        done: "Done",
        skipped: "Skipped",
        failed: "Failed",
        cancelled: "Cancelled",
      },
      search: "Search jobs",
      searchPlaceholder: "Title, slug or id",
      empty: "No jobs yet",
      emptyHint: "Open a recipe in Mealie and pick the bridge's action from the three-dot menu.",
      noMatch: "No job matches this filter.",
      noMore: "No older jobs.",
      reset: "Show all jobs",
      range: (from, to) => `${from} to ${to}`,
      newer: "Newer",
      older: "Older",
    },
    jobDetail: {
      tabsLabel: "Job sections",
      tabs: { overview: "Overview", steps: "Steps", ingredients: "Ingredients", events: "Log" },
      openEditor: (status) =>
        status === "draft" ? "Open draft in MC editor" : "Open in MC editor",
      openInMealie: "Open in Mealie",
      facts: "Details",
      conversion: "Conversion",
      status: "Status",
      servings: "Servings",
      scale: "Scale",
      model: "Model",
      tokens: "Tokens",
      tokenCounts: (input, cached, output) =>
        `${input} in${cached ? ` (${cached} cached)` : ""}, ${output} out`,
      cost: "Cost",
      duration: "Duration",
      attempts: "Attempts",
      forced: "forced",
      created: "Created",
      finished: "Finished",
      ingredientIds: "Ingredient ids",
      resolutionOff: (unresolved) => `Lookup off, ${unresolved} without id`,
      resolution: (catalog, relaxed, cache, search, unresolved) =>
        `${catalog} catalog${relaxed > 0 ? ` (${relaxed} relaxed)` : ""}, ${cache} cache, ${search} search, ${unresolved} without id`,
      jobId: "Job id",
      error: "Error",
      checkTitle: "Check before cooking",
      checkLead:
        "A language model wrote the steps. Check amounts, times, temperatures and speeds in the editor before you cook.",
      reviewHints: "Review hints",
      noHints: "The converter flagged nothing in particular.",
      warnings: "Converter warnings",
      noSteps: "No converted recipe is stored for this job. It is stored once the checks pass.",
      noEvents: "No log entries yet.",
      noIngredients: "No converted ingredients are stored for this job.",
      ingredientsTitle: "Ingredients",
      ingredientsOff:
        "Lookup off (MC_RESOLVE_INGREDIENTS=off), every ingredient went out without an id",
      ingredientCounts: (withId, without) => `${withId} with catalog id, ${without} without`,
      ingredientsHint:
        "The Monsieur Cuisine app puts only ingredients with an id on its shopping list. The recipe shows all of them.",
      ingredient: "Ingredient",
      amount: "Amount",
      catalogId: "Catalog id",
      withId: "With id",
      withoutId: "Without id",
    },
    steps: {
      modes: {
        customized: "Manual cooking",
        roasting: "Roasting",
        steaming: "Steaming",
        kneading_solid_dough: "Firm dough",
        kneading_soft_dough: "Soft dough",
        kneading_liquid_dough: "Batter",
        puree: "Puree",
        smoothie: "Smoothie",
        turbo: "Turbo",
        scale: "Scale",
        slow_cooking: "Slow cooking",
        sous_vide: "Sous vide",
        fermentation: "Fermenting",
        rice_cooking: "Rice cooking",
        cooking_eggs: "Egg cooking",
        precleaning: "Pre-rinse",
        food_processor: "Food processor",
      },
      temperature: "Temperature",
      time: "Time",
      speed: (value) => `Speed ${value}`,
      speedTitle: "Speed",
      forward: "Forward",
      reverse: "Reverse",
      rotation: "Direction",
      whisk: "Whisk",
      accessory: "Attachment",
      weight: "Weight",
      eggSize: { small: "Size S", medium: "Size M", large: "Size L" },
      eggSizeTitle: "Egg size",
      eggTexture: { soft: "Soft", waxy_soft: "Medium", hard: "Hard" },
      eggTextureTitle: "Texture",
      cleaning: { short: "Short", long: "Long" },
      servings: (amount, unit) => `${amount} ${unit}`,
      preparation: (minutes) => `${minutes} min preparation`,
      ready: (minutes) => `ready in ${minutes} min`,
      ingredients: "Ingredients",
      optional: "optional",
      none: "No steps to show.",
    },
    dryRun: {
      subtitle: "Convert a recipe without sending anything to Monsieur Cuisine.",
      formTitle: "Recipe",
      recipe: "Recipe",
      recipeHint: "Type part of a name, or paste a slug or id.",
      recipePlaceholder: "Pumpkin soup",
      scale: "Scale",
      scaleHint: "Like the scale in Mealie, 0.25 to 10.",
      convertNow: "Convert right away",
      convertNowHint: "Calls the language model, which costs money. Nothing is uploaded.",
      preview: "Preview",
      working: "Working…",
      sourceTitle: "Source",
      servings: "Servings",
      estimated: "Estimated",
      estimatedHelp:
        "The recipe states no servings. The bridge assumes a default, and the model estimates and flags it.",
      sourceHash: "Source hash",
      alreadySent: "Already sent",
      wouldSkip: "A job would skip it unless forced.",
      notSent: "No",
      convert: "Convert without uploading",
      loadFailed: "Recipe not loaded",
      matches: "Matching recipes",
      emptyTitle: "Pick a recipe",
      empty:
        "The preview shows what the converter gets and, after the conversion, the steps as the machine would show them.",
      tabsLabel: "Dry run result",
      tabs: {
        preview: "Preview",
        input: "Converter input",
        ingredients: "Ingredients",
        checks: "Checks",
      },
      notConverted: "Not converted yet",
      notConvertedHint:
        "The conversion calls the language model and costs money. Nothing is uploaded.",
      conversionFailed: "Conversion failed",
      noIngredients: "The recipe has no ingredients.",
      amount: "Amount",
      food: "Food",
      note: "Note",
      source: "Read as",
      optional: "(optional)",
      unparsed: "free text",
      passed: "Checks passed",
      errors: (count) => `${count} ${count === 1 ? "error" : "errors"}`,
      reviewHints: "Review hints",
      warnings: "Converter warnings",
      conversion: "Conversion",
      model: "Model",
      attempts: "Attempts",
      tokens: "Tokens",
      tokenCounts: (input, output) => `${input} in, ${output} out`,
      cost: "Cost",
      categories: "Categories",
      droppedIds: (ids) => `Dropped unknown ids ${ids}`,
    },
    settings: {
      title: "Settings",
      subtitle: "Session, accounts and the configuration the bridge runs with.",
      tabsLabel: "Settings sections",
      tabs: {
        mc: "Monsieur Cuisine",
        lidl: "Lidl account",
        mealie: "Mealie",
        ai: "Language model",
        notify: "Notifications",
        system: "System",
      },
      mc: {
        title: "Session",
        checkNow: "Check now",
        checkHint: "The bridge also checks by itself every SESSION_CHECK_MINUTES minutes.",
        state: "State",
        expires: "Login expires",
        lastCheck: "Last check",
        age: "Age",
        noCookie: "No cookie stored",
        ageValue: (hours, from) => {
          const value =
            hours < 48
              ? `${formatNumber(hours, INTL)} h`
              : `${formatNumber(hours / 24, INTL)} days`;
          return `${value} ${from === "login" ? "since the login" : "since it was stored in the bridge"}`;
        },
        lastError: "Last error",
        renewTitle: "Renew the session",
        ways: {
          auto: "Automatic login",
          autoHint: "Store your Lidl account once; the bridge logs in when the session expires.",
          autoLink: "Set it up",
          helper: "Login helper",
          helperHint:
            "Run it on a computer with a browser; it sends the new session to the bridge.",
          cookie: "Set the cookie by hand",
        },
        cookieLabel: "Cookie header",
        cookieHint:
          "The Cookie request header of a logged-in tab of www.monsieur-cuisine.com (developer tools, any request to proxy-api). The bridge checks it against your account before it stores it, encrypted.",
        saveCookie: "Check and save",
      },
      lidl: {
        title: "Lidl account",
        unavailable: "The automatic login is not available in this setup.",
        account: "Account",
        notConfigured: "No account stored",
        browser: "Browser",
        browserReady: "Headless Chromium available",
        browserMissing: (reason) => `Not available: ${reason}`,
        state: "State",
        running: "Login running",
        nextAttempt: "Next automatic attempt",
        nextTest: "Next manual test",
        testNow: "Test login",
        howItWorks: "How the automatic login works",
        facts: [
          "When: only after the session turned out expired or rejected, at a regular check or during a job. A working session is left alone.",
          "How often: an automatic login runs at most once per hour and three times in 24 hours. After a failure it waits 1 hour, after two in a row 4 hours, after three 24 hours.",
          "Storage: e-mail and password live in bridge.db, encrypted with SETTINGS_KEY. The password is never shown, logged or sent back to the browser.",
          "Limits: a captcha or a second factor stops the login. You then get the session mail and renew the session another way.",
          "Lidl throttles repeated logins. When it reports that its capacity is exceeded, the bridge waits at least an hour, manual tests included.",
          "On failure the bridge keeps a screenshot of the login page (the last five), so you can see what got in the way.",
          "Delete the account below. That also removes the screenshots.",
        ],
        storeAccount: "Store the account",
        changeAccount: "Change the account",
        email: "E-mail address",
        emailHint: "The address you log in with on www.monsieur-cuisine.com.",
        password: "Password",
        passwordHint: "Stored encrypted. Leave empty to keep the stored password.",
        passwordStored: "stored; leave empty to keep it",
        save: "Save account",
        dangerZone: "Delete the account",
        remove: "Delete account",
        removeHint:
          "Removes e-mail, password and screenshots. The current session stays until it expires.",
        removeConfirm:
          "The bridge forgets the Lidl account and can no longer log in by itself. The current session stays until it expires.",
        lastAttempt: "Last attempt",
        succeeded: "Succeeded",
        failed: "Failed",
        manual: "Manual test",
        screenshot: "Screenshot",
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
        progressTitle: "Steps reached",
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
        consentDismissed: "A consent dialog was declined on the way.",
        termsAccepted: "The terms of use were confirmed on your behalf.",
        deviceChosen: "MC Smart was chosen as the device.",
        browserUsed: (name, mode) =>
          `Browser: ${name ?? "unknown"}, ${
            { new: "headless (new mode)", shell: "headless shell", window: "visible window" }[mode]
          }`,
      },
      mealie: {
        title: "Connection",
        url: "Address",
        state: "State",
        connected: "Connected",
        failed: "No connection",
        unchecked: "Not checked",
        user: "API user",
        error: "Error",
        lastCheck: "Last check",
        fix: "Check MEALIE_URL and MEALIE_API_TOKEN in the .env and restart the bridge.",
        actionTitle: "Recipe action",
        actionSubtitle: "In Mealie: Settings, Data Management, Recipe Actions; type post.",
        dockerUrl: "On the same Docker network",
        pageUrl: "At the address of this page",
        reveal: "Show the URL with the token",
        allowList:
          'Mealie 3.26 and later posts only to hosts on its allow list: set HTTP_ALLOW_LIST: "mc-bridge" in Mealie\'s environment.',
        secret:
          "The token is the webhook's only protection. Keep the URL to yourself; to change it, set a new WEBHOOK_TOKEN and update the action.",
        noToken: "This page does not know the webhook token.",
      },
      ai: {
        title: "Model",
        provider: "Provider",
        providers: { openai: "OpenAI", anthropic: "Anthropic" },
        model: "Model",
        effort: "Reasoning effort",
        corrections: "Correction rounds",
        readOnly:
          "Set in the .env (LLM_PROVIDER and the model settings); restart the bridge after a change.",
        limits: "Limits and usage",
        jobsToday: "Jobs, last 24 hours",
        costToday: "Cost, last 24 hours",
        monthJobs: "Jobs this month",
        monthCost: "Cost this month",
        monthTokens: "Tokens this month",
        tokens: (input, output) => `${input} in, ${output} out`,
        limitsHint:
          "JOB_DAILY_LIMIT and JOB_DAILY_COST_LIMIT_USD. Costs are estimates from the price table.",
      },
      notify: {
        title: "E-mail",
        state: "State",
        on: "On",
        off: "Off",
        fromEnv: "from the environment",
        fromPage: "stored on this page",
        server: "Server",
        security: "Encryption",
        securityNames: { starttls: "STARTTLS", tls: "SSL/TLS", none: "None" },
        insecureAllowed: "unencrypted allowed",
        recipient: "Recipient",
        sender: "Sender",
        events: "Notifications",
        eventNames: {
          session: "Session expired or invalid",
          job: "Job failed for good",
          health: "Session check failing",
        },
        noEvents: "None",
        test: "Send test mail",
        sending: "Sending…",
        what: "Mails go out when the session expires, a job fails for good, or the session check keeps failing.",
        setUp:
          "Enter a mail server here, or set SMTP_URL and NOTIFY_EMAIL in the environment, to get mails about an expired session and failed jobs.",
        unreadable:
          "The stored mail settings cannot be read; SETTINGS_KEY has probably changed. No mail goes out until you save them again.",
        unavailable: "Mail settings are not available in this setup.",
        formTitle: "Mail server",
        envHint:
          "To edit these values here, remove SMTP_URL from the environment and restart the bridge.",
        host: "Server",
        hostHint: "Host name or IP address, for example mail.example.com.",
        port: "Port",
        securityHint:
          "STARTTLS usually on port 587, SSL/TLS usually on port 465. Without encryption the password and the mails cross the network in plain text.",
        allowInsecure: "Allow unencrypted",
        allowInsecureHint:
          "Only for a mail server on the same host or a trusted network. With STARTTLS the bridge then also sends when the server does not offer it.",
        username: "User name",
        usernameHint: "Leave empty when the server needs no login.",
        password: "Password",
        passwordHint:
          "Stored encrypted and never shown. Enter it again after changing the server or the user name.",
        passwordStored: "stored; leave empty to keep it",
        from: "Sender",
        fromHint: "Leave empty for the first recipient. With a name: Bridge <bridge@example.com>.",
        to: "Recipients",
        toHint: "One or more addresses, separated by commas, at most 10.",
        save: "Save",
        dangerZone: "Delete mail settings",
        remove: "Delete mail settings",
        removeHint:
          "Removes the server, the login and the recipients. No mail goes out afterwards.",
        removeConfirm:
          "The bridge forgets the mail server, the login and the recipients and sends no more mail.",
        errors: {
          host_required: "Enter a server.",
          host_invalid: "A host name or IP address only, without smtp:// and without a port.",
          port_invalid: "A port from 1 to 65535.",
          security_invalid: "Choose STARTTLS, SSL/TLS or None.",
          security_insecure: "No encryption only together with “Allow unencrypted”.",
          username_invalid: "At most 254 characters, no control characters.",
          password_required: "Enter the password.",
          password_reenter: "The server or the user name is new: enter the password again.",
          password_invalid: "At most 1024 characters.",
          from_invalid: "An e-mail address, optionally with a name: Bridge <bridge@example.com>.",
          to_required: "Enter at least one recipient.",
          to_invalid: "At least one address is not valid.",
          to_too_many: "At most 10 recipients.",
        },
      },
      system: {
        title: "System",
        readme: "README",
        version: "Version",
        uptime: "Uptime",
        dataDir: "Data directory",
        mcLocale: "Recipe language",
        unverified: "not verified on a device",
        uiLanguage: "Page language",
        recipeStatus: "Recipe status",
        recipeStatusHint: {
          "private-publish": "Saved privately on your device; shows up on the machine.",
          draft: "Stays a draft in the web editor; does not show up on the machine.",
        },
        envHint: "Set in the environment; change the .env and restart the bridge.",
        advanced: "Advanced: effective configuration",
        configHint:
          "What the bridge read from its environment at start. Secrets show only whether they are set.",
        name: "Variable",
        value: "Value",
        description: "Meaning",
        hidden: "set (hidden)",
        unset: "not set",
        isDefault: "default",
        defaultLabel: "Default:",
        required: "required",
        valuesLabel: "values:",
      },
    },
  },
};
