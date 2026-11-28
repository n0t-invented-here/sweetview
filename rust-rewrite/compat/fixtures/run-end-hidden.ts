// "What changed for every application", the end of `run()`: as `run()` returns, the window is
// hidden before its webview goes, and it stays a window: `isVisible()` is false and it is not in
// `Window.visibleWindows()`. The next webview attached to it that runs shows it again, as does
// `show()`; a window the application hid itself stays hidden through the next `run()`. Each run
// is ended from the page's first call (a `uiMethods` handler), which also reads whether the
// window is on the screen while that run runs. No input is injected. Prints one JSON line.

import { createApp, indexHtml, WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { isWindow, user32 } from "../../../packages/sweetview-native/test/win32-os";

const report: Record<string, unknown> = {};
const assets = {
  "index.html": indexHtml({ title: "compat run end", css: "", head: "", body: "" }),
  "main.js": new Blob([`window.__sweetview_rpc("page.loaded", null);`]),
};
const bounds = { x: 160, y: 160, width: 360, height: 260 };

let whileRunning = false;
const onLoaded = (quit: () => void) => ({
  "page.loaded": () => {
    whileRunning = app.window.isVisible();
    quit();
  },
});

const app = await createApp({ title: "sweetview compat run end", bounds, noActivate: true, assets, uiMethods: onLoaded(() => app.quit()) });
const hwnd = BigInt(app.window.handle as bigint | number);
const state = () => ({ isVisible: app.window.isVisible(), osVisible: user32.IsWindowVisible(hwnd) !== 0, alive: isWindow(hwnd), listed: Window.visibleWindows().includes(app.window) });

app.window.show();
app.run();
report.afterRun = state();

// The next webview that runs in the window shows it again.
const second = await WebView.attach(app.window, { assets, uiMethods: onLoaded(() => second.quit()) });
second.run();
report.secondRun = { whileRunning, after: state() };

// show() brings it back.
app.window.show();
report.afterShow = state();

// A window the application hid itself stays hidden through the next run().
app.window.hide();
whileRunning = true;
const third = await WebView.attach(app.window, { assets, uiMethods: onLoaded(() => third.quit()) });
third.run();
report.ownHide = { whileRunning, after: state() };

console.log(JSON.stringify(report));
process.exit(0);
