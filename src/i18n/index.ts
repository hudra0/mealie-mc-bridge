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
  failureReasons: Readonly<Record<FailureStage, string>>;
}

// Plain text mails.
export interface EmailMessages {
  subjectPrefix: string;
  session: Readonly<Record<"expired" | "invalid", { subject: string; lead: string }>>;
  sessionWaiting: string;
  sessionNextSteps: readonly string[];
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
  nav: { dashboard: string; jobs: string; dryRun: string };
  authBanner: string;
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
    conversionLinkExpired: string;
    conversionFailed(reason: string): string;
  };
  links: { backToDashboard: string; backToJobs: string; allJobs: string };
  jobStatus: Readonly<Record<JobStatusName, string>>;
  sessionState: Readonly<Record<SessionStateName, string>>;
  jobsTable: {
    empty: string;
    created: string;
    recipe: string;
    scale: string;
    status: string;
    attempts: string;
    result: string;
    recipeLink(id: number | string, status: SavedStatus): string;
  };
  dashboard: {
    session: string;
    state: string;
    lastCheck: string;
    cookieAge: string;
    noCookie: string;
    // The age of the login (from "login") or of the stored cookie (from "stored").
    age(hours: number, from: "login" | "stored"): string;
    cookieExpires: string;
    expiresAt(time: string, expired: boolean): string;
    lastError: string;
    newRecipes: string;
    privatePublish: string;
    draftOnly: string;
    checkNow: string;
    cookieLabel: string;
    saveSession: string;
    queue: string;
    worker: string;
    unknown: string;
    paused: string;
    running: string;
    stopped: string;
    lastWorkerError(time: string): string;
    recentJobs: string;
    dryRun: string;
  };
  jobList: {
    status: string;
    all: string;
    recipe: string;
    searchPlaceholder: string;
    filter: string;
    newer: string;
    older: string;
  };
  jobDetail: {
    status: string;
    job: string;
    mealieRecipe: string;
    monsieurCuisine: string;
    openRecipe(id: number | string, status: SavedStatus): string;
    scale: string;
    // " (10 Scheiben)"; the unit is null on jobs from before it was stored.
    servingSize(amount: number, unit: string | null): string;
    attempts: string;
    forced: string;
    created: string;
    started: string;
    finished: string;
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
    withoutId: string;
    reviewHints: string;
    warnings: string;
    error: string;
    runningLocked: string;
    retry: string;
    forceRebuild: string;
    cancel: string;
    events: string;
    time: string;
    level: string;
    message: string;
  };
  dryRun: {
    recipe: string;
    recipePlaceholder: string;
    scale: string;
    preview: string;
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
    section: string;
    amount: string;
    unit: string;
    food: string;
    note: string;
    source: string;
    original: string;
    optional: string;
    converterInput: string;
    conversion: string;
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
