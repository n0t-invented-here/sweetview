import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { appDataDir, createSettingsStore } from "./settings-store";

type S = { volume: number; muted: boolean };
const DEFAULTS: S = { volume: 50, muted: false };
const clamp = (input: unknown): S => {
  const s = (typeof input === "object" && input !== null ? input : {}) as Partial<Record<keyof S, unknown>>;
  return {
    volume: typeof s.volume === "number" ? Math.min(100, Math.max(0, s.volume)) : DEFAULTS.volume,
    muted: typeof s.muted === "boolean" ? s.muted : DEFAULTS.muted,
  };
};

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "sweetview-settings-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("appDataDir", () => {
  test("ends in the app's folder under a per-user base", () => {
    const dir = appDataDir("my-app");
    expect(dir.endsWith(`${sep}my-app`)).toBe(true);
    if (process.platform === "win32") expect(dir.toLowerCase()).toContain("appdata");
    else if (process.platform === "darwin") expect(dir).toContain(join("Library", "Application Support"));
  });
});

describe("createSettingsStore", () => {
  test("no file: the defaults, through sanitize", () => {
    const store = createSettingsStore<S>({ app: "x", dir: join(tempDir(), "nested", "deeper"), defaults: DEFAULTS, sanitize: clamp });
    expect(store.load()).toEqual(DEFAULTS);
  });

  test("save creates the folder and load reads it back, sanitized", () => {
    const dir = join(tempDir(), "made", "by-save");
    const store = createSettingsStore<S>({ app: "x", dir, defaults: DEFAULTS, sanitize: clamp });
    store.save({ volume: 80, muted: true });
    expect(store.path).toBe(join(dir, "settings.json"));
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toEqual({ volume: 80, muted: true });
    writeFileSync(store.path, JSON.stringify({ volume: 500, muted: "yes" }));
    expect(store.load()).toEqual({ volume: 100, muted: false });
  });

  test("a corrupt file gives the defaults", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), "{ not json");
    const store = createSettingsStore<S>({ app: "x", dir, defaults: DEFAULTS, sanitize: clamp });
    expect(store.load()).toEqual(DEFAULTS);
  });

  test("the default sanitize fills gaps from the defaults and names the file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "prefs.json"), JSON.stringify({ muted: true }));
    const store = createSettingsStore<S>({ app: "x", dir, file: "prefs.json", defaults: DEFAULTS });
    expect(store.load()).toEqual({ volume: 50, muted: true });
  });
});

describe("createSettingsStore, the edges", () => {
  test("a corrupt file still goes through sanitize", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), "{ not json");
    const derived = (input: unknown): S & { derived?: true } => ({ ...clamp(input), derived: true });
    const store = createSettingsStore<S & { derived?: true }>({ app: "x", dir, defaults: DEFAULTS, sanitize: derived });
    expect(store.load()).toEqual({ ...DEFAULTS, derived: true });
  });

  test("a sanitize that throws gives the defaults instead of throwing out of load", () => {
    const dir = tempDir();
    const store = createSettingsStore<S>({ app: "x", dir, defaults: DEFAULTS, sanitize: () => { throw new Error("no"); } });
    expect(store.load()).toEqual(DEFAULTS);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ volume: 1 }));
    expect(store.load()).toEqual(DEFAULTS);
  });

  test("the default sanitize ignores a JSON array", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify([1, 2, 3]));
    const store = createSettingsStore<S>({ app: "x", dir, defaults: DEFAULTS });
    expect(store.load()).toEqual(DEFAULTS);
  });

  test("save leaves no temporary file behind", () => {
    const dir = tempDir();
    const store = createSettingsStore<S>({ app: "x", dir, defaults: DEFAULTS });
    store.save({ volume: 3, muted: true });
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });
});
