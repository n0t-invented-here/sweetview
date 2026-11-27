// The icon a notifier's balloon fallback shows: the active tray's, as today.
//
// The tray reports its icon here; every live notifier hands it to the binding.
// This file imports nothing native, so the tray and the notifier depend on it
// and not on each other.

type Listener = (ico: Uint8Array | undefined) => void;

let current: Uint8Array | undefined;
const listeners = new Set<Listener>();

/**
 * Called by the Windows tray: with its `.ico` bytes when it is created and
 * whenever `setIcon` changes them, and with `undefined` when the active tray is
 * disposed. Balloons shown after the call carry this icon; `undefined` shows
 * the stock application icon.
 */
export function setNotifierTrayIcon(ico: Uint8Array | undefined): void {
  current = ico;
  for (const listener of [...listeners]) listener(ico);
}

/** The icon last reported by the tray, if a tray is active. */
export function notifierTrayIcon(): Uint8Array | undefined {
  return current;
}

/** Calls `listener` on every later report. Returns the function that stops it. */
export function onNotifierTrayIcon(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
