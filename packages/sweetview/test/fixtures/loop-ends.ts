// The pumped loop holds the process only while the application has something
// a person can reach (decision D46). An application in a process of its own
// runs runEventLoop() and then, by SWEETVIEW_LOOP_TEST:
//
//   failed-tab      createApp({ tabs: true }); its first openTab fails (a bad option) and the error
//                   is caught; nothing else: the loop must end by itself and the process with exit code 3
//   failed-app      createApp fails (a bad option) and the error is caught: the same
//   last-window     a window shown, then disposed, with nothing else: the same
//   hidden-window   a window never shown, with no webview, and nothing else, the application
//                   having had nothing yet: it must keep running (the loop may start first)
//   tray            a hidden window and a tray icon: it must keep running
//   visible         a visible window: it must keep running
//   hidden-after    a window shown, then hidden (to a tray that is not there): it must keep running
//   webview         a hidden window with a webview: it must keep running
//
// The ones that must keep running print `STILL` from an unref'd Bun timer
// after 2 s (a process held by nothing else would have ended before it) and
// then quit their loop. Its own `exit` listener prints `RESULT <json>` with the
// window's state after Sweetview's release. It injects no input. The parent is
// src/loop-ends.test.ts.

import { createApp, indexHtml, quitEventLoop, runEventLoop, WebView } from "@n1h/sweetview";
import { createTray, Window } from "@n1h/sweetview/native";
import { isWindow } from "../../../sweetview-native/test/win32-os";

const mode = process.env.SWEETVIEW_LOOP_TEST ?? "failed-tab";
const loop = runEventLoop({ intervalMs: 5 });
const bounds = { x: 160, y: 140, width: 360, height: 240 };
let watched = 0n;
const watch = (win: Window) => {
  watched = BigInt(win.handle as bigint | number);
  // Registered after Sweetview's own `exit` listener, which the window's creation added.
  process.on("exit", (code) => console.log("RESULT " + JSON.stringify({ mode, code, windowExists: isWindow(watched) })));
};
const keepsRunning = () => {
  setTimeout(() => {
    console.log("STILL");
    quitEventLoop();
  }, 2000).unref();
};

try {
  if (mode === "failed-tab") {
    const app = await createApp({ title: "loop-ends", tabs: true, bounds, noActivate: true });
    watch(app.window);
    // onRequest "worker" with no worker: openTab throws once the tabbed window is set up.
    await app.openTab({ assets: { "index.html": indexHtml({ title: "t", css: "" }) }, onRequest: "worker" });
  } else if (mode === "failed-app") {
    await createApp({ title: "loop-ends", bounds, noActivate: true, onRequest: "worker" });
  } else if (mode === "last-window") {
    const win = new Window({ title: "loop-ends", bounds, noActivate: true });
    watch(win);
    win.show();
    await Bun.sleep(100);
    process.exitCode = 3;
    win.dispose();
  } else if (mode === "hidden-window") {
    watch(new Window({ title: "loop-ends", bounds, noActivate: true }));
    keepsRunning();
  } else if (mode === "tray") {
    watch(new Window({ title: "loop-ends", bounds, noActivate: true }));
    createTray({ tooltip: "sweetview loop-ends fixture", menu: () => [{ label: "Quit", click: quitEventLoop }] });
    keepsRunning();
  } else if (mode === "visible") {
    const win = new Window({ title: "loop-ends", bounds, noActivate: true });
    watch(win);
    win.show();
    keepsRunning();
  } else if (mode === "hidden-after") {
    const win = new Window({ title: "loop-ends", bounds, noActivate: true });
    watch(win);
    win.show();
    await Bun.sleep(100);
    win.hide();
    keepsRunning();
  } else if (mode === "webview") {
    const win = new Window({ title: "loop-ends", bounds, noActivate: true });
    watch(win);
    await WebView.attach(win, { assets: { "index.html": indexHtml({ title: "t", css: "" }) } });
    keepsRunning();
  }
} catch (err) {
  // What native-tabs does when its start fails: say so and set the exit code, nothing more.
  console.log(`CAUGHT ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 3;
}
await loop;
console.log("LOOP-RESOLVED");
