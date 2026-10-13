import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationOutput, RecipeGenerator } from "../src/convert/index.js";
import type { FetchLike } from "../src/mc/index.js";
import { RecipeInputSchema } from "../src/recipe/schema.js";
import {
  EXIT,
  USAGE,
  UsageError,
  compareSteps,
  corpusRequest,
  parseCategories,
  parseCommand,
  programSteps,
  runConvert,
  stepTable,
} from "./convert.js";
import { parseDetailFile } from "./corpus/normalize.js";

const MEALIE = "test/fixtures/mealie/recipe-structured-v3.28.json";
const CATEGORIES = "test/fixtures/mc/categories.json";
const soupText = await readFile("test/fixtures/convert/soup.recipe-input.json", "utf8");
const soup = RecipeInputSchema.parse(JSON.parse(soupText));

// A made-up corpus recipe in the shape of the public recipe API.
const corpusRecipe = {
  recipe: {
    id: 900001,
    name: "Testsuppe",
    categories: [{ id: 228, name: "Suppen & Eintöpfe" }],
    servingSizes: [
      {
        amount: 4,
        servingUnit: "Portionen",
        ingredientGroups: [{ id: 1, name: "FÜR DIE SUPPE" }],
        ingredients: [
          { amount: "1", unit: "Stück", name: "Zwiebeln", ingredientGroupId: 1 },
          { amount: "500", unit: "g", name: "Kürbis", ingredientGroupId: 1 },
          { amount: "", unit: "", name: "Salz zum Abschmecken", ingredientGroupId: null },
        ],
        steps: [
          {
            name: "Zwiebel halbieren",
            description: "Zwiebel halbieren und in den Mixbehälter geben.",
          },
          {
            name: "Zerkleinern",
            deviceSetting: {
              mode: "customized",
              settings: [{ temperature: 0, time: 5, speed: 5 }],
            },
          },
          {
            name: "500 g Kürbis",
            description: "500 g Kürbis",
            deviceSetting: { mode: "scale", settings: [{ weight: 500 }] },
          },
          {
            name: "Köcheln",
            deviceSetting: {
              mode: "customized",
              settings: [{ temperature: 100, time: 1200, speed: 1 }],
            },
          },
          {
            name: "Pürieren",
            deviceSetting: { mode: "ramp", settings: [{ time: 10 }, { time: 10 }] },
          },
        ],
      },
    ],
  },
};

function harness(answers: (string | GenerationOutput)[] = [], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const generate = vi.fn(() => {
    const next = answers.shift() ?? "{}";
    return Promise.resolve(
      typeof next === "string"
        ? { json: next, usage: { inputTokens: 1000, outputTokens: 100 } }
        : next,
    );
  });
  const generator: RecipeGenerator = { provider: "fake", model: "gpt-5.5", generate };
  const factory = vi.fn(() => generator);
  const run = (args: string[], extra: { fetch?: FetchLike; noGenerator?: boolean } = {}) =>
    runConvert(args, {
      env,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...(extra.fetch ? { fetch: extra.fetch } : {}),
      ...(extra.noGenerator ? {} : { generator: factory }),
    });
  return { run, out, err, generate, factory };
}

describe("parseCommand", () => {
  it("reads the three commands", () => {
    expect(
      parseCommand([
        "convert",
        "--mealie-json",
        "r.json",
        "--scale",
        "1.5",
        "--provider",
        "anthropic",
        "--out",
        "o.json",
      ]),
    ).toEqual({
      name: "convert",
      mealieJson: "r.json",
      scale: 1.5,
      provider: "anthropic",
      out: "o.json",
    });
    expect(parseCommand(["prompt", "--mealie-json", "r.json", "--categories", "c.json"])).toEqual({
      name: "prompt",
      mealieJson: "r.json",
      scale: 1,
      categories: "c.json",
    });
    expect(parseCommand(["eval", "--ids", "1, 2,3"])).toEqual({
      name: "eval",
      corpusDir: "local/corpus",
      ids: [1, 2, 3],
    });
    expect(parseCommand(["--help"])).toEqual({ name: "help" });
    expect(parseCommand(["help"])).toEqual({ name: "help" });
  });

  it("rejects wrong arguments with a usage error", () => {
    const cases: string[][] = [
      [],
      ["unknown"],
      ["convert"],
      ["convert", "--mealie-json", "r.json", "extra"],
      ["convert", "--mealie-json", "r.json", "--provider", "gemini"],
      ["convert", "--mealie-json", "r.json", "--scale", "0"],
      ["convert", "--mealie-json", "r.json", "--ids", "1"],
      ["prompt", "--mealie-json", "r.json", "--out", "o.json"],
      ["eval"],
      ["eval", "--ids", "abc"],
      ["eval", "--ids", "1", "--mealie-json", "r.json"],
      ["convert", "--nope"],
    ];
    for (const args of cases) expect(() => parseCommand(args), args.join(" ")).toThrow(UsageError);
  });
});

