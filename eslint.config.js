import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "local/**", "data/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js", "vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The script of the admin pages runs in the browser.
    files: ["src/service/ui/client/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: Object.fromEntries(
        [
          "document",
          "location",
          "navigator",
          "fetch",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "getSelection",
          "Element",
          "HTMLFormElement",
          "HTMLDetailsElement",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
);
