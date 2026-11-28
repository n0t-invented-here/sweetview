// An application that runs more than one loop in its process: nothing it made
// is taken from it while the process runs (decision D36). By SWEETVIEW_LOOPS_TEST:
//
//   nested    under runEventLoop() a tray, a notifier with a balloon and a
//             window with a webview; from a Bun timer, a createApp app runs a
//             blocking run() and quits from inside; the outer objects are read
//             back after it returned, then the pumped loop ends.
//   two-runs  a tray, a notifier with a balloon and a single-instance lock,
//             then a first createApp app runs and quits, then a second one
//             runs. During the second run() it writes `SECOND_RUN` and waits
//             for the parent to start a second instance with the same app id,
//             whose launch its lock must turn away and hand over.
//
// It prints `RESULT <json>` with what it read back, from its own `exit`
// listener, which runs after Sweetview's release. It injects no input; the
// parent is src/app-exit.test.ts.

import { writeSync } from "node:fs";
import { createApp, indexHtml, quitEventLoop, runEventLoop, singleInstance, WebView, type SecondInstanceEvent } from "@n1h/sweetview";
import { createTray, Window } from "@n1h/sweetview/native";
import { scheduleNativeTimeout } from "../../../sweetview-native/src/event-loop";
import { createNotifier as notifierOfTheBinding, debugNativeNotifier } from "../../../sweetview-native/src/win32/notifier";
import { currentTray } from "../../../sweetview-native/src/win32/tray";
import { isWindow, ownMessageWindows, shellHoldsIcon } from "../../../sweetview-native/test/win32-os";

const mode = process.env.SWEETVIEW_LOOPS_TEST ?? "nested";
const appId = process.env.SWEETVIEW_LOOPS_APP_ID ?? `Sweetview.AppLoopsTest.${process.pid}`;
const page = (title: string) => ({ "index.html": indexHtml({ title, css: "", body: `<p>${title}</p>` }), "main.js": new Blob([""]) });
const quiet = { bounds: { x: 120, y: 120, width: 400, height: 280 }, noActivate: true } as const;
const report: Record<string, unknown> = { mode };

createTray({ tooltip: "sweetview app-loops fixture" });
const clicked = new Set<string>();
const balloons = notifierOfTheBinding({ onClick: (click) => void clicked.add(click.id) });
const debug = debugNativeNotifier(balloons)!;
debug.debugForcePath("balloonOnly");
const balloonUid = Number((debug.debugShow("app-loops", "Sweetview test", "app-loops fixture", true, null) ?? "").split(":")[1] ?? -1);
const trayWindow = currentTray()!.windowHandle();
const trayUid = [1, 2, 3, 4, 5, 6, 7, 8].find((uid) => shellHoldsIcon(trayWindow, uid)) ?? -1;
// The notifier's own window, found by its class: not through the shell, which may already have
// ended the balloon (another notification, quiet hours, a full-screen application in front: D20).
const notifierWindow = ownMessageWindows("SweetviewNotifierWindow")[0] ?? 0n;

/** What the application made before its blocking run(), read back from the OS and the binding. */
const outer = () => ({
  trayHeld: shellHoldsIcon(trayWindow, trayUid),
  trayWindow: isWindow(trayWindow),
  notifierWindow: isWindow(notifierWindow),
  // A notifier that is still alive keeps showing: a second balloon is accepted.
  notifierShows: debug.debugShow("app-loops-2", "Sweetview test", "app-loops fixture, again", true, null)?.startsWith("balloon:") ?? false,
  lockWindows: ownMessageWindows("SweetviewSingleInstanceWindow").length,
});

let round = 0;
/**
 * Whether the notifier still works, by what it reports itself, whatever the shell did with its
 * balloons: a new balloon is accepted, and its click, posted to the notifier's window as the
 * shell posts it, comes back to the notifier's onClick from the loop. Answers from a native
 * timeout, which either loop runs.
 */
const notifierAnswers = (done: (answers: boolean) => void) => {
  const id = `app-loops-click-${++round}`;
  const shown = debug.debugShow(id, "Sweetview test", "app-loops fixture, a click", true, null);
  const uid = shown?.startsWith("balloon:") ? Number(shown.slice("balloon:".length)) : -1;
  if (uid < 0 || !debug.debugSimulateBalloonEvent(uid, "clicked")) return done(false);
  const deadline = Date.now() + 3000;
  const check = () => {
    if (clicked.has(id) || Date.now() > deadline) done(clicked.has(id));
    else scheduleNativeTimeout(20, check);
  };
  scheduleNativeTimeout(20, check);
};

process.on("exit", () => {
  // At the end the released notifier's balloon icon is gone too, whatever the shell did before.
  report.atExit = { ...outer(), balloonHeld: shellHoldsIcon(notifierWindow, balloonUid) };
  console.log("RESULT " + JSON.stringify(report));
});

if (mode === "nested") {
  const win = new Window({ ...quiet, title: "app-loops outer" });
  const view = await WebView.attach(win, { assets: page("outer") });
  win.show();
  setTimeout(async () => {
    const inner = await createApp({ ...quiet, title: "app-loops inner", assets: page("inner") });
    const innerWindow = BigInt(inner.window.handle ?? 0);
    inner.window.show();
    scheduleNativeTimeout(800, () => inner.quit());
    inner.run();
    const after = {
      ...outer(),
      outerWindow: isWindow(BigInt(win.handle ?? 0)),
      outerWebview: view.raw.unsafeHandle !== null,
      // The inner app's own run() still tears its own webview down when it returns, as always.
      innerWebview: inner.webview!.raw.unsafeHandle !== null,
      innerWindow: isWindow(innerWindow),
    };
    notifierAnswers((answers) => {
      report.afterInnerRun = { ...after, notifierAnswers: answers };
      quitEventLoop();
    });
  }, 1000);
  await runEventLoop();
} else {
  let seconds: SecondInstanceEvent[] = [];
  const lock = await singleInstance({ appId, onSecondInstance: (event) => seconds.push(event) });
  report.primary = lock.isPrimary;
  const first = await createApp({ ...quiet, title: "app-loops first", assets: page("first") });
  first.window.show();
  scheduleNativeTimeout(800, () => first.quit());
  first.run();
  const afterFirst = outer();
  report.afterFirstRun = afterFirst;
  // Its answer comes from the second run's loop, which runs the native timeouts.
  notifierAnswers((answers) => void (report.afterFirstRun = { ...afterFirst, notifierAnswers: answers }));
  const next = await createApp({ ...quiet, title: "app-loops second", assets: page("second") });
  next.window.show();
  const started = Date.now();
  const wait = () => {
    if (seconds.length > 0 || Date.now() - started > 20_000) {
      const during = { ...outer(), secondInstances: seconds.map((event) => event.args.at(-1)) };
      notifierAnswers((answers) => {
        report.duringSecondRun = { ...during, notifierAnswers: answers };
        next.quit();
      });
      return;
    }
    scheduleNativeTimeout(50, wait);
  };
  scheduleNativeTimeout(50, () => {
    // Written straight to the pipe: Bun's own stdout waits for its loop, which run() holds.
    writeSync(1, "SECOND_RUN\n");
    wait();
  });
  next.run();
  seconds = [];
}
