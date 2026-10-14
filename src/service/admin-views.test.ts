import { describe, expect, it } from "vitest";
import { adminTimeZone, formatTime, storedNotes } from "./admin-views.js";

const AT = "2026-10-13T23:29:27.000Z";

describe("formatTime", () => {
  it("shows the time in the given zone with its short name", () => {
    expect(formatTime(AT, "Europe/Berlin")).toBe("2026-10-14 01:29:27 CEST");
    expect(formatTime("2026-12-01T08:00:00.000Z", "Europe/Berlin")).toBe("2026-12-01 09:00:00 CET");
    expect(formatTime(AT, "America/New_York")).toBe("2026-10-13 19:29:27 EDT");
    expect(formatTime(AT, "UTC")).toBe("2026-10-13 23:29:27 UTC");
  });

  it("falls back to an offset where no short name exists", () => {
    expect(formatTime(AT, "Asia/Kathmandu")).toBe("2026-10-14 05:14:27 GMT+5:45");
  });

  it("writes midnight as 00, not 24", () => {
    expect(formatTime("2026-10-13T22:00:05.000Z", "Europe/Berlin")).toBe(
      "2026-10-14 00:00:05 CEST",
    );
  });

  it("passes empty and unreadable values through", () => {
    expect(formatTime(null)).toBe("–");
    expect(formatTime(undefined)).toBe("–");
    expect(formatTime("not a date")).toBe("not a date");
  });
});

describe("adminTimeZone", () => {
  const system = new Intl.DateTimeFormat().resolvedOptions().timeZone;

  it("takes TZ when it names a zone", () => {
    expect(adminTimeZone({ TZ: "Europe/Vienna" })).toBe("Europe/Vienna");
    expect(adminTimeZone({ TZ: " UTC " })).toBe("UTC");
  });

  it("falls back to the system zone without a usable TZ", () => {
    expect(adminTimeZone({})).toBe(system);
    expect(adminTimeZone({ TZ: "" })).toBe(system);
    expect(adminTimeZone({ TZ: "Not/AZone" })).toBe(system);
  });
});

describe("storedNotes", () => {
  it("reads hints and warnings of a stored conversion and ignores anything else", () => {
    expect(storedNotes({ conversion: null })).toEqual({ hints: [], warnings: [] });
    expect(storedNotes({ conversion: { sourceHash: "x", result: "broken" } })).toEqual({
      hints: [],
      warnings: [],
    });
    expect(
      storedNotes({
        conversion: {
          sourceHash: "x",
          result: {
            reviewHints: ["a", 3, " ", "b"],
            warnings: "w",
            recipe: { reviewHints: ["b", "c"] },
          },
        },
      }),
    ).toEqual({ hints: ["a", "b", "c"], warnings: [] });
  });
});
