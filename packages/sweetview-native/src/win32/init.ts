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
// Set once CoInitializeEx has settled this thread's COM state: it succeeded (S_OK/S_FALSE, one
// reference this process keeps for its lifetime), or COM is already initialised in the other
// model (RPC_E_CHANGED_MODE, which adds no reference). Any other failure leaves it unset so a
// later call retries instead of carrying on with COM uninitialised.
let comDone = false;
let comError: Error | undefined;
let anchor: MessageWindow | undefined;

/** Sets COM STA and per-monitor DPI awareness v2. Safe to call repeatedly. */
export function ensureDpiAware(): void {
  if (!comDone) {
    const hr = ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    if (hr === RPC_E_CHANGED_MODE) {
      comDone = true;
      comError = new Error("sweetview: this thread already initialised COM as multi-threaded; WebView2 needs an STA");
    } else if (hr < 0) {
      throw new Error(`sweetview: CoInitializeEx failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
    } else {
      comDone = true;
    }
  }
  if (comError) throw comError;
  if (dpiDone) return;
  dpiDone = true;
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
