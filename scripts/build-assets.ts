// Builds the static files of the admin pages into dist/assets: the stylesheet compiled with
// Tailwind CSS from src/service/ui/app.css, the script src/service/ui/client/app.js, the
// Inter font and the app icons drawn from src/service/ui/logo.ts. Each file gets a hash of
// its content in its name, so the server can let browsers keep it for a year, and
// manifest.json maps the plain names to the hashed ones (src/service/ui/assets.ts).
//
// Run: npm run build:assets (part of npm run build), or npm run ui:watch while working on
// the pages, next to npm run dev.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import sharp from "sharp";
import { logoSvg } from "../src/service/ui/logo.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const uiDir = path.join(root, "src", "service", "ui");
export const DEFAULT_OUT_DIR = path.join(root, "dist", "assets");

// "app.css" with content -> "app.<10 hex digits>.css".
export function hashedName(name: string, content: Buffer | string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const dot = name.indexOf(".");
  return dot < 0 ? `${name}.${hash}` : `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
}

// The stylesheet with the utilities the templates use, minified.
export async function buildCss(file = path.join(uiDir, "app.css")): Promise<string> {
  const base = path.dirname(file);
  const compiler = await compile(readFileSync(file, "utf8"), { base, onDependency: () => {} });
  const scanner = new Scanner({
    sources: compiler.sources.map((source) => ({ ...source, base: source.base || base })),
  });
  const css = compiler.build(scanner.scan());
  return optimize(css, { minify: true }).code;
}

function fontFile(name: string): Buffer {
  const require = createRequire(import.meta.url);
  const dir = path.dirname(require.resolve("@fontsource-variable/inter/package.json"));
  return readFileSync(path.join(dir, "files", name));
}

export async function buildAssets(outDir = DEFAULT_OUT_DIR): Promise<Record<string, string>> {
  const files = new Map<string, Buffer>([
    ["inter-latin.woff2", fontFile("inter-latin-wght-normal.woff2")],
    ["inter-latin-ext.woff2", fontFile("inter-latin-ext-wght-normal.woff2")],
    ["favicon.svg", Buffer.from(logoSvg())],
    [
      "favicon-32.png",
      await sharp(Buffer.from(logoSvg({ size: 32 })))
        .png()
        .toBuffer(),
    ],
    [
      "apple-touch-icon.png",
      await sharp(Buffer.from(logoSvg({ size: 180, fullBleed: true })))
        .png()
        .toBuffer(),
    ],
    ["app.js", readFileSync(path.join(uiDir, "client", "app.js"))],
  ]);
  const manifest: Record<string, string> = {};
  for (const [name, content] of files) manifest[name] = hashedName(name, content);

  // The stylesheet names the fonts by their plain path; it gets the hashed ones.
  let css = await buildCss();
  for (const name of ["inter-latin.woff2", "inter-latin-ext.woff2"]) {
    css = css.split(`/admin/assets/${name}`).join(`/admin/assets/${manifest[name]}`);
  }
  files.set("app.css", Buffer.from(css));
  manifest["app.css"] = hashedName("app.css", css);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of files) writeFileSync(path.join(outDir, manifest[name]!), content);
  writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function run(): Promise<void> {
  const once = async () => {
    const started = Date.now();
    const manifest = await buildAssets();
    console.log(
      `assets: ${Object.keys(manifest).length} files in ${path.relative(root, DEFAULT_OUT_DIR)} (${Date.now() - started} ms)`,
    );
  };
  await once();
  if (!process.argv.includes("--watch")) return;
  let timer: NodeJS.Timeout | undefined;
  watch(path.join(root, "src", "service"), { recursive: true }, (_event, file) => {
    if (!file || /\.test\.ts$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      once().catch((error: unknown) => console.error(error));
    }, 150);
  });
  console.log("watching src/service for changes");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
