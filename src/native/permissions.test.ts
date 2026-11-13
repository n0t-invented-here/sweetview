// Status calls show nothing, so they run here for real. No test asks for a
// permission: a request puts a system prompt on the screen of whoever runs
// the suite.

import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import {
  automationStatus,
  openPermissionSettings,
  permissionNames,
  permissionStatus,
  pollUntil,
  requestFolderAccess,
  requestPermission,
  usageDescriptionKeys,
  waitForPermission,
  waitIsOver,
  type Permission,
  type PermissionStatus,
  type SettingsPane,
} from "./permissions";

const onMac = process.platform === "darwin";
const statuses: PermissionStatus[] = ["granted", "limited", "not-determined", "denied", "restricted", "missing", "not-applicable"];

describe("permission names", () => {
  test("each is listed once", () => {
    expect(new Set(permissionNames).size).toBe(permissionNames.length);
  });

  test("a name that is not a permission is a TypeError that lists the names", () => {
    const wrong = "cammera" as Permission;
    for (const call of [permissionStatus, requestPermission, usageDescriptionKeys, waitForPermission]) {
      expect(() => call(wrong)).toThrow(TypeError);
      expect(() => call(wrong)).toThrow(/sweetnative: \w+: no permission is named "cammera"; the names are ax-trust, /);
    }
    expect(() => openPermissionSettings("cammera" as SettingsPane)).toThrow(/no Settings pane is named "cammera"/);
    expect(() => requestFolderAccess("music" as "desktop")).toThrow(/no folder is named "music"; the names are desktop, documents, downloads/);
    expect(() => automationStatus("")).toThrow(/the target's bundle id is empty/);
  });
});

describe.if(onMac)("permission status on macOS", () => {
  test.each([...permissionNames])("%s reads as one of the statuses", (permission) => {
    expect(statuses).toContain(permissionStatus(permission));
  });

  test("device-control and input-monitoring agree with the calls the webview's input hooks check", () => {
    const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGPreflightPostEventAccess: { args: [], returns: FFIType.bool },
      CGPreflightListenEventAccess: { args: [], returns: FFIType.bool },
    }).symbols;
    expect(permissionStatus("device-control") === "granted").toBe(cg.CGPreflightPostEventAccess());
    expect(permissionStatus("input-monitoring") === "granted").toBe(cg.CGPreflightListenEventAccess());
  });

  test("the permissions macOS answers yes or no for never read as denied or not-determined", () => {
    for (const permission of ["ax-trust", "screen-recording", "full-disk-access"] as const) {
      expect(["granted", "missing"]).toContain(permissionStatus(permission));
    }
  });

  test("a permission with no request of its own is not asked for", () => {
    expect(requestPermission("full-disk-access")).toBe(permissionStatus("full-disk-access"));
  });

  test("automation answers missing for an app that is not running, and shows nothing", () => {
    expect(automationStatus("dev.sweetview.no-such-app")).toBe("missing");
    expect(["granted", "denied", "not-determined"]).toContain(automationStatus("com.apple.finder"));
  });

  test("every Settings pane has a Privacy & Security anchor", async () => {
    const { settingsUrl } = await import("./darwin/permissions");
    for (const pane of [...permissionNames, "automation", "files-and-folders"] as const) {
      expect(settingsUrl(pane)).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_[A-Za-z]+$/);
    }
    expect(settingsUrl("input-monitoring")).toEndWith("?Privacy_ListenEvent");
    expect(settingsUrl("ax-trust")).toBe(settingsUrl("device-control")); // one row in Settings
  });

  test("usage description keys", () => {
    expect(usageDescriptionKeys("camera")).toEqual(["NSCameraUsageDescription"]);
    expect(usageDescriptionKeys("location")).toEqual(["NSLocationWhenInUseUsageDescription", "NSLocationUsageDescription"]);
    expect(usageDescriptionKeys("screen-recording")).toEqual([]);
    // macOS 14 renamed the calendar keys; one of the two generations, never both.
    expect(["NSCalendarsFullAccessUsageDescription", "NSCalendarsUsageDescription"]).toContain(usageDescriptionKeys("calendars")[0]!);
    expect(usageDescriptionKeys("calendars")).toHaveLength(1);
  });

  test("asking without a usage description is refused before macOS sees it, in a bundle only", async () => {
    const { usageDescriptionError } = await import("./darwin/permissions");
    const has = (present: string[]) => (key: string) => present.includes(key);
    const keys = ["NSLocationWhenInUseUsageDescription", "NSLocationUsageDescription"];
    expect(usageDescriptionError('requestPermission("location")', keys, true, has([]))).toBe(
      `sweetnative: requestPermission("location"): the app's Info.plist has no NSLocationWhenInUseUsageDescription or NSLocationUsageDescription, and macOS refuses the request, or ends the process, without it (makeMacApp's plist option adds one)`,
    );
    expect(usageDescriptionError("x", keys, true, has(["NSLocationUsageDescription"]))).toBeUndefined(); // either key will do
    expect(usageDescriptionError("x", keys, false, has([]))).toBeUndefined(); // a bare binary asks in its launcher's name
    expect(usageDescriptionError("x", [], true, has([]))).toBeUndefined(); // nothing needed
  });
});

