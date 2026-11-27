# Sweetview: native code in type-safe Rust

Status: proposal and design. Ready for implementation on Windows. On macOS two mechanisms that were proven on Windows are not yet proven; the Readiness section lists them.

Rule: no functionality is removed. Everything Sweetview, the bindings and the C++ webview fork do today exists afterwards. Where a crate lacks something, this project writes it in Rust.

## Readiness

| Part | State | What closes it |
|---|---|---|
| JavaScript called from native code while the UI thread is inside the blocking loop, under Bun's N-API | **proven on Windows**; see "Proofs run" | on macOS: run the same proof on a Mac |
| `tao`'s loop pumped from a Bun timer delivering tray events with no window, with Bun's timers and promises still running | **proven on Windows** | on macOS: run the same proof on a Mac |
| `bun build --compile` embedding the `.node` binding into one executable | **proven on Windows** | on macOS: run the same proof on a Mac |
| The five additions inside the `wry` fork: streaming on Windows and macOS, macOS drag routing, macOS top-level-only IPC, macOS navigation-failed event | located, file and function each; see "Fork additions, located" | nothing |
| The balloon addition inside the `tray-icon` fork | located, file and function | nothing |
| Every crate API the design names | read on docs.rs or in source, with version; see "API references" | nothing |
| Native tabs and every `v1-drafting` feature | designed from a full reading of their files; see "Tabs" and "The `v1-drafting` features" | nothing |
| Linux | scoped, not designed | its own step, last |

## Proofs run

A throwaway crate, built and run on 2026-11-27 on Windows 11 with Bun 1.4.4 and Rust 1.97.1. It lives outside every repository and is not part of this proposal's code.

Built with: `napi` 3.16.3, `napi-derive` 3.7.2, `napi-build` 2.7.0, `tao` 0.38.0, `wry` 0.58.2, `tray-icon` 0.27.0, `muda` 0.22.0, `windows` 0.62.2, `webview2-com` 0.39.1. Build time from clean: 43 seconds. The binding is 1.2 MB.

| Question | What was run | Result |
|---|---|---|
| Can native code call a JavaScript function while the UI thread is inside the blocking `tao` loop? | A `#[napi]` function creates a hidden `tao` window and a `wry` webview, serves a page from a custom protocol, and enters `run_return`. The page calls `window.ipc.postMessage`. The loop calls the JavaScript function it was given and exits with its return value | The JavaScript function ran once, inside the loop, and its return value came back: `pong<ping from http://webview.localhost> insideLoop=true`. 368 ms from call to result |
| What origin does a `wry` custom protocol named `webview` get on Windows? | the page reports `location.origin` | `http://webview.localhost`, the same value `assetOrigin` has today |
| Does a `tao` loop pumped from a Bun timer deliver tray events with no window? | `init` creates a `tao` event loop and a `tray-icon` icon and no window. A Bun `setInterval` at 16 ms calls `pump`, which runs `run_return` until `MainEventsCleared`. Four tray mouse messages are posted to the tray icon's own window, the messages the shell posts for a left and a right click | 4 messages posted, 4 `TrayIconEvent::Click` events delivered to the JavaScript function |
| Does Bun's own loop keep running between pumps? | a second 10 ms `setInterval` and a promise per tick, during 70 pump ticks | 109 timer ticks and 109 promise continuations ran |
| Does `bun build --compile` embed the binding? | the script loads the binding with a literal `require("./spike.node")`; the compiled executable is copied alone into an empty folder and run | the executable passed every check above with no `.node` file beside it |

Limits of these proofs:

- Windows only. No Mac was available on the machine they ran on.
- The tray clicks were the shell's messages posted by the test, not a person clicking.
- They prove the mechanisms, not the features built on them.

## What Sweetview is

Sweetview lets a Bun app open a webview window, put an icon in the tray or menu bar, show notifications, and draw transparent click-through windows on the desktop. The app is TypeScript and compiles to one executable with `bun build --compile`.

## The change

All native code becomes Rust. Bun reaches it through N-API. No C++ and no `bun:ffi` remain.

| Piece | Today | After |
|---|---|---|
| The webview | a C++ fork of `webview/webview`, reached through a `bun:ffi` wrapper package | `wry`, plus this project's additions for what the C++ fork has and `wry` lacks |
| Windows, transparent overlays, click-through, event loop | TypeScript `bun:ffi` calling Win32 and AppKit | `tao` |
| Tray or menu-bar icon | TypeScript `bun:ffi` | `tray-icon` |
| Menus | TypeScript `bun:ffi` | `muda` |
| Folder dialog | TypeScript `bun:ffi` | `rfd` |
| Notifications | TypeScript `bun:ffi` | Rust written by this project on `windows` and `objc2-user-notifications`; `notify-rust` on Linux |
| System-wide mouse and keyboard hooks, permission model | C++ in the webview fork | Rust written by this project on `windows` and `objc2-core-graphics` |
| How Bun reaches native code | `bun:ffi` | N-API through `napi` |

## Rust crates

Crates that already wrap the OS behind safe APIs. They are the libraries Tauri 2 is built on.

| Crate | Version read | Job |
|---|---|---|
| `tao` | 0.38.0 | windows and the OS event loop |
| `wry` | 0.58.2 | the webview: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux |
| `muda` | 0.22.0 | menus: `MenuItem`, `CheckMenuItem`, `IconMenuItem`, `Submenu`, `PredefinedMenuItem` |
| `tray-icon` | 0.27.0 | tray and menu-bar icon with click events; the `ksni` feature gives Linux clicks |
| `rfd` | 0.18.0 | file and folder dialogs |
| `notify-rust` | 4.19.0 | Linux notifications |

Crates for the N-API layer and for the Rust this project writes itself.

| Crate | Version read | Job |
|---|---|---|
| `napi`, `napi-derive`, `napi-build` | 3.16.3, 3.7.2, 2.7.0 | The N-API layer. Rust marked `#[napi]` becomes the JavaScript API, and the crate generates the `.d.ts` from the Rust signatures |
| `windows` | 0.62.2 | Microsoft's Rust bindings for Win32, COM and WinRT, generated from Windows' own metadata |
| `webview2-com` | 0.39.1 | typed WebView2 interfaces and event handlers; the types `wry`'s `controller()`, `webview()` and `environment()` return |
| `objc2` | 0.6.3 | Typed Objective-C: message sends, `define_class!`, `Retained<T>`, `MainThreadMarker` |
| `objc2-foundation`, `objc2-app-kit` | 0.3.2 | typed Foundation and AppKit |
| `objc2-user-notifications`, `objc2-core-graphics` | 0.3.2 | macOS notifications; the event tap for the input hooks |
| `block2` | 0.6.2 | Objective-C blocks |

Two of the crates are used as forks this project owns, each carrying a short list of additions: `wry` and `tray-icon`. The additions are listed under "What this project writes in Rust".

## Memory safety

| Code | Unsafe |
|---|---|
| `tao`, `wry`, `muda`, `tray-icon`, `rfd` | inside the crates; their public APIs are safe |
| Sweetview's own crate, except the modules below | none: `#![forbid(unsafe_code)]` |
| Sweetview's `platform` modules: input hooks, notifications, and the single OS calls listed below | yes, one `unsafe` block per OS call |
| This project's additions inside its `wry` and `tray-icon` forks | yes, in the same style as the code around them |
| JavaScript | no native calls at all |

