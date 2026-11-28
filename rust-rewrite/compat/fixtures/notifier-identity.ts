// Part A rows `createNotifier`, `Notifier` and `NotifierOptions`, run for real: who a notification
// is shown as. In 0.2.x a notifier needed the tray and showed the tray icon's balloon, which Windows
// attributes to the application's executable. Now a notifier needs no tray and shows a WinRT toast
// under an Application User Model ID: with no `appId` or `identity` the binding gets none and uses
// `Sweetview.DesktopApp`, registered with the display name "Sweetview"
// (crates/sweetview-platform-notify/src/toast_xml.rs); with
// `identity: defineAppIdentity({ appId, appName })` the toast is registered under the
// application's own id and name. What each notifier hands the binding is read by wrapping the
// binding's `Notifier`; the registration is read from the registry after a toast that is built and
// held back from the platform (nothing is shown), under a throwaway app id whose entries are then
// removed, as notifier.test.ts does. Prints one JSON line.

import { createNotifier, defineAppIdentity } from "@n1h/sweetview/native";
import { binding } from "../../../packages/sweetview-native/src/binding";

const native = binding() as unknown as Record<string, unknown> & { Notifier: new (...args: unknown[]) => unknown };
const RealNotifier = native.Notifier;
const handed: { appId: unknown; appName: unknown }[] = [];
native.Notifier = class extends (RealNotifier as new (...args: unknown[]) => object) {
  constructor(...args: unknown[]) {
    handed.push({ appId: args[0], appName: args[1] });
    super(...args);
  }
} as unknown as typeof RealNotifier;

const key = (appId: string) => `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
const displayName = (appId: string): string | null => {
  const out = Bun.spawnSync(["reg", "query", key(appId), "/v", "DisplayName"], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) return null;
  return /DisplayName\s+REG_SZ\s+(.*)/.exec(out.stdout.toString())?.[1]?.trim() ?? null;
};

const report: Record<string, unknown> = {};

// No tray, no identity: made without a tray (0.2.x threw), and the binding gets no id and no name.
const plain = createNotifier();
report.withoutTrayOrIdentity = handed.at(-1);
plain.dispose();

// The application's own identity.
const appId = `Sweetview.NotifierTest.${crypto.randomUUID()}`;
const identity = defineAppIdentity({ appId, appName: "Compat Notes" });
try {
  const { createNotifier: createBackend, debugNativeNotifier } = require("../../../packages/sweetview-native/src/win32/notifier");
  const backend = createBackend({ identity });
  report.withIdentity = JSON.stringify(handed.at(-1)) === JSON.stringify({ appId, appName: "Compat Notes" });
  const held = debugNativeNotifier(backend);
  held.debugForcePath("toastHeld");
  held.debugShow("compat", "Sweetview compat test", "held back, never shown", true, null);
  report.registeredUnderOwnName = displayName(appId) === "Compat Notes";
  backend.dispose();
} finally {
  Bun.spawnSync(["reg", "delete", key(appId), "/f"], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["reg", "delete", `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${appId}`, "/f"], { stdout: "pipe", stderr: "pipe" });
}
report.registryCleaned = displayName(appId) === null;

native.Notifier = RealNotifier;
console.log(JSON.stringify(report));
process.exit(0);
