// macOS privacy permissions: the rows of System Settings > Privacy & Security.
// Read what macOS says about one, show the system's prompt for it, wait for
// the user's answer, open its Settings pane.
//
// A grant belongs to the app that asks, by code identity: a bare `bun` script
// gets the grants of the terminal that launched it, a signed .app its own.
//
// Windows and Linux gate none of this through these calls: every status there
// is "not-applicable", nothing is loaded and nothing throws.

/** Every permission name, in the order the docs list them. */
export const permissionNames = [
  "ax-trust",
  "device-control",
  "input-monitoring",
  "screen-recording",
  "camera",
  "microphone",
  "contacts",
  "calendars",
  "calendars-write-only",
  "reminders",
  "photos",
  "photos-add-only",
  "speech-recognition",
  "music-library",
  "location",
  "location-always",
  "bluetooth",
  "focus-status",
  "external-storage",
  "full-disk-access",
] as const;

export type Permission = (typeof permissionNames)[number];

/**
 * What macOS says about a permission.
 *
 * - `granted`: allowed.
 * - `limited`: allowed in part: some photos, calendars write-only where full
 *   access was asked, location while in use where always was asked.
 * - `not-determined`: the user has not been asked.
 * - `denied`: the user said no, or switched it off in Settings.
 * - `restricted`: a policy forbids it (parental controls, device management); the user cannot change it.
 * - `missing`: not granted, and macOS does not say whether the user was ever
 *   asked: the permissions it answers only yes or no for, and an automation
 *   target that is not running.
 * - `not-applicable`: nothing to ask: not macOS, or a permission this macOS version does not have.
 */
export type PermissionStatus = "granted" | "limited" | "not-determined" | "denied" | "restricted" | "missing" | "not-applicable";

/** A pane of System Settings > Privacy & Security: one per permission, plus the two that have no status call of their own. */
export type SettingsPane = Permission | "automation" | "files-and-folders";

/** The folders macOS asks about on first access. */
export type ProtectedFolder = "desktop" | "documents" | "downloads";

export type WaitForPermissionOptions = {
  /**
   * `answered` (default): until the status is neither `not-determined` nor
   * `missing`, so a "no" ends the wait as well as a "yes". `granted`: until
   * the status is `granted`, for a user sent to Settings to switch on what
   * was denied.
   */
  until?: "answered" | "granted";
  /** Give up after this long and resolve with the status as it then is. Default: no limit. */
  timeoutMs?: number;
  /** How often the status is read. Default 500. */
  intervalMs?: number;
};

type Backend = typeof import("./darwin/permissions");
let loaded: Backend | undefined;
/** The macOS implementation, or undefined on any other OS, where nothing is loaded. */
const mac = (): Backend | undefined => (process.platform === "darwin" ? (loaded ??= require("./darwin/permissions") as Backend) : undefined);

function check<T extends string>(call: string, what: string, value: T, allowed: readonly T[]): T {
  if (!allowed.includes(value)) throw new TypeError(`sweetnative: ${call}: no ${what} is named ${JSON.stringify(value)}; the names are ${allowed.join(", ")}`);
  return value;
}

const settingsPanes: readonly SettingsPane[] = [...permissionNames, "automation", "files-and-folders"];
const protectedFolders: readonly ProtectedFolder[] = ["desktop", "documents", "downloads"];

/** What macOS says about the permission now. Shows nothing, on any thread. */
export function permissionStatus(permission: Permission): PermissionStatus {
  check("permissionStatus", "permission", permission, permissionNames);
  return mac()?.permissionStatus(permission) ?? "not-applicable";
}

/**
 * Asks macOS for the permission, which shows the system's prompt when the
 * user has not answered it yet, and returns the status right after asking,
 * without waiting for the answer: read it again, or `waitForPermission`.
 * macOS shows each prompt once per app; after a "no" the way forward is
 * `openPermissionSettings`. Asks nothing when the permission is already
 * granted or has no request of its own (`full-disk-access`).
 *
 * Throws, in an .app bundle, when the `Info.plist` lacks the usage
 * description the permission needs, because macOS ends a process that asks
 * without one.
 */