## What the Rust types enforce

Each row is something the TypeScript `bun:ffi` code does by hand today.

| Today, in TypeScript | In Rust | Example in this repository |
|---|---|---|
| Every handle is a `bigint` | Each is its own type: `tao::window::Window`, `wry::WebView`, `muda::Menu`, `tray_icon::TrayIcon`. Passing one where another belongs does not compile | `src/native/win32/api.ts`: every handle is `FFIType.u64` |
| Function signatures are written by hand, one `FFIType` list per call | The crates' signatures are checked by the compiler | commit `83d7411`: `isZoomed` read with the wrong return type, `orderFrontRegardless` called with the wrong arity |
| One hand-made `objc_msgSend` variant per signature shape | Typed methods | `src/native/darwin/objc.ts`: `sendRectUIntUIntBool`, `sendPtrSelPtrVoid` and 30 more |
| Structs are byte arrays with numeric offsets | Real structs with named fields | `win32/tray.ts`: `new Uint8Array(976)` with `NID_INFO = 304` |
| COM methods are called by vtable slot number | Typed interfaces | `win32/folder-picker.ts`: slots 3, 9, 10, 17, 20 |
| Release is called by hand | Ownership: values free their OS resources when dropped | `darwin/menu.ts`: `release(inited)`, `release(sub)`, `release(menu)` |
| Callbacks are `JSCallback` pointers kept alive in module-level arrays | The library owns each callback for exactly as long as the OS can call it | `objc.ts`: `const retained: JSCallback[] = []`, never freed |
| Thread rules are comments | UI-thread types are not `Send`. Using one from a worker thread does not compile | "Thread: UI thread" throughout `docs/native.md` |
| Return codes are checked where someone remembered | `Result<T, E>`; an unchecked result is a compiler warning | `win32/menu.ts`: `AppendMenuW` results are not checked |
| Options are strings and numbers | Enums | `edge.includes("left")` |
| TypeScript types for native calls are written by hand | The `.d.ts` is generated from the Rust | every `dlopen` table |

## Every behaviour, and what provides it

### Sweetview on `main`

| Behaviour | Provided by |
|---|---|
| Create a window hidden, frameless or framed, transparent, topmost, not focusable, off the taskbar | `tao`: `WindowBuilder::with_visible`, `with_decorations`, `with_transparent`, `with_always_on_top`, `with_focusable`, `with_skip_taskbar`, `with_no_redirection_bitmap` |
| Show, hide, move, resize, raise, bounds | `tao`: `set_visible`, `set_outer_position`, `set_inner_size`, `set_always_on_top`, `outer_position`, `outer_size` |
| Whole-window click-through | `tao`: `set_ignore_cursor_events` |
| Hit regions: 10 ms poll, polygons, the refine round trip to the page | Sweetview's `hit` module (safe Rust): `tao` `cursor_position` and `set_ignore_cursor_events` |
| "Never flip click-through while a mouse button is down" | Sweetview `platform`: `GetAsyncKeyState` on Windows, `NSEvent::pressedMouseButtons` on macOS |
| Screen, screen at a point, virtual screen, scale | `tao`: `primary_monitor`, `available_monitors`, `monitor_from_point`, `scale_factor` |
| Work area | Sweetview `platform`: `SystemParametersInfoW`, `NSScreen::visibleFrame` |
| Title-bar drag from the page | `tao`: `drag_window` |
| Edge resize from the page, minimum 160x120 | Sweetview's own gesture, as today, in safe Rust on `cursor_position` and `set_outer_position` |
| Minimise; maximise to the work area and back | `tao` `set_minimized`; Sweetview's own toggle, as today |
| Window icon; light, dark or system frame | `tao`: `set_window_icon`, `set_theme` |
| `colorKey` and `opacity` | Sweetview `platform`: `SetLayeredWindowAttributes`, `NSWindow::setAlphaValue` |
| macOS: above the Dock, on every Space, out of window cycling, over full-screen apps | Sweetview `platform`: `NSWindow::setLevel`, `setCollectionBehavior` |
| Close button hides the window | `tao`: the `CloseRequested` event |
| Activation policy | `tao`: `EventLoopExtMacOS::set_activation_policy` |
| Tray icon, tooltip, click and double click, menu | `tray-icon`, with the single and double click timing in safe Rust |
| Menus with check marks, icons, submenus, rebuilt on every open | `muda` |
| SF Symbol icons on macOS | Sweetview `platform`: `NSImage::imageWithSystemSymbolName` |
| Windows notifications as the tray's balloon, with click | the `tray-icon` fork: one function and one event |
| macOS notifications with click, data round trip, banners while frontmost | Sweetview `platform` on `objc2-user-notifications` |
| Folder dialog | `rfd` |
| macOS app menu with About, Quit and Edit | `muda` predefined items; the About alert through `rfd` |
| Dock icon at run time | Sweetview `platform`: `NSApplication::setApplicationIconImage` |
| `run()`: the blocking loop | `tao`: `EventLoop::run` |
| `runEventLoop`: the loop pumped from a Bun timer | `tao`: `run_return`, called once per tick |
| Webview in a window, or a child webview with bounds | `wry`: `build`, `build_as_child`, `with_bounds` |
| Page-to-host calls with no TCP | `wry`: `with_ipc_handler` |
| Host-to-page replies and events | `wry`: `evaluate_script` |
| The worker's wake-up of the UI thread | `tao`: `EventLoopProxy::send_event` |

### Every addition in the C++ webview fork

All kept.

| Addition | C API today | Provided by |
|---|---|---|
| Background colour and transparency | `webview_set_background_color` | `wry`: `with_transparent`, `with_background_color` |
| Assets at the page's own origin | `webview_set_asset` | `wry`: `with_custom_protocol` |
| Request handler | `webview_set_request_handler`, `webview_complete_request` | `wry`: `with_asynchronous_custom_protocol`; header validation, status and size limits in Sweetview's safe Rust, ported from `http_request.hh` with its tests |
| Frames origin, cross-origin from the page | part of the request handler | `wry`: a second custom protocol scheme |
| Service-worker, shared-worker and cross-origin iframe requests reaching the handler on Windows | part of the request handler | the `wry` fork: `AddWebResourceRequestedFilterWithRequestSourceKinds` |
| Streamed responses | `webview_begin_response`, `webview_write_response_chunk`, `webview_end_response` | the `wry` fork: a streaming body on WebView2 and `didReceiveData:` per chunk on WKWebView, ported from `streaming_istream.hh` and `cocoa_webkit.hh` |
| External drop control with HTML drops inside the page still working | `webview_set_allow_external_drop` | the `wry` fork: the C++ fork's drag routing |
| File drop paths | `webview_set_file_drop_handler` | the `wry` fork: the same drag routing |
| Bindings reachable from the top-level document only | internal | the `wry` fork: IPC messages from other frames are refused |
| System-wide mouse hook | `webview_mouse_hook_install`, `webview_mouse_hook_remove` | Sweetview `platform`: `SetWindowsHookExW(WH_MOUSE_LL)`, `CGEventTap`; ported from `mouse_hook.hh` |
| System-wide keyboard hook, DOM key codes | `webview_keyboard_hook_install`, `webview_keyboard_hook_remove` | Sweetview `platform`: `WH_KEYBOARD_LL`, the same event tap; `key_codes.hh` ported with its tests |
| Permission model for the hooks | `webview_feature_permissions`, `webview_permission_status`, `webview_permission_request`, `webview_permission_set_auto_request` | Sweetview `platform`: `CGPreflightPostEventAccess`, `CGRequestPostEventAccess` |
| Teardown hardening | internal | Rust ownership: a webview, its handlers and its open requests are freed together when the `WebView` value is dropped |

