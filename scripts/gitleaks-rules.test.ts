// Proves that the custom rules in .gitleaks.toml fire on the synthetic leaks in
// test/fixtures/gitleaks/leaks.txt and stay quiet on the placeholders next to them. The
// fixtures are allowlisted for the history scan; the test removes that allowlist and runs
// `gitleaks detect --no-git` on a copy.
//
// Needs the gitleaks binary: GITLEAKS_BIN, gitleaks on the PATH, or local/.tools/gitleaks.
// Without one the test is skipped, unless GITLEAKS_REQUIRED=1 (CI).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/testing/temp.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(root, "test", "fixtures", "gitleaks", "leaks.txt");

function findGitleaks(): string | null {
  const candidates = [
    process.env.GITLEAKS_BIN,
    "gitleaks",
    join(root, "local", ".tools", "gitleaks", "gitleaks.exe"),
    join(root, "local", ".tools", "gitleaks", "gitleaks"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const gitleaks = findGitleaks();
if (gitleaks === null && process.env.GITLEAKS_REQUIRED === "1") {
  throw new Error("GITLEAKS_REQUIRED=1, but no gitleaks binary was found");
}

// The fixture lines (1-based) and the custom rule each must trigger.
const EXPECTED: ReadonlyArray<[number, string]> = [
  [1, "mc-smtp-url-credentials"],
  [2, "mc-smtp-url-credentials"],
  [3, "mc-wordpress-cookie-name"],
  [4, "mc-env-secret"],
  [5, "mc-env-secret"],
  [6, "mc-env-secret"],
  [7, "mc-env-secret"],
  [8, "mc-env-secret"],
  [9, "mc-env-secret"],
];
// Lines with example hosts, empty values, substitutions and placeholders.
const QUIET_LINES = [10, 11, 12, 13, 14, 15, 16];
const CUSTOM = /^mc-/;

interface Finding {
  RuleID: string;
  StartLine: number;
}

function scan(): Finding[] {
  const temp = tempDir();
  try {
    const config = readFileSync(join(root, ".gitleaks.toml"), "utf8");
    const start = config.indexOf("# fixtures-allowlist:start");
    const end = config.indexOf("# fixtures-allowlist:end");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const withoutAllowlist = config.slice(0, start) + config.slice(end);
    writeFileSync(join(temp.dir, "gitleaks.toml"), withoutAllowlist);
    const source = join(temp.dir, "source");
    mkdirSync(source);
    copyFileSync(FIXTURE, join(source, "leaks.txt"));
    const report = join(temp.dir, "report.json");
    const result = spawnSync(
      gitleaks ?? "gitleaks",
      [
        "detect",
        "--no-git",
        "--no-banner",
        "--source",
        source,
        "--config",
        join(temp.dir, "gitleaks.toml"),
        "--report-format",
        "json",
        "--report-path",
        report,
        "--exit-code",
        "0",
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(report)).toBe(true);
    return JSON.parse(readFileSync(report, "utf8")) as Finding[];
  } finally {
    temp.cleanup();
  }
}

describe.skipIf(gitleaks === null)("gitleaks rules", () => {
  it("fire on every synthetic leak and stay quiet on placeholders", () => {
    const findings = scan().filter((finding) => CUSTOM.test(finding.RuleID));
    for (const [line, rule] of EXPECTED) {
      expect(
        findings.some((finding) => finding.StartLine === line && finding.RuleID === rule),
        `line ${line}: ${rule}`,
      ).toBe(true);
    }
    const noisy = findings.filter((finding) => QUIET_LINES.includes(finding.StartLine));
    expect(noisy).toEqual([]);
  });
});
