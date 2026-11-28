// What a person sees of a window on its way out (decision D49): an
// application in a process of its own shows a framed window with a dark page
// (revealed on ready, topmost so the screen shows it), and then, by
// SWEETVIEW_FLASH_TEST:
//
//   blocking        app.quit() from inside the blocking app.run(), with a worker; nothing after run()
//   pumped          quitEventLoop() under runEventLoop(); the script ends
//   dispose         app.dispose() from inside the blocking app.run()
//   window-dispose  app.window.dispose() from inside the blocking app.run()
//   replace         under runEventLoop: the webview disposed, the window left showing for a moment,
//                   a new webview attached to it, then quitEventLoop()
//   run-twice       a blocking app.run() quit, a second webview attached to the same window and run, quit
//   tab-close       a tabbed window (appearance dark) whose last tab is disposed while an onClose
//                   listener keeps the window, left showing for a moment, then quitEventLoop()
//
// It prints `READY <hwnd>` when the page is ready, `EMPTY` when the window is
// left without its page on purpose, and `QUIT` when it ends its loop. A second
// process (window-watch.ts, started by src/quit-flash.test.ts) samples the
// screen. Its own `exit` listener, registered after Sweetview's, prints
// `RESULT <json>` with whether the window still exists then. It injects no
// input.

import { createApp, indexHtml, quitEventLoop, runEventLoop, WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { scheduleNativeTimeout } from "../../../sweetview-native/src/event-loop";
import { disableTransitions, isWindow } from "../../../sweetview-native/test/win32-os";

const mode = process.env.SWEETVIEW_FLASH_TEST ?? "blocking";
// With SWEETVIEW_FLASH_GO set, nothing is made before the parent says the watcher is watching.
if (process.env.SWEETVIEW_FLASH_GO === "1") {
  const reader = Bun.stdin.stream().getReader();
  await reader.read();
  reader.releaseLock();
}
/** The page's colour: dark, and not the backdrop's (#15161a), so the two can be told apart. */
export const PAGE = "#1f2a33";
const bounds = { x: 160, y: 140, width: 640, height: 420 };
const options = (onReady: () => void) => ({
  assets: {
    "index.html": indexHtml({ title: "quit-flash", css: "", head: `<style>html,body{background:${PAGE};margin:0;height:100%}</style>`, body: `<p style="color:#8899aa;margin:0;padding:8px">quit-flash</p>` }),
    // Ready at once; the time of the page's first animation frame is logged, for the timeline.
    "main.js": new Blob([`window.__sweetview_rpc("__sweetview.ready", null); requestAnimationFrame(() => window.__sweetview_rpc("paint.at", Date.now()));`]),
  },
  showOnReady: true,
  readyTimeoutMs: 10_000,
  onReady: () => {
    console.log(`T ready ${Date.now()}`);
    onReady();
  },
  uiMethods: { "paint.at": (at: unknown) => void console.log(`T first-frame ${at}`) },
});
const windowOptions = { title: "quit-flash", bounds, topmost: true, noActivate: true, appearance: "dark" as const };

let watched = 0n;
/**
 * DWM's transitions off for the fixture's window, before it is shown: every frame the watcher
 * reads is then the window's own pixels or the backstop behind it, never a fade between them.
 * What the window paints is unchanged; only DWM's animation of its appearing and going is.
 */
const noFade = (win: Window) => {
  if (!disableTransitions(BigInt(win.handle as bigint | number))) throw new Error("quit-flash: DWM refused to turn the window's transitions off");
};
const ready = (hwnd: unknown) => {
  if (watched === 0n) {
    // Registered after the window was made, so after Sweetview's own `exit` listener: it reads
    // what Sweetview's release left.
    process.on("exit", (code) => {
      console.log("RESULT " + JSON.stringify({ mode, code, windowExists: isWindow(watched) }));
    });
  }
  watched = BigInt(hwnd as bigint | number);
  console.log(`READY ${watched}`);
};

if (mode === "blocking" || mode === "dispose" || mode === "window-dispose" || mode === "run-twice" || mode === "run-twice-own-hide") {
  const app = await createApp({
    ...windowOptions,
    ...options(() => {
      ready(app.window.handle);
      scheduleNativeTimeout(1200, () => {
        console.log("QUIT");
        if (mode === "dispose") app.dispose();
        else if (mode === "window-dispose") app.window.dispose();
        else app.quit();
      });
    }),
    worker: mode === "blocking" ? new URL("./app-exit.worker.ts", import.meta.url) : undefined,
  });
  noFade(app.window);
  app.run();
  if (mode === "run-twice" || mode === "run-twice-own-hide") {
    // Right after the first run() returned: hidden, still a window, and not listed as visible.
    const handle = BigInt(app.window.handle as bigint | number);
    console.log(`AFTER-FIRST ${JSON.stringify({ visible: app.window.isVisible(), alive: isWindow(handle), listed: Window.visibleWindows().includes(app.window) })}`);
    // The application's own hide() stands: the second run() does not show the window again.
    if (mode === "run-twice-own-hide") app.window.hide();
    // A view with no showOnReady: only the restore at the start of run() shows the window.
    const { showOnReady: _none, ...noReveal } = options(() => {
      console.log(`SECOND ${JSON.stringify({ visible: app.window.isVisible() })}`);
      console.log("READY-AGAIN");
      scheduleNativeTimeout(1200, () => {
        console.log("QUIT");
        again.quit();
      });
    });
    const again = await WebView.attach(app.window, noReveal);
    again.run();
  }
} else if (mode === "pumped" || mode === "replace") {
  const loop = runEventLoop({ intervalMs: 5 });
  const win = new Window(windowOptions);
  noFade(win);
  let first!: () => void;
  const firstReady = new Promise<void>((resolve) => (first = resolve));
  const view = await WebView.attach(win, options(first));
  await firstReady;
  ready(win.handle);
  await Bun.sleep(1200);
  if (mode === "replace") {
    view.dispose();
    console.log("EMPTY");
    await Bun.sleep(800);
    let second!: () => void;
    const secondReady = new Promise<void>((resolve) => (second = resolve));
    await WebView.attach(win, options(second));
    await secondReady;
    await Bun.sleep(800);
  }
  console.log("QUIT");
  quitEventLoop();
  await loop;
} else if (mode === "tab-close") {
  const loop = runEventLoop({ intervalMs: 5 });
  const win = new Window({ ...windowOptions, tabs: true, onClose: () => {} });
  noFade(win);
  let first!: () => void;
  const firstReady = new Promise<void>((resolve) => (first = resolve));
  console.log(`T open-start ${Date.now()}`);
  const tab = await WebView.openTab(win, options(first));
  console.log(`T open-done ${Date.now()}`);
  await firstReady;
  ready(win.handle);
  await Bun.sleep(1200);
  // The last tab goes; the window's onClose listener keeps the window, which shows its backdrop.
  tab.dispose();
  console.log("EMPTY");
  await Bun.sleep(1000);
  console.log("QUIT");
  quitEventLoop();
  await loop;
} else {
  throw new Error(`quit-flash: unknown mode ${mode}`);
}
