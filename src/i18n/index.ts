// Message catalogs for what people read: Mealie timeline entries, mails, the admin pages
// and the job events they show, per UI_LANGUAGE. Logs and command line output stay English.
//
// Each catalog implements Messages, so the compiler holds every language to the same keys;
// a test compares them at run time as well. Texts that end up in Markdown or HTML are plain
// here; the callers escape what they insert.

import type { JobEventCode, JobEventParams } from "../store/job-events.js";
import { de } from "./de.js";
import { en } from "./en.js";

export const UI_LANGUAGES = ["de", "en"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export type FailureStage =
  | "load"
  | "prepare"
  | "categories"
  | "convert"
  | "validate"
  | "ingredients"
  | "upload"
  | "unexpected";

export const FAILURE_STAGES: readonly FailureStage[] = [
  "load",
  "prepare",
  "categories",
  "convert",
  "validate",
  "ingredients",
  "upload",
  "unexpected",
];

export type JobStatusName =
  "queued" | "running" | "done" | "skipped" | "failed" | "session_expired" | "cancelled";

// Why an automatic login failed (src/session/auto-login.ts).
export type AutoLoginFailureName =
  | "browser_unavailable"
  | "no_login_form"
  | "unknown_account"
  | "wrong_password"
  | "rate_limited"
  | "verification_required"
  | "not_logged_in"
  | "unexpected_page"
  | "verify_failed"
  | "error";

// The steps of a browser login (LOGIN_STEPS in src/session/browser-login.ts).
export type LoginStepName =
  | "page_reached"
  | "consent_dismissed"
  | "email_entered"
  | "continue_clicked"
  | "password_page"
  | "password_entered"
  | "redirect_reached"
  | "terms_confirmed"
  | "device_chosen"
  | "cookies_received";

export type SessionStateName = "valid" | "invalid" | "expired" | "unknown";

// The programs of the device (MACHINE_STEP_KINDS in src/recipe/modes.ts).
export type MachineStepKindName =
  | "customized"
  | "roasting"
  | "steaming"
  | "kneading_solid_dough"
  | "kneading_soft_dough"
  | "kneading_liquid_dough"
  | "puree"
  | "smoothie"
  | "turbo"
  | "scale"
  | "slow_cooking"
  | "sous_vide"
  | "fermentation"
  | "rice_cooking"
  | "cooking_eggs"
  | "precleaning"
  | "food_processor";

// How a recipe sits in the Monsieur Cuisine account: a draft, or saved on the device.
export type SavedStatus = "draft" | "private-publish";

export interface CreatedText {
  url: string;
  servings: number;
  // The unit of the serving size: "Portionen", "Scheiben".
  servingUnit: string;
  status: SavedStatus;
  // The status change to private-publish failed; the recipe stayed a draft.
  statusFailed: boolean;
  provider: string;
  model: string;
  reviewHints: readonly string[];
  imageSkipped: boolean;
}

// Timeline entries in Mealie. Subjects are plain text. The message functions return
// Markdown; values from outside (hints, errors, model names) arrive escaped.
export interface TimelineMessages {
  // "draft" also when the status change to private-publish failed.
  createdSubject(status: SavedStatus): string;
  created(text: CreatedText): string;
  unchangedSubject: string;
  unchanged(text: { sentAt: string; url: string; status: SavedStatus }): string;
  failedSubject(stage: FailureStage): string;
  failed(text: { stage: FailureStage; detail: string }): string;
  sessionSubject: string;
  session(): string;
  // The webhook refused a click because a daily limit is reached.
  limitSubject: string;
  limit(text: { kind: "jobs" | "cost"; limit: number }): string;
  failureReasons: Readonly<Record<FailureStage, string>>;
}

// Plain text mails.
export interface EmailMessages {
  subjectPrefix: string;
  session: Readonly<Record<"expired" | "invalid", { subject: string; lead: string }>>;
  sessionWaiting: string;
  sessionNextSteps: readonly string[];
  autoLoginFailed(reason: string): string;
  autoLoginWaiting(time: string): string;
  lastChecked(when: string): string;
  never: string;
  lastMessage(message: string): string;
  jobFailedSubject(title: string): string;
  jobFailedLead(title: string): string;
  error(message: string): string;
  job(id: string): string;
  attempts(count: number): string;
  recipeInMealie(url: string): string;
  jobRetry: string;
  healthSubject: string;
  healthLead: string;
  healthOutro: string;
  // The mail the settings page sends on request.
  testSubject: string;
  testText: string;
}

// The admin pages. Plain text; the pages escape it.
export interface AdminMessages {
  htmlLang: string;
  nav: {
    dashboard: string;
    jobs: string;
    dryRun: string;
    settings: string;
    logout: string;
    // The accessible name of the navigation.
    label: string;
  };
  // The frame of the pages: sidebar, theme switch, notices, confirmation dialog.
  shell: {
    tagline: string;
    openMenu: string;
    closeMenu: string;
    mcSession: string;
    theme: string;
    themes: Readonly<Record<"system" | "light" | "dark", string>>;
    signedIn(user: string): string;
    noPassword: string;
    dismiss: string;
    cancel: string;
    confirm: string;
  };
  authBanner: string;
  skipToContent: string;
  copy: { copy: string; copied: string; reveal: string };
  login: {
    title: string;
    subtitle: string;
    user: string;
    password: string;
    submit: string;
    hint: string;
    wrongCredentials: string;
    tooMany(minutes: number): string;
  };
  // Under a running job: the page reloads on its own.
  autoRefresh: string;
  // The Mealie check gave up waiting.
  mealieTimeout(seconds: number): string;
  notices: Readonly<Record<string, string>>;
  plain: { unknownHost: string; authRequired: string; crossOrigin: string };
  titles: {
    dashboard: string;
    jobs: string;
    job: string;
    dryRun: string;
    notFound: string;
    notPossible: string;
    formExpired: string;
    error: string;
    badRequest: string;
  };
  errors: {
    formExpired: string;
    cookieEmpty: string;
    cookieRejected(reason: string): string;
    cookieUnchecked(reason: string): string;
    noSuchJob: string;
    noSuchPage: string;
    noSuchScreenshot: string;
    recipeNotLoaded(reason: string): string;
    conversionFailed(reason: string): string;
    credentialsInvalid(field: "email" | "password"): string;
    testMailFailed(reason: string): string;
    mailUnavailable: string;
    server: string;
    badRequest: string;
  };
  links: {
    backToDashboard: string;
    backToJobs: string;
    backToJob: string;
    backToSettings: string;
  };
  jobStatus: Readonly<Record<JobStatusName, string>>;
  sessionState: Readonly<Record<SessionStateName, string>>;
  events: { details: string; code: string };
  // A short summary of a job error; the raw text goes into a collapsed details element.
  failures: {
    stages: Readonly<Record<FailureStage, string>>;
    session: string;
    limits: string;
    mealieUnreachable: string;
    mealieRefused: string;
    converterMissing: string;
    modelRefused: string;
    interrupted: string;
    generic: string;
    details: string;
  };
  dashboard: {
    subtitle: string;
    workerPaused: string;
    workerStopped: string;
    health: {
      connected: string;
      asUser(user: string): string;
      error: string;
      unchecked: string;
      sessionValid: string;
      until: string;
      checked(known: boolean): string;
      renew: string;
      autoLogin: string;
      unavailable: string;
      off: string;
      setUp: string;
      lastFailed: string;
      active: string;
      ai: string;
    };
    kpi: {
      sent: string;
      sentHint(total: number, skipped: number): string;
      successRate: string;
      noFinished: string;
      failed(count: number): string;
      duration: string;
      durationHint: string;
      cost: string;
      costToday(today: string, limit: string): string;
      costTodayNoLimit(today: string): string;
      costMeter: string;
    };
    setup: {
      title: string;
      progress(done: number, total: number): string;
      dismiss: string;
      fix: string;
      done: string;
      open: string;
      mealie: string;
      session: string;
      autoLogin: string;
      action: string;
      firstRecipe: string;
      firstRecipeHint: string;
    };
    workerError: string;
    jobError: string;
    openJob: string;
    recentJobs: string;
    allJobs: string;
  };
  jobs: {
    subtitle: string;
    scale(value: string): string;
    // "8 Portionen"; the unit is null on jobs from before it was stored.
    servings(amount: number, unit: string | null): string;
    recipeLink(id: number | string, status: SavedStatus): string;
    image: string;
    recipe: string;
    status: string;
    created: string;
    duration: string;
    cost: string;
    actions: string;
    open: string;
    openEditor: string;
    retry: string;
    forceRebuild: string;
    forceConfirm: string;
    cancel: string;
    cancelConfirm: string;
    filterLabel: string;
    filters: Readonly<
      Record<"all" | "active" | "done" | "skipped" | "failed" | "cancelled", string>
    >;
    search: string;
    searchPlaceholder: string;
    empty: string;
    emptyHint: string;
    noMatch: string;
    noMore: string;
    reset: string;
    range(from: number, to: number): string;
    newer: string;
    older: string;
  };
  jobDetail: {
    tabsLabel: string;
    tabs: Readonly<Record<"overview" | "steps" | "ingredients" | "events", string>>;
    openEditor(status: SavedStatus): string;
    openInMealie: string;
    facts: string;
    conversion: string;
    status: string;
    servings: string;
    scale: string;
    model: string;
    tokens: string;
    tokenCounts(input: string, cached: string | null, output: string): string;
    cost: string;
    duration: string;
    attempts: string;
    forced: string;
    created: string;
    finished: string;
    ingredientIds: string;
    resolutionOff(unresolved: number): string;
    resolution(
      catalog: number,
      relaxed: number,
      cache: number,
      search: number,
      unresolved: number,
    ): string;
    jobId: string;
    error: string;
    checkTitle: string;
    checkLead: string;
    reviewHints: string;
    noHints: string;
    warnings: string;
    noSteps: string;
    noEvents: string;
    noIngredients: string;
    ingredientsTitle: string;
    ingredientsOff: string;
    ingredientCounts(withId: number, without: number): string;
    ingredientsHint: string;
    ingredient: string;
    amount: string;
    catalogId: string;
    withId: string;
    withoutId: string;
  };
  // The converted recipe as the device shows it.
  steps: {
    modes: Readonly<Record<MachineStepKindName, string>>;
    temperature: string;
    time: string;
    speed(value: number): string;
    speedTitle: string;
    forward: string;
    reverse: string;
    rotation: string;
    whisk: string;
    accessory: string;
    weight: string;
    eggSize: Readonly<Record<"small" | "medium" | "large", string>>;
    eggSizeTitle: string;
    eggTexture: Readonly<Record<"soft" | "waxy_soft" | "hard", string>>;
    eggTextureTitle: string;
    cleaning: Readonly<Record<"short" | "long", string>>;
    servings(amount: number, unit: string): string;
    preparation(minutes: number): string;
    ready(minutes: number): string;
    ingredients: string;
    optional: string;
    none: string;
  };
  dryRun: {
    subtitle: string;
    formTitle: string;
    recipe: string;
    recipeHint: string;
    recipePlaceholder: string;
    scale: string;
    scaleHint: string;
    convertNow: string;
    convertNowHint: string;
    preview: string;
    working: string;
    sourceTitle: string;
    servings: string;
    estimated: string;
    estimatedHelp: string;
    sourceHash: string;
    alreadySent: string;
    wouldSkip: string;
    notSent: string;
    convert: string;
    loadFailed: string;
    matches: string;
    emptyTitle: string;
    empty: string;
    tabsLabel: string;
    tabs: Readonly<Record<"preview" | "input" | "ingredients" | "checks", string>>;
    notConverted: string;
    notConvertedHint: string;
    conversionFailed: string;
    noIngredients: string;
    amount: string;
    food: string;
    note: string;
    source: string;
    optional: string;
    unparsed: string;
    passed: string;
    errors(count: number): string;
    reviewHints: string;
    warnings: string;
    conversion: string;
    model: string;
    attempts: string;
    tokens: string;
    tokenCounts(input: number, output: number): string;
    cost: string;
    categories: string;
    droppedIds(ids: string): string;
  };
  settings: {
    title: string;
    subtitle: string;
    tabsLabel: string;
    tabs: Readonly<Record<"mc" | "lidl" | "mealie" | "ai" | "notify" | "system", string>>;
    mc: {
      title: string;
      checkNow: string;
      checkHint: string;
      state: string;
      expires: string;
      lastCheck: string;
      age: string;
      noCookie: string;
      // The age of the login (from "login") or of the stored cookie (from "stored").
      ageValue(hours: number, from: "login" | "stored"): string;
      lastError: string;
      renewTitle: string;
      ways: {
        auto: string;
        autoHint: string;
        autoLink: string;
        helper: string;
        helperHint: string;
        cookie: string;
      };
      cookieLabel: string;
      cookieHint: string;
      saveCookie: string;
    };
    lidl: {
      title: string;
      unavailable: string;
      account: string;
      notConfigured: string;
      browser: string;
      browserReady: string;
      browserMissing(reason: string): string;
      state: string;
      running: string;
      nextAttempt: string;
      nextTest: string;
      testNow: string;
      howItWorks: string;
      // How the automatic login behaves, one point per line.
      facts: readonly string[];
      storeAccount: string;
      changeAccount: string;
      email: string;
      emailHint: string;
      password: string;
      passwordHint: string;
      passwordStored: string;
      save: string;
      dangerZone: string;
      remove: string;
      removeHint: string;
      removeConfirm: string;
      lastAttempt: string;
      succeeded: string;
      failed: string;
      manual: string;
      screenshot: string;
      failure: Readonly<Record<AutoLoginFailureName, string>>;
      progressTitle: string;
      steps: Readonly<Record<LoginStepName, string>>;
      consentSteps(count: number): string;
      consentDismissed: string;
      termsAccepted: string;
      deviceChosen: string;
      // The browser of an attempt: "Chrome 141" (or null when unknown) and how it ran.
      browserUsed(name: string | null, mode: "new" | "shell" | "window"): string;
    };
    mealie: {
      title: string;
      url: string;
      state: string;
      connected: string;
      failed: string;
      unchecked: string;
      user: string;
      error: string;
      lastCheck: string;
      fix: string;
      actionTitle: string;
      actionSubtitle: string;
      dockerUrl: string;
      pageUrl: string;
      reveal: string;
      allowList: string;
      secret: string;
      noToken: string;
    };
    ai: {
      title: string;
      provider: string;
      providers: Readonly<Record<string, string>>;
      model: string;
      effort: string;
      corrections: string;
      readOnly: string;
      limits: string;
      jobsToday: string;
      costToday: string;
      monthJobs: string;
      monthCost: string;
      monthTokens: string;
      tokens(input: string, output: string): string;
      limitsHint: string;
    };
    notify: {
      title: string;
      state: string;
      on: string;
      off: string;
      recipient: string;
      test: string;
      sending: string;
      what: string;
      setUp: string;
    };
    system: {
      title: string;
      readme: string;
      version: string;
      uptime: string;
      dataDir: string;
      mcLocale: string;
      unverified: string;
      uiLanguage: string;
      recipeStatus: string;
      recipeStatusHint: Readonly<Record<SavedStatus, string>>;
      envHint: string;
      advanced: string;
      configHint: string;
      name: string;
      value: string;
      description: string;
      hidden: string;
      unset: string;
      isDefault: string;
      defaultLabel: string;
      required: string;
      valuesLabel: string;
    };
  };
}

// One sentence per job event code (src/store/job-events.ts). The raw error text of a
// failure is not part of it: the pages show the `error` parameter below the sentence.
export type JobEventTexts = {
  readonly [C in JobEventCode]: (params: JobEventParams[C]) => string;
};

export interface Messages {
  language: UiLanguage;
  // The Intl locale for dates.
  intlLocale: string;
  timeline: TimelineMessages;
  jobEvents: JobEventTexts;
  email: EmailMessages;
  admin: AdminMessages;
}

export const CATALOGS: Readonly<Record<UiLanguage, Messages>> = { de, en };

export function isUiLanguage(value: string): value is UiLanguage {
  return (UI_LANGUAGES as readonly string[]).includes(value);
}

export function messages(language: UiLanguage): Messages {
  return CATALOGS[language];
}

// The UI language for an output locale: its language part when a catalog exists, else
// English.
export function defaultUiLanguage(locale: string): UiLanguage {
  const language = locale.split("-")[0]?.toLowerCase() ?? "";
  return isUiLanguage(language) ? language : "en";
}

// The sentence of a job event in a catalog's language. Null when the stored parameters do
// not fit the code (a row edited by hand, or written by a release with other parameters).
export function jobEventText(
  catalog: Messages,
  code: JobEventCode,
  params: Readonly<Record<string, unknown>>,
): string | null {
  try {
    const render = catalog.jobEvents[code] as (params: unknown) => string;
    const text = render(params);
    return typeof text === "string" && !/\bundefined\b|\bNaN\b/.test(text) ? text : null;
  } catch {
    return null;
  }
}

// The English line of an event as the message column, the log and GET /jobs/:id keep it:
// the sentence, then the raw error when there is one.
export function jobEventMessage(code: JobEventCode, params: Readonly<Record<string, unknown>>) {
  const text = jobEventText(en, code, params) ?? code;
  return typeof params.error === "string" && params.error !== ""
    ? `${text}: ${params.error}`
    : text;
}

// A date and time in the catalog's style, for timeline entries and mails.
export function formatDateTime(iso: string, catalog: Messages): string {
  return new Intl.DateTimeFormat(catalog.intlLocale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
