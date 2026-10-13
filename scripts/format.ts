// Runs Prettier over the files git knows about: tracked files plus untracked files that no
// ignore rule hides (.gitignore, .git/info/exclude, the global excludes file). Files a
// contributor keeps out of git locally are skipped without being named in committed config.
// .prettierignore still applies, and files without a Prettier parser are left alone.
//
// Run: npm run format        (tsx scripts/format.ts --write)
//      npm run format:check  (tsx scripts/format.ts --check, also used by CI)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

export type Mode = "--check" | "--write";

export function parseMode(argv: readonly string[]): Mode {
  const [mode, ...rest] = argv;
  if ((mode === "--check" || mode === "--write") && rest.length === 0) return mode;
  throw new Error("usage: tsx scripts/format.ts --check | --write");
}

/** Tracked and untracked-but-not-ignored files that exist on disk, relative to the repo root. */
export function gitFiles(cwd = process.cwd()): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\0")
    .filter((f) => f !== "" && existsSync(path.join(cwd, f)))
    .sort();
}

export async function run(mode: Mode, cwd = process.cwd()): Promise<number> {
  const ignorePath = path.join(cwd, ".prettierignore");
  const changed: string[] = [];
  let seen = 0;
  for (const rel of gitFiles(cwd)) {
    const file = path.join(cwd, rel);
    const info = await prettier.getFileInfo(file, { ignorePath });
    if (info.ignored || info.inferredParser === null) continue;
    seen++;
    const source = readFileSync(file, "utf8");
    const options = { ...(await prettier.resolveConfig(file)), filepath: file };
    if (mode === "--check") {
      if (!(await prettier.check(source, options))) changed.push(rel);
      continue;
    }
    const formatted = await prettier.format(source, options);
    if (formatted !== source) {
      writeFileSync(file, formatted);
      changed.push(rel);
    }
  }
  if (mode === "--check") {
    for (const f of changed) console.warn(`[warn] ${f}`);
    console.log(
      changed.length
        ? `Code style issues in ${changed.length} of ${seen} files. Run npm run format to fix.`
        : `All ${seen} files use Prettier code style.`,
    );
    return changed.length ? 1 : 0;
  }
  for (const f of changed) console.log(`formatted ${f}`);
  console.log(`${changed.length} of ${seen} files changed.`);
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || norm(entry) === norm(self.replace(/\.ts$/, ""));
}

if (isMain()) {
  let mode: Mode;
  try {
    mode = parseMode(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  process.exitCode = await run(mode);
}
