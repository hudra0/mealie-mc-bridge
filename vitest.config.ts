import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "html"],
      // The Monsieur Cuisine client and the recipe rules are the product; keep them tested.
      thresholds: {
        "src/mc/**/*.ts": { lines: 85 },
        "src/recipe/**/*.ts": { lines: 85 },
      },
    },
  },
});
