// A small app's settings: one JSON document in the user's app-data folder,
// read once at start and written whole on every change. Synchronous on
// purpose: the UI thread is blocked in the OS loop after run() and cannot
// await, and a settings change is a few hundred bytes.
//
//   const store = createSettingsStore<Settings>({ app: "my-app", defaults: DEFAULTS, sanitize });
//   let settings = store.load();          // before run(); defaults when the file is missing or unreadable
//   store.save(settings = { ...settings, ...patch });
//
// No Bun or FFI; usable from any build or test script.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The per-user folder an app keeps its own files in: `%APPDATA%\<app>` on
 * Windows, `~/Library/Application Support/<app>` on macOS,
 * `$XDG_CONFIG_HOME/<app>` (default `~/.config/<app>`) elsewhere. Not created.
 */
export function appDataDir(app: string): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA || join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME || join(homedir(), ".config"));
  return join(base, app);
}

export type SettingsStoreOptions<T> = {
  /** The app's folder name under the app-data folder (`appDataDir`). */
  app: string;
  /** The file inside it. Default `settings.json`. */
  file?: string;
  /** The folder itself, instead of `appDataDir(app)`; for tests, or an app that keeps settings elsewhere. */
  dir?: string;
  /** The baseline: what the default `sanitize` merges the file over, and what `load()` returns when `sanitize` throws. */
  defaults: T;
  /**
   * Turns whatever the file held into a valid T: fill gaps, clamp ranges,
   * drop junk. Gets the parsed JSON, or `undefined` when the file was
   * missing, unreadable or not JSON. Default: the defaults with the file's
   * own keys over them, when the file holds an object. A throw is logged and
   * `defaults` is returned instead.
   */
  sanitize?: (input: unknown) => T;
};

export type SettingsStore<T> = {
  /** Where the file is (or will be). */
  readonly path: string;
  /** The saved settings through `sanitize`; `sanitize(undefined)` when the file is missing, unreadable or not JSON (the cause goes to stderr). Never throws. */
  load(): T;
  /** Writes the whole document, creating the folder; a failure goes to stderr and is otherwise ignored, so a read-only disk never stops the app. */
  save(settings: T): void;
};

export function createSettingsStore<T extends object>(options: SettingsStoreOptions<T>): SettingsStore<T> {
  const path = join(options.dir ?? appDataDir(options.app), options.file ?? "settings.json");
  const isPlainObject = (input: unknown): input is Partial<T> => typeof input === "object" && input !== null && !Array.isArray(input);
  const sanitize = options.sanitize ?? ((input: unknown): T => ({ ...options.defaults, ...(isPlainObject(input) ? input : {}) }));
  // sanitize runs on every path, so a custom one that derives or migrates fields always gets its turn;
  // a throw from it is reported like an unreadable file and the defaults are used.
  const settle = (input: unknown): T => {
    try {
      return sanitize(input);
    } catch (err) {
      console.error(`settings: sanitize failed for ${path}, using defaults:`, (err as Error).message);
      return { ...options.defaults };
    }
  };
  return {
    path,
    load() {
      if (!existsSync(path)) return settle(undefined);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        console.error(`settings: ${path} unreadable, using defaults:`, (err as Error).message);
        return settle(undefined);
      }
      return settle(parsed);
    },
    save(settings) {
      // written beside the file and renamed over it, so a crash mid-write leaves the previous document rather than a truncated one
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
        renameSync(tmp, path);
      } catch (err) {
        try {
          rmSync(tmp, { force: true });
        } catch {}
        console.error(`settings: could not write ${path}:`, (err as Error).message);
      }
    },
  };
}
