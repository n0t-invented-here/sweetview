// W1.3 and W1.4 (rust-rewrite/CHECKLIST-windows.md) for the callback kinds no
// other test covers: a JavaScript exception thrown from a callback the binding
// calls is logged with today's message and the loop goes on, with the
// callback's fallback result; and a callback may remove or replace itself, or
// destroy its owner, from inside its own call. The kinds other tests cover
// were listed with their tests in checklist item W1.3's run output, kept on the machine outside git.
//
// Inputs are the ones the OS would deliver: messages posted or sent to this
// process's own windows (the tray icon's window, the popup menu, the
// single-instance window, a window of the test's own), the cursor moved over
// a window of the test's own (restored after), and the F24 key and a few
// pixels of pointer movement injected with SendInput for the hooks (F24 is
// bound by no application, and every key pressed is released). This file uses
// bun:ffi for those probes only.
//
// What reaches the binding past the TypeScript wrappers is logged by the
// binding itself on stderr ("sweetview: <kind> threw: ..."), which this
// process cannot read for itself; test/fixtures/callback-backstop.ts throws
// from every kind straight through the binding, in a process of its own.

import { afterEach, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { untilDesktopIsOurs } from "../test/desktop";
import { runFixture } from "../test/run-fixture";
import { _resetActivationForTest, onOpenUrl, signalReady, singleInstance, type SecondInstanceEvent } from "./activation";
import { binding } from "./binding";
import { onCallbackError } from "./callback-errors";
import { installKeyboardHook, installMouseHook, type KeyboardHook, type MouseHook } from "./input-hooks";
import { deferNative, openNativeDrain, quitNativeLoop, runNativeLoop, wakeNative } from "./ui-thread";
import { isWindowDisposed, onWindowDispose, Window } from "./window";

const onWindows = process.platform === "win32";

const user32 = onWindows
  ? dlopen("user32.dll", {
      FindWindowExW: { args: [FFIType.i64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
      SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.i64 },
      SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
      SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
      IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
      GetWindowLongPtrW: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    }).symbols
  : undefined;

const WM_CLOSE = 0x0010;
const WM_COPYDATA = 0x004a;
const VK_F24 = 0x87;
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20n;

let serial = 0;
const unique = (what: string) => `callbacks.test ${what} ${process.pid}.${++serial}`;

/** Collects what console.error is given until `restore()`. */
function captureErrors() {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void calls.push(args);
  return {
    calls,
    restore: () => {
      console.error = original;
    },
    /** Each call as "<message> <error's message>". */
    lines: () => calls.map((args) => `${String(args[0])} ${args[1] instanceof Error ? args[1].message : String(args[1])}`),
  };
}

/** Pumps the OS loop until `done()` or the deadline, letting Bun's own loop run in between. */
async function pumpUntil(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    binding().pumpEvents();
    await Bun.sleep(5);
  }
  binding().pumpEvents();
}

async function pumpFor(ms: number): Promise<void> {
  const until = Date.now() + ms;
  await pumpUntil(() => Date.now() >= until, ms + 100);
}

const isWindow = (hwnd: bigint) => user32!.IsWindow(hwnd) !== 0;

function cursorNow(): { x: number; y: number } {
  const point = new Int32Array(2);
  user32!.GetCursorPos(point);
  return { x: point[0]!, y: point[1]! };
}

function sendMouseMove(dx: number, dy: number): void {
  const input = new DataView(new ArrayBuffer(40)); // INPUT on x64
  input.setUint32(0, 0, true); // INPUT_MOUSE
  input.setInt32(8, dx, true);
  input.setInt32(12, dy, true);
  input.setUint32(20, 0x0001, true); // MOUSEEVENTF_MOVE
  user32!.SendInput(1, ptr(input.buffer), 40);
}

function sendKey(virtualKey: number, up: boolean): void {
  const input = new DataView(new ArrayBuffer(40));
  input.setUint32(0, 1, true); // INPUT_KEYBOARD
  input.setUint16(8, virtualKey, true);
  input.setUint32(12, up ? 0x0002 : 0, true); // KEYEVENTF_KEYUP
  user32!.SendInput(1, ptr(input.buffer), 40);
}

const keyDown = (virtualKey: number) => user32!.GetAsyncKeyState(virtualKey) < 0;
const buttonsDown = () => [0x01, 0x02, 0x04].some(keyDown);

/** Sends `paths` to `hwnd` as a WM_DROPFILES, as the shell does for a drop. */
async function sendDrop(hwnd: bigint, paths: string[]): Promise<void> {
  (await import("../test/win32-os")).sendDrop(hwnd, paths);
}

const sendClose = (hwnd: bigint) => user32!.SendMessageW(hwnd, WM_CLOSE, 0n, null);

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");

/**
 * Hands `payload` to the single-instance window of `appId` in this process, as
 * a secondary instance does: WM_COPYDATA tagged "SWV1". Returns what the
 * window answered (1 for a payload it took), or -1 when there is no window.
 */
function handOff(appId: string, payload: SecondInstanceEvent): number {
  const hwnd = user32!.FindWindowExW(-3n /* HWND_MESSAGE */, 0n, ptr(wide("SweetviewSingleInstanceWindow")), ptr(wide(`sweetview.instance.${appId}`)));
  if (hwnd === 0n) return -1;
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(payload), "utf8"));
  const data = new DataView(new ArrayBuffer(24)); // COPYDATASTRUCT on x64
  data.setBigUint64(0, 0x53575631n, true); // dwData: "SWV1"
  data.setUint32(8, bytes.length, true); // cbData
  data.setBigUint64(16, BigInt(ptr(bytes)), true); // lpData
  return Number(user32!.SendMessageW(hwnd, WM_COPYDATA, 0n, ptr(data.buffer)));
}

const singleInstanceWindow = (appId: string) =>
  user32!.FindWindowExW(-3n, 0n, ptr(wide("SweetviewSingleInstanceWindow")), ptr(wide(`sweetview.instance.${appId}`)));

/**
 * Menu watchers still armed. Each is cancelled when its test ends: a watcher whose menu never
 * opened would otherwise stay armed for five seconds and work the next test's menu.
 */
const menuWatchers = new Set<() => void>();
afterEach(() => {
  for (const cancel of [...menuWatchers]) cancel();
});

/**
 * Runs `step` from inside the popup menu's own modal loop once a popup menu of
 * this process is open, on a native interval (which the menu loop dispatches).
 * A menu still open 3 s later is closed, so a failing test never leaves one up.
 * Returns the function that disarms the watcher; it is also disarmed when its test ends.
 */
