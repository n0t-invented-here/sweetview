// What each WindowOptions option and Window method does to the real window,
// read back from the OS. The windows come from the Rust binding; this test
// reads them through bun:ffi probes, and moves the cursor (restored after)
// and, for the resize gesture, presses the left button over its own window
// (released in a finally). Titles are unique so other sessions are not touched.

import { describe, expect, test } from "bun:test";
import { FFIType, dlopen, ptr } from "bun:ffi";
import { binding } from "../binding";
import { pumpEvents, quitEventLoop, runEventLoop } from "../event-loop";
import { Screen } from "../screen";
import { Window } from "../window";
import { untilDesktopIsOurs } from "../../test/desktop";

const onWindows = process.platform === "win32";

const probe = onWindows
  ? dlopen("user32.dll", {
      GetWindowTextW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
      GetActiveWindow: { args: [], returns: FFIType.u64 },
      WindowFromPoint: { args: [FFIType.u64], returns: FFIType.u64 },
      GetAncestor: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u64 },
      GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
      GetKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
      GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
  : undefined;

const { inMoveSize: inMoveSizeOfThisThread } = onWindows ? await import("../../test/win32-os") : { inMoveSize: () => false };

/** What the OS says about a drag in progress on this thread: read from inside the move loop when a drag test fails. */
function dragState(): { inMoveSize: boolean; leftDown: boolean; leftDownForThisThread: boolean; cursor: { x: number; y: number } } {
  const point = new Int32Array(2);
  probe!.GetCursorPos(ptr(point));
  return {
    // This thread's GUI_INMOVESIZE, read by thread id (test/win32-os.ts): GetGUIThreadInfo(0, ...)
    // names the foreground thread, which may be another process's.
    inMoveSize: inMoveSizeOfThisThread(),
    leftDown: probe!.GetAsyncKeyState(0x01) < 0,
    leftDownForThisThread: probe!.GetKeyState(0x01) < 0,
    cursor: { x: point[0]!, y: point[1]! },
  };
}
const dwm = onWindows ? dlopen("dwmapi.dll", { DwmGetWindowAttribute: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } }).symbols : undefined;

const WS_EX_TOPMOST = 0x8n;
const WS_EX_TRANSPARENT = 0x20n;
const WS_EX_TOOLWINDOW = 0x80n;
const WS_EX_APPWINDOW = 0x40000n;
const WS_EX_LAYERED = 0x80000n;
const WS_EX_NOACTIVATE = 0x8000000n;
const WS_EX_ACCEPTFILES = 0x10n;
const WS_THICKFRAME = 0x40000n;
const WS_MAXIMIZEBOX = 0x10000n;

let serial = 0;
const unique = (what: string) => `window-native.test ${what} ${process.pid}.${++serial}`;

async function api() {
  return await import("../../test/win32-os");
}

async function styles(handle: bigint) {
  const { GWL_EXSTYLE, GWL_STYLE, user32 } = await api();
  return { style: BigInt.asUintN(32, user32.GetWindowLongPtrW(handle, GWL_STYLE)), ex: BigInt.asUintN(32, user32.GetWindowLongPtrW(handle, GWL_EXSTYLE)) };
}

function titleOf(handle: bigint): string {
  const buffer = new Uint16Array(256);
  const length = probe!.GetWindowTextW(handle, buffer, buffer.length);
  return Buffer.from(buffer.buffer, 0, length * 2).toString("utf16le");
}

async function clientAndOuter(handle: bigint) {
  const { user32 } = await api();
  const client = new Int32Array(4);
  const outer = new Int32Array(4);
  user32.GetClientRect(handle, client);
  user32.GetWindowRect(handle, outer);
  return { client: { width: client[2]!, height: client[3]! }, outer: { width: outer[2]! - outer[0]!, height: outer[3]! - outer[1]! } };
}

