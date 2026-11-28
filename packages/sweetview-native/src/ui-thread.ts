// Internal. The UI thread's loop as the webview layer uses it, over the Rust binding:
// the blocking loop, a job on a later native tick, and the wake a Worker calls.
//
// A deferred job and a drain both arrive through the binding's signal window, so they
// run inside whichever message loop the UI thread is in, a handler's modal dialog included.

import { binding } from "./binding";

/** Drains Bun's microtask queue now: what runs a promise's continuation while Bun's event loop cannot. */
const drainMicrotasks: () => void = (require("bun:jsc") as { drainMicrotasks(): void }).drainMicrotasks;

let settleInstalled = false;

/**
 * Blocks in the OS loop until `quitNativeLoop()`. JavaScript runs only as callbacks from inside it.
 * Bun's event loop does not turn meanwhile, so after each callback that returns to the loop the
 * binding drains the microtask queue: a handler's `await` (of `WebView.attach`, say) continues
 * there. Timers and I/O of Bun's own still wait for the loop to end.
 */
export function runNativeLoop(): void {
  const native = binding();
  if (!settleInstalled) {
    // It acts only while runLoop() is on the stack; under the pumped loop Bun settles by itself.
    native.setCallbackSettle(drainMicrotasks);
    settleInstalled = true;
  }
  native.runLoop();
}

/** True while the blocking loop (`runNativeLoop`) is on the stack. */
export function inBlockingLoop(): boolean {
  return binding().isLoopBlocking();
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
      console.error("sweetview: UI dispatch failed:", err);
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
      console.error("sweetview: UI dispatch failed:", err);
    }
  });
  return { token, close: () => binding().setDrain(token, null) };
}

/** Runs the drain registered under `token` on the UI thread. Callable from any thread: a Worker calls it. */
export function wakeNative(token: number): boolean {
  return binding().wake(token);
}
