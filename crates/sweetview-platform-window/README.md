# sweetview-platform-window

Job: the window-level OS calls `tao` has no API for, and the events of any window by subclass.

| Module | Holds |
|---|---|
| `foreign` | `ForeignWindow`: a window this process did not create through Sweetview, named by the handle value an application passes. It is what a webview is mounted into by handle, and what `Window.fromHandle` wraps |

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
