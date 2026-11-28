// How `@n1h/sweetview`, which holds the webview (D50), connects to this package.

import { provideBinding, type NativeBinding } from "./binding";
import { reportCallbackError } from "./callback-errors";

/**
 * Internal: `@n1h/sweetview` hands over its binding's loader (on Windows; `undefined` elsewhere,
 * where the webview is the macOS library) and gets back the reporter its webview's callbacks report
 * through, which no entry point exports.
 * @throws {Error} When this package's own binding was loaded already (see `provideBinding`).
 */
export function connectWebview(load: (() => NativeBinding) | undefined): { reportCallbackError: typeof reportCallbackError } {
  if (load !== undefined) provideBinding(load);
  return { reportCallbackError };
}
