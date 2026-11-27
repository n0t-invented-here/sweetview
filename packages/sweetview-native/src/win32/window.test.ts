// Live Win32 FFI tests for the unified Window class (createWindow, fromHandle,
// disposal, multi-window close without killing the loop, events, maximize).
// Windows only; creates hidden windows so nothing flashes on screen.

import { describe, expect, test } from "bun:test";
import { defineAppIdentity } from "@n1h/sweetview-settings";
import { Screen } from "../screen";
import { closeToTrayOnLastWindow, createWindow, getWindowMeta, holdWindowNativeDispose, isWindowDisposed, onWindowDispose, Window } from "../window";

const onWindows = process.platform === "win32";

describe.if(onWindows)("win32 Window", () => {
  test("close-to-tray destroys the secondary window and hides the last visible owned window", async () => {
    const { WM_CLOSE, user32 } = await import("../../test/win32-os");
    const main = new Window({ title: "Main", noActivate: true });
    const secondary = new Window({ title: "Secondary", noActivate: true });
    const hidden = new Window();
    const borrowed = Window.fromHandle(main.handle);
    let hiddenWindow: Window | undefined;
    const offMain = closeToTrayOnLastWindow(main, (win) => { hiddenWindow = win; });
    const offSecondary = closeToTrayOnLastWindow(secondary, (win) => { hiddenWindow = win; });
    try {
      expect(Window.visibleWindows()).not.toContain(hidden);
      main.show();
      main.minimize();
      secondary.show();
      expect(Window.visibleWindows()).toContain(main);
      expect(Window.visibleWindows()).toContain(secondary);
      expect(Window.visibleWindows()).not.toContain(borrowed);
      user32.SendMessageW(BigInt(secondary.handle!), WM_CLOSE, 0n, 0n);
      expect(user32.IsWindow(BigInt(secondary.handle!))).toBe(0);
      expect(Window.visibleWindows()).not.toContain(secondary);
      expect(hiddenWindow).toBeUndefined();
      user32.SendMessageW(BigInt(main.handle!), WM_CLOSE, 0n, 0n);
      expect(user32.IsWindow(BigInt(main.handle!))).not.toBe(0);
      expect(hiddenWindow).toBe(main);
      expect(Window.visibleWindows()).not.toContain(main);
    } finally {
      offMain();
      offSecondary();
      borrowed.dispose();
      hidden.dispose();
      secondary.dispose();
      main.dispose();
    }
  });

  test("identity sets a window's title and icon, and explicit options win", async () => {
    const { user32 } = await import("../../test/win32-os");
    const identity = defineAppIdentity({
      appId: "com.example.shell",
      appName: "Example Shell",
      icon: { width: 2, height: 1, rgba: new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255]) },
    });
    const win = new Window({ identity });
    const override = new Window({ identity, title: "Override", icon: {} });
    try {
      expect(getWindowMeta(win).title).toBe("Example Shell");
      expect(user32.SendMessageW(BigInt(win.handle!), 0x007f, 1n, 0n)).not.toBe(0n); // WM_GETICON, ICON_BIG
      expect(getWindowMeta(override).title).toBe("Override");
      expect(getWindowMeta(override).icon).toEqual({});
    } finally {
      win.dispose();
      override.dispose();
    }
  });

  test("delivers Unicode file drops and cleans up owned, tabbed and borrowed listeners", async () => {
    const { GWL_EXSTYLE, kernel32, ownWindow, sendDrop, user32 } = await import("../../test/win32-os");
        const { _debugTrackedCount } = await import("./window");
    const paths = ["C:\\example\\日本語 🥐.txt", "C:\\example\\second.bin"];
    const native = ownWindow();
    const owned = new Window();
    const tabs = new Window({ tabs: true });
    const borrowed = Window.fromHandle(native.hwnd);
    try {
      for (const win of [owned, tabs, borrowed]) {
        const hwnd = BigInt(win.handle!);
        const tracked = _debugTrackedCount(hwnd);
        const delivered: string[][] = [];
        const off = win.onFileDrop((files) => delivered.push(files));
        expect(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & 0x10n).toBe(0x10n); // WS_EX_ACCEPTFILES
        const drop = sendDrop(hwnd, paths);
        expect(delivered).toEqual([paths]);
        expect(kernel32.GlobalSize(drop)).toBe(0n);
        off();
        off();
        expect(user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & 0x10n).toBe(0n);
        expect(_debugTrackedCount(hwnd)).toBe(tracked);
        win.onFileDrop(() => {});
        win.dispose();
        expect(_debugTrackedCount(hwnd)).toBe(0);
      }
      expect(user32.IsWindow(native.hwnd)).not.toBe(0);
      expect(user32.GetWindowLongPtrW(native.hwnd, GWL_EXSTYLE) & 0x10n).toBe(0n);
    } finally {
      owned.dispose();
      tabs.dispose();
      borrowed.dispose();
      native.destroy();
    }
  });
  test("creates hidden framed and frameless windows and disposes cleanly & idempotently", async () => {
    const { user32 } = await import("../../test/win32-os");
    const { _debugTrackedCount, asHwnd } = await import("./window");

    const framed = new Window({ title: "Test Framed", bounds: { x: 100, y: 100, width: 400, height: 300 } });
    const frameless = createWindow({ title: "Test Frameless", frame: false, transparent: true, bounds: { x: 120, y: 120, width: 200, height: 150 } });
    const h1 = asHwnd(framed.handle);
    const h2 = asHwnd(frameless.handle);

    expect(framed.isVisible()).toBe(false);
    expect(frameless.isVisible()).toBe(false);
    expect(user32.IsWindow(h1)).not.toBe(0);
    expect(user32.IsWindow(h2)).not.toBe(0);
    expect(framed.bounds()).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(frameless.bounds()).toEqual({ x: 120, y: 120, width: 200, height: 150 });
    expect(framed.scale()).toBeGreaterThan(0);

    framed.dispose();
    framed.dispose(); // idempotent
    expect(user32.IsWindow(h1)).toBe(0);
    expect(_debugTrackedCount(h1)).toBe(0);
    expect(user32.IsWindow(h2)).not.toBe(0);

    frameless.dispose();
    expect(user32.IsWindow(h2)).toBe(0);
    expect(_debugTrackedCount(h2)).toBe(0);
  });

  test("closing one window disposes it without posting WM_QUIT to kill the app loop", async () => {
    const { user32, WM_CLOSE } = await import("../../test/win32-os");
    const { pumpEvents } = await import("./event-loop");
    const { _debugTrackedCount, asHwnd } = await import("./window");

    const w1 = new Window({ title: "Close Me" });
    const w2 = new Window({ title: "Stay Alive" });
    const h1 = asHwnd(w1.handle);
    const h2 = asHwnd(w2.handle);
    try {
      user32.SendMessageW(h1, WM_CLOSE, 0n, 0n);
      expect(user32.IsWindow(h1)).toBe(0);
      expect(_debugTrackedCount(h1)).toBe(0);
      expect(user32.IsWindow(h2)).not.toBe(0);
      // Must NOT have posted WM_QUIT
      expect(pumpEvents()).toBe(true);
    } finally {
      w1.dispose();
      w2.dispose();
    }
  });

  test("onClose intercepts WM_CLOSE and unsubscribing restores default close-and-dispose", async () => {
    const { user32, WM_CLOSE } = await import("../../test/win32-os");
    const { asHwnd } = await import("./window");

    const win = new Window({ title: "Intercept Close" });
    const hwnd = asHwnd(win.handle);
    let closes = 0;
    const off = win.onClose(() => closes++);
    try {
      user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
      expect(closes).toBe(1);
      expect(user32.IsWindow(hwnd)).not.toBe(0);

      off();
      user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
      expect(closes).toBe(1);
      expect(user32.IsWindow(hwnd)).toBe(0);
    } finally {
      win.dispose();
    }
  });

  test("a native-dispose hold keeps the HWND until the last hold is released (dispose() and WM_CLOSE)", async () => {
    const { user32, WM_CLOSE } = await import("../../test/win32-os");
    const { asHwnd } = await import("./window");

    for (const close of ["dispose", "WM_CLOSE"] as const) {
      const win = new Window({ title: `Held ${close}` });
      const hwnd = asHwnd(win.handle);
      let hooks = 0;
      onWindowDispose(win, () => hooks++);
      const releaseA = holdWindowNativeDispose(win);
      const releaseB = holdWindowNativeDispose(win);
      try {
        if (close === "dispose") win.dispose();
        else user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
        // Disposal is observable at once; only the native window waits.
        expect(isWindowDisposed(win)).toBe(true);
        expect(hooks).toBe(1);
        expect(Window.visibleWindows()).not.toContain(win);
        expect(user32.IsWindow(hwnd)).not.toBe(0);
        win.dispose();
        releaseA();
        releaseA();
        expect(user32.IsWindow(hwnd)).not.toBe(0);
        releaseB();
        expect(user32.IsWindow(hwnd)).toBe(0);
        expect(hooks).toBe(1);
      } finally {
        releaseA();
        releaseB();
        win.dispose();
      }
    }

    // Releasing a hold on a window that was never disposed leaves it alive.
    const live = new Window({ title: "Held live" });
    const liveHwnd = asHwnd(live.handle);
    try {
      holdWindowNativeDispose(live)();
      expect(user32.IsWindow(liveHwnd)).not.toBe(0);
    } finally {
      live.dispose();
    }
    expect(user32.IsWindow(liveHwnd)).toBe(0);
  });

  test("onResize and onMove fire with outer bounds and stop after unsubscribe", () => {
    const win = new Window({ title: "Events", bounds: { x: 100, y: 100, width: 300, height: 200 } });
    const resizes: { width: number; height: number }[] = [];
    const moves: { x: number; y: number }[] = [];
    const offResize = win.onResize((b) => resizes.push({ width: b.width, height: b.height }));
    const offMove = win.onMove((b) => moves.push({ x: b.x, y: b.y }));
    try {
      win.resize(420, 310);
      expect(resizes.length).toBeGreaterThanOrEqual(1);
      expect(resizes.at(-1)).toEqual({ width: 420, height: 310 });

      win.moveTo(180, 160);
      expect(moves.length).toBeGreaterThanOrEqual(1);
      expect(moves.at(-1)).toEqual({ x: 180, y: 160 });

      const rCount = resizes.length;
      const mCount = moves.length;
      offResize();
      offMove();
      win.setBounds({ x: 200, y: 200, width: 500, height: 350 });
      expect(resizes.length).toBe(rCount);
      expect(moves.length).toBe(mCount);
    } finally {
      win.dispose();
    }
  });

  test("frameless toggleMaximize uses the window's own monitor workArea and restores bounds", () => {
    const win = new Window({ frame: false, bounds: { x: 110, y: 120, width: 320, height: 240 } });
    try {
      expect(win.isMaximized()).toBe(false);
      const expectedWorkArea = Screen.of(win).workArea;
      win.toggleMaximize();
      expect(win.isMaximized()).toBe(true);
      expect(win.bounds()).toEqual(expectedWorkArea);

      win.toggleMaximize();
      expect(win.isMaximized()).toBe(false);
      expect(win.bounds()).toEqual({ x: 110, y: 120, width: 320, height: 240 });
    } finally {
      win.dispose();
    }
  });

  test("Window.fromHandle intercepts events non-mutatingly and dispose does not destroy the external HWND", async () => {
    const { ownWindow, user32, WM_CLOSE } = await import("../../test/win32-os");
    const msg = ownWindow();
    try {
      const wrapped = Window.fromHandle(msg.hwnd);
      let closes = 0;
      wrapped.onClose(() => closes++);
      user32.SendMessageW(msg.hwnd, WM_CLOSE, 0n, 0n);
      expect(closes).toBe(1);
      wrapped.dispose();
      // External HWND still exists after wrapper dispose
      expect(user32.IsWindow(msg.hwnd)).not.toBe(0);
      user32.SendMessageW(msg.hwnd, WM_CLOSE, 0n, 0n);
      expect(closes).toBe(1);
    } finally {
      msg.destroy();
    }
  });

  test("tabbed windows honor topmost on creation and setTopmost afterwards", async () => {
    const { GWL_EXSTYLE, user32 } = await import("../../test/win32-os");
    const win = new Window({ tabs: true, topmost: true });
    try {
      const hwnd = BigInt(win.handle!);
      const topmost = () => (user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & 0x8n) !== 0n; // WS_EX_TOPMOST
      expect(topmost()).toBe(true);
      expect(getWindowMeta(win).topmost).toBe(true);
      win.setTopmost(false);
      expect(topmost()).toBe(false);
      expect(getWindowMeta(win).topmost).toBe(false);
      win.setTopmost(true);
      expect(topmost()).toBe(true);
    } finally {
      win.dispose();
    }
  });

  test("tabbed windows apply resizable, opacity, hideFromTaskbar, noActivate and outer minimum size", async () => {
    const { GWL_EXSTYLE, GWL_STYLE, minTrackSize, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_THICKFRAME, WS_MAXIMIZEBOX, user32 } = await import("../../test/win32-os");
    const win = new Window({ tabs: true, resizable: false, opacity: 0.5, hideFromTaskbar: true, noActivate: true, minWidth: 700, minHeight: 500 });
    try {
      const hwnd = BigInt(win.handle!);
      const style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE);
      const ex = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      expect(style & BigInt(WS_THICKFRAME | WS_MAXIMIZEBOX)).toBe(0n);
      expect(ex & BigInt(WS_EX_LAYERED)).toBe(BigInt(WS_EX_LAYERED));
      expect(ex & BigInt(WS_EX_TOOLWINDOW)).toBe(BigInt(WS_EX_TOOLWINDOW));
      expect(ex & BigInt(WS_EX_NOACTIVATE)).toBe(BigInt(WS_EX_NOACTIVATE));
      // MINMAXINFO.ptMinTrackSize is outer physical pixels: caller minimums apply unscaled.
      expect(minTrackSize(hwnd)).toEqual([700, 500]);
    } finally {
      win.dispose();
    }
  });

  test("tabbed windows keep per-frame appearance; system updates only touch system frames", async () => {
    const { getTabFrame, setDarkWindows } = await import("./tab-window");
    const { dwmapi } = await import("../../test/win32-os");
    const dwmDark = (hwnd: bigint) => {
      const value = new Int32Array(1);
      expect(dwmapi.DwmGetWindowAttribute(hwnd, 20, value, 4)).toBe(0); // DWMWA_USE_IMMERSIVE_DARK_MODE
      return value[0] !== 0;
    };
    const darkWin = new Window({ tabs: true, appearance: "dark" });
    const lightWin = new Window({ tabs: true, appearance: "light" });
    const systemWin = new Window({ tabs: true, appearance: "system" });
    try {
      const dark = getTabFrame(BigInt(darkWin.handle!))!;
      const light = getTabFrame(BigInt(lightWin.handle!))!;
      const system = getTabFrame(BigInt(systemWin.handle!))!;
      expect(dark.isDark()).toBe(true);
      expect(light.isDark()).toBe(false);
      expect(dwmDark(dark.hwnd)).toBe(true);
      expect(dwmDark(light.hwnd)).toBe(false);

      setDarkWindows(true);
      expect(light.isDark()).toBe(false);
      expect(system.isDark()).toBe(true);
      expect(dwmDark(system.hwnd)).toBe(true);
      setDarkWindows(false);
      expect(dark.isDark()).toBe(true);
      expect(system.isDark()).toBe(false);
      expect(dwmDark(dark.hwnd)).toBe(true);

      system.setSystemDark(true);
      light.setSystemDark(true);
      dark.setSystemDark(false);
      expect(system.isDark()).toBe(true);
      expect(light.isDark()).toBe(false);
      expect(dark.isDark()).toBe(true);
      expect(dwmDark(light.hwnd)).toBe(false);
    } finally {
      darkWin.dispose();
      lightWin.dispose();
      systemWin.dispose();
    }
  });

  test("Window.fromHandle reports the wrapped window's frame and resizability", () => {
    const frameless = new Window({ frame: false });
    const fixed = new Window({ resizable: false });
    const framed = new Window();
    const wrappers = [frameless, fixed, framed].map((win) => Window.fromHandle(win.handle));
    try {
      expect(wrappers.map((w) => ({ frame: getWindowMeta(w).frame, resizable: getWindowMeta(w).resizable }))).toEqual([
        { frame: false, resizable: false },
        { frame: true, resizable: false },
        { frame: true, resizable: true },
      ]);
    } finally {
      for (const w of wrappers) w.dispose();
      frameless.dispose();
      fixed.dispose();
      framed.dispose();
    }
  });

  test("disposing a Window.fromHandle wrapper of an owned Window preserves the owner's onClose listener", async () => {
    const { user32, WM_CLOSE } = await import("../../test/win32-os");
    const { asHwnd } = await import("./window");
    const owner = new Window({ title: "Owned Close Preservation" });
    const hwnd = asHwnd(owner.handle);
    let ownerCalls = 0;
    let wrapperCalls = 0;
    owner.onClose(() => ownerCalls++);
    try {
      const borrowed = Window.fromHandle(owner.handle);
      borrowed.onClose(() => wrapperCalls++);
      borrowed.dispose();

      user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
      expect(ownerCalls).toBe(1);
      expect(wrapperCalls).toBe(0);
      expect(user32.IsWindow(hwnd)).not.toBe(0);
    } finally {
      owner.dispose();
    }
  });
});
