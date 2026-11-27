// System notifications.
//
// Windows: WinRT toasts with per-notification Shell_NotifyIconW fallback.
// macOS: UNUserNotificationCenter with eager delegate registration in constructor.

import { backend } from "./platform";
import type { AppIdentity } from "@n1h/sweetview-settings";

export type NotificationOptions = {
  title: string;
  body?: string;
  silent?: boolean;
  /**
   * Names the notification; `onClick` reports it. Default `sweetview-<n>`,
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
  onClick?: (click: NotificationClick) => void;
  /** Windows toast identity. Defaults to `identity.appId` or `Sweetview.DesktopApp`. */
  appId?: string;
  /** Supplies the Windows toast app ID and display name. */
  identity?: AppIdentity;
};

export interface NotifierBackend {
  notify(notification: NotificationOptions): boolean;
  dispose(): void;
}

let nextId = 1;
export const notificationId = (n: NotificationOptions): string => n.id ?? `sweetview-${nextId++}`;

type Backend = { createNotifier(options?: NotifierOptions): NotifierBackend };
const impl = backend<Backend>(
  () => require("./win32/notifier"),
  () => require("./darwin/notifier"),
);

export class Notifier {
  readonly #inner: NotifierBackend;

  constructor(options: NotifierOptions = {}) {
    this.#inner = impl().createNotifier(options);
  }

  notify(notification: NotificationOptions): boolean {
    return this.#inner.notify(notification);
  }

  /** Safe to call twice. */
  dispose(): void {
    this.#inner.dispose();
  }
}

export function createNotifier(options: NotifierOptions = {}): Notifier {
  return new Notifier(options);
}
