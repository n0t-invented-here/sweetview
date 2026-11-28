// Internal. The UI thread's loop as the webview layer uses it, over the Rust binding:
// the blocking loop, a job on a later native tick, and the wake a Worker calls.
//
// A deferred job and a drain both arrive through the binding's signal window, so they
// run inside whichever message loop the UI thread is in, a handler's modal dialog included.

import { binding } from "./binding";
import { reportCallbackError } from "./callback-errors";

/** Blocks in the OS loop until `quitNativeLoop()`. JavaScript runs only as callbacks from inside it. */
export function runNativeLoop(): void {
  binding().runLoop();
}

/** Ends the `runNativeLoop()` in progress. */
export function quitNativeLoop(): void {
  binding().quitLoop();
}

/** Runs `job` on a later native UI tick. Returns a function that forgets it. */
export function deferNative(job: () => void): () => void {
  let live = true;
  binding().defer(() => {
    if (!live) return;
    live = false;
    try {
      job();
    } catch (err) {
      reportCallbackError("internal", err, "sweetview: UI dispatch failed:"); // no public call defers a job: Sweetview's own
    }
  });
  return () => {
    live = false;
  };
}

let nextDrainToken = 1;

/** Makes `drain` what `wakeNative(token)` runs on the UI thread. */
export function openNativeDrain(drain: () => void): { token: number; close(): void } {
  const token = nextDrainToken++;
  binding().setDrain(token, () => {
    try {
      drain();
    } catch (err) {
      // The worker's drain: its replies and events, and the application's onEvent listeners.
      reportCallbackError("worker", err, "sweetview: UI dispatch failed:");
    }
  });
  return { token, close: () => binding().setDrain(token, null) };
}

/** Runs the drain registered under `token` on the UI thread. Callable from any thread: a Worker calls it. */
export function wakeNative(token: number): boolean {
  return binding().wake(token);
}
