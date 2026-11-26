// Live Windows tests for WebView.attach, createApp outer-bounds & style preservation,
// ringBytes validation, error-path recovery, and Layer 1 tabbed Window disposal
// (both explicit win.dispose() and default WM_CLOSE).

import { describe, expect, test } from "bun:test";
import { createApp, WebView } from "./index";
import { Window } from "@n1h/sweetview-native";

const onWindows = process.platform === "win32";

describe.if(onWindows)("WebView & createApp (win32)", () => {
  test("WebView.attach rejects invalid ringBytes (below 128, non-power-of-two, > 2^30) without poisoning later attaches", async () => {
    const win = new Window({ title: "Ring Validation", bounds: { x: 100, y: 100, width: 400, height: 300 } });
    try {
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 32 })).rejects.toThrow(/power of two between 128/);
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 200 })).rejects.toThrow(/power of two between 128/);
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 2 ** 31 })).rejects.toThrow(/power of two between 128/);
      // A healthy attach afterward must succeed cleanly.
      const view = await WebView.attach(win, { url: "about:blank", ringBytes: 256 });
      view.dispose();
    } finally {
      win.dispose();
    }
  });

  test("failed WebView.attach (missing asset) discards WM_QUIT so subsequent attaches succeed", async () => {
    const w1 = new Window({ title: "Bad Attach", bounds: { x: 100, y: 100, width: 400, height: 300 } });
    const w2 = new Window({ title: "Good Attach After Failure", bounds: { x: 140, y: 140, width: 400, height: 300 } });
    try {
      await expect(
        WebView.attach(w1, { assets: { "index.html": "C:/definitely-nonexistent-sweetview-test/index.html" } }),
      ).rejects.toThrow();
      const view = await WebView.attach(w2, { url: "about:blank" });
      expect(view.raw.unsafeHandle).not.toBeNull();
      view.dispose();
    } finally {
      w1.dispose();
      w2.dispose();
    }
  });

  test("WebView.attach preserves exact outer bounds and GWL_STYLE for framed, frameless-resizable, and Window.fromHandle windows", async () => {
    const { GWL_STYLE, user32 } = await import("@n1h/sweetview-native/win32/api");
    const { asHwnd } = await import("@n1h/sweetview-native/win32/window");

    // 1. Owned framed window
    const target = { x: 120, y: 120, width: 640, height: 480 };
    const win = new Window({ title: "Attach Bounds", bounds: target });
    const view = await WebView.attach(win, { url: "about:blank" });
    try {
      expect(win.bounds()).toEqual(target);
    } finally {
      view.dispose();
      win.dispose();
    }

    // 2. createApp framed window
    const app = await createApp({ title: "App Bounds", bounds: target, url: "about:blank" });
    try {
      expect(app.window.bounds()).toEqual(target);
    } finally {
      app.dispose();
    }

    // 3. Owned frameless + resizable window keeps exact style (no WS_THICKFRAME) and bounds
    const frameless = new Window({ frame: false, resizable: true, bounds: { x: 100, y: 100, width: 500, height: 400 } });
    const styleBefore = user32.GetWindowLongPtrW(asHwnd(frameless.handle), GWL_STYLE);
    const framelessView = await WebView.attach(frameless, { url: "about:blank" });
    try {
      expect(frameless.bounds()).toEqual({ x: 100, y: 100, width: 500, height: 400 });
      expect(user32.GetWindowLongPtrW(asHwnd(frameless.handle), GWL_STYLE)).toBe(styleBefore);
    } finally {
      framelessView.dispose();
      frameless.dispose();
    }

    // 4. Borrowed Window.fromHandle wrapper keeps exact style and bounds
    const host = new Window({ frame: false, bounds: { x: 110, y: 110, width: 500, height: 400 } });
    const hostStyleBefore = user32.GetWindowLongPtrW(asHwnd(host.handle), GWL_STYLE);
    const borrowed = Window.fromHandle(host.handle);
    const borrowedView = await WebView.attach(borrowed, { url: "about:blank" });
    try {
      expect(host.bounds()).toEqual({ x: 110, y: 110, width: 500, height: 400 });
      expect(user32.GetWindowLongPtrW(asHwnd(host.handle), GWL_STYLE)).toBe(hostStyleBefore);
    } finally {
      borrowedView.dispose();
      borrowed.dispose();
      host.dispose();
    }
  });

  test("Layer 1 tabbed Window.dispose() disposes child tab webviews and blocks later openTab calls", async () => {
    const win = new Window({ title: "Layer 1 Tabs", tabs: true, bounds: { x: 140, y: 140, width: 720, height: 500 } });
    const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
    const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
    expect(t1.webview.raw.unsafeHandle).not.toBeNull();
    expect(t2.webview.raw.unsafeHandle).not.toBeNull();

    win.dispose();
    win.dispose(); // idempotent

    expect(t1.webview.raw.unsafeHandle).toBeNull();
    expect(t2.webview.raw.unsafeHandle).toBeNull();
    await expect(WebView.openTab(win, { title: "Three", url: "about:blank" })).rejects.toThrow(/disposed window/);
  });

  test("closing a tabbed Window via WM_CLOSE with no onClose disposes all child tab webviews", async () => {
    const { user32, WM_CLOSE } = await import("@n1h/sweetview-native/win32/api");
    const { asHwnd } = await import("@n1h/sweetview-native/win32/window");
    const win = new Window({ title: "Close Tabs via WM_CLOSE", tabs: true, bounds: { x: 160, y: 160, width: 720, height: 500 } });
    const hwnd = asHwnd(win.handle);
    const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
    const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });

    user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);

    expect(user32.IsWindow(hwnd)).toBe(0);
    expect(t1.webview.raw.unsafeHandle).toBeNull();
    expect(t2.webview.raw.unsafeHandle).toBeNull();
    await expect(WebView.openTab(win, { title: "Three", url: "about:blank" })).rejects.toThrow(/disposed window/);
  });
});
