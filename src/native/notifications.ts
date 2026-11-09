// System notifications.
//
// Windows: the tray icon's balloon, which Windows 10/11 shows as a toast with
// our icon, so create the tray first. macOS: UNUserNotificationCenter, which
// asks the user for permission on the first notification and needs a bundle
// identifier, so run the .app rather than the bare binary.

import { backend } from "./platform";

export type NotificationOptions = {
  title: string;
  body?: string;
  /** No sound. Default false. */
  silent?: boolean;
};

export type NotifierOptions = {
  /** The user clicked a notification. */
  onClick?: () => void;
};

export interface Notifier {
  /**
   * Shows a notification. Returns false when the platform cannot show one
   * right now (macOS without a bundle id; Windows after the tray is gone), in
   * which case nothing is displayed.
   */
  notify(notification: NotificationOptions): boolean;
  dispose(): void;
}

type Backend = { createNotifier(options?: NotifierOptions): Notifier };
const impl = backend<Backend>(
  () => require("./win32/notifier"),
  () => require("./darwin/notifier"),
);

export function createNotifier(options: NotifierOptions = {}): Notifier {
  return impl().createNotifier(options);
}
