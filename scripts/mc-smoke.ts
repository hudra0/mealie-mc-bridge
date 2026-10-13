// Manual checks of the Monsieur Cuisine side against a real account.
//
//   npm run mc:smoke -- whoami
//   npm run mc:smoke -- categories
//   npm run mc:smoke -- dry-run <recipe-input.json>
//   npm run mc:smoke -- create <recipe-input.json> [--status private-publish] [--image <photo>]
//
// whoami, categories and create need MC_COOKIE: the Cookie header of a logged-in
// www.monsieur-cuisine.com session. It is a secret. Pass it through the environment, never
// as an argument, and never commit it. dry-run works offline and needs no session.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import {
  McClient,
  McSessionError,
  McTransport,
  StaticSessionProvider,
  UnsupportedImageError,
  isWritableStatus,
  prepareRecipeImage,
  type FetchLike,
  type McWritableStatus,
} from "../src/mc/index.js";
import { DeviceLimitsError, loadDeviceLimits, type DeviceLimits } from "../src/recipe/limits.js";
import { buildMcPayload } from "../src/recipe/payload.js";
import type { RecipeInput } from "../src/recipe/schema.js";
import { validateRecipeInput, type ValidateOptions } from "../src/recipe/validate.js";

export const EXIT = {
  ok: 0,
  invalidInput: 1,
  session: 2,
  api: 3,
  usage: 64,
  // A missing or malformed device limits file (EX_CONFIG).
  config: 78,
} as const;

export const USAGE = `Usage: mc-smoke <command> [options]

Commands:
  whoami                         check the session and show the account id
  categories                     list the recipe categories
  dry-run <recipe-input.json>    validate a recipe and print the API payload (offline)
  create <recipe-input.json>     validate and create the recipe as a draft
      --status private-publish   then save it on your device only
      --image <file>             upload a JPEG, PNG or WebP photo as the cover image

whoami, categories and create read the session from MC_COOKIE. It is the Cookie header of a
logged-in www.monsieur-cuisine.com browser session and a secret: keep it out of shell history,
files under version control and screenshots.`;

