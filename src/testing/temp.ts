// Shared test helpers. Not part of the build or the coverage report.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store/index.js";

export const TEST_SETTINGS_KEY = Buffer.alloc(32, 1);

// A fresh directory under the system temp dir, removed by the returned cleanup.
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mc-bridge-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TempStore extends Store {
  dir: string;
  path: string;
  dispose(): void;
}

// A store on its own SQLite file. Call dispose() in afterEach.
export function tempStore(options: { key?: Buffer | null; now?: () => Date } = {}): TempStore {
  const { dir, cleanup } = tempDir();
  const path = join(dir, "bridge.db");
  const store = openStore({
    path,
    key: options.key === undefined ? TEST_SETTINGS_KEY : options.key,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    ...store,
    dir,
    path,
    dispose: () => {
      if (store.db.open) store.close();
      cleanup();
    },
  };
}

// A clock that advances by one second on every call unless set explicitly.
export function steppingClock(start = "2026-10-13T10:00:00.000Z") {
  let current = new Date(start).getTime();
  const now = () => {
    const value = new Date(current);
    current += 1000;
    return value;
  };
  return {
    now,
    set: (iso: string) => {
      current = new Date(iso).getTime();
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}
