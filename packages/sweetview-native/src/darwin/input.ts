// macOS only, until the macOS goal of the Rust rewrite replaces it: the input hooks
// and the permission model are the webview library's, through @n1h/sweetview-webview-bun,
// and `../input-hooks.ts` and `../permissions.ts` hand every call to them.
//
// The library's hooks do not catch an exception the handler throws (their wrapper is a
// `try`/`finally`), so Bun would throw it at whatever JavaScript is running the loop. The
// handler is wrapped here, as on Windows: an exception goes to `reportCallbackError`, printed
// with the Windows message when the application has no `onCallbackError` listener, and the
// event is not swallowed.

import { reportCallbackError } from "../callback-errors";
import type { KeyHandler, KeyboardHook, MouseHandler, MouseHook } from "../input-hooks";

import { library } from "./library";

const libraryMouseHook = library.installMouseHook as (handler: MouseHandler) => MouseHook;
const libraryKeyboardHook = library.installKeyboardHook as (handler: KeyHandler) => KeyboardHook;

export function installMouseHook(handler: MouseHandler): MouseHook {
  return libraryMouseHook((message) => {
    try {
      return handler(message);
    } catch (err) {
      reportCallbackError("mouseHook", err, "sweetview: mouse hook handler threw:");
      return false;
    }
  });
}

export function installKeyboardHook(handler: KeyHandler): KeyboardHook {
  return libraryKeyboardHook((message) => {
    try {
      return handler(message);
    } catch (err) {
      reportCallbackError("keyboardHook", err, "sweetview: keyboard hook handler threw:");
      return false;
    }
  });
}

export const permissions = library.permissions as object;
