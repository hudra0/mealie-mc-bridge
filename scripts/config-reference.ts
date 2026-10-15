// The configuration reference: one Markdown table row per environment variable, built from
// the zod schema in src/config.ts and the descriptions in src/config-reference.ts (which
// the admin settings page shows as well). README.md carries the table between two markers,
// and config-reference.test.ts fails when the two drift apart.
//
// Run: npm run docs:config                        rewrite the table in README.md
//      npx tsx scripts/config-reference.ts         print the table
//      npx tsx scripts/config-reference.ts --check exit 1 when README.md is out of date

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { referenceRows } from "../src/config-reference.js";

export { referenceRows, type ReferenceName } from "../src/config-reference.js";

export const README_START = "<!-- config-reference:start -->";
export const README_END = "<!-- config-reference:end -->";

export const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));

const HEADER = ["Variable", "Default", "Values", "Description"];

function row(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
}

// The table as Prettier formats it, so it compares equal to the formatted README.
export async function referenceTable(): Promise<string> {
  const lines = [row(HEADER), row(HEADER.map(() => "---")), ...referenceRows().map(row)];
  const formatted = await prettier.format(`${lines.join("\n")}\n`, {
    ...(await prettier.resolveConfig(readmePath)),
    parser: "markdown",
  });
  return formatted.trimEnd();
}

// The table between the markers, or null when a marker is missing.
export function readmeTable(readme: string): string | null {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) return null;
  return readme.slice(start + README_START.length, end).trim();
}

export function replaceReadmeTable(readme: string, table: string): string {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md needs the markers ${README_START} and ${README_END}`);
  }
  return `${readme.slice(0, start + README_START.length)}\n\n${table}\n\n${readme.slice(end)}`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv;
  if (rest.length > 0 || (mode !== undefined && mode !== "--check" && mode !== "--write")) {
    console.error("usage: tsx scripts/config-reference.ts [--check | --write]");
    return 64;
  }
  const table = await referenceTable();
  if (mode === undefined) {
    console.log(table);
    return 0;
  }
  const readme = readFileSync(readmePath, "utf8");
  if (mode === "--check") {
    if (readmeTable(readme) === table) {
      console.log(`README.md lists all ${referenceRows().length} variables.`);
      return 0;
    }
    console.error("The configuration table in README.md is out of date. Run npm run docs:config.");
    return 1;
  }
  writeFileSync(readmePath, replaceReadmeTable(readme, table));
  console.log(`README.md: wrote ${referenceRows().length} variables.`);
  return 0;
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
