import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "text", "html"],
      // The product modules keep a line threshold each; scripts/ is reported without one.
      thresholds: {
        "src/mc/**/*.ts": { lines: 85 },
        "src/recipe/**/*.ts": { lines: 85 },
        "src/mealie/**/*.ts": { lines: 85 },
        "src/ingredients/**/*.ts": { lines: 85 },
        "src/convert/**/*.ts": { lines: 85 },
      },
    },
  },
});
