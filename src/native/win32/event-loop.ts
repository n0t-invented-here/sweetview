// The OS loop without a webview: dispatch every message waiting in this
// thread's queue, then return. A blocking GetMessage loop would stall Bun's
// event loop; PeekMessage leaves it in charge, so timers, promises and I/O
// keep working on the UI thread. The tray's hidden message window, SetTimer
// and TrackPopupMenu all run from here.

import { PM_REMOVE, WM_QUIT, user32 } from "./api";

// MSG, x64: hwnd 8, message 4 (+4 padding), wParam 8, lParam 8, time 4, pt 8 (+4 padding)
const MSG_SIZE = 48;
const MSG_MESSAGE_OFFSET = 8;
const msg = new Uint8Array(MSG_SIZE);
const msgView = new DataView(msg.buffer);

export function pumpEvents(): boolean {
  while (user32.PeekMessageW(msg, 0n, 0, 0, PM_REMOVE) !== 0) {
    if (msgView.getUint32(MSG_MESSAGE_OFFSET, true) === WM_QUIT) return false; // PostQuitMessage: the loop is over
    user32.TranslateMessage(msg);
    user32.DispatchMessageW(msg);
  }
  return true;
}

// Windows has no Dock: a process with no visible window has no taskbar presence already.
export function setActivationPolicy(): void {}