/** Dispatches the OS loop for `ms`, letting Bun's own loop run in between. */
async function settle(ms: number, until?: () => boolean): Promise<void> {
  for (const end = performance.now() + ms; performance.now() < end; await Bun.sleep(5)) {
    pumpEvents();
    if (until?.()) return;
  }
}

async function cursorNow(): Promise<{ x: number; y: number }> {
  const { user32 } = await api();
  const point = new Int32Array(2);
  user32.GetCursorPos(point);
  return { x: point[0]!, y: point[1]! };
}

async function buttonsDown(): Promise<boolean> {
  const { user32 } = await api();
  return [0x01, 0x02, 0x04].some((vk) => user32.GetAsyncKeyState(vk) < 0);
}

/** The top-level window under a screen point. */
function windowAt(x: number, y: number): bigint {
  const packed = (BigInt.asUintN(32, BigInt(x)) | (BigInt.asUintN(32, BigInt(y)) << 32n));
  const hit = probe!.WindowFromPoint(packed);
  return hit === 0n ? 0n : probe!.GetAncestor(hit, 2); // GA_ROOT
}

function leftButton(down: boolean): void {
  const input = new Uint8Array(40); // INPUT, x64: type, MOUSEINPUT at 8 (dx, dy, mouseData, dwFlags at 20, time, dwExtraInfo)
  const view = new DataView(input.buffer);
  view.setUint32(0, 0, true); // INPUT_MOUSE
  view.setUint32(20, down ? 0x2 : 0x4, true); // MOUSEEVENTF_LEFTDOWN / LEFTUP
  probe!.SendInput(1, input, 40);
}

/**
 * Moves the cursor to a screen point as a mouse would: an injected absolute move, which is what the
 * OS's own move loop follows, then SetCursorPos so the point is exact (the injected move is rounded
 * to 1/65535 of the desktop). SetCursorPos alone moves the cursor but, in a session with nobody at
 * it, does not reach a modal move loop.
 */
function moveCursorAsInput(x: number, y: number): void {
  const desk = Screen.bounds();
  const input = new Uint8Array(40); // INPUT, x64, as in leftButton
  const view = new DataView(input.buffer);
  view.setUint32(0, 0, true); // INPUT_MOUSE
  view.setInt32(8, Math.round(((x - desk.x) * 65535) / Math.max(1, desk.width - 1)), true);
  view.setInt32(12, Math.round(((y - desk.y) * 65535) / Math.max(1, desk.height - 1)), true);
  view.setUint32(20, 0x1 | 0x8000 | 0x4000, true); // MOUSEEVENTF_MOVE | ABSOLUTE | VIRTUALDESK
  probe!.SendInput(1, input, 40);
  probe!.SetCursorPos(x, y);
}

const handleOf = (win: Window) => BigInt(win.handle!);

// The move-loop control (test/win32-os.ts), run once before the gesture that needs the OS's move
// loop: when the session's OS runs no move loop for a plain window of the test's own either, the
// startDrag test is skipped for that reason rather than failed.
const moveLoop = onWindows ? await (await api()).moveLoopControl(Screen.bounds(), Screen.primary().workArea) : undefined;
if (moveLoop?.ok === false) {
  console.log(`window-native.test: startDrag skipped: the session's OS started no move loop for the control window either (${moveLoop.why}): ${JSON.stringify(moveLoop.readings)}`);
}

