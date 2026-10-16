// The static files of the admin pages, built by scripts/build-assets.ts into dist/assets:
// stylesheet, script, font and icons, each under a name with a hash of its content. The
// catalog reads manifest.json and keeps the files in memory (together well under 1 MB),
// so serving one is a map lookup and nothing outside the manifest can be requested.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ASSET_NAMES = [
  "app.css",
  "app.js",
  "inter-latin.woff2",
  "inter-latin-ext.woff2",
  "favicon.svg",
  "favicon-32.png",
  "apple-touch-icon.png",
] as const;

export type AssetName = (typeof ASSET_NAMES)[number];

export const ASSET_PREFIX = "/admin/assets/";

// /admin/assets/<file name>, the file name without a slash or "..".
export function isAssetPath(path: string): boolean {
  const name = path.startsWith(ASSET_PREFIX) ? path.slice(ASSET_PREFIX.length) : "";
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export interface AssetFile {
  type: string;
  body: Buffer;
}

export class AssetCatalog {
  readonly #urls: ReadonlyMap<string, string>;
  readonly #files: ReadonlyMap<string, AssetFile>;

  constructor(urls: ReadonlyMap<string, string>, files: ReadonlyMap<string, AssetFile>) {
    this.#urls = urls;
    this.#files = files;
  }

  // The URL of an asset: its hashed name, or the plain one when the build is missing.
  url(name: AssetName): string {
    return `${ASSET_PREFIX}${this.#urls.get(name) ?? name}`;
  }

  // The file behind a hashed name; undefined for anything the manifest does not list.
  get(file: string): AssetFile | undefined {
    return this.#files.get(file);
  }

  get empty(): boolean {
    return this.#files.size === 0;
  }
}

export const EMPTY_ASSETS = new AssetCatalog(new Map(), new Map());

// dist/assets next to the compiled code, or the one of the repository when the service runs
// from src (npm run dev, tests); null when neither has been built.
export function defaultAssetDir(): string | null {
  const candidates = [
    fileURLToPath(new URL("../../assets/", import.meta.url)),
    fileURLToPath(new URL("../../../dist/assets/", import.meta.url)),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "manifest.json"))) ?? null;
}

// Reads the manifest and every file it names. A missing or broken build gives an empty
// catalog: the pages still work, unstyled.
export function loadAssets(dir: string | null = defaultAssetDir()): AssetCatalog {
  if (dir === null) return EMPTY_ASSETS;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return EMPTY_ASSETS;
  }
  if (manifest === null || typeof manifest !== "object") return EMPTY_ASSETS;
  const urls = new Map<string, string>();
  const files = new Map<string, AssetFile>();
  for (const name of ASSET_NAMES) {
    const file = (manifest as Record<string, unknown>)[name];
    // Plain file names only: no directories, nothing that climbs out of dir.
    if (typeof file !== "string" || !/^[\w.-]+$/.test(file) || file.startsWith(".")) continue;
    const type = CONTENT_TYPES[path.extname(file)];
    if (!type) continue;
    try {
      files.set(file, { type, body: readFileSync(path.join(dir, file)) });
      urls.set(name, file);
    } catch {
      // A file listed but missing stays out; its URL falls back to the plain name.
    }
  }
  return new AssetCatalog(urls, files);
}
