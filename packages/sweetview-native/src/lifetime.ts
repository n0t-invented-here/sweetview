// The end of the application. Whatever Sweetview made for an application is
// released by Sweetview when the application ends, so its last line is
// `run()` (or the end of its script under `runEventLoop`) and nothing after
// it is required (decision D36 in rust-rewrite/DECISIONS.md).
//
// Each object registers its own idempotent dispose here when it is made and
// takes it back when it is disposed by hand. `releaseAll` runs what is left,
// kind by kind in a safe order, newest first within a kind, and then, on
// Windows, the binding's own `releaseAll`, which releases whatever the binding
// still holds in the same order. It runs:
//
// - when a blocking `run()` of a WebView (`app.run()` on a single-window app)
//   has returned: the application has quit;
// - when the process exits for any other reason JavaScript sees: the script
//   ends (the pumped loop), `process.exit`, an uncaught exception
//   (Bun's `exit` event, which fires on each of them, on this thread).
//
// A release that throws is logged and the others still run. Objects made
// after a release work as usual and are released at the next end.

import { binding } from "./binding";

/** The kinds of object, in the order they are released. */
const ORDER = ["hook", "app", "webview", "tray", "notifier", "lock", "window"] as const;

/**
 * What a release entry is for: `hook` an input hook, `app` a WebView of
 * `@n1h/sweetview` (it stops the worker and destroys its webview), `webview`
 * a raw webview, `tray`, `notifier`, `lock` a single-instance lock, `window`
 * a `Window`. A webview goes before its window, a tray before the windows.
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
