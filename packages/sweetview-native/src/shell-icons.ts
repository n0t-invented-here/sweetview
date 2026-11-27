// Telling the desktop shell that program icons changed, through the native
// binding. Its own subpath (`@n1h/sweetview-native/shell-icons`) so a build
// script reaches it without loading the rest of the native module.

import { binding } from "./binding";

/**
 * Windows: tells the shell that program icons changed (`SHChangeNotify` with
 * `SHCNE_ASSOCCHANGED` and `SHCNF_FLUSH`), so Explorer, the taskbar and the
 * Start menu draw a rebuilt program's icon. Changes nothing on the computer.
 * Elsewhere it does nothing. Callable from any thread.
 */
export function refreshShellIcons(): void {
  if (process.platform !== "win32") return;
  binding().refreshShellIcons();
}
