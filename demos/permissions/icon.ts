// The demo's icon: a green dot, for the Windows title bar, the Dock and the
// .app bundle. One module so the app and the build script agree.

import { dotIcns, dotIcon, dotPng, type Icon } from "@n1h/sweetview/native";

const COLOR = "#16a34a";

/** Windows: the title bar and taskbar. macOS: the Dock tile of the bare binary; the .app has its .icns. */
export const APP_ICON: Icon = { windows: { ico: dotIcon({ color: COLOR, sizes: [16, 24, 32, 48, 64] }) }, macos: { png: dotPng(512, { color: COLOR }), template: false } };

/** The executable's icon (`bun build --compile --windows-icon`), up to Explorer's 256px tile. */
export const appIco = (): Uint8Array => dotIcon({ color: COLOR, sizes: [16, 24, 32, 48, 64, 128, 256] });

/** The .app bundle's CFBundleIconFile, for Finder. */
export const appIcns = (): Uint8Array => dotIcns({ color: COLOR });
