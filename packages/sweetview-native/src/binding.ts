// Internal. Loads the Rust binding, `sweetview.<target>.node`.
//
// The `require` of the prebuilt file is a literal string per target, which is
// the form `bun build --compile` embeds into the executable; a build for
// Windows without the file fails then (`requireWindowsBinding`). The same call
// works inside a `Worker`: the first thread to load the binding is the UI
// thread, and a later one gets the functions that are callable from any thread.
//
// `SWEETVIEW_NATIVE_PATH` names a binding you built yourself. It is read once,
// when the binding is first loaded.

import type * as Binding from "../prebuilt/binding";

export type NativeBinding = typeof Binding;

const customPath = process.env.SWEETVIEW_NATIVE_PATH || undefined;

let loaded: NativeBinding | undefined;
/** The loader `@n1h/sweetview` handed over: its binding, which has these calls and the webview's (D50). */
let provided: (() => NativeBinding) | undefined;

// Follows the message when the package's own file is not there. In a checkout of the repository it
// is built from source and ignored by git; an installed package always ships it.
const NOT_BUILT =
  "The file is not there. In a checkout of the sweetview repository it is built from the Rust source: " +
  "run `just native build` (it needs the Rust toolchain, installed with rustup from https://rustup.rs; " +
  "the repository's recipes that run the demos and the tests build it first), or set SWEETVIEW_NATIVE_PATH " +
  "to a binding you built. In an application that installed @n1h/sweetview-native the file ships with the " +
  "package, so its absence means a broken install: install the package again.";

function fail(file: string, cause: unknown, hint?: string): never {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const message = `sweetview: the native binding could not be loaded from ${file}: ${reason}`;
  throw new Error(hint === undefined ? message : `${message}\n${hint}`);
}

/** Whether `require` failed because the file is not there, rather than because it would not load. */
function isMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "MODULE_NOT_FOUND";
}

// The literal `require` of the prebuilt file, outside any `try` on purpose: Bun's bundler lets a
// `require` it cannot resolve through only inside a `try`, so out here a `bun build --compile` for
// Windows made without the file fails at build time ("Could not resolve"), instead of making an
// executable that fails when it starts. Bun puts the target's platform in place of
// `process.platform` when it compiles, so a build for another OS (`--target=bun-darwin-arm64`)
// drops the `require` and does not need the Windows file. (Only this form drops it: the `require`
// inside the `if`. Behind an early `if (process.platform !== "win32") throw` it is still resolved.)
function requireWindowsBinding(): NativeBinding {
  if (process.platform === "win32") return require("../prebuilt/sweetview.win32-x64-msvc.node") as NativeBinding;
  throw new Error(`sweetview: the Windows binding does not load on ${process.platform}`);
}

function load(): NativeBinding {
  if (customPath !== undefined) {
    try {
      return require(customPath) as NativeBinding;
    } catch (err) {
      fail(`${customPath} (SWEETVIEW_NATIVE_PATH)`, err);
    }
  }
  const target = `${process.platform}-${process.arch}`;
  switch (target) {
    case "win32-x64":
      try {
        return requireWindowsBinding();
      } catch (err) {
        fail("@n1h/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node", err, isMissing(err) ? NOT_BUILT : undefined);
      }
    default:
      throw new Error(
        `sweetview: there is no native binding for ${target}: @n1h/sweetview-native/prebuilt/ holds sweetview.win32-x64-msvc.node only; set SWEETVIEW_NATIVE_PATH to one you built`,
      );
  }
}

/** The binding, loaded on first use. Throws with the name of the file it looked for when it cannot be loaded. */
export function binding(): NativeBinding {
  return (loaded ??= customPath === undefined && provided !== undefined ? provided() : load());
}

/**
 * Internal: `@n1h/sweetview` hands over its own binding, which has every call of this package's and
 * the webview's, when it loads (D50). One binding is then loaded in the process, the facade's; an
 * application that imports only this package loads this package's, which has no webview.
 * @throws {Error} When this package's binding was loaded already, by a call made before
 * `@n1h/sweetview` was imported.
 */
export function provideBinding(load: () => NativeBinding): void {
  if (loaded !== undefined && provided !== load) {
    throw new Error("sweetview: @n1h/sweetview-native loaded its own binding before @n1h/sweetview was imported; import @n1h/sweetview before the first native call, so that one binding, the one with the webview, is loaded");
  }
  provided = load;
}

/** Loads the binding from a given file, bypassing the cache. For the loader's own tests. */
export function loadBindingFrom(path: string): NativeBinding {
  try {
    return require(path) as NativeBinding;
  } catch (err) {
    fail(path, err);
  }
}
