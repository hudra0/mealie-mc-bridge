import { describe, expect, it } from "vitest";
import { CATALOGS } from "../../i18n/index.js";
import { JOB_EVENT_CODES } from "../../store/job-events.js";
import type { JobEvent } from "../../store/jobs.js";
import { EVENT_SAMPLES } from "../../testing/events.js";
import { ICONS } from "../ui/icons.generated.js";
import type { ViewContext } from "./context.js";
import { EVENT_STYLE, eventItem, eventTimeline } from "./events.js";

const ctx = (language: "de" | "en"): ViewContext => ({
  m: CATALOGS[language],
  t: CATALOGS[language].admin,
  now: new Date("2026-10-16T12:00:00.000Z"),
  timeZone: "UTC",
  csrf: "",
});

const event = (overrides: Partial<JobEvent>): JobEvent => ({
  id: 1,
  jobId: "j",
  ts: "2026-10-16T11:58:00.000Z",
  level: "info",
  message: "stored message",
  code: null,
  params: null,
  ...overrides,
});

describe("job event timeline", () => {
  it("has an icon for every code", () => {
    for (const code of JOB_EVENT_CODES) {
      expect(ICONS[EVENT_STYLE[code][0]], code).toBeTruthy();
    }
  });

  it("renders a code in the language of the pages, with the error and the details", () => {
    const failed = event({
      level: "error",
      code: "failed",
      params: { stage: "upload", error: "HTTP 500 <b>" },
      message: "Upload failed: HTTP 500 <b>",
    });
    const item = eventItem(failed, ctx("de"));
    expect(item.text).toBe("Hochladen fehlgeschlagen");
    expect(item.tone).toBe("danger");
    expect(item.sub).toBe("HTTP 500 <b>");
    expect(item.details?.html).toContain("<code>failed</code>");
    expect(item.details?.html).toContain("HTTP 500 &lt;b&gt;");
    expect(item.time.html).toContain("vor 2 Minuten");
  });

  it("shows the stored message for older rows and codes whose parameters do not fit", () => {
    const old = eventItem(event({ level: "warn", message: "Konvertierung gestartet" }), ctx("en"));
    expect(old.text).toBe("Konvertierung gestartet");
    expect(old.tone).toBe("warn");
    expect(old.details).toBeNull();
    const broken = eventItem(event({ code: "categories", params: {} }), ctx("en"));
    expect(broken.text).toBe("stored message");
    expect(broken.details).toBeNull();
  });

  it("lists every sample event newest first", () => {
    const events = JOB_EVENT_CODES.map((code, index) =>
      event({
        id: index,
        code,
        params: EVENT_SAMPLES[code],
        ts: new Date(Date.parse("2026-10-16T11:00:00.000Z") + index * 1000).toISOString(),
      }),
    );
    for (const language of ["de", "en"] as const) {
      const html = eventTimeline(events, ctx(language)).html;
      expect(html).not.toContain("stored message");
      expect(html).not.toMatch(/undefined|NaN/);
      expect(
        html.indexOf(CATALOGS[language].jobEvents.retry_scheduled(EVENT_SAMPLES.retry_scheduled)),
      ).toBeLessThan(html.indexOf(CATALOGS[language].jobEvents.queued(EVENT_SAMPLES.queued)));
    }
    const lists = eventItem(
      event({ code: "categories_dropped", params: { ids: [1, 2] } }),
      ctx("en"),
    );
    expect(lists.details?.html).toContain("1, 2");
  });
});
