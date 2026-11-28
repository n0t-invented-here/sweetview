// Shared by the webview fixtures: each runs in its own process with its own
// WebView2 profile (WEBVIEW2_USER_DATA_FOLDER), prints one line
// `RESULT <json>` and exits. Each arms its own watchdog, so a fixture that
// hangs reports and exits by itself and is never killed from outside.

import { binding } from "../../../sweetview/src/binding";
import { unload, WebviewError } from "../../../sweetview/src/raw-webview";

export const native = binding();

/** What the fixture prints on its RESULT line. */
export const report: Record<string, unknown> = {};

let printed = false;

/** Prints the RESULT line once. */
export function print(extra: Record<string, unknown> = {}) {
  if (printed) return;
  printed = true;
  console.log("RESULT " + JSON.stringify({ ...report, ...extra }));
}

/** Prints the RESULT line and ends the process. */
export function finish(): never {
  print();
  process.exit(0);
}

/**
 * Reports a hang instead of hanging: after `ms`, from inside the native loop
 * (which `run()` blocks in) and from Bun's own loop (for the phases that
 * await), every webview is destroyed, the loop ends, and the RESULT line is
 * printed with `timedOut: true`.
 */
export function watchdog(ms = 25_000) {
  const fire = () => {
    report.timedOut = true;
    try {
      unload();
    } catch {
      // Already gone.
    }
    print();
    process.exit(0);
  };
  native.scheduleTimeout(ms, fire);
  setTimeout(fire, ms + 1_000).unref();
}

/** What `fn` throws: a WebviewError's code, 0 when it does not throw, or a description. */
export function codeOf(fn: () => unknown): number | string {
  try {
    fn();
    return 0;
  } catch (e) {
    return e instanceof WebviewError ? e.code : String(e);
  }
}
