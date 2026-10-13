// Consistency checks for the knowledge base in knowledge/. The files are data written from the
// corpus analysis; these tests keep them coherent with each other and with the device rules.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(import.meta.dirname, "..", "..", "knowledge");
const load = <T>(name: string): T => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;

interface Quantiles {
  typical: number;
  range: [number, number];
}
interface Technique {
  id: string;
  aliases: { de: string[]; en: string[] };
  ingredientClasses: string[];
  device: {
    mode: string;
    temperature?: Quantiles | null;
    timeSeconds?: Quantiles | null;
    speed?: { typical: number; max: number } | null;
    reverse: boolean | string;
    turbo: boolean;
    accessory: { measuringCup: string; attachment: string | null };
  };
  structure: string[];
  evidence: { steps: number; recipes: number; source: string };
}
interface Range {
  min: number;
  max: number;
}
interface Recommended {
  temperature?: { values?: number[]; range?: Range };
  timeSeconds?: Range;
  speed?: Range & { maxWhenHeated?: number; maxWithReverse?: number };
  weightGrams?: Range;
  phases?: Range;
  phaseTimeSeconds?: Range;
  phaseSpeed?: Range;
  modeSetting?: Record<string, string[]>;
}
interface ModeLimits {
  recommended: Recommended;
}
interface DeviceLimits {
  temperatureGrids: { heating: number[] };
  modes: Record<string, ModeLimits>;
}
interface HardLayer {
  min: number | null;
  max: number | null;
  values: (number | string | boolean)[] | null;
  conditions: { when: Record<string, Record<string, unknown>>; set: { max?: number } }[];
}
interface ProgramMode {
  id: string;
  params?: Record<string, { effective?: HardLayer }>;
}
interface TimingModel {
  constants: {
    heaterWatts: number;
    efficiency: number;
    heatCapacityJoulePerKgKelvin: number;
    startTemperatureC: number;
  };
  functions: { tMinSeconds: { secondsPerKgToBoil: number } };
  massLimits: { id: string; maxGrams?: number; minGrams?: number }[];
}
interface Units {
  roundingGrid: { grams: { band: [number, number | null]; step: number }[] };
  allowedUnits: { unit: string }[];
}

const techniques = load<{ techniques: Technique[] }>("techniques.json").techniques;
const limits = load<DeviceLimits>("device-limits.json");
const programs = load<{ modes: ProgramMode[] }>("device-programs.json");
const timing = load<TimingModel>("timing-model.json");
const units = load<Units>("units.json");

const within = (x: number, r: Range | undefined) => !r || (x >= r.min && x <= r.max);

describe("techniques.json", () => {
  it("covers at least 30 techniques with unique ids", () => {
    expect(techniques.length).toBeGreaterThanOrEqual(30);
    expect(new Set(techniques.map((t) => t.id)).size).toBe(techniques.length);
  });

  it("names a known mode, aliases in both languages and corpus evidence", () => {
    for (const t of techniques) {
      expect(limits.modes[t.device.mode], t.id).toBeDefined();
      expect(t.aliases.de.length, t.id).toBeGreaterThan(0);
      expect(t.aliases.en.length, t.id).toBeGreaterThan(0);
      expect(t.structure.length, t.id).toBeGreaterThan(0);
      expect(t.evidence.steps, t.id).toBeGreaterThan(0);
      expect(t.evidence.recipes, t.id).toBeGreaterThan(0);
      expect(t.evidence.source, t.id).toBe("corpus 2026-10");
    }
  });

  it("keeps typical values inside the recommended device ranges", () => {
    for (const t of techniques) {
      const rec = limits.modes[t.device.mode]?.recommended;
      if (!rec) continue;
      const time = t.device.timeSeconds;
      if (time) {
        expect(within(time.typical, rec.timeSeconds), `${t.id} time`).toBe(true);
        expect(time.range[0] <= time.typical && time.typical <= time.range[1], t.id).toBe(true);
      }
      const temp = t.device.temperature;
      if (temp && rec.temperature?.values && t.device.mode === "customized")
        expect(rec.temperature.values, `${t.id} temperature`).toContain(temp.typical);
    }
  });

  it("respects the speed caps for heat, reverse and the whisk", () => {
    for (const t of techniques) {
      const { speed, temperature, reverse, accessory } = t.device;
      if (!speed) continue;
      expect(speed.typical, t.id).toBeLessThanOrEqual(speed.max);
      if ((temperature?.typical ?? 0) > 0 || reverse === true)
        expect(speed.max, t.id).toBeLessThanOrEqual(3);
      if (accessory.attachment === "whisk") expect(speed.max, t.id).toBeLessThanOrEqual(4);
    }
  });

  it("stores no speed on program modes", () => {
    for (const t of techniques)
      if (t.device.mode !== "customized") expect(t.device.speed ?? null, t.id).toBeNull();
  });
});

