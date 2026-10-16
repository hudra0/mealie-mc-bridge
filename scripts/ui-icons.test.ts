import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generate, ICON_NAMES, innerSvg } from "./ui-icons.js";

describe("icon subset", () => {
  it("takes the children of the SVG element on one line", () => {
    expect(
      innerSvg('<!-- c -->\n<svg\n  a="1"\n>\n  <path d="M1 2" />\n  <circle r="2" />\n</svg>\n'),
    ).toBe('<path d="M1 2"/><circle r="2"/>');
    expect(() => innerSvg("<div></div>")).toThrow("not an SVG document");
  });

  it("matches the committed file, so a new name needs npm run ui:icons", () => {
    const require = createRequire(import.meta.url);
    const dir = path.join(path.dirname(require.resolve("lucide-static/package.json")), "icons");
    const generated = generate((name) => readFileSync(path.join(dir, `${name}.svg`), "utf8"));
    const committed = readFileSync(
      new URL("../src/service/ui/icons.generated.ts", import.meta.url),
      "utf8",
    );
    expect(committed.replace(/\r\n/g, "\n")).toBe(generated);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });
});
