// Internal. Picks the implementation folder for the running OS, once, lazily.
//
// `require` rather than `import()` so every public function stays synchronous:
// the UI thread cannot await while the webview's run loop owns it, and the
// bundler still embeds both folders (the strings are static), evaluating only
// the one the process is on.

/**
 * True on macOS until the macOS goal of the Rust rewrite: there, shared code the Windows goal
 * changed keeps the path it had at the tag `pre-rust-rewrite`, because nothing new on that path
 * has been run on a Mac. Every place that holds new behaviour back from macOS asks this, so a
 * search for the name finds them all; `rust-rewrite/HANDOFF-macos.md` lists them. Read when
 * called, not at import, so a test can set `process.platform` around a call.
 */
export function macosKeepsTagPath(): boolean {
  return process.platform === "darwin";
}

export function backend<T>(win32: () => T, darwin: () => T): () => T {
  let loaded: T | undefined;
  return () => {
    if (loaded === undefined) {
      switch (process.platform) {
        case "win32":
          loaded = win32();
          break;
        case "darwin":
          loaded = darwin();
          break;
        default:
          throw new Error(`sweetview: ${process.platform} is not supported (win32 and darwin are)`);
      }
    }
    return loaded;
  };
}
