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
  /** Suppresses only the sound; the notification still shows. Default false. */
  silent?: boolean;
  /**
   * Names the notification; `onClick` reports it. Default `sweetnative-<n>`,
   * counting up per process. macOS: a new notification with the id of one
   * still showing replaces it.
   */
  id?: string;
  /** Anything `JSON.stringify` accepts; `onClick` gets it back as parsed JSON. */
  data?: unknown;
};

/** What `onClick` receives: the clicked notification's `id` and its `data`, or `undefined` when it had none. */
export type NotificationClick = { id: string; data: unknown };

export type NotifierOptions = {
  /** Runs on the UI thread. On Windows the tray holds a single handler, so only the newest notifier's `onClick` fires. */
  onClick?: (click: NotificationClick) => void;
};

export interface Notifier {
  /**
   * Shows a notification. Returns false when the platform cannot show one
   * right now (macOS without a bundle id; Windows after the tray is gone), in
   * which case nothing is displayed. Windows shows one balloon per tray icon,
   * so a new one replaces the one still showing, and a click reports the
   * newest.
   */
  notify(notification: NotificationOptions): boolean;
  dispose(): void;
}

let nextId = 1;
/** Call once per notification: without an `id`, every call takes the next number. */
export const notificationId = (n: NotificationOptions): string => n.id ?? `sweetnative-${nextId++}`;

type Backend = { createNotifier(options?: NotifierOptions): Notifier };
const impl = backend<Backend>(
  () => require("./win32/notifier"),
  () => require("./darwin/notifier"),
);

export function createNotifier(options: NotifierOptions = {}): Notifier {
  return impl().createNotifier(options);
}
