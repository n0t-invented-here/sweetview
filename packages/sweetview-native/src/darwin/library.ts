// macOS only, until the macOS goal of the Rust rewrite replaces it: loads the webview library's
// bindings package, @n1h/sweetview-webview-bun, which is the webview engine, the input hooks and
// the permission model there.
//
// The import is behind `process.platform === "darwin"`, written out here (not `onDarwin` from
// ../platform, which the bundler cannot see through): Bun folds the comparison for the target of
// `bun build --compile --target=…`, so an executable for Windows leaves the import, and with it the
// package's sources and native library, out even when the package is installed, and one for macOS
// keeps it. Only the macOS seams (./input and ./webview) import this module, and only on macOS.
//
// `import()` inside `try`, for two reasons. The package has a top-level await, which `require`
// cannot load. And a macOS bundle built on a machine without the package must still build: an
// import that cannot be resolved inside `try` is left for run time.
//
// The package is an optional peer, as it was at the tag `pre-rust-rewrite`: an application on
// macOS that uses only windows, the tray, menus or notifications does not install it. So a failed
// load is kept and thrown by `library()`, at the first use of the webview, a hook or a permission,
// never at the import of `@n1h/sweetview-native`.

let loaded: Record<string, unknown> | undefined;
let failure: Error | undefined;
if (process.platform === "darwin") {
  try {
    loaded = (await import("@n1h/sweetview-webview-bun")) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failure = new Error(`sweetview: on macOS the webview needs the package @n1h/sweetview-webview-bun, which could not be loaded: ${reason}`);
  }
} else {
  throw new Error(`sweetview: @n1h/sweetview-webview-bun is the webview engine on macOS only; it is not loaded on ${process.platform}`);
}

/**
 * The bindings package's exports. Loosely typed on purpose: the installed version decides what exists.
 * @throws {Error} When the package could not be loaded (not installed, or its library failed to load).
 */
export function library(): Record<string, unknown> {
  if (loaded === undefined) throw failure!;
  return loaded;
}
