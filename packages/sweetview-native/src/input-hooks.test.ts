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
  ? dlopen("user32.dll", { SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 } }).symbols
  : undefined;

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
    sendKey(VK_F24, true);
    pumpUntil(() => seen.length >= 2);
    expect(seen.map((m) => m.event)).toEqual([KeyEvent.Down, KeyEvent.Up]);
    expect(seen[0]!.code).toBe("F24");
    expect(seen[0]!.raw).toBe(VK_F24);
    expect(seen[0]!.modifiers).toEqual({ shift: false, ctrl: false, alt: false, meta: false });
    keys.dispose();
    keys.dispose();
    keys = undefined;
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
