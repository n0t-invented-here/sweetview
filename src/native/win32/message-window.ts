// A never-shown top-level window whose window procedure is a JSCallback.
// Shell_NotifyIcon posts tray clicks to it, SetTimer posts WM_TIMER to it, and
// TrackPopupMenu needs an owner window that can take the foreground. It is a
// real (not message-only) window so it also receives the TaskbarCreated
// broadcast when Explorer restarts.

import { FFIType, JSCallback, ptr } from "bun:ffi";
import { WM_CLOSE, hInstance, lastError, user32, wstr } from "./api";

const CLASS_NAME = "NativeShellMessageWindow";
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_OVERLAPPED = 0x00000000;
const WNDCLASSEXW_SIZE = 80;

export type MessageHandler = (message: number, wParam: bigint, lParam: bigint) => void;

export type MessageWindow = {
  readonly hwnd: bigint;
  readonly destroy: () => void;
};

const handlers = new Map<bigint, MessageHandler>();

// Retained for the process: the registered class calls it until exit.
let wndProc: JSCallback | undefined;

function ensureClass(): void {
  if (wndProc !== undefined) return;
  wndProc = new JSCallback(
    (hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint => {
      try {
        handlers.get(hwnd)?.(message, wParam, lParam);
      } catch (err) {
        // Never let an exception unwind into user32.
        console.error("sweetnative: tray handler threw:", err);
      }
      // Only destroy() tears this window down; an external WM_CLOSE is ignored.
      return message === WM_CLOSE ? 0n : user32.DefWindowProcW(hwnd, message, wParam, lParam);
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  );
  if (wndProc.ptr === null) throw new Error("sweetnative: could not allocate the window procedure");

  const wc = new Uint8Array(WNDCLASSEXW_SIZE);
  const dv = new DataView(wc.buffer);
  const className = wstr(CLASS_NAME);
  dv.setUint32(0, WNDCLASSEXW_SIZE, true); // cbSize
  dv.setBigUint64(8, BigInt(wndProc.ptr), true); // lpfnWndProc
  dv.setBigUint64(24, hInstance(), true); // hInstance
  dv.setBigUint64(64, BigInt(ptr(className)), true); // lpszClassName
  if (user32.RegisterClassExW(ptr(wc)) === 0) {
    throw new Error(`sweetnative: RegisterClassExW failed (${lastError()})`);
  }
}

export function createMessageWindow(handler: MessageHandler): MessageWindow {
  ensureClass();
  const className = wstr(CLASS_NAME);
  const hwnd = user32.CreateWindowExW(WS_EX_TOOLWINDOW, className, null, WS_OVERLAPPED, 0, 0, 0, 0, 0n, 0n, hInstance(), null);
  if (hwnd === 0n) throw new Error(`sweetnative: CreateWindowExW failed (${lastError()})`);
  handlers.set(hwnd, handler);
  let destroyed = false;
  return {
    hwnd,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      handlers.delete(hwnd);
      user32.DestroyWindow(hwnd);
    },
  };
}