### What this project writes in Rust

| Where | What | Unsafe |
|---|---|---|
| `wry` fork | streamed response bodies; all request source kinds on Windows; the C++ fork's drag routing; top-level-only IPC | yes |
| `tray-icon` fork | the balloon notification and its click event on Windows | yes |
| Sweetview `platform::input` | mouse hook, keyboard hook, permissions | yes |
| Sweetview `platform::notify` | macOS notifications | yes |
| Sweetview `platform::misc` | mouse-button state, work area, `colorKey` and `opacity`, window level and collection behaviour, SF Symbols, Dock icon | yes, one call each |
| Sweetview `hit`, `http`, `menu`, `click`, `resize` | hit-region poll and refine state machine; header validation; menu data; click timing; the resize gesture | no |
| Sweetview `napi_surface`, `callbacks`, `registry`, `threads` | the N-API layer | no |

## The games: required functions and the gate

Every function of Sweetview, the bindings and the C++ fork is treated as required by the owner's games. The functions below are the ones a full-screen transparent game with click handling exercises directly.

| Function | Provided by | Check that exists today | Proven at |
|---|---|---|---|
| A transparent, frameless, topmost window that never takes focus, above the taskbar or Dock | `tao`, `platform::misc` for the macOS window level | `demos/desktop-pet`; `scripts/shot.ps1`, `scripts/flicker.ps1` | step 5 |
| A transparent page background, alpha 0 | `wry` `with_transparent`, `with_background_color` | the fork's background colour tests; `demos/desktop-pet` | step 2 |
| Whole-window click-through on and off | `tao` `set_ignore_cursor_events` | `scripts/settings-probe.ps1` | step 5 |
| Hit regions: polygons from the page, 10 ms poll, exact answer from the page, no flip while a button is down | Sweetview `hit`, `platform::misc` | `hit-regions.test.ts`; `scripts/probe.ps1`, which sends real input and reports which window the OS hands each click to | step 5 |
| System-wide mouse hook: move, left, right, middle, wheel, modifiers, swallow per event | Sweetview `platform::input` | `examples/input-hooks.ts`; the fork's unit tests | step 4 |
| System-wide keyboard hook: down, up, repeat, DOM key codes, modifiers, swallow per event | Sweetview `platform::input` | `examples/input-hooks.ts`; the fork's key-code unit tests | step 4 |
| macOS permission model for the hooks: needed, status, request, auto-request | Sweetview `platform::input` | `examples/input-hooks.ts` | step 4 |
| Window move and resize driven by the page, every frame | `tao` | `demos/desktop-pet` | step 5 |
| Every monitor: screen, screen at a point, virtual screen, scale | `tao` | `demos/desktop-pet` on a second monitor | step 5 |
| Assets, models and textures served at the page's origin | `wry` custom protocol | `test/request-handler.test.ts` | step 2 |
| Page calls answered on the UI thread and in the worker; events to the page | `wry` IPC, the ring | `demos/desktop-pet`, `demos/web-app` | step 2 |
| Both loop modes | `tao` | `demos/web-app`, `demos/menubar-only` | step 1 |
| One executable from `bun build --compile` | the `.node` binding | each demo's `compile` recipe | step 1 |

Nothing in this table works until its step is built and its check passes. This document is a design; it proves nothing by itself.

The gate:

- The current stack stays intact, published and usable throughout: the TypeScript FFI, `@n1h/sweetview-webview-bun` and the C++ fork. A game keeps running on it at every point.
- The Rust library ships beside it under its own package version. A game moves to it by changing a dependency and moves back the same way.
- Nothing of the current stack is deleted until every check in this document passes on Windows and macOS, and the owner's games run on the Rust library.
- A function that cannot be made to work in Rust stops the migration at that step. The current stack remains the shipping one.

## Fork additions, located

### `tray-icon`: the Windows balloon

Read in `src/platform_impl/windows/mod.rs` on the crate's `dev` branch.

| Existing code | What it does | The addition |
|---|---|---|
| `struct TrayUserData` and `pub struct TrayIcon`, both holding `hwnd` and `internal_id` | the tray's hidden window and its `uID` | nothing; the addition uses both |
| `register_tray_icon`, `TrayIcon::set_icon`, `TrayIcon::set_tooltip` | fill `NOTIFYICONDATAW` with `NIF_MESSAGE`, `NIF_ICON`, `NIF_TIP` and call `Shell_NotifyIconW` | a new `TrayIcon::show_balloon(title, body, silent, icon)`: `NIM_MODIFY` with `NIF_INFO`, `szInfo`, `szInfoTitle`, `dwInfoFlags`, as `win32/tray.ts` does today |
| `tray_proc`, the arm for `WM_USER_TRAYICON` | matches mouse messages and sends `TrayIconEvent::Click` or `DoubleClick` | one more match arm for `NIN_BALLOONUSERCLICK` sending a new `TrayIconEvent::BalloonClick` |
| the arm for `S_U_TASKBAR_RESTART` | re-adds the icon when Explorer restarts | nothing; this is the `TaskbarCreated` behaviour Sweetview has today |

The file has no `NIF_INFO`, no `NIN_*` constant and no notification code today.

### `wry`: what it already does, and the five additions

Read on the crate's `dev` branch: `src/webview2/mod.rs`, `src/webview2/drag_drop.rs`, `src/wkwebview/mod.rs`, `src/wkwebview/drag_drop.rs`, `src/wkwebview/class/url_scheme_handler.rs`, `src/wkwebview/class/wry_web_view.rs`, `src/wkwebview/class/wry_web_view_delegate.rs`.

Already in `wry`, so no addition is needed:

| Fork behaviour | Where `wry` has it |
|---|---|
| Requests from service workers, shared workers and cross-origin iframes reach the handler on Windows | `attach_custom_protocol_handler` in `src/webview2/mod.rs` calls `AddWebResourceRequestedFilterWithRequestSourceKinds` with `COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL` when `ICoreWebView2_22` is present, and falls back to `AddWebResourceRequestedFilter` |
| Requests held open until answered | the same function takes `args.GetDeferral()` and completes it from the responder, on the UI thread through `dispatch_handler` |
| Windows page messages from the top-level document only | `attach_ipc_handler` subscribes `add_WebMessageReceived` on the top-level `ICoreWebView2` only |
| Custom scheme mapped to an `http://` origin on Windows | `custom_protocol_workaround` |

Four of the five additions, each with the function it changes:

| Addition | File and function in `wry` | Change | Reference in the C++ fork |
|---|---|---|---|
| Streamed response bodies, Windows | `src/webview2/mod.rs`: `prepare_web_request_response`, which builds the body with `SHCreateMemStream` over the whole response | a second responder that passes an `IStream` whose `Read` blocks until a chunk or the end arrives | `streaming_istream.hh` |
| Streamed response bodies, macOS | `src/wkwebview/class/url_scheme_handler.rs`: the nested `fn response` inside `start_task`, which calls `didReceiveResponse`, one `didReceiveData`, `didFinish` | a second responder that calls `didReceiveData` per chunk, behind the existing `check_task_is_valid` guard | `begin_response_impl`, `write_response_chunk_impl`, `end_response_impl` in `cocoa_webkit.hh` |
| Drag routing, macOS: drags from other apps only, file drags to the handler, everything else to WebKit, one route per drag session | `src/wkwebview/drag_drop.rs`: `dragging_entered`, `dragging_updated`, `perform_drag_operation`, `dragging_exited`, which today call the handler for every drag and never read `draggingSource`; and `src/wkwebview/class/wry_web_view.rs`, which does not override `prepareForDragOperation:` or `draggingEnded:` | the fork's session routing | `get_webview_class` in `cocoa_webkit.hh` |
| Page messages from the top-level document only, macOS | `src/wkwebview/class/wry_web_view_delegate.rs`: `did_receive`, which reads `msg.frameInfo()` for the URL and does not check the frame | return early unless `frameInfo().isMainFrame()` | the script message handler in `cocoa_webkit.hh` |

Done outside `wry`, in Sweetview's `platform` code, through `WebViewExtWindows::controller()`, `webview()` and `environment()`:

| Fork behaviour | How |
|---|---|
| External drop control, Windows | `ICoreWebView2Controller4::SetAllowExternalDrop` on `controller()` |
| File drop paths, Windows, with WebView2's own drop target left in place | the C++ fork's method: an initialization script that posts the dropped `File` objects with `postMessageWithAdditionalObjects`, and a `WebMessageReceived` handler on `webview()` that reads each `ICoreWebView2File` path. `wry`'s own `with_drag_drop_handler` is not used on Windows, because `DragDropController` in `src/webview2/drag_drop.rs` revokes WebView2's drop targets and rejects non-file drags |
| Bridge and drop scripts in the top-level document only, Windows | each script starts with `if (window !== window.top) return`, as the C++ fork's do. `wry` adds scripts to every frame on Windows |

The fifth addition, needed by tabs for the "This site did not open" page:

| Addition | File in `wry` | Change |
|---|---|---|
| Navigation-failed event, macOS | `src/wkwebview/class/wry_navigation_delegate.rs`: `WryNavigationDelegate` implements `decidePolicyForNavigationAction`, `decidePolicyForNavigationResponse`, `didFinishNavigation`, `didCommitNavigation`, the two download methods and `webViewWebContentProcessDidTerminate`. It does not implement `webView:didFailNavigation:withError:` or `webView:didFailProvisionalNavigation:withError:`, and no builder callback reports a failed load | add the two methods and a handler ivar beside `on_page_load_handler`. `wry` owns the navigation delegate, so the tabs demo's own delegate cannot be installed |
| Navigation-failed event, Windows | none | outside `wry`: `add_NavigationCompleted` on `WebViewExtWindows::webview()`, with the failure rules `win-webview2.ts` has today |

## API references

"Read" means the docs.rs page for that item was read on 2026-11-27 and the item is declared safe unless noted.

