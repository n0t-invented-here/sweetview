// The end of the application. Whatever Sweetview made for an application is
// released by Sweetview when the application's process ends, so its last line
// is `run()` (or the end of its script under `runEventLoop`) and nothing after
// it is required (decision D36 in rust-rewrite/DECISIONS.md). Nothing is
// released while the process runs: code after `run()`, a second loop, a
// nested one all keep what the application made.
//
// Each object registers its own release here when it is made and takes it
// back when it is disposed by hand. `releaseAll` runs what is left, kind by
// kind in a safe order, newest first within a kind, and then, on Windows, the
// binding's own `releaseAll`, which releases whatever the binding still holds
// in the same order. It runs on Bun's `exit` event, which fires on this thread
// when the script ends, on `process.exit` and after an uncaught exception.
//
// A release that throws is logged and the others still run.
//
// Windows only, until the macOS goal of the Rust rewrite: on macOS `releaseAtEnd`
// registers nothing and hooks no `exit`, so a macOS application ends as it did at
// the tag `pre-rust-rewrite`, releasing nothing at exit (its own disposes and
// `process.exit` do what is done). AppKit and WebKit teardown from inside Bun's
// `exit` event has not been run on a Mac.

import { binding } from "./binding";
import { macosKeepsTagPath } from "./platform";

/** The kinds of object, in the order they are released. */
const ORDER = ["hook", "conceal", "app", "webview", "tray", "notifier", "lock", "window"] as const;

/**
 * What a release entry is for: `hook` an input hook, `conceal` hiding a
 * visible `Window` (D46), `app` a WebView of `@n1h/sweetview` (it stops the
 * worker and destroys its webview), `webview` a raw webview, `tray`,
 * `notifier`, `lock` a single-instance lock, `window` a `Window`. Every
 * window is off the screen before any webview goes, a webview goes before
 * its window, a tray before the windows.
 */
export type ReleaseKind = (typeof ORDER)[number];

const entries = new Map<ReleaseKind, Set<() => void>>(ORDER.map((kind) => [kind, new Set()]));
let exitHooked = false;
let releasing = false;

/**
 * Registers `release` to run when the application ends. Returns the function
 * that takes it back, for an object disposed by hand; calling it twice does nothing.
 */
export function releaseAtEnd(kind: ReleaseKind, release: () => void): () => void {
  // Until the macOS goal: nothing is released at exit there (see the header).
  if (macosKeepsTagPath()) return () => {};
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", releaseAll);
  }
  const entry = () => release();
  const set = entries.get(kind)!;
  set.add(entry);
  return () => void set.delete(entry);
}

/**
 * Releases everything still registered and everything the binding still
 * holds. Safe to call any number of times, and from inside a release (it then
 * does nothing more).
 */
export function releaseAll(): void {
  if (releasing) return;
  releasing = true;
  try {
    for (const kind of ORDER) {
      const set = entries.get(kind)!;
      for (const entry of [...set].reverse()) {
        set.delete(entry);
        try {
          entry();
        } catch (err) {
          console.error(`sweetview: releasing a ${kind} at the end of the application threw:`, err);
        }
      }
    }
    if (process.platform === "win32") {
      try {
        binding().releaseAll();
      } catch (err) {
        console.error("sweetview: releasing the native objects at the end of the application threw:", err);
      }
    }
  } finally {
    releasing = false;
  }
}
