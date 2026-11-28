// Part A rows that changed behaviour, run for real: an overlay made the new
// way (`createApp` with the window options that `createOverlayWindow` and
// `makeOverlay` used to imply), its `Window` (what `NativeWindow` and `Overlay`
// were), `Window.fromHandle` (what `nativeWindow` was) with `onClose` (what
// `onCloseRequest` was), the `Screen` questions an `Overlay` answered,
// `HitRelay` as a class, and a frameless window's reported frame. Also the
// UI-thread check: `Clipboard` from a `Worker` throws. Prints one JSON line.

import { createApp } from "@n1h/sweetview";
import { HitRelay, Screen, Window, createHitRelay } from "@n1h/sweetview/native";
import { getWindowMeta } from "../../../packages/sweetview-native/src/internal";

const report: Record<string, unknown> = {};
const bounds = { x: 120, y: 120, width: 320, height: 240 };
const app = await createApp({
  title: "sweetview compat overlay",
  bounds,
  frame: false,
  transparent: true,
  topmost: true,
  hideFromTaskbar: true,
  noActivate: true,
  assets: { "index.html": new TextEncoder().encode("<!doctype html><title>compat</title><body style='background:transparent'></body>") },
});

report.windowIsWindow = app.window instanceof Window;
report.windowHandleType = typeof app.window.handle;
report.rawHandleType = typeof app.webview?.raw.unsafeHandle;
report.notify = typeof app.notify;
report.boundsKept = JSON.stringify(app.window.bounds()) === JSON.stringify(bounds);
report.isMaximized = app.window.isMaximized();
report.scalePositive = app.window.scale() > 0;

// nativeWindow(handle) -> Window.fromHandle(handle); onCloseRequest -> onClose.
const wrapped = Window.fromHandle(app.window.handle);
report.wrappedFrame = getWindowMeta(wrapped).frame;
const unsubscribe = wrapped.onClose(() => {});
report.onCloseReturns = typeof unsubscribe;
unsubscribe();
wrapped.dispose();

// Overlay.cursor(), screen(), screenAt(), workArea(), virtualScreen() -> Screen.
const rect = (r: { x: number; y: number; width: number; height: number }) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
const cursor = Screen.cursor();
report.screen = {
  cursor: Number.isFinite(cursor.x) && Number.isFinite(cursor.y),
  primary: rect(Screen.primary().bounds),
  workArea: rect(Screen.primary().workArea),
  at: rect(Screen.at(cursor).bounds),
  virtual: rect(Screen.bounds()),
  of: Screen.of(app.window).scale > 0,
};

// HitRelay is a class; enabled() is isEnabled(); createHitRelay takes the Window.
const relay = createHitRelay(app.window, () => {});
relay.setRegions([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]]);
relay.setEnabled(false);
report.hitRelay = { isClass: relay instanceof HitRelay, isEnabled: relay.isEnabled() };

// Clipboard from a Worker throws the UI-thread error.
const worker = new Worker(new URL("./clipboard-worker.ts", import.meta.url).href);
report.workerClipboard = await new Promise<string>((resolve) => {
  worker.onmessage = (event) => resolve(String(event.data));
  worker.onerror = (event) => resolve(`worker failed: ${event.message}`);
});
worker.terminate();

app.dispose();
console.log(JSON.stringify(report));
process.exit(0);