describe.if(onWindows)("Window on the binding: options read back from the OS", () => {
  test("bounds, title, frame, resizable and the minimum size", async () => {
    const { user32, WM_GETMINMAXINFO } = await api();
    const title = unique("framed");
    const framed = new Window({ title, bounds: { x: 140, y: 130, width: 500, height: 360 }, minWidth: 420, minHeight: 300 });
    const fixed = new Window({ title: unique("fixed"), resizable: false });
    const frameless = new Window({ title: unique("frameless"), frame: false, bounds: { x: 150, y: 150, width: 220, height: 140 } });
    try {
      expect(framed.bounds()).toEqual({ x: 140, y: 130, width: 500, height: 360 });
      expect(titleOf(handleOf(framed))).toBe(title);
      framed.setTitle("renamed " + title);
      expect(titleOf(handleOf(framed))).toBe("renamed " + title);

      const withFrame = await clientAndOuter(handleOf(framed));
      expect(withFrame.client.height).toBeLessThan(withFrame.outer.height); // a title bar and borders
      const noFrame = await clientAndOuter(handleOf(frameless));
      expect(noFrame.client).toEqual(noFrame.outer); // the page fills the whole window

      expect((await styles(handleOf(framed))).style & WS_THICKFRAME).toBe(WS_THICKFRAME);
      const fixedStyle = (await styles(handleOf(fixed))).style;
      expect(fixedStyle & (WS_THICKFRAME | WS_MAXIMIZEBOX)).toBe(0n);

      // MINMAXINFO.ptMinTrackSize is the outer minimum, in physical pixels.
      const info = new Int32Array(10);
      user32.SendMessageW(handleOf(framed), WM_GETMINMAXINFO, 0n, BigInt(ptr(info)));
      expect([info[6], info[7]]).toEqual([420, 300]);
    } finally {
      framed.dispose();
      fixed.dispose();
      frameless.dispose();
    }
  });

  test("appearance sets the title bar's dark mode", () => {
    const dark = new Window({ title: unique("dark"), appearance: "dark" });
    const light = new Window({ title: unique("light"), appearance: "light" });
    const darkMode = (win: Window) => {
      const value = new Int32Array(1);
      expect(dwm!.DwmGetWindowAttribute(handleOf(win), 20, value, 4)).toBe(0); // DWMWA_USE_IMMERSIVE_DARK_MODE
      return value[0] !== 0;
    };
    try {
      expect(darkMode(dark)).toBe(true);
      expect(darkMode(light)).toBe(false);
    } finally {
      dark.dispose();
      light.dispose();
    }
  });

  test("topmost, hideFromTaskbar, noActivate and layering, kept through a style rewrite", async () => {
    const overlay = new Window({ title: unique("overlay"), frame: false, transparent: true, topmost: true, hideFromTaskbar: true, noActivate: true, opacity: 0.75 });
    const plain = new Window({ title: unique("plain") });
    try {
      let { ex } = await styles(handleOf(overlay));
      expect(ex & WS_EX_TOPMOST).toBe(WS_EX_TOPMOST);
      expect(ex & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW)).toBe(WS_EX_TOOLWINDOW);
      expect(ex & WS_EX_NOACTIVATE).toBe(WS_EX_NOACTIVATE);
      expect(ex & WS_EX_LAYERED).toBe(WS_EX_LAYERED);
      expect(ex & WS_EX_ACCEPTFILES).toBe(0n); // only while a drop listener exists
      // `tao` rewrites the whole extended style when topmost changes; Sweetview's bits hold.
      overlay.setTopmost(false);
      ({ ex } = await styles(handleOf(overlay)));
      expect(ex & WS_EX_TOPMOST).toBe(0n);
      expect(ex & (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_LAYERED)).toBe(WS_EX_TOOLWINDOW | WS_EX_LAYERED);
      overlay.setTopmost(true);
      expect((await styles(handleOf(overlay))).ex & WS_EX_TOPMOST).toBe(WS_EX_TOPMOST);

      ({ ex } = await styles(handleOf(plain)));
      expect(ex & (WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED)).toBe(0n);
    } finally {
      overlay.dispose();
      plain.dispose();
    }
  });

  test("show() leaves a noActivate window inactive and activates any other", async () => {
    const quiet = new Window({ title: unique("quiet"), noActivate: true, frame: false, bounds: { x: -3000, y: -3000, width: 120, height: 80 } });
    const loud = new Window({ title: unique("loud"), frame: false, bounds: { x: -3000, y: -2800, width: 120, height: 80 } });
    try {
      quiet.show();
      await settle(20);
      expect(quiet.isVisible()).toBe(true);
      expect(probe!.GetActiveWindow()).not.toBe(handleOf(quiet));
      loud.show();
      await settle(20);
      expect(probe!.GetActiveWindow()).toBe(handleOf(loud));
      quiet.hide();
      expect(quiet.isVisible()).toBe(false);
    } finally {
      quiet.dispose();
      loud.dispose();
    }
  });

  test("minimize, show restoring it, and toggleMaximize on a framed window", async () => {
    const { user32 } = await api();
    const win = new Window({ title: unique("maximize"), noActivate: true, bounds: { x: -3000, y: -3000, width: 300, height: 200 } });
    try {
      win.show();
      win.minimize();
      expect(user32.IsIconic(handleOf(win))).not.toBe(0);
      expect(win.isVisible()).toBe(true); // minimized windows still count as visible
      win.show();
      expect(user32.IsIconic(handleOf(win))).toBe(0);
      win.toggleMaximize();
      await settle(20);
      expect(win.isMaximized()).toBe(true);
      expect(user32.IsZoomed(handleOf(win))).not.toBe(0);
      win.toggleMaximize();
      await settle(20);
      expect(win.isMaximized()).toBe(false);
      expect(user32.IsZoomed(handleOf(win))).toBe(0);
    } finally {
      win.dispose();
    }
  });

  test("Screen.of a window is the screen its frame is on; Screen.bounds holds every screen", () => {
    const primary = Screen.primary();
    const win = new Window({ title: unique("screen"), bounds: { x: primary.workArea.x + 40, y: primary.workArea.y + 40, width: 200, height: 120 } });
    try {
      expect(Screen.of(win).bounds).toEqual(primary.bounds);
      expect(Screen.of(handleOf(win)).bounds).toEqual(primary.bounds);
      const all = Screen.bounds();
      for (const screen of Screen.all()) {
        expect(screen.bounds.x).toBeGreaterThanOrEqual(all.x);
        expect(screen.bounds.y).toBeGreaterThanOrEqual(all.y);
        expect(screen.bounds.x + screen.bounds.width).toBeLessThanOrEqual(all.x + all.width);
        expect(screen.bounds.y + screen.bounds.height).toBeLessThanOrEqual(all.y + all.height);
      }
    } finally {
      win.dispose();
    }
  });
});

