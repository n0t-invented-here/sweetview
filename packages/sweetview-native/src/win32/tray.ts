// Notification-area icon, made by the native binding (tray-icon). Right click
// opens the menu, built from the template each time it opens; left double
// click fires onDoubleClick; a left click that is not followed by a second one
// within the user's double-click time fires onClick. The binding times the
// double click on the UI thread's own message loop, so it works while the
// blocking loop owns the thread, and calls these handlers from that loop.

import { binding } from "../binding";
import { resolveMenu, type MenuSource } from "../menu";
import type { TrayBackend, TrayOptions } from "../tray";
import { iconBytes, menuData } from "./menu";

// NOTIFYICONDATAW, x64, current version (sizeof = 976). The tray no longer
// lays it out; the notifier's hidden balloon icon (notifier.ts) does.
export const NID_SIZE = 976;
export const NID_HWND = 8;
export const NID_UID = 16;
export const NID_FLAGS = 20;
export const NID_CALLBACK = 24;
export const NID_HICON = 32;
export const NID_TIP = 40; // WCHAR[128]
export const NID_INFO = 304; // WCHAR[256]
export const NID_INFO_TITLE = 820; // WCHAR[64]
export const NID_INFO_FLAGS = 948;
export const NID_BALLOON_ICON = 968;

/** The Windows tray, as the rest of this folder sees it. */
export interface Win32Tray extends TrayBackend {
  /** The icon's own window, which the shell posts its mouse messages to. 0n once disposed. */
  readonly windowHandle: () => bigint;
  readonly iconBytes: () => Uint8Array | undefined;
}

let active: Win32Tray | undefined;
/** The most recently created tray that has not been disposed. */
export const currentTray = (): Win32Tray | undefined => active;
/** The active tray's .ico bytes, if a tray currently exists. */
export const currentTrayIconBytes = (): Uint8Array | undefined => active?.iconBytes();

const report = (err: unknown) => console.error("sweetview: message window handler threw:", err);

/** An application handler as the binding calls it: an exception is logged, never thrown into the OS loop. */
const guarded = (handler: () => void) => () => {
  try {
    handler();
  } catch (err) {
    report(err);
  }
};

export function createTray(options: TrayOptions): Win32Tray {
  let rawIco = options.icon?.windows?.ico;
  let menu: MenuSource | undefined = options.menu;
  let handlers = new Map<number, () => void>();
  let disposed = false;

  const openMenu = () => {
    try {
      const built = menuData(resolveMenu(menu));
      handlers = built.handlers;
      return built.data;
    } catch (err) {
      report(err);
      return [];
    }
  };
  const menuChosen = (id: number) => {
    const handler = handlers.get(id);
    handlers = new Map();
    if (handler) guarded(handler)();
  };

  const native = new (binding().Tray)(
    options.tooltip ?? "",
    iconBytes(options.icon) ?? null,
    menu !== undefined,
    options.onClick ? guarded(() => options.onClick?.()) : null,
    options.onDoubleClick ? guarded(() => options.onDoubleClick?.()) : null,
    openMenu,
    menuChosen,
  );

  const tray: Win32Tray = {
    windowHandle: () => native.windowHandle,
    iconBytes: () => rawIco,
    setTooltip(text) {
      if (disposed) return;
      native.setTooltip(text);
    },
    setIcon(next) {
      if (disposed) return;
      native.setIcon(iconBytes(next) ?? null);
      rawIco = next.windows?.ico;
    },
    setMenu(next) {
      menu = next;
      if (!disposed) native.setHasMenu(next !== undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      native.dispose();
      if (active === tray) active = undefined;
    },
  };

  active = tray;
  return tray;
}
