import { describe, expect, it } from "vitest";
import {
  adminTimeZone,
  formatCost,
  formatDateTime,
  formatDuration,
  formatExactTime,
  formatMs,
  formatNumber,
  formatPercent,
  relativeTime,
} from "./format.js";

const AT = "2026-10-13T23:29:27.000Z";

describe("dates", () => {
  it("shows a date and time in the language and zone of the pages", () => {
    expect(formatDateTime(AT, "de-DE", "Europe/Berlin")).toBe("14.10.2026, 01:29");
    expect(formatDateTime(AT, "en-US", "America/New_York")).toBe("Oct 13, 2026, 7:29 PM");
    expect(formatDateTime(null, "de-DE")).toBe("–");
    expect(formatDateTime("not a date", "de-DE")).toBe("not a date");
  });

  it("shows the exact time with seconds and the zone for tooltips", () => {
    expect(formatExactTime(AT, "de-DE", "Europe/Berlin")).toBe("14.10.2026, 01:29:27 MESZ");
    expect(formatExactTime(AT, "en-US", "UTC")).toBe("10/13/2026, 11:29:27 PM UTC");
    expect(formatExactTime("nope", "en-US")).toBe("nope");
  });

  it("picks seconds, minutes, hours or days, past and future", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    expect(relativeTime("2026-10-15T11:59:30.000Z", now, "en")).toBe("30 seconds ago");
    expect(relativeTime("2026-10-15T11:57:00.000Z", now, "en")).toBe("3 minutes ago");
    expect(relativeTime("2026-10-15T09:00:00.000Z", now, "de")).toBe("vor 3 Stunden");
    expect(relativeTime("2026-10-13T12:00:00.000Z", now, "en")).toBe("2 days ago");
    expect(relativeTime("2026-10-24T12:00:00.000Z", now, "de")).toBe("in 9 Tagen");
    expect(relativeTime("not a date", now, "en")).toBe("not a date");
  });

  it("takes TZ when it names a zone, else the system zone", () => {
    const system = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(adminTimeZone({ TZ: "Europe/Vienna" })).toBe("Europe/Vienna");
    expect(adminTimeZone({ TZ: " UTC " })).toBe("UTC");
    expect(adminTimeZone({})).toBe(system);
    expect(adminTimeZone({ TZ: "Not/AZone" })).toBe(system);
  });
});

describe("durations", () => {
  it("writes seconds, minutes and hours", () => {
    expect(formatMs(45_000)).toBe("45 s");
    expect(formatMs(185_000)).toBe("3 min 05 s");
    expect(formatMs(3_720_000)).toBe("1 h 02 min");
    expect(formatMs(null)).toBe("–");
    expect(formatMs(-1)).toBe("–");
  });

  it("counts a running job up to now and skips unreadable times", () => {
    const now = new Date("2026-10-15T12:01:00.000Z");
    expect(formatDuration("2026-10-15T12:00:00.000Z", null, now)).toBe("1 min 00 s");
    expect(formatDuration("2026-10-15T12:00:00.000Z", "2026-10-15T12:00:30.000Z", now)).toBe(
      "30 s",
    );
    expect(formatDuration(null, null, now)).toBe("–");
    expect(formatDuration("x", null, now)).toBe("–");
    expect(formatDuration("2026-10-15T12:00:30.000Z", "2026-10-15T12:00:00.000Z", now)).toBe("–");
  });
});

describe("money and numbers", () => {
  it("writes cents, and four decimals when precise or below a cent", () => {
    expect(formatCost(0.1162, "en-US")).toBe("$0.12");
    expect(formatCost(0.1162, "en-US", { precise: true })).toBe("$0.1162");
    expect(formatCost(0.004, "en-US")).toBe("$0.0040");
    expect(formatCost(0, "en-US")).toBe("$0.00");
    expect(formatCost(1.05, "de-DE")).toBe("1,05 $");
    expect(formatCost(null, "en-US")).toBe("–");
    expect(formatCost(undefined, "en-US")).toBe("–");
    expect(formatCost(Number.NaN, "en-US")).toBe("–");
  });

  it("formats numbers and shares per locale", () => {
    expect(formatNumber(12480, "de-DE")).toBe("12.480");
    expect(formatNumber(1.25, "en-US", 2)).toBe("1.25");
    expect(formatPercent(0.666, "en-US")).toBe("67%");
    expect(formatPercent(0.5, "de-DE")).toBe("50 %");
  });
});
