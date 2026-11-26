// Tray icon (Windows notification area) / menu bar status item (macOS).
//
// Runs on the UI thread. Callbacks fire on that thread from inside the OS
// loop: return quickly, and do not await anything that needs Bun's event loop
// (it is blocked while webview.run() is on the stack).

import type { Icon } from "./icon";
import type { MenuSource } from "./menu";
import { backend } from "./platform";

/**
 * The tray's icon: an `Icon`.
 * - Windows: the notification-area icon (and the icon of legacy tray balloon
 *   tips) is taken from the `.ico`, which should carry a 16px image (plus
 *   20/24/32px for higher DPI). WinRT toast notifications are separate: their
 *   images come from the toast XML (`Notifier`), not from this icon.
 * - macOS: the menu bar status item shows the PNG at 18x18 points (36px for Retina).
 */
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

export interface TrayBackend {
  setTooltip(text: string): void;
  setIcon(icon: TrayIcon): void;
  setMenu(menu: MenuSource | undefined): void;
  dispose(): void;
}

type Backend = { createTray(options: TrayOptions): TrayBackend };
const impl = backend<Backend>(
  () => require("./win32/tray"),
  () => require("./darwin/tray"),
);

export class Tray {
  readonly #inner: TrayBackend;

  constructor(options: TrayOptions) {
    this.#inner = impl().createTray(options);
  }

  setTooltip(text: string): void {
    this.#inner.setTooltip(text);
  }

  setIcon(icon: TrayIcon): void {
    this.#inner.setIcon(icon);
  }

  setMenu(menu: MenuSource | undefined): void {
    this.#inner.setMenu(menu);
  }

  /** Safe to call twice. */
  dispose(): void {
    this.#inner.dispose();
  }
}

export function createTray(options: TrayOptions): Tray {
  return new Tray(options);
}