async function whenMenuOpens(step: (menuWindow: bigint) => void): Promise<() => void> {
  const { endMenu, openPopupMenu } = await import("../test/win32-os");
  const native = binding();
  const started = Date.now();
  // The 3 s closer is kept with the watcher, so the test's end disarms it too: one left behind
  // would end whichever menu is open when it fires, the next test's included (review G10).
  let closer: number | undefined;
  const cancel = () => {
    native.cancelTimeout(id);
    if (closer !== undefined) native.cancelTimeout(closer);
    menuWatchers.delete(cancel);
  };
  const id = native.scheduleInterval(10, () => {
    const menuWindow = openPopupMenu();
    if (menuWindow !== 0n) {
      native.cancelTimeout(id);
      closer = native.scheduleTimeout(3000, () => {
        closer = undefined;
        menuWatchers.delete(cancel);
        void (openPopupMenu() !== 0n && endMenu());
      });
      step(menuWindow);
    } else if (Date.now() - started > 5000) {
      cancel();
    }
  });
  menuWatchers.add(cancel);
  return cancel;
}

/**
 * Right-clicks the tray icon and chooses the menu's first item until `chosen()`.
 * A popup menu closes without a choice when another window takes the
 * foreground (other sessions share this desktop), so a menu that closed
 * unchosen is opened again, up to `attempts` times. Returns the attempts used.
 */
async function chooseFirstTrayItem(trayWindow: bigint, chosen: () => boolean, attempts = 3): Promise<number> {
  const { TRAY, VK, openPopupMenu, postTrayMouse, pressKeys } = await import("../test/win32-os");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let shown = false;
    const disarm = await whenMenuOpens((menuWindow) => {
      shown = true;
      pressKeys(menuWindow, VK.DOWN, VK.RETURN);
    });
    postTrayMouse(trayWindow, TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
    await pumpUntil(() => chosen() || (shown && openPopupMenu() === 0n));
    await pumpUntil(() => openPopupMenu() === 0n, 1000);
    // One watcher per attempt: this one never works the menu of the next.
    disarm();
    if (chosen()) return attempt;
  }
  return attempts;
}

// ---------------------------------------------------------------------------------------------

