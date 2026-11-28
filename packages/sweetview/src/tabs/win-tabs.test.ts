// Live Windows tests of tabbed windows (`new Window({ tabs: true })`,
// `WebView.openTab`, `Tab`): one per behaviour of "Behaviour: tabs on
// Windows" (rust-rewrite/reference/v1-drafting-tabs-and-window.md) that the
// other tab tests do not cover. They run in test/fixtures/win-tabs.ts and,
// for the gestures that need a held mouse button and real keys,
// test/fixtures/win-tabs-input.ts: each a process of its own with a WebView2
// profile of its own; each test reads its check from that run's report. A
// check that needs the shared desktop (the mouse over the fixture's own
// window, the foreground) is reported skipped, with the reason, when another
// session has it: such a check shows as a skip in the runner, never as a
// pass, and each fixture prints how many of its checks ran, passed, failed
// and were skipped.
//
// The fixtures run while this file is loaded (before any test), so that
// whether a check is a skip is known when its test is declared.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Check = { ok: boolean; detail?: unknown } | { skipped: string };

const CHECKS = [
  "system menu",
  "strip and page rectangles: the strip across the top, one tab over the page area",
  "a new tab is selected",
  "moving the window tells the strip's and every tab's webview",
  "DPI change: the frame takes the suggested rectangle; the strip height and the default minimum follow the window's DPI",
  "concurrent openTab calls wait for one host: both tabs open in the window under one strip",
  "a failed host attach is forgotten: the waiting openTab fails with it, a later openTab makes the host again",
  "select shows that tab and hides the others",
  "the window title follows the selected tab",
  "close: the tab goes, onTabClose fires, its webview is destroyed",
  "shortcut Ctrl+1",
  "shortcut Ctrl+2 (after: opens next to its tab)",
  "shortcut Ctrl+9",
  "shortcut Ctrl+Tab wraps",
  "shortcut Ctrl+PageDown",
  "shortcut Ctrl+Shift+Tab",
  "shortcut Ctrl+PageUp wraps",
  "shortcut Ctrl+T",
  "shortcut a key that is no shortcut is left to the page",
  "shortcut the strip takes every key",
  "shortcut Ctrl+W closes the selected tab",
  "shortcut Ctrl+F4 closes the selected tab",
  "strip.move reorders the tabs",
  "strip.move clamps an index past the end to the last place",
  "a tab whose webview is disposed directly leaves its window, which shows another tab",
  "a tab opened with no title is called Tab <id>",
  "renaming a tab trims the title; an empty one becomes Tab <id>",
  "strip.select selects that tab",
  "strip.close closes that tab",
  "strip.new asks the window for a new tab",
  "a new tab goes after the tab given as after, else after the selected tab (also when the given tab is in another window)",
  "tab ids rise by one from tab to tab",
  "after a close the tab at the same place is selected, else the one before it (onTabSelect says so)",
  "tab.dispose() takes even the last tab down at once; then the window's onClose listeners are asked",
  "a window with no title shows the selected tab's title alone",
  "openTab needs a window made with tabs: true that is not disposed",
  "the strip's close button asks the window's onClose listeners",
  "shortcut Alt+F4 closes the window",
  "last tab: an onClose listener intercepts, the tab stays",
  "last tab: with no listener the window closes with it",
  "a popup opens as a tab after its opener",
  "the popup tab's title follows its page",
  "a popup to another scheme is dropped",
  "failed load: the tab shows the page with the address",
  "failed load: the page gives the reason from the engine's table (a refused port, which WebView2 reports with no status of the table: its default sentence)",
  "a URL tab is called by its host until its page gives a title",
  "failed load: not shown for an HTTP error status (404, 500): the server's page stays",
  "failed load: not shown for an aborted navigation (a 204 response): the page stays",
  "failed load: not shown for a cancelled navigation (stopped while loading): the page stays",
  "failed load: not shown for a navigation a newer one superseded",
  "failed load: not shown for a navigation the host superseded with setHTML or navigate",
  "failed load: not shown for a data: address the engine refuses",
  "failed load: not shown for an about: address the engine refuses",
  "failed load: only a URL tab shows the page (a tab of assets whose navigation fails does not)",
  "tab menu items",
  "system menu on the strip: Restore off and Move, Size, Minimize, Maximize, Close on while not maximised",
  "choosing Close tab in the tab menu closes that tab",
  "maximised with the caption removed: the page fills the work area, the strip at its top",
  "the strip is told the window is maximised",
  "the strip and the page follow a resize",
  "a resize of the frame reaches Window.onResize",
  "strip minimise",
  "choosing Maximize in the strip's system menu maximises the window",
  "system menu on the strip while maximised: Restore and Minimize on, Move, Size and Maximize off; Close on and the default item",
  "choosing Minimize in the strip's system menu minimises the window",
  "strip.drag and strip.resize do nothing while the left button is up",
  "focus returns to the page after a strip action",
  "file drops on the frame",
  "topmost",
  "opacity",
  "hideFromTaskbar",
  "noActivate",
  "minimum size given as the outer frame",
  "a system frame follows the strip's report of the system theme",
  "an explicit appearance ignores the system",
  "tear-off: the new window takes the source's title, appearance, icon, resizable, topmost, opacity, hideFromTaskbar, noActivate and minimum size",
  "tear-off: the new window's tab events reach the window the tab came from",
  "a popup from a torn-off tab opens in the tab's current window",
  "a window whose only tab moves to a new window closes",
  "tear-off: the tab's webview moves to a new window with its page as it was",
  "merge: the tab comes back with its page as it was, the emptied window closes",
  "merge: the window keeps its selected tab on show",
  "a file dropped on a torn-off tab's webview goes to its new window",
  "a file dropped on a merged tab's webview goes to the window it joined",
  "choosing New tab in the tab menu asks the window for a new tab",
  "choosing Close other tabs in the tab menu keeps only that tab",
  "tab menu: Merge all windows is off with one window; Move tab to new window and Close other tabs are off with one tab",
  "choosing Move tab to new window in the tab menu moves that tab to a new window",
  "choosing Merge all windows in the tab menu brings every tab into one window and closes the other",
];

