// The application's menu bar. macOS: an app menu (About, Quit) and an Edit
// menu, because webview creates NSApplication without one and Cmd+Q / Cmd+C /
// Cmd+V do nothing otherwise. Windows: nothing; the tray menu is the menu.

import { backend } from "./platform";

export type AppMenuOptions = { appName: string; aboutText: string };

type Backend = { installAppMenu(options: AppMenuOptions): void };
const impl = backend<Backend>(
  () => require("./win32/app-menu"),
  () => require("./darwin/app-menu"),
);

/** Call on the UI thread before the run loop starts. */
export function installAppMenu(options: AppMenuOptions): void {
  impl().installAppMenu(options);
}