describe.if(onWindows)("Window on the binding: click-through, hit regions, the resize gesture", () => {
  test("setClickThrough sets and clears the click-through bits", async () => {
    const win = new Window({ title: unique("click-through"), frame: false });
    const bits = async () => (await styles(handleOf(win))).ex & (WS_EX_TRANSPARENT | WS_EX_LAYERED);
    try {
      win.setClickThrough(true);
      expect(await bits()).toBe(WS_EX_TRANSPARENT | WS_EX_LAYERED);
      win.setClickThrough(false);
      expect(await bits()).toBe(0n);
    } finally {
      win.dispose();
    }
  });

  test("the 10 ms poll follows the cursor into and out of a polygon, with and without the refiner", async () => {
    const original = await cursorNow();
    const bounds = { x: 260, y: 240, width: 300, height: 200 };
    const win = new Window({ title: unique("hit regions"), frame: false, topmost: true, noActivate: true, bounds });
    const passing = async () => ((await styles(handleOf(win))).ex & WS_EX_TRANSPARENT) !== 0n;
    const leftHalf = [[{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 200 }, { x: 0, y: 200 }]];
    try {
      // The poll freezes while a button is held (proved in sweetview-window-logic): wait for another
      // session's held button to be let go, or fail saying why.
      await untilDesktopIsOurs("hit-region poll: a mouse button is held", async () => !(await buttonsDown()));
      win.show();
      win.setHitRegions(leftHalf);
      probe!.SetCursorPos(bounds.x + 50, bounds.y + 50);
      await settle(200, () => false);
      expect(await passing()).toBe(false); // inside the polygon: solid
      probe!.SetCursorPos(bounds.x + 250, bounds.y + 50);
      await settle(200);
      expect(await passing()).toBe(true); // outside: clicks fall through

      // With a refiner the page decides inside the polygon.
      const asked: { x: number; y: number }[] = [];
      win.setHitRegions(leftHalf, (local, answer) => {
        asked.push(local);
        answer(false); // "transparent here"
      });
      probe!.SetCursorPos(bounds.x + 60, bounds.y + 70);
      await settle(200);
      expect(asked).toContainEqual({ x: 60, y: 70 });
      expect(await passing()).toBe(true);
      win.setHitRegions(leftHalf, (_local, answer) => answer(true));
      probe!.SetCursorPos(bounds.x + 61, bounds.y + 70);
      await settle(200);
      expect(await passing()).toBe(false);

      // hide() stops the poll; null restores normal hit testing.
      win.setHitRegions(null);
      expect(await passing()).toBe(false);
    } finally {
      probe!.SetCursorPos(original.x, original.y);
      win.dispose();
    }
  });

  test("startResize follows the cursor from an edge while the left button is down", async () => {
    const original = await cursorNow();
    const bounds = { x: 300, y: 300, width: 300, height: 200 };
    const win = new Window({ title: unique("resize"), frame: false, topmost: true, noActivate: true, bounds, minWidth: 250 });
    let pressed = false;
    try {
      win.show();
      await settle(30);
      const corner = { x: bounds.x + bounds.width - 2, y: bounds.y + bounds.height - 2 };
      probe!.SetCursorPos(corner.x, corner.y);
      // Press only over this test's own window, so the click reaches nothing else. Another session's
      // window or held button is waited out (the window raised and the cursor placed again), or the
      // test fails saying why.
      await untilDesktopIsOurs(
        "startResize: the test window is not under the cursor, or a mouse button is held",
        async () => !(await buttonsDown()) && windowAt(corner.x, corner.y) === handleOf(win),
        { between: () => { win.setTopmost(true); win.show(); probe!.SetCursorPos(corner.x, corner.y); } },
      );
      leftButton(true);
      pressed = true;
      await settle(30);
      win.startResize("bottom-right");
      probe!.SetCursorPos(corner.x + 40, corner.y + 30);
      await settle(200, () => win.bounds().width === 340);
      expect(win.bounds()).toEqual({ x: 300, y: 300, width: 340, height: 230 });
      // The left edge never goes below minWidth.
      probe!.SetCursorPos(corner.x - 500, corner.y);
      await settle(200, () => win.bounds().width === 250);
      expect(win.bounds().width).toBe(250);
      leftButton(false);
      pressed = false;
      await settle(60);
      probe!.SetCursorPos(corner.x + 100, corner.y + 100);
      await settle(60);
      expect(win.bounds().width).toBe(250); // released: the gesture is over
    } finally {
      if (pressed) leftButton(false);
      probe!.SetCursorPos(original.x, original.y);
      win.dispose();
    }
  });

  test.skipIf(moveLoop?.ok === false)("startDrag hands the window to the OS, which moves it with the cursor until the button is released", async () => {
    const native = binding();
    const original = await cursorNow();
    const bounds = { x: 320, y: 320, width: 300, height: 200 };
    const win = new Window({ title: unique("drag"), frame: false, topmost: true, noActivate: true, bounds });
    let pressed = false;
    try {
      win.show();
      await settle(30);
      const grip = { x: bounds.x + 40, y: bounds.y + 20 };
      probe!.SetCursorPos(grip.x, grip.y);
      // Press only over this test's own window, as in startResize: waited out, or fails saying why.
      await untilDesktopIsOurs(
        "startDrag: the test window is not under the cursor, or a mouse button is held",
        async () => !(await buttonsDown()) && windowAt(grip.x, grip.y) === handleOf(win),
        { between: () => { win.setTopmost(true); win.show(); probe!.SetCursorPos(grip.x, grip.y); } },
      );
      leftButton(true);
      pressed = true;
      // The OS starts its move loop only when this thread has seen the press: the button's state
      // as the thread's own queue has it, which follows the press message, not the injection.
      await settle(2000, () => probe!.GetKeyState(0x01) < 0);
      // The OS runs its own move loop from here until the button is released, so the cursor is
      // moved and the button released from native timeouts, which fire inside that loop.
      let duringDrag: ReturnType<Window["bounds"]> | undefined;
      const states: Record<string, ReturnType<typeof dragState>> = { beforeStartDrag: dragState() };
      native.scheduleTimeout(60, () => (states.inLoopBeforeTheMove = dragState()));
      native.scheduleTimeout(120, () => moveCursorAsInput(grip.x + 60, grip.y + 45));
      // No fixed delay before the reading: a session may apply the move well after the cursor got
      // there (the hosted runner does). From inside the loop, wait until the window is where the
      // cursor took it, or a generous limit passed; then read and release.
      const readInLoop = (end: number) => {
        const now = win.bounds();
        if (now.x !== bounds.x + 60 || now.y !== bounds.y + 45) {
          if (Date.now() < end && pressed) {
            native.scheduleTimeout(20, () => readInLoop(end));
            return;
          }
        }
        states.inLoopAfterTheMove = dragState();
        duringDrag = now;
        leftButton(false);
        pressed = false;
      };
      native.scheduleTimeout(140, () => readInLoop(Date.now() + 6000));
      win.startDrag();
      await settle(8000, () => !pressed);
      await settle(60);
      if (duringDrag?.x !== bounds.x + 60) console.warn(`window-native.test: startDrag: the window did not follow; ${JSON.stringify(states)}`);
      expect(duringDrag).toEqual({ x: bounds.x + 60, y: bounds.y + 45, width: 300, height: 200 });
      expect(win.bounds()).toEqual({ x: bounds.x + 60, y: bounds.y + 45, width: 300, height: 200 });
      // Released: the cursor no longer carries the window.
      probe!.SetCursorPos(grip.x + 200, grip.y + 200);
      await settle(80);
      expect(win.bounds().x).toBe(bounds.x + 60);
    } finally {
      if (pressed) leftButton(false);
      probe!.SetCursorPos(original.x, original.y);
      win.dispose();
    }
  }, 20_000);
});

