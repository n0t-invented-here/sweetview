// The Windows notifier through the native binding, against real WinRT and the real shell.
// The binding's debug hooks stand in for a person clicking: they invoke the
// handlers WinRT holds and post the messages the shell posts, and the clicks
// then arrive from the UI thread's message loop, as real ones do.

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
  test("registers an AUMID and shows real WinRT toasts with independently routed clicks", async () => {
    const { createNotifier, debugNativeNotifier } = await import("./notifier");
    const appId = `Sweetview.NotifierTest.${crypto.randomUUID()}`;
    const identity = defineAppIdentity({ appId, appName: 'Sweetview <test> & "toast"' });
    const clicks: NotificationClick[] = [];
    // A real IToastNotifier.Show under this identity, on a notifier of its own: a toast, not a fallback.
    const real = createNotifier({ identity, onClick: () => {} });
    try {
      const realNative = debugNativeNotifier(real)!;
      realNative.debugSetToastLife(TEST_TOAST_LIFE);
      cookieOf(realNative.debugShow("really shown", '<Title> & "quotes"', "It’s <body> & 'more'", true, "null"), "toast");
      expect(realNative.debugToastsAvailable()).toBe(true);
      expect(realNative.debugBalloonsShown()).toBe(0);
    } finally {
      real.dispose();
    }
    const backend = createNotifier({ identity, onClick: (click) => clicks.push(click) });
    const native = debugNativeNotifier(backend)!;
    native.debugSetToastLife(TEST_TOAST_LIFE);
    try {
      const first = { id: 'first<&>"', data: { index: 1 } };
      const second = { id: "second", data: ["different", 2] };
      const show = (click: { id: string; data: unknown }) =>
        native.debugShow(click.id, '<Title> & "quotes"', "It’s <body> & 'more'", true, JSON.stringify(click.data));
      // The toasts whose events are routed below are built and subscribed the same way and held
      // back from the platform, so its own events (a machine that shows no toasts dismisses each
      // at once) cannot arrive between the ones this test delivers.
      native.debugForcePath("toastHeld");
      const firstCookie = cookieOf(show(first), "toast");
      const secondCookie = cookieOf(show(second), "toast");
      const outstanding = cookieOf(show({ id: "outstanding", data: null }), "toast");
      expect(firstCookie).not.toBe(secondCookie);
      expect(native.debugToastsAvailable()).toBe(true);
      expect(displayName(appId)).toBe(identity.appName);
      expect(native.debugPendingToasts()).toBe(3);
      expect(native.debugPendingBalloons()).toBe(0);

      // The handlers WinRT holds post the event; the click arrives only from the loop.
      expect(native.debugSimulateToastEvent(secondCookie, "activated")).toBe(true);
      expect(native.debugSimulateToastEvent(firstCookie, "activated")).toBe(true);
      expect(native.debugSimulateToastEvent(secondCookie, "activated")).toBe(true);
      expect(clicks).toEqual([]);
      pumpUntil(() => clicks.length >= 2);
      expect(clicks).toEqual([second, first]);

      // A failed toast falls back to one balloon; a dismissed one only goes away; neither clicks.
      const failed = cookieOf(show({ id: "failed", data: null }), "toast");
      const dismissed = cookieOf(show({ id: "dismissed", data: null }), "toast");
      native.debugSimulateToastEvent(failed, "failed");
      native.debugSimulateToastEvent(failed, "failed");
      native.debugSimulateToastEvent(dismissed, "dismissed");
      native.debugSimulateToastEvent(failed, "activated");
      native.debugSimulateToastEvent(dismissed, "activated");
      pumpUntil(() => native.debugPendingToasts() === 1 && native.debugBalloonsShown() === 1);
      expect(clicks).toEqual([second, first]);
      // Counted as shown, not as still pending: a shell that shows no balloons hides one at once.
      expect(native.debugBalloonsShown()).toBe(1);
      expect(native.debugPendingBalloons()).toBeLessThanOrEqual(1);
      expect(native.debugPendingToasts()).toBe(1);

      backend.dispose();
      backend.dispose();
      // Disposed: a late event finds nothing, and every handler WinRT held is released.
      expect(native.debugSimulateToastEvent(outstanding, "activated")).toBe(false);
      pump();
      expect(clicks).toEqual([second, first]);
      expect(binding().debugLiveToastHandlers()).toBe(0);
    } finally {
      backend.dispose();
      deleteAppId(appId);
    }
  });

  test("uses the explicit app ID and falls back when WinRT Show fails", async () => {
    const { createNotifier, debugNativeNotifier } = await import("./notifier");
    const appId = `Sweetview.NotifierFallbackTest.${crypto.randomUUID()}`;
    const unused = `Sweetview.Unused.${crypto.randomUUID()}`;
    const identity = defineAppIdentity({ appId: unused, appName: "Sweetview fallback test" });
    const clicks: NotificationClick[] = [];
    const backend = createNotifier({ appId, identity, onClick: (click) => clicks.push(click) });
    const native = debugNativeNotifier(backend)!;
    native.debugSetToastLife(TEST_TOAST_LIFE);
    try {
      expect(backend.notify({ title: "WinRT", silent: true })).toBe(true);
      expect(native.debugToastsAvailable()).toBe(true);
      expect(native.debugPendingToasts()).toBe(1);
      expect(native.debugPendingBalloons()).toBe(0);
      expect(displayName(appId)).toBe("Sweetview fallback test");
      expect(displayName(unused)).toBeNull();

      native.debugForcePath("toastShowFails");
      expect(backend.notify({ title: "Fallback", silent: true, data: [1] })).toBe(true);
      expect(native.debugPendingBalloons()).toBe(1);
      expect(native.debugPendingToasts()).toBe(1); // the failed toast was torn down

      // The click the shell posts for a fallback balloon comes back with its id and data.
      const uid = cookieOf(native.debugShow("balloon-click", "Fallback", "", true, JSON.stringify({ ok: true })), "balloon");
      expect(native.debugSimulateBalloonEvent(uid, "clicked")).toBe(true);
      pumpUntil(() => clicks.length > 0);
      expect(clicks).toEqual([{ id: "balloon-click", data: { ok: true } }]);
      expect(native.debugPendingBalloons()).toBe(1);

      backend.dispose();
      expect(native.debugPendingBalloons()).toBe(0);
      expect(backend.notify({ title: "Disposed" })).toBe(false);
    } finally {
      backend.dispose();
      deleteAppId(appId);
      deleteAppId(unused);
    }
  });

  test("without WinRT every notification is a balloon, with the tray's icon or the stock one", async () => {
    const { createNotifier, debugNativeNotifier } = await import("./notifier");
    const { setNotifierTrayIcon } = await import("./notify-icon");
    const clicks: NotificationClick[] = [];
    const errors: unknown[][] = [];
    const originalError = console.error;
    const backend = createNotifier({ onClick: (click) => clicks.push(click) });
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
      expect(native.debugToastsAvailable()).toBe(false); // WinRT was never tried
      expect(native.debugPendingBalloons()).toBe(2);

      // A value JSON cannot carry comes back unchanged, as today on Windows.
      const raw = () => "not JSON";
      const uid = cookieOf(native.debugShow("plain", "Plain", "", true, null), "balloon");
      expect(native.debugSimulateBalloonEvent(uid, "clicked")).toBe(true);
      pumpUntil(() => clicks.length === 1);
      expect(clicks).toEqual([{ id: "plain", data: undefined }]);
      expect(backend.notify({ title: "Raw", id: "raw", silent: true, data: raw })).toBe(true);
      // Balloon uIDs count up process-wide, so this notification's is the next one.
      expect(native.debugSimulateBalloonEvent(uid + 1, "clicked")).toBe(true);
      pumpUntil(() => clicks.length === 2);
      expect(clicks[1]!.id).toBe("raw");
      expect(clicks[1]!.data).toBe(raw);
      // A balloon that times out reports no click.
      const timeout = cookieOf(native.debugShow("timeout", "Timed out", "", true, null), "balloon");
      native.debugSimulateBalloonEvent(timeout, "timedOut");
      pumpUntil(() => native.debugPendingBalloons() === 2);
      expect(native.debugPendingBalloons()).toBe(2);
      expect(clicks).toHaveLength(2);
    } finally {
      console.error = originalError;
      setNotifierTrayIcon(undefined);
      backend.dispose();
    }
  });

  test("with a real Tray in the process the fallback is still a balloon on the notifier's own icon: its click is the notification's, and the tray's clicks stay the tray's", async () => {
    const { createNotifier, debugNativeNotifier } = await import("./notifier");
    const { createTray, currentTray } = await import("./tray");
    const { postTrayMouse, TRAY } = await import("../../test/win32-os");
    const clicks: NotificationClick[] = [];
    const trayEvents: string[] = [];
    const tray = createTray({
      tooltip: `sweetview-test notifier with a tray ${process.pid}`,
      icon: { windows: { ico: dotIco({ sizes: [16, 32] }) } },
      onDoubleClick: () => trayEvents.push("double"),
    });
    const backend = createNotifier({ onClick: (click) => clicks.push(click) });
    const native = debugNativeNotifier(backend)!;
    native.debugSetToastLife(TEST_TOAST_LIFE);
    try {
      expect(currentTray()).toBe(tray);
      expect(tray.windowHandle()).not.toBe(0n);
      // Both failures, with the tray there: WinRT not in use, and a toast whose Show fails.
      for (const [path, id] of [["balloonOnly", "no-winrt"], ["toastShowFails", "show-failed"]] as const) {
        native.debugForcePath(path);
        const shownBefore = native.debugBalloonsShown();
        const uid = cookieOf(native.debugShow(id, "With a tray", "", true, JSON.stringify({ path })), "balloon");
        // The shell accepted a balloon on the notifier's own icon (the tray's icon has none: its
        // window gets no balloon message, and a click on the balloon is not a click on the tray).
        expect(native.debugBalloonsShown()).toBe(shownBefore + 1);
        expect(native.debugSimulateBalloonEvent(uid, "clicked")).toBe(true);
        pumpUntil(() => clicks.some((c) => c.id === id));
        expect(clicks.at(-1)).toEqual({ id, data: { path } });
        expect(trayEvents).toEqual([]);
      }
      // The tray goes on working beside it: a double click the shell posts to the tray's own
      // window is the tray's, and no notification click.
      const before = clicks.length;
      postTrayMouse(tray.windowHandle(), TRAY.LBUTTONDBLCLK);
      pumpUntil(() => trayEvents.length > 0);
      expect(trayEvents).toEqual(["double"]);
      expect(clicks).toHaveLength(before);
      // And without it: the tray goes, the notifier's icon stays and still shows a balloon.
      tray.dispose();
      expect(currentTray()).toBeUndefined();
      native.debugForcePath("balloonOnly");
      const shownBefore = native.debugBalloonsShown();
      expect(backend.notify({ title: "After the tray", silent: true })).toBe(true);
      expect(native.debugBalloonsShown()).toBe(shownBefore + 1);
    } finally {
      tray.dispose();
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
