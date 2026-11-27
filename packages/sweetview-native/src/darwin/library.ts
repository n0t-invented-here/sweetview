// macOS only, until the macOS goal of the Rust rewrite replaces it: loads the webview library's
// bindings package, @n1h/sweetview-webview-bun, which is the webview engine, the input hooks and
// the permission model there.
//
// `import()` inside `try`, for two reasons. The package has a top-level await, which `require`
// cannot load. And a bundle built on a machine without the package (a Windows-only project, which
// no longer needs it) must still build: an import that cannot be resolved inside `try` is left for
// run time, where only macOS reaches it.

let loaded: Record<string, unknown>;
try {
  loaded = (await import("@n1h/sweetview-webview-bun")) as Record<string, unknown>;
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  throw new Error(`sweetview: on macOS the webview needs the package @n1h/sweetview-webview-bun, which could not be loaded: ${reason}`);
}

/** The bindings package's exports. Loosely typed on purpose: the installed version decides what exists. */
export const library = loaded;