describe.if(onWindows)("startDrag on a maximised frameless window", () => {
  test.skipIf(moveLoop?.ok === false)("a frameless window maximised by toggleMaximize and dragged by startDrag is no longer maximised, says so once, and maximises again on the next toggle", async () => {
    // Review N8: the drag left the saved restore rectangle set, so isMaximized() stayed true.
    const native = binding();
    const original = await cursorNow();
    const start = { x: 320, y: 320, width: 300, height: 200 };
    const win = new Window({ title: unique("drag maximised"), frame: false, topmost: true, noActivate: true, bounds: start });
    const seen: boolean[] = [];
    win.onMaximizeChange((m) => seen.push(m));
    let pressed = false;
    try {
      win.show();
      win.toggleMaximize();
      const maximised = win.bounds();
      expect({ maximized: win.isMaximized(), bounds: maximised }).toEqual({ maximized: true, bounds: Screen.of(win).workArea });
      await settle(30);
      const grip = { x: maximised.x + 40, y: maximised.y + 20 };
      probe!.SetCursorPos(grip.x, grip.y);
      await untilDesktopIsOurs(
        "startDrag (maximised): the test window is not under the cursor, or a mouse button is held",
        async () => !(await buttonsDown()) && windowAt(grip.x, grip.y) === handleOf(win),
        { between: () => { win.setTopmost(true); win.show(); probe!.SetCursorPos(grip.x, grip.y); } },
      );
      leftButton(true);
      pressed = true;
      await settle(2000, () => probe!.GetKeyState(0x01) < 0);
      native.scheduleTimeout(120, () => moveCursorAsInput(grip.x + 60, grip.y + 45));
      const readInLoop = (end: number) => {
        const now = win.bounds();
        if ((now.x !== maximised.x + 60 || now.y !== maximised.y + 45) && Date.now() < end && pressed) {
          native.scheduleTimeout(20, () => readInLoop(end));
          return;
        }
        leftButton(false);
        pressed = false;
      };
      native.scheduleTimeout(140, () => readInLoop(Date.now() + 6000));
      win.startDrag();
      await settle(8000, () => !pressed);
      await settle(60);
      expect(win.bounds()).toEqual({ ...maximised, x: maximised.x + 60, y: maximised.y + 45 });
      expect({ maximized: win.isMaximized(), seen }).toEqual({ maximized: false, seen: [true, false] });
      win.toggleMaximize();
      expect({ maximized: win.isMaximized(), bounds: win.bounds(), seen }).toEqual({ maximized: true, bounds: Screen.of(win).workArea, seen: [true, false, true] });
    } finally {
      if (pressed) leftButton(false);
      probe!.SetCursorPos(original.x, original.y);
      win.dispose();
    }
  }, 20_000);
});