| Item | Crate and version | Read |
|---|---|---|
| `WindowBuilder::with_visible`, `with_decorations`, `with_transparent`, `with_always_on_top`, `with_always_on_bottom`, `with_focusable`, `with_resizable`, `with_inner_size`, `with_position`, `with_title`, `with_window_icon`, `with_theme`, `with_visible_on_all_workspaces` | `tao` 0.38.0 | yes |
| `WindowBuilderExtWindows::with_skip_taskbar`, `with_no_redirection_bitmap`, `with_undecorated_shadow`, `with_owner_window`, `with_window_classname` | `tao` 0.38.0 | yes |
| `Window::set_ignore_cursor_events`, `cursor_position`, `outer_position`, `set_outer_position`, `inner_size`, `outer_size`, `set_inner_size`, `set_always_on_top`, `set_decorations`, `set_focusable`, `set_visible`, `is_visible`, `set_minimized`, `set_maximized`, `is_maximized`, `drag_window`, `drag_resize_window`, `scale_factor`, `current_monitor`, `primary_monitor`, `available_monitors`, `monitor_from_point`, `set_window_icon`, `set_theme`, `set_visible_on_all_workspaces` | `tao` 0.38.0 | yes |
| `WindowExtWindows::hwnd`, `set_skip_taskbar`, `set_enable`, `set_undecorated_shadow` | `tao` 0.38.0 | yes |
| `WindowExtMacOS::ns_window`, `ns_view`, `set_has_shadow`, `set_tabbing_identifier`, `tabbing_identifier`, `set_allows_automatic_window_tabbing`. The trait has no method for window level or collection behaviour | `tao` 0.38.0 | yes |
| `EventLoopExtMacOS::set_activation_policy`, `set_dock_visibility`, `set_activate_ignoring_other_apps`, each effective only before the loop starts; `EventLoopWindowTargetExtMacOS::set_activation_policy_at_runtime` named there | `tao` 0.38.0 | yes |
| `EventLoopProxy::send_event` | `tao` 0.38.0 | yes |
| `EventLoopExtRunReturn::run_return`: documented as discouraged; does not return while a window is being resized | `tao` 0.38.0 | yes |
| `WebViewBuilder::with_custom_protocol`, `with_asynchronous_custom_protocol`, `with_ipc_handler`, `with_initialization_script`, `with_initialization_script_for_main_only`, `with_transparent`, `with_background_color`, `with_devtools`, `with_drag_drop_handler`, `with_bounds`, `build`, `build_as_child` | `wry` 0.58.2 | yes |
| `WebView::evaluate_script`, `evaluate_script_with_callback`, `load_url`, `load_html`, `set_background_color`, `bounds`, `set_bounds`, `set_visible`, `focus`, `open_devtools` | `wry` 0.58.2 | yes |
| `WebViewExtWindows::controller`, `webview`, `environment`, `hwnd`, `reparent` | `wry` 0.58.2 | yes |
| `TrayIconBuilder::with_icon`, `with_tooltip`, `with_title`, `with_menu`, `with_menu_on_left_click`, `with_menu_on_right_click`; `TrayIcon::set_icon`, `set_menu`, `set_tooltip`, `set_visible`, `set_show_menu_on_left_click`, `show_menu`, `rect` | `tray-icon` 0.27.0 | yes |
| `TrayIconEvent::Click` with `button` and `button_state`; `DoubleClick`, Windows only; `Enter`, `Move`, `Leave`; `set_event_handler`. AppIndicator emits no events; KSNI emits left and middle clicks | `tray-icon` 0.27.0 | yes |
| `Menu`, `Submenu`, `MenuItem`, `CheckMenuItem` with `set_checked`, `set_text`, `set_enabled`; `PredefinedMenuItem`; `MenuEvent::set_event_handler`. `show_context_menu_for_hwnd` and `show_context_menu_for_nsview` are `unsafe` calls | `muda` 0.22.0 | yes |
| `IconMenuItem::new`, `with_id`, `with_native_icon`, `set_icon`, `set_text`, `set_enabled` | `muda` 0.22.0 | yes |
| `WebViewBuilder::with_navigation_handler`, `with_on_page_load_handler`, `with_new_window_req_handler`, `with_document_title_changed_handler`, `with_url`, `with_html`. No callback reports a failed load | `wry` 0.58.2 | yes |
| `FileDialog::set_title`, `set_parent`, `set_can_create_directories`, `pick_folder` | `rfd` 0.18.0 | yes |
| `MessageDialog::set_title`, `set_description`, `set_buttons`, `set_parent`, `show` | `rfd` 0.18.0 | yes |
| `Notification::summary`, `body`, `icon`, `appname`, `timeout`, `action`, `show` | `notify-rust` 4.19.0 | yes, the Linux page |
| `NSWindow::setLevel`, `setCollectionBehavior`, `setAlphaValue`, `setOpaque`, `setIgnoresMouseEvents`, `setHasShadow`, `setStyleMask`, `frame`, `setFrame_display`, `setFrameOrigin`, `makeKeyAndOrderFront`, `orderFrontRegardless`, `orderOut`, `isVisible`, `isZoomed`, `zoom`, `miniaturize`, `performWindowDragWithEvent`, `standardWindowButton`, `addTabbedWindow_ordered`, `tabGroup`, `toggleTabBar`, `setTabbingIdentifier`, `setTabbingMode`, `setContentMinSize`, `setMinSize`, `screen`, `performClose`: all safe. `setNextResponder` and `setReleasedWhenClosed`: `unsafe` | `objc2-app-kit` 0.3.2 | yes |
| `NSEvent::pressedMouseButtons`, `mouseLocation`, `doubleClickInterval`, `modifierFlags`, `clickCount`, `type`: all safe | `objc2-app-kit` 0.3.2 | yes |
| `NSScreen::screens`, `mainScreen`, `frame`, `visibleFrame`, `backingScaleFactor`: all safe | `objc2-app-kit` 0.3.2 | yes |
| `NSImage::imageWithSystemSymbolName_accessibilityDescription`, `initWithData`, `setTemplate`, `setSize`: all safe | `objc2-app-kit` 0.3.2 | yes |
| `NSApplication::sharedApplication`, `setActivationPolicy`, `activate`, `currentEvent`, `keyWindow`, `mainMenu`, `setMainMenu`, `setWindowsMenu`, `nextEventMatchingMask_untilDate_inMode_dequeue`, `sendEvent`, `finishLaunching`, `updateWindows`: all safe. `setApplicationIconImage`: `unsafe` | `objc2-app-kit` 0.3.2 | yes |
| `UNUserNotificationCenter::currentNotificationCenter`, `setDelegate`, `requestAuthorizationWithOptions_completionHandler`, `addNotificationRequest_withCompletionHandler`: all safe; completion handlers are `block2::DynBlock` | `objc2-user-notifications` 0.3.2 | yes |
| `CGEvent::tap_create`: `unsafe`. `CGEvent::tap_enable`, `flags`, `location`, `integer_value_field`, `double_value_field`, `type`: safe | `objc2-core-graphics` 0.3.2 | yes |
| `SetWindowsHookExW`: `unsafe`, returns `Result<HHOOK>`. `Shell_NotifyIconW`: `unsafe` | `windows` 0.62.2 | yes |
| the other `windows` functions named in this document: `GetAsyncKeyState`, `SystemParametersInfoW`, `SetLayeredWindowAttributes`, `CreateMutexW`, `FindWindowExW`, `SendMessageTimeoutW`, the registry and clipboard calls, the WinRT toast types | `windows` 0.62.2 | no; every Win32 function in this crate is `unsafe` |
| `objc2-core-foundation` `CFMessagePort` functions | not read | no |
| `napi` `Function` called from inside a native loop; `.node` loading by `require`; embedding by `bun build --compile` | `napi` 3.16.3 on Bun 1.4.4 | built and run; see "Proofs run" |

One consequence of these readings for memory safety on macOS: almost every AppKit call this project makes is a safe method. The `unsafe` there is the one conversion of `tao`'s `ns_window()` pointer into an `NSWindow` reference, plus `setNextResponder`, `setApplicationIconImage`, `CGEvent::tap_create` and the classes defined with `define_class!`.

One correction these readings forced: `tao` has no window level or collection behaviour call, so "above the Dock, on every Space" on macOS is written by this project against `NSWindow`, through the pointer from `ns_window()`.

One addition they found: `tao` has `set_tabbing_identifier`, which is the macOS native-tabs mechanism the tabs demo implements by hand.

## Architecture

| Layer | Content | Language |
|---|---|---|
| App | the developer's single `.ts` file | TypeScript |
| Sweetview API | the public API of today, unchanged | TypeScript |
| Binding | `sweetview.<target>.node`, loaded with `require` | Rust |

Sweetview's native layer already has the seam this design uses. Each module declares a `Backend` type and picks an implementation with `backend(win32, darwin)` in `src/native/platform.ts`: `event-loop`, `window`, `overlay`, `tray`, `notifications`, `folder-picker`, `app-menu`, `app-icon`. The Rust library implements those eight `Backend` types and `platform.ts` returns it. The bindings' `Webview` class keeps its public shape and calls the Rust library in place of `lib.symbols.*`.

## The N-API surface

Internal to the package. Signatures are the generated TypeScript.

