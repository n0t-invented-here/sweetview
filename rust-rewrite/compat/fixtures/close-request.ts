// Part A rows of `createOverlayWindow`, `makeOverlay`, `Overlay` and `OverlayWindowOptions`, and
// "What changed for every application": what a close request (the frame's X, Alt+F4, both a
// WM_CLOSE to the window) does in 1.0, run for real. A `Window` with no `onClose` listener is
// disposed. A tray application declares close-to-tray with `closeToTrayOnLastWindow(win, onHide)`:
// the last visible window is hidden and kept, `onHide` told, and any other is disposed. The same for
// the window of `createApp`: with no listener the close disposes it and `run()` returns (no other
// window is visible), and declared close-to-tray it is hidden and its webview lives on. The close
// request is a WM_CLOSE sent or posted to this process's own window; no input is injected. Prints
// one JSON line.

import { createApp } from "@n1h/sweetview";
import { Window, closeToTrayOnLastWindow } from "@n1h/sweetview/native";
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

// Close-to-tray declared: the last visible window is hidden and kept, and onHide is told.
const hidden: Window[] = [];
const last = new Window({ title: "sweetview compat close: to the tray", bounds, noActivate: true });
closeToTrayOnLastWindow(last, (win) => hidden.push(win));
last.show();
sendClose(last);
report.closeToTrayLastWindow = { disposed: isWindowDisposed(last), osWindowExists: isWindow(hwndOf(last)), visible: last.isVisible(), onHideTold: hidden.length === 1 && hidden[0] === last };

// Close-to-tray declared, another window still visible: this one is closed as usual.
const other = new Window({ title: "sweetview compat close: still visible", bounds, noActivate: true });
const second = new Window({ title: "sweetview compat close: not the last", bounds, noActivate: true });
closeToTrayOnLastWindow(second, (win) => hidden.push(win));
other.show();
second.show();
const secondHwnd = hwndOf(second);
sendClose(second);
report.closeToTrayAnotherVisible = { disposed: isWindowDisposed(second), osWindowExists: isWindow(secondHwnd), onHideTold: hidden.includes(second) };
other.dispose();
last.dispose();

// createApp declared close-to-tray: hidden, the webview lives on.
const tray = await createApp({ title: "sweetview compat close: app to the tray", bounds, noActivate: true, assets: page });
closeToTrayOnLastWindow(tray.window);
tray.window.show();
sendClose(tray.window);
report.appCloseToTray = {
  disposed: isWindowDisposed(tray.window),
  osWindowExists: isWindow(hwndOf(tray.window)),
  visible: tray.window.isVisible(),
  webviewAlive: tray.webview?.raw.unsafeHandle != null,
};
tray.dispose();

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