describe("device-limits.json", () => {
  it("has ordered ranges for every recommended range", () => {
    for (const [mode, m] of Object.entries(limits.modes)) {
      const r = m.recommended;
      for (const x of [r.timeSeconds, r.speed, r.weightGrams, r.phases, r.phaseTimeSeconds])
        if (x) expect(x.min, mode).toBeLessThanOrEqual(x.max);
    }
  });

  it("caps manual speed at 3 with heat or reverse", () => {
    const speed = limits.modes.customized?.recommended.speed;
    expect(speed?.maxWhenHeated).toBe(3);
    expect(speed?.maxWithReverse).toBe(3);
  });

  it("keeps every recommended range inside the hard limit in device-programs.json", () => {
    // device-limits key -> device-programs param id; temperature and modeSetting are handled below.
    const rangeParams: Record<string, string> = {
      timeSeconds: "time",
      speed: "speed",
      weightGrams: "weight",
      phases: "phaseCount",
      phaseTimeSeconds: "phaseTime",
      phaseSpeed: "phaseSpeed",
    };
    const hardModes = new Map(programs.modes.map((m) => [m.id, m]));
    const notCompared: string[] = [];
    let compared = 0;
    for (const id of new Set([...Object.keys(limits.modes), ...hardModes.keys()])) {
      const rec = limits.modes[id]?.recommended;
      const hard = hardModes.get(id);
      if (!rec || !hard) {
        notCompared.push(`${id} (missing in ${rec ? "device-programs" : "device-limits"})`);
        continue;
      }
      const params = hard.params ?? {};
      for (const [key, value] of Object.entries(rec)) {
        const label = `${id}.${key}`;
        if (key === "modeSetting") {
          for (const [k, values] of Object.entries(rec.modeSetting ?? {})) {
            const allowed = params[k]?.effective?.values;
            if (!allowed) notCompared.push(`${label}.${k}`);
            else for (const v of values) expect(allowed, `${label}.${k}`).toContain(v);
            compared++;
          }
          continue;
        }
        const param = key === "temperature" ? "temperature" : rangeParams[key];
        const h = param === undefined ? undefined : params[param]?.effective;
        if (!h) {
          notCompared.push(label);
          continue;
        }
        compared++;
        const inside = (x: number, what: string) => {
          if (h.values && h.values.every((v) => typeof v === "number"))
            expect(h.values, `${label} ${what}`).toContain(x);
          if (h.min !== null) expect(x, `${label} ${what}`).toBeGreaterThanOrEqual(h.min);
          if (h.max !== null) expect(x, `${label} ${what}`).toBeLessThanOrEqual(h.max);
        };
        if (key === "temperature") {
          for (const v of rec.temperature?.values ?? []) inside(v, "value");
          const r = rec.temperature?.range;
          if (r) {
            if (h.min !== null) expect(r.min, label).toBeGreaterThanOrEqual(h.min);
            if (h.max !== null) expect(r.max, label).toBeLessThanOrEqual(h.max);
          }
          continue;
        }
        const r = value as Range;
        if (h.min !== null) expect(r.min, `${label} min`).toBeGreaterThanOrEqual(h.min);
        if (h.max !== null) expect(r.max, `${label} max`).toBeLessThanOrEqual(h.max);
      }
    }
    // The heated and reverse speed caps must not exceed the device conditions.
    const speedConditions = hardModes.get("customized")?.params?.speed?.effective?.conditions ?? [];
    const capFor = (param: string) =>
      speedConditions.find((c) => param in c.when)?.set.max ?? Number.POSITIVE_INFINITY;
    const speed = limits.modes.customized?.recommended.speed;
    expect(speed?.maxWhenHeated).toBeLessThanOrEqual(capFor("temperature"));
    expect(speed?.maxWithReverse).toBeLessThanOrEqual(capFor("clockwise"));

    expect(compared).toBeGreaterThan(20);
    if (notCompared.length)
      console.info(`recommended vs hard limits, not compared: ${notCompared.join(", ")}`);
  });

  it("uses the heating grid 0, 37, 40-130 in steps of 5", () => {
    const grid = limits.temperatureGrids.heating;
    expect(grid.slice(0, 3)).toEqual([0, 37, 40]);
    expect(grid.at(-1)).toBe(130);
    for (let i = 3; i < grid.length; i++) expect((grid[i] ?? 0) - (grid[i - 1] ?? 0)).toBe(5);
  });
});

describe("timing-model.json", () => {
  it("matches the stated seconds per kg to boil", () => {
    const c = timing.constants;
    const tMin =
      (c.heatCapacityJoulePerKgKelvin * (100 - c.startTemperatureC)) /
      (c.heaterWatts * c.efficiency);
    expect(Math.round(tMin)).toBe(timing.functions.tMinSeconds.secondsPerKgToBoil);
  });

  it("limits the bowl to 3000 g", () => {
    expect(timing.massLimits.find((l) => l.id === "bowl_max")?.maxGrams).toBe(3000);
  });
});

describe("units.json", () => {
  it("has contiguous gram rounding bands", () => {
    const bands = units.roundingGrid.grams;
    expect(bands[0]?.band[0]).toBe(0);
    for (let i = 1; i < bands.length; i++) expect(bands[i]?.band[0]).toBe(bands[i - 1]?.band[1]);
    expect(bands.at(-1)?.band[1]).toBeNull();
  });

  it("allows the official unit spellings", () => {
    const allowed = units.allowedUnits.map((u) => u.unit);
    for (const u of ["g", "Stück", "Tl", "El", "Prise", "Prisen", "Msp."])
      expect(allowed).toContain(u);
  });
});
