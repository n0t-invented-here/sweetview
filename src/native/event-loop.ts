// The OS event loop for an app with no webview window: a menu-bar or tray app,
// an overlay with no page. `createWebviewApp(...).run()` blocks the UI thread
// inside the OS loop, and Bun's event loop with it, which is why a windowed
// app keeps its logic in a worker. These run the OS loop the other way round,
// from a Bun timer that drains pending OS events each tick, so the UI thread
// keeps Bun's event loop and `setTimeout`, promises and I/O work on it.

import { backend } from "./platform";

/** macOS NSApplicationActivationPolicy: `regular` has a Dock tile and app menu, `accessory` has neither but can show windows and menus, `prohibited` cannot show anything. */
export type ActivationPolicy = "regular" | "accessory" | "prohibited";

export type EventLoopOptions = {
  /** How often pending OS events are drained, in milliseconds. Default 16. */
  intervalMs?: number;
};

type Backend = {
  pumpEvents(): boolean;
  setActivationPolicy(policy: ActivationPolicy): void;
};
const impl = backend<Backend>(
  () => require("./win32/event-loop"),
  () => require("./darwin/event-loop"),
);

/**
 * Dispatches every OS event waiting for this thread and returns at once.
 * Returns false when the OS asked the loop to end (Windows: `WM_QUIT`), true
 * otherwise. For a loop of your own; `runEventLoop` calls it on a timer.
 */
export function pumpEvents(): boolean {
  return impl().pumpEvents();
}

let stopRunning: (() => void) | undefined;

/**
 * Runs the OS loop from Bun's event loop: `pumpEvents` every `intervalMs`
 * until `quitEventLoop` is called or the OS ends the loop. Resolves then.
 * Create the tray, notifier and windows before or after calling it, on this
 * thread. One loop per process: a second call while one runs throws.
 */
export function runEventLoop(options: EventLoopOptions = {}): Promise<void> {
  const { intervalMs = 16 } = options;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError(`intervalMs must be a number of at least 1, got ${intervalMs}`);
  if (stopRunning) throw new Error("sweetnative: runEventLoop is already running");
  const { pumpEvents: pump } = impl(); // an unsupported OS throws here, synchronously, like every other native call
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!pump()) stopRunning?.();
    }, intervalMs);
    stopRunning = () => {
      clearInterval(timer);
      stopRunning = undefined;
      resolve();
    };
  });
}

/** Ends the loop `runEventLoop` is running, so its promise resolves; the pair of `run()` and `quit()` on a webview app. A no-op when no loop runs. */
export function quitEventLoop(): void {
  stopRunning?.();
}

/** macOS: how the app appears in the Dock and the app switcher; `accessory` for a menu-bar app. Windows: no-op. */
export function setActivationPolicy(policy: ActivationPolicy): void {
  impl().setActivationPolicy(policy);
}
