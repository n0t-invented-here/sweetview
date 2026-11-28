// What docs/upgrading.md and the pages say where an application used an internal call: the public
// call that replaces it, with what it keeps and how it differs, or that 1.0 has no public call for it
// (D45). The behaviour each row names is run by upgrade-guide.test.ts through fixtures/row-runners.ts.

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

describe("an internal the guide now says the true thing about", () => {
  test("discardQuit says the same in Part A and Part B: App#dispose for a webview of createApp or WebView, no public call for a raw Webview#destroy()", () => {
    const partA = row("`src/native/event-loop.ts`, `src/native/win32/color-ref.ts`", "`discardQuit`");
    const partB = row("`@n1h/sweetview-native/internal`", "`discardQuit`");
    const said = (line: string) => ({
      writeNow: line.split(" | ")[1],
      appAndWebView: /`App#dispose\(\)`, and `WebView#dispose\(\)`, take back the quit/.test(line),
      rawGap: /for a raw `Webview#destroy\(\)` under `runEventLoop` there is no public call in 1\.0/.test(line),
    });
    const want = { writeNow: '`import type { App } from "@n1h/sweetview"`; `App#dispose`', appAndWebView: true, rawGap: true };
    expect({ partA: said(partA), partB: said(partB) }).toEqual({ partA: want, partB: want });
  });

  test("the shell's icon refresh is named by its public call, refreshWindowsIcons, with its failure contract", () => {
    const added = guideLines.slice(guideLines.indexOf("## Added since `v1-drafting`")).join(" ");
    expect({
      namesTheEntry: added.includes("sweetview-native/shell-icons"),
      namesThePublicCall: added.includes("`refreshWindowsIcons()` of `@n1h/sweetview/build`"),
      saysItSwallowsErrors: /never throws: an error of the\s+native binding is swallowed/.test(added),
    }).toEqual({ namesTheEntry: false, namesThePublicCall: true, saysItSwallowsErrors: true });
  });
});

describe("the ready watchdog is opt-in, and every passage says so", () => {
  test("a paragraph that reveals a window by showOnReady and the watchdog, or a snippet with showOnReady: true, names readyTimeoutMs", () => {
    const lacking: string[] = [];
    for (const path of ["README.md", "docs/app.md", "docs/upgrading.md", "docs/page.md"]) {
      const text = read(path);
      // Paragraphs, and each bullet, numbered step and table row of a list on its own; a code block whole.
      for (const block of text.split(/\r?\n\s*\r?\n/).flatMap((b) => (b.includes("```") ? [b] : b.split(/\r?\n(?=\s*(?:- |\d+\. |\| ))/)))) {
        const code = block.includes("```") || /^\s*(const|await|import) /m.test(block);
        const needs = (/showOnReady/.test(block) && /watchdog/.test(block)) || (code && /showOnReady: true/.test(block));
        if (needs && !/readyTimeoutMs/.test(block)) lacking.push(`${path}: ${block.trim().slice(0, 90)}`);
      }
    }
    expect(lacking).toEqual([]);
  });
});

