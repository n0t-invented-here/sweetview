# Handoff to the macOS goal

Written by the Windows goal for checklist item W10.3. Read it after `rust-rewrite/REQUIREMENTS.md` and before starting `rust-rewrite/CHECKLIST-macos.md`. Every claim about code names its file; line numbers are those of the commit named below. "Not confirmed" marks what was not checked; "suggestion" marks this document's own proposals.

## 1. Where things stand

On Windows, Sweetview's native layer runs on Rust: the crates under `crates/`, reached from Bun through one N-API binding (`packages/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node`, loaded by `packages/sweetview-native/src/binding.ts`). Windows no longer loads `@n1h/sweetview-webview-bun` or the C++ library, and no Windows source under `packages/` imports `bun:ffi`. macOS still runs today's code: the TypeScript under `packages/sweetview-native/src/darwin/`, the files `packages/sweetview/src/darwin-*.ts` and `packages/sweetview/src/tabs/darwin-*.ts`, calling AppKit through `bun:ffi` and the webview through the C++ library of the optional peer `@n1h/sweetview-webview-bun`. The work is on branch `v1-rust-rewrite` of `n0t-invented-here/sweetview`; tag `pre-rust-rewrite` marks the tree before the first change. This document describes the tree at commit `73c93e1`. Still open on the Windows side at that commit: W7.1 and W7.2 (tabs), W10.1 (`rust-rewrite/UNSAFE-LEDGER.md`) and W10.2 (the independent `unsafe` review), plus W0.5, W0.6, W1.6, W4.7, W5.5 and W8.2, which are unticked in `rust-rewrite/CHECKLIST-windows.md`.

## 2. What compiles for macOS

Command, from the repository root on the Windows machine:

```
bun rust-rewrite/checks/mac-check.ts
```

Output at `73c93e1`:

```
$ cargo check --target aarch64-apple-darwin --workspace   (C compiler and archiver: a stand-in that creates empty outputs)
    Checking sweetview-runtime v1.0.0 (<REPO>\crates\sweetview-runtime)
    Checking sweetview-napi v1.0.0 (<REPO>\crates\sweetview-napi)
    Checking sweetview-platform-node v1.0.0 (<REPO>\crates\sweetview-platform-node)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 8.46s
exit: 0; warnings and errors: 0
removing <TEMP>\sweetview-mac-check-RaCmDB
```

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
| `sweetview-platform-loop` | the parts of the UI thread's event loop `tao` has no API for | stand-in: `src/unported.rs` |
| `sweetview-platform-webview` | what the webview needs on top of `wry` that `wry` has no API for | stand-in: `src/unported.rs` |
| `sweetview-platform-input` | system-wide mouse and keyboard hooks and the permission model | stand-in: `src/unported.rs`; macOS branch in `src/permissions.rs` |
| `sweetview-platform-window` | the window-level OS calls `tao` has no API for, and the events of any window by subclass | stand-ins: `src/unported.rs`, `src/tab_frame_unported.rs`, and `cfg(not(windows))` modules in `metrics.rs`, `popup.rs`, `size_hint.rs` |
| `sweetview-platform-notify` | desktop notifications with a click that comes back | stand-in: `src/unported.rs` |
| `sweetview-platform-shell` | clipboard text, URL schemes, single instance, icon refresh | per-module `cfg(not(windows))` stand-ins in `clipboard.rs`, `url_scheme.rs`, `single_instance.rs`; `icons.rs` is a no-op off Windows |

## 3. What is stubbed

### 3.0 The gate, and what to do about it

W10.3 asked for stubs behind `cfg(target_os = "macos")`. The code does not use that gate: every platform crate selects its implementation with `#[cfg(windows)]` and its stand-in with `#[cfg(not(windows))]` (the one exception is `crates/sweetview-platform-input/src/permissions.rs`, which gates on `target_os = "macos"`). So today the stand-ins serve macOS and Linux alike.

Suggestion for the macOS goal: replace each `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;` with three arms, `#[cfg(windows)]`, `#[cfg(target_os = "macos")]` (the new macOS module) and `#[cfg(not(any(windows, target_os = "macos")))]` (the stand-in, kept for Linux), and do the same for each `cfg(not(windows))` fallback function in `sweetview-runtime`. Gate each crate's macOS dependencies the same way (`[target.'cfg(target_os = "macos")'.dependencies]`). That keeps `cargo check --target x86_64-unknown-linux-gnu` meaningful for the Linux goal and records in `rust-rewrite/HANDOFF-linux.md` (item M9.4) which stand-ins are still Linux's.

Every platform crate's `Cargo.toml` puts its OS crates under `[target.'cfg(windows)'.dependencies]` (`windows`, plus `webview2-com` and `windows-core` in the webview crate). `sweetview-runtime/Cargo.toml` depends on `tao`, `wry`, `muda`, `rfd` and `tray-icon` unconditionally, and on `webview2-com` for Windows only.

In the tables below, "same signature" means the macOS module must expose exactly these items, because `sweetview-runtime` calls them on every platform.

### 3.1 `sweetview-platform-loop`

Gate: `src/lib.rs` lines 18-23 (`#[cfg(windows)] #[path = "windows.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`); exports at line 27: `discard_quit, messages_waiting, post_quit_for_tests, SignalWindow, Waker`. `LoopHost` (`src/loop_host.rs`) is shared and has no gate except its tests (`#[cfg(all(test, windows))]`, line 100). `src/com.rs` line 58 has a `cfg(not(windows))` `ComApartment` whose `enter()` returns `Ok` (correct for macOS: no COM).

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

Consequence: `Runtime::new` makes the signal window and returns its error with `?` (`crates/sweetview-runtime/src/runtime.rs` lines 121-126), so on macOS today the runtime does not start. This crate is the first thing the macOS goal ports.

### 3.2 `sweetview-platform-webview`

