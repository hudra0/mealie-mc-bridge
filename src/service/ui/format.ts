// Dates, durations, money and numbers as the admin pages show them, in the language of the
// pages and the time zone of the bridge.

// The zone the admin pages show times in: TZ when it names a zone Intl knows, else the
// zone of the system. The Mealie timeline entries use local time as well.
export function adminTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const zone = env.TZ?.trim();
  if (zone) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      // Not a zone name; fall back to the system zone.
    }
  }
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// "16. Okt. 2026, 12:45" or "Oct 16, 2026, 12:45 PM"; "–" without a time.
export function formatDateTime(
  iso: string | null | undefined,
  intlLocale: string,
  timeZone: string = adminTimeZone(),
): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

// The full time for a tooltip: date, time with seconds and the zone's short name.
export function formatExactTime(
  iso: string,
  intlLocale: string,
  timeZone: string = adminTimeZone(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(date);
}

// "vor 3 Minuten", "in 9 Tagen": from seconds up to days, in the language of the pages.
export function relativeTime(iso: string, now: Date, language: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((then - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

// "45 s", "3 min 05 s", "1 h 02 min"; "–" for null.
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "–";
  const seconds = Math.round(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${pad(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${pad(Math.floor((seconds % 3600) / 60))} min`;
}

// How long a job ran. A running job counts up to now; "–" before it started or when a time
// is unreadable.
export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
  now: Date,
): string {
  if (!startedAt) return "–";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "–";
  return formatMs(end - start);
}

// US dollars: cents in lists, four decimals where the exact estimate matters and for
// amounts below a cent, so a cheap conversion does not show as $0.00; "–" without a cost.
export function formatCost(
  costUsd: number | null | undefined,
  intlLocale: string,
  options: { precise?: boolean } = {},
): string {
  if (costUsd === null || costUsd === undefined || !Number.isFinite(costUsd)) return "–";
  const digits = options.precise || (costUsd !== 0 && Math.abs(costUsd) < 0.01) ? 4 : 2;
  return new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(costUsd);
}

export function formatNumber(value: number, intlLocale: string, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(intlLocale, { maximumFractionDigits }).format(value);
}

export function formatPercent(share: number, intlLocale: string): string {
  return new Intl.NumberFormat(intlLocale, { style: "percent", maximumFractionDigits: 0 }).format(
    share,
  );
}
