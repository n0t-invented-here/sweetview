// Popup menus: a MenuTemplate becomes an HMENU tree, shown modally with
// TrackPopupMenu, then destroyed. Built fresh for every showing, so dynamic
// labels and check marks cost nothing. Item icons are 32bpp bitmaps
// (MENUITEMINFO.hbmpItem), which DestroyMenu does not free, so the build
// keeps a list to delete afterwards.

import { isSeparator, isSubmenu, type MenuTemplate } from "../menu";
import { WM_NULL, gdi32, lastError, user32, wstr } from "./api";
import { iconBitmap } from "./icon";

const MF_STRING = 0x0;
const MF_GRAYED = 0x1;
const MF_CHECKED = 0x8;
const MF_POPUP = 0x10;
const MF_SEPARATOR = 0x800;

const TPM_RIGHTBUTTON = 0x0002;
const TPM_BOTTOMALIGN = 0x0020;
const TPM_RETURNCMD = 0x0100;

// MENUITEMINFOW, x64 (sizeof = 80).
export const MII_SIZE = 80;
export const MII_MASK = 4;
export const MII_HBMPITEM = 72;
const MIIM_BITMAP = 0x80;

/** A literal ampersand in a menu label is an accelerator prefix unless doubled. */
export const escapeLabel = (label: string) => label.replaceAll("&", "&&");

/** The MENUITEMINFOW that sets only hbmpItem. */
export function bitmapItemInfo(hbm: bigint): Uint8Array {
  const mii = new Uint8Array(MII_SIZE);
  const dv = new DataView(mii.buffer);
  dv.setUint32(0, MII_SIZE, true);
  dv.setUint32(MII_MASK, MIIM_BITMAP, true);
  dv.setBigUint64(MII_HBMPITEM, hbm, true);
  return mii;
}

type Built = { hmenu: bigint; commands: Map<number, () => void>; bitmaps: bigint[] };

function build(template: MenuTemplate): Built {
  const built: Built = { hmenu: user32.CreatePopupMenu(), commands: new Map(), bitmaps: [] };
  if (built.hmenu === 0n) throw new Error("sweetnative: CreatePopupMenu failed");
  try {
    fill(built.hmenu, template, built);
  } catch (err) {
    destroy(built);
    throw err;
  }
  return built;
}

function destroy(built: Built): void {
  user32.DestroyMenu(built.hmenu); // takes the submenus with it
  for (const hbm of built.bitmaps) gdi32.DeleteObject(hbm);
}

function fill(hmenu: bigint, template: MenuTemplate, built: Built): void {
  template.forEach((item, position) => {
    if (isSeparator(item)) {
      user32.AppendMenuW(hmenu, MF_SEPARATOR, 0n, null);
      return;
    }
    const grayed = item.enabled === false ? MF_GRAYED : 0;
    const label = wstr(escapeLabel(item.label)); // AppendMenuW copies the text
    if (isSubmenu(item)) {
      const sub = user32.CreatePopupMenu();
      if (sub === 0n) throw new Error("sweetnative: CreatePopupMenu failed");
      fill(sub, item.submenu, built);
      user32.AppendMenuW(hmenu, MF_POPUP | MF_STRING | grayed, sub, label);
    } else {
      const id = built.commands.size + 1; // command ids are 1-based; 0 means "nothing chosen"
      built.commands.set(id, item.click ?? (() => {}));
      const checked = item.checked ? MF_CHECKED : 0;
      user32.AppendMenuW(hmenu, MF_STRING | grayed | checked, BigInt(id), label);
    }
    const ico = item.icon?.windows?.ico;
    if (ico !== undefined) {
      const hbm = iconBitmap(ico);
      if (hbm !== 0n) {
        built.bitmaps.push(hbm);
        if (!user32.SetMenuItemInfoW(hmenu, position, 1, bitmapItemInfo(hbm))) console.error(`sweetnative: SetMenuItemInfoW(hbmpItem) failed (${lastError()})`);
      }
    }
  });
}

/**
 * Shows `template` at the cursor, owned by `owner`, and runs the chosen item's
 * click handler. Blocks until the menu closes. Returns true when an item was chosen.
 */
export function popupMenuAtCursor(owner: bigint, template: MenuTemplate): boolean {
  const pt = new Int32Array(2);
  user32.GetCursorPos(pt);
  const built = build(template);
  // The owner must be the foreground window or the menu will not dismiss when
  // the user clicks elsewhere; the WM_NULL afterwards is the documented nudge
  // that makes the menu close correctly next time (KB 135788).
  user32.SetForegroundWindow(owner);
  const chosen = user32.TrackPopupMenu(built.hmenu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_RETURNCMD, pt[0]!, pt[1]!, 0, owner, null);
  user32.PostMessageW(owner, WM_NULL, 0n, 0n);
  destroy(built);
  const handler = built.commands.get(chosen);
  handler?.();
  return handler !== undefined;
}
