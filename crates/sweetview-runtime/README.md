# sweetview-runtime

Job: everything that lives on Sweetview's UI thread, with no JavaScript in sight.

It owns the event loop in both of its modes, and the objects that live on it: windows, webviews, the tray, menus, notifiers. Callers hand it plain Rust closures and get plain Rust values back, so it is tested with `cargo test` and knows nothing of N-API. The binding crate, `sweetview-napi`, is the only caller.

It is safe Rust: `#![forbid(unsafe_code)]`. What needs an OS call no crate wraps is asked of a `sweetview-platform-*` crate.

| Module | Holds |
|---|---|
| `threads` | which thread is the UI thread, and the check every UI-thread entry point makes |
| `runtime` | the loop in its blocking and pumped modes, deferred jobs, native timeouts, wakes from other threads |
| `window` | windows made by `tao` and an application's own windows wrapped by handle: one record per native window with its subclass, listeners, hit-region poll and resize gesture; the lookup a webview mounts by |
| `screen` | monitors, work areas, the screen at a point or of a window, the virtual screen, the cursor |
