import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testAssets, TEST_ASSET_FILES } from "../../testing/assets.js";
import { tempDir } from "../../testing/temp.js";
import { ASSET_NAMES, EMPTY_ASSETS, defaultAssetDir, isAssetPath, loadAssets } from "./assets.js";

describe("asset catalog", () => {
  it("maps the plain names to the hashed files of the manifest", () => {
    const { assets, cleanup } = testAssets();
    try {
      expect(assets.empty).toBe(false);
      for (const name of ASSET_NAMES) {
        const [file, content] = TEST_ASSET_FILES[name]!;
        expect(assets.url(name)).toBe(`/admin/assets/${file}`);
        expect(assets.get(file)?.body.toString()).toBe(content);
      }
      expect(assets.get("app.css")).toBeUndefined();
      expect(assets.get("manifest.json")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("is empty without a build and falls back to the plain names", () => {
    expect(loadAssets(null)).toBe(EMPTY_ASSETS);
    expect(EMPTY_ASSETS.url("app.css")).toBe("/admin/assets/app.css");
    const { dir, cleanup } = tempDir();
    try {
      expect(loadAssets(dir).empty).toBe(true);
      writeFileSync(join(dir, "manifest.json"), "not json");
      expect(loadAssets(dir).empty).toBe(true);
      writeFileSync(join(dir, "manifest.json"), "null");
      expect(loadAssets(dir).empty).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("refuses manifest entries that leave the directory, have no known type or are missing", () => {
    const { dir, cleanup } = tempDir();
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "x.css"), "x");
      writeFileSync(join(dir, "app.1.js"), "js");
      writeFileSync(join(dir, "page.html"), "<html>");
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
          "app.css": "sub/x.css",
          "app.js": "app.1.js",
          "favicon.svg": "../outside.svg",
          "favicon-32.png": "page.html",
          "apple-touch-icon.png": "missing.png",
          "inter-latin.woff2": 7,
        }),
      );
      const assets = loadAssets(dir);
      expect(assets.url("app.js")).toBe("/admin/assets/app.1.js");
      expect(assets.url("app.css")).toBe("/admin/assets/app.css");
      expect(assets.url("favicon.svg")).toBe("/admin/assets/favicon.svg");
      expect(assets.get("page.html")).toBeUndefined();
      expect(assets.get("missing.png")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("finds the build next to the code or in the repository", () => {
    const dir = defaultAssetDir();
    expect(dir === null || dir.replace(/\\/g, "/").endsWith("dist/assets/")).toBe(true);
  });

  it("treats only one plain file name below the prefix as an asset path", () => {
    expect(isAssetPath("/admin/assets/app.0123456789.css")).toBe(true);
    for (const path of [
      "/admin/assets/",
      "/admin/assets/..",
      "/admin/assets/.hidden",
      "/admin/assets/a/b",
      "/admin/assets/a%2Fb",
      "/admin/assetsx",
      "/admin/jobs",
    ]) {
      expect(isAssetPath(path), path).toBe(false);
    }
  });
});
