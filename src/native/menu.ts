// Menus as data. A template describes items; each platform renders it with
// its own menu system when the menu opens.

import type { Icon } from "./icon";

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