const INPUT_CHECKS = [
  "strip.drag: the window follows the cursor, the held point stays under it",
  "strip.resize top",
  "strip.resize top-left",
  "strip.resize top-right",
  "strip.drag from a maximised window: it restores first and follows the cursor",
  "strip.detach: a tab dragged out of a window with several tabs becomes a new window at the cursor, same size, keeping its page",
  "strip.detach: the only tab of a window drags the whole window",
  "strip.detach: a tab dropped on another window's strip joins it at the drop index",
  "strip.scrolled: a tab dropped on a strip whose tabs are scrolled joins it at the index the scrolled offset gives",
  "real keys: Ctrl+T opens a tab and Ctrl+W closes it while the page has the keyboard focus",
];

type Run = { report: Record<string, Check>; output: string };

/** Runs one fixture in a process of its own, on a WebView2 profile of its own, with a limit. */
async function runFixture(file: string): Promise<Run> {
  const profile = mkdtempSync(join(tmpdir(), "sweetview-win-tabs-"));
  try {
    const fixture = fileURLToPath(new URL(`../../test/fixtures/${file}`, import.meta.url));
    const proc = Bun.spawn([process.execPath, fixture], {
      timeout: 260_000,
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    return { report: line ? JSON.parse(line.slice("RESULT ".length)) : {}, output: `exit ${code}\n${stdout}\n${stderr}` };
  } finally {
    // WebView2's browser processes can hold the profile a moment after the fixture exits.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {}
  }
}

const SUITES = [
  ["tabbed windows (win32, live)", "win-tabs.ts", CHECKS],
  ["tabbed windows: strip gestures and real keys (win32, live)", "win-tabs-input.ts", INPUT_CHECKS],
] as const;

// One after the other: both use the shared desktop.
const runs: Run[] = [];
if (process.platform === "win32") for (const [, file] of SUITES) runs.push(await runFixture(file));

for (const [index, [title, file, checks]] of SUITES.entries()) {
  describe.if(process.platform === "win32")(title, () => {
    const { report, output } = runs[index] ?? { report: {}, output: "" };
    const results = checks.map((name) => report[name]);
    const skipped = results.filter((r) => r !== undefined && "skipped" in r).length;
    const ran = results.filter((r) => r !== undefined && !("skipped" in r));
    const passed = ran.filter((r) => (r as { ok: boolean }).ok).length;
    if (process.platform === "win32") {
      console.log(`${file}: ${checks.length} checks: ${ran.length} ran, ${passed} passed, ${ran.length - passed} failed, ${skipped} skipped, ${checks.length - ran.length - skipped} missing`);
    }

    test("the fixture ran every check to the end", () => {
      expect(report["fixture ran to the end"], output).toBeUndefined();
      expect(Object.keys(report).sort(), output).toEqual([...checks].sort());
    });

    for (const name of checks) {
      const result = report[name];
      if (result !== undefined && "skipped" in result) {
        console.log(`skip: ${name}: ${result.skipped}`);
        test.skip(name, () => {});
        continue;
      }
      test(name, () => {
        expect(result, output).toBeDefined();
        expect({ name, ...result }).toEqual({ name, ok: true, detail: (result as { detail?: unknown } | undefined)?.detail });
      });
    }
  });
}