```ts
class Engine {
  static create(debug: boolean, window: bigint | null): Engine;
  readonly handle: bigint;
  readonly windowHandle: bigint;
  setTitle(title: string): void;
  setSize(width: number, height: number, hint: number): void;
  navigate(url: string): void;
  setHtml(html: string): void;
  init(source: string): void;
  eval(source: string): void;
  bind(name: string, fn: (seq: string, req: string) => void): number;
  unbind(name: string): number;
  returnValue(seq: string, status: number, result: string): void;
  run(): void;
  terminate(): void;
  destroy(): void;
  setAsset(path: string, mime: string, data: Uint8Array): number;
  setBackgroundColor(r: number, g: number, b: number, a: number): number;
  setRequestHandler(fn: ((req: RawRequest) => void) | null): number;
  setFileDropHandler(fn: ((paths: string[]) => void) | null): number;
  setAllowExternalDrop(allow: boolean): number;
  setDrain(fn: (() => void) | null): void;
}

// Callable from any thread:
function completeRequest(handle: bigint, id: bigint, status: number, headersJson: string | null, body: Uint8Array | null): number;
function beginResponse(handle: bigint, id: bigint, status: number, headersJson: string | null): number;
function writeResponseChunk(handle: bigint, id: bigint, chunk: Uint8Array): number;
function endResponse(handle: bigint, id: bigint): number;
function wake(handle: bigint): void;

function installMouseHook(fn: (event: number, x: number, y: number, wheel: number, modifiers: number) => boolean): number;
function removeMouseHook(): number;
function installKeyboardHook(fn: (event: number, code: string, raw: number, modifiers: number) => boolean): number;
function removeKeyboardHook(): number;
function featurePermissions(feature: number): number;
function permissionStatus(permission: number): number;
function permissionRequest(permission: number): number;
function permissionSetAutoRequest(on: boolean): number;

function pumpEvents(): boolean;
function discardQuit(): void;
function setActivationPolicy(policy: ActivationPolicy): void;

class NativeWindow {
  constructor(handle: bigint);
  isVisible(): boolean; show(): void; hide(): void;
  setIcon(ico: Uint8Array | null): void;
  onCloseRequest(fn: (() => void) | null): void;
}

class Overlay {
  static create(options: OverlayWindowInit): Overlay;
  static adopt(handle: bigint, options: OverlayInit): Overlay;
  readonly handle: bigint;
  show(): void; hide(): void; setIcon(ico: Uint8Array | null): void;
  bounds(): Rect; moveTo(x: number, y: number): void; resize(w: number, h: number): void; setBounds(r: Rect): void;
  setClickThrough(on: boolean): void;
  setHitRegions(packed: Int32Array | null, refine: ((x: number, y: number, seq: number) => void) | null): void;
  answerHit(seq: number, solid: boolean): void;
  setTopmost(on: boolean): void; startDrag(): void; startResize(edge: ResizeEdge): void;
  minimize(): void; toggleMaximize(): void; maximized(): boolean;
  cursor(): Point; screen(): Rect; screenAt(x: number, y: number): Rect; workArea(): Rect; virtualScreen(): Rect; scale(): number;
}

class Tray {
  constructor(init: TrayInit);   // icon, tooltip, onClick, onDoubleClick, openMenu, menuChosen
  setTooltip(text: string): void; setIcon(icon: IconBytes): void; setHasMenu(has: boolean): void; dispose(): void;
  showBalloon(n: BalloonInit): boolean;
  onBalloonClick(fn: (() => void) | null): void;
}

class Notifier {
  constructor(onClick: ((id: string, dataJson: string | null) => void) | null);
  notify(n: NotificationInit): boolean; dispose(): void;
}

function pickFolder(owner: bigint | null, title: string): string | null;
function installAppMenu(appName: string, aboutText: string): void;
function setAppIcon(icon: IconBytes): void;
```

The data types those signatures use:

```ts
type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
type ActivationPolicy = "regular" | "accessory" | "prohibited";

type RawRequest = { id: bigint; method: string; url: string; headersJson: string; body: Uint8Array | null };

// One icon, as Sweetview's `Icon` type carries it today.
type IconBytes = { ico?: Uint8Array; png?: Uint8Array; symbol?: string; template?: boolean };

type OverlayInit = { transparent: boolean; colorKey?: string; opacity?: number; topmost: boolean; hideFromTaskbar: boolean; noActivate: boolean };
type OverlayWindowInit = OverlayInit & { title: string; bounds?: Rect; frame: boolean; appearance: "system" | "light" | "dark"; icon?: IconBytes };

type MenuData = MenuItemData[];
type MenuItemData =
  | { kind: "item"; id: number; label: string; enabled: boolean; checked: boolean; icon?: IconBytes }
  | { kind: "submenu"; label: string; enabled: boolean; icon?: IconBytes; items: MenuData }
  | { kind: "separator" };

type TrayInit = {
  tooltip: string;
  icon?: IconBytes;
  hasMenu: boolean;
  onClick: (() => void) | null;
  onDoubleClick: (() => void) | null;
  openMenu: () => MenuData;                  // called when the menu is about to open
  menuChosen: (id: number) => void;          // called after the menu closes
};

type BalloonInit = { title: string; body: string; silent: boolean };
type NotificationInit = { id: string; title: string; body: string; silent: boolean; dataJson: string | null };
```

- Numeric results keep the `webview_error_t` codes of today, so `WebviewError` and every documented code stay as they are.
- Menus stay data. When a menu is about to open the library calls `openMenu()`; TypeScript resolves the template, keeps the click handlers by item number, and returns plain data. The library builds the `muda` menu and calls `menuChosen(itemNumber)`.

## Threads

| Thread | May call |
|---|---|
| UI thread: the Bun main thread | everything |
| Worker threads | `completeRequest`, `beginResponse`, `writeResponseChunk`, `endResponse`, `wake`, as today |

- UI-thread state lives in `thread_local!` storage and in types that are not `Send`.
- Any other function called from a worker throws `sweetview: this call must be made on the UI thread`. Today that mistake is undefined behaviour.
- A worker reaches the UI thread through `tao`'s `EventLoopProxy`, which is `Send`.

## Callbacks from native code into JavaScript

Today a `JSCallback` lets the OS call JavaScript on the UI thread while that thread is inside the loop.

- The library keeps a reference to each JavaScript function and calls it synchronously on the UI thread, inside the native call that is running the loop.
- Each call opens its own handle scope.
- A JavaScript exception is caught at the boundary and logged with the message the TypeScript logs today. Nothing unwinds into the OS. The fallback results match today's: a hook returns "do not swallow", a request handler answers 500.
- A callback may remove or replace itself, or destroy its owner, from inside its own call. The library holds it for the duration of the call. The bindings' `NativeCallback`, `HookCallback`, `closeReleasedCallbacks` and `closeOrphans` exist only to do this by hand and go away.

## Event loop

| Mode | Today | After |
|---|---|---|
| `run()` | `webview_run`, blocking | `EventLoop::run`, blocking, entered from `Engine.run()` |
| `runEventLoop` | a Bun `setInterval` calling `pumpEvents`: `PeekMessageW` and `DispatchMessageW`, or `nextEventMatchingMask:` and `sendEvent:` | the same Bun timer calling `pumpEvents`, which calls `run_return` and exits it when the queue is empty |

`tao` documents that `run_return` does not return while a window is being resized. Today's pump has the same property: `DispatchMessageW` does not return during the OS's modal size loop.

## Transport

`Ring`, `ringBytes` and their documented behaviour stay; the ring is pure TypeScript over a `SharedArrayBuffer`.

| Hop | Today | After |
|---|---|---|
| page to UI thread | `webview_bind` of `__sweetview_rpc` | `wry`'s IPC handler |
| UI thread to worker | `worker.postMessage` | the same |
| worker to UI thread | frame into the ring, then `webview_dispatch` with a `JSCallback` pointer | frame into the ring, then `wake(handle)`, which sends a `tao` user event; the UI thread runs the function given to `setDrain` |
| UI thread to page | `webview_return`, `webview_eval` | `wry` `evaluate_script` |

## Handles and constants

- `Overlay.handle`, `WebviewApp.windowHandle` and `Webview.unsafeWindowHandle` stay the real OS handles, as `docs/native.md` and the bindings' docs define them: the `HWND` on Windows, the `NSWindow` pointer on macOS. `tao` returns them from `WindowExtWindows::hwnd()` and `WindowExtMacOS::ns_window()`.
- `Webview.unsafeHandle` and the `handle` argument of the worker functions stay in the API as an opaque number that names the webview. The library checks it against its table of live webviews.
- `assetOrigin` keeps its values: `http://webview.localhost` on Windows, `webview://localhost` on macOS.
- `framesOrigin` on Windows becomes `http://webview-frames.localhost`; today it is `http://frames.webview.localhost`. Apps read it from the getter.
- `WEBVIEW_PATH` pointed at a custom engine build. `SWEETVIEW_NATIVE_PATH` points at a custom build of the binding.

