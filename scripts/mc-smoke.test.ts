import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/mc/index.js";
import { EXIT, USAGE, runSmoke } from "./mc-smoke.js";

const COOKIE = "wordpress_logged_in_0123=synthetic-cookie; lidl_sso_id_token=synthetic-token";
const SAMPLE = "test/fixtures/recipe/all-modes.recipe-input.json";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../test/fixtures/mc/${name}`, import.meta.url), "utf8"));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(env: Record<string, string> = {}, responses: Response[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const endpoints: string[] = [];
  const fetch = vi.fn<FetchLike>((url, init) => {
    if (typeof init.body === "string") {
      const body = JSON.parse(init.body) as { endpoint: string; method: string };
      endpoints.push(`${body.method} ${body.endpoint}`);
    } else {
      endpoints.push(`${init.method ?? "GET"} ${new URL(url).host}`);
    }
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("unexpected fetch call"));
  });
  const run = (...args: string[]) =>
    runSmoke(args, {
      env,
      fetch,
      sleep: () => Promise.resolve(),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
  return { run, out, err, fetch, endpoints };
}

describe("mc-smoke", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mc-smoke-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prints the usage without a command", async () => {
    const { run, out } = harness();
    expect(await run()).toBe(EXIT.usage);
    expect(out).toEqual([USAGE]);
    expect(await run("--help")).toBe(EXIT.ok);
  });

  it.each([
    [["frobnicate"], /Unknown command frobnicate/],
    [["whoami", "extra"], /Too many arguments for whoami/],
    [["dry-run"], /dry-run needs a recipe file/],
    [["whoami", "--status", "draft"], /only apply to create/],
    [["whoami", "--verbose"], /Unknown option '--verbose'/],
  ])("rejects %j", async (args, message) => {
    const { run, err } = harness({ MC_COOKIE: COOKIE });
    expect(await run(...args)).toBe(EXIT.usage);
    expect(err.join("\n")).toMatch(message);
  });

  it.each(["whoami", "categories", `create ${SAMPLE}`])(
    "refuses %s without MC_COOKIE",
    async (command) => {
      const { run, err, fetch } = harness({ MC_COOKIE: "" });
      expect(await run(...command.split(" "))).toBe(EXIT.session);
      expect(err.join("\n")).toContain("MC_COOKIE is not set");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("checks the session", async () => {
    const { run, out, endpoints } = harness({ MC_COOKIE: COOKIE }, [
      json(200, await fixture("users.json")),
    ]);
    expect(await run("whoami")).toBe(EXIT.ok);
    expect(endpoints).toEqual(["GET api/v1/users"]);
    expect(out).toEqual(["Session is valid. Account id 1000001, display name test-user."]);
  });

  it("explains an expired session without printing the cookie", async () => {
    const { run, out, err } = harness({ MC_COOKIE: COOKIE }, [
      json(401, await fixture("error-expired-cookie.json")),
    ]);
    expect(await run("whoami")).toBe(EXIT.session);
    expect(err[0]).toMatch(/^No usable Monsieur Cuisine session \(expired\)/);
    expect([...out, ...err].join("\n")).not.toContain("synthetic");
  });

  it("lists the categories", async () => {
    const { run, out } = harness({ MC_COOKIE: COOKIE }, [
      json(200, await fixture("categories.json")),
    ]);
    expect(await run("categories")).toBe(EXIT.ok);
    expect(out[0]).toBe("25 categories (from the proxy API):");
    expect(out).toContain("   228  Suppen & Eintöpfe");
  });

  it("reports other API failures", async () => {
    const { run, err } = harness({ MC_COOKIE: COOKIE }, [
      json(500, { code: 1, message: "Internal", data: null }),
      json(503, { code: 1, message: "Unavailable", data: null }),
    ]);
    expect(await run("categories")).toBe(EXIT.api);
    expect(err[0]).toMatch(/^Categories are unavailable/);
  });

  it("validates offline and prints the payload", async () => {
    const { run, out, err, fetch } = harness();
    expect(await run("dry-run", SAMPLE)).toBe(EXIT.ok);
    expect(fetch).not.toHaveBeenCalled();
    expect(err).toEqual([`${SAMPLE} is valid.`]);
    const payload = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "draft",
      deviceTypeIds: [13],
      title: "Bridge Test Alle Modi",
    });
  });

  it("lists the problems of an invalid recipe", async () => {
    const file = join(dir, "invalid.json");
    const recipe = JSON.parse(await readFile(SAMPLE, "utf8")) as Record<string, unknown>;
    recipe.title = "";
    await writeFile(file, JSON.stringify(recipe));
    const { run, out, err } = harness();
    expect(await run("dry-run", file)).toBe(EXIT.invalidInput);
    expect(out).toEqual([]);
    expect(err).toEqual([`${file} has 1 problem(s):`, "  title: title must not be empty"]);
  });

  it("names unreadable and malformed recipe files", async () => {
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{");
    const { run, err } = harness();
    expect(await run("dry-run", join(dir, "missing.json"))).toBe(EXIT.invalidInput);
    expect(await run("dry-run", broken)).toBe(EXIT.invalidInput);
    expect(err).toEqual([
      expect.stringMatching(/^Cannot read the recipe file .*missing\.json \(ENOENT\)$/) as unknown,
      `${broken} is not valid JSON`,
    ]);
  });

  it("reports a broken device programs file", async () => {
    const { run, err } = harness({ DEVICE_PROGRAMS_PATH: join(dir, "nowhere.json") });
    expect(await run("dry-run", SAMPLE)).toBe(EXIT.api);
    expect(err[0]).toMatch(/^Cannot read the device programs file/);
  });

  it("creates a draft and saves it on the device", async () => {
    const { run, out, endpoints } = harness({ MC_COOKIE: COOKIE }, [
      json(200, await fixture("categories.json")),
      json(201, await fixture("recipe-create.json")),
      json(200, await fixture("recipe-status.json")),
    ]);
    expect(await run("create", SAMPLE, "--status", "private-publish")).toBe(EXIT.ok);
    expect(endpoints).toEqual([
      "GET api/v1/categories",
      "POST api/v3/auth/user/recipes/",
      "PATCH api/v3/auth/user/recipes/900002",
    ]);
    expect(out).toEqual([
      "Created recipe 900002 with status private-publish.",
      "Review it before cooking: https://www.monsieur-cuisine.com/de/create-recipe?devices=mc-smart&recipe-id=900002",
      "  - Testrezept: nicht kochen, nach der Prüfung löschen.",
    ]);
  });

  it("uploads the cover image before creating the draft", async () => {
    const photo = join(dir, "photo.webp");
    await writeFile(
      photo,
      await sharp({ create: { width: 64, height: 36, channels: 3, background: "#c83c14" } })
        .webp()
        .toBuffer(),
    );
    const { run, out, err, endpoints, fetch } = harness({ MC_COOKIE: COOKIE }, [
      json(200, await fixture("categories.json")),
      json(201, await fixture("media-upload-url-details.json")),
      new Response(null, { status: 200 }),
      json(201, await fixture("media-upload-url-thumbnail.json")),
      new Response(null, { status: 200 }),
      json(200, await fixture("media-ready.json")),
      json(201, await fixture("recipe-create.json")),
    ]);
    expect(await run("create", SAMPLE, "--image", photo)).toBe(EXIT.ok);
    expect(endpoints).toEqual([
      "GET api/v1/categories",
      "POST api/v1/media/image/upload-url",
      "PUT storage.example.com",
      "POST api/v1/media/image/upload-url",
      "PUT storage.example.com",
      "GET api/v1/media?ids[]=700002&ids[]=700001",
      "POST api/v3/auth/user/recipes/",
    ]);
    expect(err).toContain("Image uploaded: details 700002, thumbnail 700001");
    expect(out[0]).toBe("Created recipe 900002 with status draft.");
    const create = fetch.mock.calls[6]?.[1].body as string;
    const payload = (
      JSON.parse(create) as { payload: Record<string, { landscapeMediaId: number }> }
    ).payload;
    expect(payload.detailsImage?.landscapeMediaId).toBe(700002);
    expect(payload.thumbnail?.landscapeMediaId).toBe(700001);
  });

  it("refuses an image it cannot read", async () => {
    const notAnImage = join(dir, "photo.txt");
    await writeFile(notAnImage, "text");
    const { run, err } = harness({ MC_COOKIE: COOKIE }, [
      json(200, await fixture("categories.json")),
    ]);
    expect(await run("create", SAMPLE, "--image", notAnImage)).toBe(EXIT.invalidInput);
    expect(err).toContain("The image could not be decoded");
  });

  it("checks categories against the live catalog before creating", async () => {
    const file = join(dir, "unknown-category.json");
    const recipe = JSON.parse(await readFile(SAMPLE, "utf8")) as Record<string, unknown>;
    recipe.categoryIds = [999999];
    await writeFile(file, JSON.stringify(recipe));
    const { run, err, endpoints } = harness({ MC_COOKIE: COOKIE }, [
      json(200, await fixture("categories.json")),
    ]);
    expect(await run("create", file)).toBe(EXIT.invalidInput);
    expect(endpoints).toEqual(["GET api/v1/categories"]);
    expect(err[1]).toMatch(/^ {2}categoryIds\[0\]: category 999999 does not exist/);
  });

  it("refuses to publish", async () => {
    const { run, err, fetch } = harness({ MC_COOKIE: COOKIE });
    expect(await run("create", SAMPLE, "--status", "pending")).toBe(EXIT.usage);
    expect(err[0]).toBe("--status must be draft or private-publish, not pending");
    expect(fetch).not.toHaveBeenCalled();
  });
});
