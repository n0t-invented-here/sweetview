// The demo's icons: a bell in the macOS menu bar (SF Symbol, recoloured by the
// system) and an amber dot everywhere else. One module so the app and the
// build script agree.

import { dotIcns, dotIcon, type Icon } from "@n1h/sweetview/native";

const COLOR = "#f59e0b";

/** Tray / menu bar. Windows: the dot at the tray sizes, also used for the toast. macOS: the bell as a template image. */
export const TRAY_ICON: Icon = { windows: { ico: dotIcon({ color: COLOR }) }, macos: { symbol: "bell.fill" } };

/** The executable's icon (`bun build --compile --windows-icon`), up to Explorer's 256px tile. */
export const appIco = (): Uint8Array => dotIcon({ color: COLOR, sizes: [16, 24, 32, 48, 64, 128, 256] });

/** The .app bundle's CFBundleIconFile, for Finder. */
export const appIcns = (): Uint8Array => dotIcns({ color: COLOR });
