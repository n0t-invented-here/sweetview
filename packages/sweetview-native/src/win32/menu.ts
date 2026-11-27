// Popup menus. The native binding builds the menu (muda) fresh for every
// showing from plain data, tracks it, and answers with the chosen item's number
// after it closes; the click handlers stay here, kept under those numbers.
// Either mouse button chooses an item. `buildMenu` hands an application the
// built menu itself, for its own `TrackPopupMenu`, until `destroyMenu`.

import type { IconBytes, MenuItemData } from "../../prebuilt/binding";
import { binding } from "../binding";
import type { Icon } from "../icon";
import { isSeparator, isSubmenu, type MenuTemplate } from "../menu";
import type { Point, WindowHandle } from "../types";

/** The part of an `Icon` the Windows binding reads: the .ico. */
export const iconBytes = (icon: Icon | undefined): IconBytes | undefined => (icon?.windows ? { ico: icon.windows.ico } : undefined);

/** A template as the binding's menu data, with the click handler of each item kept under its number. */
export type BuiltMenuData = { data: MenuItemData[]; handlers: Map<number, () => void> };

/**
 * Numbers the items of `template` from 1, depth first in the order they
 * appear (0 means nothing was chosen), and turns it into the binding's data.
 * An item without `click` still counts as chosen.
 */
export function menuData(template: MenuTemplate): BuiltMenuData {
  const handlers = new Map<number, () => void>();
  const convert = (items: MenuTemplate): MenuItemData[] =>
    items.map((item): MenuItemData => {
      if (isSeparator(item)) return { kind: "separator" };
      const common = { label: item.label, enabled: item.enabled !== false, icon: iconBytes(item.icon) };
      if (isSubmenu(item)) return { kind: "submenu", ...common, items: convert(item.submenu) };
      const id = handlers.size + 1;
      handlers.set(id, item.click ?? (() => {}));
      return { kind: "item", id, ...common, checked: item.checked === true };
    });
  return { data: convert(template), handlers };
}

/** The window handle as the binding takes it. */
export function handleValue(owner: WindowHandle): bigint {
  if (owner === null || owner === 0 || owner === 0n) throw new Error("sweetview: window handle is NULL");
  return BigInt(owner);
}

type Built = {
  /** The popup menu (`HMENU`), for the application's own `TrackPopupMenu`. */
  hmenu: bigint;
  /** The click handler of each item, under the command id `TrackPopupMenu` returns for it (from 1, in template order). */
  commands: Map<number, () => void>;
  /**
   * The item bitmaps the application had to free. Always empty: the native
   * layer owns the menu, its submenus and its item bitmaps, and `destroyMenu`
   * frees them all.
   */
  bitmaps: bigint[];
};

/**
 * Builds `template` into a popup menu for the application's own
 * `TrackPopupMenu`: check marks, icons, submenus, separators and disabled items
 * as `Menu.popup` shows them. Each item's command id is its number in
 * `commands` (from 1, depth first in template order), so the id
 * `TrackPopupMenu` returns (with `TPM_RETURNCMD`) or a `WM_COMMAND` carries
 * names its click handler. The menu stays alive until `destroyMenu(built)`.
 */
export function buildMenu(template: MenuTemplate): Built {
  const { data, handlers } = menuData(template);
  return { hmenu: binding().buildMenu(data), commands: handlers, bitmaps: [] };
}

/** Frees a menu `buildMenu` made, its submenus and its item bitmaps. Safe to call twice. */
export function destroyMenu(built: Built): void {
  binding().destroyMenu(built.hmenu);
}

function show(owner: bigint, template: MenuTemplate, at: Point | null, above: boolean): boolean {
  const { data, handlers } = menuData(template);
  const chosen = binding().popupMenu(owner, data, at, above);
  const handler = chosen === null ? undefined : handlers.get(chosen);
  handler?.();
  return handler !== undefined;
}

/**
 * Shows `template` at `at` (or the cursor when omitted), owned by `owner`, and
 * runs the chosen item's click handler. Blocks until the menu closes. Returns
 * whether an item was chosen.
 */
export function popupMenu(owner: WindowHandle, template: MenuTemplate, at?: Point): boolean {
  if (template.length === 0) return false;
  return show(handleValue(owner), template, at ?? null, false);
}

/**
 * Shows `template` at the cursor aligned above it (for tray menus, so the menu
 * sits above the taskbar), owned by `owner`, and runs the chosen item's click handler.
 */
export function popupMenuAtCursor(owner: bigint, template: MenuTemplate): boolean {
  if (template.length === 0) return false;
  return show(handleValue(owner), template, null, true);
}