describe.if(onWindows)("W1.3 / W1.4 deferred jobs and native timeouts", () => {
  /** Runs the blocking loop until `quitNativeLoop()`, with a watchdog. */
  function runLoopFor(ms = 5000): void {
    const native = binding();
    const watchdog = native.scheduleTimeout(ms, () => native.quitLoop());
    runNativeLoop();
    native.cancelTimeout(watchdog);
  }

  test("W1.3 a deferred job that throws is logged with today's message, and the next job runs", () => {
    const ran: string[] = [];
    const log = captureErrors();
    try {
      deferNative(() => {
        ran.push("throws");
        throw new Error("deferred boom");
      });
      deferNative(() => {
        ran.push("next");
        quitNativeLoop();
      });
      runLoopFor();
    } finally {
      log.restore();
    }
    expect(ran).toEqual(["throws", "next"]);
    expect(log.lines()).toEqual(["sweetview: UI dispatch failed: deferred boom"]);
  });

  test("W1.4 a deferred job forgets itself and another pending job, and defers a replacement, from inside its own call", () => {
    const ran: string[] = [];
    let forgetSelf = () => {};
    let forgetOther = () => {};
    forgetSelf = deferNative(() => {
      ran.push("first");
      forgetSelf();
      forgetOther();
      deferNative(() => {
        ran.push("replacement");
        quitNativeLoop();
      });
    });
    forgetOther = deferNative(() => ran.push("forgotten"));
    runLoopFor();
    expect(ran).toEqual(["first", "replacement"]);
  });

  test("W1.3 a native timeout that throws is logged with today's message, and a later timeout fires", async () => {
    const { scheduleNativeTimeout } = await import("./win32/event-loop");
    const ran: string[] = [];
    const log = captureErrors();
    try {
      scheduleNativeTimeout(1, () => {
        ran.push("throws");
        throw new Error("timeout boom");
      });
      scheduleNativeTimeout(30, () => {
        ran.push("later");
        quitNativeLoop();
      });
      runLoopFor();
    } finally {
      log.restore();
    }
    expect(ran).toEqual(["throws", "later"]);
    expect(log.lines()).toEqual(["sweetview: message window handler threw: timeout boom"]);
  });

  test("W1.4 a native timeout cancels itself and another pending timeout, and schedules a replacement, from inside its own call", async () => {
    const { scheduleNativeTimeout } = await import("./win32/event-loop");
    const ran: string[] = [];
    let cancelSelf = () => {};
    let cancelOther = () => {};
    cancelSelf = scheduleNativeTimeout(1, () => {
      ran.push("first");
      cancelSelf();
      cancelOther();
      scheduleNativeTimeout(20, () => {
        ran.push("replacement");
        quitNativeLoop();
      });
    });
    cancelOther = scheduleNativeTimeout(150, () => ran.push("cancelled"));
    runLoopFor();
    await pumpFor(200); // the cancelled timeout's time has passed
    expect(ran).toEqual(["first", "replacement"]);
  });

  test("W1.3 a drain that throws is logged with today's message, stays registered, and runs on the next wake", () => {
    let drains = 0;
    const log = captureErrors();
    const drain = openNativeDrain(() => {
      drains++;
      if (drains === 1) {
        wakeNative(drain.token);
        throw new Error("drain boom");
      }
      quitNativeLoop();
    });
    try {
      wakeNative(drain.token);
      runLoopFor();
    } finally {
      log.restore();
      drain.close();
    }
    expect(drains).toBe(2);
    expect(log.lines()).toEqual(["sweetview: UI dispatch failed: drain boom"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe.if(onWindows)("W1.3 / W1.4 the hooks' fallback: a handler that throws does not swallow", () => {
  let keys: KeyboardHook | undefined;
  let mouse: MouseHook | undefined;
  afterEach(() => {
    keys?.dispose();
    mouse?.dispose();
    keys = mouse = undefined;
    sendKey(VK_F24, true);
  });

  test("W1.3 a keyboard hook handler that throws is logged with today's message and the key reaches the system; a swallowing one keeps it", async () => {
    // Control: a handler that swallows keeps F24 from the system's key state.
    let swallowed = 0;
    keys = installKeyboardHook((m) => {
      if (m.code !== "F24") return false;
      swallowed++;
      return true;
    });
    sendKey(VK_F24, false);
    await pumpUntil(() => swallowed >= 1, 3000);
    await pumpFor(100);
    const downWhileSwallowed = keyDown(VK_F24);
    sendKey(VK_F24, true);
    await pumpUntil(() => swallowed >= 2, 3000);
    keys.dispose();
    keys = undefined;

    let thrown = 0;
    const log = captureErrors();
    try {
      keys = installKeyboardHook((m) => {
        if (m.code !== "F24") return false;
        thrown++;
        throw new Error("keyboard boom");
      });
      sendKey(VK_F24, false);
      await pumpUntil(() => thrown >= 1 && keyDown(VK_F24), 3000);
      const downAfterThrow = keyDown(VK_F24);
      sendKey(VK_F24, true);
      await pumpUntil(() => thrown >= 2 && !keyDown(VK_F24), 3000);
      expect({ swallowed, downWhileSwallowed, thrown, downAfterThrow }).toEqual({ swallowed: 2, downWhileSwallowed: false, thrown: 2, downAfterThrow: true });
    } finally {
      log.restore();
    }
    expect(log.lines()).toEqual(["sweetview: keyboard hook handler threw: keyboard boom", "sweetview: keyboard hook handler threw: keyboard boom"]);
  });

  test("onCallbackError: a keyboard hook handler's exception reaches the listener through the binding, once per call, with nothing printed, and the key still reaches the system (review N8)", async () => {
    const told: string[] = [];
    const off = onCallbackError((error, source) => void told.push(`${source.kind}: ${error.message}`));
    let thrown = 0;
    let downAfterThrow = false;
    const log = captureErrors();
    try {
      keys = installKeyboardHook((m) => {
        if (m.code !== "F24") return false;
        thrown++;
        throw new Error("keyboard boom");
      });
      sendKey(VK_F24, false);
      await pumpUntil(() => thrown >= 1 && keyDown(VK_F24), 3000);
      downAfterThrow = keyDown(VK_F24);
      sendKey(VK_F24, true);
      await pumpUntil(() => thrown >= 2 && !keyDown(VK_F24), 3000);
    } finally {
      off();
      log.restore();
    }
    expect({ thrown, downAfterThrow, told, printed: log.lines() }).toEqual({ thrown: 2, downAfterThrow: true, told: ["keyboardHook: keyboard boom", "keyboardHook: keyboard boom"], printed: [] });
  });

  test("onCallbackError: a mouse hook handler's exception reaches the listener through the binding, once per call, with nothing printed, and the pointer still moves (review N8)", async () => {
    const original = cursorNow();
    const told: string[] = [];
    const off = onCallbackError((error, source) => void told.push(`${source.kind}: ${error.message}`));
    const log = captureErrors();
    let thrown = 0;
    let moved = false;
    try {
      await untilDesktopIsOurs("a mouse button is held", () => !buttonsDown());
      mouse = installMouseHook(() => {
        thrown++;
        throw new Error("mouse boom");
      });
      const start = cursorNow();
      sendMouseMove(start.x > 100 ? -8 : 8, 0);
      await pumpUntil(() => thrown > 0 && cursorNow().x !== start.x, 3000);
      moved = cursorNow().x !== start.x;
      mouse.dispose();
      mouse = undefined;
    } finally {
      off();
      log.restore();
      user32!.SetCursorPos(original.x, original.y);
    }
    expect(moved).toBe(true);
    expect(thrown).toBeGreaterThan(0);
    // Every call that threw, and only those: another session's pointer may add calls of its own.
    expect(told).toEqual(Array.from({ length: thrown }, () => "mouseHook: mouse boom"));
    expect(log.lines()).toEqual([]);
  });

  test("W1.3 a mouse hook handler that throws lets the pointer move; a swallowing one holds it", async () => {
    // The throw's log and the hook disposing itself: input-hooks.test.ts. This is its fallback.
    const original = cursorNow();
    try {
      // A held button is another session's: wait for it to be let go, or fail saying why.
      await untilDesktopIsOurs("a mouse button is held", () => !buttonsDown());
      let swallowed = 0;
      mouse = installMouseHook(() => {
        swallowed++;
        return true;
      });
      const before = cursorNow();
      // Away from the nearer screen edge, where the cursor could not move further.
      const dx = before.x > 100 ? -8 : 8;
      sendMouseMove(dx, 0);
      await pumpUntil(() => swallowed > 0, 3000);
      await pumpFor(50);
      const heldAt = cursorNow();
      mouse.dispose();
      mouse = undefined;

      let thrown = 0;
      const log = captureErrors();
      let movedTo = before;
      try {
        mouse = installMouseHook(() => {
          thrown++;
          throw new Error("mouse boom");
        });
        const start = cursorNow();
        sendMouseMove(dx, 0);
        await pumpUntil(() => thrown > 0 && cursorNow().x !== start.x, 3000);
        movedTo = cursorNow();
        expect(movedTo.x).not.toBe(start.x);
      } finally {
        log.restore();
      }
      expect(heldAt).toEqual(before);
      expect(thrown).toBeGreaterThan(0);
      expect(log.lines()[0]).toBe("sweetview: mouse hook handler threw: mouse boom");
    } finally {
      user32!.SetCursorPos(original.x, original.y);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe.if(onWindows)("W1.3 / W1.4 a window's listeners", () => {
  const offscreen = { x: -3000, y: -3000, width: 300, height: 200 };
  const make = (what: string) => new Window({ title: unique(what), frame: false, noActivate: true, hideFromTaskbar: true, bounds: offscreen });
  const handleOf = (win: Window) => BigInt(win.handle!);

  test("W1.3 onResize, onMove, onClose and onFileDrop handlers that throw are logged with today's messages; the next handler and later events still arrive; the close request is still taken", async () => {
    const win = make("throws");
    const hwnd = handleOf(win);
    const seen: string[] = [];
    const log = captureErrors();
    try {
      win.onResize(() => {
        throw new Error("resize boom");
      });
      win.onResize((b) => seen.push(`resize ${b.width}`));
      win.onMove(() => {
        throw new Error("move boom");
      });
      win.onMove((b) => seen.push(`move ${b.x}`));
      win.onClose(() => {
        throw new Error("close boom");
      });
      win.onClose(() => seen.push("close"));
      win.onFileDrop(() => {
        throw new Error("drop boom");
      });
      win.onFileDrop((paths) => seen.push(`drop ${paths.length}`));

      win.setBounds({ ...offscreen, x: -2990, width: 310 });
      sendClose(hwnd);
      await sendDrop(hwnd, ["C:\\example\\one.txt"]);
      win.setBounds({ ...offscreen, x: -2980, width: 320 });
    } finally {
      log.restore();
    }
    try {
      // One setBounds raises both events; the OS picks their order.
      const settled = (list: string[]) => [...list.slice(0, 2).sort(), ...list.slice(2, 4), ...list.slice(4).sort()];
      expect(settled(seen)).toEqual(["move -2990", "resize 310", "close", "drop 1", "move -2980", "resize 320"]);
      // A listener that threw still took the close request: the window is open.
      expect(isWindow(hwnd)).toBe(true);
      expect(settled(log.lines())).toEqual([
        "sweetview: onMove handler threw: move boom",
        "sweetview: onResize handler threw: resize boom",
        "sweetview: onClose handler threw: close boom",
        "sweetview: onFileDrop handler threw: drop boom",
        "sweetview: onMove handler threw: move boom",
        "sweetview: onResize handler threw: resize boom",
      ]);
    } finally {
      win.dispose();
    }
  });

  test("W1.4 an onResize handler removes itself, an onMove handler replaces itself, and an onFileDrop handler removes itself, each from inside its own call", async () => {
    const win = make("remove-self");
    const hwnd = handleOf(win);
    const seen: string[] = [];
    try {
      const offResize = win.onResize(() => {
        seen.push("resize once");
        offResize();
      });
      const offMove = win.onMove(() => {
        seen.push("move A");
        offMove();
        win.onMove(() => seen.push("move B"));
      });
      const offDrop = win.onFileDrop(() => {
        seen.push("drop once");
        offDrop();
      });
      win.setBounds({ ...offscreen, x: -2990, width: 310 });
      win.setBounds({ ...offscreen, x: -2980, width: 320 });
      await sendDrop(hwnd, ["C:\\example\\one.txt"]);
      await sendDrop(hwnd, ["C:\\example\\two.txt"]);
      // One setBounds raises both events; the OS picks their order, so each kind is read on its own.
      expect(seen.filter((s) => s.startsWith("resize"))).toEqual(["resize once"]);
      expect(seen.filter((s) => s.startsWith("move"))).toEqual(["move A", "move B"]);
      expect(seen.filter((s) => s.startsWith("drop"))).toEqual(["drop once"]);
    } finally {
      win.dispose();
    }
  });

  test("W1.3 / W1.4 a close request no listener takes disposes the window from inside the binding's call; a dispose hook that throws is logged with today's message", async () => {
    const win = make("default close");
    const hwnd = handleOf(win);
    let hooks = 0;
    const log = captureErrors();
    try {
      onWindowDispose(win, () => {
        hooks++;
        throw new Error("dispose hook boom");
      });
      onWindowDispose(win, () => hooks++);
      sendClose(hwnd);
      await pumpFor(50);
    } finally {
      log.restore();
      win.dispose();
    }
    expect(hooks).toBe(2);
    expect(isWindowDisposed(win)).toBe(true);
    expect(isWindow(hwnd)).toBe(false);
    expect(log.lines()).toEqual(["sweetview: window dispose hook threw: dispose hook boom"]);
  });
});

// ---------------------------------------------------------------------------------------------

// TabFrame.onActivate: the frame of a tabbed window (public `new Window({ tabs: true })`), reached
// as src/win32/tab-window.ts reaches it (`TabFrame.of(handle)`, and `getTabFrame` for the tabs
// library's own callbacks). Activation is driven by sending WM_ACTIVATE to the frame, as the OS
// sends it, so no foreground is needed: the low word is WA_ACTIVE (1) or WA_INACTIVE (0).
describe.if(onWindows)("W1.3 / W1.4 a tab frame's activation listener", () => {
  const WM_ACTIVATE = 0x0006;
  const make = (what: string) =>
    new Window({ title: unique(what), tabs: true, noActivate: true, hideFromTaskbar: true, bounds: { x: -3000, y: -3000, width: 500, height: 300 } });
  const activate = (hwnd: bigint, on: boolean) => user32!.SendMessageW(hwnd, WM_ACTIVATE, on ? 1n : 0n, null);
  /** Folds consecutive repeats. */
  const dedupe = <T>(list: T[]) => list.filter((item, i) => i === 0 || item !== list[i - 1]);

  test("W1.3 an onActivate callback that throws is logged with today's message; the next callback and later activations still arrive", async () => {
    const { getTabFrame } = await import("./win32/tab-window");
    const win = make("activate throws");
    const hwnd = BigInt(win.handle!);
    const seen: string[] = [];
    const log = captureErrors();
    try {
      const frame = getTabFrame(hwnd)!;
      expect(frame).toBeDefined();
      frame.addCallbacks({
        onActivate(active) {
          seen.push(`throwing ${active}`);
          throw new Error("activate boom");
        },
      });
      frame.addCallbacks({ onActivate: (active) => void seen.push(`next ${active}`) });
      activate(hwnd, true);
      activate(hwnd, false);
      activate(hwnd, true);
    } finally {
      log.restore();
      win.dispose();
    }
    // Each activation reaches the throwing callback and then the next one. The default window
    // procedure may report a state a second time (focus moves inside it), so repeats are folded.
    const pairs = seen.flatMap((entry, i) => (i % 2 === 0 ? [`${entry} | ${seen[i + 1]}`] : []));
    expect(pairs.every((pair) => pair === "throwing true | next true" || pair === "throwing false | next false")).toBe(true);
    expect(dedupe(pairs)).toEqual(["throwing true | next true", "throwing false | next false", "throwing true | next true"]);
    expect(log.lines()).toEqual(pairs.map(() => "sweetview: a tab frame's onActivate callback threw: activate boom"));
  });

  test("W1.4 the tabs library's onActivate callback removes itself from inside its own call", async () => {
    const { getTabFrame } = await import("./win32/tab-window");
    const win = make("library callback removes itself");
    const hwnd = BigInt(win.handle!);
    const calls: boolean[] = [];
    try {
      const frame = getTabFrame(hwnd)!;
      const remove = frame.addCallbacks({
        onActivate(active) {
          calls.push(active);
          remove();
        },
      });
      activate(hwnd, true);
      activate(hwnd, false);
      expect(calls).toEqual([true]);
    } finally {
      win.dispose();
    }
  });

});

// ---------------------------------------------------------------------------------------------

describe.if(onWindows)("W1.3 / W1.4 the hit-region refiner", () => {
  const bounds = { x: 280, y: 260, width: 300, height: 200 };
  const leftHalf = [[{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 200 }, { x: 0, y: 200 }]];
  const passing = (hwnd: bigint) => (BigInt.asUintN(32, BigInt(user32!.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))) & WS_EX_TRANSPARENT) !== 0n;

  /** A shown, topmost window under a cursor the test moves; waits for held buttons to be let go (the poll freezes while one is), or throws why. */
  async function withRefinerWindow(what: string, body: (win: Window, hwnd: bigint, at: (x: number, y: number) => void) => Promise<void>) {
    await untilDesktopIsOurs(`${what}: a mouse button is held, which freezes the poll`, () => !buttonsDown());
    const original = cursorNow();
    const win = new Window({ title: unique(what), frame: false, topmost: true, noActivate: true, hideFromTaskbar: true, bounds });
    try {
      win.show();
      await body(win, BigInt(win.handle!), (x, y) => void user32!.SetCursorPos(bounds.x + x, bounds.y + y));
    } finally {
      user32!.SetCursorPos(original.x, original.y);
      win.dispose();
    }
  }

  test("W1.3 a refiner that throws is logged with today's message, leaves the window solid, and is asked again at the next point", async () => {
    await withRefinerWindow("refiner throws", async (win, hwnd, at) => {
      const asked: string[] = [];
      const log = captureErrors();
      try {
        at(250, 50); // outside the polygon first, so the next point inside asks
        await pumpFor(60);
        win.setHitRegions(leftHalf, (local) => {
          asked.push(`${local.x},${local.y}`);
          throw new Error("refine boom");
        });
        at(40, 40);
        await pumpUntil(() => asked.length >= 1, 2000);
        at(60, 70);
        await pumpUntil(() => asked.length >= 2, 2000);
      } finally {
        log.restore();
      }
      expect(asked.slice(0, 2)).toEqual(["40,40", "60,70"]);
      expect(passing(hwnd)).toBe(false); // no answer: the polygon's own answer, solid, stands
      expect(log.lines().slice(0, 2)).toEqual(["sweetview: hit region poll threw: refine boom", "sweetview: hit region poll threw: refine boom"]);
    });
  });

  test("onCallbackError: a refiner's exception reaches the listener through the binding, once per ask, with nothing printed, and the window stays solid (review N8)", async () => {
    await withRefinerWindow("refiner reports", async (win, hwnd, at) => {
      const asked: string[] = [];
      const told: string[] = [];
      const off = onCallbackError((error, source) => void told.push(`${source.kind}: ${error.message}`));
      const log = captureErrors();
      try {
        at(250, 50); // outside the polygon first, so the next point inside asks
        await pumpFor(60);
        win.setHitRegions(leftHalf, (local) => {
          asked.push(`${local.x},${local.y}`);
          throw new Error("refine boom");
        });
        at(40, 40);
        await pumpUntil(() => asked.length >= 1, 2000);
        at(60, 70);
        await pumpUntil(() => asked.length >= 2, 2000);
      } finally {
        off();
        log.restore();
      }
      expect(asked.slice(0, 2)).toEqual(["40,40", "60,70"]);
      expect(told).toEqual(asked.map(() => "hitRegions.refine: refine boom"));
      expect(passing(hwnd)).toBe(false);
      expect(log.lines()).toEqual([]);
    });
  });

});

// ---------------------------------------------------------------------------------------------

describe.if(onWindows)("W1.3 / W1.4 the tray's click, menu function and menu item", () => {
  test("W1.3 a click handler that throws is logged with today's message, and the next click is delivered", async () => {
    const { TRAY, doubleClickTime, postTrayMouse } = await import("../test/win32-os");
    const { createTray } = await import("./win32/tray");
    let clicks = 0;
    const log = captureErrors();
    const tray = createTray({
      tooltip: unique("tray"),
      onClick: () => {
        clicks++;
        throw new Error("click boom");
      },
    });
    try {
      const wait = doubleClickTime() + 2000;
      postTrayMouse(tray.windowHandle(), TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
      await pumpUntil(() => clicks === 1, wait);
      postTrayMouse(tray.windowHandle(), TRAY.LBUTTONDOWN, TRAY.LBUTTONUP);
      await pumpUntil(() => clicks === 2, wait);
    } finally {
      log.restore();
      tray.dispose();
    }
    expect(clicks).toBe(2);
    expect(log.lines()).toEqual(["sweetview: message window handler threw: click boom", "sweetview: message window handler threw: click boom"]);
  }, 20_000);

  test("W1.3 a menu function that throws is logged with today's message and opens no menu; the next right click opens one", async () => {
    const { TRAY, VK, openPopupMenu, postTrayMouse, pressKeys } = await import("../test/win32-os");
    const { createTray } = await import("./win32/tray");
    let opened = 0;
    let shown = 0;
    const log = captureErrors();
    const tray = createTray({
      tooltip: unique("tray"),
      menu: () => {
        opened++;
        if (opened === 1) throw new Error("menu function boom");
        return [{ label: "Only" }];
      },
    });
    let noMenuAfterThrow: boolean | undefined;
    try {
      postTrayMouse(tray.windowHandle(), TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
      await pumpUntil(() => opened === 1);
      await pumpFor(200);
      noMenuAfterThrow = openPopupMenu() === 0n;
      await whenMenuOpens((menuWindow) => {
        shown++;
        pressKeys(menuWindow, VK.ESCAPE);
      });
      postTrayMouse(tray.windowHandle(), TRAY.RBUTTONDOWN, TRAY.RBUTTONUP);
      await pumpUntil(() => opened === 2 && shown === 1 && openPopupMenu() === 0n);
    } finally {
      log.restore();
      tray.dispose();
    }
    expect({ opened, shown, noMenuAfterThrow }).toEqual({ opened: 2, shown: 1, noMenuAfterThrow: true });
    expect(log.lines()).toEqual(["sweetview: message window handler threw: menu function boom"]);
  }, 20_000);

  test("W1.3 a menu item's click that throws is logged with today's message, and the next choice runs", async () => {
    const { openPopupMenu } = await import("../test/win32-os");
    const { createTray } = await import("./win32/tray");
    let clicks = 0;
    const log = captureErrors();
    const tray = createTray({
      tooltip: unique("tray"),
      menu: () => [
        {
          label: "Boom",
          click: () => {
            clicks++;
            throw new Error("menu item boom");
          },
        },
      ],
    });
    try {
      for (let round = 1; round <= 2; round++) await chooseFirstTrayItem(tray.windowHandle(), () => clicks === round);
      expect(openPopupMenu()).toBe(0n);
    } finally {
      log.restore();
      tray.dispose();
    }
    expect(clicks).toBe(2);
    expect(log.lines()).toEqual(["sweetview: message window handler threw: menu item boom", "sweetview: message window handler threw: menu item boom"]);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------

describe.if(onWindows)("W1.3 / W1.4 the single-instance handoff and onOpenUrl", () => {
  afterEach(() => _resetActivationForTest());
  const appIdOf = (what: string) => `dev.sweetview.test.callbacks-${what}-${process.pid}-${Date.now()}`;

  test("W1.3 an onSecondInstance handler and an onOpenUrl listener that throw are logged with today's messages; the other listener and the next handoff still arrive", async () => {
    const appId = appIdOf("throws");
    let seconds = 0;
    const urls: string[] = [];
    const log = captureErrors();
    onOpenUrl(() => {
      throw new Error("open url boom");
    });
    onOpenUrl((url) => urls.push(url));
    signalReady();
    const lock = await singleInstance({
      appId,
      args: [],
      onSecondInstance: () => {
        seconds++;
        throw new Error("second instance boom");
      },
    });
    let answers: number[] = [];
    try {
      expect(lock.isPrimary).toBe(true);
      answers = [
        handOff(appId, { args: ["svtest://one"], cwd: "C:\\", url: "svtest://one" }),
        handOff(appId, { args: ["svtest://two"], cwd: "C:\\", url: "svtest://two" }),
      ];
    } finally {
      log.restore();
      lock.dispose();
    }
    expect(answers).toEqual([1, 1]);
    expect(seconds).toBe(2);
    expect(urls).toEqual(["svtest://one", "svtest://two"]);
    expect(log.lines()).toEqual([
      "sweetview: onOpenUrl handler threw: open url boom",
      "sweetview: onSecondInstance handler threw: second instance boom",
      "sweetview: onOpenUrl handler threw: open url boom",
      "sweetview: onSecondInstance handler threw: second instance boom",
    ]);
  });

  test("W1.4 an onSecondInstance handler disposes its lock, and an onOpenUrl listener removes itself, from inside their own calls", async () => {
    const appId = appIdOf("dispose");
    const urls: string[] = [];
    const off = onOpenUrl((url) => {
      urls.push(url);
      off();
    });
    signalReady();
    let seconds = 0;
    const lock = await singleInstance({
      appId,
      args: [],
      onSecondInstance: () => {
        seconds++;
        lock.dispose();
      },
    });
    let next: Awaited<ReturnType<typeof singleInstance>> | undefined;
    try {
      expect(lock.isPrimary).toBe(true);
      expect(handOff(appId, { args: [], cwd: "C:\\", url: "svtest://one" })).toBe(1);
      expect(seconds).toBe(1);
      expect(urls).toEqual(["svtest://one"]);
      // The lock is released: its window is gone and the next acquire is primary.
      expect(singleInstanceWindow(appId)).toBe(0n);
      expect(handOff(appId, { args: [], cwd: "C:\\" })).toBe(-1);
      next = await singleInstance({ appId, args: [], onSecondInstance: () => seconds++ });
      expect(next.isPrimary).toBe(true);
      expect(handOff(appId, { args: [], cwd: "C:\\", url: "svtest://two" })).toBe(1);
      expect(seconds).toBe(2);
      expect(urls).toEqual(["svtest://one"]); // the listener removed itself
    } finally {
      lock.dispose();
      next?.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe.if(onWindows)("W1.3 the binding's backstop, straight through the binding", () => {
  test("W1.3 an exception from every non-webview kind, with no TypeScript wrapper in between, is logged by the binding with its kind; each fallback applies and the loop goes on", async () => {
    const { r, stderr, exitCode } = await runFixture("callback-backstop.ts");
    expect(exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
    expect(r).toMatchObject({
      deferredAfter: true,
      timeoutAfter: true,
      intervalCalls: 3,
      drains: 2,
      probeTransformThrew: null,
      probeDone: "pong",
      windowAfterEvents: true,
      closeRequestTaken: true,
      dropAfter: true,
      trayClicks: 2,
      trayDoubleClicks: 1,
      trayNoMenuAfterThrow: true,
      trayChosen: 1,
      notifierClicks: 2,
      handOffAnswers: [1, 1],
      keyReachedSystem: true,
      keyboardCalls: 1,
      mouseMoved: true,
      tabFrameLiveAfterThrow: true,
    });
    // WA_ACTIVE then WA_INACTIVE; the default procedure may report a state twice.
    const activations = r.tabActivations as boolean[];
    expect(activations.filter((a, i) => i === 0 || a !== activations[i - 1])).toEqual([true, false]);
    const expected = [
      "sweetview: a deferred job threw: Error: deferred boom",
      "sweetview: a native timeout threw: Error: timeout boom",
      "sweetview: a native interval threw: Error: interval boom",
      "sweetview: a drain function threw: Error: drain boom",
      "sweetview: a probe threw: Error: probe boom",
      "sweetview: a probe's completion threw: Error: probe completion boom",
      "sweetview: an onResize handler threw: Error: resize boom",
      "sweetview: an onMove handler threw: Error: move boom",
      "sweetview: an onClose handler threw: Error: close boom",
      "sweetview: an onFileDrop handler threw: Error: drop boom",
      "sweetview: a window's default close threw: Error: default close boom",
      "sweetview: a tray click handler threw: Error: tray click boom",
      "sweetview: a tray double-click handler threw: Error: tray double-click boom",
      "sweetview: a tray menu function threw: Error: tray menu function boom",
      "sweetview: a tray menu handler threw: Error: tray menu handler boom",
      "sweetview: a notification onClick threw: Error: notification boom",
      "sweetview: a singleInstance onSecondInstance threw: Error: second instance boom",
      "sweetview: a keyboard hook handler threw: Error: keyboard boom",
      "sweetview: a mouse hook handler threw: Error: mouse boom",
      "sweetview: a hit-region refiner threw: Error: refine boom",
      "sweetview: a tab frame's activation listener threw: Error: activate boom",
    ];
    // The refiner step needs the cursor and no held button; the fixture retried it. Never a silent pass.
    if (r.refineSkipped) throw new Error(`not run: the raw refiner step: ${r.refineSkipped}`);
    expect(r.refinerAsked).toBe(true);
    for (const line of expected) expect(stderr).toContain(line);
    // The interval threw on each of its three runs, and the drain once.
    expect(stderr.split("interval boom").length - 1).toBe(3);
    // The activation listener threw on every call and stayed registered.
    expect(stderr.split("activate boom").length - 1).toBe(activations.length);
    // Every line the binding wrote is one of these.
    const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith("sweetview:"));
    for (const line of lines) expect(expected).toContain(line);
  }, 60_000);
});

// onCallbackError (src/callback-errors.ts): the same kinds, with a listener set. Each exception
// arrives once with its kind and the handler's error, Sweetview prints nothing, the fallback still
// applies; a listener that throws, a thrown non-error, the binding's sink, and today's lines back
// once the listener is removed. Run in a process of its own (test/fixtures/callback-errors.ts),
// whose stderr carries the binding's own lines. No input is injected.
describe.if(onWindows)("onCallbackError", () => {
  test("with a listener, every kind arrives once with its kind and error, nothing is printed, and each fallback applies", async () => {
    // A deadline of the parent's own, which ends this child only: a fixture stuck where its own
    // watchdog cannot run (inside a modal menu loop) is not left on the shared desktop (review 3, item 6).
    const { r, stderr, exitCode } = await runFixture("callback-errors.ts", ["listener"], {}, 100_000);
    expect({ exitCode, timedOut: r.timedOut }).toEqual({ exitCode: 0, timedOut: undefined });
    const arrived = (r.arrivals as { kind: string; name?: string; message: string; isError: boolean }[]).map((a) => `${a.kind}${a.name ? ` (${a.name})` : ""}: ${a.message}${a.isError ? "" : " (not an Error)"}`);
    expect([...arrived].sort()).toEqual(
      [
        "internal: deferred boom",
        "internal: timeout boom",
        // The binding caught this one itself: its reason, the exception as a string, is the message.
        "internal (a native interval): interval boom",
        "worker: drain boom",
        "window.onMove: onMove boom",
        "window.onResize: onResize boom",
        "window.onClose: onClose boom",
        "window.onMaximizeChange: onMaximizeChange boom",
        "window.onMaximizeChange: window chrome emit boom",
        "window.onFileDrop: onFileDrop boom",
        "window.onNewTab: onNewTab boom",
        "window.onTabSelect: onTabSelect boom",
        "window.onTabClose: onTabClose boom",
        "internal: dispose hook boom",
        "tray.onClick: tray click boom",
        "tray.onDoubleClick: tray double click boom",
        "tray.menu: tray menu boom",
        "menu.click: menu item boom",
        "notifier.onClick: notification click boom",
        "onOpenUrl: open url boom",
        "singleInstance.onSecondInstance: second instance boom",
      ].sort(),
    );
    expect(r.printedWithListener).toEqual([]);
    expect(r.steps).toEqual({
      intervalKeptItsSchedule: true,
      closeRequestStillTaken: true,
      throwingMenuOpensNoMenu: true,
      noMenuLeftOpen: true,
      handedOff: 1,
    });
    expect(r.throwingListener).toEqual({
      printed: ["sweetview: UI dispatch failed: deferred again boom", "sweetview: an onCallbackError handler threw: listener boom"],
      nextListener: ["internal: deferred again boom"],
      recorded: ["internal: deferred again boom"],
    });
    expect(r.nonError).toEqual([{ kind: "internal", message: "a string", isError: true, cause: "a string" }]);
    expect(r.printedWithoutListener).toEqual(["sweetview: UI dispatch failed: deferred without listener boom"]);
    expect(r.arrivalsWithoutListener).toBe(0);
    // The binding's own lines: none while Sweetview's sink was set; both when a raw sink threw; today's line once nothing is set.
    expect(stderr.split(/\r?\n/).filter((line) => line.startsWith("sweetview:"))).toEqual([
      "sweetview: a native interval threw: Error: raw interval boom",
      "sweetview: the callback error sink threw: Error: raw sink boom",
      "sweetview: a native interval threw: Error: interval without listener",
    ]);
  }, 120_000);

  test("registering a window listener reads nothing from the application's function, and no function can name its own kind (review 2, item 3)", async () => {
    const { r, exitCode } = await runFixture("callback-errors.ts", ["registration"]);
    expect({ exitCode, readsWhileRegistering: r.readsWhileRegistering, told: r.told }).toEqual({ exitCode: 0, readsWhileRegistering: 0, told: ["window.onResize: claims another kind"] });
  }, 60_000);

  test("a fault raised while a listener runs is printed, not delivered again: a listener that resizes a window whose onResize throws is called once (review N6)", async () => {
    const { r, exitCode } = await runFixture("callback-errors.ts", ["reentry"]);
    expect({ exitCode, calls: r.calls, printed: r.printed }).toEqual({ exitCode: 0, calls: 1, printed: ["sweetview: onResize handler threw: resize boom"] });
  }, 60_000);

  test("windowChromeEvents: its listener is a Window#onMaximizeChange listener; the thrown value is never touched, with or without a listener (review F3)", async () => {
    const { r, exitCode } = await runFixture("callback-errors.ts", ["chrome"]);
    expect(exitCode).toBe(0);
    expect(r.printedWithoutListener).toEqual(["sweetview: onMaximizeChange handler threw: frozen without listener"]);
    expect(r.told).toEqual([
      "window.onMaximizeChange: chrome primitive (not the thrown value)",
      "window.onMaximizeChange: frozen with listener",
      "window.onMaximizeChange: thrown twice",
      "internal: thrown twice",
    ]);
    expect(r.printedWithListener).toEqual([]);
  }, 60_000);

  for (const mode of ["exit-blocking", "exit-pumped", "exit-run-event-loop"]) {
    test(`a listener that calls process.exit(3) from inside a native callback ends the process with 3 (${mode === "exit-blocking" ? "the blocking loop" : mode === "exit-pumped" ? "the loop pumped by hand" : "runEventLoop"}), and the end of the application releases cleanly`, async () => {
      // Spawned here, not through runFixture: a process the listener ends prints no RESULT line.
      const profile = mkdtempSync(join(tmpdir(), "sweetview-callback-exit-"));
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/callback-errors.ts", import.meta.url)), mode], {
        env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      expect({ exitCode, result: stdout.includes("RESULT"), sweetviewLines: stderr.split(/\r?\n/).filter((line) => /sweetview|panic|error/i.test(line)) }).toEqual({ exitCode: 3, result: false, sweetviewLines: [] });
    }, 60_000);
  }
});

// The sink onCallbackError registers with the binding (review F1, F8, N4, F9), from
// test/fixtures/callback-sink.ts in a process of its own each.
describe.if(onWindows)("onCallbackError's sink in the binding", () => {
  const UI_THREAD = "sweetview: this call must be made on the UI thread";
  const spawnSink = async (mode: string) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../test/fixtures/callback-sink.ts", import.meta.url)), mode], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
    return { r: line ? JSON.parse(line.slice("RESULT ".length)) : undefined, stderr, exitCode };
  };

  // What the binding's own catch does with each kind of thrown value (review 3, item 2 and Q1): it
  // reads nothing of the value, leaves nothing pending, and follows no cause.
  const VALUES = ["string", "number", "null", "undefined", "symbol", "no prototype", "toString throws", "plain object", "error", "error whose cause is itself", "error whose message throws"];
  test("every kind of value thrown past the TypeScript catches reaches a listener as it is, and the next call into the binding works", async () => {
    const { r, exitCode, stderr } = await spawnSink("values-listen");
    expect(exitCode).toBe(0);
    expect(r.after).toEqual(VALUES.map((v) => `${v}: ran, returned`));
    const wrapped = (message: string) => ({ name: "a native timeout", kind: "internal", message, isThrown: false, causeIsThrown: true });
    expect(r.told).toEqual([
      wrapped("disconnected"),
      wrapped("42"),
      wrapped("null"),
      wrapped("undefined"),
      wrapped("Symbol(thrown)"),
      wrapped("[object Object]"),
      wrapped("[object Object]"),
      wrapped("[object Object]"),
      { name: "a native timeout", kind: "internal", message: "boom", isThrown: true, causeIsThrown: false },
      { name: "a native timeout", kind: "internal", message: "loop", isThrown: true, causeIsThrown: true },
      // The thrown object itself, its unreadable message left to the listener (review 4, C3).
      { name: "a native timeout", kind: "internal", message: "(its message throws)", isThrown: true, causeIsThrown: false },
    ]);
    expect(stderr).toBe("");
  });

  test("with no listener, each kind of value thrown past the TypeScript catches prints the main branch's line, leaves nothing pending, and a cause that is itself is not followed", async () => {
    const { r, exitCode, stderr } = await spawnSink("values");
    expect(exitCode).toBe(0);
    expect(r.after).toEqual(VALUES.map((v) => `${v}: ran, returned`));
    // The main branch's lines: napi keeps no reference to a primitive below Node-API 10, which is
    // the text for the first four; a value whose String() throws gives none. The main branch left
    // the symbol's exception pending (the pump then threw it) and overflowed the stack on the error
    // whose cause is itself; here each prints its line and the pump returns.
    const line = (reason: string) => `sweetview: a native timeout threw: ${reason}`;
    expect(stderr.split(/\r?\n/).filter(Boolean)).toEqual([
      line("Create Error reference failed"),
      line("Create Error reference failed"),
      line("Create Error reference failed"),
      line("Create Error reference failed"),
      line(""),
      line(""),
      line(""),
      line("[object Object]"),
      line("Error: boom"),
      line("Error: loop"),
      // Its String() reads the message, which throws: no text, as napi's coercion gave none.
      line(""),
    ]);
  });

  test("the binding's guard holds Reflect.apply, Object.create and String as they were when the binding loaded, not as the application patched them before its first callback", async () => {
    const { r, exitCode, stderr } = await spawnSink("patched-globals");
    expect({ exitCode, ran: r.ran, told: r.told }).toEqual({ exitCode: 0, ran: 2, told: ["a native timeout: second"] });
    expect(stderr.split(/\r?\n/).filter(Boolean)).toEqual(["sweetview: a native timeout threw: Error: first"]);
  });

  test("a listener registered while the binding reads a value thrown with none set hears nothing of that fault, and its line is printed", async () => {
    const { r, exitCode, stderr } = await spawnSink("late-listener");
    expect({ exitCode, told: r.told }).toEqual({ exitCode: 0, told: [] });
    expect(stderr.split(/\r?\n/).filter(Boolean)).toEqual(["sweetview: a native timeout threw: registers a listener"]);
  });

  test("a Worker that calls onCallbackError first is refused, loads nothing, and the main thread stays the UI thread", async () => {
    const { r, exitCode } = await spawnSink("worker-first");
    expect({ exitCode, worker: r.worker, windowOnThisThread: r.windowOnThisThread }).toEqual({ exitCode: 0, worker: UI_THREAD, windowOnThisThread: null });
  });

  test("the binding refuses a sink from a thread that is not the UI thread", async () => {
    const { r, exitCode } = await spawnSink("worker-raw");
    expect({ exitCode, worker: r.worker }).toEqual({ exitCode: 0, worker: UI_THREAD });
  });

  test("a binding without setCallbackErrorSink makes onCallbackError throw, as any missing export does", async () => {
    const { r, exitCode } = await spawnSink("missing-export");
    expect(exitCode).toBe(0);
    expect(r.registration).toContain("setCallbackErrorSink");
  });

  test("after releaseAll() a listener still hears of the binding's own catches", async () => {
    const { r, exitCode } = await spawnSink("after-release");
    expect({ exitCode, told: r.told }).toEqual({ exitCode: 0, told: ["internal (a native interval): interval after release"] });
  });

  test("a sink a Worker set straight through the binding, having loaded it first, is released when the worker's environment ends: the environment's cleanup hook (review 2, item 6)", async () => {
    const { r, exitCode, stderr } = await spawnSink("worker-raw-first");
    expect({ exitCode, worker: r.worker, stderr: stderr.trim() }).toEqual({ exitCode: 0, worker: "set", stderr: "" });
  });

  test("a sink set by an application that makes nothing else is released when its environment ends, and nothing is printed", async () => {
    const { exitCode, stderr } = await spawnSink("at-end");
    expect({ exitCode, stderr: stderr.trim() }).toEqual({ exitCode: 0, stderr: "" });
  });
});

// The raw webview class's callback boundaries with a listener set (review F6, N3), from
// test/fixtures/webview-errors.ts. The drop is the DevTools protocol's; no input is injected.
describe.if(onWindows)("onCallbackError and the raw webview class", () => {
  // With no listener, each boundary prints what it printed on the main branch, as often (review 4,
  // C1): a value whose reading threw left the TypeScript catch for the binding's own there.
  test("with no listener, the raw webview's faults print the main branch's lines, once each", async () => {
    const { r, exitCode, stderr } = await runFixture("webview-errors.ts", ["none"]);
    expect({ exitCode, proxy: r.page?.proxy, promiseThenGetter: r.page?.promiseThenGetter, bindProxy: r.page?.bindProxy, rawThrows: r.page?.rawThrows }).toEqual({ exitCode: 0, proxy: 500, promiseThenGetter: 500, bindProxy: "rejected", rawThrows: "unanswered" });
    expect(stderr.split(/\r?\n/).filter((line) => line.startsWith("sweetview:"))).toEqual([
      "sweetview: a binding threw: Error: getPrototypeOf trap",
      "sweetview: a binding threw: Error: raw throws",
      "sweetview: a binding threw: Error: shared",
      "sweetview: a binding threw: Error: shared",
      "sweetview: a request handler threw: Error: returned getPrototypeOf trap",
      "sweetview: a request handler threw: Error: request then getter",
      "sweetview: a request handler threw: Error: request then throws",
    ]);
  }, 90_000);

  test("a bound function, a raw binding, a request handler and a file drop handler: each fault arrives once with its kind, and the page still gets its failure", async () => {
    const { r, exitCode } = await runFixture("webview-errors.ts");
    expect({ exitCode, timedOut: r.timedOut }).toEqual({ exitCode: 0, timedOut: undefined });
    expect(r.page).toEqual({
      bindThrows: "rejected",
      bindRejects: "rejected",
      bindProxy: "rejected",
      bindBadMessage: "rejected",
      bindAddsListener: "rejected: adds a listener",
      bindThenGetter: "rejected",
      bindThenThrows: "rejected",
      throws: 500,
      rejects: 500,
      proxy: 500,
      promiseThenGetter: 500,
      promiseThenThrows: 500,
      thenable: 200,
      rawThrows: "unanswered",
    });
    expect(r.told).toEqual(
      [
        "webview.bind (bindThrows): bind throws",
        "webview.bind (bindRejects): bind rejects",
        "webview.bind (bindProxy): [object Object]",
        "webview.bind (bindBadMessage): (its message throws)",
        "webview.bind (bindAddsListener): adds a listener",
        "webview.bind (bindThenGetter): then getter",
        "webview.bind (bindThenThrows): then throws",
        "webview.setRequestHandler: returned getPrototypeOf trap",
        "webview.setRequestHandler: request then getter",
        "webview.setRequestHandler: request then throws",
        "webview.bindRaw (rawThrows): raw throws",
        "webview.bindRaw (save): shared [the thrown object]",
        "webview.bindRaw (load): shared [the thrown object]",
        "webview.setRequestHandler: request throws",
        "webview.setRequestHandler: request rejects",
        "webview.setFileDropHandler: drop throws",
      ].sort(),
    );
    // A listener added while the page's reply read the thrown value does not hear that fault
    // (review 3, item 3): the listeners were taken before the reply.
    expect(r.lateTold).toEqual([]);
  }, 90_000);
});
