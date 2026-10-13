import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "text"],
      thresholds: {
        "src/mealie/**": { lines: 85 },
        "src/ingredients/**": { lines: 85 },
      },
    },
  },
});
