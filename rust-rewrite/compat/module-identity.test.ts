// The repository's tests reach Sweetview's internals by relative source path instead of the
// package's internal entries (D45). That keeps one module, and one state, only if both spellings
// load the same module: an internal entry, resolved from the package that imports it, and the
// relative path to its file give the same module object and the same functions.

import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
/** [entry, relative path from here, a function it exports, the folder the entry is resolved from]. */
const SAME_FILE: [string, string, string, string][] = [
  ["@n1h/sweetview-native/internal", "../../packages/sweetview-native/src/internal", "scheduleNativeTimeout", import.meta.dir],
  ["@n1h/sweetview-native/win32/window", "../../packages/sweetview-native/src/win32/window", "asHwnd", import.meta.dir],
  ["@n1h/sweetview-native/win32/menu", "../../packages/sweetview-native/src/win32/menu", "buildMenu", import.meta.dir],
  // It holds state: the tab frames of this process.
  ["@n1h/sweetview-native/win32/tab-window", "../../packages/sweetview-native/src/win32/tab-window", "getTabFrame", import.meta.dir],
  ["@n1h/sweetview-native/win32/strip-shared", "../../packages/sweetview-native/src/win32/strip-shared", "dropIndex", import.meta.dir],
  ["@n1h/sweetview-native/win32/shortcuts", "../../packages/sweetview-native/src/win32/shortcuts", "shortcutFor", import.meta.dir],
  // Imported by @n1h/sweetview-build, through its own link to the native package.
  ["@n1h/sweetview-native/shell-icons", "../../packages/sweetview-native/src/shell-icons", "refreshShellIcons", join(root, "packages", "sweetview-build", "src")],
];

test("an internal entry and the relative path to its file are the same module, with the same functions", async () => {
  const seen = [];
  for (const [entry, path, name, from] of SAME_FILE) {
    const resolved = Bun.resolveSync(entry, from);
    const byEntry = (await import(resolved)) as Record<string, unknown>;
    const byPath = (await import(path)) as Record<string, unknown>;
    seen.push({ entry, sameModule: byEntry === byPath, sameFunction: typeof byEntry[name] === "function" && byEntry[name] === byPath[name], resolved: resolved === Bun.resolveSync(path, import.meta.dir) });
  }
  console.log(JSON.stringify(seen));
  expect(seen).toEqual(SAME_FILE.map(([entry]) => ({ entry, sameModule: true, sameFunction: true, resolved: true })));
});
