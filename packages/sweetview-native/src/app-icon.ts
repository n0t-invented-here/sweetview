// The application's own icon, as the OS shows the running app.
//
// macOS: the Dock tile and the Cmd+Tab switcher (NSApplication's
// applicationIconImage). Replaces what the bundle's CFBundleIconFile set, or
// the generic icon for a bare executable.
//
// Windows: nothing to set at run time. Explorer, the taskbar and Alt+Tab take
// the icon from the executable's resources (`bun build --compile
// --windows-icon=app.ico`) and from each window (`Window.setIcon`,
// `WindowOptions.icon`).

import type { Icon } from "./icon";
import { backend } from "./platform";

type Backend = { setAppIcon(icon: Icon): void };
const impl = backend<Backend>(
  () => require("./win32/app-icon"),
  () => require("./darwin/app-icon"),
);

/**
 * Sets the running application's icon.
 * - macOS: replaces `NSApplication.applicationIconImage`, the Dock tile and
 *   Cmd+Tab icon of the running process.
 * - Windows: no-op. Windows has no process-wide runtime icon; embed the
 *   executable icon at build time (`bun build --compile --windows-icon=app.ico`)
 *   and set per-window title bar / taskbar / Alt+Tab icons with
 *   `Window.setIcon` or `WindowOptions.icon`.
 */
export function setAppIcon(icon: Icon): void {
  impl().setAppIcon(icon);
}
