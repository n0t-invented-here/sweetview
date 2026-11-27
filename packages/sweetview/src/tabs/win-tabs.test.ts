// Live Windows tests of tabbed windows (`new Window({ tabs: true })`,
// `WebView.openTab`, `Tab`): one per behaviour of "Behaviour: tabs on
// Windows" (rust-rewrite/reference/v1-drafting-tabs-and-window.md) that the
// other tab tests do not cover. They run in test/fixtures/win-tabs.ts, a
// process of its own with a WebView2 profile of its own; each test reads its
// check from that run's report.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Check = { ok: boolean; detail?: unknown } | { skipped: string };

const CHECKS = [
  "backdrop: the strip and the page areas in their own colours (light)",
  "backdrop: the strip and the page areas in their own colours (dark)",
  "frame styles",
  "system menu",
  "frame metrics: a 1040 x 720 page plus the strip, the caption removed, the system border kept",
  "resize edges: left, right, bottom and the bottom corners",
  "default minimum size: a 560 x 420 page plus the strip and the frame",
  "dark appearance: dark title bar",
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
  "a tab whose webview is disposed directly leaves its window, which shows another tab",
  "the strip's close button asks the window's onClose listeners",
  "shortcut Alt+F4 closes the window",
  "last tab: an onClose listener intercepts, the tab stays",
  "last tab: with no listener the window closes with it",
  "tear-off: the tab's webview moves to a new window with its page as it was",
  "merge: the tab comes back with its page as it was, the emptied window closes",
  "merge: the window keeps its selected tab on show",
  "a file dropped on a torn-off tab's webview goes to its new window",
  "a file dropped on a merged tab's webview goes to the window it joined",
  "a popup opens as a tab after its opener",
  "the popup tab's title follows its page",
  "a popup to another scheme is dropped",
  "failed load: the tab shows the page with the address",
  "tab menu items",
  "system menu on the strip: Restore off and Move, Size, Minimize, Maximize, Close on while not maximised",
  "choosing Close tab in the tab menu closes that tab",
  "maximised with the caption removed: the page fills the work area, the strip at its top",
  "the strip is told the window is maximised",
  "the strip and the page follow a resize",
  "strip minimise",
  "focus returns to the page after a strip action",
  "file drops on the frame",
  "topmost",
  "opacity",
  "hideFromTaskbar",
  "noActivate",
  "minimum size given as the outer frame",
  "a system frame follows the strip's report of the system theme",
  "an explicit appearance ignores the system",
];

describe.if(process.platform === "win32")("tabbed windows (win32, live)", () => {
  let report: Record<string, Check> = {};
  let output = "";

  beforeAll(async () => {
    const profile = mkdtempSync(join(tmpdir(), "sweetview-win-tabs-"));
    try {
      const fixture = fileURLToPath(new URL("../../test/fixtures/win-tabs.ts", import.meta.url));
      const proc = Bun.spawn([process.execPath, fixture], {
        timeout: 150_000,
        env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      output = `exit ${code}\n${stdout}\n${stderr}`;
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
      if (line) report = JSON.parse(line.slice("RESULT ".length));
    } finally {
      // WebView2's browser processes can hold the profile a moment after the fixture exits.
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {}
    }
  }, 180_000);

  test("the fixture ran every check to the end", () => {
    expect(report["fixture ran to the end"], output).toBeUndefined();
    expect(Object.keys(report).sort(), output).toEqual([...CHECKS].sort());
  });

  for (const name of CHECKS) {
    test(name, () => {
      const result = report[name];
      expect(result, output).toBeDefined();
      if (result && "skipped" in result) {
        console.log(`skipped: ${name}: ${result.skipped}`);
        return;
      }
      expect({ name, ...result }).toEqual({ name, ok: true, detail: result?.detail });
    });
  }
});