## Packaging

- One npm package holds the TypeScript and one `.node` binding per target: Windows x64, macOS arm64 and x64, Linux x64.
- The binding is loaded with a literal `require` per platform, the form `bun build --compile` embeds.
- CI builds with `cargo` on one runner per OS. Consumers install no Rust.
- `@n1h/sweetview-webview-bun` is folded into the one package; its API is re-exported unchanged.

## Module map

| TypeScript or C++ today | Lines | After |
|---|---|---|
| `win32/api.ts`, `darwin/objc.ts` | 485 | gone: the crates replace them |
| `win32/event-loop.ts`, `darwin/event-loop.ts` | 91 | `tao` event loop |
| `win32/window.ts`, `darwin/window.ts`, `win32/message-window.ts` | 213 | `tao` windows and events |
| `win32/overlay.ts`, `darwin/overlay.ts` | 869 | `tao`, Sweetview `hit` and `resize`, `platform::misc` |
| `win32/tray.ts`, `darwin/tray.ts` | 359 | `tray-icon` fork, Sweetview `click` |
| `win32/menu.ts`, `darwin/menu.ts`, `darwin/app-menu.ts` | 283 | `muda`, Sweetview `menu` |
| `win32/notifier.ts`, `darwin/notifier.ts` | 169 | `tray-icon` fork balloon; `platform::notify` |
| `win32/icon.ts`, `darwin/image.ts`, `darwin/app-icon.ts` | 142 | the crates' `Icon` types; `platform::misc` for SF Symbols and the Dock icon |
| `win32/folder-picker.ts`, `darwin/folder-picker.ts` | 150 | `rfd` |
| the bindings' `src/` | 2,014 | Sweetview `engine` on `wry` |
| C++ fork: backends, `engine_base.hh` | upstream plus 8,646 added | `wry` and its fork additions |
| C++ fork: `http_request.hh` | 683 | Sweetview `http`, safe Rust |
| C++ fork: `input_hooks.hh`, `mouse_hook.hh`, `keyboard_hook.hh`, `key_codes.hh` | 1,617 | Sweetview `platform::input` |
| C++ fork: `streaming_istream.hh` | 373 | `wry` fork |

Kept as TypeScript, untouched: `hit-regions.ts`, `icon.ts`, `menu.ts`, `ring.ts`, the IPC modules, `html.ts`, `build.ts`, `make-app.ts`, `settings-store.ts`, `window-chrome.ts`, `page.ts`.

## Tabs

Every file of `demos/native-tabs` on `main` and of the tabs library on `v1-drafting` was read in full for this section. The public API is `v1-drafting`'s: `new Window({ tabs: true })`, `WebView.openTab`, `Tab`, `TabOptions`, `createApp({ tabs: true })`.

### Windows

| Behaviour today | Provided by |
|---|---|
| One frame window per tabbed window, caption removed in `WM_NCCALCSIZE`, system border, shadow, snap and maximise kept | `tao` window with `with_decorations(false)` and `with_undecorated_shadow(true)` |
| A 40 DIP strip webview across the top, drawing tabs, `+` and the caption buttons | a `wry` child webview from `build_as_child` with `with_bounds`; the strip's HTML, CSS and script (`win-strip-assets.ts`) and its 15 `strip.*` methods stay TypeScript |
| One WebView2 per tab in a child pane; one shown at a time | one `wry` child webview per tab; `WebView::set_visible`, `set_bounds` |
| Tear-off and merge: a tab moves to another window without reloading | `WebViewExtWindows::reparent(hwnd)` |
| Shortcuts while a page has focus: Ctrl+T, Ctrl+W, Ctrl+F4, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp, Ctrl+PageDown, Ctrl+1 to 9, Alt+F4 | `add_AcceleratorKeyPressed` on `controller()`, through the typed handler of `webview2-com`. The mapping in `shortcuts.ts` stays TypeScript |
| `target="_blank"` and `window.open` become a tab | `wry` `with_new_window_req_handler` |
| Keyboard returned to the page after a strip action | `MoveFocus` on `controller()` |
| Popups follow the window when it moves | `NotifyParentWindowPositionChanged` on `controller()` |
| "This site did not open" page on a failed load | a navigation-failed event from the `wry` fork; the rules for which failures count stay as `win-webview2.ts` has them |
| Tab context menu and the window's system menu | `muda` context menu; `GetSystemMenu` and `TrackPopupMenu` in `platform` |
| Strip drag moves the window; top edge and corners resize it | `tao` `drag_window`, `drag_resize_window` |
| Minimum size, DPI change, dark title bar following the system | `tao` `with_inner_size_constraints`, `ScaleFactorChanged`, `set_theme` |
| File drops on the frame | `tao` `WindowEvent::DroppedFile` |

What goes away: the eight hand-built COM vtables in `win-webview2.ts`, their slot numbers from `WebView2.h`, and the callbacks that are never freed. `webview2-com` generates those handlers.

### macOS

| Behaviour today | Provided by |
|---|---|
| One `NSWindow` per tab inside AppKit window tabbing | `tao` windows with `set_tabbing_identifier` |
| A new tab placed after a given tab | `platform`: `NSWindow::addTabbedWindow_ordered` |
| The `+` button | `platform`: an `NSResponder` subclass implementing `newWindowForTab:` set as each window's next responder, defined with `define_class!` |
| Tab bar kept visible with one tab | `platform`: `NSWindowTabGroup::isTabBarVisible`, `toggleTabBar:` |
| File, View and Window menus with the tab items and key equivalents | `muda` |
| Close, become-main, resize and move per tab window | `tao` window events |
| Popups become a tab | `wry` `with_new_window_req_handler` |
| Failed-load page | the navigation-failed event from the `wry` fork |
| Every native call inside an autorelease pool | `objc2::rc::autoreleasepool` |
| Draining the main dispatch queue twice before a tab's webview is destroyed | not needed: it exists because the C++ engine queues replies holding a plain pointer to itself. `wry` guards each task with `check_task_is_valid` |

### Rule kept from today

Showing, hiding, moving and destroying a webview is deferred to its own turn of the loop. A webview is never destroyed inside its own callback.

## The `v1-drafting` features

Every file of each feature on `v1-drafting` was read in full for this section. Names, limits and wire formats stay exactly as they are, so an old build and a new build of the same app still find each other.

