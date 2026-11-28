// What docs/upgrading.md and the pages say where an application used an internal call: the public
// call that replaces it, with what it keeps and how it differs, or that 1.0 has no public call for it
// (D44). The behaviour each row names is run by upgrade-guide.test.ts through fixtures/row-runners.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const guideLines = read("docs/upgrading.md").split(/\r?\n/);
/** The guide's table row whose Old cell is `old`, under the heading `section`. */
const row = (section: string, old: string) => {
  let current = "";
  for (const line of guideLines) {
    if (/^#{2,4} /.test(line)) current = line.replace(/^#+ /, "");
    else if (current === section && line.startsWith(`| ${old} |`)) return line;
  }
  throw new Error(`no row ${old} under ${section}`);
};

describe("the system menu of a window by its handle (the tag's windowMenu(hwnd))", () => {
  const page = read("docs/native/menus-and-tray.md");
  const guideRow = row("`@n1h/sweetview-native/win32/tab-window`", "`windowMenu`");
  for (const [where, text] of [
    ["docs/native/menus-and-tray.md", page.replace(/\s+/g, " ")],
    ["the guide's windowMenu row", guideRow],
  ] as const) {
    test(`${where} wraps the window once and calls showSystemMenu on that object, and says what the wrapper keeps and how it differs`, () => {
      expect({
        where,
        // `Window.fromHandle(hwnd).showSystemMenu()` in a right-click handler keeps one wrapper per click.
        wrapsPerCall: /Window\.fromHandle\([^)]*\)\.showSystemMenu\(/.test(text),
        wrapsOnce: /const (\w+) = Window\.fromHandle\(hwnd\)/.test(text) && /`?\b(\w+)\.showSystemMenu\(\)/.test(text.replace(/Window#showSystemMenu/g, "")),
        saysWhatItKeeps: /kept.*until `?\w+\.dispose\(\)`? or the end of the application/.test(text),
        saysNullAndNotAWindowThrow: /throws for a null handle and for a value that names no window/.test(text),
        saysForeignWindowIsWatched: /did not make.*watched.*until the wrapper is disposed/s.test(text),
      }).toEqual({ where, wrapsPerCall: false, wrapsOnce: true, saysWhatItKeeps: true, saysNullAndNotAWindowThrow: true, saysForeignWindowIsWatched: true });
    });
  }
});
