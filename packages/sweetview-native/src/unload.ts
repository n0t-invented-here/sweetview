// `unload()`: what it releases is made by `@n1h/sweetview`, which holds the webview (D50), and
// registers itself here when it loads. With only this package loaded there is nothing to release.

const unloaders = new Set<() => void>();

/** Internal: a release `unload()` runs, registered by `@n1h/sweetview` for its webviews. */
export function onUnload(release: () => void): void {
  unloaders.add(release);
}

/**
 * Destroys every webview this process created through `RawWebview` of
 * `@n1h/sweetview` that is still alive. Installed mouse or keyboard hooks are
 * not removed; dispose them first.
 */
export function unload(): void {
  for (const release of [...unloaders]) release();
}
