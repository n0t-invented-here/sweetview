// Tray icon (Windows notification area) / menu bar status item (macOS).
//
// Runs on the UI thread. Callbacks fire on that thread from inside the OS
// loop: return quickly, and do not await anything that needs Bun's event loop
// (it is blocked while webview.run() is on the stack).

import type { Icon } from "./icon";
import type { MenuSource } from "./menu";
import { backend } from "./platform";

/** The tray's icon: an `Icon`. Windows picks the 16px image for the tray and 32px for toasts; macOS shows the PNG at 18x18 points (36px for Retina). */
export type TrayIcon = Icon;

export type TrayOptions = {
  tooltip?: string;
  icon?: TrayIcon;
  /** Windows: opened by right click. macOS: by any click, as menu bar items do. */
  menu?: MenuSource;
  /** Left single click. Fires only when the click did not turn into a double click. macOS: only when no menu is set. */
  onClick?: () => void;
  /** Left double click. macOS: only when no menu is set. */
  onDoubleClick?: () => void;
};

export interface Tray {
  setTooltip(text: string): void;
  setIcon(icon: TrayIcon): void;
  setMenu(menu: MenuSource | undefined): void;
  /** Removes the icon. Safe to call twice. */
  dispose(): void;
}

type Backend = { createTray(options: TrayOptions): Tray };
const impl = backend<Backend>(
  () => require("./win32/tray"),
  () => require("./darwin/tray"),
);

export function createTray(options: TrayOptions): Tray {
  return impl().createTray(options);
}
