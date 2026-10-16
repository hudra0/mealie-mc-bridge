// A small build of the admin assets in a temp directory, so page tests do not depend on
// `npm run build`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssets, type AssetCatalog } from "../service/ui/assets.js";
import { tempDir } from "./temp.js";

export const TEST_ASSET_FILES: Readonly<Record<string, readonly [string, string]>> = {
  "app.css": ["app.0123456789.css", "body{color:red}"],
  "app.js": ["app.abcdef0123.js", "console.log(1);"],
  "inter-latin.woff2": ["inter-latin.1111111111.woff2", "wOF2"],
  "inter-latin-ext.woff2": ["inter-latin-ext.2222222222.woff2", "wOF2"],
  "favicon.svg": ["favicon.3333333333.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>"],
  "favicon-32.png": ["favicon-32.4444444444.png", "PNG"],
  "apple-touch-icon.png": ["apple-touch-icon.5555555555.png", "PNG"],
};

export function testAssets(): { assets: AssetCatalog; dir: string; cleanup: () => void } {
  const { dir, cleanup } = tempDir();
  const out = join(dir, "assets");
  mkdirSync(out);
  const manifest: Record<string, string> = {};
  for (const [name, [file, content]] of Object.entries(TEST_ASSET_FILES)) {
    manifest[name] = file;
    writeFileSync(join(out, file), content);
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
  return { assets: loadAssets(out), dir: out, cleanup };
}
