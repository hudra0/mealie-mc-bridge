import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { tempDir } from "../testing/temp.js";
import {
  INGREDIENT_CATALOG_FILE,
  IngredientCatalogError,
  createIngredientCatalog,
  loadConfiguredCatalog,
  loadIngredientCatalog,
  lookupCatalog,
  normalizeIngredientName,
  parseIngredientCatalog,
  type IngredientCatalogFile,
} from "./catalog.js";

const entry = (name: string, systemIngredientId: number) => ({
  name,
  systemIngredientId,
  officialRecipes: 1,
  memberRecipes: 0,
  category: null,
  alternatives: [],
});

const file: IngredientCatalogFile = {
  generatedFrom: "test",
  entries: [
    entry("Testzutat A", 9001),
    entry("Mehl (Type 405)", 9002),
    entry("Crème fraîche", 9003),
    entry("testzutat a", 9999),
  ],
};

describe("normalizeIngredientName", () => {
  it("trims and collapses whitespace, tabs and no-break spaces included", () => {
    expect(normalizeIngredientName("  Testzutat \t  A  ")).toBe("testzutat a");
  });

  it("ignores case", () => {
    expect(normalizeIngredientName("ZWIEBELN")).toBe(normalizeIngredientName("Zwiebeln"));
    expect(normalizeIngredientName("ÄPFEL")).toBe("äpfel");
  });

  it("compares composed and decomposed umlauts alike", () => {
    const decomposed = "Crème fraîche";
    expect(normalizeIngredientName(decomposed)).toBe(normalizeIngredientName("Crème fraîche"));
  });

  it("keeps punctuation and qualifiers", () => {
    expect(normalizeIngredientName("Mehl (Type 405)")).toBe("mehl (type 405)");
    expect(normalizeIngredientName("Mehl Type 405")).not.toBe(
      normalizeIngredientName("Mehl (Type 405)"),
    );
    expect(normalizeIngredientName("Sahne (30 % Fett)")).toBe("sahne (30 % fett)");
    expect(normalizeIngredientName("Pfeffer, schwarz")).toBe("pfeffer, schwarz");
  });
});

describe("lookupCatalog", () => {
  const catalog = createIngredientCatalog(file);

  it("finds names that are equal after normalization", () => {
    expect(lookupCatalog(catalog, "Testzutat A")).toBe(9001);
    expect(lookupCatalog(catalog, " testzutat  a ")).toBe(9001);
    expect(lookupCatalog(catalog, "MEHL (TYPE 405)")).toBe(9002);
    expect(lookupCatalog(catalog, "Crème fraîche")).toBe(9003);
  });

  it("matches exactly, never in part", () => {
    expect(lookupCatalog(catalog, "Testzutat")).toBeNull();
    expect(lookupCatalog(catalog, "Testzutat A, gehackt")).toBeNull();
    expect(lookupCatalog(catalog, "Mehl")).toBeNull();
    expect(lookupCatalog(catalog, "Mehl Type 405")).toBeNull();
    expect(lookupCatalog(catalog, "")).toBeNull();
  });

  it("keeps the first of two entries with the same normalized name", () => {
    expect(catalog.byName.size).toBe(3);
    expect(catalog.entries).toHaveLength(4);
  });
});

describe("parseIngredientCatalog", () => {
  it("rejects a file that does not match the schema", () => {
    expect(() => parseIngredientCatalog({ entries: [] })).toThrow(IngredientCatalogError);
    expect(() =>
      parseIngredientCatalog({ generatedFrom: "x", entries: [entry("A", -1)] }, "file.json"),
    ).toThrow(/file\.json is not a valid ingredient catalog \(entries\.0\.systemIngredientId/);
  });
});

describe("loadIngredientCatalog", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("reads and indexes the file in a directory", async () => {
    const temp = tempDir();
    cleanup = temp.cleanup;
    writeFileSync(join(temp.dir, INGREDIENT_CATALOG_FILE), JSON.stringify(file));
    const catalog = await loadIngredientCatalog(temp.dir);
    expect(lookupCatalog(catalog, "testzutat a")).toBe(9001);
    expect(catalog.generatedFrom).toBe("test");
  });

  it("names the file it cannot read or parse", async () => {
    const temp = tempDir();
    cleanup = temp.cleanup;
    await expect(loadIngredientCatalog(join(temp.dir, "missing"))).rejects.toThrow(
      /Cannot read the ingredient catalog .*ingredient-catalog\.json/,
    );
    mkdirSync(join(temp.dir, "broken"));
    writeFileSync(join(temp.dir, "broken", INGREDIENT_CATALOG_FILE), "{");
    await expect(loadIngredientCatalog(join(temp.dir, "broken"))).rejects.toThrow(
      IngredientCatalogError,
    );
  });

  it("loads the committed catalog", async () => {
    const catalog = await loadIngredientCatalog(
      fileURLToPath(new URL("../../knowledge", import.meta.url)),
    );
    expect(catalog.entries.length).toBeGreaterThan(1000);
    expect(catalog.byName.size).toBe(catalog.entries.length);
  });
});

describe("loadConfiguredCatalog", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("reads the catalog from KNOWLEDGE_DIR", async () => {
    const temp = tempDir();
    cleanup = temp.cleanup;
    writeFileSync(join(temp.dir, INGREDIENT_CATALOG_FILE), JSON.stringify(file));
    const catalog = await loadConfiguredCatalog(loadConfig({ KNOWLEDGE_DIR: temp.dir }));
    expect(catalog && lookupCatalog(catalog, "Testzutat A")).toBe(9001);
  });

  it("fails when exact mode finds no catalog in KNOWLEDGE_DIR", async () => {
    const temp = tempDir();
    cleanup = temp.cleanup;
    await expect(
      loadConfiguredCatalog(
        loadConfig({ KNOWLEDGE_DIR: temp.dir, MC_RESOLVE_INGREDIENTS: "exact" }),
      ),
    ).rejects.toThrow(IngredientCatalogError);
  });

  it("loads nothing when resolution is off", async () => {
    const config = loadConfig({ KNOWLEDGE_DIR: "/nonexistent", MC_RESOLVE_INGREDIENTS: "off" });
    await expect(loadConfiguredCatalog(config)).resolves.toBeNull();
  });
});
