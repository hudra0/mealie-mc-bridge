import { describe, expect, it } from "vitest";
import { CATALOGS, UI_LANGUAGES, jobEventMessage, jobEventText } from "../i18n/index.js";
import { EVENT_SAMPLES } from "../testing/events.js";
import { tempStore } from "../testing/temp.js";
import { JOB_EVENT_CODES, MAX_PARAM_LENGTH, isJobEventCode, storedParams } from "./job-events.js";

describe("job event codes", () => {
  it("render every code in every language", () => {
    expect(Object.keys(EVENT_SAMPLES).sort()).toEqual([...JOB_EVENT_CODES].sort());
    for (const language of UI_LANGUAGES) {
      for (const code of JOB_EVENT_CODES) {
        const text = jobEventText(CATALOGS[language], code, EVENT_SAMPLES[code]);
        expect(text, `${language} ${code}`).toBeTruthy();
        expect(text, `${language} ${code}`).not.toMatch(/undefined|NaN|\[object/);
      }
    }
  });

  it("writes the English message with the raw error", () => {
    expect(jobEventMessage("failed", EVENT_SAMPLES.failed)).toBe(
      "Conversion failed: invalid answer",
    );
    expect(jobEventMessage("queued", EVENT_SAMPLES.queued)).toBe("Queued with scale 1.5, forced");
    expect(jobEventText(CATALOGS.de, "failed", EVENT_SAMPLES.failed)).toBe(
      "Umwandlung fehlgeschlagen",
    );
  });

  it("returns null for parameters that do not fit the code", () => {
    expect(jobEventText(CATALOGS.en, "categories", {})).toBeNull();
    expect(jobEventText(CATALOGS.en, "attempt_started", {})).toBeNull();
    expect(jobEventMessage("attempt_started", {})).toBe("attempt_started");
  });

  it("knows its codes and stores only plain parameter values", () => {
    expect(isJobEventCode("done")).toBe(true);
    expect(isJobEventCode("future_code")).toBe(false);
    expect(isJobEventCode(7)).toBe(false);
    const stored = storedParams({
      text: "x".repeat(MAX_PARAM_LENGTH + 5),
      count: 3,
      flag: false,
      none: null,
      list: ["a", 1, { nested: true }],
      object: { nested: true },
    });
    expect(stored).toEqual({
      text: `${"x".repeat(MAX_PARAM_LENGTH)}...`,
      count: 3,
      flag: false,
      none: null,
      list: ["a", 1],
    });
    expect(storedParams(undefined)).toEqual({});
  });
});

describe("job events in the store", () => {
  it("keeps the code, the parameters and the English message", () => {
    const store = tempStore();
    try {
      const { job } = store.jobs.enqueue({ recipeId: "r1", scale: 1 });
      store.jobs.appendEvent(job.id, "error", {
        code: "failed",
        params: { stage: "upload", error: "<b>boom</b>" },
      });
      store.jobs.appendEvent(job.id, "info", "a plain message");
      const [queued, failed, plain] = store.jobs.events(job.id);
      expect(queued).toMatchObject({
        code: "queued",
        params: { scale: 1, force: false },
        message: "Queued with scale 1",
      });
      expect(failed).toMatchObject({
        level: "error",
        code: "failed",
        params: { stage: "upload", error: "<b>boom</b>" },
        message: "Upload failed: <b>boom</b>",
      });
      expect(plain).toMatchObject({ code: null, params: null, message: "a plain message" });
    } finally {
      store.dispose();
    }
  });

  it("reads an unknown code or broken parameters back without failing", () => {
    const store = tempStore();
    try {
      const { job } = store.jobs.enqueue({ recipeId: "r1", scale: 1 });
      const db = store.db;
      db.prepare(
        "INSERT INTO job_events (job_id, ts, level, message, code, params_json) VALUES (?, ?, 'info', ?, ?, ?)",
      ).run(job.id, "2026-10-16T10:00:00.000Z", "from the future", "future_code", "{}");
      db.prepare(
        "INSERT INTO job_events (job_id, ts, level, message, code, params_json) VALUES (?, ?, 'info', ?, ?, ?)",
      ).run(job.id, "2026-10-16T10:00:01.000Z", "broken", "done", "not json");
      const events = store.jobs.events(job.id);
      expect(events[1]).toMatchObject({ code: null, params: null, message: "from the future" });
      expect(events[2]).toMatchObject({ code: "done", params: {}, message: "broken" });
    } finally {
      store.dispose();
    }
  });
});