export interface SmokeContext {
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  // For tests; the global fetch otherwise.
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

class UsageError extends Error {}
class InputError extends Error {}

export async function runSmoke(args: readonly string[], ctx: SmokeContext): Promise<number> {
  try {
    return await dispatch(args, ctx);
  } catch (error) {
    return report(error, ctx);
  }
}

async function dispatch(args: readonly string[], ctx: SmokeContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        status: { type: "string" },
        image: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const [command, file, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") {
    ctx.out(USAGE);
    return command === undefined && !values.help ? EXIT.usage : EXIT.ok;
  }
  const takesFile = command === "dry-run" || command === "create";
  if (rest.length > 0 || (!takesFile && file !== undefined)) {
    throw new UsageError(`Too many arguments for ${command}`);
  }
  if (takesFile && file === undefined) throw new UsageError(`${command} needs a recipe file`);
  if (command !== "create" && (values.status !== undefined || values.image !== undefined)) {
    throw new UsageError("--status and --image only apply to create");
  }

  const config = loadConfig(ctx.env);
  switch (command) {
    case "whoami": {
      const user = await client(config.MC_COOKIE, ctx).getCurrentUser();
      const name = user.displayName ? `, display name ${user.displayName}` : "";
      ctx.out(`Session is valid. Account id ${user.id}${name}.`);
      return EXIT.ok;
    }
    case "categories": {
      const { source, categories } = await client(config.MC_COOKIE, ctx).getCategories();
      ctx.out(`${categories.length} categories (from the ${source} API):`);
      for (const category of [...categories].sort((a, b) => a.id - b.id)) {
        ctx.out(`  ${String(category.id).padStart(4)}  ${category.name}`);
      }
      return EXIT.ok;
    }
    case "dry-run": {
      const limits = await loadDeviceLimits(config.DEVICE_PROGRAMS_PATH);
      const recipe = await validated(file as string, limits, {}, ctx);
      if (!recipe) return EXIT.invalidInput;
      ctx.out(JSON.stringify(buildMcPayload(recipe, limits, { status: "draft" }), null, 2));
      return EXIT.ok;
    }
    case "create":
      return create(file as string, values, config, ctx);
    default:
      throw new UsageError(`Unknown command ${command}`);
  }
}

async function create(
  file: string,
  options: { status?: string | undefined; image?: string | undefined },
  config: ReturnType<typeof loadConfig>,
  ctx: SmokeContext,
): Promise<number> {
  const status = options.status ?? "draft";
  if (!isWritableStatus(status)) {
    throw new UsageError(`--status must be draft or private-publish, not ${status}`);
  }
  const limits = await loadDeviceLimits(config.DEVICE_PROGRAMS_PATH);
  const mc = client(config.MC_COOKIE, ctx);
  // Only the live catalog says which category ids exist.
  const { categories } = await mc.getCategories();
  const known = { knownCategoryIds: categories.map((category) => category.id) };
  const recipe = await validated(file, limits, known, ctx);
  if (!recipe) return EXIT.invalidInput;

  let media: { detailsMediaId: number; thumbnailMediaId: number } | null = null;
  if (options.image !== undefined) {
    const bytes = await readInput(options.image, "image");
    const image = await prepareRecipeImage(bytes, limits.recipe.coverPhotoAspect);
    media = await mc.uploadImage(image);
    ctx.err(`Image uploaded: details ${media.detailsMediaId}, thumbnail ${media.thumbnailMediaId}`);
  }
  // The server creates every recipe as a draft; the status change is a second call.
  const payload = buildMcPayload(recipe, limits, {
    status: "draft",
    detailsMediaId: media?.detailsMediaId ?? null,
    thumbnailMediaId: media?.thumbnailMediaId ?? null,
  });
  let created;
  try {
    created = await mc.createRecipe(payload);
  } catch (error) {
    if (media) {
      ctx.err("No recipe was created. The uploaded images are not attached to any recipe.");
    }
    throw error;
  }
  let finalStatus: string = created.status;
  if (status === "private-publish") {
    try {
      finalStatus = (await mc.setStatus(created.id, status satisfies McWritableStatus)).status;
    } catch (error) {
      // The draft exists. Say so, or a second run would create another one.
      ctx.err(
        `Created recipe ${created.id} as a draft, but setting private-publish failed: ${messageOf(error)}`,
      );
      ctx.err(`Set the status in the editor instead of running create again: ${created.editorUrl}`);
      return exitCodeOf(error);
    }
  }
  ctx.out(`Created recipe ${created.id} with status ${finalStatus}.`);
  ctx.out(`Review it before cooking: ${created.editorUrl}`);
  for (const hint of recipe.reviewHints ?? []) ctx.out(`  - ${hint}`);
  return EXIT.ok;
}

// Reads and validates a recipe file. Prints the errors and returns null when it is invalid.
async function validated(
  file: string,
  limits: DeviceLimits,
  options: ValidateOptions,
  ctx: SmokeContext,
): Promise<RecipeInput | null> {
  const text = (await readInput(file, "recipe file")).toString("utf8");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new InputError(`${file} is not valid JSON`);
  }
  const result = validateRecipeInput(input, limits, options);
  if (!result.recipe) {
    ctx.err(`${file} has ${result.errors.length} problem(s):`);
    for (const error of result.errors) ctx.err(`  ${error.path}: ${error.message}`);
    return null;
  }
  ctx.err(`${file} is valid.`);
  return result.recipe;
}

async function readInput(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(resolve(file));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    throw new InputError(`Cannot read the ${label} ${file}${code ? ` (${code})` : ""}`);
  }
}

function client(cookie: string | undefined, ctx: SmokeContext): McClient {
  if (!cookie) {
    throw new McSessionError({
      kind: "invalid",
      status: 0,
      code: null,
      serverMessage: null,
      endpoint: "mc-smoke",
      message: "MC_COOKIE is not set",
    });
  }
  const transport = new McTransport(ctx.fetch ? { fetch: ctx.fetch } : {});
  return new McClient(
    transport,
    new StaticSessionProvider(cookie),
    "de-DE",
    ctx.sleep ? { sleep: ctx.sleep } : {},
  );
}

function report(error: unknown, ctx: SmokeContext): number {
  if (error instanceof UsageError) {
    ctx.err(error.message);
    ctx.err("Run mc-smoke --help for the commands.");
    return EXIT.usage;
  }
  if (error instanceof McSessionError) {
    ctx.err(`No usable Monsieur Cuisine session (${error.kind}): ${error.message}`);
    ctx.err(
      "Log in on www.monsieur-cuisine.com and copy the Cookie header into MC_COOKIE (see README).",
    );
    return EXIT.session;
  }
  ctx.err(messageOf(error));
  if (error instanceof DeviceLimitsError) {
    ctx.err("Check DEVICE_PROGRAMS_PATH; it must point at knowledge/device-programs.json.");
  }
  return exitCodeOf(error);
}

function exitCodeOf(error: unknown): number {
  if (error instanceof McSessionError) return EXIT.session;
  if (error instanceof InputError || error instanceof UnsupportedImageError) {
    return EXIT.invalidInput;
  }
  if (error instanceof DeviceLimitsError) return EXIT.config;
  // API failures, image processing timeouts and anything unexpected.
  return EXIT.api;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const exitCode = await runSmoke(process.argv.slice(2), {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = exitCode;
}
