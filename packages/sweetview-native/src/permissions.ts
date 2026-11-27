// The permission model for the input hooks: which OS permissions a feature
// needs, whether each is granted, and asking for one. The model the package
// `@n1h/sweetview-webview-bun` exported as `permissions`.
//
// Windows needs none: every feature reports nothing needed, and a permission's
// status is "not-applicable". macOS: the webview library of
// `@n1h/sweetview-webview-bun`, until the macOS goal of the rewrite.

import { binding } from "./binding";

/** An OS permission. The values are bits, as the native layer reports them. */
export enum Permission {
  /** macOS: "Device Control and Data Access", which posting and swallowing input needs. */
  DeviceControl = 1 << 0,
  /** macOS: "Input Monitoring". */
  InputMonitoring = 1 << 1,
}

/** A feature that may need permissions. */
export enum Feature {
  MouseHook = 0,
  KeyboardHook = 1,
}

/** `"not-applicable"`: this platform has no such permission. */
export type PermissionStatus = "granted" | "missing" | "not-applicable";

const WEBVIEW_ERROR_OK = 0;
const WEBVIEW_ERROR_MISSING_DEPENDENCY = -5;
const WEBVIEW_ERROR_UNSPECIFIED = -1;

function statusFrom(code: number): PermissionStatus {
  if (code === WEBVIEW_ERROR_OK) return "granted";
  if (code === WEBVIEW_ERROR_MISSING_DEPENDENCY) return "missing";
  if (code === WEBVIEW_ERROR_UNSPECIFIED) return "not-applicable";
  throw new Error(`webview permission call failed: error ${code}`);
}

const all: Permission[] = [Permission.DeviceControl, Permission.InputMonitoring];
let autoRequest = true;

type Permissions = {
  /** The permissions a feature needs on this platform; empty when it needs none. */
  needed(feature: Feature): Permission[];
  /** Whether a permission is granted, without asking for it. */
  status(permission: Permission): PermissionStatus;
  /** Asks the OS for a permission (macOS shows its prompt once) and returns its state. */
  request(permission: Permission): PermissionStatus;
  /** True when every permission the feature needs is granted. */
  ready(feature: Feature): boolean;
  /** Whether installing a hook asks for a missing permission by itself. Default: true. */
  autoRequest: boolean;
};

const native: Permissions = {
  needed(feature) {
    const bits = binding().featurePermissions(feature);
    return all.filter((p) => (bits & p) !== 0);
  },
  status(permission) {
    return statusFrom(binding().permissionStatus(permission));
  },
  request(permission) {
    return statusFrom(binding().permissionRequest(permission));
  },
  ready(feature) {
    return this.needed(feature).every((p) => this.status(p) === "granted");
  },
  get autoRequest() {
    return autoRequest;
  },
  set autoRequest(on: boolean) {
    autoRequest = on;
    binding().permissionSetAutoRequest(on);
  },
};

/** The permission model. */
export const permissions: Permissions =
  process.platform === "darwin" ? ((await import("./darwin/input")).permissions as Permissions) : native;