Gate: `src/lib.rs` lines 32-37 (`#[cfg(windows)] #[path = "windows/mod.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`); line 24 `#![cfg_attr(not(windows), allow(dead_code))]`; lines 39-40 export `create_environment` and `default_user_data_folder` on Windows only; line 41 exports `UserScript, WebviewExtras` everywhere.

| Item (in `src/unported.rs`) | Windows (`src/windows/`) | Stand-in returns |
|---|---|---|
| `WebviewExtras::attach(webview: &wry::WebView, options: ExtrasOptions) -> Result<Self, ErrorCode>` | adds the extras through `wry`'s `controller()`, `webview()`, `environment()` | `Err(ErrorCode::Unspecified)` |
| `drain(&self)` | runs work queued from other threads | no-op |
| `add_user_script(&self, &str) -> Result<UserScript, ErrorCode>` | `AddScriptToExecuteOnDocumentCreated`, registered before the call returns | `Err(Unspecified)` |
| `remove_user_script(&self, UserScript)` | removes it | no-op |
| `set_asset(&self, path, mime, Vec<u8>) -> ErrorCode` | serves it on `http://webview.localhost` | `Unspecified` |
| `set_request_handler(&self, Option<Rc<dyn Fn(RawRequest)>>) -> ErrorCode` | one `WebResourceRequested` handler for both origins, requests held with a deferral | `Unspecified` |
| `responder(&self) -> Responder` | the answering half, usable from any thread; streamed bodies through an `IStream` | `unreachable!("no WebviewExtras exists on this platform")` (lines 54-56): a panic |
| `set_background_color(&self, r, g, b, a) -> ErrorCode` | `DefaultBackgroundColor`; alpha 0 or 255 only | `Unspecified` |
| `allows_external_drop(&self) -> Option<bool>` / `set_allow_external_drop(&self, bool) -> ErrorCode` | `ICoreWebView2Controller4::AllowExternalDrop` | `None` / `Unspecified` |
| `set_file_drop_handler(...) -> ErrorCode` | the drop script plus `WebMessageReceived` reading `ICoreWebView2File` (D17) | `Unspecified` |
| `set_accelerator_key_handler(Option<Rc<dyn Fn(KeyData) -> bool>>) -> ErrorCode`, `set_navigation_failed_handler(...) -> ErrorCode` | the tabs library's hooks | `Unspecified` |
| `note_host_navigation`, `move_focus`, `notify_parent_window_position_changed` | the tabs library's controller calls | no-ops |
| `call_devtools_protocol_method(&self, &str, &str) -> ErrorCode` | `CallDevToolsProtocolMethod` | `Unspecified` |

Shared code in `src/lib.rs` that is WebView2-shaped: `KeyData.virtual_key` is "the Windows virtual-key code" (lines 78-79); `web_error_reason` maps `COREWEBVIEW2_WEB_ERROR_STATUS` values (line 131); `FILE_DROP_SCRIPT` posts through `window.chrome.webview.postMessageWithAdditionalObjects` (lines 173-206). All crate tests are `#![cfg(windows)]`: `tests/environment.rs`, `tests/file_drop.rs`, `tests/requests.rs`, `tests/teardown.rs`.

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

Gates in `src/lib.rs`: lines 21-26 (`#[cfg(windows)] #[path = "windows.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`, `pub use platform::*;` at 28) and lines 33-38 (`#[cfg(windows)] #[path = "tab_frame.rs"] mod tab_frame;` / `#[cfg(not(windows))] #[path = "tab_frame_unported.rs"] mod tab_frame;`, `pub use tab_frame::*;` at 40). Per-module fallbacks: `src/metrics.rs` (8 / 30), `src/popup.rs` (47 / 149), `src/size_hint.rs` (41-44 / 90). Stand-in error text: `NOT_PORTED = "sweetview: window calls are not ported to this platform yet"` (`src/unported.rs` line 13).

`src/unported.rs`:

| Item | Windows (`src/windows.rs`) | Stand-in returns |
|---|---|---|
| `trait NativeWindow` (sealed), for `tao::window::Window` and `ForeignWindow` | yields the `HWND` | marker only |
| `ForeignWindow::from_handle_value(isize) -> Option<Self>` | an `IsWindow`-checked `HWND` | `None` |
| `ForeignWindow::of(&impl NativeWindow) -> Self` | wraps the same window | an empty wrapper naming no window |
| `impl HasWindowHandle for ForeignWindow` | `Win32WindowHandle` | `Err(HandleError::NotSupported)` |
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
| `handle_counts() -> HandleCounts` | `GetGuiResources`, `GetProcessHandleCount` | zeros |
| `GeometrySnapshot::take` / `restore` | styles and bounds across a mount (`preserveGeometry`) | unit value / no-op |
| `WindowIcons::set(&impl NativeWindow, Option<&[u8]>) -> Result<Self, String>` | `HICON`s from `.ico` bytes | `Err(NOT_PORTED)` |
| `WindowSubclass::install(&impl NativeWindow, impl Fn(&WindowEvent) -> bool + 'static) -> Result<Self, String>` | `SetWindowSubclass`: resize, move, close, drop, destroy events inside any loop (D8) | `Err(NOT_PORTED)`; window creation propagates it (`crates/sweetview-runtime/src/window.rs` line 210) |
| `WindowSubclass::policy`, `set_policy`, `set_hold_visibility`, `set_fill_child`, `force_style(u32)` | the forced extended styles | defaults / no-ops (unreachable) |

`src/tab_frame_unported.rs`: `FRAME_STYLE: u32` (`0`; Windows `WS_CLIPCHILDREN`), `is_foreground -> bool` (`false`), `move_with_mouse`, `size_with_mouse(.., ResizeEdge)`, `show_system_menu(.., Point)` (no-ops; Windows runs the OS move/size loop and the system menu), `request_close` (no-op; Windows sends `WM_CLOSE`), `PopupEntry`, `popup_menu(.., &[PopupEntry], Point) -> Result<Option<usize>, String>` (`Err("sweetview: popup menus are not ported to this platform yet")`), `system_is_dark() -> bool` (`false`; Windows reads `UISettings`). This module serves the Windows tab strip; macOS tabs are AppKit's (section 5, M6).

