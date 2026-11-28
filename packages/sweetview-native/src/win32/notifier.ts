// Windows notifications through the native binding: WinRT toasts, with a
// balloon on a hidden notification icon of the notifier's own as the fallback,
// with or without a Tray. Each toast or balloon carries its own click payload.

import { binding } from "../binding";
import type { Notifier as NativeNotifier } from "../../prebuilt/binding";
import { type NotificationClick, type NotificationOptions, type NotifierBackend, type NotifierOptions, notificationId } from "../notifications";
import { notifierTrayIcon, onNotifierTrayIcon } from "./notify-icon";

/**
 * Marks a `dataJson` that is not JSON: a value `JSON.stringify` cannot carry,
 * which today's notifier hands back unchanged. A NUL cannot start JSON text.
 */
const RAW_DATA = "\u0000sweetview-raw:";

/** Hands `ico` to the native notifier; bytes it refuses fall back to the stock icon. */
function applyIcon(native: NativeNotifier, ico: Uint8Array | undefined): void {
  try {
    native.setIcon(ico ?? null);
  } catch (err) {
    console.error("sweetview: notifier icon:", err);
    native.setIcon(null);
  }
}

export function createNotifier(options: NotifierOptions = {}): NotifierBackend {
  let disposed = false;
  const rawData = new Map<number, unknown>();
  let nextRaw = 1;

  const onClick = (id: string, dataJson: string | null | undefined): void => {
    if (disposed) return;
    let data: unknown;
    if (dataJson != null && dataJson.startsWith(RAW_DATA)) {
      const key = Number(dataJson.slice(RAW_DATA.length));
      data = rawData.get(key);
      rawData.delete(key);
    } else if (dataJson != null) {
      data = JSON.parse(dataJson);
    }
    const click: NotificationClick = { id, data };
    try {
      options.onClick?.(click);
    } catch (err) {
      console.error("sweetview: notification onClick threw:", err);
    }
  };

  const NativeNotifierClass = binding().Notifier;
  const appId = options.appId ?? options.identity?.appId ?? null;
  const appName = options.identity?.appName ?? null;
  let native: NativeNotifier;
  try {
    native = new NativeNotifierClass(appId, appName, notifierTrayIcon() ?? null, onClick);
  } catch {
    // Icon bytes the binding refuses: start with the stock icon instead.
    native = new NativeNotifierClass(appId, appName, null, onClick);
  }
  const stopIcon = onNotifierTrayIcon((ico) => {
    if (!disposed) applyIcon(native, ico);
  });

  const backend: NotifierBackend = {
    notify(n: NotificationOptions): boolean {
      if (disposed) return false;
      // Clone data through JSON when possible to match macOS; a value JSON cannot carry comes back unchanged.
      let dataJson: string | null = null;
      if (n.data !== undefined) {
        let json: string | undefined;
        try {
          json = JSON.stringify(n.data);
          if (json !== undefined) JSON.parse(json);
        } catch {
          json = undefined;
        }
        if (json === undefined) {
          const key = nextRaw++;
          rawData.set(key, n.data);
          dataJson = `${RAW_DATA}${key}`;
        } else {
          dataJson = json;
        }
      }
      return native.notify(notificationId(n), n.title, n.body ?? "", n.silent === true, dataJson);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopIcon();
      rawData.clear();
      native.dispose();
    },
    release() {
      if (disposed) return;
      disposed = true;
      stopIcon();
      rawData.clear();
      native.release();
    },
  };
  nativeOf.set(backend, native);
  return backend;
}

const nativeOf = new WeakMap<NotifierBackend, NativeNotifier>();

/** Test hook: the binding's notifier behind a backend `createNotifier` made, for its `debug*` methods. */
export function debugNativeNotifier(backend: NotifierBackend): NativeNotifier | undefined {
  return nativeOf.get(backend);
}
