import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Resolves to the project root's package.json from both src/ and dist/.
const pkg = require("../package.json") as { version: string };

export const version: string = pkg.version;
