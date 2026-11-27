# Handoff to the macOS goal

Written by the Windows goal for checklist item W10.3. Read it after `rust-rewrite/REQUIREMENTS.md` and before starting `rust-rewrite/CHECKLIST-macos.md`. Every claim about code names its file; line numbers are those of the commit named below. "Not confirmed" marks what was not checked; "suggestion" marks this document's own proposals.

## 1. Where things stand

On Windows, Sweetview's native layer runs on Rust: the crates under `crates/`, reached from Bun through one N-API binding (`packages/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node`, loaded by `packages/sweetview-native/src/binding.ts`). Windows no longer loads `@n1h/sweetview-webview-bun` or the C++ library, and no Windows source under `packages/` imports `bun:ffi`. macOS still runs today's code: the TypeScript under `packages/sweetview-native/src/darwin/`, the files `packages/sweetview/src/darwin-*.ts` and `packages/sweetview/src/tabs/darwin-*.ts`, calling AppKit through `bun:ffi` and the webview through the C++ library of the optional peer `@n1h/sweetview-webview-bun`. The work is on branch `v1-rust-rewrite` of `n0t-invented-here/sweetview`; tag `pre-rust-rewrite` marks the tree before the first change. This document describes the tree at commit `f88ceb4`. Still open on the Windows side at that commit, unticked in `rust-rewrite/CHECKLIST-windows.md`: W0.6 (the GitHub Actions workflow item), W10.2 (the independent review of every `unsafe` block and every item's evidence), W10.3 (this document) and W10.4 (`rust-rewrite/OWNER-ACTIONS.md`). Every other Windows item is ticked, among them tabs (W7.1, W7.2), the docs and upgrade items (W9.1 to W9.4), the unsafe ledger (W10.1), `bun build --compile` embedding the binding (W1.6) and the window and notifier demos (W4.7, W5.5).

## 2. What compiles for macOS

Command, from the repository root on the Windows machine:

```
bun rust-rewrite/checks/mac-check.ts
```

Output at `f88ceb4`:

```
$ cargo check --target aarch64-apple-darwin --workspace   (C compiler and archiver: a stand-in that creates empty outputs)
    Checking sweetview-runtime v1.0.0 (<REPO>\crates\sweetview-runtime)
    Checking sweetview-napi v1.0.0 (<REPO>\crates\sweetview-napi)
    Checking sweetview-platform-node v1.0.0 (<REPO>\crates\sweetview-platform-node)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 7.56s
exit: 0; warnings and errors: 0
removing <TEMP>\sweetview-mac-check-042fbT
```

The other crates do not appear as "Checking" because they were up to date in the script's target folder (`target/mac-check`) from an earlier run; why these three are re-checked on every run is not confirmed.

What it proves (header of `rust-rewrite/checks/mac-check.ts`, lines 1-11): rustc type-checks the Rust of every workspace crate and of every dependency for `aarch64-apple-darwin`, with no warning and no error. `objc2-exception-helper`, pulled in by `wry` on macOS, compiles an Objective-C file in its build script; the script gives cargo a stand-in C compiler and archiver that only create empty output files.

What it does not prove: nothing is linked, nothing is run, and the stand-in object files are empty. It runs `cargo check --workspace` without `--all-targets` (`mac-check.ts`, line 49), so tests, dev-dependencies and examples are not checked for macOS. It checks `aarch64-apple-darwin` only, not `x86_64-apple-darwin`. Everything that compiles does so because the platform crates swap in stand-ins (section 3), so a clean check says nothing about macOS behaviour.

The twelve crates (jobs from each crate's `README.md`):

| Crate | Job | macOS as it stands |
|---|---|---|
| `sweetview-http` | the rules of the webview's request handler that need no OS call | complete: pure logic, no platform gate; has `MACOS_ASSET_ORIGIN` `webview://localhost` and `MACOS_FRAMES_ORIGIN` (`src/url.rs` lines 4-8, re-exported in `src/lib.rs`) |
| `sweetview-keycodes` | the tables that turn an OS key or mouse message into the values applications see | complete for macOS as logic: `dom_code_from_mac_keycode` (`src/tables.rs` line 171; 121 named entries asserted in `src/lib.rs` lines 190-192) and the event-tap decisions in `src/mac.rs`; nothing outside the crate calls either yet |
| `sweetview-window-logic` | what a window should do next, decided from cursor positions, button states and bounds | compiles everywhere, no gate; parts are Windows-shaped (section 3.8) |
| `sweetview-runtime` | everything that lives on the UI thread, with no JavaScript in sight | compiles; Windows-shaped in places with `cfg(not(windows))` fallbacks (section 3.7) |
| `sweetview-napi` | the binding: converts JavaScript values and functions and calls the runtime | compiles; no platform gate; some exports are Windows-only in meaning (section 3.7) |
| `sweetview-platform-node` | the export table: the items that carry `#[napi]` | compiles; no platform gate |
| `sweetview-platform-loop` | the parts of the UI thread's event loop `tao` has no API for, and the message-only window, pump calls and handle counts the other platform crates share (D23) | stand-in: `src/unported.rs`; the shared message-window pieces are exported on Windows only |
| `sweetview-platform-webview` | what the webview needs on top of `wry` that `wry` has no API for | stand-in: `src/unported.rs` |
| `sweetview-platform-input` | system-wide mouse and keyboard hooks and the permission model | stand-in: `src/unported.rs`; macOS branch in `src/permissions.rs` |
| `sweetview-platform-window` | the window-level OS calls `tao` has no API for, and the events of any window by subclass | stand-ins: `src/unported.rs`, `src/tab_frame_unported.rs`, and `cfg(not(windows))` modules in `metrics.rs`, `popup.rs`, `size_hint.rs` |
| `sweetview-platform-notify` | desktop notifications with a click that comes back | stand-in: `src/unported.rs` |
| `sweetview-platform-shell` | clipboard text, URL schemes, single instance, icon refresh | per-module `cfg(not(windows))` stand-ins in `clipboard.rs`, `url_scheme.rs`, `single_instance.rs`; `icons.rs` is a no-op off Windows |

## 3. What is stubbed

### 3.0 The gate, and what to do about it

W10.3 asked for stubs behind `cfg(target_os = "macos")`. The code does not use that gate: every platform crate selects its implementation with `#[cfg(windows)]` and its stand-in with `#[cfg(not(windows))]` (the one exception is `crates/sweetview-platform-input/src/permissions.rs`, which gates on `target_os = "macos"`). So today the stand-ins serve macOS and Linux alike.

Suggestion for the macOS goal: replace each `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;` with three arms, `#[cfg(windows)]`, `#[cfg(target_os = "macos")]` (the new macOS module) and `#[cfg(not(any(windows, target_os = "macos")))]` (the stand-in, kept for Linux), and do the same for each `cfg(not(windows))` fallback function in `sweetview-runtime`. Gate each crate's macOS dependencies the same way (`[target.'cfg(target_os = "macos")'.dependencies]`). That keeps `cargo check --target x86_64-unknown-linux-gnu` meaningful for the Linux goal and records in `rust-rewrite/HANDOFF-linux.md` (item M9.4) which stand-ins are still Linux's.

Every platform crate's `Cargo.toml` puts its OS crates under `[target.'cfg(windows)'.dependencies]`: `windows` in each; `windows-registry` 0.6.1 in `sweetview-platform-notify` and `sweetview-platform-shell` (D23); `dirs` 7.0.0, `webview2-com` and `windows-core` in `sweetview-platform-webview` (`dirs` for the default WebView2 profile folder, D15, D23). Both new crates are declared once in the root `Cargo.toml` `[workspace.dependencies]` (lines 30 and 35). `sweetview-platform-loop` is a Windows-only dependency of the notify, shell and webview crates (for `MessageWindow`, `Poster` or the pump calls, each as it needs) and an unconditional one of `sweetview-platform-window`, whose `HandleCounts` is the loop crate's `ResourceCounts` (`crates/sweetview-platform-window/src/lib.rs` line 71). `sweetview-runtime/Cargo.toml` depends on `tao`, `wry`, `muda`, `rfd` and `tray-icon` unconditionally, and on `webview2-com` for Windows only. `dirs` is cross-platform; whether the macOS data store of D15 needs a folder from it is not confirmed.

In the tables below, "same signature" means the macOS module must expose exactly these items, because `sweetview-runtime` calls them on every platform.

### 3.1 `sweetview-platform-loop`

Gate: `src/lib.rs` lines 25-30 (`#[cfg(windows)] #[path = "windows.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`); exports on every platform at line 34: `discard_quit, dispatch_waiting, messages_waiting, post_quit_for_tests, resource_counts, SignalWindow, Waker`. Lines 35-36 export on Windows only, with no stand-in: `next_message, wait_message, MessageWindow, Poster, QueuedMessage, Waited, WindowError` (D23: one owning type for a message-only window and its cross-thread poster, and the pump calls, used by the Windows modules of the notifier, the single-instance window and the clipboard owner, and by Windows tests). The macOS goal needs no counterpart for them unless its own modules choose to share one.

Shared, no gate: `ResourceCounts` (`src/lib.rs` lines 40-49; its fields are documented as `GetGuiResources` and `GetProcessHandleCount`), and `src/testing.rs` (`settled_counts`, `smallest_growth`, `Growth`: D20's way of reading counts once they stop moving and taking the smaller growth of two runs, built on `resource_counts`). `LoopHost` (`src/loop_host.rs`) is shared and has no gate except its tests (`#[cfg(all(test, windows))]`, line 73); it keeps a clone of the loop's window target (D4, rewritten by D23, no `unsafe`), and that clone type-checks for `aarch64-apple-darwin` (section 2). `src/com.rs` line 58 has a `cfg(not(windows))` `ComApartment` whose `enter()` returns `Ok` (correct for macOS: no COM).

| Item (in `src/unported.rs`) | Windows (`src/windows.rs`) | Stand-in returns |
|---|---|---|
| `SignalWindow::new(handler: impl Fn(Signal) + 'static) -> Result<Self, SignalError>` | a message-only window; wakes and timers arrive as its messages, inside any message loop the thread is in | `Err(SignalError("the signal window is not ported to this platform yet"))` |
| `SignalWindow::waker(&self) -> Waker` | a `Send` handle that posts to the window | a `Waker` (unreachable) |
| `SignalWindow::set_timer(&self, interval_ms: u32) -> Result<TimerId, SignalError>` | `SetTimer` on the window | `Err(...)` |
| `SignalWindow::cancel_timer(&self, TimerId)` | `KillTimer` | no-op |
| `SignalWindow::dispatch_due_timers(&self)` | serves due timers after a pump (decision D3) | no-op |
| `Waker::wake(&self, token: u64) -> bool` | posts a message carrying the token; false when the window is gone | `false` |
| `discard_quit() -> bool` | takes back a pending `WM_QUIT` | `false` |
| `post_quit_for_tests()` (`#[doc(hidden)]`) | `PostQuitMessage(0)` | no-op |
| `messages_waiting() -> bool` | whether the thread's queue holds a posted message (used by `Runtime::pump`, D11) | `false` |
| `dispatch_waiting()` | dispatches every message waiting in the thread's queue, without translation (the Windows tests' pump) | no-op |
| `resource_counts() -> ResourceCounts` | `GetGuiResources` (USER and GDI objects) and `GetProcessHandleCount` | all three fields `0` |

Consequence: `Runtime::new` makes the signal window and returns its error with `?` (`crates/sweetview-runtime/src/runtime.rs` lines 121-126), so on macOS today the runtime does not start. This crate is the first thing the macOS goal ports.

### 3.2 `sweetview-platform-webview`

Gate: `src/lib.rs` lines 32-37 (`#[cfg(windows)] #[path = "windows/mod.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`); line 24 `#![cfg_attr(not(windows), allow(dead_code))]`; lines 39-40 export `create_environment` and `default_user_data_folder` on Windows only; line 41 exports `UserScript, WebviewExtras` everywhere.

| Item (in `src/unported.rs`) | Windows (`src/windows/`) | Stand-in returns |
|---|---|---|
| `WebviewExtras::attach(webview: &wry::WebView, options: ExtrasOptions) -> Result<Self, ErrorCode>` | adds the extras through `wry`'s `controller()`, `webview()`, `environment()` | `Err(ErrorCode::Unspecified)` |
| `drain(&self)` | runs work queued from other threads | no-op |
| `add_user_script(&self, &str) -> Result<UserScript, ErrorCode>` | `AddScriptToExecuteOnDocumentCreated`; returns at once and counts the registration as outstanding until WebView2 reports it (D21) | `Err(Unspecified)` |
| `remove_user_script(&self, UserScript)` | removes it (or marks it for removal when its id has not arrived) | no-op |
| `scripts_pending(&self) -> bool` | whether a registration (or a removal asked for before its id arrived) is outstanding; the runtime holds navigations and evaluations while it is true (D21) | `false` |
| `set_scripts_registered_handler(&self, Option<Rc<dyn Fn()>>)` | called inside WebView2's completion callback when the last outstanding registration completes | no-op |
| `stop_navigation(&self)` | `ICoreWebView2::Stop`, so an outstanding registration completes without waiting for the navigation in flight (D21) | no-op |
| `set_asset(&self, path, mime, Vec<u8>) -> ErrorCode` | serves it on `http://webview.localhost` | `Unspecified` |
| `set_request_handler(&self, Option<Rc<dyn Fn(RawRequest)>>) -> ErrorCode` | one `WebResourceRequested` handler for both origins, requests held with a deferral | `Unspecified` |
| `responder(&self) -> Responder` | the answering half, usable from any thread; streamed bodies through an `IStream` | `unreachable!("no WebviewExtras exists on this platform")` (lines 65-67): a panic |
| `set_background_color(&self, r, g, b, a) -> ErrorCode` | `DefaultBackgroundColor`; alpha 0 or 255 only | `Unspecified` |
| `allows_external_drop(&self) -> Option<bool>` / `set_allow_external_drop(&self, bool) -> ErrorCode` | `ICoreWebView2Controller4::AllowExternalDrop` | `None` / `Unspecified` |
| `set_file_drop_handler(&self, Option<Rc<dyn Fn(Vec<String>)>>) -> ErrorCode` | the drop script plus `WebMessageReceived` reading `ICoreWebView2File` (D17) | `Unspecified` |
| `set_accelerator_key_handler(&self, Option<Rc<dyn Fn(KeyData) -> bool>>) -> ErrorCode`, `set_navigation_failed_handler(&self, Option<Rc<dyn Fn(NavigationFailure)>>) -> ErrorCode` | the tabs library's hooks | `Unspecified` |
| `note_host_navigation(&self)`, `notify_parent_window_position_changed(&self)` | the tabs library's controller calls | no-ops |
| `call_devtools_protocol_method(&self, method: &str, params_json: &str) -> ErrorCode` | `CallDevToolsProtocolMethod` | `Unspecified` |

`move_focus` is gone from the crate (D23): the runtime gives the page focus with `wry`'s `WebView::focus` (`crates/sweetview-runtime/src/engine.rs` line 411), which `wry` 0.58.2 implements on macOS too (`src/wkwebview/mod.rs` line 1165: `makeFirstResponder` on the webview's window), so focus needs no macOS item here. That macOS implementation calls `self.webview.window().unwrap()`, so it panics for a webview that has no window at the time of the call.

Shared code in `src/lib.rs` that is WebView2-shaped: `FILE_DROP_MESSAGE` and `is_file_drop_message` (lines 45-57, the string the drop script posts); `KeyData.virtual_key` is "the Windows virtual-key code" (lines 78-79); `web_error_reason` maps `COREWEBVIEW2_WEB_ERROR_STATUS` values (line 131); `FILE_DROP_SCRIPT` posts through `window.chrome.webview.postMessageWithAdditionalObjects` (lines 173-206). All crate tests are `#![cfg(windows)]`: `tests/environment.rs`, `tests/file_drop.rs`, `tests/requests.rs`, `tests/teardown.rs`.

### 3.3 `sweetview-platform-input`

Gate: `src/lib.rs` lines 20-25 (`#[cfg(windows)] #[path = "windows.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`); line 28 `pub use platform::{KeyboardHook, MouseHook};`. `src/permissions.rs` is shared, with `#[cfg(target_os = "macos")]` and `#[cfg(not(target_os = "macos"))]` arms at lines 150-180.

| Item | Windows | Stand-in returns |
|---|---|---|
| `MouseHook::install(handler: impl Fn(&MouseEvent) -> bool + 'static) -> Result<MouseHook, HookError>` (`unported.rs` line 17) | `WH_MOUSE_LL` on the calling thread; true swallows; one per process | `Err(HookError::Os("mouse hooks are not ported to this platform yet"))` |
| `MouseHook::remove(self) -> Result<(), HookError>` | unhooks | `Ok(())` (unreachable) |
| `KeyboardHook::install(...)` / `remove` (lines 32, 36) | `WH_KEYBOARD_LL` | `Err(HookError::Os(...))` / `Ok(())` |
| `permissions::platform_needed()` (macOS arm, line 167) | `0` (nothing needed) | `Permission::DeviceControl.bit()` |
| `permissions::platform_status(_)` (macOS arm, lines 172-175) | `NotApplicable` | always `Status::Missing` |
| `permissions::platform_request(_)` (macOS arm, lines 177-180) | as status | returns status; asks the system nothing |

`crates/sweetview-keycodes/src/mac.rs` already holds the event-tap decisions (`CGEventType` values, `mouse_event_kind`, `modifiers_from_flags`, `modifier_flags_for_keycode`, `key_event_kind`), ported for this crate's macOS module to call. Test file `tests/windows_hooks.rs` is `#![cfg(windows)]`.

### 3.4 `sweetview-platform-window`

Gates in `src/lib.rs`: lines 22-27 (`#[cfg(windows)] #[path = "windows.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`, `pub use platform::*;` at 29) and lines 34-39 (`#[cfg(windows)] #[path = "tab_frame.rs"] mod tab_frame;` / `#[cfg(not(windows))] #[path = "tab_frame_unported.rs"] mod tab_frame;`, `pub use tab_frame::*;` at 41). Line 71: `pub use sweetview_platform_loop::ResourceCounts as HandleCounts;` (shared). Per-module fallbacks (Windows / stand-in): `src/metrics.rs` (8 / 30), `src/popup.rs` (21 / 89), `src/size_hint.rs` (41-44 / 84). Stand-in error text: `NOT_PORTED = "sweetview: window calls are not ported to this platform yet"` (`src/unported.rs` line 13).

`src/unported.rs`:

| Item | Windows (`src/windows.rs`) | Stand-in returns |
|---|---|---|
| `trait NativeWindow` (sealed), for `tao::window::Window` and `ForeignWindow` | yields the `HWND` | marker only |
| `ForeignWindow` (`Debug`, `Clone`, not `Send`) | the one type that names a window by handle: an application's own window (adopted, or a webview mounted in it), a webview's reparent target, and the owner of a popup menu, the tray menu or a folder dialog (the former `OwnerWindow` is folded into it) | a wrapper naming no window |
| `ForeignWindow::from_handle_value(isize) -> Option<Self>` | an `IsWindow`-checked `HWND`; `None` for `0` | `None` |
| `ForeignWindow::of(&impl NativeWindow) -> Self` | wraps the same window | an empty wrapper naming no window |
| `impl HasWindowHandle for ForeignWindow` | `Win32WindowHandle`, re-checked with `IsWindow`; `Err(HandleError::Unavailable)` once the window is gone | `Err(HandleError::NotSupported)` |
| `impl HasDisplayHandle for ForeignWindow` | `DisplayHandle::windows()` | `Err(HandleError::NotSupported)` |
| `handle_value(&impl NativeWindow) -> isize` | the `HWND` as an integer | `0` |
| `is_window`, `is_on_this_thread`, `is_visible`, `is_active`, `is_minimized`, `is_zoomed` | `IsWindow`, thread id, `IsWindowVisible`, ... | `false` each |
| `outer_bounds -> Option<Rect>` | `GetWindowRect` | `None` |
| `dpi_scale -> f64` | `GetDpiForWindow / 96` | `1.0` |
| `ex_style -> u32`, `style -> u32` | `GWL_EXSTYLE`, `GWL_STYLE` | `0` |
| `chrome -> Chrome` | frame and resizability from the styles | `Chrome { frame: true, resizable: true }` |
| `set_outer_bounds`, `move_outer`, `resize_outer`, `set_topmost`, `refresh_frame -> bool` | one `SetWindowPos` each | `false` |
| `bring_to_front`, `show(no_activate, topmost)`, `hide`, `minimize`, `toggle_zoom` | today's `show()` semantics (D9), `ShowWindow` | no-ops |
| `set_title -> bool` | `SetWindowTextW` | `false` |
| `start_os_drag` | `WM_NCLBUTTONDOWN` with `HTCAPTION` | no-op |
| `send_close_for_tests`, `fill_first_child`, `apply_ex_style(&ExStylePolicy)` | `WM_CLOSE`, child resize, `SetWindowLongPtrW` | no-ops |
| `set_layered_attributes(color_key: Option<u32>, opacity: Option<f64>) -> Result<(), String>` | `SetLayeredWindowAttributes` | `Err(NOT_PORTED)` |
| `destroy_now(&tao::window::Window)` | `DestroyWindow` | no-op |
| `mouse_buttons_down()`, `left_button_down() -> bool` | `GetAsyncKeyState` | `false` |
| `work_area(&MonitorHandle) -> Option<Rect>` | `GetMonitorInfo().rcWork` | `None` (the runtime then uses the monitor bounds, `crates/sweetview-runtime/src/screen.rs` line 34) |
| `handle_counts() -> HandleCounts` | `sweetview_platform_loop::resource_counts()` (D23) | zeros |
| `GeometrySnapshot::take` / `restore` | styles and bounds across a mount (`preserveGeometry`) | unit value / no-op |
| `WindowIcons::set(&impl NativeWindow, Option<&[u8]>) -> Result<Self, String>` | `HICON`s from `.ico` bytes | `Err(NOT_PORTED)` |
| `WindowSubclass::install(&impl NativeWindow, impl Fn(&WindowEvent) -> bool + 'static) -> Result<Self, String>` | `SetWindowSubclass` with a safe `extern "system"` procedure (D23): resize, move, close, drop, destroy and activation events inside any loop (D8) | `Err(NOT_PORTED)`; window creation propagates it (`crates/sweetview-runtime/src/window.rs` line 210) |
| `WindowSubclass::policy`, `set_policy`, `set_hold_visibility`, `set_fill_child`, `force_style(u32)` | the forced extended styles | defaults / no-ops (unreachable) |

`src/tab_frame_unported.rs` (the Windows module is `src/tab_frame.rs`; D22):

| Item | Windows | Stand-in returns |
|---|---|---|
| `FRAME_STYLE: u32` | `WS_CLIPCHILDREN` | `0` |
| `is_foreground(&impl NativeWindow) -> bool` | whether the frame is the foreground window | `false` |
| `move_with_mouse(&impl NativeWindow)`, `size_with_mouse(&impl NativeWindow, ResizeEdge)` | the OS move and size loops | no-ops |
| `show_system_menu(&impl NativeWindow, Point)` | the system menu | no-op |
| `request_close(&impl NativeWindow)` | sends `WM_CLOSE` and returns once the window has handled it | no-op |
| `PopupEntry::{Item { label, enabled }, Separator}` | shared shape | same |
| `popup_menu(&impl NativeWindow, &[PopupEntry], Point) -> Result<Option<usize>, String>` | `CreatePopupMenu` and `TrackPopupMenu` with `TPM_RETURNCMD`, the chosen index before it returns (D22) | `Err("sweetview: popup menus are not ported to this platform yet")` |
| `system_is_dark() -> bool` | reads `UISettings` | `false` |
| `Backdrop { strip_height: u32, strip: (u8, u8, u8), page: (u8, u8, u8) }` | shared shape | same |
| `FrameMessages::install(&impl NativeWindow, Backdrop) -> Result<Self, String>` | a second subclass procedure on the frame, a safe function (D23): `WM_ERASEBKGND` fills the strip and page rectangles with two owned brushes; `WM_DPICHANGED` goes to `tao` first, then the suggested rectangle is applied (D22) | `Err("sweetview: tab frames are not ported to this platform yet")`; the runtime drops the error with `.ok()` (`crates/sweetview-runtime/src/window/tab_frame.rs` line 129) |
| `FrameMessages::set_backdrop(&self, Backdrop) -> Result<(), String>` | replaces the brushes and repaints | `Ok(())` (unreachable) |

This module serves the Windows tab strip; macOS tabs are AppKit's (section 5, M6).

`src/metrics.rs`: `double_click_time_ms() -> u32` (stand-in `500`; Windows `GetDoubleClickTime`), `small_icon_size() -> u32` (stand-in `16`; Windows `SM_CXSMICON`).

`src/popup.rs`: `show_popup(&muda::Menu, &ForeignWindow, PopupAt) -> bool` (stand-in `false`; Windows `show_context_menu_for_hwnd` at a screen point converted to the owner's client area, then `WM_NULL`), `check_item(&muda::Menu, &[u32], bool) -> bool` (stand-in `false`; Windows `SetMenuItemInfoW` with `MFS_CHECKED`), `PopupAt` shared. `OwnerWindow` no longer exists; the owner is a `ForeignWindow` (rows above).

`src/size_hint.rs`: `apply_given_window_size(&impl NativeWindow, u32, u32, GivenWindowSizeHint) -> bool` (stand-in `false`; Windows rewrites `GWL_STYLE` and sizes with `AdjustWindowRectExForDpi`).

### 3.5 `sweetview-platform-notify`

Gate: `src/lib.rs` lines 18-23 (`#[cfg(windows)] #[path = "windows.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`); line 25 `pub use platform::{live_toast_handlers, Notifier};`.

| Item (in `src/unported.rs`) | Windows | Stand-in returns |
|---|---|---|
| `Notifier::new(options: NotifierOptions, on_click: impl Fn(&str, Option<&str>) + 'static) -> Result<Notifier, NotifyError>` | WinRT toasts under a registered AUMID, balloon fallback, clicks on the notifier's thread | `Err(NotifyError("sweetview: notifications are not ported to this platform yet"))` |
| `notify(&self, &Notification) -> bool` / `show(&self, &Notification) -> Option<Shown>` | shows a toast or balloon | `false` / `None` |
| `set_icon_ico(&self, Option<Vec<u8>>) -> Result<(), NotifyError>` | validates and keeps the balloon's `.ico` | `Ok(())` without validating (unreachable) |
| `toasts_available(&self) -> bool` | whether WinRT toasts are in use | `false` |
| `force_path(&self, ForcedPath)` | test hook: makes later notifications take a failure path, or `ToastHeld` (built and subscribed, not handed to the platform; D20) | no-op |
| `set_toast_life(&self, Option<u32>)` | test hook: later toasts show no banner and expire after the given seconds; `None` is what applications get | no-op |
| `simulate_toast_event(&self, u64, ToastEvent) -> bool`, `simulate_balloon_event(&self, u32, BalloonEvent) -> bool` | test hooks: deliver an event as WinRT or the shell would | `false` |
| `pending_toasts(&self) -> usize`, `pending_balloons(&self) -> usize` | test hooks | `0` |
| `balloons_shown(&self) -> u32` | test hook: balloons the shell accepted since the notifier was made (D20) | `0` |
| `live_toast_handlers() -> usize` | live WinRT handlers | `0` |

The shared types in `src/lib.rs` are Windows-shaped on every platform: `Shown::{Toast(u64), Balloon(u32)}` (57-63), `ToastEvent` (67-71), `BalloonEvent` (75-82), `ForcedPath::{Auto, BalloonOnly, ToastShowFails, ToastHeld}` (87-102); `NotifierOptions.app_id` is documented as an AUMID (lines 30-32). The crate's tests are `#[cfg(all(test, windows))]` (`src/lib.rs` line 118). On Windows the toast identity's registry key is written through `windows-registry` (D23).

### 3.6 `sweetview-platform-shell`

No `unported.rs`. Gate: `src/lib.rs` lines 17-18 (`#[cfg(windows)] mod win;`) and 32-35 (`#[cfg(not(windows))] pub(crate) fn unported(what: &str) -> ShellError`, text `sweetview: {what} is not ported to this platform yet`).

| Item | Windows | Stand-in returns |
|---|---|---|
| `clipboard::read_text() -> Result<Option<String>, ShellError>`, `write_text(&str) -> Result<(), ShellError>`, `clear() -> Result<(), ShellError>` (`src/clipboard.rs`, stand-in `mod imp` at 214) | `OpenClipboard` with retries, `CF_UNICODETEXT`; the owner window is the loop crate's `MessageWindow` (D23) | `Err(unported("the clipboard"))` |
| `single_instance::acquire(app_id: &str, payload_json: &str, on_second: impl Fn(&str) + 'static) -> Result<Acquired, ShellError>`, with `Acquired::{Primary(SingleInstance), Secondary { handed_off: bool }}` (`src/single_instance.rs`, stand-in `mod imp` at 208) | named mutex `Local\sweetview.instance.<id>`, the loop crate's `MessageWindow` (D23), `WM_COPYDATA` | `Err(unported("singleInstance"))` |
| `url_scheme::register(&str, &Registration) -> Result<(), ShellError>`, `unregister(&str) -> Result<(), ShellError>` (`src/url_scheme.rs`, stand-in `mod imp` at 87-101) | `HKCU\Software\Classes\<scheme>` through `windows-registry` (D23) | `Ok(())` after validation: macOS reads schemes from the bundle's `Info.plist`, as today's `packages/sweetview-native/src/darwin/activation.ts` (lines 63-70) also does; correct for macOS |
| `icons::refresh_shell_icons()` (`src/icons.rs`) | `SHChangeNotify(SHCNE_ASSOCCHANGED)` | no-op (documented) |

Shared helpers that carry Windows names: `mutex_name` (`Local\...`, `single_instance.rs` line 41), `scheme_key`/`registry_values` (`url_scheme.rs` lines 44-58), `decode_unicode_text`/`encode_unicode_text` (`clipboard.rs` lines 16-25). The crate's test serialisation is `#[cfg(all(test, windows))]` (`src/lib.rs` lines 47-53).

### 3.7 Windows-shaped code in `sweetview-runtime`, `sweetview-napi` and `sweetview-platform-node`

`sweetview-napi` and `sweetview-platform-node` have no platform gate. `sweetview-runtime`'s gates:

| File, lines | What it gates | Off Windows today | macOS needs |
|---|---|---|---|
| `src/runtime.rs` 361-373 | `build_event_loop()` | `EventLoopBuilder::new().build()` (Windows adds `with_any_thread(true)`, D6) | not confirmed whether `tao` on macOS accepts the Bun main thread without complaint; it is the process's main thread when Bun runs a script |
| `src/engine.rs` 765-796 | the WebView2 environment (a thread-local made once), `configure_for_platform` | `Ok(builder)` | the `WKWebViewConfiguration` with Sweetview's scheme handler (M0.5), and the data store today's library uses (section 5, D15) |
| `src/engine.rs` 798-807 | `window_value_of(&TaoWindow) -> isize` | `0` | the `NSWindow` pointer |
| `src/engine.rs` 809-818 | `reparent(&WebView, &ForeignWindow) -> Result<(), wry::Error>` | `Ok(())` without moving anything | `wry` 0.58.2 has `WebViewExtMacOS::reparent(&self, window: *mut NSWindow)` (`src/lib.rs` line 2559 of that crate) |
| `src/bridge.rs` 13-17 | `POST_FUNCTION` | `window.webkit.messageHandlers.__webview__.postMessage` | already the macOS form; the script message handler Sweetview adds must be named `__webview__` |
| `src/tray.rs` 88, 261-289 | `SIID_APPLICATION`, the stock icon (`with_stock_icon`, `set_stock_icon`), `window_handle_of(&TrayIcon)` | builder unchanged / `set_icon(None)` / `0` | a macOS default icon; the menu owner (below) |
| `src/tray.rs` 389-398 | `window_handle_value(&tao Window)` | `0`, so the tray menu's owner, a `ForeignWindow::from_handle_value` at `tray.rs` line 385, is `None` and the menu fails with "the tray menu's window is gone" | the macOS tray menu path |
| `src/window.rs` 927-944 | `platform_builder(WindowBuilder, Option<&TabState>)` | builder unchanged (Windows: no `tao` drop target, the undecorated shadow and backdrop colour for a tab frame, D22) | macOS builder options (overlays, tabbing identifier) |
| tests | `#[cfg(all(test, windows))]` in `runtime.rs` 376/407, `window.rs` 977 (`window_tests.rs`), `activation.rs` 69, `clipboard.rs` 33, `notify.rs` 98, `screen.rs` 95 | not compiled | the runtime's tests run on macOS too |

Code that is not gated but leans on Windows-only answers of the platform crates:

- The page-operation queue of D21 (`src/engine.rs` lines 600-662: `page_op`, `release_held`, `run_page_op`) holds `navigate`, `setHTML`, `eval`, a binding's reply and the bridge's notices while `WebviewExtras::scripts_pending()` is true, and calls `stop_navigation` for a held navigation; the handler set from line 288 releases them on a later turn through `Runtime::defer`. With a `scripts_pending` that is always `false` the queue never holds, which is correct only if a script added on macOS is in effect for every navigation asked for after `add_user_script` returns. Candidate (not confirmed through `wry`): `WKUserContentController addUserScript:` takes effect for documents created afterwards with no completion to wait for.
- `Engine::moves_told` (`src/engine.rs` lines 414-425; exported as `movesTold` from `crates/sweetview-platform-node/src/engine.rs` line 89, used by `packages/sweetview/test/fixtures/win-tabs.ts`) counts calls of `notify_parent_window_position_changed` that reached a live webview. Any implementation that returns `()` counts every call, whether or not anything was told.

Windows-only concepts in public signatures:

- Window handles as `isize`, documented as the `HWND`: `Window::adopt(handle: isize)` and `Window::handle()` (`sweetview-runtime/src/window.rs` lines 551, 580-581), `tracked_count`, `mount_target` (949, 962), `Engine::window_handle()` and `reparent(window: isize)` (`engine.rs` 337, 428), `dialogs::pick_folder(owner: Option<isize>)` (`dialogs.rs` 13), `menu::popup(owner: isize)` (`menu.rs` 190), `screen::of_window` (`screen.rs` 70), `TabFrame::of` (`window/tab_frame.rs` 149). Each turns the value into a `ForeignWindow` with `from_handle_value` (`dialogs.rs` 18, `menu.rs` 196, `screen.rs` 71, `window.rs` 560 and 966, `tray.rs` 385, `window/tab_frame.rs` 351). In the binding: `sweetview-napi/src/menus.rs` lines 20-23 ("a `bigint` holding the `HWND`'s value"), `window.rs` 19-29, `engine.rs` 57-59. The window registry is keyed by that value (`WINDOWS: HashMap<isize, Rc<Core>>`, `sweetview-runtime/src/window.rs` lines 161-169, filled at 493 for a made window and 567 for an adopted one), so the macOS `handle_value` must be unique per window, not `0`.
- Notifier test hooks: `sweetview-runtime/src/notify.rs` lines 51-89 (with `set_toast_life` at 62) and `sweetview-napi/src/notify.rs` lines 61-134 (`debug_force_path` with `balloonOnly`, `toastShowFails`, `toastHeld`; `debug_show` answering `"toast:<cookie>"` / `"balloon:<uid>"`; `debug_set_toast_life`, `debug_balloons_shown` and the other `debug_*` counters), exported from `sweetview-platform-node/src/notify.rs` (lines 53-108).
- WebView2 and COM: `engine.rs` lines 228 and 786, error texts "is the WebView2 runtime installed?"; `runtime.rs` enters a `ComApartment`; `KeyData.virtual_key` passes through `sweetview-napi/src/engine.rs` (lines 44, 227).
- Extended styles: `ExStylePolicy`, `apply_ex_style`, `set_layered_attributes` with a `COLORREF` colour key (`sweetview-runtime/src/window.rs` lines 145-230 and 515-524).
- The tab frame: `sweetview-napi/src/tab_frame.rs` (header "for the Windows tabs library"), `sweetview-platform-node/src/tab_frame.rs` line 10 and `types.rs` line 104 ("Windows:"); the runtime side, `sweetview-runtime/src/window/tab_frame.rs`, installs `FrameMessages` with its error discarded (line 129) and reads `system_is_dark` (lines 58, 340-341).
- The macOS-only app settings are no-ops on every platform: `install_app_menu`, `set_app_icon`, `set_activation_policy` return `Ok(())` with no gate (`sweetview-runtime/src/app.rs` lines 23-35; the comment at 8-9 says macOS keeps its implementation in the native package until the macOS goal).

### 3.8 Windows-shaped values in `sweetview-window-logic`

No gate; compiles everywhere. `geometry` works in "outer-frame physical pixels" (crate `README.md`), while macOS windows and screens are in points with a flipped y axis (M3.6). `style` holds `WS_EX_*` bits and `ExStylePolicy` (`src/style.rs` lines 6-13); `color` turns `#rrggbb` into a `COLORREF` (`src/color.rs` line 3). `hit`, `resize`, `screen` and `ico` are platform-neutral logic.

## 4. The TypeScript seams

| Seam | How it chooses today | What the macOS goal changes |
|---|---|---|
| `packages/sweetview-native/src/platform.ts` line 8, `backend<T>(win32: () => T, darwin: () => T): () => T` | picks once by `process.platform`, with literal `require("./win32/...")` / `require("./darwin/...")` thunks so public functions stay synchronous; any other platform throws | each darwin thunk goes to the binding. Call sites: `activation.ts` 84, `app-icon.ts` 16, `app-menu.ts` 10, `clipboard.ts` 9, `event-loop.ts` 23 and 30, `folder-picker.ts` 7, `menu.ts` 45, `notifications.ts` 43, `screen.ts` 29, `tray.ts` 40, `window.ts` 172. Suggestion: where the `win32/` module is now only binding calls, point both arms at one module and drop `backend` for it |
| `packages/sweetview-native/src/binding.ts` lines 32-45 | `switch` on `${process.platform}-${process.arch}`; only `case "win32-x64"` with the literal `require("../prebuilt/sweetview.win32-x64-msvc.node")`; every other target throws; `SWEETVIEW_NATIVE_PATH` overrides | add `case "darwin-arm64"` and `case "darwin-x64"`, each with its own literal `require` (the literal form is what `bun build --compile` embeds, header lines 3-4) |
| `packages/sweetview-native/src/darwin/library.ts` | the only importer of `@n1h/sweetview-webview-bun`: top-level `await import()` inside `try`, so a Windows bundle builds without it | deleted (R5) |
| `packages/sweetview-native/src/webview.ts` line 136, `input-hooks.ts` line 88, `permissions.ts` line 80 | top-level `process.platform === "darwin" ? await import("./darwin/webview" or "./darwin/input") : undefined`, with `if (onDarwin) return darwin()...` branches (`webview.ts` 158, 187, 205, 217, 268, 328); the other side is `binding()` | the darwin branches and `darwin/webview.ts`, `darwin/input.ts` go; one path through `binding()`. `webview.ts` lines 419 and 428 already give the macOS origins |
| `packages/sweetview/src/webview-host.ts` lines 103-108, `webviewEngine()` | darwin: `require("./darwin-webview-host").libraryEngine()`; otherwise `{ hasRequests: true, host: bindingHost }` | darwin takes `bindingHost`; the `WorkerWake` `kind: "library"` variant (lines 16-18) goes |
| `packages/sweetview/src/worker-wake.ts` lines 10-16 | `kind === "native"` uses `wakeNative(token)`; otherwise `require("./darwin-worker-wake").libraryWake(wake)` | only the native wake remains |
| `packages/sweetview/src/tabs/index.ts` lines 17-20 | `await import("./win-tabs")` or `await import("./darwin-tabs")` | the darwin driver is rebuilt on the binding (M6) |
| `packages/sweetview-native/package.json` | `napi`: `binaryName: "sweetview"`, `targets: ["x86_64-pc-windows-msvc"]` (41-46); `files` includes `prebuilt/*.node` and `prebuilt/binding.d.ts` (15-22); optional peer `@n1h/sweetview-webview-bun` `^2.7.0` (50-57); `exports` include `./darwin/objc`, `./darwin/screen`, `./darwin/tabs`, `./darwin/window` (33-36) | add `aarch64-apple-darwin` and `x86_64-apple-darwin` to `targets`; remove the peer; the `./darwin/*` export rows in `docs/upgrading.md` (from line 1236 to line 1386) say "unchanged; macOS only, until the macOS goal" and change with it |
| root `justfile` line 19, `just native` | `bunx napi build --platform --release --cwd packages/sweetview-native --manifest-path ../../crates/sweetview-platform-node/Cargo.toml --output-dir prebuilt --no-js --dts binding.d.ts`; the recipe shell is `pwsh` (line 4); `mod webview` (line 7) holds the C++ library recipes | `--platform` already names the output for the host target. `pwsh` must be installed on the Mac, or the shell setting changes (shared file, R8). `mod webview` and `webview/` go or are rewritten (M8.2) |

Files still importing `bun:ffi` that the macOS goal removes (the ten macOS-only sources in `rust-rewrite/ffi-allowlist.txt` at `f88ceb4`, confirmed with `git grep -l -E "(from|import\()[[:space:]]*[\"']bun:ffi[\"']|require\([\"']bun:ffi[\"']\)" -- packages demos`, which lists 28 files: these ten and 18 probes):

- `packages/sweetview-native/src/darwin/activation.ts`
- `packages/sweetview-native/src/darwin/core-foundation.ts`
- `packages/sweetview-native/src/darwin/event-loop.ts`
- `packages/sweetview-native/src/darwin/notifier.ts`
- `packages/sweetview-native/src/darwin/objc.ts`
- `packages/sweetview-native/src/darwin/window.ts`
- `packages/sweetview/src/darwin-webview-host.ts`
- `packages/sweetview/src/darwin-webview-lib.ts`
- `packages/sweetview/src/darwin-worker-wake.ts`
- `packages/sweetview/src/tabs/darwin-webview.ts`

The macOS probes already listed (`packages/sweetview-native/src/darwin/activation.test.ts`, `packages/sweetview/src/app.test.ts`, `packages/sweetview/test/fixtures/webview-file-drop.darwin.ts`, `demos/native-tabs/scripts/mac-capture.ts`) may stay as `probe:` entries.

The rule the `ffi` check applies (`rust-rewrite/verify.ts` lines 86-119): every file under `packages/` or `demos/` that imports `bun:ffi` must be in the allowlist. A `probe:` entry under `packages/` must be a `*.test.ts` or under a `test/` folder. A `setup:` entry is printed each run, and more than three fail. Any other reason fails on `macos` and `linux` ("only probes and setup files may remain after the macos goal"); on `windows` it passes only for a macOS-only file. So after the macOS goal (`bun rust-rewrite/verify.ts macos`), the list holds probes and at most three `setup:` files, each saying what it sets up and why N-API cannot (R3).

The `engine` check (`verify.ts` lines 122-126) on `macos` passes only when no `package.json` names `sweetview-webview-bun`. At `f88ceb4` seven do: the root `package.json`, `packages/sweetview-native/package.json`, `packages/sweetview/package.json`, `demos/desktop-pet/package.json`, `demos/menubar-notify/package.json`, `demos/native-tabs/package.json`, `demos/web-app/package.json`. It does not look at source, docs or `bun.lock`.

## 5. What the Windows work learned that changes `CHECKLIST-macos.md`

### 5.1 Decisions, one by one (`rust-rewrite/DECISIONS.md`)

| Decision | macOS |
|---|---|
| D1 crate boundaries | carries over as is: macOS modules go into the same platform crates, behind the gate of section 3.0 |
| D2 binding in two crates (`#[napi]` cannot compile under `#![forbid(unsafe_code)]`: E0453 from `ctor`'s `#[allow(unsafe_code)]`) | carries over as is; new exports go into `sweetview-platform-node` as one-line forwards, behaviour into `sweetview-napi` |
| D3 wakes, deferred jobs and native timeouts through a message-only window, not `tao`; `request_exit` sends a `tao` user event; due timers taken after each pump | carries over with a macOS mechanism to be chosen. Windows found that `tao`'s `run_return` buffers events while its handler runs and calls its handler only for its own messages. Not confirmed whether `tao`'s macOS backend behaves the same; assume it does until M0 proves otherwise. Candidates (not facts): a `CFRunLoopSource` signalled from any thread and a `CFRunLoopTimer`, both added to `kCFRunLoopCommonModes` so they fire in AppKit's modal and event-tracking modes; or the main dispatch queue. The `SignalWindow`/`Waker` signatures of section 3.1 are the contract |
| D4 `LoopHost` keeps a clone of the loop's window target and lends it whether or not a run is in progress (no `unsafe`; rewritten by the safety pass) | carries over as is; the code is shared (`crates/sweetview-platform-loop/src/loop_host.rs`) and type-checks for macOS (section 2). Not confirmed: that a clone of `tao`'s macOS `EventLoopWindowTarget` shares the loop's state as the Windows one does (D4 states it for `tao` 0.38 on Windows). WebKit delegate callbacks arrive outside `tao`'s handler just as WebView2's do |
| D5 built `.node` not tracked; `binding.d.ts` tracked | carries over; the macOS binaries are built by `just native` on a Mac and by CI. `binding.d.ts` is generated from the same Rust on both platforms and must come out identical |
| D6 UI thread = the thread that loads the binding first; `tao` with `with_any_thread(true)` | the rule carries over (`sweetview_runtime::threads`). `with_any_thread` is a Windows builder extension here (`runtime.rs` line 363); AppKit requires its own main thread, which is Bun's main thread when Bun runs a script. Entry points that touch AppKit take a `MainThreadMarker` (UNSAFE-POLICY) |
| D7 exceptions logged by the TypeScript wrapper, binding as backstop (`sweetview: <kind> threw: <reason>`) | carries over as is (shared TypeScript and `sweetview-napi/src/callback.rs`) |
| D8 windows by `tao`; events and extended styles through one subclass | Windows-only in mechanism. The need carries over: events must arrive synchronously inside any loop, and `Window.fromHandle` must observe a window `tao` did not make. Candidates: `NSNotificationCenter` observers for `NSWindowDidResizeNotification`, `NSWindowDidMoveNotification`, `NSWindowWillCloseNotification` (today's `darwin/window.ts` uses observers, per its allowlist reason), and a delegate or `windowShouldClose:` route for the close request. The style policy has no macOS counterpart; overlay properties are `setLevel`, `setCollectionBehavior`, `setIgnoresMouseEvents` (proposal) |
| D9 show by the platform crate, then tell `tao` | carries over with a macOS mechanism: if `tao`'s macOS `set_visible(true)` makes the window key (not confirmed), `noActivate` windows need `orderFront:`/`orderFrontRegardless` instead (candidates) |
| D10 a quit outside a blocking run waits for the next pump | carries over as is (runtime logic); `discard_quit` (section 3.1) needs a macOS meaning, likely "clear the flag" only |
| D11 one pump dispatches everything waiting (256 rounds, then due timers) | carries over; `messages_waiting()` needs a macOS answer. Candidate: `nextEventMatchingMask:untilDate:inMode:dequeue:` with `dequeue: NO` and a past date |
| D12 positional types where an object would need `unsafe`; callback types written out | carries over as is |
| D13 tray events queued, never run inside `tray-icon`'s callback | carries over as is (runtime). The single/double click rule uses `double_click_time_ms()`, whose stand-in is 500; candidate `NSEvent.doubleClickInterval`. M4.1 also says any click opens the menu when one is set, which differs from Windows |
| D14 menus built fresh per showing; 16 pixel icons; `check_item` for icon plus check | built-fresh carries over. The 16 pixel size and `check_item` are Windows `muda` facts; not confirmed what `muda` 0.22.0 does with an icon and a check on macOS. Popups: candidate `muda`'s `show_context_menu_for_nsview` (proposal), with the owner a `ForeignWindow` naming the `NSWindow` (`show_popup`, section 3.4) |
| D15 WebView2 environment created the C++ library's way, once per process | Windows-only in mechanism; the reason carries over: an upgraded application must keep its cookies and storage. Suggestion: find which `WKWebsiteDataStore` the C++ library uses on macOS and configure `wry` to the same |
| D16 a page message is answered on a later turn; a webview is dropped only when none of its callbacks is on the stack | carries over as is (`sweetview-runtime/src/engine.rs`), provided the macOS script message handler and scheme handler enter the runtime the same way |
| D17 dropped files reach the host as one string message with attached `ICoreWebView2File` objects | Windows-only. macOS uses `wry`'s `with_drag_drop_handler` with the route kept from Enter to Drop or Leave (proposal table, M0.5, M1.6). `FILE_DROP_SCRIPT` in `crates/sweetview-platform-webview/src/lib.rs` is Windows-only |
| D18 the macOS seam is one module per shared file; the bindings package loads only on macOS | the macOS goal removes it (section 4) |
| D19 no list of dependent applications made | carries over; `rust-rewrite/local/dependents.txt` is machine-local and the owner's |
| D20 tests corrected because they measured the machine | carries over as method: a test that shows real notifications hides them and does not depend on the platform keeping one on screen; handle and object counts are read once they stop moving and growth is compared with a baseline loop; input that drives an OS modal loop is injected as a device would make it. Tests' notifications carry no banner and expire by themselves (`set_toast_life`), and routed events go to notifications held back from the platform (`ForcedPath::ToastHeld`); a move-loop check waits inside the loop until the window arrives and lays out from the work area. macOS counterparts (not confirmed on a hosted runner): notification authorisation and banners need a bundle; event taps and synthetic input need Accessibility permission; the macOS notifier's test hooks (M4.3) need the same two properties: no notification left on screen, and events a test delivers that the platform cannot race |
| D21 adding a user script does not wait; navigations, evaluations, replies and the bridge's notices wait for registrations in one ordered queue (`crates/sweetview-runtime/src/engine.rs`) | the queue carries over as is (shared runtime code). The mechanism is Windows-only: WebView2 registers asynchronously. On macOS, `scripts_pending` answers `false` and `stop_navigation` is never needed if a `WKUserScript` added to the `WKUserContentController` is in effect for every document created after the call (candidate, not confirmed through `wry`'s `manager()`). If it is not, the macOS module counts registrations and calls the registered handler as the Windows one does |
| D22 the tab frame is `tao`'s undecorated window; a second subclass procedure (`FrameMessages`) paints the backdrop and answers `WM_DPICHANGED`; the tab context menu is this project's own synchronous popup | Windows-only: macOS tabs are AppKit's (M6). The macOS module of `sweetview-platform-window` still has to expose `FrameMessages`, `Backdrop`, `popup_menu` and the rest of section 3.4's tab frame table with the same signatures, because the runtime calls them unconditionally; each may answer with an error |
| D23 the safety pass: `windows-registry` and `dirs` added; `MessageWindow`, `Poster`, the pump calls and the handle counts shared in `sweetview-platform-loop`; both subclass procedures safe functions; `move_focus` replaced by `wry`'s `WebView::focus`; `rust-rewrite/UNSAFE-LEDGER.md` (217 uses in 20 files at `f88ceb4`) | the method carries over as is: every macOS `unsafe` block goes through `UNSAFE-POLICY.md`, and `bun rust-rewrite/verify.ts <platform> --ledger` (header of `rust-rewrite/UNSAFE-LEDGER.md`) rewrites the ledger with the macOS files. The two crates are Windows-only dependencies. The shared message window is Windows-only; a macOS module that needs a cross-thread poster or a run-loop pump puts its one owning type in `sweetview-platform-loop` the same way (suggestion). `resource_counts` and `testing` need a macOS meaning before any count-based test ports (section 7) |

### 5.2 The proposal's "Risks and actions" (`SWEETVIEW-RESTART-PROPOSAL.md` lines 675-686)

| Risk | macOS |
|---|---|
| The two loop mechanisms are proven on Windows only (line 679) | needs a macOS mechanism; the proposal's fallback is `NSApplication::nextEventMatchingMask_untilDate_inMode_dequeue` plus `sendEvent` (M0.3). The wake and timer question of D3 must be proven in the same step |
| The tray proof used posted messages (line 680) | carries over: M4.5 clicks by hand |
| Every rebuilt module can behave differently (line 681) | carries over as is |
| A `Worker` cannot load the binding twice or wake the UI thread (line 682) | W1.7 proved it on Windows; the fallback named (`PostMessageW` through `bun:ffi`) is Windows-only. Needs re-proof on a Mac; candidate fallback: a `CFRunLoopSource` signalled from the worker's thread |
| `tao` queues window events while its handler runs (line 683) | needs a macOS mechanism: the Windows answer (WebView2 callbacks plus the wake message, D3, D8) does not transfer; see D3 and D8 above |
| A later `wry` changes a native object this project builds on (line 684) | carries over with more exposure: four of the five behaviours built on `wry`'s native objects are macOS-only (scheme handler, `manager()` script handler, navigation delegate, drag routing) |
| `unsafe` spreads (line 685) | carries over as is; the proposal (line 306) lists where macOS needs `unsafe` |
| `tao`'s undecorated window loses the tab frame's border (line 686) | Windows-only: macOS tabs are AppKit's |

### 5.3 By item of `CHECKLIST-macos.md`

- M0.1: nothing changes.
- M0.2 "The three proofs of `rust-rewrite/spike/` pass on this Mac": `rust-rewrite/spike/spike.ts` drives the tray proof with `bun:ffi` calls into `user32` (posted `WM_USER_TRAYICON` messages), so the tray half needs a macOS driver. The spike wakes through `EventLoopProxy`, which on Windows proved insufficient (D3); passing the spike does not settle wakes inside a modal loop. W1.6 (`bun build --compile` embedding the binding in a demo) is ticked on Windows; its evidence is `rust-rewrite/evidence/w1-compiled-alone.txt`.
- M0.3 "If the timer-pumped loop fails on macOS under `tao`'s `run_return` ...": widen it. Before anything else, port `sweetview-platform-loop` (section 3.1), because `Runtime::new` fails without the signal window (`crates/sweetview-runtime/src/runtime.rs` lines 121-126). Prove, under both loop modes, that a wake from a worker, a deferred job and a native timeout each run while a handler holds an AppKit modal loop open (an `NSAlert` `runModal`, a popup menu, a window resize), as W1.8 did on Windows. Record the mechanism in `DECISIONS.md`.
- M0.4 CI: `.github/workflows/windows.yml` is the only workflow. Add a macOS job; add both Apple targets to the `napi` block; make `just` run there (`pwsh` shell, root `justfile` line 4). The hosted Windows runner dismissed toasts at once and did not let `SetCursorPos` reach a move loop (D20); expect the hosted macOS runner to differ from a desk machine in notifications, TCC permissions and synthetic input, and write tests that do not depend on them (not confirmed what it does).
- M0.5: the four rows are as the proposal states. Add: the script message handler is named `__webview__`, because the page bridge already posts to `window.webkit.messageHandlers.__webview__` (`crates/sweetview-runtime/src/bridge.rs` line 17).
- M1.1 "Every member of `RawWebview`, as in W2.1": `configure_for_platform`, `window_value_of` and `reparent` in `crates/sweetview-runtime/src/engine.rs` (lines 777-818) are the runtime's macOS seams; `WebviewExtras` (section 3.2) is the platform contract. D16 applies unchanged. D21's queue (`engine.rs` lines 600-662) runs on macOS as written; what the macOS `scripts_pending`, `set_scripts_registered_handler` and `stop_navigation` must do follows from whether a script added on macOS is in effect for the next document at once (section 5.1, D21). D21 names the scenario that failed before the queue: `navigate`, then `bind`, then `eval` on a new webview; the `eval` must run in the navigated document, and `bind`, `init` and `unbind` must return while the navigation's response comes from a `Bun.serve` on the UI thread.
- M1.2: origins and asset rules are already in `sweetview-http` (`MACOS_ASSET_ORIGIN`, `route_request`).
- M1.3 "`setBackgroundColor` with any alpha": Windows refuses alpha other than 0 and 255 (WebView2's limit); macOS accepts any. The shared check must be per platform.
- M1.4, M1.5: the stand-in's `responder()` panics (section 3.2); the macOS `Responder` must answer from any thread as on Windows (`completeWebviewRequest` from a worker).
- M1.6: D17 is Windows-only; use the proposal's drag routing.
- M1.7: the injected bridge script already returns early in frames other than the top-level document (`bridge.rs`); the native handler still checks `frameInfo.isMainFrame` (proposal line 239).
- M1.8: the webview crate's tests are all `#![cfg(windows)]`; macOS needs crate tests of its own. Teardown growth is measured against a baseline loop, and the smaller growth of two runs counts (D20, `crates/sweetview-platform-loop/src/testing.rs`); on macOS `resource_counts` answers zeros today (section 3.1), so such a test proves nothing until it has a macOS meaning.
- M2.1: call `sweetview_keycodes::mac` and `dom_code_from_mac_keycode`. The tap's run-loop source must fire inside modal loops as the Windows hooks do (common modes, candidate). A hook is not `Send` and one of each kind exists per process (`crates/sweetview-platform-input/README.md`).
- M2.2: replace the macOS arm of `crates/sweetview-platform-input/src/permissions.rs` (lines 165-180), which always answers `Missing` and never asks. Candidates from the proposal: `CGPreflightPostEventAccess`, `CGRequestPostEventAccess`.
- M3.1: D10 and D11 carry; `messages_waiting` and `discard_quit` need macOS meanings.
- M3.2 "`handle` is the real `NSWindow` pointer": the window registry is keyed by `handle_value` (section 3.7); the stand-in's `0` would make every window share one record. Events: D8 above.
- M3.3: no `ExStylePolicy` on macOS; the runtime calls `apply_ex_style` and `set_layered_attributes` unconditionally (`crates/sweetview-runtime/src/window.rs` lines 226 and 523), so those calls need a per-platform route.
- M3.4: the hit-region poll and the "no flip while a button is down" rule are shared (`sweetview-window-logic::hit`); `mouse_buttons_down` on macOS: candidate `NSEvent.pressedMouseButtons` (proposal).
- M3.5: `startDrag`: candidate `performWindowDragWithEvent:` (not confirmed). The macOS test already avoids real input (`packages/sweetview/src/app.test.ts` warps the cursor with `CGWarpMouseCursorPosition`).
- M3.6 "points and the flipped y axis": `sweetview-window-logic::geometry` is in physical pixels (section 3.8); decide where points are converted. `work_area` on macOS: candidate `NSScreen.visibleFrame`.
- M4.1: D13 carries. The tray menu owner path makes a hidden `tao` window and names it as a `ForeignWindow` by its handle value, which fails off Windows (`crates/sweetview-runtime/src/tray.rs` lines 376-398).
- M4.2: see D14.
- M4.3: the notifier's shared types and the binding's test hooks are toast and balloon shaped (section 3.5, 3.7); decide what the macOS test hooks are, including counterparts of `set_toast_life` (no banner, removed by the platform) and `ForcedPath::ToastHeld` (events only a test delivers). Tests follow D20.
- M4.4: `install_app_menu`, `set_app_icon`, `set_activation_policy` return `Ok(())` on every platform today (`crates/sweetview-runtime/src/app.rs` lines 23-35); the clipboard stand-in errors. Activation policy changes before the loop starts (`EventLoopExtMacOS::set_activation_policy`, proposal line 153).
- M5.1: `url_scheme` correctly does nothing at run time on macOS. `onOpenUrl` is buffered until `signalReady`; the open-URL event must reach the runtime inside any loop (candidate: `tao`'s `Event::Opened`, proposal line 637, subject to the D3 caveat about `tao`'s handler).
- M5.2: `single_instance` is a stand-in; the wire format is today's `CFMessagePort` (proposal lines 301, 636). `mutex_name` is Windows-only.
- M6.1, M6.2: the Rust tab frame (`tab_frame.rs`, `sweetview-napi/src/tab_frame.rs`) is the Windows strip and has no meaning on macOS; macOS tabs use AppKit tabbing (proposal lines 610-623). W7.1 and W7.2 are ticked on Windows (D22); the tab state machines are shared TypeScript, so a change to them for macOS reruns the Windows tab checks (`packages/sweetview/test/fixtures/win-tabs.ts`, `win-tabs-input.ts`, `demos/native-tabs/scripts/win-drive.ts`). The macOS `sweetview-platform-window` module still exposes the tab frame items of section 3.4, because the runtime calls them on every platform.
- M7.1: `binding.ts` needs a literal `require` per Apple target; the published package carries what CI builds (D5, `files` includes `prebuilt/*.node`).
- M7.2 "from Windows for the macOS target": the Windows machine needs the macOS `.node` files in `prebuilt/` to compile a macOS executable; they are not tracked (D5), so they come from CI or a Mac.
- M8.1: see section 4 for the rule.
- M8.2: seven `package.json` files name the bindings package (section 4); `mod webview` in the root `justfile` and `webview/` go.
- M8.3: `docs/upgrading.md` lines 48-49, 107, 138 and 160-162 tell macOS readers to keep `@n1h/sweetview-webview-bun`, line 531 moves the `dlopen` helpers to `darwin-webview-lib.ts` "until the macOS goal", and the rows from line 1236 to line 1386 cover the `./darwin/*` exports. `docs/webview-library.md`, `docs/app.md` and `docs/native.md` describe the macOS library path.
- M8.4: see section 6.
- M9.1 to M9.4: nothing changes.

### 5.4 Not covered by any item

Proposed item texts (suggestions; the checklist is not edited here):

- "M0.6 `sweetview-platform-loop` has a macOS module: `SignalWindow`, `Waker`, `messages_waiting`, `discard_quit`, `dispatch_waiting` and `resource_counts` with the signatures of the Windows module, and a test shows a wake, a deferred job and a native timeout delivered while an AppKit modal loop runs, in both loop modes." (Covers D3; nothing in M0 to M3 names it, and the runtime cannot start without it.)
- "M0.7 `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` pass on macOS, with the runtime's tests (`#[cfg(all(test, windows))]` today) running there." (No macOS item runs the Rust tests.)
- "M3.8 Every window, owned or adopted, has a distinct non-zero handle value, and `Window.handle` is that value." (Section 3.7; M3.2 names the pointer but not the registry.)
- "M8.5 Every binding export with no meaning on macOS (the tab frame, the notifier's toast and balloon test hooks) either has a macOS meaning or throws a documented error there, and `docs/upgrading.md` says which." (Section 7.)
- "M8.6 Each platform crate selects its macOS module with `cfg(target_os = "macos")`, and the stand-ins stay behind `cfg(not(any(windows, target_os = "macos")))` for Linux." (Section 3.0.)

## 6. Shared files the macOS goal will touch, and what must keep passing on Windows

Shared Rust (compiled on both platforms):

- `Cargo.toml`, `Cargo.lock`.
- `crates/sweetview-runtime/src/*` (in particular `runtime.rs`, `engine.rs`, `window.rs`, `tray.rs`, `app.rs`, `notify.rs`, `bridge.rs`, `screen.rs`), `crates/sweetview-napi/src/*`, `crates/sweetview-platform-node/src/*`, and the generated `packages/sweetview-native/prebuilt/binding.d.ts`.
- `crates/sweetview-http`, `crates/sweetview-keycodes`, `crates/sweetview-window-logic`.
- Each platform crate's `lib.rs`, `Cargo.toml`, `loop_host.rs`, `com.rs`, `signal.rs`, `testing.rs` (the loop crate's count helpers, D23), `permissions.rs`, the webview crate's `shared.rs` and `stream.rs`, and the shared modules `metrics.rs`, `popup.rs`, `size_hint.rs`, `clipboard.rs`, `single_instance.rs`, `url_scheme.rs`, `icons.rs`.

Shared TypeScript and tooling:

- `packages/sweetview-native/src/`: `platform.ts`, `binding.ts`, `webview.ts`, `input-hooks.ts`, `permissions.ts`, the `backend` front modules listed in section 4, `internal.ts`, `index.ts`; `packages/sweetview-native/package.json`.
- `packages/sweetview/src/`: `webview-host.ts`, `worker-wake.ts`, `app.ts`, `tabs/index.ts`; `packages/sweetview/package.json`.
- Root `package.json`, `justfile`, `.github/workflows/`, `rust-rewrite/verify.ts`, `rust-rewrite/ffi-allowlist.txt`, `rust-rewrite/UNSAFE-LEDGER.md` (rewritten by `verify.ts --ledger`), `docs/`.
Run on Windows after each change to a shared file (R8, M8.4), from the repository root:

```
just native
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run typecheck
bun test
bun rust-rewrite/verify.ts windows
```

The Windows job of the workflow runs the first five; it is the evidence for M8.4.

## 7. Open points handed over

- `crates/sweetview-runtime/src/runtime.rs` lines 121-126: `Runtime::new` fails off Windows because the signal window stand-in (`crates/sweetview-platform-loop/src/unported.rs` lines 23-25) returns an error; nothing of the runtime can run on macOS until that module is ported.
- `crates/sweetview-platform-loop/src/unported.rs` lines 60-65: `dispatch_waiting` does nothing and `resource_counts` answers zeros, so every count-based check built on `crates/sweetview-platform-loop/src/testing.rs` (`settled_counts`, `smallest_growth`) or `crates/sweetview-platform-window` `handle_counts` would pass on macOS without measuring anything; an error or a gated test would be more honest until macOS counts exist.
- `crates/sweetview-platform-window/src/unported.rs` line 56: `handle_value` returns `0`, and `crates/sweetview-runtime/src/window.rs` lines 161-169, 493 and 567 key every window by it; two windows would share one record.
- `crates/sweetview-platform-window/src/unported.rs` line 35: `ForeignWindow::from_handle_value` answers `None`, and the runtime treats that as "no owner": `crates/sweetview-runtime/src/dialogs.rs` line 18 shows the folder dialog unowned, and `crates/sweetview-runtime/src/menu.rs` line 196 makes `Menu.popup` return `Ok(None)` ("nothing chosen") without showing a menu. On macOS today a popup menu reports a dismissal that never happened.
- `crates/sweetview-runtime/src/engine.rs` lines 798-818: off Windows, `window_value_of` returns `0` and `reparent` returns `Ok(())` without moving the webview (success where nothing happened).
- `crates/sweetview-runtime/src/tray.rs` lines 281-289: off Windows the tray's window handle is `0`, so the tray menu's owner (`ForeignWindow::from_handle_value` at line 385) is `None` and the tray menu fails.
- `crates/sweetview-runtime/src/app.rs` lines 23-35: `install_app_menu`, `set_app_icon`, `set_activation_policy` report success on macOS and do nothing, with no gate; a macOS application on the binding would lose its app menu, Dock icon and activation policy silently.
- `crates/sweetview-platform-input/src/permissions.rs` lines 165-180: the macOS arm always reports `Missing` and `request` asks the system nothing.
- `crates/sweetview-platform-webview/src/unported.rs` lines 65-67: `responder()` panics with `unreachable!`; unreachable today only because `attach` always fails.
- `crates/sweetview-platform-webview/src/unported.rs` lines 44-52: `scripts_pending` answers `false` and `set_scripts_registered_handler` and `stop_navigation` do nothing, so on macOS D21's queue (`crates/sweetview-runtime/src/engine.rs` lines 600-662) never holds anything. That is correct only if a user script added on macOS is in effect for the next document as soon as `add_user_script` returns (not confirmed through `wry`); otherwise a navigation right after `bind` or `init` can create its document without the script, the race D21 closed on Windows.
- `crates/sweetview-runtime/src/engine.rs` lines 414-425: `notify_moved` counts a move as told (`moves_told`, the `movesTold` test hook) whenever the webview is live, because `notify_parent_window_position_changed` returns `()`; a macOS no-op there makes the hook report moves nothing received.
- `crates/sweetview-platform-window/src/unported.rs`: `is_window` and `is_visible` answer `false`, `dpi_scale` `1.0`, `chrome` "framed and resizable", and `show`, `hide`, `minimize`, `toggle_zoom`, `bring_to_front`, `apply_ex_style` do nothing silently (lines 59-119); `crates/sweetview-platform-window/src/metrics.rs` lines 30-38 answer 500 ms and 16 pixels.
- `crates/sweetview-platform-notify/src/lib.rs` lines 57-102 and `crates/sweetview-napi/src/notify.rs` lines 61-134: the notifier's result type and test hooks (now with `set_toast_life` and `balloons_shown`) are toast and balloon shaped; they have no macOS meaning as written.
- `crates/sweetview-napi/src/tab_frame.rs` (whole module) and `crates/sweetview-platform-node/src/tab_frame.rs` line 10: the tab frame API is the Windows tab strip and has no macOS meaning; `crates/sweetview-platform-window/src/tab_frame_unported.rs` makes `request_close` a silent no-op (line 16), `system_is_dark` `false` (lines 28-30), and `FrameMessages::set_backdrop` `Ok(())` (lines 49-51).
- `crates/sweetview-runtime/src/window/tab_frame.rs` line 129: `FrameMessages::install(...).ok()` discards the error, so on macOS a tab frame is made with no backdrop and no DPI handling and nothing reports it; the stand-in's error text (`crates/sweetview-platform-window/src/tab_frame_unported.rs` line 47) is never seen.
- `crates/sweetview-platform-webview/src/lib.rs` lines 45-57, 78-79, 131, 173-206: `FILE_DROP_MESSAGE`, `is_file_drop_message`, `KeyData.virtual_key`, `web_error_reason` and `FILE_DROP_SCRIPT` are WebView2-specific shared items.
- `wry` 0.58.2 `src/wkwebview/mod.rs` line 1168: the macOS `WebView::focus`, which replaced `move_focus` (D23) and which `crates/sweetview-runtime/src/engine.rs` line 411 calls, unwraps the webview's window and panics when it has none.
- `crates/sweetview-window-logic/src/style.rs` lines 6-13 and `src/color.rs` line 3: Windows style bits and `COLORREF` in the shared logic crate; `geometry` is in physical pixels while macOS uses points.
- `crates/sweetview-keycodes/src/mac.rs` and `src/tables.rs` line 171: ported and tested, called by nothing yet; checked against the C++ table's 121 entries, not against the full `kVK_*` list (not confirmed complete beyond that).
- `crates/sweetview-runtime/src/runtime.rs` lines 361-373: the non-Windows event loop is built without `with_any_thread`; whether `tao` on macOS panics when the binding is first loaded off the main thread (a `Worker` loading first) is not confirmed.
- `packages/sweetview-native/src/binding.ts` lines 32-45 and `packages/sweetview-native/package.json` lines 41-46: only `win32-x64` is loadable or built.
- `justfile` line 4: every recipe runs under `pwsh`, which a Mac may not have.
- `rust-rewrite/checks/mac-check.ts` line 49: no `--all-targets`, so test code and dev-dependencies were never checked for macOS.
- `rust-rewrite/spike/spike.ts`: the tray proof driver is Windows-only (`user32` through `bun:ffi`).
- `docs/upgrading.md` lines 48-49, 107, 138, 160-162, 531 and the rows from line 1236 to line 1386: tell macOS readers to keep `@n1h/sweetview-webview-bun` and the `./darwin/*` exports "until the macOS goal"; they become wrong when the macOS goal lands. `rust-rewrite/OWNER-ACTIONS.md` section 6 (line 66) notes that `docs/app.md` and `docs/webview-library.md` say macOS needs `@n1h/sweetview-webview-bun` 2.8.0, which may not be published.
- Merged at `f88ceb4`: `OwnerWindow` is folded into `ForeignWindow` (`crates/sweetview-platform-window/src/popup.rs` header; `show_popup`, `crates/sweetview-runtime/src/dialogs.rs`, `menu.rs` and `tray.rs` take a `ForeignWindow`; section 3.4), and adding a user script no longer waits: `crates/sweetview-platform-webview` has `scripts_pending`, `set_scripts_registered_handler` and `stop_navigation`, and `crates/sweetview-runtime/src/engine.rs` holds page operations in order until registrations complete (D21; sections 3.2, 3.7).
- Windows items still open at `f88ceb4` that the macOS goal builds on: W10.2 (the independent review of every `unsafe` block, whose findings may change shared code), W0.6 (the workflow item, which M0.4 extends) and W10.4 (`rust-rewrite/OWNER-ACTIONS.md`), all unticked in `rust-rewrite/CHECKLIST-windows.md`.
