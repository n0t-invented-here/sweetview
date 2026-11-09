// Show/hide and close interception for a window someone else created (the
// webview's). The close hook subclasses the window procedure with comctl32's
// SetWindowSubclass, so the webview's own procedure stays in the chain for
// everything but WM_CLOSE.

import { FFIType, JSCallback } from "bun:ffi";
import type { NativeWindow, WindowHandle } from "../window";
import { SW_HIDE, SW_RESTORE, SW_SHOW, WM_CLOSE, WM_NCDESTROY, comctl32, user32 } from "./api";
import { setWindowIcon } from "./icon";

export const asHwnd = (handle: WindowHandle): bigint => {
  if (handle === null || handle === 0 || handle === 0n) throw new Error("sweetnative: window handle is NULL");
  return BigInt(handle);
};

const SUBCLASS_ID = 0x4e53n; // "NS"
const closeHandlers = new Map<bigint, () => void>();

// One SUBCLASSPROC for every window we hook, retained for the process.
let subclassProc: JSCallback | undefined;
const proc = () =>
  (subclassProc ??= new JSCallback(
    (hwnd: bigint, message: number, wParam: bigint, lParam: bigint, _id: bigint, _ref: bigint): bigint => {
      const handler = closeHandlers.get(hwnd);
      if (message === WM_CLOSE && handler !== undefined) {
        try {
          handler();
        } catch (err) {
          console.error("sweetnative: close handler threw:", err);
        }
        return 0n; // handled: the window stays
      }
      if (message === WM_NCDESTROY) {
        // The window is going away for real (quit); leave the chain cleanly.
        closeHandlers.delete(hwnd);
        comctl32.RemoveWindowSubclass(hwnd, proc().ptr, SUBCLASS_ID);
      }
      return comctl32.DefSubclassProc(hwnd, message, wParam, lParam);
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  ));

export function nativeWindow(handle: WindowHandle): NativeWindow {
  const hwnd = asHwnd(handle);
  const self: NativeWindow = {
    isVisible: () => user32.IsWindowVisible(hwnd) !== 0,
    show() {
      user32.ShowWindow(hwnd, user32.IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
      user32.SetForegroundWindow(hwnd);
    },
    hide() {
      user32.ShowWindow(hwnd, SW_HIDE);
    },
    toggle() {
      if (self.isVisible()) self.hide();
      else self.show();
    },
    setIcon(icon) {
      setWindowIcon(hwnd, icon?.windows?.ico);
    },
    onCloseRequest(handler) {
      if (!closeHandlers.has(hwnd)) {
        // SetWindowSubclass on an already-subclassed (hwnd, proc, id) just updates refData.
        if (!comctl32.SetWindowSubclass(hwnd, proc().ptr, SUBCLASS_ID, 0n)) {
          throw new Error("sweetnative: SetWindowSubclass failed");
        }
      }
      closeHandlers.set(hwnd, handler);
      return () => {
        if (closeHandlers.get(hwnd) !== handler) return;
        closeHandlers.delete(hwnd);
        comctl32.RemoveWindowSubclass(hwnd, proc().ptr, SUBCLASS_ID);
      };
    },
  };
  return self;
}