describe.if(onWindows)("Window.fromHandle on an application's own window (made here through bun:ffi)", () => {
  test("a window the application made, maximised and minimised before Window.fromHandle wraps it, reports nothing when restored to maximised", async () => {
    // Review round 2, finding 5: the state was read only when the window was not minimised.
    const { WS_OVERLAPPEDWINDOW, hInstance, user32, wide } = await api();
    const WM_SYSCOMMAND = 0x0112;
    const [SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE] = [0xf020n, 0xf030n, 0xf120n];
    const hwnd = user32.CreateWindowExW(0, wide("STATIC"), wide(unique("own wrapped minimised")), WS_OVERLAPPEDWINDOW, 60, 60, 300, 200, 0n, 0n, hInstance(), null);
    expect(hwnd).not.toBe(0n);
    const command = (sc: bigint) => user32.SendMessageW(hwnd, WM_SYSCOMMAND, sc, 0n);
    command(SC_MAXIMIZE);
    command(SC_MINIMIZE);
    const wrapped = Window.fromHandle(hwnd);
    try {
      const seen: boolean[] = [];
      wrapped.onMaximizeChange((m) => seen.push(m));
      command(SC_RESTORE); // back to maximised
      expect({ maximized: wrapped.isMaximized(), seen }).toEqual({ maximized: true, seen: [] });
      command(SC_RESTORE);
      expect({ maximized: wrapped.isMaximized(), seen }).toEqual({ maximized: false, seen: [false] });
    } finally {
      wrapped.dispose();
      if (user32.IsWindow(hwnd)) user32.DestroyWindow(hwnd);
    }
  });

  test("onMaximizeChange arrives for a window the application made: maximised, minimised and restored to maximised (nothing), restored", async () => {
    // Review N7: onMaximizeChange had been run only on wrappers of Sweetview's own windows.
    const { WS_OVERLAPPEDWINDOW, hInstance, user32, wide } = await api();
    const WM_SYSCOMMAND = 0x0112;
    const [SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE] = [0xf020n, 0xf030n, 0xf120n];
    const hwnd = user32.CreateWindowExW(0, wide("STATIC"), wide(unique("own maximise")), WS_OVERLAPPEDWINDOW, 60, 60, 300, 200, 0n, 0n, hInstance(), null);
    expect(hwnd).not.toBe(0n);
    const wrapped = Window.fromHandle(hwnd);
    try {
      const seen: boolean[] = [];
      const off = wrapped.onMaximizeChange((m) => seen.push(m));
      const command = (sc: bigint) => user32.SendMessageW(hwnd, WM_SYSCOMMAND, sc, 0n);
      command(SC_MAXIMIZE);
      expect({ maximized: wrapped.isMaximized(), seen }).toEqual({ maximized: true, seen: [true] });
      command(SC_MINIMIZE);
      command(SC_RESTORE); // back to maximised
      expect({ maximized: wrapped.isMaximized(), seen }).toEqual({ maximized: true, seen: [true] });
      command(SC_RESTORE);
      expect({ maximized: wrapped.isMaximized(), seen }).toEqual({ maximized: false, seen: [true, false] });
      off();
      command(SC_MAXIMIZE);
      expect(seen).toEqual([true, false]);
    } finally {
      wrapped.dispose();
      if (user32.IsWindow(hwnd)) user32.DestroyWindow(hwnd);
    }
  });

  test("onResize, onMove, onClose and onFileDrop arrive; dispose leaves the window alive", async () => {
    const { WM_CLOSE, WS_OVERLAPPEDWINDOW, hInstance, sendDrop, user32, wide } = await api();
    const hwnd = user32.CreateWindowExW(0, wide("STATIC"), wide(unique("own")), WS_OVERLAPPEDWINDOW, 50, 50, 300, 200, 0n, 0n, hInstance(), null);
    expect(hwnd).not.toBe(0n);
    const wrapped = Window.fromHandle(hwnd);
    try {
      expect(wrapped.handle).toBe(hwnd);
      const seen: string[] = [];
      wrapped.onResize((b) => seen.push(`resize ${b.width}x${b.height}`));
      wrapped.onMove((b) => seen.push(`move ${b.x},${b.y}`));
      wrapped.onClose(() => seen.push("close"));
      const drops: string[][] = [];
      wrapped.onFileDrop((paths) => drops.push(paths));

      wrapped.setBounds({ x: 70, y: 80, width: 320, height: 210 });
      expect(seen).toContain("resize 320x210");
      expect(seen).toContain("move 70,80");
      user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
      expect(seen).toContain("close");
      expect(user32.IsWindow(hwnd)).not.toBe(0); // the listener took the request

      const paths = ["C:\\example\\one.txt", "C:\\example\\two.txt"];
      sendDrop(hwnd, paths);
      expect(drops).toEqual([paths]);

      wrapped.dispose();
      expect(user32.IsWindow(hwnd)).not.toBe(0);
      // Unhooked: the window's own procedure gets the close request again (STATIC destroys itself).
      user32.SendMessageW(hwnd, WM_CLOSE, 0n, 0n);
      expect(seen.filter((s) => s === "close")).toHaveLength(1);
      expect(user32.IsWindow(hwnd)).toBe(0);
    } finally {
      wrapped.dispose();
      if (user32.IsWindow(hwnd)) user32.DestroyWindow(hwnd);
    }
  });
});

