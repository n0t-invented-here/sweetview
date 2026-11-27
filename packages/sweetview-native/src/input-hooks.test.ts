// The system-wide hooks and the permission model, through the public API (checklist group W3).
// Real input is injected with SendInput, which is why this test file uses bun:ffi: it is a probe
// of the OS, not part of the package. Each injection is a one-pixel pointer move or the F24 key,
// which no application binds, and every key pressed is released.

import { afterEach, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { binding } from "./binding";
import {
  Feature,
  installKeyboardHook,
  installMouseHook,
  KeyEvent,
  Modifier,
  modifiersFrom,
  MouseEvent,
  Permission,
  permissions,
  type KeyboardHook,
  type KeyMessage,
  type MouseHook,
  type MouseMessage,
} from "./index";

const onWindows = process.platform === "win32";

const user32 = onWindows
  ? dlopen("user32.dll", {
      SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
      // Read back what reached the system: the key's state and the pointer's position.
      GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
      GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
      SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols
  : undefined;

/** The system's state of a key: down when the last event of it that reached the system was a press. */
const keyIsDown = (virtualKey: number) => user32!.GetAsyncKeyState(virtualKey) < 0;

function cursorNow(): { x: number; y: number } {
  const point = new Int32Array(2);
  user32!.GetCursorPos(ptr(point));
  return { x: point[0]!, y: point[1]! };
}

const INPUT_SIZE = 40; // sizeof(INPUT) on x64
const VK_F24 = 0x87;

function sendMouseMove(dx: number, dy: number) {
  const input = new DataView(new ArrayBuffer(INPUT_SIZE));
  input.setUint32(0, 0, true); // INPUT_MOUSE
  input.setInt32(8, dx, true);
  input.setInt32(12, dy, true);
  input.setUint32(20, 0x0001, true); // MOUSEEVENTF_MOVE
  user32!.SendInput(1, ptr(input.buffer), INPUT_SIZE);
}

function sendKey(virtualKey: number, up: boolean) {
  const input = new DataView(new ArrayBuffer(INPUT_SIZE));
  input.setUint32(0, 1, true); // INPUT_KEYBOARD
  input.setUint16(8, virtualKey, true);
  input.setUint32(12, up ? 0x0002 : 0, true); // KEYEVENTF_KEYUP
  user32!.SendInput(1, ptr(input.buffer), INPUT_SIZE);
}

/** Pumps the UI thread's loop, which is what delivers a hook's events, until `done` or a deadline. */
function pumpUntil(done: () => boolean, ms = 3000) {
  const native = binding();
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) native.pumpEvents();
}

let mouse: MouseHook | undefined;
let keys: KeyboardHook | undefined;
afterEach(() => {
  mouse?.dispose();
  keys?.dispose();
  mouse = keys = undefined;
  if (onWindows) sendKey(VK_F24, true);
});

describe("modifier helpers", () => {
  test("modifiersFrom splits the mask into its four keys", () => {
    expect(modifiersFrom(0)).toEqual({ shift: false, ctrl: false, alt: false, meta: false });
    expect(modifiersFrom(Modifier.Shift | Modifier.Alt)).toEqual({ shift: true, ctrl: false, alt: true, meta: false });
    expect(modifiersFrom(Modifier.Control | Modifier.Meta)).toEqual({ shift: false, ctrl: true, alt: false, meta: true });
  });
});

describe.if(onWindows)("installMouseHook (W3.1)", () => {
  test("a move arrives with coordinates and modifiers, a second hook is refused, dispose is idempotent", () => {
    const seen: MouseMessage[] = [];
    mouse = installMouseHook((m) => {
      seen.push(m);
      return false;
    });
    expect(() => installMouseHook(() => false)).toThrow("webview_mouse_hook_install failed: a mouse hook is already installed");
    sendMouseMove(1, 0);
    pumpUntil(() => seen.some((m) => m.event === MouseEvent.Move));
    sendMouseMove(-1, 0);
    pumpUntil(() => seen.filter((m) => m.event === MouseEvent.Move).length >= 2);
    const move = seen.find((m) => m.event === MouseEvent.Move);
    expect(move).toBeDefined();
    expect(Number.isFinite(move!.x) && Number.isFinite(move!.y)).toBe(true);
    expect(move!.wheel).toBe(0);
    expect(Object.keys(move!.modifiers).sort()).toEqual(["alt", "ctrl", "meta", "shift"]);
    mouse.dispose();
    mouse.dispose();
    mouse = undefined;
    // With the hook gone another one installs.
    mouse = installMouseHook(() => false);
  });

  test("a hook may dispose itself from inside its handler, and a handler that throws does not swallow", () => {
    let calls = 0;
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      mouse = installMouseHook(() => {
        calls++;
        mouse!.dispose();
        throw new Error("thrown from a mouse hook");
      });
      sendMouseMove(1, 0);
      pumpUntil(() => calls > 0);
      sendMouseMove(-1, 0);
      pumpUntil(() => false, 100);
    } finally {
      console.error = original;
    }
    expect(calls).toBe(1);
    expect(errors[0]?.[0]).toBe("sweetview: mouse hook handler threw:");
    mouse = undefined;
  });
});

describe.if(onWindows)("installKeyboardHook (W3.2)", () => {
  test("down, repeat and up arrive with the DOM code and the raw code, and a swallowed key is swallowed per event", () => {
    const seen: KeyMessage[] = [];
    keys = installKeyboardHook((m) => {
      if (m.code === "F24") seen.push(m);
      // Swallowed: F24 never reaches any application.
      return m.code === "F24";
    });
    expect(() => installKeyboardHook(() => false)).toThrow("webview_keyboard_hook_install failed: a keyboard hook is already installed");
    sendKey(VK_F24, false);
    pumpUntil(() => seen.length >= 1);
    pumpUntil(() => false, 30);
    // Swallowed: the press never reached the system, whose key state stays up.
    const downAfterSwallowedPress = keyIsDown(VK_F24);
    sendKey(VK_F24, true);
    pumpUntil(() => seen.length >= 2);
    expect(downAfterSwallowedPress).toBe(false);
    expect(seen.map((m) => m.event)).toEqual([KeyEvent.Down, KeyEvent.Up]);
    expect(seen[0]!.code).toBe("F24");
    expect(seen[0]!.raw).toBe(VK_F24);
    expect(seen[0]!.modifiers).toEqual({ shift: false, ctrl: false, alt: false, meta: false });
    keys.dispose();
    keys.dispose();
    keys = undefined;
  });

  test("a held key that is not swallowed reaches the system and its second press is a repeat: down, repeat, up", () => {
    const seen: KeyMessage[] = [];
    keys = installKeyboardHook((m) => {
      if (m.code === "F24") seen.push(m);
      return false;
    });
    sendKey(VK_F24, false);
    pumpUntil(() => seen.length >= 1 && keyIsDown(VK_F24));
    const downAfterPress = keyIsDown(VK_F24);
    // Pressed again while held, as the keyboard's auto-repeat does.
    sendKey(VK_F24, false);
    pumpUntil(() => seen.length >= 2);
    sendKey(VK_F24, true);
    pumpUntil(() => seen.length >= 3 && !keyIsDown(VK_F24));
    expect(downAfterPress).toBe(true);
    expect(seen.map((m) => m.event)).toEqual([KeyEvent.Down, KeyEvent.Repeat, KeyEvent.Up]);
    for (const m of seen) expect({ code: m.code, raw: m.raw }).toEqual({ code: "F24", raw: VK_F24 });
    expect(keyIsDown(VK_F24)).toBe(false);
  });

  test("a handler returning true swallows per event: the swallowed press never reaches the system, so the next press is a down again, not a repeat", () => {
    const seen: KeyMessage[] = [];
    let swallow = true;
    keys = installKeyboardHook((m) => {
      if (m.code !== "F24") return false;
      seen.push(m);
      return swallow && m.event !== KeyEvent.Up;
    });
    sendKey(VK_F24, false);
    pumpUntil(() => seen.length >= 1);
    pumpUntil(() => false, 30);
    const downAfterSwallowedPress = keyIsDown(VK_F24);
    // The same press, now let through: the system sees a first press, and the hook a down.
    swallow = false;
    sendKey(VK_F24, false);
    pumpUntil(() => seen.length >= 2 && keyIsDown(VK_F24));
    const downAfterPassedPress = keyIsDown(VK_F24);
    sendKey(VK_F24, true);
    pumpUntil(() => seen.length >= 3 && !keyIsDown(VK_F24));
    expect({ downAfterSwallowedPress, downAfterPassedPress }).toEqual({ downAfterSwallowedPress: false, downAfterPassedPress: true });
    expect(seen.map((m) => m.event)).toEqual([KeyEvent.Down, KeyEvent.Down, KeyEvent.Up]);
  });
});

describe.if(onWindows)("installMouseHook swallow, read back from the OS (W3.1)", () => {
  test("a handler returning true swallows a move (the pointer stays); returning false lets the same move through (the pointer moves)", async () => {
    const original = cursorNow();
    try {
      // Other sessions move the pointer too: a reading spoilt by one is taken again, up to five times.
      type P = { x: number; y: number };
      let readings: { swallowedFrom: P; swallowedAt: P; passedFrom: P; passedAt: P; dx: number } | undefined;
      for (let attempt = 1; attempt <= 5; attempt++) {
        let swallow = true;
        const moves: MouseMessage[] = [];
        mouse = installMouseHook((m) => {
          if (m.event === MouseEvent.Move) moves.push(m);
          return swallow && m.event === MouseEvent.Move;
        });
        const swallowedFrom = cursorNow();
        // Away from the nearer screen edge, where the pointer could not move further.
        const dx = swallowedFrom.x > 100 ? -6 : 6;
        sendMouseMove(dx, 0);
        pumpUntil(() => moves.length >= 1);
        pumpUntil(() => false, 40);
        const swallowedAt = cursorNow();
        swallow = false;
        const passedFrom = cursorNow();
        sendMouseMove(dx, 0);
        pumpUntil(() => moves.length >= 2 && cursorNow().x !== passedFrom.x);
        const passedAt = cursorNow();
        mouse.dispose();
        mouse = undefined;
        readings = { swallowedFrom, swallowedAt, passedFrom, passedAt, dx };
        // Pointer speed and acceleration scale a relative move, so the move through is checked by direction.
        const clean = swallowedAt.x === swallowedFrom.x && swallowedAt.y === swallowedFrom.y && Math.sign(passedAt.x - passedFrom.x) === Math.sign(dx) && passedAt.y === passedFrom.y;
        if (clean) break;
        await Bun.sleep(200);
      }
      const { swallowedFrom, swallowedAt, passedFrom, passedAt, dx } = readings!;
      expect(swallowedAt).toEqual(swallowedFrom);
      expect(passedAt.y).toBe(passedFrom.y);
      expect(Math.sign(passedAt.x - passedFrom.x)).toBe(Math.sign(dx));
    } finally {
      user32!.SetCursorPos(original.x, original.y);
    }
  });
});

describe.if(onWindows)("permissions (W3.3)", () => {
  test("Windows needs no permission: nothing needed, status not-applicable, every feature ready", () => {
    expect(permissions.needed(Feature.MouseHook)).toEqual([]);
    expect(permissions.needed(Feature.KeyboardHook)).toEqual([]);
    expect(permissions.status(Permission.DeviceControl)).toBe("not-applicable");
    expect(permissions.status(Permission.InputMonitoring)).toBe("not-applicable");
    expect(permissions.request(Permission.DeviceControl)).toBe("not-applicable");
    expect(permissions.ready(Feature.MouseHook)).toBe(true);
    expect(permissions.ready(Feature.KeyboardHook)).toBe(true);
  });

  test("autoRequest defaults to true and can be turned off and on", () => {
    expect(permissions.autoRequest).toBe(true);
    permissions.autoRequest = false;
    expect(permissions.autoRequest).toBe(false);
    permissions.autoRequest = true;
    expect(permissions.autoRequest).toBe(true);
  });

  test("a permission number that names nothing is an error", () => {
    expect(() => permissions.status(64 as Permission)).toThrow("webview permission call failed: error -2");
  });
});

// A hook must also see what is typed while one of the application's own windows is in front.
// The fixture runs in a process of its own (it needs the foreground); when the desktop does not
// give it the foreground, the test is skipped with that reason, never passed.
type OwnForeground = { inFront?: { foregroundIsOurs: boolean; saw: string[] }; behind?: { foregroundIsOurs: boolean; saw: string[] }; limit?: boolean };
const ownForeground: Record<string, OwnForeground> = {};
if (onWindows) {
  const { runFixture } = await import("../test/run-fixture");
  for (const mode of ["window", "webview"]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await runFixture<OwnForeground>("hook-own-foreground.ts", [mode], {}, 40_000);
      ownForeground[mode] = run.r;
      if (run.r.inFront?.foregroundIsOurs) break;
    }
    if (!ownForeground[mode]?.inFront?.foregroundIsOurs) console.warn(`input-hooks.test: own-foreground (${mode}) skipped: the desktop did not give the fixture's window the foreground`);
  }
}

describe.if(onWindows)("installKeyboardHook while the application's own window is in front", () => {
  for (const mode of ["window", "webview"]) {
    test.skipIf(!ownForeground[mode]?.inFront?.foregroundIsOurs)(`a key typed while this process's own ${mode === "window" ? "Window" : "webview window"} holds the foreground reaches the hook (down, up), as it does when another window is in front`, () => {
      const r = ownForeground[mode]!;
      expect(r.limit).toBeUndefined();
      expect(r.inFront).toEqual({ foregroundIsOurs: true, saw: ["down", "up"] });
      expect(r.behind?.foregroundIsOurs).toBe(false);
      expect(r.behind?.saw).toEqual(["down", "up"]);
    });
  }
});
