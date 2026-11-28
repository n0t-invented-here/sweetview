// The Windows notifier's TypeScript layer (`createNotifier`) through the native binding: which
// identity it hands the binding, what a click's data comes back as, the tray's icon handed on,
// `dispose`, and an exception thrown by `onClick`. What the notifier does with WinRT and the shell
// (toasts, routing each click once, the balloon fallback, beside a real tray) is proven in Rust:
// `crates/sweetview-platform-notify/src/windows.rs` and `crates/sweetview-runtime/src/notify.rs`.
// The binding's debug hooks stand in for a person clicking: they post the messages the shell
// posts, and the clicks then arrive from the UI thread's message loop, as real ones do.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { defineAppIdentity } from "@n1h/sweetview-settings";
import { binding } from "../binding";
import { dotIco } from "../icon";
import type { NotificationClick } from "../notifications";

const appIdKey = (appId: string) => `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;

/** The AUMID's `DisplayName`, read with `reg.exe`, or `null` when the key or value is missing. */
function displayName(appId: string): string | null {
  const out = spawnSync("reg", ["query", appIdKey(appId), "/v", "DisplayName"], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const line = out.stdout.split(/\r?\n/).find((l) => l.trim().startsWith("DisplayName"));
  return line?.replace(/^\s*DisplayName\s+REG_SZ\s+/, "") ?? null;
}

function deleteAppId(appId: string): void {
  // Exit code 1 means the key was not there, which is the state wanted.
  spawnSync("reg", ["delete", appIdKey(appId), "/f"], { encoding: "utf8" });
  expect(displayName(appId)).toBeNull();
  // The entry the notification platform keeps for every app id that has shown a toast.
  spawnSync("reg", ["delete", String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings` + "\\" + appId, "/f"], { encoding: "utf8" });
}

/** Dispatches what the UI thread's loop has waiting: the posted toast and balloon events. */
function pump(): void {
  binding().pumpEvents();
}

function pumpUntil(done: () => boolean): void {
  const deadline = Date.now() + 5000;
  while (!done() && Date.now() < deadline) {
    pump();
    Bun.sleepSync(5);
  }
  pump();
}

function cookieOf(shown: string | null, kind: "toast" | "balloon"): number {
  expect(shown).toStartWith(`${kind}:`);
  return Number(shown!.slice(kind.length + 1));
}

// The toasts these tests show go to the notification centre with no banner and are removed by the
// platform after this many seconds, so a run leaves none on the screen of a machine with nobody at
// it. Applications' toasts show a banner and never expire.
const TEST_TOAST_LIFE = 4;

describe.if(process.platform === "win32")("Windows notifier", () => {
  test("the explicit app ID wins over the identity's and is registered under the identity's name; a click's data comes back through JSON, or unchanged when JSON cannot carry it; dispose ends it", async () => {
    const { createNotifier, debugNativeNotifier } = await import("./notifier");
    const appId = `Sweetview.NotifierWrapperTest.${crypto.randomUUID()}`;
    const unused = `Sweetview.Unused.${crypto.randomUUID()}`;
    const identity = defineAppIdentity({ appId: unused, appName: "Sweetview wrapper test" });
    const clicks: NotificationClick[] = [];
    const backend = createNotifier({ appId, identity, onClick: (click) => clicks.push(click) });
    const native = debugNativeNotifier(backend)!;
    native.debugSetToastLife(TEST_TOAST_LIFE);
    try {
      expect(backend.notify({ title: "WinRT", silent: true })).toBe(true);
      expect(displayName(appId)).toBe("Sweetview wrapper test");
      expect(displayName(unused)).toBeNull();

      native.debugForcePath("balloonOnly");
      // A click with no payload gives no data.
      const plain = cookieOf(native.debugShow("plain", "Plain", "", true, null), "balloon");
      expect(native.debugSimulateBalloonEvent(plain, "clicked")).toBe(true);
      pumpUntil(() => clicks.length === 1);
      expect(clicks.splice(0)).toEqual([{ id: "plain", data: undefined }]);
      // Balloon uIDs count up process-wide, so each notification's below is the next one.
      const uid = cookieOf(native.debugShow("probe", "Probe", "", true, null), "balloon");
      const data = { index: 1, list: ["different", 2] };
      expect(backend.notify({ title: "Data", id: "data", silent: true, data })).toBe(true);
      const raw = () => "not JSON";
      expect(backend.notify({ title: "Raw", id: "raw", silent: true, data: raw })).toBe(true);
      expect(native.debugSimulateBalloonEvent(uid + 1, "clicked")).toBe(true);
      expect(native.debugSimulateBalloonEvent(uid + 2, "clicked")).toBe(true);
      pumpUntil(() => clicks.length === 2);
      expect(clicks[0]).toEqual({ id: "data", data });
      expect(clicks[0]!.data).not.toBe(data);
      expect(clicks[1]!.id).toBe("raw");
      expect(clicks[1]!.data).toBe(raw);

      backend.dispose();
      backend.dispose();
      expect(backend.notify({ title: "Disposed" })).toBe(false);
    } finally {
      backend.dispose();
      deleteAppId(appId);
      deleteAppId(unused);
    }
  });

  test("the tray's icon is handed to the binding; bytes it refuses are logged and the stock icon is used", async () => {
    const { createNotifier, debugNativeNotifier } = await import("./notifier");
    const { setNotifierTrayIcon } = await import("./notify-icon");
    const errors: unknown[][] = [];
    const originalError = console.error;
    const backend = createNotifier({});
    const native = debugNativeNotifier(backend)!;
    native.debugSetToastLife(TEST_TOAST_LIFE);
    try {
      native.debugForcePath("balloonOnly");
      setNotifierTrayIcon(dotIco({ sizes: [16, 32] }));
      expect(backend.notify({ title: "Tray icon", silent: true })).toBe(true);
      console.error = (...args: unknown[]) => void errors.push(args);
      setNotifierTrayIcon(new Uint8Array([1, 2, 3])); // not an icon: logged, the stock icon is used
      console.error = originalError;
      expect(String(errors[0]?.[0])).toBe("sweetview: notifier icon:");
      setNotifierTrayIcon(undefined);
      expect(backend.notify({ title: "Stock icon", silent: true })).toBe(true);
      // How many balloons are pending is proven in Rust (sweetview-platform-notify, windows.rs):
      // without_winrt_every_notification_is_a_balloon_with_or_without_an_icon.
    } finally {
      console.error = originalError;
      setNotifierTrayIcon(undefined);
      backend.dispose();
    }
  });

  test("a click handler that throws is logged with today's message and the loop goes on", async () => {
    const { createNotifier, debugNativeNotifier } = await import("./notifier");
    const errors: unknown[][] = [];
    const originalError = console.error;
    let calls = 0;
    const backend = createNotifier({
      onClick: () => {
        calls++;
        throw new Error("boom");
      },
    });
    const native = debugNativeNotifier(backend)!;
    native.debugSetToastLife(TEST_TOAST_LIFE);
    try {
      native.debugForcePath("balloonOnly");
      const uid = cookieOf(native.debugShow("throws", "Throws", "", true, null), "balloon");
      console.error = (...args: unknown[]) => void errors.push(args);
      native.debugSimulateBalloonEvent(uid, "clicked");
      pumpUntil(() => calls === 1);
      console.error = originalError;
      expect(calls).toBe(1);
      expect(errors.map((e) => e[0])).toEqual(["sweetview: notification onClick threw:"]);
      expect((errors[0]![1] as Error).message).toBe("boom");
    } finally {
      console.error = originalError;
      backend.dispose();
    }
  });
});
