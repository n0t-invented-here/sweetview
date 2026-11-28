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

  test("isMinimized follows the OS (IsIconic) for created, frameless, tabbed and wrapped windows; a hidden window is not minimised", async () => {
    const { ownWindow, user32 } = await import("../../test/win32-os");
    const iconic = (win: Window) => user32.IsIconic(BigInt(win.handle!)) !== 0;
    const framed = new Window({ title: "isMinimized framed", noActivate: true, bounds: { x: 140, y: 140, width: 320, height: 240 } });
    const frameless = new Window({ frame: false, noActivate: true, bounds: { x: 160, y: 160, width: 320, height: 240 } });
    const tabbed = new Window({ tabs: true, noActivate: true });
    // A window Sweetview did not make (`tao` did not create it), and a wrapper of Sweetview's own.
    const own = ownWindow();
    const wrapped = Window.fromHandle(own.hwnd);
    const wrapperOfOwned = Window.fromHandle(framed.handle);
    try {
      for (const [name, win] of [["framed", framed], ["frameless", frameless], ["tabbed", tabbed], ["wrapped", wrapped]] as const) {
        expect({ name, visible: win.isVisible(), minimized: win.isMinimized(), iconic: iconic(win) }).toEqual({ name, visible: false, minimized: false, iconic: false });
        win.show();
        expect({ name, visible: win.isVisible(), minimized: win.isMinimized(), iconic: iconic(win) }).toEqual({ name, visible: true, minimized: false, iconic: false });
        win.minimize();
        // isVisible() stays true for a minimised window; isMinimized() tells the two apart.
        expect({ name, visible: win.isVisible(), minimized: win.isMinimized(), iconic: iconic(win) }).toEqual({ name, visible: true, minimized: true, iconic: true });
        win.show();
        expect({ name, visible: win.isVisible(), minimized: win.isMinimized(), iconic: iconic(win) }).toEqual({ name, visible: true, minimized: false, iconic: false });
        win.hide();
        expect({ name, visible: win.isVisible(), minimized: win.isMinimized() }).toEqual({ name, visible: false, minimized: false });
      }
      framed.show();
      framed.minimize();
      expect(wrapperOfOwned.isMinimized()).toBe(true);
      framed.show();
      expect(wrapperOfOwned.isMinimized()).toBe(false);
      framed.dispose();
      expect(framed.isMinimized()).toBe(false);
    } finally {
      wrapperOfOwned.dispose();
      wrapped.dispose();
      own.destroy();
      tabbed.dispose();
      frameless.dispose();
      framed.dispose();
    }
  });

  test("contentSize is the page area in DIPs at the window's scale, centred on the primary work area and kept on it; a tabbed window's page is below its strip; bounds with it throws", async () => {
    const { clientSize } = await import("../../test/win32-os");
    const { STRIP_HEIGHT } = await import("./strip-shared");
    const area = Screen.primary().workArea;
    const centred = (b: { width: number; height: number }) => ({
      x: area.x + Math.max(0, Math.trunc((area.width - b.width) / 2)),
      y: area.y + Math.max(0, Math.trunc((area.height - b.height) / 2)),
    });
    const framed = new Window({ title: "contentSize framed", contentSize: { width: 500, height: 300 } });
    const frameless = new Window({ frame: false, contentSize: { width: 410, height: 270 } });
    const tabbed = new Window({ tabs: true, contentSize: { width: 700, height: 420 } });
    const huge = new Window({ title: "contentSize huge", contentSize: { width: 100_000, height: 100_000 } });
    try {
      for (const [name, win, width, height, strip] of [["framed", framed, 500, 300, 0], ["frameless", frameless, 410, 270, 0], ["tabbed", tabbed, 700, 420, STRIP_HEIGHT]] as const) {
        const scale = win.scale();
        // The page, in CSS pixels, is what was asked for at the screen's scale, whatever the frame takes.
        expect({ name, client: clientSize(BigInt(win.handle!)) }).toEqual({ name, client: { width: Math.round(width * scale), height: Math.round((height + strip) * scale) } });
        const bounds = win.bounds();
        expect({ name, x: bounds.x, y: bounds.y }).toEqual({ name, ...centred(bounds) });
        expect(win.isVisible()).toBe(false);
      }
      // Frameless: the outer frame is the page.
      expect(frameless.bounds().width).toBe(clientSize(BigInt(frameless.handle!)).width);
      // Larger than the work area: the whole window is cut to it.
      expect(huge.bounds()).toEqual(area);
      expect(() => new Window({ bounds: { x: 0, y: 0, width: 100, height: 100 }, contentSize: { width: 100, height: 100 } })).toThrow("sweetview: bounds and contentSize cannot both be given");
    } finally {
      huge.dispose();
      tabbed.dispose();
      frameless.dispose();
      framed.dispose();
    }
  });

  test("backgroundColor is what a window shows where nothing has painted, a tabbed window's page area too; a transparent window does not take it; a malformed one throws", async () => {
    const { clientSize, clientToScreen, screenPixel } = await import("../../test/win32-os");
    const { pumpEvents } = await import("../event-loop");
    const { STRIP_HEIGHT } = await import("./strip-shared");
    const area = Screen.primary().workArea;
    const plain = new Window({ title: "backgroundColor plain", backgroundColor: "#204060", topmost: true, noActivate: true, bounds: { x: area.x + 40, y: area.y + 40, width: 260, height: 200 } });
    const tabbed = new Window({ tabs: true, backgroundColor: "#603020", topmost: true, noActivate: true, bounds: { x: area.x + 340, y: area.y + 40, width: 460, height: 340 } });
    // The middle of the client area, below `top` physical pixels (a tab frame's strip).
    const middle = (win: Window, top = 0) => {
      const hwnd = BigInt(win.handle!);
      const size = clientSize(hwnd);
      return clientToScreen(hwnd, size.width >> 1, top + ((size.height - top) >> 1));
    };
    const settle = (win: Window, want: string, top = 0) => {
      const deadline = Date.now() + 5000;
      let seen = "";
      do {
        pumpEvents();
        const at = middle(win, top);
        seen = screenPixel(at.x, at.y);
        if (seen === want) break;
        Bun.sleepSync(20);
      } while (Date.now() < deadline);
      return seen;
    };
    try {
      expect(getWindowMeta(plain).backgroundColor).toBe("#204060");
      plain.show();
      expect(settle(plain, "#204060")).toBe("#204060");
      tabbed.show();
      expect(settle(tabbed, "#603020", Math.round(STRIP_HEIGHT * tabbed.scale()))).toBe("#603020");

      const clear = new Window({ transparent: true, frame: false, backgroundColor: "#FFFFFF" });
      expect(getWindowMeta(clear).backgroundColor).toBeUndefined();
      clear.dispose();
      expect(() => new Window({ backgroundColor: "red" })).toThrow("sweetview: background color must be #rrggbb, got red");
      expect(() => new Window({ backgroundColor: "#fff" })).toThrow("sweetview: background color must be #rrggbb, got #fff");
    } finally {
      tabbed.dispose();
      plain.dispose();
    }
  });

  test("onMaximizeChange reports each change, by toggleMaximize or the system's own commands, once; nothing for a minimise and restore; frameless and tabbed windows too", async () => {
    const { user32 } = await import("../../test/win32-os");
    const WM_SYSCOMMAND = 0x0112;
    const [SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE] = [0xf020n, 0xf030n, 0xf120n];
    const area = Screen.primary().workArea;
    const at = { x: area.x + 120, y: area.y + 120, width: 420, height: 300 };
    const framedSeen: boolean[] = [];
    const framed = new Window({ title: "onMaximizeChange", noActivate: true, bounds: at, onMaximizeChange: (m) => framedSeen.push(m) });
    const wrapped = Window.fromHandle(framed.handle);
    const frameless = new Window({ frame: false, noActivate: true, bounds: at });
    const tabbed = new Window({ tabs: true, noActivate: true, bounds: { ...at, width: 700, height: 500 } });
    try {
      const wrapperSeen: boolean[] = [];
      const offWrapper = wrapped.onMaximizeChange((m) => wrapperSeen.push(m));
      const hwnd = BigInt(framed.handle!);
      const command = (sc: bigint) => user32.SendMessageW(hwnd, WM_SYSCOMMAND, sc, 0n);
      framed.show();
      framed.toggleMaximize();
      framed.toggleMaximize();
      // The frame's maximise button, a snap and a title bar double click all end as the system command.
      command(SC_MAXIMIZE);
      command(SC_MINIMIZE);
      expect(framed.isMinimized()).toBe(true);
      command(SC_RESTORE); // back to maximised: no change to report
      expect(framed.isMaximized()).toBe(true);
      command(SC_RESTORE);
      expect(framedSeen).toEqual([true, false, true, false]);
      expect(wrapperSeen).toEqual([true, false, true, false]);
      offWrapper();
      framed.toggleMaximize();
      expect(wrapperSeen.length).toBe(4);
      expect(framedSeen).toEqual([true, false, true, false, true]);

      for (const [name, win] of [["frameless", frameless], ["tabbed", tabbed]] as const) {
        const seen: boolean[] = [];
        const off = win.onMaximizeChange((m) => seen.push(m));
        win.show();
        win.toggleMaximize();
        expect({ name, maximized: win.isMaximized() }).toEqual({ name, maximized: true });
        win.toggleMaximize();
        off();
        win.toggleMaximize();
        expect({ name, seen }).toEqual({ name, seen: [true, false] });
      }
    } finally {
      wrapped.dispose();
      tabbed.dispose();
      frameless.dispose();
      framed.dispose();
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