| Feature | What stays identical | Provided by |
|---|---|---|
| Single instance, Windows | mutex `Local\sweetview.instance.<id>`; message-only window class `SweetviewSingleInstanceWindow`, title `sweetview.instance.<id>`; `WM_COPYDATA` with magic `0x53575631`; JSON `{args, cwd, url?}`; 10 lookups 25 ms apart; 5000 ms send timeout | `platform` on `windows`: `CreateMutexW`, `FindWindowExW`, `SendMessageTimeoutW` |
| Single instance, macOS | port name `sweetview.<sha256 of appId>`; message id 1; 1.5 s send timeout; no reply | `platform` on `objc2-core-foundation`: `CFMessagePort` |
| URL opened while running, macOS | URLs buffered until `signalReady()`, then delivered in arrival order | `tao`: `Event::Opened` |
| `registerUrlScheme`, Windows | `HKCU\Software\Classes\<scheme>` with `URL Protocol`, `DefaultIcon`, `shell\open\command` | `platform` on `windows`: registry calls |
| Clipboard text | Windows: 5 attempts 5 ms apart, a hidden owner window for writes, read bounded by `GlobalSize`. macOS: `public.utf8-plain-text` | `platform` on `windows` and `objc2-app-kit` |
| Screen information | physical pixels and effective DPI on Windows; points with y flipped on macOS | `tao` monitors; `platform` for the work area |
| Native file reading | all of it | unchanged: it is `node:fs`, with no native code |
| WinRT toasts | AUMID key under `HKCU\Software\Classes\AppUserModelId`; the toast XML; balloon as the fallback | `windows` crate WinRT types: `ToastNotificationManager`, `ToastNotification`, `XmlDocument`, `TypedEventHandler`. This removes the C shim compiled at run time with Bun's `cc`, the hand-built delegate objects and the vtable slot numbers |
| Notifier, macOS | one shared delegate; clicks routed by notification id through a map capped at 256; the per-process tag that stops old notifications counting as cold-launch clicks | `platform::notify` |
| `Menu.popup` at a point | ids from 1; `&` doubled on Windows; menu built fresh each time | `muda`: `show_context_menu_for_hwnd`, `show_context_menu_for_nsview`, both `unsafe` calls made from `platform` |
| App identity | all of it | unchanged: pure TypeScript |
| `Window` file drops | paths delivered to `onFileDrop` | `tao` `WindowEvent::DroppedFile` |
| Shared Win32 start-up: STA, per-monitor DPI, the hidden first window | all three | `tao` sets DPI awareness and initialises OLE; the hidden first window is a hidden `tao` window created first |

One disagreement between docs and code found while reading, kept as the code behaves: on Windows `tab.close()` on a window's last tab is offered to `onClose` listeners first and the tab stays when one intercepts; `docs/app.md` says it always closes.

## Linux

No Linux code exists in Sweetview today, and the C++ fork's additions do nothing there. Scope for the last step: a `tao` window with a `wry` webview on WebKitGTK, assets and IPC, a tray menu and left click through `tray-icon`'s `ksni` feature, a notification through `notify-rust`. Overlays, hit regions, input hooks and tabs are not in scope on Linux.

## Order of work

1. Binding skeleton on `napi`, `tao` and `wry`; CI producing the binaries. Proves two mechanisms: a JavaScript function called from the page while `run()` blocks, and a tray-only app with no window receiving clicks under the timer-pumped loop on Windows and macOS. Accepted by the bindings' `examples/basic.ts`, `examples/bind.ts` and `demos/menubar-only`.
2. The `Webview` API on `wry`: assets, background colour, bind, the request handler. Accepted by the parts of `test/request-handler.test.ts` that cover them.
3. The `wry` fork additions: streaming, request source kinds, drag routing, top-level-only IPC. Accepted by the rest of `test/request-handler.test.ts`, unchanged.
4. Input hooks and permissions. Accepted by the ported key-code tests and `examples/input-hooks.ts`.
5. Windows, overlays, hit regions. Accepted by `demos/web-app` and `demos/desktop-pet`.
6. Tray, menus, notifications, folder dialog, app menu, app icon. Accepted by `demos/menubar-notify`.
7. Native tabs. Accepted by `demos/native-tabs`.
8. The gate: every check in this document passes on Windows and macOS, and the owner's games run on the Rust library. Only then are the TypeScript FFI, the bindings package and the dependency on the C++ fork deleted.
9. The `v1-drafting` features, one at a time.
10. Tauri 2 and Electron IPC transports: page code identical across webview, WebSocket, Tauri 2 and Electron.
11. Linux.

## Risks and actions

| Risk | Action |
|---|---|
| The two loop mechanisms are proven on Windows and not on macOS | Step 1 runs the same proof on a Mac before any macOS module is built. If the timer pump fails there, the pump function dequeues events itself with `NSApplication::nextEventMatchingMask_untilDate_inMode_dequeue` and `sendEvent`, the calls today's `pumpEvents` makes; both are safe methods in `objc2-app-kit`. |
| The tray proof used posted messages, not a person's click | Step 1's acceptance is `demos/menubar-only` clicked by hand on Windows and macOS. |
| A rebuilt module behaves differently from today. Every game-critical path is re-implemented under this proposal, so each one can differ | Each is accepted against its existing tests and demo. The current stack stays the shipping one until the gate in step 8 is passed. |
| The forks of `wry` and `tray-icon` drift from upstream | Each addition is one commit on top of a pinned upstream version, and is offered upstream. |
| `unsafe` spreads | `#![forbid(unsafe_code)]` on every Sweetview module outside `platform`. CI counts `unsafe` blocks and fails when the count rises without an entry in a tracked list. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Keep the C++ webview engine | It stays memory-unsafe C++ |
| Port each OS call to Rust by hand with `windows` and `objc2` only | Every OS call becomes an `unsafe` block; the safe crates already wrap most of them |
| Keep the TypeScript FFI | No compiler checks on any native call |
| `webviewjs/webview` | Its tray does not deliver events without a window; no check marks or icons in menus; one maintainer |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket; excluded by the project owner |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |

## What was read

- `n0t-invented-here/sweetview-webview-bun`, branch `v1-drafting`: every file in `src/`, the README, every page in `docs/`, `scripts/build.ts`, the justfile.
- `n0t-invented-here/sweetview-webview`, branch `v1-drafting`: every page in `sweetview/`; the full diff against upstream `f1a9d6b` of `engine_base.hh`, `win32_edge.hh` and `cocoa_webkit.hh`; `input_hooks.hh`.
- This repository on `main`: `README.md`, `docs/app.md`, `docs/native.md`, `docs/webview-library.md`, `src/app.ts`, `src/worker.ts`, `src/webview-lib.ts`, `src/ring.ts`, and every file under `src/native/` except `icon.ts` and `hit-regions.ts`.
- docs.rs pages of `tao` 0.38.0 (`Window`, `WindowBuilder`, `WindowBuilderExtWindows`, `EventLoopExtRunReturn`), `wry` 0.58.2 (`WebViewBuilder`), `muda` 0.22.0 and `tray-icon` 0.27.0 (crate pages).

## Sources

- https://docs.rs/tao/latest/tao/window/struct.Window.html
- https://docs.rs/tao/latest/tao/window/struct.WindowBuilder.html
- https://docs.rs/tao/latest/x86_64-pc-windows-msvc/tao/platform/windows/trait.WindowBuilderExtWindows.html
- https://docs.rs/tao/latest/tao/platform/run_return/trait.EventLoopExtRunReturn.html
- https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html
- https://docs.rs/muda/latest/muda/
- https://docs.rs/tray-icon/latest/tray_icon/
- https://github.com/napi-rs/napi-rs
- https://github.com/microsoft/windows-rs
- https://github.com/madsmtm/objc2
- https://bun.com/docs/api/node-api
- https://bun.com/docs/compiler/executables