describe("one recipe for each thing", () => {
  test("a window with a page is shown by the ready signal: no createApp snippet shows it by hand, and the createWebviewApp row says so first", () => {
    const byHand: string[] = [];
    for (const path of ["README.md", "docs/app.md"]) {
      for (const block of read(path).split("```").filter((_b, i) => i % 2 === 1)) {
        if (/createApp(<[^>]*>)?\(/.test(block) && /\bpage\b/.test(block) && !/tabs: true/.test(block) && /^app\.window\.show\(\);/m.test(block)) byHand.push(`${path}: ${block.trim().split("\n")[0]}`);
      }
    }
    const intro = read("docs/app.md").replace(/\s+/g, " ");
    const createRow = row("`@n1h/sweetview`", "`createWebviewApp`");
    expect({ byHand, introShowsByHand: /then `app\.window\.show\(\)` and `app\.run\(\)`/.test(intro), rowShowFirst: /\(`app\.window\.show\(\)`, or `showOnReady: true`\)/.test(createRow) }).toEqual({ byHand: [], introShowsByHand: false, rowShowFirst: false });
  });

  test("Part A's setActivationPolicy rows say what Part B's say: it does nothing on Windows", () => {
    const rows = guideLines.filter((l) => l.startsWith("| `setActivationPolicy`"));
    expect({ rows: rows.length, unchanged: rows.filter((l) => / \| unchanged \|$/.test(l)).length, nothing: rows.filter((l) => /does nothing on Windows/.test(l)).length }).toEqual({ rows: 5, unchanged: 0, nothing: 5 });
  });

  test("a tray application is told closeToTrayOnLastWindow, and a plain onClose hide only for a window that must never close", () => {
    const overlay = row("`@n1h/sweetview/native`", "`OverlayWindowOptions`");
    const app = read("docs/app.md").replace(/\s+/g, " ");
    const single = app.slice(app.indexOf("**Single-window app, blocking `app.run()`.**"), app.indexOf("**Single-window app, blocking `app.run()`.**") + 1200);
    expect({
      overlayHides: overlay.includes("onClose: () => win.hide()"),
      overlayCloseToTray: overlay.includes("`closeToTrayOnLastWindow(win, onHide)`"),
      appCloseToTray: single.includes("`closeToTrayOnLastWindow(app.window, onHide)`"),
      appHideOnlyNeverClose: !/To keep the process running after the main window closes, pass `onClose`/.test(single) && /must never close/.test(single),
    }).toEqual({ overlayHides: false, overlayCloseToTray: true, appCloseToTray: true, appHideOnlyNeverClose: true });
  });

  test("unload: on Windows the call is deleted, on macOS it is kept until its goal; no Write now tells a Windows reader to call it", () => {
    const rows = guideLines.filter((l) => l.startsWith("| `unload` |"));
    const partC = guideLines.slice(guideLines.indexOf("### C. The bindings package, imported directly")).join(" ");
    expect({
      rows: rows.length,
      writeNowCalls: rows.filter((l) => l.split(" | ")[1]!.includes("unload()")).length,
      saysBoth: rows.filter((l) => /On Windows delete the call/.test(l) && /on macOS, until the macOS goal, keep it/i.test(l)).length,
      stepSaysBoth: /Delete the `unload\(\)` call on Windows/.test(partC) && /On macOS, until the macOS goal, keep it/.test(partC),
    }).toEqual({ rows: 2, writeNowCalls: 0, saysBoth: 2, stepSaysBoth: true });
  });
});

describe("rows and paragraphs say what the code does, no more", () => {
  test("getWindowMeta offers no public tabs field, holdWindowNativeDispose says when dispose waits, the tray's click handler is a construction option, pumpEvents' rule is Windows', and WebView.attach leaves a shown window shown", () => {
    const meta = row("`@n1h/sweetview-native/internal`", "`getWindowMeta`");
    const hold = row("`@n1h/sweetview-native/internal`", "`holdWindowNativeDispose`");
    const trayAt = guideLines.indexOf("#### `packages/sweetview-native/src/win32/tray.ts`");
    const tray = guideLines.slice(trayAt + 1, trayAt + 4).join(" ");
    const pumps = guideLines.filter((l) => /^\| `pumpEvents`/.test(l));
    const attach = read("docs/app.md").replace(/\s+/g, " ");
    const attachPara = attach.slice(attach.indexOf("Mounts a webview inside an existing `Window`"), attach.indexOf("Mounts a webview inside an existing `Window`") + 900);
    expect({
      metaTabsField: /`tabs` field/.test(meta),
      holdSaysWhenItWaits: /while a `WebView#run\(\)`/.test(hold) && !/releases it at once \|/.test(hold),
      trayClickAtConstruction: /click handler, given when it is made/.test(tray),
      pumpsSayWindows: pumps.length === 5 && pumps.every((l) => /On Windows/.test(l) && /on macOS/.test(l)),
      attachKeepsShown: /already shown stays shown/.test(attachPara),
    }).toEqual({ metaTabsField: false, holdSaysWhenItWaits: true, trayClickAtConstruction: true, pumpsSayWindows: true, attachKeepsShown: true });
  });
});

describe("internals named in passing", () => {
  test("docs/app.md's list of what the end of the application releases names no internal call", () => {
    const list = read("docs/app.md").replace(/\s+/g, " ");
    // The release list's last step, which names what the native layer still holds: present, and naming no internal call.
    const start = list.indexOf("7. on Windows, whatever the native layer still holds");
    const end = list.indexOf("A step that fails", start);
    const step = start >= 0 && end > start ? list.slice(start, end) : "";
    expect({ found: step.length > 40, namesBuildMenu: /buildMenu/.test(step), namesNativeTimeouts: /native timeouts/.test(step) }).toEqual({ found: true, namesBuildMenu: false, namesNativeTimeouts: false });
  });

  test("the guide's win32/tray.ts note says what the public Tray covers, not that the file's exports are still there", () => {
    const at = guideLines.indexOf("#### `packages/sweetview-native/src/win32/tray.ts`");
    const note = guideLines.slice(at + 1, at + 4).join(" ");
    expect({ stillThere: /are still there/.test(note), namesTray: /`createTray\(options\)`/.test(note) }).toEqual({ stillThere: false, namesTray: true });
  });
});

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
