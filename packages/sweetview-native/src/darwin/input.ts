// macOS only, until the macOS goal of the Rust rewrite replaces it: the input hooks and
// the permission model are the webview library's, through @n1h/sweetview-webview-bun,
// and `../input-hooks.ts` and `../permissions.ts` hand every call to them. Each reaches
// the package when called (see ./library), not when this module loads.
//
// The library's hooks do not catch an exception the handler throws (their wrapper is a
// `try`/`finally`). Until the macOS goal that stays so (D42): with no `onCallbackError`
// listener set, the handler's exception is rethrown unchanged and leaves the library as it
// did at the tag. Only while a listener is set is it reported there instead, and the event
// is not swallowed (D43).

import { hasCallbackErrorListener, reportCallbackError, type CallbackKind } from "../callback-errors";
import type { KeyHandler, KeyboardHook, MouseHandler, MouseHook } from "../input-hooks";
import type { Feature, Permission, PermissionStatus } from "../permissions";

import { library } from "./library";

/** `handler` as the library calls it: as it is, unless a listener is set when it throws. */
function reportingWhenListened<M>(kind: CallbackKind, line: string, handler: (message: M) => boolean): (message: M) => boolean {
  return (message) => {
    try {
      return handler(message);
    } catch (err) {
      if (!hasCallbackErrorListener()) throw err;
      reportCallbackError(kind, err, line);
      return false;
    }
  };
}

export const installMouseHook = (handler: MouseHandler): MouseHook =>
  (library().installMouseHook as (handler: MouseHandler) => MouseHook)(reportingWhenListened("mouseHook", "sweetview: mouse hook handler threw:", handler));
export const installKeyboardHook = (handler: KeyHandler): KeyboardHook =>
  (library().installKeyboardHook as (handler: KeyHandler) => KeyboardHook)(reportingWhenListened("keyboardHook", "sweetview: keyboard hook handler threw:", handler));

type LibraryPermissions = {
  needed(feature: Feature): Permission[];
  status(permission: Permission): PermissionStatus;
  request(permission: Permission): PermissionStatus;
  ready(feature: Feature): boolean;
  autoRequest: boolean;
};
const libraryPermissions = (): LibraryPermissions => library().permissions as LibraryPermissions;

/** The library's `permissions`, each member forwarded to it when used. */
export const permissions: LibraryPermissions = {
  needed: (feature) => libraryPermissions().needed(feature),
  status: (permission) => libraryPermissions().status(permission),
  request: (permission) => libraryPermissions().request(permission),
  ready: (feature) => libraryPermissions().ready(feature),
  get autoRequest() {
    return libraryPermissions().autoRequest;
  },
  set autoRequest(on: boolean) {
    libraryPermissions().autoRequest = on;
  },
};
