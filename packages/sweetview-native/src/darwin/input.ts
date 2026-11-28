// macOS only, until the macOS goal of the Rust rewrite replaces it: the input hooks and
// the permission model are the webview library's, through @n1h/sweetview-webview-bun,
// and `../input-hooks.ts` and `../permissions.ts` hand every call to them. Each reaches
// the package when called (see ./library), not when this module loads.

import type { KeyHandler, KeyboardHook, MouseHandler, MouseHook } from "../input-hooks";
import type { Feature, Permission, PermissionStatus } from "../permissions";

import { library } from "./library";

export const installMouseHook = (handler: MouseHandler): MouseHook => (library().installMouseHook as (handler: MouseHandler) => MouseHook)(handler);
export const installKeyboardHook = (handler: KeyHandler): KeyboardHook =>
  (library().installKeyboardHook as (handler: KeyHandler) => KeyboardHook)(handler);

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
