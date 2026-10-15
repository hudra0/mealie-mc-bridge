// Message catalogs for what people read: Mealie timeline entries, mails and the admin
// pages, per UI_LANGUAGE, and the progress events of a running conversion. Logs, the other
// job events and command line output stay English.
//
// Each catalog implements Messages, so the compiler holds every language to the same keys;
// a test compares them at run time as well. Texts that end up in Markdown or HTML are plain
// here; the callers escape what they insert.

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
  | "verification_required"
  | "not_logged_in"
  | "unexpected_page"
  | "verify_failed"
  | "error";

export type SessionStateName = "valid" | "invalid" | "expired" | "unknown";

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
}

// The admin pages. Text in backticks is shown as code.
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
  header: { mcSession: string; signedIn(user: string): string; noPassword: string };
  authBanner: string;
  skipToContent: string;
  login: {
    title: string;
    intro: string;
    user: string;
    password: string;
    submit: string;
    wrongCredentials: string;
    tooMany(minutes: number): string;
  };
  // Under the job list and a running job: the page reloads on its own.
  autoRefresh: string;
  notices: Readonly<Record<string, string>>;
  plain: { unknownHost: string; authRequired: string; crossOrigin: string };
  titles: {
    dashboard: string;
    jobs: string;
    job: string;
    notFound: string;
    notPossible: string;
    formExpired: string;
    dryRun: string;
  };
  errors: {
    formExpired: string;
    cookieEmpty: string;
    cookieRejected(reason: string): string;
    cookieUnchecked(reason: string): string;
    noSuchJob: string;
    recipeNotLoaded(reason: string): string;
    conversionFailed(reason: string): string;
    credentialsInvalid(field: "email" | "password"): string;
  };
  links: { backToDashboard: string; backToJobs: string; allJobs: string };
  jobStatus: Readonly<Record<JobStatusName, string>>;
  // One sentence per status for the legend under the job list.
  jobStatusHelp: Readonly<Record<JobStatusName, string>>;
  sessionState: Readonly<Record<SessionStateName, string>>;
  jobsTable: {
    empty: string;
    emptyHint: string;
    created: string;
    recipe: string;
    scale: string;
    status: string;
    duration: string;
    cost: string;
    result: string;
    recipeLink(id: number | string, status: SavedStatus): string;
  };
  // The "getting started" checklist on the overview.
  setup: {
    title: string;
    lead: string;
    stepState: Readonly<Record<"done" | "open" | "failed" | "unknown", string>>;
    mealie: {
      title: string;
      ok(url: string): string;
      failed(url: string): string;
      unchecked(url: string): string;
      fix: string;
      timeout(seconds: number): string;
    };
    session: {
      title: string;
      valid: string;
      validUntil(time: string, expired: boolean): string;
      notValid(state: string): string;
      fix: string;
    };
    autoLogin: {
      title: string;
      configured(email: string): string;
      notConfigured: string;
      fix: string;
      unavailable: string;
    };
    action: {
      title: string;
      seen(jobs: number): string;
      notSeen: string;
      where: string;
      reveal: string;
      dockerLabel: string;
      pageLabel: string;
      secret: string;
      noToken: string;
      network: string;
    };
    firstJob: { title: string; done(count: number): string; notYet: string };
  };
  dashboard: {
    lead: string;
    state: string;
    lastCheck: string;
    cookieAge: string;
    noCookie: string;
    // The age of the login (from "login") or of the stored cookie (from "stored").
    age(hours: number, from: "login" | "stored"): string;
    cookieExpires: string;
    expiresAt(time: string, expired: boolean): string;
    lastError: string;
    checkNow: string;
    // The help text under the cookie field on the settings page.
    cookieLabel: string;
    saveSession: string;
    queue: string;
    queueLead: string;
    worker: string;
    unknown: string;
    paused: string;
    running: string;
    stopped: string;
    workerError(time: string): string;
    jobError(time: string): string;
    noErrors: string;
    recentJobs: string;
  };
  jobList: {
    lead: string;
    status: string;
    all: string;
    recipe: string;
    searchPlaceholder: string;
    filter: string;
    reset: string;
    noMatch: string;
    noMore: string;
    newer: string;
    older: string;
    legend: string;
  };
  jobDetail: {
    lead: string;
    facts: string;
    job: string;
    mealieRecipe: string;
    monsieurCuisine: string;
    openRecipe(id: number | string, status: SavedStatus): string;
    openInMealie: string;
    scale: string;
    // " (10 Scheiben)"; the unit is null on jobs from before it was stored.
    servingSize(amount: number, unit: string | null): string;
    attempts: string;
    forced: string;
    created: string;
    started: string;
    finished: string;
    duration: string;
    model: string;
    usage: string;
    tokens(input: number, cached: number | null, output: number): string;
    ingredientIds: string;
    resolutionOff(unresolved: number): string;
    resolution(
      catalog: number,
      relaxed: number,
      cache: number,
      search: number,
      unresolved: number,
    ): string;
    checkTitle: string;
    checkLead: string;
    noHints: string;
    reviewHints: string;
    warnings: string;
    error: string;
    actions: string;
    runningLocked: string;
    retry: string;
    retryHelp: string;
    forceRebuild: string;
    forceRebuildHelp: string;
    cancel: string;
    cancelHelp: string;
    events: string;
    noEvents: string;
    ingredients: string;
    ingredientsLead: string;
    ingredientsOff: string;
    resolved(count: number): string;
    withoutId(count: number): string;
    noneResolved: string;
    noneUnresolved: string;
  };
  settings: {
    title: string;
    lead: string;
    session: {
      title: string;
      lead: string;
      checkHelp: string;
      renewTitle: string;
      renewWays: readonly string[];
      cookieLabel: string;
    };
    account: string;
    intro: string;
    // How the automatic login behaves, one point per line.
    facts: readonly string[];
    unavailable: string;
    accountState: string;
    storeAccount: string;
    changeAccount: string;
    email: string;
    emailHelp: string;
    password: string;
    passwordHelp: string;
    passwordStored: string;
    save: string;
    testNow: string;
    testHelp: string;
    remove: string;
    removeHelp: string;
    notConfigured: string;
    configuredAs(email: string): string;
    browser: string;
    browserReady: string;
    browserMissing(reason: string): string;
    lastAttempt: string;
    never: string;
    attempt(time: string, ok: boolean, manual: boolean): string;
    failure: Readonly<Record<AutoLoginFailureName, string>>;
    consentDismissed: string;
    termsAccepted: string;
    deviceChosen: string;
    screenshot: string;
    nextAttempt: string;
    running: string;
    manualCooldown(time: string): string;
    locale: {
      title: string;
      lead: string;
      unverified: string;
      mcLocale: string;
      uiLanguage: string;
      recipeStatus: Readonly<Record<SavedStatus, string>>;
    };
    config: {
      title: string;
      lead: string;
      unavailable: string;
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
  dryRun: {
    lead: string;
    formTitle: string;
    recipe: string;
    recipePlaceholder: string;
    recipeHelp: string;
    scale: string;
    scaleHelp: string;
    preview: string;
    alsoConvert: string;
    alsoConvertHelp: string;
    servings: string;
    servingsEstimated: string;
    sourceHash: string;
    alreadySent: string;
    sentAt(time: string): string;
    wouldSkip: string;
    no: string;
    convert: string;
    costsMoney: string;
    ingredients: string;
    ingredientsLead: string;
    noIngredients: string;
    section: string;
    amount: string;
    unit: string;
    food: string;
    note: string;
    source: string;
    original: string;
    optional: string;
    converterInput: string;
    converterInputLead: string;
    conversion: string;
    conversionLead: string;
    model: string;
    attempts(count: number): string;
    usage: string;
    tokens(input: number, output: number): string;
    title: string;
    times: string;
    timesValue(preparation: number, ready: number): string;
    categories: string;
    none: string;
    droppedIds(ids: string): string;
    validation: string;
    passed: string;
    errors(count: number): string;
    field: string;
    problem: string;
    reviewHints: string;
    noHints: string;
    warnings: string;
    steps: string;
    kind: string;
    settings: string;
    text: string;
    ingredientGroups: string;
  };
}

// Job events while the language model works, so the job page shows progress.
export interface JobEventMessages {
  converting: string;
  stillConverting(seconds: number): string;
}

export interface Messages {
  language: UiLanguage;
  // The Intl locale for dates.
  intlLocale: string;
  timeline: TimelineMessages;
  jobEvents: JobEventMessages;
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

// A date and time in the catalog's style, for timeline entries and mails.
export function formatDateTime(iso: string, catalog: Messages): string {
  return new Intl.DateTimeFormat(catalog.intlLocale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
