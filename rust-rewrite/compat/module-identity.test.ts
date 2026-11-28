// The repository's tests reach Sweetview's internals by relative source path instead of the
// package's internal entries (D44). That keeps one module, and one state, only if both spellings
// load the same module: an internal entry and the relative path to its file give the same module
// object and the same functions.

import { expect, test } from "bun:test";

const SAME_FILE: [string, string, string][] = [
  ["@n1h/sweetview-native/internal", "../../packages/sweetview-native/src/internal", "scheduleNativeTimeout"],
  ["@n1h/sweetview-native/win32/window", "../../packages/sweetview-native/src/win32/window", "asHwnd"],
  ["@n1h/sweetview-native/win32/menu", "../../packages/sweetview-native/src/win32/menu", "buildMenu"],
];

test("an internal entry and the relative path to its file are the same module, with the same functions", async () => {
  const seen = [];
  for (const [entry, path, name] of SAME_FILE) {
    const byEntry = (await import(entry)) as Record<string, unknown>;
    const byPath = (await import(path)) as Record<string, unknown>;
    seen.push({ entry, sameModule: byEntry === byPath, sameFunction: typeof byEntry[name] === "function" && byEntry[name] === byPath[name], resolved: Bun.resolveSync(entry, import.meta.dir) === Bun.resolveSync(path, import.meta.dir) });
  }
  console.log(JSON.stringify(seen));
  expect(seen).toEqual(SAME_FILE.map(([entry]) => ({ entry, sameModule: true, sameFunction: true, resolved: true })));
});
