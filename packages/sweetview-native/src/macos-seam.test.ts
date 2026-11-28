// The macOS seams, decided on any machine: until the macOS goal of the Rust rewrite, macOS keeps
// the path it had at the tag `pre-rust-rewrite` (rust-rewrite/HANDOFF-macos.md, section 8).
// `test/fixtures/macos-seam.ts` runs in its own process that says it is macOS and stands in a
// module for @n1h/sweetview-webview-bun; nothing reaches AppKit or a webview, and no window opens.

import { describe, expect, test } from "bun:test";
import { runFixture } from "../test/run-fixture";

const MISSING = "sweetview: on macOS the webview needs the package @n1h/sweetview-webview-bun, which could not be loaded: Cannot find package '@n1h/sweetview-webview-bun'";

describe("on macOS, until the macOS goal", () => {
  test("importing the native package does not need @n1h/sweetview-webview-bun; the webview, a hook and a permission ask for it when used", async () => {
    const { r, exitCode } = await runFixture("macos-seam.ts", ["absent"]);
    expect(exitCode).toBe(0);
    expect(r.platform).toBe("darwin");
    expect(r.importError).toBeNull();
    expect(r.webviewError).toBe(MISSING);
    expect(r.mouseHookError).toBe(MISSING);
    expect(r.permissionsError).toBe(MISSING);
  });

  test("the window code the Windows goal added is held back: contentSize is not used, onMaximizeChange registers nothing, and the demos pass the outer frame they passed at the tag", async () => {
    // Review finding 8 and N2.
    const { r } = await runFixture("macos-seam.ts", ["fake"]);
    expect(r.windowCode).toEqual({ contentSize: null, maximizeEvents: false });
    expect(r.demoWindowSize).toEqual({ bounds: { x: 410, y: 140, width: 1100, height: 800 } });
    // Review round 2, finding 6: no check of the Windows goal's options runs on macOS.
    expect(r.windowValidation).toEqual([]);
    // Round 3, measure C: the window chrome's table is the tag's (no window.systemMenu, which would
    // replace an application's own method of that name with one that does nothing).
    expect(r.chromeMethods).toEqual(["window.close", "window.drag", "window.info", "window.maximize", "window.minimize", "window.resize"]);
  });

  test("a WebView's window is an own enumerable property after raw, as at the tag; on Windows it is the accessor a tab's window follows", async () => {
    // Review round 5, R5-6.
    const { r } = await runFixture("macos-seam.ts", ["fake"]);
    expect(r.webviewWindowProperty).toEqual({ keys: ["raw", "window"], own: true, spread: true, isTheWindow: true });
    if (process.platform === "win32") {
      const { webviewWindowShape } = await import("../test/webview-window-shape");
      expect(webviewWindowShape(await import("../../sweetview/src/app"))).toEqual({ keys: ["raw"], own: false, spread: false, isTheWindow: true });
    }
  });

  test("the reveal's drawn handshake is off: no request is made, and a method named __sweetview.drawn is the application's, as at the tag", async () => {
    // Review round 2 of D49, T2.
    const { r } = await runFixture("macos-seam.ts", ["fake"]);
    expect(r.drawnHandshake).toBe(false);
  });

  test("nothing is registered for release at exit, and no exit listener is added", async () => {
    const { r } = await runFixture("macos-seam.ts", ["fake"]);
    expect(r.lifetime).toEqual({ exitListenersAdded: 0, released: 0, macosKeepsTagPath: true });
  });

  test("a window handle reaches the library's Webview as a number, as createApp passed it at the tag", async () => {
    const { r } = await runFixture("macos-seam.ts", ["fake"]);
    expect(r.webviewWindow).toEqual([
      { type: "number", value: 0x1234 },
      { type: "number", value: 77 },
      { type: "object", value: null },
    ]);
  });

  test("onCallbackError calls no listener: every catch prints the line it printed on the main branch", async () => {
    const { r } = await runFixture("macos-seam.ts", ["fake"]);
    expect(r.callbackErrors).toEqual({
      told: [],
      printed: [
        ["sweetview: message window handler threw:", "mac boom"],
        ["sweetview: onClose handler threw:", "mac close"],
      ],
    });
  });

  test("hooks, permissions and the any-thread calls go to the library, each when called", async () => {
    const { r } = await runFixture("macos-seam.ts", ["fake"]);
    expect(r.permissions).toEqual({ status: "granted", request: "missing", ready: true, needed: [1], autoRequest: false });
    expect(r.calls).toEqual([
      ["installMouseHook", "function"],
      ["mouseHook.dispose"],
      ["installKeyboardHook", "function"],
      ["keyboardHook.dispose"],
      ["permissions.autoRequest=", false],
      ["permissions.status", 1],
      ["permissions.request", 2],
      ["permissions.ready", 0],
      ["permissions.needed", 0],
      ["permissions.needed", 1],
      ["completeWebviewRequest", 9, "3n", { status: 204 }],
    ]);
  });
});
