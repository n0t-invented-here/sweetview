// Dock tile and Cmd+Tab icon: NSApplication.applicationIconImage. Full colour
// (not a template) at the PNG's own size; 512px or 1024px looks right in the Dock.

import type { Icon } from "../icon";
import { applyImage, makeImage } from "./image";
import { sharedApp } from "./objc";

export function setAppIcon(icon: Icon): void {
  applyImage(sharedApp(), "setApplicationIconImage:", makeImage(icon.macos, undefined, false));
}
