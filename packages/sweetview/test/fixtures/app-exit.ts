// An application in a process of its own whose script has nothing after its
// loop: no dispose(), no process.exit(). It makes what an application makes (a
// createApp window with a worker, a second window with its own webview, a
// tray, a notifier, a notifier the binding made with a balloon on its hidden
// icon, a mouse hook) and ends one of these ways, by SWEETVIEW_EXIT_TEST:
//
//   blocking     app.quit() from inside the blocking app.run()
//   pumped       quitEventLoop() under runEventLoop(), and the script ends
//   throw        the script throws, before any loop has run
//   exit         process.exit(7) from inside the blocking app.run()
//   exit-pumped  process.exit(7) from a Bun timer under runEventLoop()
//
// Its own `exit` listener, registered after Sweetview's, reads back from the
// OS what Sweetview left while the process still lives (Explorer drops a dead
// process's icons by itself, so after the exit it would see nothing either
// way) and prints `RESULT <json>`. It injects no input. The parent
// (src/app-exit.test.ts) checks the exit code, the time and stderr.

import { createApp, indexHtml, quitEventLoop, runEventLoop, WebView } from "@n1h/sweetview";
import { createNotifier, createTray, installMouseHook, Window } from "@n1h/sweetview/native";
import { binding } from "../../../sweetview-native/src/binding";
import { scheduleNativeTimeout } from "../../../sweetview-native/src/event-loop";
import { createNotifier as notifierOfTheBinding, debugNativeNotifier } from "../../../sweetview-native/src/win32/notifier";
import { currentTray } from "../../../sweetview-native/src/win32/tray";
import { isWindow, ownMessageWindows, shellHoldsIcon } from "../../../sweetview-native/test/win32-os";

const mode = process.env.SWEETVIEW_EXIT_TEST ?? "blocking";
const pumped = mode === "pumped" || mode === "exit-pumped";
const page = (title: string) => ({ "index.html": indexHtml({ title, css: "", body: `<p>${title}</p>` }), "main.js": new Blob([""]) });

const app = await createApp({
  title: "app-exit",
  bounds: { x: 120, y: 120, width: 480, height: 320 },
  noActivate: true,
  assets: page("app-exit"),
  worker: new URL("./app-exit.worker.ts", import.meta.url),
});
const second = new Window({ title: "app-exit second", bounds: { x: 640, y: 120, width: 320, height: 240 }, noActivate: true });
await WebView.attach(second, { assets: page("second") });
createTray({ tooltip: "sweetview app-exit fixture", menu: () => [{ label: "Quit", click: () => app.quit() }] });
createNotifier();
// A notifier the binding made with no TypeScript wrapper, showing a balloon on its hidden icon:
// what the binding's own release must remove.
const balloons = notifierOfTheBinding();
const debug = debugNativeNotifier(balloons)!;
debug.debugForcePath("balloonOnly");
const shown = debug.debugShow("app-exit", "Sweetview test", "app-exit fixture", true, null) ?? "";
installMouseHook(() => false);

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
  windows: isWindow(appWindow) && isWindow(secondWindow),
};

process.on("exit", (code) => {
  const after = {
    trayHeld: shellHoldsIcon(trayWindow, trayUid),
    trayWindow: isWindow(trayWindow),
    balloonHeld: shellHoldsIcon(notifierWindow, balloonUid),
    notifierWindows: ownMessageWindows("SweetviewNotifierWindow").length,
    windows: [isWindow(appWindow), isWindow(secondWindow)],
    // 0 when a hook was still installed (and is removed by this call), 2 when none was.
    mouseHookRemove: binding().removeMouseHook(),
  };
  console.log("RESULT " + JSON.stringify({ mode, code, before, after }));
});

const quitting = (how: () => void) => () => {
  console.log("QUIT");
  how();
};

if (mode === "throw") {
  console.log("QUIT");
  throw new Error("app-exit: the script threw");
}
if (pumped) {
  app.window.show();
  setTimeout(quitting(mode === "pumped" ? quitEventLoop : () => process.exit(7)), 1500);
  await runEventLoop();
} else {
  app.window.show();
  scheduleNativeTimeout(1500, quitting(mode === "blocking" ? () => app.quit() : () => process.exit(7)));
  app.run();
}
