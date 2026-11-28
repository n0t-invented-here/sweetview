// Menus as data plus native popup menus backed by Win32 HMENU and AppKit NSMenu.

import type { Icon } from "./icon";
import { backend } from "./platform";
import { unwrapHandle, type Point, type WindowHandle, type WindowRef } from "./types";

export type MenuItem =
  | {
      type?: "item";
      label: string;
      /** Greyed out and unclickable when false. Default true. */
      enabled?: boolean;
      checked?: boolean;
      /** An image before the label: 16px from the .ico on Windows, a 16pt template image on macOS. */
      icon?: Icon;
      click?: () => void;
    }
  | {
      type?: "submenu";
      label: string;
      enabled?: boolean;
      icon?: Icon;
      submenu: MenuTemplate;
    }
  | { type: "separator" };

export type MenuTemplate = MenuItem[];

/**
 * A template, or a function that produces one. The function form is called
 * every time the menu is about to open, so labels, check marks and enabled
 * state can reflect current app state without any bookkeeping.
 */
export type MenuSource = MenuTemplate | (() => MenuTemplate);

export const resolveMenu = (source: MenuSource | undefined): MenuTemplate =>
  source === undefined ? [] : typeof source === "function" ? source() : source;

export const isSeparator = (item: MenuItem): item is { type: "separator" } => item.type === "separator";

export const isSubmenu = (item: MenuItem): item is Extract<MenuItem, { submenu: MenuTemplate }> =>
  !isSeparator(item) && "submenu" in item;

/** How `Menu.popup` places the menu at its point. */
export type MenuPopupOptions = {
  /**
   * The menu opens above the point: its bottom-left corner at the point, as a
   * tray menu opens above the taskbar. Default `false`: its top-left corner at
   * the point, so it opens downward. Windows only for now; macOS ignores it.
   */
  above?: boolean;
};

type Backend = { popupMenu(owner: WindowHandle, template: MenuTemplate, at?: Point, options?: MenuPopupOptions): boolean };
const impl = backend<Backend>(
  () => require("./win32/menu"),
  () => require("./darwin/menu"),
);

export const Menu = {
  /**
   * Opens a native popup menu at `at` (default: cursor position), below the
   * point, or above it with `{ above: true }`. Returns true if an item was chosen.
   */
  popup(owner: WindowRef, menu: MenuSource, at?: Point, options?: MenuPopupOptions): boolean {
    const template = resolveMenu(menu);
    if (template.length === 0) return false;
    return impl().popupMenu(unwrapHandle(owner), template, at, options);
  },
};
