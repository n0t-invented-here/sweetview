// Icon bytes to GDI objects: an HICON for the tray, toasts and window
// captions; an HBITMAP for menu items (menus take bitmaps, not icons, and
// want 32bpp premultiplied alpha). The .ico is decoded in JS so both paths
// scale to the DPI's size instead of letting the menu stretch a 16px image.

import { ptr, toArrayBuffer } from "bun:ffi";
import { icoRgba, parseIco, pickIcoEntry } from "../icon";
import { ICON_BIG, ICON_SMALL, SM_CXICON, SM_CXSMICON, WM_SETICON, gdi32, lastError, user32 } from "./api";

const IDI_APPLICATION = 32512n;
const LR_DEFAULTCOLOR = 0;
const DIB_RGB_COLORS = 0;

export type LoadedIcon = { handle: bigint; owned: boolean };

/** HICON from .ico bytes at the small-icon size (or `metric`); the stock application icon when there are none. */
export function loadIcon(ico: Uint8Array | undefined, metric: number = SM_CXSMICON): LoadedIcon {
  if (ico) {
    const want = user32.GetSystemMetrics(metric) || (metric === SM_CXICON ? 32 : 16);
    const entry = pickIcoEntry(parseIco(ico), want);
    const bits = ico.subarray(entry.offset, entry.offset + entry.size);
    const handle = user32.CreateIconFromResourceEx(bits, bits.length, 1, 0x00030000, want, want, LR_DEFAULTCOLOR);
    if (handle !== 0n) return { handle, owned: true };
    console.error(`sweetnative: CreateIconFromResourceEx failed (${lastError()}); using the default icon`);
  }
  return { handle: user32.LoadIconW(0n, IDI_APPLICATION), owned: false };
}

export const releaseIcon = (icon: LoadedIcon) => {
  if (icon.owned) user32.DestroyIcon(icon.handle);
};

/**
 * A 32bpp premultiplied-alpha HBITMAP of the .ico at `size` px (default the
 * small-icon metric), for MENUITEMINFO.hbmpItem. 0n, with the reason logged,
 * when the .ico cannot be decoded. The caller owns it: DeleteObject when done.
 */
export function iconBitmap(ico: Uint8Array, size: number = user32.GetSystemMetrics(SM_CXSMICON) || 16): bigint {
  let rgba: Uint8Array;
  try {
    rgba = icoRgba(ico, size);
  } catch (err) {
    console.error(`sweetnative: menu icon skipped: ${err instanceof Error ? err.message : err}`);
    return 0n;
  }
  const info = new Uint8Array(40); // BITMAPINFOHEADER; no colour table for BI_RGB 32bpp
  const dv = new DataView(info.buffer);
  dv.setUint32(0, 40, true);
  dv.setInt32(4, size, true);
  dv.setInt32(8, -size, true); // negative: top-down, so the RGBA rows copy straight in
  dv.setUint16(12, 1, true);
  dv.setUint16(14, 32, true);
  const bitsOut = new BigUint64Array(1);
  const hbm = gdi32.CreateDIBSection(0n, info, DIB_RGB_COLORS, ptr(bitsOut), 0n, 0);
  if (hbm === 0n || bitsOut[0] === 0n) {
    console.error(`sweetnative: CreateDIBSection failed (${lastError()})`);
    return 0n;
  }
  const bits = new Uint8Array(toArrayBuffer(Number(bitsOut[0]) as never, 0, size * size * 4));
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    bits[i] = Math.round((rgba[i + 2]! * a) / 255); // B
    bits[i + 1] = Math.round((rgba[i + 1]! * a) / 255); // G
    bits[i + 2] = Math.round((rgba[i]! * a) / 255); // R
    bits[i + 3] = a;
  }
  return hbm;
}

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
