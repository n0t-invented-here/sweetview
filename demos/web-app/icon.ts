// The demo's icons: the sparkle tile (icon-art.ts) on Windows and for the
// Dock and bundle; the "sparkles" SF Symbol in the macOS menu bar and menus.
// One module so the app and the build scripts agree.

import { encodeIcns, encodeIco, encodePng, type Icon } from "@n1h/sweetview/native";
import { renderSparkleTile } from "./icon-art";

const ico = (sizes: number[]) => encodeIco(new Map(sizes.map((s) => [s, renderSparkleTile(s)])));
const png = (size: number) => encodePng(size, renderSparkleTile(size));

/** Tray / menu bar: the tile at the small sizes; in the menu bar at 18pt from a 36px render (Retina), in colour. */
export const TRAY_ICON: Icon = { windows: { ico: ico([16, 24, 32, 48]) }, macos: { png: png(36), template: false } };

/** Windows: the main window's title bar, taskbar and Alt+Tab. macOS: the Dock tile. */
export const APP_ICON: Icon = { windows: { ico: ico([16, 24, 32, 48, 64]) }, macos: { png: png(512), template: false } };

/** Menu items: SF Symbols on macOS; nothing on Windows, where there is no matching art. */
export const menuIcon = (symbol: string): Icon => ({ macos: { symbol } });

/** The executable's icon (`bun build --compile --windows-icon`), up to Explorer's 256px tile. */
export const appIco = (): Uint8Array => ico([16, 24, 32, 48, 64, 128, 256]);

/** The .app bundle's CFBundleIconFile. */
export const appIcns = (): Uint8Array => encodeIcns(new Map([16, 32, 64, 128, 256, 512].map((s) => [s, png(s)])));
