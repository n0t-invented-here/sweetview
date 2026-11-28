// The ready signal's reveal (D49) when the page does not answer it as the host asks. In a process
// of its own; no input is injected and the screen is not read.
//
//   bound   the page answers the ready handshake and swallows the drawn request: the window is
//           put on the screen at the reveal's bound all the same, with no readyTimeoutMs set
//           (T1 of D49's second review).
//   route   the application has its own method named `__sweetview.drawn`, and the page calls it:
//           it reaches the application, not the host (T2).
//
// Prints `RESULT <json>`.

import { ptr } from "bun:ffi";
import { createApp, indexHtml } from "@n1h/sweetview";
import { scheduleNativeTimeout } from "../../../sweetview-native/src/event-loop";
import { dwmapi, user32 } from "../../../sweetview-native/test/win32-os";
import { REVEAL_BOUND_MS } from "../../src/app";

const mode = process.argv[2];
const bounds = { x: 160, y: 160, width: 360, height: 260 };
const cloaked = (hwnd: bigint) => {
  const value = new Uint32Array(1);
  dwmapi.DwmGetWindowAttribute(hwnd, 14, ptr(value), 4); // DWMWA_CLOAKED
  return value[0] !== 0;
};

if (mode === "bound" || mode === "toggle") {
  // Sent before the host asks: every drawn request the host makes after the ready signal is dropped.
  const page = `const rpc = window.__sweetview_rpc;
window.__sweetview_rpc = (method, params) => (method === "__sweetview.drawn" ? new Promise(() => {}) : rpc(method, params));
rpc("__sweetview.ready", null);`;
  const app = await createApp({ title: "reveal bound", bounds, noActivate: true, showOnReady: true, assets: { "index.html": indexHtml({ title: "reveal bound" }), "main.js": new Blob([page]) } });
  const hwnd = BigInt(app.window.handle as bigint | number);
  const seen: { at: string; visible: boolean; cloaked: boolean }[] = [];
  scheduleNativeTimeout(REVEAL_BOUND_MS / 2, () => {
    seen.push({ at: "before the bound", visible: user32.IsWindowVisible(hwnd) !== 0, cloaked: cloaked(hwnd) });
    // A cloaked window is not on the screen: toggle() puts it there, it does not hide it (T6).
    if (mode === "toggle") {
      app.window.toggle();
      seen.push({ at: "toggled", visible: user32.IsWindowVisible(hwnd) !== 0, cloaked: cloaked(hwnd) });
    }
  });
  scheduleNativeTimeout(REVEAL_BOUND_MS + 1_000, () => {
    seen.push({ at: "after the bound", visible: user32.IsWindowVisible(hwnd) !== 0, cloaked: cloaked(hwnd) });
    app.quit();
  });
  app.run();
  console.log(`RESULT ${JSON.stringify({ seen })}`);
} else if (mode === "route") {
  const routed: unknown[] = [];
  let answer: unknown = "none";
  const page = `window.__sweetview_rpc("__sweetview.drawn", "mine").then((value) => window.__sweetview_rpc("report", value));`;
  const app = await createApp({
    title: "reveal route",
    bounds,
    noActivate: true,
    assets: { "index.html": indexHtml({ title: "reveal route" }), "main.js": new Blob([page]) },
    uiMethods: {
      "__sweetview.drawn": (params: unknown) => (routed.push(params), "the application's"),
      report: (value: unknown) => {
        answer = value;
        app.quit();
      },
    },
  });
  scheduleNativeTimeout(10_000, () => app.quit());
  app.run();
  console.log(`RESULT ${JSON.stringify({ routed, answer })}`);
} else {
  throw new Error(`reveal-handshake: unknown mode ${mode}`);
}
process.exit(0);
