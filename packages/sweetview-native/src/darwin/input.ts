// macOS only, until the macOS goal of the Rust rewrite replaces it: the input hooks
// and the permission model are the webview library's, through @n1h/sweetview-webview-bun,
// and `../input-hooks.ts` and `../permissions.ts` hand every call to them.

import type { KeyHandler, KeyboardHook, MouseHandler, MouseHook } from "../input-hooks";

// Loosely typed on purpose: the installed version of the library decides what exists.
const library = require("@n1h/sweetview-webview-bun") as Record<string, unknown>;

export const installMouseHook = library.installMouseHook as (handler: MouseHandler) => MouseHook;
export const installKeyboardHook = library.installKeyboardHook as (handler: KeyHandler) => KeyboardHook;
export const permissions = library.permissions as object;
