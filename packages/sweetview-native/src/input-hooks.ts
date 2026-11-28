// System-wide mouse and keyboard hooks: every mouse and key event of the
// desktop, whichever application has focus, with the choice to swallow each.
// These are the hooks the package `@n1h/sweetview-webview-bun` exported.
//
// Windows: the Rust binding (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`). macOS: the
// webview library of `@n1h/sweetview-webview-bun`, until the macOS goal of the
// rewrite replaces it; `./darwin/input` is that seam.
//
// A hook is delivered by the UI thread's loop: events arrive while the app is
// inside `run()` or while `runEventLoop()` is pumping. Keep handlers quick: the
// OS drops a low-level hook's event past its timeout and delivers it unseen.

import { binding } from "./binding";
import { reportCallbackError } from "./callback-errors";
import { releaseAtEnd } from "./lifetime";

/** The modifier keys held when an event happened. */
export type Modifiers = {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
};

/** The bits of the modifier mask the native layer reports. */
export enum Modifier {
  Shift = 1 << 0,
  Control = 1 << 1,
  Alt = 1 << 2,
  Meta = 1 << 3,
}

/** Splits a modifier mask into its keys. */
export function modifiersFrom(bits: number): Modifiers {
  return {
    shift: (bits & Modifier.Shift) !== 0,
    ctrl: (bits & Modifier.Control) !== 0,
    alt: (bits & Modifier.Alt) !== 0,
    meta: (bits & Modifier.Meta) !== 0,
  };
}

const WEBVIEW_ERROR_MISSING_DEPENDENCY = -5;
const WEBVIEW_ERROR_UNSPECIFIED = -1;
const WEBVIEW_ERROR_DUPLICATE = 1;
const WEBVIEW_ERROR_NOT_FOUND = 2;

function hookInstallError(kind: "mouse" | "keyboard", code: number): Error {
  const why =
    code === WEBVIEW_ERROR_DUPLICATE
      ? `a ${kind} hook is already installed`
      : code === WEBVIEW_ERROR_MISSING_DEPENDENCY
        ? "the process needs the Device Control and Data Access permission (System Settings > Privacy & Security)"
        : code === WEBVIEW_ERROR_UNSPECIFIED
          ? "the hook could not be installed (on Linux there is none)"
          : `error ${code}`;
  return new Error(`webview_${kind}_hook_install failed: ${why}`);
}

/** What happened to the mouse. */
export enum MouseEvent {
  Move = 0,
  LeftDown = 1,
  LeftUp = 2,
  RightDown = 3,
  RightUp = 4,
  MiddleDown = 5,
  MiddleUp = 6,
  Wheel = 7,
}

/** One mouse event. `x` and `y` are screen coordinates; `wheel` is in notches, positive away from the user. */
export type MouseMessage = {
  event: MouseEvent;
  x: number;
  y: number;
  wheel: number;
  modifiers: Modifiers;
};

/** Return true to swallow the event: no application sees it. */
export type MouseHandler = (m: MouseMessage) => boolean;

/** An installed mouse hook. `dispose()` removes it; calling it twice does nothing more. */
export type MouseHook = { dispose(): void };

// The macOS seam.
type DarwinInput = typeof import("./darwin/input");
const onDarwin = process.platform === "darwin";
const darwinModule: DarwinInput | undefined = onDarwin ? await import("./darwin/input") : undefined;
const darwin = (): DarwinInput => darwinModule!;

/**
 * Installs the process's mouse hook. One per process: a second install
 * throws. The handler runs on the UI thread for every mouse event of the
 * desktop and may dispose its own hook from inside its call. A handler that
 * throws does not swallow the event.
 *
 * @throws {Error} `webview_mouse_hook_install failed: ...` when a mouse hook is
 * already installed, a permission is missing (macOS), or the platform has none.
 */
export function installMouseHook(handler: MouseHandler): MouseHook {
  return removedAtEnd(installMouseHookNow(handler));
}

/**
 * A hook removed when the application ends (see `run()`), before anything else: a
 * system-wide hook that no loop answers holds up the desktop's input.
 */
function removedAtEnd(hook: { dispose(): void }): { dispose(): void } {
  const unregister = releaseAtEnd("hook", () => hook.dispose());
  return {
    dispose() {
      hook.dispose();
      unregister();
    },
  };
}

function installMouseHookNow(handler: MouseHandler): MouseHook {
  if (onDarwin) return darwin().installMouseHook(handler);
  const native = binding();
  const code = native.installMouseHook((event, x, y, wheel, modifiers) => {
    try {
      return handler({ event, x, y, wheel, modifiers: modifiersFrom(modifiers) }) === true;
    } catch (err) {
      reportCallbackError("mouseHook", err, "sweetview: mouse hook handler threw:");
      return false;
    }
  });
  if (code !== 0) throw hookInstallError("mouse", code);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      const removed = native.removeMouseHook();
      if (removed !== 0 && removed !== WEBVIEW_ERROR_NOT_FOUND) {
        throw new Error(`webview_mouse_hook_remove failed: error ${removed}`);
      }
      disposed = true;
    },
  };
}

/** What happened to a key. */
export enum KeyEvent {
  Down = 0,
  Up = 1,
  Repeat = 2,
}

/**
 * One key event. `code` is the DOM `KeyboardEvent.code` of the physical key
 * (`"KeyA"`, `"ShiftLeft"`, `"F5"`), or `"Unidentified"`; `raw` is the
 * platform's own key code; `modifiers` is the state after the event.
 */
export type KeyMessage = {
  event: KeyEvent;
  code: string;
  raw: number;
  modifiers: Modifiers;
};

/** Return true to swallow the event: no application sees it. */
export type KeyHandler = (m: KeyMessage) => boolean;

/** An installed keyboard hook. `dispose()` removes it; calling it twice does nothing more. */
export type KeyboardHook = { dispose(): void };

/**
 * Installs the process's keyboard hook. One per process: a second install
 * throws. The handler runs on the UI thread for every key event of the
 * desktop and may dispose its own hook from inside its call. A handler that
 * throws does not swallow the event.
 *
 * @throws {Error} `webview_keyboard_hook_install failed: ...` when a keyboard
 * hook is already installed, a permission is missing (macOS), or the platform has none.
 */
export function installKeyboardHook(handler: KeyHandler): KeyboardHook {
  return removedAtEnd(installKeyboardHookNow(handler));
}

function installKeyboardHookNow(handler: KeyHandler): KeyboardHook {
  if (onDarwin) return darwin().installKeyboardHook(handler);
  const native = binding();
  const code = native.installKeyboardHook((event, key, raw, modifiers) => {
    try {
      return handler({ event, code: key, raw, modifiers: modifiersFrom(modifiers) }) === true;
    } catch (err) {
      reportCallbackError("keyboardHook", err, "sweetview: keyboard hook handler threw:");
      return false;
    }
  });
  if (code !== 0) throw hookInstallError("keyboard", code);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      const removed = native.removeKeyboardHook();
      if (removed !== 0 && removed !== WEBVIEW_ERROR_NOT_FOUND) {
        throw new Error(`webview_keyboard_hook_remove failed: error ${removed}`);
      }
      disposed = true;
    },
  };
}