describe("runConvert", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "convert-cli-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prints the usage", async () => {
    const { run, out, err } = harness();
    expect(await run(["--help"])).toBe(EXIT.ok);
    expect(out).toEqual([USAGE]);
    expect(await run([])).toBe(EXIT.usage);
    expect(err[0]).toBe("Missing command");
  });

  it("prints the prompts without calling a model", async () => {
    const { run, out, factory } = harness();
    expect(await run(["prompt", "--mealie-json", MEALIE, "--categories", CATEGORIES])).toBe(
      EXIT.ok,
    );
    expect(out[0]).toMatch(/^# Role and goal/);
    expect(out[2]).toContain("- 228: Suppen & Eintöpfe");
    expect(out[2]).toContain("# Kürbis-Linsen-Suppe");
    expect(factory).not.toHaveBeenCalled();
  });

  it("converts a recipe, prints the steps and writes the result", async () => {
    const { run, out, err, factory } = harness([soupText]);
    const file = join(dir, "result.json");
    expect(
      await run(["convert", "--mealie-json", MEALIE, "--categories", CATEGORIES, "--out", file]),
    ).toBe(EXIT.ok);
    expect(factory).toHaveBeenCalledWith(expect.anything(), "openai");
    expect(err[0]).toContain('Converting "Kürbis-Linsen-Suppe" with fake gpt-5.5');
    expect(out[0]).toBe("Kürbis-Linsen-Suppe (4 Portionen, easy)");
    expect(out).toContain("Validator: ok after 1 attempt(s) with fake gpt-5.5");
    expect(
      out.some((line) => /^\s*2 {2}customized +Zerkleinern +0 °C, 5 s, speed 5$/.test(line)),
    ).toBe(true);
    expect(out).toContain("  - Croûtons nach Belieben, Menge nicht angegeben.");
    expect(out.at(-1)).toBe("Usage: 1000 input tokens, 100 output tokens, about 0.0080 USD");
    const written = JSON.parse(await readFile(file, "utf8")) as { attempts: number };
    expect(written.attempts).toBe(1);
  });

  it("reports a recipe that still has errors after the last round", async () => {
    const { run, err } = harness(["{}"], { LLM_MAX_CORRECTIONS: "0" });
    const file = join(dir, "failed.json");
    expect(
      await run(["convert", "--mealie-json", MEALIE, "--categories", CATEGORIES, "--out", file]),
    ).toBe(EXIT.failed);
    expect(err.some((line) => line.startsWith("The recipe still has"))).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      failed: true,
      lastJson: "{}",
    });
  });

  it("explains a missing API key, a missing file and a file that is not a recipe", async () => {
    const missingKey = harness();
    expect(
      await missingKey.run(["convert", "--mealie-json", MEALIE, "--categories", CATEGORIES], {
        noGenerator: true,
      }),
    ).toBe(EXIT.config);
    expect(missingKey.err.at(-1)).toContain("OPENAI_API_KEY is not set");

    const missing = harness();
    expect(await missing.run(["convert", "--mealie-json", join(dir, "nope.json")])).toBe(
      EXIT.failed,
    );
    expect(missing.err[0]).toContain("Cannot read the Mealie recipe");

    const notRecipe = harness();
    expect(await notRecipe.run(["convert", "--mealie-json", CATEGORIES])).toBe(EXIT.failed);
    expect(notRecipe.err[0]).toContain("not a Mealie recipe");
  });

  it("loads the categories from the public API and stops without them", async () => {
    const categories = await readFile(CATEGORIES, "utf8");
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(
        new Response(categories, { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const ok = harness();
    expect(await ok.run(["prompt", "--mealie-json", MEALIE], { fetch })).toBe(EXIT.ok);
    expect(ok.out[2]).toContain("- 228: Suppen & Eintöpfe");

    const offline = harness();
    const failing = vi.fn<FetchLike>(() => Promise.reject(new Error("offline")));
    expect(await offline.run(["prompt", "--mealie-json", MEALIE], { fetch: failing })).toBe(
      EXIT.failed,
    );
    expect(offline.err.at(-1)).toContain("Pass --categories <file>");
    expect(offline.out).toEqual([]);
  });

  it("prices the conversion with LLM_PRICES_JSON", async () => {
    const { run, out } = harness([soupText], {
      LLM_PRICES_JSON: '{"gpt-5.5": {"input": 1, "output": 1}}',
    });
    expect(await run(["convert", "--mealie-json", MEALIE, "--categories", CATEGORIES])).toBe(
      EXIT.ok,
    );
    // 1000 input and 100 output tokens at 1 USD per million each.
    expect(out.at(-1)).toBe("Usage: 1000 input tokens, 100 output tokens, about 0.0011 USD");
  });

  it("refuses to evaluate without a corpus", async () => {
    const { run, err } = harness();
    expect(await run(["eval", "--ids", "1", "--corpus-dir", join(dir, "no-corpus")])).toBe(
      EXIT.noInput,
    );
    expect(err[0]).toContain("No corpus at");
  });

  it("evaluates corpus recipes against their programs", async () => {
    const corpus = join(dir, "corpus");
    await mkdir(join(corpus, "details"), { recursive: true });
    await writeFile(join(corpus, "details", "900001.json"), JSON.stringify(corpusRecipe));
    const { run, out, generate } = harness([soupText]);
    const file = join(dir, "eval.json");
    const code = await run([
      "eval",
      "--corpus-dir",
      corpus,
      "--ids",
      "900001,900002",
      "--categories",
      CATEGORIES,
      "--out",
      file,
    ]);
    expect(code).toBe(EXIT.failed);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out[0]).toContain("id  orig  conv  mode  temp  time");
    expect(out[1]).toMatch(/^ 900001 {5}3 {5}5 {2}100% {2}100% {2}100%/);
    expect(out[2]).toContain("900002  missing or unreadable");
    expect(out[3]).toMatch(/^ {2}total/);
    expect(out[3]).toContain("1 failed");
    expect(out[5]).toMatch(/^tokens: 1000 input \(0 cached\), 100 output; /);
    const written = JSON.parse(await readFile(file, "utf8")) as {
      result: { corrections: unknown[] };
    }[];
    expect(written).toHaveLength(1);
    expect(written[0]?.result.corrections).toEqual([]);
  });
});

