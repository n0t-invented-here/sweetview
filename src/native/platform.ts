// Internal. Picks the implementation folder for the running OS, once, lazily.
//
// `require` rather than `import()` so every public function stays synchronous:
// the UI thread cannot await while the webview's run loop owns it, and the
// bundler still embeds both folders (the strings are static), evaluating only
// the one the process is on.

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
          throw new Error(`sweetnative: ${process.platform} is not supported (win32 and darwin are)`);
      }
    }
    return loaded;
  };
}
