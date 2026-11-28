// The binding of `@n1h/sweetview`: every call of `@n1h/sweetview-native`'s binding and the
// webview's (D50). It is handed to the native package when this module loads, so one binding is
// loaded in the process, this one; an application that imports only the native package loads that
// package's own, which has no webview.

import { connectWebview, type NativeBinding } from "@n1h/sweetview-native/internal";
import type * as Binding from "../prebuilt/binding";

export type WebviewBinding = typeof Binding;

const NOT_BUILT =
  "The file is not there. In a checkout of the sweetview repository it is built from the Rust source: " +
  "run `just native build`, which builds it with the native package's binding. In an application that " +
  "installed @n1h/sweetview the file ships with the package, so its absence means a broken install: install the package again.";

function load(): WebviewBinding {
  try {
    if (process.platform !== "win32") throw new Error(`the Windows binding does not load on ${process.platform}`);
    const own = require("../prebuilt/sweetview-webview.win32-x64-msvc.node") as WebviewBinding;
    const file = require.resolve("../prebuilt/sweetview-webview.win32-x64-msvc.node");
    // The process's one runtime is the first binding loaded in it (D50).
    const owner = own.claimProcess(file);
    if (owner === file) return own;
    return require(owner) as WebviewBinding;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const missing = (err as { code?: unknown } | null)?.code === "MODULE_NOT_FOUND";
    throw new Error(`sweetview: the binding of @n1h/sweetview could not be loaded from @n1h/sweetview/prebuilt/sweetview-webview.win32-x64-msvc.node: ${reason}${missing ? `\n${NOT_BUILT}` : ""}`);
  }
}

let loaded: WebviewBinding | undefined;

/** The binding, loaded on first use by this package or the native package, once. */
export const binding = (): WebviewBinding => (loaded ??= load());

// Windows only hands the binding over: on macOS, until its goal, the webview is the library of
// @n1h/sweetview-webview-bun.
const connection = connectWebview(process.platform === "win32" ? (binding as unknown as () => NativeBinding) : undefined);

/** Reports an exception of the webview's callbacks as the native package reports its own. */
export const reportCallbackError = connection.reportCallbackError;