`src/metrics.rs`: `double_click_time_ms() -> u32` (stand-in `500`; Windows `GetDoubleClickTime`), `small_icon_size() -> u32` (stand-in `16`; Windows `SM_CXSMICON`).

`src/popup.rs` (as on `73c93e1`; see section 7 for the pending change): `OwnerWindow::from_handle_value(isize) -> Option<Self>` (stand-in `None`), `OwnerWindow::handle_value(&self) -> isize` (`0`), `HasWindowHandle`/`HasDisplayHandle` (`Err(NotSupported)`), `show_popup(&muda::Menu, &OwnerWindow, PopupAt) -> bool` (`false`; Windows `show_context_menu_for_hwnd` at a screen point, then `WM_NULL`), `check_item(&muda::Menu, &[u32], bool) -> bool` (`false`; Windows `SetMenuItemInfoW` with `MFS_CHECKED`), `PopupAt` shared.

`src/size_hint.rs`: `apply_given_window_size(&impl NativeWindow, u32, u32, GivenWindowSizeHint) -> bool` (stand-in `false`; Windows rewrites `GWL_STYLE` and sizes with `AdjustWindowRectExForDpi`).

### 3.5 `sweetview-platform-notify`

Gate: `src/lib.rs` lines 18-23 (`#[cfg(windows)] #[path = "windows.rs"] mod platform;` / `#[cfg(not(windows))] #[path = "unported.rs"] mod platform;`); line 25 `pub use platform::{live_toast_handlers, Notifier};`.

| Item (in `src/unported.rs`) | Windows | Stand-in returns |
|---|---|---|
| `Notifier::new(options: NotifierOptions, on_click: impl Fn(&str, Option<&str>) + 'static) -> Result<Notifier, NotifyError>` | WinRT toasts under a registered AUMID, balloon fallback, clicks on the notifier's thread | `Err(NotifyError("sweetview: notifications are not ported to this platform yet"))` |
| `notify(&self, &Notification) -> bool` / `show(&self, &Notification) -> Option<Shown>` | shows a toast or balloon | `false` / `None` |
| `set_icon_ico(&self, Option<Vec<u8>>) -> Result<(), NotifyError>` | validates and keeps the balloon's `.ico` | `Ok(())` without validating (unreachable) |
| `toasts_available`, `force_path(ForcedPath)`, `simulate_toast_event`, `simulate_balloon_event`, `pending_toasts`, `balloons_shown`, `pending_balloons` | test hooks | `false` / no-op / `0` |
| `live_toast_handlers() -> usize` | live WinRT handlers | `0` |

The shared types in `src/lib.rs` are Windows-shaped on every platform: `Shown::{Toast(u64), Balloon(u32)}` (57-63), `ToastEvent` (67-71), `BalloonEvent` (75-82), `ForcedPath::{Auto, BalloonOnly, ToastShowFails, ToastHeld}` (87-102); `NotifierOptions.app_id` is documented as an AUMID (line 30).

### 3.6 `sweetview-platform-shell`

No `unported.rs`. Gate: `src/lib.rs` lines 17-18 (`#[cfg(windows)] mod win;`) and 32-35 (`#[cfg(not(windows))] pub(crate) fn unported(what: &str) -> ShellError`, text `sweetview: {what} is not ported to this platform yet`).

| Item | Windows | Stand-in returns |
|---|---|---|
| `clipboard::read_text() -> Result<Option<String>, ShellError>`, `write_text(&str)`, `clear()` (`src/clipboard.rs`, stand-in `mod imp` at 206) | `OpenClipboard` with retries, `CF_UNICODETEXT` | `Err(unported("the clipboard"))` |
| `single_instance::acquire(app_id: &str, payload_json: &str, on_second: impl Fn(&str) + 'static) -> Result<Acquired, ShellError>` (`src/single_instance.rs`, stand-in at 232) | named mutex `Local\sweetview.instance.<id>`, message-only window, `WM_COPYDATA` | `Err(unported("singleInstance"))` |
| `url_scheme::register(&str, &Registration) -> Result<(), ShellError>`, `unregister(&str)` (`src/url_scheme.rs`, stand-in at 90-102) | `HKCU\Software\Classes\<scheme>` | `Ok(())` after validation: macOS reads schemes from the bundle's `Info.plist`, as today's `packages/sweetview-native/src/darwin/activation.ts` (lines 63-70) also does; correct for macOS |
| `icons::refresh_shell_icons()` (`src/icons.rs`) | `SHChangeNotify(SHCNE_ASSOCCHANGED)` | no-op (documented) |

Shared helpers that carry Windows names: `mutex_name` (`Local\...`, `single_instance.rs` line 41), `scheme_key`/`registry_values` (`url_scheme.rs` lines 44-58), `decode_unicode_text`/`encode_unicode_text` (`clipboard.rs` lines 16-25).

### 3.7 Windows-shaped code in `sweetview-runtime`, `sweetview-napi` and `sweetview-platform-node`

`sweetview-napi` and `sweetview-platform-node` have no platform gate. `sweetview-runtime`'s gates:

