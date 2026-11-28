// The Window class's TypeScript layer on Windows: what `window.ts` and `win32/window.ts` decide
// (close to tray, the identity, the native-dispose hold, any number of listeners per Window and
// their order, what `getWindowMeta` records, the option checks). What the window does in the OS
// (options, minimise and maximise, the system's commands, drops, an application's own window, the
// screen's colour, real-input gestures) is proven in Rust: `crates/sweetview-runtime/src/
// window_tests.rs` and `window_os_tests.rs`. Windows only.

import { describe, expect, test } from "bun:test";
import { defineAppIdentity } from "@n1h/sweetview-settings";
import { closeToTrayOnLastWindow, getWindowMeta, holdWindowNativeDispose, isWindowDisposed, onWindowDispose, Window } from "../window";

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

  test("a resize or move raised inside a listener is delivered as at the tag: at once to every listener, then the outer delivery goes on with its bounds, for two listeners of one Window and for two wrappers", async () => {
    // Review round 3, measure A. At tag pre-rust-rewrite (win32/window.ts, fireResize and fireMove,
    // lines 173 to 197) a resize or move read its bounds once and went to a snapshot of the window's
    // listeners in order; one raised inside a listener was delivered there, in full, and the outer
    // delivery then carried on with the older bounds.
    const start = { x: 180, y: 180, width: 320, height: 240 };
    const size = (b: { width: number; height: number }) => `${b.width}x${b.height}`;
    const at = (b: { x: number; y: number }) => `${b.x},${b.y}`;
    for (const wrappers of [false, true]) {
      const win = new Window({ title: `nested resize ${wrappers}`, noActivate: true, bounds: start });
      const other = wrappers ? Window.fromHandle(win.handle) : win;
      try {
        const heard: string[] = [];
        let once = false;
        win.onResize((b) => {
          heard.push(`1 ${size(b)}`);
          if (!once) {
            once = true;
            win.resize(400, 300);
          }
        });
        other.onResize((b) => heard.push(`2 ${size(b)}`));
        win.resize(360, 260);
        expect({ wrappers, heard }).toEqual({ wrappers, heard: ["1 360x260", "1 400x300", "2 400x300", "2 360x260"] });

        const moved: string[] = [];
        let first = false;
        win.onMove((b) => {
          moved.push(`1 ${at(b)}`);
          if (!first) {
            first = true;
            win.moveTo(240, 240);
          }
        });
        other.onMove((b) => moved.push(`2 ${at(b)}`));
        win.moveTo(200, 200);
        expect({ wrappers, moved }).toEqual({ wrappers, moved: ["1 200,200", "1 240,240", "2 240,240", "2 200,200"] });
      } finally {
        if (wrappers) other.dispose();
        win.dispose();
      }
    }
  });

  test("two wrappers of one window share one list of resize, move and maximise listeners: in the order added, the same function once, either unsubscribe takes it out, a dispose takes out what its wrapper added", () => {
    // Review round 5, R5-8: the function keys of win32/listener-keys.ts are what make the list one.
    const w = new Window({ frame: false, noActivate: true, bounds: { x: -2000, y: -2000, width: 300, height: 200 } });
    const b = Window.fromHandle(w.handle!);
    try {
      let n = 0;
      const kinds = [
        { name: "onResize", fire: () => w.setBounds({ ...w.bounds(), width: 300 + (++n % 2) * 10 }) },
        { name: "onMove", fire: () => w.setBounds({ ...w.bounds(), x: -2000 + (++n % 2) * 10 }) },
        { name: "onMaximizeChange", fire: () => w.toggleMaximize() },
      ] as const;
      for (const { name, fire } of kinds) {
        const heard: string[] = [];
        const told = (label: string) => () => heard.push(label);
        const [a1, b1, a2, both] = [told("A1"), told("B1"), told("A2"), told("both")];
        const on = (win: Window, fn: () => void) => (win[name] as (fn: () => void) => () => void).call(win, fn);
        on(w, a1);
        const offB1 = on(b, b1);
        on(w, a2);
        on(w, both);
        const offBothThroughB = on(b, both);
        const round = () => {
          heard.length = 0;
          fire();
          return [...heard];
        };
        expect({ name, heard: round() }).toEqual({ name, heard: ["A1", "B1", "A2", "both"] });
        offBothThroughB();
        expect({ name, heard: round() }).toEqual({ name, heard: ["A1", "B1", "A2"] });
        offB1();
        expect({ name, heard: round() }).toEqual({ name, heard: ["A1", "A2"] });
        on(b, b1);
        expect({ name, heard: round() }).toEqual({ name, heard: ["A1", "A2", "B1"] });
      }
      // b's dispose takes out what b added; w's stay.
      const heard: string[] = [];
      w.onResize(() => heard.push("w"));
      b.onResize(() => heard.push("b"));
      b.dispose();
      w.setBounds({ ...w.bounds(), width: 333 });
      expect(heard).toEqual(["w"]);
    } finally {
      b.dispose();
      w.dispose();
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

  test("the probe's screenPixel throws for a point no screen shows, rather than reading it as white", async () => {
    // Review N10: GetPixel's CLR_INVALID became "#ffffff". app.test.ts and its fixtures read the screen with it.
    const { screenPixel } = await import("../../test/win32-os");
    const { Screen } = await import("../screen");
    const far = Screen.bounds();
    expect(() => screenPixel(far.x - 10_000, far.y - 10_000)).toThrow("GetPixel");
  });

  test("bounds with contentSize throws; a malformed backgroundColor throws; a transparent window keeps no backgroundColor", () => {
    expect(() => new Window({ bounds: { x: 0, y: 0, width: 100, height: 100 }, contentSize: { width: 100, height: 100 } })).toThrow("sweetview: bounds and contentSize cannot both be given");
    expect(() => new Window({ backgroundColor: "red" })).toThrow("sweetview: background color must be #rrggbb, got red");
    expect(() => new Window({ backgroundColor: "#fff" })).toThrow("sweetview: background color must be #rrggbb, got #fff");
    const plain = new Window({ backgroundColor: "#204060" });
    const clear = new Window({ transparent: true, frame: false, backgroundColor: "#FFFFFF" });
    try {
      expect(getWindowMeta(plain).backgroundColor).toBe("#204060");
      expect(getWindowMeta(clear).backgroundColor).toBeUndefined();
    } finally {
      plain.dispose();
      clear.dispose();
    }
  });

  test("a tabbed window's topmost is recorded on creation and by setTopmost; setDarkWindows tells every frame, and only system frames follow", async () => {
    const { getTabFrame, setDarkWindows } = await import("./tab-window");
    const win = new Window({ tabs: true, topmost: true });
    const light = new Window({ tabs: true, appearance: "light" });
    const system = new Window({ tabs: true, appearance: "system" });
    try {
      expect(getWindowMeta(win).topmost).toBe(true);
      win.setTopmost(false);
      expect(getWindowMeta(win).topmost).toBe(false);
      setDarkWindows(true);
      expect(getTabFrame(BigInt(light.handle!))!.isDark()).toBe(false);
      expect(getTabFrame(BigInt(system.handle!))!.isDark()).toBe(true);
      setDarkWindows(false);
      expect(getTabFrame(BigInt(system.handle!))!.isDark()).toBe(false);
    } finally {
      win.dispose();
      light.dispose();
      system.dispose();
    }
  });
});
