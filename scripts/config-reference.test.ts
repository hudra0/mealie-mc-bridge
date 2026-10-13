import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVICE_REQUIRED, settingsSchema } from "../src/config.js";
import {
  README_END,
  README_START,
  readmePath,
  readmeTable,
  referenceRows,
  referenceTable,
  replaceReadmeTable,
} from "./config-reference.js";

const names = () => referenceRows().map(([cell]) => cell?.replaceAll("`", ""));

describe("configuration reference", () => {
  it("has one row per setting of the schema, plus TZ and NODE_ENV", () => {
    const settings = Object.keys(settingsSchema.shape);
    expect(names()).toEqual(expect.arrayContaining([...settings, "TZ", "NODE_ENV"]));
    expect(names()).toHaveLength(settings.length + 2);
  });

  it("marks the settings the service cannot start without as required", () => {
    for (const row of referenceRows()) {
      const name = row[0]?.replaceAll("`", "") ?? "";
      const required = (SERVICE_REQUIRED as readonly string[]).includes(name);
      expect(row[1] === "**required**", name).toBe(required);
    }
  });

  it("takes defaults and allowed values from the schema", () => {
    const byName = new Map(referenceRows().map((row) => [row[0], row]));
    expect(byName.get("`PORT`")?.slice(1, 3)).toEqual(["`3000`", "integer 1 to 65535"]);
    expect(byName.get("`MC_RECIPE_STATUS`")?.slice(1, 3)).toEqual([
      "`private-publish`",
      "`draft`, `private-publish`",
    ]);
    expect(byName.get("`WORKER_POLL_SECONDS`")?.[2]).toBe("number above 0 to 60");
    expect(byName.get("`MC_COOKIE`")?.[1]).toBe("unset");
  });

  it("matches the table in README.md (run npm run docs:config after changing a setting)", async () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readmeTable(readme)).toBe(await referenceTable());
  });
});

describe("replaceReadmeTable", () => {
  it("replaces only the text between the markers", () => {
    const readme = `# Title\n\n${README_START}\nold\n${README_END}\n\nrest\n`;
    const updated = replaceReadmeTable(readme, "| a |");
    expect(updated).toBe(`# Title\n\n${README_START}\n\n| a |\n\n${README_END}\n\nrest\n`);
    expect(readmeTable(updated)).toBe("| a |");
  });

  it("refuses a README without markers", () => {
    expect(readmeTable("# Title\n")).toBeNull();
    expect(() => replaceReadmeTable("# Title\n", "| a |")).toThrow(/markers/);
  });
});

describe(".env.example", () => {
  it("lists every setting of the schema, set or commented out", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const listed = new Set(
      [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
    );
    const missing = Object.keys(settingsSchema.shape).filter((name) => !listed.has(name));
    expect(missing).toEqual([]);
  });
});
