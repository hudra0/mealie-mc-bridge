# Third-party notices

## SmartRecipe

Source: https://github.com/gerkensm/smart-recipe (MIT)

Parts of the Monsieur Cuisine client and the recipe format are ported from SmartRecipe and changed. Each of these files names its source files in a header comment:

| File in this repository        | SmartRecipe source                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/mc/transport.ts`          | `src/mc/client.ts` (proxy transport, headers, session error codes)                                                |
| `src/mc/client.ts`             | `src/mc/client.ts` (endpoints, image upload)                                                                      |
| `src/mc/types.ts`              | `src/recipes/schema.ts` (`SmartRecipePayloadSchema`)                                                              |
| `src/recipe/schema.ts`         | `src/recipes/schema.ts` (`RecipeInputSchema`)                                                                     |
| `src/recipe/modes.ts`          | `src/recipes/modes.ts`, `src/recipes/constants.ts`                                                                |
| `src/recipe/payload.ts`        | `src/recipes/payload.ts`, `src/catalogs/catalogs.ts`                                                              |
| `src/session/browser-login.ts` | `src/mc/browser-login.ts` (SSO start, Lidl form selectors, welcome-screen button rule, cookie polling and header) |

```text
MIT License

Copyright (c) 2026 SmartRecipe contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
