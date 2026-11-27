// Application-wide settings that macOS has and Windows does not. The binding
// does nothing for each on Windows: the tray menu is the app's menu, and
// taskbar and Alt+Tab presence is per window (`WindowOptions.hideFromTaskbar`).

import type { AppMenuOptions } from "../app-menu";
import { binding } from "../binding";
import type { ActivationPolicy } from "../event-loop";

/** Windows has no application menu bar here; the tray menu is the app's menu. */
export function setAppMenu(options: AppMenuOptions): void {
  binding().installAppMenu(options.appName, options.aboutText);
}

/** Windows has no process-wide activation policy. */
export function setActivationPolicy(policy: ActivationPolicy): void {
  binding().setActivationPolicy(policy);
}
