// The OS event loop for an app with no webview window: a menu-bar or tray app,
// an overlay with no page. `app.run()` / `webview.run()` blocks the UI thread
// inside the OS loop, and Bun's event loop with it, which is why a windowed
// app keeps its logic in a worker. These run the OS loop the other way round,
// from a Bun timer that drains pending OS events each tick, so the UI thread
// keeps Bun's event loop and `setTimeout`, promises and I/O work on it.

import { applicationReachable } from "./lifetime";
import { backend } from "./platform";

/** macOS NSApplicationActivationPolicy: `regular` has a Dock tile and app menu, `accessory` has neither but can show windows and menus, `prohibited` cannot show anything. */
export type ActivationPolicy = "regular" | "accessory" | "prohibited";

export type EventLoopOptions = {
  /** How often pending OS events are drained, in milliseconds. Default 16. */
  intervalMs?: number;
};

type Backend = {
  pumpEvents(): boolean;
  discardQuit(): void;
  scheduleNativeTimeout(ms: number, fn: () => void): () => void;
};
const impl = backend<Backend>(
  () => require("./win32/event-loop"),
  () => require("./darwin/event-loop"),
);

// Windows keeps it with the other application-wide settings it has no use for.
type PolicyBackend = { setActivationPolicy(policy: ActivationPolicy): void };
const policyImpl = backend<PolicyBackend>(
  () => require("./win32/app-menu"),
  () => require("./darwin/event-loop"),
);

/**
 * Dispatches every OS event waiting for this thread and returns at once.
 * For a loop of your own; `runEventLoop` calls it on a timer.
 *
 * @returns `false` when the OS asked the loop to end (Windows: a `WM_QUIT`
 * was dequeued, e.g. from `PostQuitMessage`), so the caller should stop
 * pumping; `true` otherwise. macOS has no equivalent quit message here and
 * returns `true`.
 */
export function pumpEvents(): boolean {
  return impl().pumpEvents();
}

/** Runs once on the native UI loop. The returned cancellation function is idempotent. */
export function scheduleNativeTimeout(ms: number, fn: () => void): () => void {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 0x7fff_ffff) {
    throw new RangeError(`sweetview: native timeout must be greater than 0 and at most 2147483647 ms, got ${ms}`);
  }
  return impl().scheduleNativeTimeout(ms, fn);
}

/**
 * Internal, for `WebView.dispose()`. Destroying a webview asks
 * the OS loop to end, which is right after `run()` and wrong for one window
 * of several under `runEventLoop`. Windows: dispatches what is waiting until
 * that request comes out, and drops it. macOS: nothing to take back.
 */
export function discardQuit(): void {
  impl().discardQuit();
}

let stopRunning: (() => void) | undefined;

/** How long the application must have had nothing to reach before the loop ends by itself (D43). */
const UNREACHABLE_MS = 250;

/**
 * Runs the OS loop from Bun's event loop: `pumpEvents` every `intervalMs`
 * until `quitEventLoop` is called or the OS ends the loop. Resolves then.
 * Create the tray, notifier and windows before or after calling it, on this
 * thread. One loop per process: a second call while one runs throws.
 *
 * It also ends by itself, and resolves, once the application has had nothing
 * a person can reach for `UNREACHABLE_MS`: no window it has shown and not
 * disposed, no tray icon, notifier, single-instance lock, input hook or
 * webview, and no window or tab being made (`applicationReachable`). That is
 * a start-up that failed with its error caught, or an application whose last
 * window was disposed with nothing else left: nothing could ever end the loop
 * otherwise, and Bun keeps a process waiting on `await runEventLoop()` alive
 * for as long as the promise is pending (D43).
 */
export function runEventLoop(options: EventLoopOptions = {}): Promise<void> {
  const { intervalMs = 16 } = options;
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new RangeError(`intervalMs must be a number of at least 1, got ${intervalMs}`);
  if (stopRunning) throw new Error("sweetview: runEventLoop is already running");
  const { pumpEvents: pump } = impl(); // an unsupported OS throws here, synchronously, like every other native call
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!pump()) {
        stopRunning?.();
        return;
      }
      if (applicationReachable()) {
        unreachableSince = undefined;
      } else {
        const now = performance.now();
        unreachableSince ??= now;
        if (now - unreachableSince >= UNREACHABLE_MS) stopRunning?.();
      }
    }, intervalMs);
    let unreachableSince: number | undefined;
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

/**
 * macOS: sets the process-wide `NSApplicationActivationPolicy`, which decides
 * whether the app has a Dock icon, appears in Cmd+Tab, and owns the menu bar
 * when active. Use `accessory` for a menu-bar app.
 *
 * Windows: no-op. Windows has no process-wide equivalent; taskbar and Alt+Tab
 * presence is per window, set with `WindowOptions.hideFromTaskbar`.
 */
export function setActivationPolicy(policy: ActivationPolicy): void {
  policyImpl().setActivationPolicy(policy);
}
