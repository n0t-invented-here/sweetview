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

function fail(file: string, cause: unknown): never {
  const reason = cause instanceof Error ? cause.message : String(cause);
  throw new Error(`sweetview: the native binding could not be loaded from ${file}: ${reason}`);
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
        fail("@n1h/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node", err);
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
