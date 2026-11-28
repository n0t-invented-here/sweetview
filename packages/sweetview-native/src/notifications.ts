// System notifications.
//
// Windows: WinRT toasts with per-notification Shell_NotifyIconW fallback.
// macOS: UNUserNotificationCenter with eager delegate registration in constructor.

import { releaseAtEnd } from "./lifetime";
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
  /**
   * The release at the end of the application: lets go of the notifier as
   * `dispose()` does but leaves alone what it showed. Windows only; macOS's
   * `dispose()` already leaves its delivered notifications in place.
   */
  release?(): void;
}

let nextId = 1;
export const notificationId = (n: NotificationOptions): string => n.id ?? `sweetview-${nextId++}`;

type Backend = { createNotifier(options?: NotifierOptions): NotifierBackend };
const impl = backend<Backend>(
  () => require("./win32/notifier"),
  () => require("./darwin/notifier"),
);

/** Shows notifications. Released when the application ends (see `run()`), or before that by `dispose()`. */
export class Notifier {
  readonly #inner: NotifierBackend;
  readonly #unregister: () => void;

  constructor(options: NotifierOptions = {}) {
    const inner = (this.#inner = impl().createNotifier(options));
    backends.set(this, inner);
    // At the end the notifications it showed stay for the user to read; only dispose() withdraws them.
    this.#unregister = releaseAtEnd("notifier", () => (inner.release ? inner.release() : inner.dispose()));
  }

  notify(notification: NotificationOptions): boolean {
    return this.#inner.notify(notification);
  }

  /** Releases the notifier now, before the application ends. Safe to call twice, and after the end. */
  dispose(): void {
    this.#unregister();
    this.#inner.dispose();
  }
}

const backends = new WeakMap<Notifier, NotifierBackend>();

/** Internal, for tests: the platform backend behind a `Notifier`. */
export function notifierBackend(notifier: Notifier): NotifierBackend | undefined {
  return backends.get(notifier);
}

export function createNotifier(options: NotifierOptions = {}): Notifier {
  return new Notifier(options);
}