| File, lines | What it gates | Off Windows today | macOS needs |
|---|---|---|---|
| `src/runtime.rs` 361-373 | `build_event_loop()` | `EventLoopBuilder::new().build()` (Windows adds `with_any_thread(true)`, D6) | not confirmed whether `tao` on macOS accepts the Bun main thread without complaint; it is the process's main thread when Bun runs a script |
| `src/engine.rs` 666-697 | the WebView2 environment, `configure_for_platform` | `Ok(builder)` | the `WKWebViewConfiguration` with Sweetview's scheme handler (M0.5), and the data store today's library uses (section 5, D15) |
| `src/engine.rs` 699-708 | `window_value_of(&TaoWindow) -> isize` | `0` | the `NSWindow` pointer |
| `src/engine.rs` 710-719 | `reparent(&WebView, &ForeignWindow)` | `Ok(())` without moving anything | `wry`'s macOS reparent (`WebViewExtMacOS::reparent`; not confirmed for `wry` 0.58.2) |
| `src/bridge.rs` 13-17 | `POST_FUNCTION` | `window.webkit.messageHandlers.__webview__.postMessage` | already the macOS form; the script message handler Sweetview adds must be named `__webview__` |
| `src/tray.rs` 261-298 | stock icon, `window_handle_of(&TrayIcon)` | builder unchanged / `set_icon(None)` / `0` | a macOS default icon; the menu owner (below) |
| `src/tray.rs` 389-398 | `window_handle_value(&tao Window)` | `0`, so the tray menu's owner lookup fails (`tray.rs` line 385) | the macOS tray menu path |
| `src/window.rs` 927-944 | `platform_builder(WindowBuilder, Option<&TabState>)` | builder unchanged | macOS builder options (overlays, tabbing identifier) |
| tests | `#[cfg(all(test, windows))]` in `runtime.rs` 376/407, `window.rs` 977, `activation.rs` 69, `clipboard.rs` 33, `notify.rs` 93, `screen.rs` 95 | not compiled | the runtime's tests run on macOS too |

Windows-only concepts in public signatures:

- Window handles as `isize`, documented as the `HWND`: `Window::adopt(handle: isize)` and `Window::handle()` (`sweetview-runtime/src/window.rs` lines 551, 580-581), `tracked_count`, `mount_target` (949, 962), `Webview::window_handle()` and `reparent(window: isize)` (`engine.rs` 301, 383), `dialogs::pick_folder(owner: Option<isize>)` (`dialogs.rs` 13), `menu::popup(owner: isize)` (`menu.rs` 190), `screen::of_window` (`screen.rs` 70), `TabFrame::of` (`window/tab_frame.rs` 132). In the binding: `sweetview-napi/src/menus.rs` lines 20-23 ("a `bigint` holding the `HWND`'s value"), `window.rs` 19-29, `engine.rs` 57-59. The window registry is keyed by that value (`WINDOWS: HashMap<isize, Rc<Core>>`, `sweetview-runtime/src/window.rs` lines 161-169, filled at 182), so the macOS `handle_value` must be unique per window, not `0`.
- Notifier test hooks: `sweetview-runtime/src/notify.rs` lines 52-90 and `sweetview-napi/src/notify.rs` lines 61-135 (`forcePath` with `balloonOnly`, `toastShowFails`, `toastHeld`; `"toast:<cookie>"` / `"balloon:<uid>"`; `debug_*` counters), exported from `sweetview-platform-node/src/notify.rs`.
- WebView2 and COM: `engine.rs` lines 211 and 687, error texts "is the WebView2 runtime installed?"; `runtime.rs` enters a `ComApartment`; `KeyData.virtual_key` passes through `sweetview-napi/src/engine.rs`.
- Extended styles: `ExStylePolicy`, `apply_ex_style`, `set_layered_attributes` with a `COLORREF` colour key (`sweetview-runtime/src/window.rs` lines 145-230 and 511-526).
- The tab frame: `sweetview-napi/src/tab_frame.rs` (header "for the Windows tabs library"), `sweetview-platform-node/src/tab_frame.rs` line 10 and `types.rs` line 104 ("Windows:").
- The macOS-only app settings are no-ops on every platform: `install_app_menu`, `set_app_icon`, `set_activation_policy` return `Ok(())` with no gate (`sweetview-runtime/src/app.rs` lines 23-35; the comment at 8-9 says macOS keeps its implementation in the native package until the macOS goal).

### 3.8 Windows-shaped values in `sweetview-window-logic`

No gate; compiles everywhere. `geometry` works in "outer-frame physical pixels" (crate `README.md`), while macOS windows and screens are in points with a flipped y axis (M3.6). `style` holds `WS_EX_*` bits and `ExStylePolicy` (`src/style.rs` lines 6-13); `color` turns `#rrggbb` into a `COLORREF` (`src/color.rs` line 3). `hit`, `resize`, `screen` and `ico` are platform-neutral logic.

## 4. The TypeScript seams

