// Popup menus. The native binding builds the menu (muda) fresh for every
// showing from plain data, shows it, and answers with the chosen item's number
// after it closes; the click handlers stay here, kept under those numbers.

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

/**
 * Shows `template` at `at` (or the cursor when omitted), owned by `owner`, and
 * runs the chosen item's click handler. Blocks until the menu closes. Returns
 * whether an item was chosen.
 */
export function popupMenu(owner: WindowHandle, template: MenuTemplate, at?: Point): boolean {
  if (template.length === 0) return false;
  const hwnd = handleValue(owner);
  const { data, handlers } = menuData(template);
  const chosen = binding().popupMenu(hwnd, data, at ?? null);
  const handler = chosen === null ? undefined : handlers.get(chosen);
  handler?.();
  return handler !== undefined;
}

/** Shows `template` at the cursor, owned by `owner`, and runs the chosen item's click handler. */
export function popupMenuAtCursor(owner: bigint, template: MenuTemplate): boolean {
  return popupMenu(owner, template);
}
