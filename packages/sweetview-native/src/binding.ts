// Internal. Loads the Rust binding, `sweetview.<target>.node`.
//
// The `require` of the prebuilt file is a literal string per target, which is
// the form `bun build --compile` embeds into the executable. The same call
// works inside a `Worker`: the first thread to load the binding is the UI
// thread, and a later one gets the functions that are callable from any thread.
//
// `SWEETVIEW_NATIVE_PATH` names a binding you built yourself. It is read once,
// when the binding is first loaded.

import type * as Binding from "../prebuilt/binding";

export type NativeBinding = typeof Binding;

const customPath = process.env.SWEETVIEW_NATIVE_PATH || undefined;

let loaded: NativeBinding | undefined;

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
        return require("../prebuilt/sweetview.win32-x64-msvc.node") as NativeBinding;
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
  return (loaded ??= load());
}

/** Loads the binding from a given file, bypassing the cache. For the loader's own tests. */
export function loadBindingFrom(path: string): NativeBinding {
  try {
    return require(path) as NativeBinding;
  } catch (err) {
    fail(path, err);
  }
}