describe.if(onWindows)("both loop modes serve a window", () => {
  test("the blocking loop and the Bun-timer loop deliver a close request and run the hit-region poll", async () => {
    const native = binding();
    const { WM_CLOSE, user32 } = await api();
    for (const mode of ["blocking", "pumped"] as const) {
      const win = new Window({ title: unique(`loop ${mode}`), frame: false, noActivate: true, bounds: { x: -3000, y: -3000, width: 100, height: 100 } });
      const seen: string[] = [];
      win.onClose(() => {
        seen.push(native.isLoopBlocking() ? "close in the blocking loop" : "close in a pump");
        if (mode === "blocking") native.quitLoop();
        else quitEventLoop();
      });
      try {
        win.show();
        win.setHitRegions([]); // nothing takes clicks: the poll makes the whole window click-through
        native.scheduleTimeout(50, () => user32.PostMessageW(handleOf(win), WM_CLOSE, 0n, 0n));
        const watchdog = native.scheduleTimeout(5000, () => (mode === "blocking" ? native.quitLoop() : quitEventLoop()));
        if (mode === "blocking") native.runLoop();
        else await runEventLoop({ intervalMs: 4 });
        native.cancelTimeout(watchdog);
        expect(seen).toEqual([mode === "blocking" ? "close in the blocking loop" : "close in a pump"]);
        expect((await styles(handleOf(win))).ex & WS_EX_TRANSPARENT).toBe(WS_EX_TRANSPARENT);
      } finally {
        win.dispose();
      }
    }
  });
});
