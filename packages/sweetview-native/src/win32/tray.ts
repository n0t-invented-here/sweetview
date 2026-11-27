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
import { setNotifierTrayIcon } from "./notify-icon";

/** The Windows tray, as the rest of this folder sees it. */
export interface Win32Tray extends TrayBackend {
  /** The icon's own window, which the shell posts its mouse messages to. 0n once disposed. */
  readonly windowHandle: () => bigint;
  readonly iconBytes: () => Uint8Array | undefined;
}

let active: Win32Tray | undefined;
/** The most recently created tray that has not been disposed. */
export const currentTray = (): Win32Tray | undefined => active;

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
      // A notifier's balloon fallback shows the active tray's icon.
      if (active === tray) setNotifierTrayIcon(rawIco);
    },
    setMenu(next) {
      menu = next;
      if (!disposed) native.setHasMenu(next !== undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      native.dispose();
      if (active === tray) {
        active = undefined;
        setNotifierTrayIcon(undefined);
      }
    },
  };

  active = tray;
  setNotifierTrayIcon(rawIco);
  return tray;
}
