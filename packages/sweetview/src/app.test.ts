// Live Windows tests for WebView.attach, createApp outer-bounds & style preservation,
// ringBytes validation, error-path recovery, and Layer 1 tabbed Window disposal
// (both explicit win.dispose() and default WM_CLOSE).

import { describe, expect, test } from "bun:test";
import { createApp, WebView } from "./index";
import { Window, closeToTrayOnLastWindow, onOpenUrl, pumpEvents } from "@n1h/sweetview-native";
import { emitActivationUrl } from "@n1h/sweetview-native/internal";
import { _resetActivationForTest } from "../../sweetview-native/src/activation";

const onWindows = process.platform === "win32";
const liveDesktop = onWindows || process.platform === "darwin";

const htmlBytes = (html: string) => new TextEncoder().encode(html);

function pumpUntil(done: () => boolean, budgetMs = 2000): void {
  const deadline = performance.now() + budgetMs;
  do {
    pumpEvents();
    if (done()) return;
    Bun.sleepSync(5);
  } while (performance.now() < deadline);
}

describe.if(liveDesktop)("desktop startup & deferred RPC", () => {
  test("a native watchdog fires during pumpEvents, loads fallback HTML, and reveals the window", async () => {
    const win = new Window({ noActivate: true });
    let timeouts = 0;
    let fallbackLoaded = false;
    const view = await WebView.attach(win, {
      url: "about:blank",
      showOnReady: true,
      readyTimeoutMs: 30,
      readyFallbackHtml: '<script>window.__sweetview_rpc("fallbackLoaded", null)</script>',
      onReadyTimeout: () => { timeouts++; },
      uiMethods: { fallbackLoaded: () => { fallbackLoaded = true; } },
    });
    try {
      expect(win.isVisible()).toBe(false);
      pumpUntil(() => fallbackLoaded);
      expect(timeouts).toBe(1);
      expect(win.isVisible()).toBe(true);
      expect(fallbackLoaded).toBe(true);
    } finally {
      view.dispose();
      win.dispose();
    }
  });

  test("a native watchdog also fires while webview_run blocks Bun", async () => {
    // A broken watchdog could hang a blocking native run. Bound it from the parent.
    const script = `
      import { createApp } from "@n1h/sweetview";
      let timeouts = 0;
      const app = await createApp({
        url: "about:blank",
        readyTimeoutMs: 30,
        onReadyTimeout: () => { timeouts++; app.quit(); },
      });
      try {
        app.run();
        console.log(JSON.stringify({ timeouts, visible: app.window.isVisible() }));
      } finally {
        app.dispose();
      }
      const next = await createApp({ url: "about:blank" });
      next.dispose();
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit", timeout: 4000 });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ timeouts: 1, visible: false });
  });

  test("the ready handshake drains activation, acknowledges duplicates, and cancels the watchdog", async () => {
    _resetActivationForTest();
    const win = new Window({ noActivate: true });
    const order: string[] = [];
    const offUrl = onOpenUrl((url) => order.push(url));
    const activationUrl = "sweetview-ready-test://queued";
    emitActivationUrl(activationUrl);
    expect(order).toEqual([]);
    let ack: unknown;
    let view: WebView | undefined;
    try {
      view = await WebView.attach(win, {
        assets: { "index.html": htmlBytes(`<script>
          window.__sweetview_rpc("__sweetview.ready", null)
            .then(result => window.__sweetview_rpc("__sweetview.ready", null).then(duplicate =>
              window.__sweetview_rpc("capture", [result, duplicate])));
        </script>`) },
        showOnReady: true,
        readyTimeoutMs: 1000,
        onReady: () => order.push("ready"),
        onReadyTimeout: () => order.push("timeout"),
        uiMethods: { capture: (params: unknown) => { ack = params; } },
      });
      expect(win.isVisible()).toBe(false);
      pumpUntil(() => ack !== undefined);
      expect(ack).toEqual([null, null]);
      expect(order).toEqual([activationUrl, "ready"]);
      expect(win.isVisible()).toBe(true);
      // Run past the original deadline with Bun's event loop blocked.
      pumpUntil(() => order.includes("timeout"), 1050);
      expect(order).toEqual([activationUrl, "ready"]);
    } finally {
      offUrl();
      _resetActivationForTest();
      view?.dispose();
      win.dispose();
    }
  });

  test("keeps startup behavior opt-in and cancels an armed watchdog on disposal", async () => {
    const win = new Window({ noActivate: true });
    let timeouts = 0;
    let view: WebView | undefined;
    try {
      view = await WebView.attach(win, { url: "about:blank", onReadyTimeout: () => { timeouts++; } });
      pumpUntil(() => win.isVisible(), 50);
      expect(win.isVisible()).toBe(false);
      expect(timeouts).toBe(0);
      view.dispose();
      view = await WebView.attach(win, {
        url: "about:blank",
        showOnReady: true,
        readyTimeoutMs: 30,
        onReadyTimeout: () => { timeouts++; },
      });
      view.dispose();
      pumpUntil(() => win.isVisible(), 60);
      expect(timeouts).toBe(0);
      expect(win.isVisible()).toBe(false);
    } finally {
      view?.dispose();
      win.dispose();
    }
  });

  test("dispatches deferred RPCs without reentering a running UI handler", async () => {
    const win = new Window();
    const calls: string[] = [];
    let result: unknown;
    const view = await WebView.attach(win, {
      assets: { "index.html": htmlBytes(`<script>
        const rpc = window.__sweetview_rpc;
        Promise.all([
          rpc("modal", "first"),
          rpc("modal", "second"),
          rpc("bad", null).catch(error => error.message),
        ]).then(values => rpc("capture", values));
      </script>`) },
      uiMethods: { capture: (params: unknown) => { result = params; } },
      deferredUiMethods: {
        modal: (params: unknown) => {
          calls.push(`open ${params}`);
          pumpUntil(() => false, 30);
          calls.push(`close ${params}`);
          return params;
        },
        bad: () => Promise.reject(new Error("async UI code")),
      },
    });
    try {
      pumpUntil(() => result !== undefined);
      expect(calls).toEqual(["open first", "close first", "open second", "close second"]);
      expect(result).toEqual(["first", "second", expect.stringContaining("must return synchronously")]);
    } finally {
      view.dispose();
      win.dispose();
    }
  });

  test("rejects duplicate UI method names before attaching", async () => {
    const win = new Window();
    try {
      await expect(WebView.attach(win, {
        url: "about:blank",
        uiMethods: { duplicate: () => null },
        deferredUiMethods: { duplicate: () => null },
      })).rejects.toThrow(/duplicate is defined in both uiMethods and deferredUiMethods/);
    } finally {
      win.dispose();
    }
  });
});

describe.if(onWindows)("WebView & createApp (win32)", () => {
  test("close-to-tray can intercept the default close on a createApp window", async () => {
    const { WM_CLOSE, user32 } = await import("@n1h/sweetview-native/win32/api");
    const app = await createApp({ url: "about:blank", noActivate: true });
    const hwnd = BigInt(app.window.handle!);
    let hides = 0;
    const unsubscribe = closeToTrayOnLastWindow(app.window, () => { hides++; });
    try {
      app.window.show();
      user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
      expect(hides).toBe(1);
      expect(app.window.isVisible()).toBe(false);
      expect(user32.IsWindow(hwnd)).not.toBe(0);
      expect(app.webview?.raw.unsafeHandle).not.toBeNull();
    } finally {
      unsubscribe();
      app.dispose();
    }
  });
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
