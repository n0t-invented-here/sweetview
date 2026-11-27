// Native Windows folder picker, through the native binding (rfd, which shows
// the IFileOpenDialog folder dialog). No child process.
//
// Must be called on the UI thread. The dialog runs its own message loop until
// it closes; the UI thread's timers, wakes and deferred work go on running in it.

import { binding } from "../binding";
import type { WindowHandle } from "../types";

/** Opens the native folder dialog owned by `owner`. Returns the path, or null if cancelled. */
export function pickFolder(owner: WindowHandle, title: string): string | null {
  const hwnd = owner === null || owner === 0 || owner === 0n ? null : BigInt(owner);
  return binding().pickFolder(hwnd, title);
}
