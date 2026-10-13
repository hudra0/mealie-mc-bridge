// Gentle crawler for the public Monsieur Cuisine recipe API (no login needed).
//
// Output: $CORPUS_DIR/index.jsonl          one recipe summary per line (all pages)
//         $CORPUS_DIR/details/<id>.json    one recipe detail per file
//         $CORPUS_DIR/crawl.log            progress and failures
// Default CORPUS_DIR: local/corpus for de-DE, local/corpus/<locale> for every other locale
// (gitignored). The recipes are copyrighted: keep the raw crawl private. Only derived
// numbers and rules in your own words belong in knowledge/.
//
// The crawler sends one request per second (DELAY_MS, never below 1000), backs off on HTTP 429
// and 5xx, and resumes: a finished index is reused and details already on disk are skipped.
// An interrupted index crawl restarts from page 1 (index.jsonl.partial).
//
// Environment: CORPUS_DIR, DEVICE (default MC3.0, the Monsieur Cuisine smart),
//              LOCALE (default de-DE), DELAY_MS (default 1000).
// Run: npm run corpus:crawl   (about 40 minutes for 2,200 recipes)
//      npm run corpus:crawl -- --locale en-US   (--locale wins over LOCALE)

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCorpusArgs } from "./locale.js";

export const API_BASE = "https://mc-api.tecpal.com";
// The website sends this fixed value with every API call.
const CDN_BYPASS = "cd844315-77c4-46ba-83fe-7702d13b12b2";
export const MIN_DELAY_MS = 1000;

export interface CrawlOptions {
  corpusDir: string;
  device: string;
  locale: string;
  delayMs: number;
}

export function parseOptions(
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): CrawlOptions {
  const delay = env.DELAY_MS === undefined ? MIN_DELAY_MS : Number(env.DELAY_MS);
  if (!Number.isFinite(delay)) throw new Error(`DELAY_MS is not a number: ${env.DELAY_MS}`);
  if (delay < MIN_DELAY_MS)
    throw new Error(`DELAY_MS must be at least ${MIN_DELAY_MS}, got ${delay}`);
  const args = parseCorpusArgs(argv, env, env.LOCALE ?? "de-DE");
  if (args.rest.length > 0) throw new Error(`unknown argument: ${args.rest.join(" ")}`);
  return {
    corpusDir: args.corpusDir,
    device: env.DEVICE ?? "MC3.0",
    locale: args.locale,
    delayMs: delay,
  };
}

const envelopeSchema = z.looseObject({
  code: z.number(),
  message: z.unknown().optional(),
  data: z.unknown(),
});
const idSchema = z.looseObject({ id: z.number() });
export const indexPageSchema = z.looseObject({
  total: z.number(),
  totalPage: z.number(),
  recipes: z.array(z.unknown()),
});

export function requestHeaders(locale: string): Record<string, string> {
  return {
    "X-Request-ID": randomUUID(),
    "x-bypass-cdn": CDN_BYPASS,
    "device-type": "web",
    "Accept-Language": locale,
    "User-Agent": "Mozilla/5.0",
  };
}

/** The `data` of an API response, or an error naming the status and the API's code. */
export function unwrap(status: number, body: unknown, url: string): unknown {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) throw new Error(`HTTP ${status}, unexpected response body: ${url}`);
  const envelope = parsed.data;
  if (status !== 200 || envelope.code !== 0) {
    const message = typeof envelope.message === "string" ? ` ${envelope.message}` : "";
    throw new Error(`HTTP ${status} code ${envelope.code}${message}: ${url}`);
  }
  return envelope.data;
}

export function indexUrl(page: number, device: string): string {
  return `${API_BASE}/api/v2/recipes/page/${page}?filters[deviceTypes][]=${encodeURIComponent(device)}`;
}

export function detailUrl(id: number): string {
  return `${API_BASE}/api/v2/recipes/${id}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function crawl(options: CrawlOptions): Promise<{ fetched: number; failed: number }> {
  const detailsDir = path.join(options.corpusDir, "details");
  const indexFile = path.join(options.corpusDir, "index.jsonl");
  const partialFile = `${indexFile}.partial`;
  const logFile = path.join(options.corpusDir, "crawl.log");
  mkdirSync(detailsDir, { recursive: true });

  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    appendFileSync(logFile, line + "\n");
  };

  async function get(url: string, attempt = 1): Promise<unknown> {
    const res = await fetch(url, { headers: requestHeaders(options.locale) });
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 4) throw new Error(`HTTP ${res.status} after ${attempt} attempts: ${url}`);
      log(`HTTP ${res.status} on ${url}, backing off ${30 * attempt}s`);
      await sleep(30_000 * attempt);
      return get(url, attempt + 1);
    }
    return unwrap(res.status, await res.json(), url);
  }

  // 1. index
  const ids = new Set<number>();
  if (existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, "utf8").split("\n"))
      if (line.trim()) ids.add(idSchema.parse(JSON.parse(line)).id);
    log(`index loaded: ${ids.size} ids`);
  } else {
    rmSync(partialFile, { force: true });
    let page = 1;
    let totalPage = 1;
    do {
      const data = indexPageSchema.parse(await get(indexUrl(page, options.device)));
      totalPage = data.totalPage;
      // Keep each summary exactly as the API sent it; only the id is checked.
      for (const raw of data.recipes) {
        const { id } = idSchema.parse(raw);
        if (!ids.has(id)) {
          ids.add(id);
          appendFileSync(partialFile, JSON.stringify(raw) + "\n");
        }
      }
      if (page % 10 === 0 || page === totalPage)
        log(`index page ${page}/${totalPage}, ${ids.size} ids (total reported ${data.total})`);
      page++;
      await sleep(options.delayMs);
    } while (page <= totalPage);
    renameSync(partialFile, indexFile);
  }

  // 2. details
  const have = new Set(
    readdirSync(detailsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => Number(f.slice(0, -5))),
  );
  const todo = [...ids].filter((id) => !have.has(id));
  log(`details: ${have.size} present, ${todo.length} to fetch`);
  let fetched = 0;
  let failed = 0;
  for (const id of todo) {
    try {
      const data = await get(detailUrl(id));
      writeFileSync(path.join(detailsDir, `${id}.json`), JSON.stringify(data));
      fetched++;
    } catch (e) {
      failed++;
      log(`FAIL ${id}: ${(e as Error).message}`);
    }
    if ((fetched + failed) % 50 === 0)
      log(`details progress ${fetched + failed}/${todo.length} (failed ${failed})`);
    await sleep(options.delayMs);
  }
  log(`finished: ${fetched} fetched, ${failed} failed, ${have.size + fetched} total on disk`);
  return { fetched, failed };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || norm(entry) === norm(self.replace(/\.ts$/, ""));
}

if (isMain()) {
  let options: CrawlOptions;
  try {
    options = parseOptions(process.env, process.argv.slice(2));
  } catch (e) {
    console.error(`corpus:crawl: ${(e as Error).message}`);
    process.exit(2);
  }
  const { failed } = await crawl(options);
  process.exitCode = failed ? 1 : 0;
}
