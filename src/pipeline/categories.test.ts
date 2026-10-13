import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McSessionError, type McCategory } from "../mc/index.js";
import { tempStore, type TempStore } from "../testing/temp.js";
import {
  CATEGORY_CACHE_KEY,
  categoryHints,
  loadCategories,
  matchCategories,
  mergeCategoryIds,
  namesMatch,
} from "./categories.js";

// The live catalog as recorded in the fixture.
const catalog = (
  JSON.parse(
    readFileSync(new URL("../../test/fixtures/mc/categories.json", import.meta.url), "utf8"),
  ) as { data: { categories: McCategory[] } }
).data.categories;

let store: TempStore;
afterEach(() => store?.dispose());

describe("namesMatch", () => {
  it.each([
    ["Suppe", "Suppen & Eintöpfe"],
    ["Eintopf", "Suppen & Eintöpfe"],
    ["Hauptgericht", "Hauptgerichte"],
    ["Dessert", "Desserts"],
    ["Salat", "Salate"],
    ["Vegetarisch", "Vegetarisch"],
    ["vegan", "Vegan"],
    ["One-Pot", "One-Pot / All-in-One"],
    ["Deutsche Küche", "Küche Deutsch"],
    ["Italienisch", "Küche Italienisch"],
    ["Frühstück", "Frühstück"],
    ["Getränk", "Getränke"],
    ["Marmelade", "Marmelade & Gelee"],
    ["Beilage", "Beilagen"],
  ])("matches %s with %s", (mealie, category) => {
    expect(namesMatch(mealie, category)).toBe(true);
  });

  it.each([
    ["Herbst", "Suppen & Eintöpfe"],
    ["Küche", "Küche Deutsch"],
    ["Kuchen", "Backen"],
    ["Essen", "Abendessen"],
    ["", "Desserts"],
    ["!!!", "Desserts"],
  ])("does not match %s with %s", (mealie, category) => {
    expect(namesMatch(mealie, category)).toBe(false);
  });
});

describe("matchCategories and hints", () => {
  it("finds the categories named by Mealie categories and tags, in catalog order", () => {
    const matches = matchCategories(["Suppe", "Vegetarisch", "Herbst", "suppe "], catalog);
    expect(matches.map((match) => [match.category.id, match.matchedBy])).toEqual([
      [588, ["Vegetarisch"]],
      [228, ["Suppe", "suppe"]],
    ]);
  });

  it("lists the matched categories first, then the rest of the catalog", () => {
    const matches = matchCategories(["Desserts"], catalog);
    const hints = categoryHints(catalog, matches);
    expect(hints[0]).toBe("308: Desserts");
    expect(hints).toHaveLength(catalog.length);
    expect(new Set(hints).size).toBe(catalog.length);
  });
});

describe("mergeCategoryIds", () => {
  it("puts matched ids first, keeps known picks, drops unknown ones and caps the list", () => {
    expect(mergeCategoryIds([228], [260, 228, 9999], catalog, 8)).toEqual({
      ids: [228, 260],
      dropped: [9999],
    });
    expect(mergeCategoryIds([1, 2, 3], [], catalog, 2).ids).toEqual([1, 2]);
  });
});

describe("loadCategories", () => {
  const list = [{ id: 1, name: "Eins", order: 0 }];
  const now = () => new Date("2026-10-13T12:00:00.000Z");

  it("fetches and caches the catalog", async () => {
    store = tempStore();
    const mc = {
      getCategories: vi.fn(() => Promise.resolve({ source: "proxy" as const, categories: list })),
    };
    const first = await loadCategories(mc, store.settings, { now });
    expect(first).toEqual({ categories: list, fetchedAt: now().toISOString(), source: "proxy" });
    const second = await loadCategories(mc, store.settings, { now });
    expect(second.source).toBe("cache");
    expect(mc.getCategories).toHaveBeenCalledTimes(1);
  });

  it("fetches again after a day", async () => {
    store = tempStore();
    store.settings.setJson(CATEGORY_CACHE_KEY, {
      fetchedAt: "2026-10-12T11:00:00.000Z",
      categories: list,
    });
    const mc = {
      getCategories: vi.fn(() => Promise.resolve({ source: "public" as const, categories: list })),
    };
    expect((await loadCategories(mc, store.settings, { now })).source).toBe("public");
  });

  it("uses an old cache when the fetch fails, but not for a dead session", async () => {
    store = tempStore();
    store.settings.setJson(CATEGORY_CACHE_KEY, {
      fetchedAt: "2026-01-01T00:00:00.000Z",
      categories: list,
    });
    const failing = { getCategories: () => Promise.reject(new Error("offline")) };
    expect((await loadCategories(failing, store.settings, { now })).source).toBe("stale-cache");

    const expired = new McSessionError({
      kind: "expired",
      status: 401,
      code: 110002,
      serverMessage: null,
      endpoint: "GET api/v1/categories",
    });
    const dead = { getCategories: () => Promise.reject(expired) };
    await expect(
      loadCategories(dead, store.settings, {
        now,
        isSessionError: (error) => error instanceof McSessionError,
      }),
    ).rejects.toBe(expired);
  });

  it("fails without a cache", async () => {
    store = tempStore();
    const failing = { getCategories: () => Promise.reject(new Error("offline")) };
    await expect(loadCategories(failing, store.settings, { now })).rejects.toThrow("offline");
  });

  it("ignores an empty or broken cache", async () => {
    store = tempStore();
    store.settings.setJson(CATEGORY_CACHE_KEY, { fetchedAt: now().toISOString(), categories: [] });
    const mc = {
      getCategories: vi.fn(() => Promise.resolve({ source: "proxy" as const, categories: list })),
    };
    expect((await loadCategories(mc, store.settings, { now })).source).toBe("proxy");
  });
});