| Seam | How it chooses today | What the macOS goal changes |
|---|---|---|
| `packages/sweetview-native/src/platform.ts` line 8, `backend<T>(win32: () => T, darwin: () => T): () => T` | picks once by `process.platform`, with literal `require("./win32/...")` / `require("./darwin/...")` thunks so public functions stay synchronous; any other platform throws | each darwin thunk goes to the binding. Call sites: `activation.ts` 84, `app-icon.ts` 16, `app-menu.ts` 10, `clipboard.ts` 9, `event-loop.ts` 23 and 30, `folder-picker.ts` 7, `menu.ts` 45, `notifications.ts` 43, `screen.ts` 29, `tray.ts` 40, `window.ts` 172. Suggestion: where the `win32/` module is now only binding calls, point both arms at one module and drop `backend` for it |
| `packages/sweetview-native/src/binding.ts` lines 32-44 | `switch` on `${process.platform}-${process.arch}`; only `case "win32-x64"` with the literal `require("../prebuilt/sweetview.win32-x64-msvc.node")`; every other target throws; `SWEETVIEW_NATIVE_PATH` overrides | add `case "darwin-arm64"` and `case "darwin-x64"`, each with its own literal `require` (the literal form is what `bun build --compile` embeds, header lines 3-4) |
| `packages/sweetview-native/src/darwin/library.ts` | the only importer of `@n1h/sweetview-webview-bun`: top-level `await import()` inside `try`, so a Windows bundle builds without it | deleted (R5) |
| `packages/sweetview-native/src/webview.ts` line 136, `input-hooks.ts` line 88, `permissions.ts` line 80 | top-level `process.platform === "darwin" ? await import("./darwin/webview" or "./darwin/input") : undefined`, with `if (onDarwin) return darwin()...` branches (`webview.ts` 158, 187, 205, 217, 268, 328); the other side is `binding()` | the darwin branches and `darwin/webview.ts`, `darwin/input.ts` go; one path through `binding()`. `webview.ts` lines 419 and 428 already give the macOS origins |
| `packages/sweetview/src/webview-host.ts` lines 103-108, `webviewEngine()` | darwin: `require("./darwin-webview-host").libraryEngine()`; otherwise `{ hasRequests: true, host: bindingHost }` | darwin takes `bindingHost`; the `WorkerWake` `kind: "library"` variant (lines 16-18) goes |
| `packages/sweetview/src/worker-wake.ts` lines 10-16 | `kind === "native"` uses `wakeNative(token)`; otherwise `require("./darwin-worker-wake").libraryWake(wake)` | only the native wake remains |
| `packages/sweetview/src/tabs/index.ts` lines 18-20 | `await import("./win-tabs")` or `await import("./darwin-tabs")` | the darwin driver is rebuilt on the binding (M6) |
| `packages/sweetview-native/package.json` | `napi`: `binaryName: "sweetview"`, `targets: ["x86_64-pc-windows-msvc"]` (41-46); `files` includes `prebuilt/*.node` and `prebuilt/binding.d.ts` (15-22); optional peer `@n1h/sweetview-webview-bun` `^2.7.0` (50-57); `exports` include `./darwin/objc`, `./darwin/screen`, `./darwin/tabs`, `./darwin/window` (33-36) | add `aarch64-apple-darwin` and `x86_64-apple-darwin` to `targets`; remove the peer; the four `./darwin/*` exports need rows in `docs/upgrading.md` (lines 1236-1241 say "unchanged; macOS only, until the macOS goal") |
| root `justfile` line 19, `just native` | `bunx napi build --platform --release --cwd packages/sweetview-native --manifest-path ../../crates/sweetview-platform-node/Cargo.toml --output-dir prebuilt --no-js --dts binding.d.ts`; the recipe shell is `pwsh` (line 4); `mod webview` (line 7) holds the C++ library recipes | `--platform` already names the output for the host target. `pwsh` must be installed on the Mac, or the shell setting changes (shared file, R8). `mod webview` and `webview/` go or are rewritten (M8.2) |

Files still importing `bun:ffi` that the macOS goal removes (the ten macOS-only sources in `rust-rewrite/ffi-allowlist.txt` at `73c93e1`, confirmed with `git grep -l -E "(from|import\()[[:space:]]*[\"']bun:ffi[\"']|require\([\"']bun:ffi[\"']\)" -- packages demos`, which lists 27 files: these ten and 17 probes):

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

The `engine` check (`verify.ts` lines 122-126) on `macos` passes only when no `package.json` names `sweetview-webview-bun`. At `73c93e1` seven do: the root `package.json`, `packages/sweetview-native/package.json`, `packages/sweetview/package.json`, `demos/desktop-pet/package.json`, `demos/menubar-notify/package.json`, `demos/native-tabs/package.json`, `demos/web-app/package.json`. It does not look at source, docs or `bun.lock`.

## 5. What the Windows work learned that changes `CHECKLIST-macos.md`

### 5.1 Decisions, one by one (`rust-rewrite/DECISIONS.md`)

