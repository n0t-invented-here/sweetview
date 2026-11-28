// Part A rows of `createOverlayWindow`, `makeOverlay`, `Overlay` and `OverlayWindowOptions`, and
// "What changed for every application": what a close request (the frame's X, Alt+F4, both a
// WM_CLOSE to the window) does now, run for real. A `Window` with no `onClose` listener is disposed;
// one made with `onClose: () => win.hide()` is hidden and kept, which is what the window of 0.x
// `createOverlayWindow` did by itself. The same for the window of `createApp`: with no `onClose` the
// close disposes it and `run()` returns (no other window is visible), and with
// `onClose: () => app.window.hide()` it is hidden and its webview lives on. The close request is a
// WM_CLOSE sent or posted to this process's own window; no input is injected. Prints one JSON line.

import { createApp } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { isWindowDisposed } from "../../../packages/sweetview-native/src/internal";
import { WM_CLOSE, isWindow, user32 } from "../../../packages/sweetview-native/test/win32-os";

const report: Record<string, unknown> = {};
const hwndOf = (win: Window) => BigInt(win.handle!);
const sendClose = (win: Window) => user32.SendMessageW(hwndOf(win), WM_CLOSE, 0n, 0n);
const page = { "index.html": new TextEncoder().encode("<!doctype html><title>compat close</title>") };
const bounds = { x: 160, y: 160, width: 360, height: 260 };

// A Window with no onClose listener: the close request disposes it.
const plain = new Window({ title: "sweetview compat close: no listener", bounds, noActivate: true });
const plainHwnd = hwndOf(plain);
plain.show();
sendClose(plain);
report.windowWithoutListener = { disposed: isWindowDisposed(plain), osWindowExists: isWindow(plainHwnd) };

// A Window with onClose: () => win.hide(): hidden and kept, as createOverlayWindow's window was.
const kept: Window = new Window({ title: "sweetview compat close: hides", bounds, noActivate: true, onClose: () => kept.hide() });
kept.show();
sendClose(kept);
report.windowWithHide = { disposed: isWindowDisposed(kept), osWindowExists: isWindow(hwndOf(kept)), visible: kept.isVisible() };
kept.dispose();

// createApp with onClose: () => app.window.hide(): hidden, the webview lives on.
const hiding = await createApp({ title: "sweetview compat close: app hides", bounds, noActivate: true, assets: page, onClose: () => hiding.window.hide() });
hiding.window.show();
sendClose(hiding.window);
report.appWithHide = {
  disposed: isWindowDisposed(hiding.window),
  osWindowExists: isWindow(hwndOf(hiding.window)),
  visible: hiding.window.isVisible(),
  webviewAlive: hiding.webview?.raw.unsafeHandle != null,
};
hiding.dispose();

// createApp with no onClose: the close disposes the window, and run() returns (no window is visible).
const ending = await createApp({ title: "sweetview compat close: app ends", bounds, noActivate: true, assets: page });
ending.window.show();
const endingHwnd = hwndOf(ending.window);
user32.PostMessageW(endingHwnd, WM_CLOSE, 0n, 0n);
ending.run();
report.appWithoutListener = { runReturned: true, disposed: isWindowDisposed(ending.window), osWindowExists: isWindow(endingHwnd) };
ending.dispose();

console.log(JSON.stringify(report));
process.exit(0);