describe.if(!onMac)("off macOS", () => {
  test("every status is not-applicable and nothing is asked or opened", async () => {
    for (const permission of permissionNames) {
      expect(permissionStatus(permission)).toBe("not-applicable");
      expect(requestPermission(permission)).toBe("not-applicable");
      expect(usageDescriptionKeys(permission)).toEqual([]);
    }
    expect(await waitForPermission("camera")).toBe("not-applicable");
    expect(automationStatus("com.apple.finder")).toBe("not-applicable");
    expect(requestFolderAccess("desktop")).toBe("not-applicable");
    expect(openPermissionSettings("camera")).toBe(false);
  });
});

describe("waiting for an answer", () => {
  test("answered: a no ends the wait, a status that says nothing does not", () => {
    for (const status of ["granted", "limited", "denied", "restricted", "not-applicable"] as const) expect(waitIsOver(status, "answered")).toBe(true);
    for (const status of ["not-determined", "missing"] as const) expect(waitIsOver(status, "answered")).toBe(false);
  });

  test("granted: only granted ends the wait", () => {
    for (const status of ["limited", "denied", "restricted", "not-determined", "missing"] as const) expect(waitIsOver(status, "granted")).toBe(false);
    expect(waitIsOver("granted", "granted")).toBe(true);
    expect(waitIsOver("not-applicable", "granted")).toBe(true);
  });

  test("pollUntil reads until the value is accepted", async () => {
    const answers = ["not-determined", "not-determined", "denied", "granted"];
    let reads = 0;
    expect(await pollUntil(() => answers[reads++]!, (status) => status !== "not-determined", Infinity, 1)).toBe("denied");
    expect(reads).toBe(3);
  });

  test("pollUntil reads once when the first value is accepted", async () => {
    let reads = 0;
    expect(await pollUntil(() => ++reads, () => true, Infinity, 1)).toBe(1);
  });

  test("pollUntil gives up at the timeout with the value as it then is", async () => {
    let reads = 0;
    const last = await pollUntil(() => ++reads, () => false, 30, 5);
    expect(last).toBe(reads);
    expect(reads).toBeGreaterThan(1);
  });

  test("pollUntil rejects when a read throws", async () => {
    expect(pollUntil(() => { throw new Error("read failed"); }, () => true, Infinity, 1)).rejects.toThrow("read failed");
  });

  test("waitForPermission rejects a bad interval, timeout or kind of wait", () => {
    expect(() => waitForPermission("camera", { intervalMs: 0 })).toThrow(RangeError);
    expect(() => waitForPermission("camera", { timeoutMs: -1 })).toThrow(RangeError);
    expect(() => waitForPermission("camera", { until: "soon" as "granted" })).toThrow(/no wait is named "soon"; the names are answered, granted/);
  });

  test.if(onMac)("waitForPermission resolves with the status at the timeout", async () => {
    // Full Disk Access is granted or missing; either way the wait ends within the timeout.
    expect(await waitForPermission("full-disk-access", { timeoutMs: 20, intervalMs: 5 })).toBe(permissionStatus("full-disk-access"));
  });
});
