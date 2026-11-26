// Live Windows tests for WebView.attach, createApp outer-bounds & style preservation,
// ringBytes validation, error-path recovery, and Layer 1 tabbed Window disposal
// (both explicit win.dispose() and default WM_CLOSE), and their live macOS
// counterparts on NSWindow and WKWebView.

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

describe.if(process.platform === "darwin")("WebView, createApp & tabs (darwin)", () => {
  const NSStatusWindowLevel = 25n;
  const objc = () => import("@n1h/sweetview-native/darwin/objc");
  const styleMaskOf = async (win: Window) => {
    const { asId, sel, sendInt } = await objc();
    return BigInt(sendInt(asId(win.handle as bigint), sel("styleMask")) ?? -1);
  };
  // Tab closes finish on a Bun timer (after AppKit's windowWillClose:), so the
  // wait yields to Bun's loop as well as pumping AppKit's.
  const settle = async (done: () => boolean, budgetMs = 3000) => {
    for (const end = performance.now() + budgetMs; performance.now() < end; await Bun.sleep(10)) {
      pumpEvents();
      if (done()) return true;
    }
    return done();
  };

  test("WebView.attach rejects invalid ringBytes without poisoning later attaches", async () => {
    const win = new Window({ title: "Ring Validation", bounds: { x: 100, y: 100, width: 400, height: 300 }, noActivate: true });
    try {
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 32 })).rejects.toThrow(/power of two between 128/);
      await expect(WebView.attach(win, { url: "about:blank", ringBytes: 200 })).rejects.toThrow(/power of two between 128/);
      const view = await WebView.attach(win, { url: "about:blank", ringBytes: 256 });
      expect(view.raw.unsafeHandle).not.toBeNull();
      view.dispose();
    } finally {
      win.dispose();
    }
  });

  test("WebView.attach preserves outer bounds and the NSWindow styleMask for framed, frameless, and Window.fromHandle windows", async () => {
    const target = { x: 120, y: 120, width: 640, height: 480 };
    const win = new Window({ title: "Attach Bounds", bounds: target, noActivate: true });
    const framedMask = await styleMaskOf(win);
    const view = await WebView.attach(win, { url: "about:blank" });
    try {
      expect(win.bounds()).toEqual(target);
      expect(await styleMaskOf(win)).toBe(framedMask);
    } finally {
      view.dispose();
      win.dispose();
    }

    // A frameless window stays borderless (styleMask 0) through the attach and after it is shown.
    const bounds = { x: 100, y: 100, width: 500, height: 400 };
    const frameless = new Window({ frame: false, bounds, noActivate: true });
    expect(await styleMaskOf(frameless)).toBe(0n);
    const framelessView = await WebView.attach(frameless, { url: "about:blank" });
    try {
      expect(await styleMaskOf(frameless)).toBe(0n);
      expect(frameless.bounds()).toEqual(bounds);
      frameless.show();
      pumpUntil(() => frameless.isVisible());
      expect(await styleMaskOf(frameless)).toBe(0n);
      expect(frameless.bounds()).toEqual(bounds);
    } finally {
      framelessView.dispose();
      frameless.dispose();
    }

    // A borrowed Window.fromHandle wrapper leaves the host's style and bounds alone.
    const host = new Window({ frame: false, bounds, noActivate: true });
    const borrowed = Window.fromHandle(host.handle);
    const borrowedView = await WebView.attach(borrowed, { url: "about:blank" });
    try {
      expect(await styleMaskOf(host)).toBe(0n);
      expect(host.bounds()).toEqual(bounds);
    } finally {
      borrowedView.dispose();
      borrowed.dispose();
      host.dispose();
    }
  });

  test("a tabbed Window shown before its first tab reveals the tabs, and setTopmost and Screen.of follow the tab windows", async () => {
    const { asId, sel, sendInt, sendRetBool } = await objc();
    const { Screen } = await import("@n1h/sweetview-native");
    const win = new Window({ title: "Tabs", tabs: true, bounds: { x: 140, y: 140, width: 720, height: 500 }, noActivate: true });
    try {
      win.show(); // before any tab exists
      const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
      const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
      const tabWindows = [t1, t2].map((tab) => asId(tab.webview.window.handle as bigint));
      expect(await settle(() => win.isVisible() && tabWindows.every((w) => Boolean(sendRetBool(w, sel("isVisible")))))).toBe(true);

      win.setTopmost(true);
      expect(tabWindows.map((w) => BigInt(sendInt(w, sel("level")) ?? -1))).toEqual([NSStatusWindowLevel, NSStatusWindowLevel]);
      win.setTopmost(false);
      expect(tabWindows.map((w) => BigInt(sendInt(w, sel("level")) ?? -1))).toEqual([0n, 0n]);

      const screen = Screen.of(win);
      expect(screen.bounds.width).toBeGreaterThan(0);
      expect(screen.scale).toBeGreaterThan(0);

      // With no mouse button down these do nothing, and must not throw.
      win.startResize("right");
      pumpEvents();
      expect(win.bounds().width).toBe(720);
    } finally {
      win.dispose();
    }
  });

  test("startResize and startDrag act only while the left mouse button is down", async () => {
    // The button state AppKit reports and NSWindow's own drag entry point are
    // replaced for the test, so no real input is needed. The cursor is moved
    // with CGWarpMouseCursorPosition, which posts no events, and put back.
    const { dlopen, FFIType, JSCallback } = await import("bun:ffi");
    const { asId, cls, sel, send, NIL } = await objc();
    const { Screen } = await import("@n1h/sweetview-native");
    const { u64, f64, i64, i16 } = FFIType;
    const runtime = dlopen("/usr/lib/libobjc.A.dylib", {
      class_getClassMethod: { args: [u64, u64], returns: u64 },
      class_getInstanceMethod: { args: [u64, u64], returns: u64 },
      method_setImplementation: { args: [u64, u64], returns: u64 },
    }).symbols;
    // +[NSEvent otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:]
    const makeEvent = dlopen("/usr/lib/libobjc.A.dylib", {
      objc_msgSend: { args: [u64, u64, u64, f64, f64, u64, f64, i64, u64, i16, i64, i64], returns: u64 },
    }).symbols.objc_msgSend;
    const { CGWarpMouseCursorPosition } = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGWarpMouseCursorPosition: { args: [f64, f64], returns: FFIType.i32 },
    }).symbols;

    let buttons = 0n;
    const pressedStub = new JSCallback(() => buttons, { args: [u64, u64], returns: u64 });
    const drags: bigint[] = [];
    const dragStub = new JSCallback((_self: bigint, _cmd: bigint, event: bigint) => void drags.push(BigInt(event)), { args: [u64, u64, u64], returns: FFIType.void });
    const pressedMethod = runtime.class_getClassMethod(cls("NSEvent"), sel("pressedMouseButtons"));
    const dragMethod = runtime.class_getInstanceMethod(cls("NSWindow"), sel("performWindowDragWithEvent:"));
    expect(pressedMethod).not.toBe(0n);
    expect(dragMethod).not.toBe(0n);
    const realPressed = runtime.method_setImplementation(pressedMethod, BigInt(pressedStub.ptr!));
    const realDrag = runtime.method_setImplementation(dragMethod, BigInt(dragStub.ptr!));

    const home = Screen.cursor();
    const moveCursor = (dx: number) => CGWarpMouseCursorPosition(home.x + dx, home.y);
    const bounds = { x: 300, y: 300, width: 400, height: 300 };
    const win = new Window({ frame: false, resizable: true, bounds, noActivate: true });
    const widthAfter = async (ms = 120) => {
      for (const end = performance.now() + ms; performance.now() < end; await Bun.sleep(10)) pumpEvents();
      return win.bounds().width;
    };
    try {
      win.show();
      await settle(() => win.isVisible());

      // Right button only: no resize gesture starts.
      buttons = 2n;
      win.startResize("right");
      moveCursor(40);
      expect(await widthAfter()).toBe(400);

      // Left button: the right edge follows the cursor.
      moveCursor(0);
      buttons = 1n;
      win.startResize("right");
      moveCursor(40);
      expect(await settle(() => win.bounds().width === 440)).toBe(true);
      moveCursor(60);
      expect(await settle(() => win.bounds().width === 460)).toBe(true);
      expect(win.bounds().x).toBe(300);

      // Released: the gesture ends, and the cursor no longer moves the edge.
      buttons = 0n;
      await widthAfter(60);
      moveCursor(120);
      expect(await widthAfter()).toBe(460);

      // startDrag hands AppKit the current event only while the left button is down.
      const event = asId(makeEvent(cls("NSEvent"), sel("otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:"), 15n, 0, 0, 0n, 0, 0n, NIL, 0, 0n, 0n));
      expect(event).not.toBe(NIL);
      const postEvent = dlopen("/usr/lib/libobjc.A.dylib", { objc_msgSend: { args: [u64, u64, u64, FFIType.bool], returns: FFIType.void } }).symbols.objc_msgSend;
      postEvent(asId(send(cls("NSApplication"), sel("sharedApplication"))), sel("postEvent:atStart:"), event, true);
      pumpEvents();
      for (const down of [0n, 2n]) {
        buttons = down;
        win.startDrag();
      }
      expect(drags).toEqual([]);
      buttons = 1n;
      win.startDrag();
      expect(drags).toHaveLength(1);
      expect(drags[0]).not.toBe(NIL);
    } finally {
      runtime.method_setImplementation(pressedMethod, realPressed);
      runtime.method_setImplementation(dragMethod, realDrag);
      CGWarpMouseCursorPosition(home.x, home.y);
      win.dispose();
    }
  });

  test("tab.close() closes a window's last tab, fires onTabClose, then asks the window's onClose listeners", async () => {
    const win = new Window({ title: "Last Tab", tabs: true, bounds: { x: 150, y: 150, width: 720, height: 500 }, noActivate: true });
    const events: string[] = [];
    win.onTabClose((tab) => events.push(`tab:${tab.title}`));
    win.onClose(() => events.push("window"));
    try {
      const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
      const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
      win.show();
      await settle(() => win.isVisible());
      t2.close();
      expect(await settle(() => events.length === 1)).toBe(true);
      expect(events).toEqual(["tab:Two"]);
      expect(t2.webview.raw.unsafeHandle).toBeNull();
      t1.close();
      expect(await settle(() => events.length === 3)).toBe(true);
      expect(events).toEqual(["tab:Two", "tab:One", "window"]);
      expect(t1.webview.raw.unsafeHandle).toBeNull();
    } finally {
      win.dispose();
    }
  });

  test("a tab survives its webview being disposed directly, and the library's UIDelegate is restored first", async () => {
    const { asId, jsString, sel, send } = await objc();
    const { hostedWebView } = await import("./tabs/darwin-webview");
    const className = (object: bigint) => jsString(asId(send(object, sel("className"))));
    const win = new Window({ title: "Direct Dispose", tabs: true, bounds: { x: 160, y: 160, width: 720, height: 500 }, noActivate: true });
    const closed: string[] = [];
    win.onTabClose((tab) => closed.push(tab.title));
    try {
      const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
      const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
      win.show();
      await settle(() => win.isVisible());
      const wkWebView = hostedWebView(asId(t1.webview.window.handle as bigint))!;
      // A tab's WKWebView is the library's subclass, behind the tab driver's UIDelegate.
      expect(className(wkWebView)).toBe("SweetviewWKWebView");
      expect(className(asId(send(wkWebView, sel("UIDelegate"))))).toBe("SweetviewTabUIDelegate");

      t1.webview.dispose();
      t1.webview.dispose(); // idempotent
      expect(t1.webview.raw.unsafeHandle).toBeNull();
      expect(t2.webview.raw.unsafeHandle).not.toBeNull();
      t1.close();
      expect(await settle(() => closed.length === 1)).toBe(true);
      expect(closed).toEqual(["One"]);
    } finally {
      win.dispose();
    }
  });

  test("tabbed Window.dispose() disposes its tabs' webviews, leaves a torn-off tab alone, and blocks later openTab calls", async () => {
    const win = new Window({ title: "Layer 1 Tabs", tabs: true, bounds: { x: 170, y: 170, width: 720, height: 500 }, noActivate: true });
    const t1 = await WebView.openTab(win, { title: "One", url: "about:blank" });
    const t2 = await WebView.openTab(win, { title: "Two", url: "about:blank" });
    const t3 = await WebView.openTab(win, { title: "Three", url: "about:blank" });
    win.show();
    await settle(() => win.isVisible());
    const detached = await t3.moveToNewWindow();
    try {
      expect(detached).not.toBe(win);
      expect(t3.window).toBe(detached);
      expect(await settle(() => detached.isVisible())).toBe(true);

      win.dispose();
      win.dispose(); // idempotent
      expect(t1.webview.raw.unsafeHandle).toBeNull();
      expect(t2.webview.raw.unsafeHandle).toBeNull();
      expect(t3.webview.raw.unsafeHandle).not.toBeNull();
      await expect(WebView.openTab(win, { title: "Four", url: "about:blank" })).rejects.toThrow(/disposed window/);
    } finally {
      detached.dispose();
    }
    expect(t3.webview.raw.unsafeHandle).toBeNull();
  });
});
