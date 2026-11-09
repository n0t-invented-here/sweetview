// Control of a window someone else created (the webview's): show, hide, and
// what the close button does.

import type { Pointer } from "bun:ffi";
import type { Icon } from "./icon";
import { backend } from "./platform";

/** A native window handle as the webview hands it out (HWND on Windows, NSWindow* on macOS). */
export type WindowHandle = Pointer | bigint | number | null;

export interface NativeWindow {
  isVisible(): boolean;
  /** Shows, un-minimises and brings to the front. */
  show(): void;
  hide(): void;
  toggle(): void;
  /**
   * Windows: the title bar, taskbar and Alt+Tab icon for this window, from
   * `icon.windows.ico`; undefined restores the stock one. macOS: no-op, a
   * window has no icon of its own there; `setAppIcon` sets the Dock's.
   */
  setIcon(icon: Icon | undefined): void;
  /**
   * Replaces what the window's close button does (destroy the window, which
   * ends the app) with `handler`, typically `hide`. Returns a function that
   * restores the default. Only the close button is intercepted; quitting
   * through a menu still works.
   */
  onCloseRequest(handler: () => void): () => void;
}

type Backend = { nativeWindow(handle: WindowHandle): NativeWindow };
const impl = backend<Backend>(
  () => require("./win32/window"),
  () => require("./darwin/window"),
);

export function nativeWindow(handle: WindowHandle): NativeWindow {
  return impl().nativeWindow(handle);
}
