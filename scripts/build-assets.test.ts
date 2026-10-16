import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/testing/temp.js";
import { buildAssets, buildCss, hashedName } from "./build-assets.js";

describe("hashedName", () => {
  it("puts a hash of the content before the extension", () => {
    expect(hashedName("app.css", "x")).toMatch(/^app\.[0-9a-f]{10}\.css$/);
    expect(hashedName("app.css", "x")).toBe(hashedName("app.css", "x"));
    expect(hashedName("app.css", "y")).not.toBe(hashedName("app.css", "x"));
    expect(hashedName("inter-latin.woff2", "x")).toMatch(/^inter-latin\.[0-9a-f]{10}\.woff2$/);
    expect(hashedName("LICENSE", "x")).toMatch(/^LICENSE\.[0-9a-f]{10}$/);
  });
});

describe("asset build", () => {
  it("compiles the utilities the templates use and both themes", async () => {
    const css = await buildCss();
    for (const token of [
      ".grid{display:grid}",
      ".skip-link",
      "dialog.modal",
      "[data-theme=dark]",
    ]) {
      expect(css, token).toContain(token);
    }
    expect(css).toContain("prefers-color-scheme:dark");
    // Classes that only test files mention stay out (src/service/ui/components.test.ts).
    expect(css).not.toContain("17deg");
  });

  it("writes hashed files and a manifest the server can read", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const out = join(dir, "assets");
      const manifest = await buildAssets(out);
      expect(Object.keys(manifest).sort()).toEqual(
        [
          "app.css",
          "app.js",
          "apple-touch-icon.png",
          "favicon-32.png",
          "favicon.svg",
          "inter-latin-ext.woff2",
          "inter-latin.woff2",
        ].sort(),
      );
      const files = readdirSync(out).sort();
      expect(files).toEqual([...Object.values(manifest), "manifest.json"].sort());
      const css = readFileSync(join(out, manifest["app.css"]!), "utf8");
      expect(css).toContain(`/admin/assets/${manifest["inter-latin.woff2"]}`);
      expect(css).not.toContain("/admin/assets/inter-latin.woff2");
      expect(readFileSync(join(out, manifest["favicon-32.png"]!)).subarray(1, 4).toString()).toBe(
        "PNG",
      );
      expect(readFileSync(join(out, manifest["app.js"]!), "utf8")).toContain('"use strict"');
    } finally {
      cleanup();
    }
  });
});
