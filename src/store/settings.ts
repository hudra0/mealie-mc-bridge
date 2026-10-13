// Key-value settings in bridge.db. Secrets (the Monsieur Cuisine cookie) are encrypted
// with AES-256-GCM under SETTINGS_KEY, a random 32-byte key the operator keeps outside the
// database. The setting's name is bound to the ciphertext as additional data, so a value
// copied to another key does not decrypt.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT = "v1";

export class SettingsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsKeyError";
  }
}

// A new SETTINGS_KEY: base64 of 32 random bytes.
export function generateSettingsKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function parseSettingsKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new SettingsKeyError("SETTINGS_KEY must be the base64 encoding of 32 bytes");
  }
  return key;
}

export function encryptSecret(key: Buffer, name: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

export function decryptSecret(key: Buffer, name: string, stored: string): string {
  const [format, iv, tag, body] = stored.split(":");
  if (format !== FORMAT || iv === undefined || tag === undefined || body === undefined) {
    throw new SettingsKeyError(`Setting ${name} is not an encrypted value`);
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // The cause would only say "unable to authenticate data".
    throw new SettingsKeyError(
      `Setting ${name} cannot be decrypted: SETTINGS_KEY differs from the key it was stored with`,
    );
  }
}

export interface SettingsStoreOptions {
  // The decoded SETTINGS_KEY. Without it, secrets can be neither read nor written.
  key?: Buffer | null;
  now?: () => Date;
}

export class SettingsStore {
  readonly #db: Db;
  readonly #key: Buffer | null;
  readonly #now: () => Date;

  constructor(db: Db, options: SettingsStoreOptions = {}) {
    this.#db = db;
    this.#key = options.key ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  get(name: string): string | null {
    const row = this.#db
      .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
      .get(name);
    return row ? row.value : null;
  }

  // When the value was last written, or null when it is not set.
  updatedAt(name: string): string | null {
    const row = this.#db
      .prepare<[string], { updated_at: string }>("SELECT updated_at FROM settings WHERE key = ?")
      .get(name);
    return row ? row.updated_at : null;
  }

  set(name: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value, this.#now().toISOString());
  }

  delete(name: string): void {
    this.#db.prepare("DELETE FROM settings WHERE key = ?").run(name);
  }

  getJson<T>(name: string): T | null {
    const value = this.get(name);
    if (value === null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  setJson(name: string, value: unknown): void {
    this.set(name, JSON.stringify(value));
  }

  getSecret(name: string): string | null {
    const stored = this.get(name);
    if (stored === null) return null;
    return decryptSecret(this.#requireKey(), name, stored);
  }

  setSecret(name: string, value: string): void {
    this.set(name, encryptSecret(this.#requireKey(), name, value));
  }

  #requireKey(): Buffer {
    if (!this.#key) throw new SettingsKeyError("SETTINGS_KEY is not set");
    return this.#key;
  }
}
