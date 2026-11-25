// Live Win32 FFI tests for the unified Window class (createWindow, fromHandle,
// disposal, multi-window close without killing the loop, events, maximize).
// Windows only; creates hidden windows so nothing flashes on screen.

import { describe, expect, test } from "bun:test";
import { Screen } from "../screen";
import { createWindow, Window } from "../window";

const onWindows = process.platform === "win32";

describe.if(onWindows)("win32 Window", () => {
  test("creates hidden framed and frameless windows and disposes cleanly & idempotently", async () => {
    const { user32 } = await import("./api");
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
    const { user32, WM_CLOSE } = await import("./api");
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
    const { user32, WM_CLOSE } = await import("./api");
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
    const { createMessageWindow } = await import("./message-window");
    const { user32, WM_CLOSE } = await import("./api");
    const msg = createMessageWindow(() => {});
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
});
