# sweetview-napi

Job: the binding, where JavaScript values and functions are converted and handed to the runtime.

Every function JavaScript can call is an ordinary safe function in this crate: it checks the thread, converts its arguments, calls `sweetview-runtime`, and converts the answer. It holds no behaviour of its own.

It is safe Rust: `#![forbid(unsafe_code)]`. The `#[napi]` attribute cannot be used under that lint (its expansion registers each export through `unsafe extern "C"` code), so the attribute-carrying export table is a crate of its own, `sweetview-platform-node`, and each of its items forwards to a function here.

| Module | Holds |
|---|---|
| `callback` | `JsCallback`: a JavaScript function kept alive and called synchronously on the UI thread, each call in its own handle scope, with a thrown exception caught and logged |
| `errors` | the conversion of runtime errors into thrown JavaScript errors |
| `event_loop` | both loop modes, deferred jobs, native timeouts, and the wake a `Worker` calls |
| `menus` | the tray, popup menus, built menus handed to the application, a window's system menu, the folder dialog and the app-wide settings: window handles from `bigint`, the menu object shapes (`MenuItemData`, `IconBytes`, `Point`) and their conversion to the runtime's menu data, the chosen item's number out |
