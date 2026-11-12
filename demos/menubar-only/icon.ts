// The demo's icons: a timer in the macOS menu bar (SF Symbol, recoloured by
// the system) and a teal dot everywhere else. One module so the app and the
// build script agree.

import { dotIcns, dotIcon, type Icon } from "@n1h/sweetview/native";

const COLOR = "#0d9488";

/** Tray / menu bar. Windows: the dot at the tray sizes. macOS: the timer as a template image. */
export const TRAY_ICON: Icon = { windows: { ico: dotIcon({ color: COLOR }) }, macos: { symbol: "timer" } };

/** The executable's icon (`bun build --compile --windows-icon`), up to Explorer's 256px tile. */
export const appIco = (): Uint8Array => dotIcon({ color: COLOR, sizes: [16, 24, 32, 48, 64, 128, 256] });

/** The .app bundle's CFBundleIconFile, for Finder. */
export const appIcns = (): Uint8Array => dotIcns({ color: COLOR });
