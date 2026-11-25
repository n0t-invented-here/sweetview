// Shared one-time Win32 UI-thread initialization:
// 1. COM STA initialization (required by WebView2 and IFileOpenDialog)
// 2. Per-monitor DPI awareness v2 (must run before ANY top-level HWND exists,
//    including hidden message windows for trays/notifiers)
// 3. Windows 11 25H2 topmost anchor workaround: the first top-level window a
//    process creates can never become HWND_TOPMOST, so create a hidden message
//    window first and keep it for the process.

import { COINIT_APARTMENTTHREADED, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, RPC_E_CHANGED_MODE, ole32, user32 } from "./api";
import { createMessageWindowRaw, type MessageWindow } from "./message-window";

let dpiDone = false;
let anchor: MessageWindow | undefined;

/** Sets COM STA and per-monitor DPI awareness v2. Safe to call repeatedly. */
export function ensureDpiAware(): void {
  if (dpiDone) return;
  dpiDone = true;
  const hr = ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (hr === RPC_E_CHANGED_MODE) {
    throw new Error("sweetview: this thread already initialised COM as multi-threaded; WebView2 needs an STA");
  }
  user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

/**
 * Full Win32 startup initializer: COM STA, per-monitor DPI v2, and the hidden
 * first-window anchor so any subsequent window can become HWND_TOPMOST.
 */
export function ensureWin32Init(): void {
  ensureDpiAware();
  if (anchor === undefined) {
    anchor = createMessageWindowRaw(() => {});
  }
}