describe("corpus evaluation helpers", () => {
  it("builds a request from ingredients and instruction texts only", () => {
    const { request, original } = corpusRequest(parseDetailFile(JSON.stringify(corpusRecipe)));
    expect(request.title).toBe("Testsuppe");
    expect(request.servings).toBe(4);
    expect(request.categoryHints).toEqual(["Suppen & Eintöpfe"]);
    expect(request.ingredients.map((i) => [i.quantity, i.unit, i.food, i.section])).toEqual([
      [1, "Stueck", "Zwiebeln", "FÜR DIE SUPPE"],
      [500, "g", "Kürbis", "FÜR DIE SUPPE"],
      [null, null, "Salz zum Abschmecken", null],
    ]);
    expect(request.rendered).toContain(
      "1. Zwiebel halbieren und in den Mixbehälter geben.\n2. 500 g Kürbis",
    );
    expect(request.rendered).not.toContain("Köcheln");
    expect(original).toEqual([
      { mode: "customized", temperature: 0, seconds: 5 },
      { mode: "customized", temperature: 100, seconds: 1200 },
      { mode: "ramp", temperature: null, seconds: 20 },
    ]);
  });

  it("aligns program steps in order and checks temperature and time", () => {
    const comparison = compareSteps(
      [
        { mode: "customized", temperature: 0, seconds: 5 },
        { mode: "roasting", temperature: 130, seconds: 240 },
        { mode: "kneading", temperature: null, seconds: 120 },
      ],
      [
        { mode: "customized", temperature: 0, seconds: 10 },
        { mode: "steaming", temperature: null, seconds: 900 },
        { mode: "roasting", temperature: 120, seconds: 250 },
        { mode: "kneading_solid_dough", temperature: null, seconds: 120 },
      ],
    );
    expect(comparison).toEqual({
      original: 3,
      converted: 4,
      modeMatches: 3,
      temperaturePairs: 2,
      temperatureOk: 2,
      timePairs: 3,
      timeOk: 2,
    });
  });

  it("lists the program steps of a converted recipe and prints a step table", () => {
    expect(programSteps(soup).map((step) => step.mode)).toEqual([
      "customized",
      "customized",
      "customized",
      "puree",
      "customized",
    ]);
    const table = stepTable(soup);
    expect(table).toHaveLength(13);
    expect(table[3]).toMatch(/^\s*4 {2}scale +25 g Olivenöl in den Mixbehälter geben\. +25 g$/);
    expect(table[4]).toContain("100 °C, 3 min 0 s, speed 1, reverse");
  });

  it("reads category files in three shapes", () => {
    const list = [{ id: 1, name: "A" }];
    expect(parseCategories(list)).toEqual(list);
    expect(parseCategories({ categories: list })).toEqual(list);
    expect(parseCategories({ data: { categories: [{ id: 1, name: "A", order: 3 }] } })).toEqual(
      list,
    );
    expect(() => parseCategories({ nope: true })).toThrow("no list of {id, name}");
  });
});