export function requestPermission(permission: Permission): PermissionStatus {
  check("requestPermission", "permission", permission, permissionNames);
  return mac()?.requestPermission(permission) ?? "not-applicable";
}

/**
 * The `Info.plist` keys a bundled app needs before it asks for the
 * permission: any one of the keys returned is enough, and an empty list means
 * the permission needs none. Depends on the macOS version for calendars and
 * reminders. Empty on any OS other than macOS.
 */
export function usageDescriptionKeys(permission: Permission): string[] {
  check("usageDescriptionKeys", "permission", permission, permissionNames);
  return mac()?.usageDescriptionKeys(permission) ?? [];
}

/** True when the status ends a wait of that kind. */
export function waitIsOver(status: PermissionStatus, until: "answered" | "granted"): boolean {
  if (status === "not-applicable") return true;
  return until === "granted" ? status === "granted" : status !== "not-determined" && status !== "missing";
}

/**
 * Reads the status on a timer until the user has answered, and resolves with
 * it. The timer is a Bun timer, so the thread's JS loop has to be running: a
 * worker, or the UI thread under `runEventLoop`; not the UI thread inside a
 * webview's `run()`, which blocks it.
 */
export function waitForPermission(permission: Permission, options: WaitForPermissionOptions = {}): Promise<PermissionStatus> {
  check("waitForPermission", "permission", permission, permissionNames);
  const { until = "answered", timeoutMs = Infinity, intervalMs = 500 } = options;
  check("waitForPermission", "wait", until, ["answered", "granted"]);
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError(`intervalMs must be a number of at least 1, got ${intervalMs}`);
  if (Number.isNaN(timeoutMs) || timeoutMs < 0) throw new RangeError(`timeoutMs must be a number of at least 0, got ${timeoutMs}`);
  return pollUntil(() => permissionStatus(permission), (status) => waitIsOver(status, until), timeoutMs, intervalMs);
}

/** Resolves with the first value `done` accepts, or with the value read once `timeoutMs` has passed. */
export function pollUntil<T>(read: () => T, done: (value: T) => boolean, timeoutMs: number, intervalMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    const tick = () => {
      let value: T;
      try {
        value = read();
      } catch (error) {
        reject(error);
        return;
      }
      if (done(value) || performance.now() >= deadline) resolve(value);
      else setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/**
 * Opens System Settings at the permission's pane of Privacy & Security, where
 * the user switches the app on. Returns false when the pane could not be
 * opened, and on any OS other than macOS.
 */
export function openPermissionSettings(pane: SettingsPane): boolean {
  check("openPermissionSettings", "Settings pane", pane, settingsPanes);
  return mac()?.openPermissionSettings(pane) ?? false;
}

/**
 * Whether this app may send Apple Events to the app with that bundle id
 * (`com.apple.finder`). Shows nothing. macOS answers only for a target that
 * is running: `missing` when it is not.
 */
export function automationStatus(targetBundleId: string): PermissionStatus {
  if (typeof targetBundleId !== "string" || targetBundleId === "") throw new TypeError("sweetnative: automationStatus: the target's bundle id is empty");
  return mac()?.automationStatus(targetBundleId) ?? "not-applicable";
}

/**
 * Asks to automate the app with that bundle id. Unlike `requestPermission`
 * this blocks the calling thread until the user answers the prompt, and
 * returns the answer.
 */
export function requestAutomation(targetBundleId: string): PermissionStatus {
  if (typeof targetBundleId !== "string" || targetBundleId === "") throw new TypeError("sweetnative: requestAutomation: the target's bundle id is empty");
  return mac()?.requestAutomation(targetBundleId) ?? "not-applicable";
}

/**
 * Lists the user's Desktop, Documents or Downloads folder, which is what
 * makes macOS ask for it: the call blocks while the prompt is up and returns
 * `granted` or `denied`. There is no way to read this status without asking.
 */
export function requestFolderAccess(folder: ProtectedFolder): PermissionStatus {
  check("requestFolderAccess", "folder", folder, protectedFolders);
  return mac()?.requestFolderAccess(folder) ?? "not-applicable";
}
