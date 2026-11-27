// Icon bytes to HICONs, for the notifier's balloon icons and window captions.
// The tray and menu items take their icons through the native binding, which
// decodes the .ico itself.

import { parseIco, pickIcoEntry } from "../icon";
import { ICON_BIG, ICON_SMALL, SM_CXICON, SM_CXSMICON, WM_SETICON, lastError, user32 } from "./api";

const IDI_APPLICATION = 32512n;
const LR_DEFAULTCOLOR = 0;

export type LoadedIcon = { handle: bigint; owned: boolean };

/** HICON from .ico bytes at the small-icon size (or `metric`); the stock application icon when there are none. */
export function loadIcon(ico: Uint8Array | undefined, metric: number = SM_CXSMICON): LoadedIcon {
  if (ico) {
    const want = user32.GetSystemMetrics(metric) || (metric === SM_CXICON ? 32 : 16);
    const entry = pickIcoEntry(parseIco(ico), want);
    const bits = ico.subarray(entry.offset, entry.offset + entry.size);
    const handle = user32.CreateIconFromResourceEx(bits, bits.length, 1, 0x00030000, want, want, LR_DEFAULTCOLOR);
    if (handle !== 0n) return { handle, owned: true };
    console.error(`sweetview: CreateIconFromResourceEx failed (${lastError()}); using the default icon`);
  }
  return { handle: user32.LoadIconW(0n, IDI_APPLICATION), owned: false };
}

export const releaseIcon = (icon: LoadedIcon) => {
  if (icon.owned) user32.DestroyIcon(icon.handle);
};

const windowIcons = new Map<bigint, LoadedIcon[]>();

/**
 * Sets a window's caption and taskbar icons (WM_SETICON small + big) from .ico
 * bytes, or back to the stock icon when undefined. The HICONs live until the
 * next call for the same window; Windows draws from them, so they cannot be
 * destroyed right away.
 */
export function setWindowIcon(hwnd: bigint, ico: Uint8Array | undefined): void {
  const small = loadIcon(ico, SM_CXSMICON);
  const big = loadIcon(ico, SM_CXICON);
  user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, BigInt.asIntN(64, small.handle));
  user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, BigInt.asIntN(64, big.handle));
  windowIcons.get(hwnd)?.forEach(releaseIcon);
  windowIcons.set(hwnd, [small, big]);
}

/** Releases any HICONs associated with `hwnd` when the window is disposed. */
export function clearWindowIcon(hwnd: bigint): void {
  const icons = windowIcons.get(hwnd);
  if (!icons) return;
  windowIcons.delete(hwnd);
  icons.forEach(releaseIcon);
}
