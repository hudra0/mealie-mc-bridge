import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      // src/testing holds fakes for the tests and is not part of the build.
      exclude: ["**/*.test.ts", "src/testing/**"],
      reporter: ["text-summary", "text", "html"],
      // The product modules keep a line threshold each; scripts/ is reported without one.
      thresholds: {
        "src/mc/**/*.ts": { lines: 85 },
        "src/recipe/**/*.ts": { lines: 85 },
        "src/mealie/**/*.ts": { lines: 85 },
        "src/ingredients/**/*.ts": { lines: 85 },
        "src/convert/**/*.ts": { lines: 85 },
        "src/store/**/*.ts": { lines: 85 },
        "src/session/**/*.ts": { lines: 85 },
        "src/pipeline/**/*.ts": { lines: 85 },
        "src/service/**/*.ts": { lines: 85 },
        "src/notify/**/*.ts": { lines: 85 },
        "src/locale/**/*.ts": { lines: 85 },
        "src/i18n/**/*.ts": { lines: 85 },
      },
    },
  },
});
