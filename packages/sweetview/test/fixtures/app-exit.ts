// An application in a process of its own whose script has nothing after its
// loop: no dispose(), no process.exit(). It makes what an application makes (a
// createApp window with a worker, a second window with its own webview, a
// tray, a notifier showing a toast, a notifier the binding made with a
// balloon on its hidden icon, a single-instance lock, a mouse hook) and ends
// one of these ways, by SWEETVIEW_EXIT_TEST:
//
//   blocking     app.quit() from inside the blocking app.run()
//   pumped       quitEventLoop() under runEventLoop(), and the script ends
//   throw        the script throws, before any loop has run
//   exit         process.exit(7) from inside the blocking app.run()
//   exit-pumped  process.exit(7) from a Bun timer under runEventLoop()
//   disposed     everything but the app disposed by hand, then app.quit()
//
// The toast is shown under SWEETVIEW_EXIT_APP_ID, with no banner (the
// notifier's test life), in the same callback that ends the loop, so it is
// still pending when the process ends; the parent reads the notification
// centre afterwards. Its own `exit` listener, registered after Sweetview's,
// reads back from the OS what Sweetview left while the process still lives
// (Explorer drops a dead process's icons by itself, so after the exit it
// would see nothing either way) and prints `RESULT <json>`. It injects no
// input. The parent is src/app-exit.test.ts.

import { createApp, indexHtml, quitEventLoop, runEventLoop, singleInstance, WebView } from "@n1h/sweetview";
import { createNotifier, createTray, installMouseHook, Window } from "@n1h/sweetview/native";
import { binding } from "../../../sweetview-native/src/binding";
import { scheduleNativeTimeout } from "../../../sweetview-native/src/event-loop";
import { notifierBackend } from "../../../sweetview-native/src/notifications";
import { createNotifier as notifierOfTheBinding, debugNativeNotifier } from "../../../sweetview-native/src/win32/notifier";
import { currentTray } from "../../../sweetview-native/src/win32/tray";
import { isWindow, ownMessageWindows, shellHoldsIcon } from "../../../sweetview-native/test/win32-os";

const mode = process.env.SWEETVIEW_EXIT_TEST ?? "blocking";
const appId = process.env.SWEETVIEW_EXIT_APP_ID ?? `Sweetview.AppExitTest.${process.pid}`;
const pumped = mode === "pumped" || mode === "exit-pumped";
const page = (title: string) => ({ "index.html": indexHtml({ title, css: "", body: `<p>${title}</p>` }), "main.js": new Blob([""]) });

const lock = await singleInstance({ appId });
const app = await createApp({
  title: "app-exit",
  bounds: { x: 120, y: 120, width: 480, height: 320 },
  noActivate: true,
  assets: page("app-exit"),
  worker: new URL("./app-exit.worker.ts", import.meta.url),
});
const second = new Window({ title: "app-exit second", bounds: { x: 640, y: 120, width: 320, height: 240 }, noActivate: true });
await WebView.attach(second, { assets: page("second") });
const tray = createTray({ tooltip: "sweetview app-exit fixture", menu: () => [{ label: "Quit", click: () => app.quit() }] });
const notifier = createNotifier({ appId });
// The test's toast goes to the notification centre with no banner, and leaves it by itself later.
const toasts = debugNativeNotifier(notifierBackend(notifier)!)!;
toasts.debugSetToastLife(120);
// A notifier the binding made with no TypeScript wrapper, showing a balloon on its hidden icon:
// what the binding's own release must remove.
const balloons = notifierOfTheBinding();
const debug = debugNativeNotifier(balloons)!;
debug.debugForcePath("balloonOnly");
const shown = debug.debugShow("app-exit", "Sweetview test", "app-exit fixture", true, null) ?? "";
const hook = installMouseHook(() => false);

const trayWindow = currentTray()!.windowHandle();
// tray-icon numbers its icons itself; the shell holds this one under one small id.
const trayUid = [1, 2, 3, 4, 5, 6, 7, 8].find((uid) => shellHoldsIcon(trayWindow, uid)) ?? -1;
const balloonUid = Number(shown.split(":")[1] ?? -1);
const notifierWindow = ownMessageWindows("SweetviewNotifierWindow").find((hwnd) => shellHoldsIcon(hwnd, balloonUid)) ?? 0n;
const appWindow = BigInt(app.window.handle ?? 0);
const secondWindow = BigInt(second.handle ?? 0);
const before = {
  trayUid,
  trayHeld: shellHoldsIcon(trayWindow, trayUid),
  balloonHeld: shellHoldsIcon(notifierWindow, balloonUid),
  notifierWindows: ownMessageWindows("SweetviewNotifierWindow").length,
  lockWindows: ownMessageWindows("SweetviewSingleInstanceWindow").length,
  primary: lock.isPrimary,
  windows: isWindow(appWindow) && isWindow(secondWindow),
};
// The toast still waiting for its first event when the loop ended: what the end must leave alone.
let toastPendingAtQuit: number | null = null;

process.on("exit", (code) => {
  const after = {
    trayHeld: shellHoldsIcon(trayWindow, trayUid),
    trayWindow: isWindow(trayWindow),
    balloonHeld: shellHoldsIcon(notifierWindow, balloonUid),
    notifierWindows: ownMessageWindows("SweetviewNotifierWindow").length,
    lockWindows: ownMessageWindows("SweetviewSingleInstanceWindow").length,
    windows: [isWindow(appWindow), isWindow(secondWindow)],
    // 0 when a hook was still installed (and is removed by this call), 2 when none was.
    mouseHookRemove: binding().removeMouseHook(),
  };
  console.log("RESULT " + JSON.stringify({ mode, code, before, toastPendingAtQuit, after }));
});

/** Shows the toast and ends the loop `how`, in one callback: the toast is still pending at the end. */
const quitting = (how: () => void) => () => {
  notifier.notify({ id: "app-exit", title: "Sweetview test", body: "app-exit fixture: shown at Quit", silent: true });
  toastPendingAtQuit = toasts.debugPendingToasts();
  if (mode === "disposed") {
    hook.dispose();
    tray.dispose();
    notifier.dispose();
    balloons.dispose();
    second.dispose();
    lock.dispose();
  }
  console.log("QUIT");
  how();
};

if (mode === "throw") {
  console.log("QUIT");
  throw new Error("app-exit: the script threw");
}
app.window.show();
if (pumped) {
  setTimeout(quitting(mode === "pumped" ? quitEventLoop : () => process.exit(7)), 1500);
  await runEventLoop();
} else {
  scheduleNativeTimeout(1500, quitting(mode === "exit" ? () => process.exit(7) : () => app.quit()));
  app.run();
}