| Decision | macOS |
|---|---|
| D1 crate boundaries | carries over as is: macOS modules go into the same platform crates, behind the gate of section 3.0 |
| D2 binding in two crates (`#[napi]` cannot compile under `#![forbid(unsafe_code)]`: E0453 from `ctor`'s `#[allow(unsafe_code)]`) | carries over as is; new exports go into `sweetview-platform-node` as one-line forwards, behaviour into `sweetview-napi` |
| D3 wakes, deferred jobs and native timeouts through a message-only window, not `tao`; `request_exit` sends a `tao` user event; due timers taken after each pump | carries over with a macOS mechanism to be chosen. Windows found that `tao`'s `run_return` buffers events while its handler runs and calls its handler only for its own messages. Not confirmed whether `tao`'s macOS backend behaves the same; assume it does until M0 proves otherwise. Candidates (not facts): a `CFRunLoopSource` signalled from any thread and a `CFRunLoopTimer`, both added to `kCFRunLoopCommonModes` so they fire in AppKit's modal and event-tracking modes; or the main dispatch queue. The `SignalWindow`/`Waker` signatures of section 3.1 are the contract |
| D4 `LoopHost` lends the window target during a run (one `unsafe` dereference) | carries over as is; the code is shared (`crates/sweetview-platform-loop/src/loop_host.rs`). WebKit delegate callbacks arrive outside `tao`'s handler just as WebView2's do |
| D5 built `.node` not tracked; `binding.d.ts` tracked | carries over; the macOS binaries are built by `just native` on a Mac and by CI. `binding.d.ts` is generated from the same Rust on both platforms and must come out identical |
| D6 UI thread = the thread that loads the binding first; `tao` with `with_any_thread(true)` | the rule carries over (`sweetview_runtime::threads`). `with_any_thread` is a Windows builder extension here (`runtime.rs` line 363); AppKit requires its own main thread, which is Bun's main thread when Bun runs a script. Entry points that touch AppKit take a `MainThreadMarker` (UNSAFE-POLICY) |
| D7 exceptions logged by the TypeScript wrapper, binding as backstop (`sweetview: <kind> threw: <reason>`) | carries over as is (shared TypeScript and `sweetview-napi/src/callback.rs`) |
| D8 windows by `tao`; events and extended styles through one subclass | Windows-only in mechanism. The need carries over: events must arrive synchronously inside any loop, and `Window.fromHandle` must observe a window `tao` did not make. Candidates: `NSNotificationCenter` observers for `NSWindowDidResizeNotification`, `NSWindowDidMoveNotification`, `NSWindowWillCloseNotification` (today's `darwin/window.ts` uses observers, per its allowlist reason), and a delegate or `windowShouldClose:` route for the close request. The style policy has no macOS counterpart; overlay properties are `setLevel`, `setCollectionBehavior`, `setIgnoresMouseEvents` (proposal) |
| D9 show by the platform crate, then tell `tao` | carries over with a macOS mechanism: if `tao`'s macOS `set_visible(true)` makes the window key (not confirmed), `noActivate` windows need `orderFront:`/`orderFrontRegardless` instead (candidates) |
| D10 a quit outside a blocking run waits for the next pump | carries over as is (runtime logic); `discard_quit` (section 3.1) needs a macOS meaning, likely "clear the flag" only |
| D11 one pump dispatches everything waiting (256 rounds, then due timers) | carries over; `messages_waiting()` needs a macOS answer. Candidate: `nextEventMatchingMask:untilDate:inMode:dequeue:` with `dequeue: NO` and a past date |
| D12 positional types where an object would need `unsafe`; callback types written out | carries over as is |
| D13 tray events queued, never run inside `tray-icon`'s callback | carries over as is (runtime). The single/double click rule uses `double_click_time_ms()`, whose stand-in is 500; candidate `NSEvent.doubleClickInterval`. M4.1 also says any click opens the menu when one is set, which differs from Windows |
| D14 menus built fresh per showing; 16 pixel icons; `check_item` for icon plus check | built-fresh carries over. The 16 pixel size and `check_item` are Windows `muda` facts; not confirmed what `muda` 0.22.0 does with an icon and a check on macOS. Popups: candidate `muda`'s `show_context_menu_for_nsview` (proposal) |
| D15 WebView2 environment created the C++ library's way, once per process | Windows-only in mechanism; the reason carries over: an upgraded application must keep its cookies and storage. Suggestion: find which `WKWebsiteDataStore` the C++ library uses on macOS and configure `wry` to the same |
| D16 a page message is answered on a later turn; a webview is dropped only when none of its callbacks is on the stack | carries over as is (`sweetview-runtime/src/engine.rs`), provided the macOS script message handler and scheme handler enter the runtime the same way |
| D17 dropped files reach the host as one string message with attached `ICoreWebView2File` objects | Windows-only. macOS uses `wry`'s `with_drag_drop_handler` with the route kept from Enter to Drop or Leave (proposal table, M0.5, M1.6). `FILE_DROP_SCRIPT` in `crates/sweetview-platform-webview/src/lib.rs` is Windows-only |
| D18 the macOS seam is one module per shared file; the bindings package loads only on macOS | the macOS goal removes it (section 4) |
| D19 no list of dependent applications made | carries over; `rust-rewrite/local/dependents.txt` is machine-local and the owner's |
| D20 tests corrected because they measured the machine | carries over as method: a test that shows real notifications hides them and does not depend on the platform keeping one on screen; handle and object counts are read once they stop moving and growth is compared with a baseline loop; input that drives an OS modal loop is injected as a device would make it. macOS counterparts (not confirmed on a hosted runner): notification authorisation and banners need a bundle; event taps and synthetic input need Accessibility permission |

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
- M0.2 "The three proofs of `rust-rewrite/spike/` pass on this Mac": `rust-rewrite/spike/spike.ts` drives the tray proof with `bun:ffi` calls into `user32` (posted `WM_USER_TRAYICON` messages), so the tray half needs a macOS driver. The spike wakes through `EventLoopProxy`, which on Windows proved insufficient (D3); passing the spike does not settle wakes inside a modal loop. W1.6 (`bun build --compile` embedding the binding in a demo) is still unticked on Windows.
- M0.3 "If the timer-pumped loop fails on macOS under `tao`'s `run_return` ...": widen it. Before anything else, port `sweetview-platform-loop` (section 3.1), because `Runtime::new` fails without the signal window (`crates/sweetview-runtime/src/runtime.rs` lines 121-126). Prove, under both loop modes, that a wake from a worker, a deferred job and a native timeout each run while a handler holds an AppKit modal loop open (an `NSAlert` `runModal`, a popup menu, a window resize), as W1.8 did on Windows. Record the mechanism in `DECISIONS.md`.
- M0.4 CI: `.github/workflows/windows.yml` is the only workflow. Add a macOS job; add both Apple targets to the `napi` block; make `just` run there (`pwsh` shell, root `justfile` line 4). The hosted Windows runner dismissed toasts at once and did not let `SetCursorPos` reach a move loop (D20); expect the hosted macOS runner to differ from a desk machine in notifications, TCC permissions and synthetic input, and write tests that do not depend on them (not confirmed what it does).
- M0.5: the four rows are as the proposal states. Add: the script message handler is named `__webview__`, because the page bridge already posts to `window.webkit.messageHandlers.__webview__` (`crates/sweetview-runtime/src/bridge.rs` line 17).
- M1.1 "Every member of `RawWebview`, as in W2.1": `configure_for_platform`, `window_value_of` and `reparent` in `crates/sweetview-runtime/src/engine.rs` (lines 694-719) are the runtime's macOS seams; `WebviewExtras` (section 3.2) is the platform contract. D16 applies unchanged.
- M1.2: origins and asset rules are already in `sweetview-http` (`MACOS_ASSET_ORIGIN`, `route_request`).
- M1.3 "`setBackgroundColor` with any alpha": Windows refuses alpha other than 0 and 255 (WebView2's limit); macOS accepts any. The shared check must be per platform.
- M1.4, M1.5: the stand-in's `responder()` panics (section 3.2); the macOS `Responder` must answer from any thread as on Windows (`completeWebviewRequest` from a worker).
- M1.6: D17 is Windows-only; use the proposal's drag routing.
- M1.7: the injected bridge script already returns early in frames other than the top-level document (`bridge.rs`); the native handler still checks `frameInfo.isMainFrame` (proposal line 239).
- M1.8: the webview crate's tests are all `#![cfg(windows)]`; macOS needs crate tests of its own. Teardown growth is measured against a baseline loop (D20).
- M2.1: call `sweetview_keycodes::mac` and `dom_code_from_mac_keycode`. The tap's run-loop source must fire inside modal loops as the Windows hooks do (common modes, candidate). A hook is not `Send` and one of each kind exists per process (`crates/sweetview-platform-input/README.md`).
- M2.2: replace the macOS arm of `crates/sweetview-platform-input/src/permissions.rs` (lines 165-180), which always answers `Missing` and never asks. Candidates from the proposal: `CGPreflightPostEventAccess`, `CGRequestPostEventAccess`.
- M3.1: D10 and D11 carry; `messages_waiting` and `discard_quit` need macOS meanings.
- M3.2 "`handle` is the real `NSWindow` pointer": the window registry is keyed by `handle_value` (section 3.7); the stand-in's `0` would make every window share one record. Events: D8 above.
- M3.3: no `ExStylePolicy` on macOS; the runtime calls `apply_ex_style` and `set_layered_attributes` unconditionally (`crates/sweetview-runtime/src/window.rs` around 226 and 514-526), so those calls need a per-platform route.
- M3.4: the hit-region poll and the "no flip while a button is down" rule are shared (`sweetview-window-logic::hit`); `mouse_buttons_down` on macOS: candidate `NSEvent.pressedMouseButtons` (proposal).
- M3.5: `startDrag`: candidate `performWindowDragWithEvent:` (not confirmed). The macOS test already avoids real input (`packages/sweetview/src/app.test.ts` warps the cursor with `CGWarpMouseCursorPosition`).
- M3.6 "points and the flipped y axis": `sweetview-window-logic::geometry` is in physical pixels (section 3.8); decide where points are converted. `work_area` on macOS: candidate `NSScreen.visibleFrame`.
- M4.1: D13 carries. The tray menu owner path goes through `OwnerWindow` and fails off Windows (`crates/sweetview-runtime/src/tray.rs` lines 385-398).
- M4.2: see D14.
- M4.3: the notifier's shared types and the binding's test hooks are toast and balloon shaped (section 3.5, 3.7); decide what the macOS test hooks are. Tests follow D20.
- M4.4: `install_app_menu`, `set_app_icon`, `set_activation_policy` return `Ok(())` on every platform today (`crates/sweetview-runtime/src/app.rs` lines 23-35); the clipboard stand-in errors. Activation policy changes before the loop starts (`EventLoopExtMacOS::set_activation_policy`, proposal line 153).
- M5.1: `url_scheme` correctly does nothing at run time on macOS. `onOpenUrl` is buffered until `signalReady`; the open-URL event must reach the runtime inside any loop (candidate: `tao`'s `Event::Opened`, proposal line 637, subject to the D3 caveat about `tao`'s handler).
- M5.2: `single_instance` is a stand-in; the wire format is today's `CFMessagePort` (proposal lines 301, 636). `mutex_name` is Windows-only.
- M6.1, M6.2: the Rust tab frame (`tab_frame.rs`, `sweetview-napi/src/tab_frame.rs`) is the Windows strip and has no meaning on macOS; macOS tabs use AppKit tabbing (proposal lines 610-623). W7.1 is still open on Windows, and the tab state machines are shared TypeScript.
- M7.1: `binding.ts` needs a literal `require` per Apple target; the published package carries what CI builds (D5, `files` includes `prebuilt/*.node`).
- M7.2 "from Windows for the macOS target": the Windows machine needs the macOS `.node` files in `prebuilt/` to compile a macOS executable; they are not tracked (D5), so they come from CI or a Mac.
- M8.1: see section 4 for the rule.
- M8.2: seven `package.json` files name the bindings package (section 4); `mod webview` in the root `justfile` and `webview/` go.
- M8.3: `docs/upgrading.md` lines 44-49, 107, 138 and 160-162 tell macOS readers to keep `@n1h/sweetview-webview-bun`; lines 1236-1241 cover `./darwin/objc`. `docs/webview-library.md`, `docs/app.md` and `docs/native.md` describe the macOS library path.
- M8.4: see section 6.
- M9.1 to M9.4: nothing changes.

### 5.4 Not covered by any item

Proposed item texts (suggestions; the checklist is not edited here):

- "M0.6 `sweetview-platform-loop` has a macOS module: `SignalWindow`, `Waker`, `messages_waiting`, `discard_quit` with the signatures of the Windows module, and a test shows a wake, a deferred job and a native timeout delivered while an AppKit modal loop runs, in both loop modes." (Covers D3; nothing in M0 to M3 names it, and the runtime cannot start without it.)
- "M0.7 `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` pass on macOS, with the runtime's tests (`#[cfg(all(test, windows))]` today) running there." (No macOS item runs the Rust tests.)
- "M3.8 Every window, owned or adopted, has a distinct non-zero handle value, and `Window.handle` is that value." (Section 3.7; M3.2 names the pointer but not the registry.)
- "M8.5 Every binding export with no meaning on macOS (the tab frame, the notifier's toast and balloon test hooks) either has a macOS meaning or throws a documented error there, and `docs/upgrading.md` says which." (Section 7.)
- "M8.6 Each platform crate selects its macOS module with `cfg(target_os = "macos")`, and the stand-ins stay behind `cfg(not(any(windows, target_os = "macos")))` for Linux." (Section 3.0.)

## 6. Shared files the macOS goal will touch, and what must keep passing on Windows

Shared Rust (compiled on both platforms):

- `Cargo.toml`, `Cargo.lock`.
- `crates/sweetview-runtime/src/*` (in particular `runtime.rs`, `engine.rs`, `window.rs`, `tray.rs`, `app.rs`, `notify.rs`, `bridge.rs`, `screen.rs`), `crates/sweetview-napi/src/*`, `crates/sweetview-platform-node/src/*`, and the generated `packages/sweetview-native/prebuilt/binding.d.ts`.
- `crates/sweetview-http`, `crates/sweetview-keycodes`, `crates/sweetview-window-logic`.
- Each platform crate's `lib.rs`, `Cargo.toml`, `loop_host.rs`, `com.rs`, `permissions.rs`, and the shared modules `metrics.rs`, `popup.rs`, `size_hint.rs`, `clipboard.rs`, `single_instance.rs`, `url_scheme.rs`, `icons.rs`.

Shared TypeScript and tooling:

- `packages/sweetview-native/src/`: `platform.ts`, `binding.ts`, `webview.ts`, `input-hooks.ts`, `permissions.ts`, the `backend` front modules listed in section 4, `internal.ts`, `index.ts`; `packages/sweetview-native/package.json`.
- `packages/sweetview/src/`: `webview-host.ts`, `worker-wake.ts`, `app.ts`, `tabs/index.ts`; `packages/sweetview/package.json`.
- Root `package.json`, `justfile`, `.github/workflows/`, `rust-rewrite/verify.ts`, `rust-rewrite/ffi-allowlist.txt`, `docs/`.

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

- `crates/sweetview-runtime/src/runtime.rs` lines 121-126: `Runtime::new` fails off Windows because the signal window stand-in (`crates/sweetview-platform-loop/src/unported.rs` lines 22-24) returns an error; nothing of the runtime can run on macOS until that module is ported.
- `crates/sweetview-platform-window/src/unported.rs` line 50: `handle_value` returns `0`, and `crates/sweetview-runtime/src/window.rs` lines 161-169 and 182 key every window by it; two windows would share one record.
- `crates/sweetview-runtime/src/engine.rs` lines 705-719: off Windows, `window_value_of` returns `0` and `reparent` returns `Ok(())` without moving the webview (success where nothing happened).
- `crates/sweetview-runtime/src/tray.rs` lines 285-298: off Windows the tray's window handle is `0`, so the tray menu's owner lookup at line 385 fails.
- `crates/sweetview-runtime/src/app.rs` lines 23-35: `install_app_menu`, `set_app_icon`, `set_activation_policy` report success on macOS and do nothing, with no gate; a macOS application on the binding would lose its app menu, Dock icon and activation policy silently.
- `crates/sweetview-platform-input/src/permissions.rs` lines 165-180: the macOS arm always reports `Missing` and `request` asks the system nothing.
- `crates/sweetview-platform-webview/src/unported.rs` lines 54-56: `responder()` panics with `unreachable!`; unreachable today only because `attach` always fails.
- `crates/sweetview-platform-window/src/unported.rs`: `is_window` and `is_visible` answer `false`, `dpi_scale` `1.0`, `chrome` "framed and resizable", and `show`, `hide`, `minimize`, `toggle_zoom`, `bring_to_front`, `apply_ex_style` do nothing silently (lines 53-113); `crates/sweetview-platform-window/src/metrics.rs` lines 30-38 answer 500 ms and 16 pixels.
- `crates/sweetview-platform-notify/src/lib.rs` lines 57-102 and `crates/sweetview-napi/src/notify.rs` lines 61-135: the notifier's result type and test hooks are toast and balloon shaped; they have no macOS meaning as written.
- `crates/sweetview-napi/src/tab_frame.rs` (whole module) and `crates/sweetview-platform-node/src/tab_frame.rs` line 10: the tab frame API is the Windows tab strip and has no macOS meaning; `crates/sweetview-platform-window/src/tab_frame_unported.rs` makes `request_close` a silent no-op and `system_is_dark` `false`.
- `crates/sweetview-platform-webview/src/lib.rs` lines 78-79, 131, 173-206: `KeyData.virtual_key`, `web_error_reason` and `FILE_DROP_SCRIPT` are WebView2-specific shared items.
- `crates/sweetview-window-logic/src/style.rs` lines 6-13 and `src/color.rs` line 3: Windows style bits and `COLORREF` in the shared logic crate; `geometry` is in physical pixels while macOS uses points.
- `crates/sweetview-keycodes/src/mac.rs` and `src/tables.rs` line 171: ported and tested, called by nothing yet; checked against the C++ table's 121 entries, not against the full `kVK_*` list (not confirmed complete beyond that).
- `crates/sweetview-runtime/src/runtime.rs` lines 361-373: the non-Windows event loop is built without `with_any_thread`; whether `tao` on macOS panics when the binding is first loaded off the main thread (a `Worker` loading first) is not confirmed.
- `packages/sweetview-native/src/binding.ts` lines 32-44 and `packages/sweetview-native/package.json` lines 41-46: only `win32-x64` is loadable or built.
- `justfile` line 4: every recipe runs under `pwsh`, which a Mac may not have.
- `rust-rewrite/checks/mac-check.ts` line 49: no `--all-targets`, so test code and dev-dependencies were never checked for macOS.
- `rust-rewrite/spike/spike.ts`: the tray proof driver is Windows-only (`user32` through `bun:ffi`).
- `docs/upgrading.md` lines 44-49, 107, 138, 160-162 and 1236-1241: tell macOS readers to keep `@n1h/sweetview-webview-bun` and the `./darwin/*` exports "until the macOS goal"; they become wrong when the macOS goal lands. `rust-rewrite/OWNER-ACTIONS.md` section 6 notes that `docs/app.md` and `docs/webview-library.md` say macOS needs `@n1h/sweetview-webview-bun` 2.8.0, which may not be published.
- About to change on a branch another session is finishing, not merged at `73c93e1`: `OwnerWindow` in `crates/sweetview-platform-window/src/popup.rs` is folded into `ForeignWindow` (the popup table in section 3.4 then collapses into the `ForeignWindow` row), and `add_user_script` in `crates/sweetview-platform-webview` no longer waits for the registration (navigations are held until registrations complete). Re-read both before porting them.
- Windows items still open at `73c93e1` that the macOS goal builds on: W7.1 and W7.2 (tabs; shared tab TypeScript), W10.1 and W10.2 (`rust-rewrite/UNSAFE-LEDGER.md` and the `unsafe` review), and the unticked W0.5, W0.6, W1.6, W4.7, W5.5, W8.2 in `rust-rewrite/CHECKLIST-windows.md`.
