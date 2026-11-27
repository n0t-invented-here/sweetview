// The OS loop on Windows, over the Rust binding. `pumpEvents` runs `tao`'s
// loop until what is waiting has been dispatched, then returns, so Bun's own
// loop keeps the thread: timers, promises and I/O work between pumps. Native
// timeouts ride on the runtime's signal window, so they fire inside any loop
// the thread is in, a modal dialog's included.

import { binding } from "../binding";

/** Dispatches what is waiting. False when a `WM_QUIT` (`PostQuitMessage`) ended the pump. */
export function pumpEvents(): boolean {
  return binding().pumpEvents();
}

/**
 * Takes back a `PostQuitMessage`: dispatches what is waiting until the quit
 * request comes out, and drops it. Returns at once when none was made and
 * nothing waits. The C++ webview library posts one when a webview is
 * destroyed; with the webview on the binding, nothing posts one.
 */
export function discardQuit(): void {
  binding().discardQuit();
}

// Windows has no Dock: a process with no visible window has no taskbar presence already.
export function setActivationPolicy(): void {}

export function scheduleNativeTimeout(ms: number, fn: () => void): () => void {
  let active = true;
  const native = binding();
  const id = native.scheduleTimeout(Math.ceil(ms), () => {
    if (!active) return;
    active = false;
    try {
      fn();
    } catch (err) {
      console.error("sweetview: message window handler threw:", err);
    }
  });
  return () => {
    if (!active) return;
    active = false;
    native.cancelTimeout(id);
  };
}
