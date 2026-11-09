// Windows notifications: the tray icon's balloon, which Windows 10/11 renders
// as a regular toast in the notification centre, with our own icon. Flat C,
// no WinRT, no AppUserModelID registration. The toast belongs to the tray
// icon, so the tray must exist first.

import type { Notifier, NotifierOptions } from "../notifications";
import { currentTray } from "./tray";

const activeNotifier = new WeakMap<object, symbol>(); // each tray has one balloon click handler; its newest notifier owns it

export function createNotifier(options: NotifierOptions = {}): Notifier {
  const tray = currentTray();
  if (!tray) throw new Error("sweetnative: on Windows, create the tray before the notifier (toasts hang off the tray icon)");
  tray.balloon.onClick(options.onClick);
  const me = Symbol("notifier");
  activeNotifier.set(tray, me);
  let disposed = false;
  return {
    notify(n) {
      return !disposed && tray.balloon.show(n);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (activeNotifier.get(tray) === me) tray.balloon.onClick(undefined); // a newer notifier owns the handler otherwise
    },
  };
}
