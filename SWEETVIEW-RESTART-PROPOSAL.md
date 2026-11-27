# Sweetview: native code in type-safe Rust

Status: design. The Readiness section lists what has been proven by running it and what has not, with the checklist item that proves each.

Rule: no functionality is removed. Everything Sweetview, the bindings and the C++ webview fork do today exists afterwards. Where a crate lacks something, this project writes it in Rust. The API is free to change where the design is better for it; each change has a row in `docs/upgrading.md`.

How this document is used: it is the design. `rust-rewrite/REQUIREMENTS.md` states what the result must be and outranks this document where the two differ; `rust-rewrite/CHECKLIST-<platform>.md` is the order of work with its acceptance.

## How the tree is organised

Branch `v1-rust-rewrite` is `main` with `v1-drafting` merged: six packages under `packages/`. A file name in this document is relative to `packages/sweetview-native/src/` unless it starts with `packages/`. `rust-rewrite/reference/ffi-files.md` lists the 34 files that import `bun:ffi`.

- One `Window` class over one `WindowBackend` interface (`window.ts`) covers framed windows, overlays, tabbed windows and wrapped windows. An overlay is a `Window` with `transparent`, `topmost`, `noActivate` and `hideFromTaskbar`.
- A webview is mounted inside a window that already exists. `WebView.attach(window, options)` in `packages/sweetview/src/app.ts` passes the `Window`'s handle to the engine, and the tabs library mounts one into each child pane it wraps with `Window.fromHandle`. The binding therefore mounts a `wry` webview into a window it is given by handle, as well as into windows it created.
- The native package picks an implementation per OS in one place: `backend(win32, darwin)` in `platform.ts`, used by eleven modules (`activation`, `app-icon`, `app-menu`, `clipboard`, `event-loop`, `folder-picker`, `menu`, `notifications`, `screen`, `tray`, `window`). On Windows each of those returns the Rust binding's implementation.
- The webview has no such seam: `packages/sweetview/src/app.ts`, `webview-lib.ts` and `worker.ts` call the bindings' `Webview` class and the C library's symbols directly.
- The input hooks and the permission model are exported only by the bindings package, `@n1h/sweetview-webview-bun`. Sweetview re-exports `SizeHint`, `WEBVIEW_VERSION` and `Webview` (as `RawWebview`) from it and nothing else. `rust-rewrite/reference/bindings-exports.txt` lists every name a Sweetview package exports once the bindings package is gone.
- A notification on Windows is a WinRT toast, with a balloon on a hidden notification icon of the notifier's own as the fallback (`win32/notifier.ts`, `win32/winrt-toast.ts`). The tray is not involved.

## Readiness

| Part | State | What closes it |
|---|---|---|
| JavaScript called from native code while the UI thread is inside the blocking loop, under Bun's N-API | **proven on Windows**; see "Proofs run" | on macOS: run the same proof on a Mac |
| `tao`'s loop pumped from a Bun timer delivering tray events with no window, with Bun's timers and promises still running | **proven on Windows** | on macOS: run the same proof on a Mac |
| `bun build --compile` embedding the `.node` binding into one executable | **proven on Windows** | on macOS: run the same proof on a Mac |
| The five behaviours `wry` lacks: streaming on Windows and macOS, macOS drag routing, macOS top-level-only IPC, macOS navigation-failed event | no fork: each is built outside `wry` through the native objects it hands out; see "What `wry` lacks, and where each is built" | Windows: nothing. macOS: checklist item M0.5 runs each of the four as a proof |
| The Windows notification fallback (a balloon on a hidden icon) | Sweetview `platform::notify`, on `Shell_NotifyIconW` | nothing |
| The binding loaded a second time inside a Bun `Worker`, waking the UI thread | **not proven**; today the worker opens the C library itself and calls `webview_dispatch` | checklist item W1.7, before any webview work |
| Every crate API the design names | read on docs.rs or in source, with version; see "API references" | nothing |
| Native tabs and every `v1-drafting` feature | designed from a full reading of their files; see "Tabs" and "The `v1-drafting` features" | nothing |
| Linux | scoped, not designed | the Linux goal, `rust-rewrite/CHECKLIST-linux.md` |

## Proofs run

A small crate, built and run on 2026-11-27 on Windows 11 with Bun 1.4.4 and Rust 1.97.1. Its source is `rust-rewrite/spike/`. It proves mechanisms and is not the start of the implementation.

Built with: `napi` 3.16.3, `napi-derive` 3.7.2, `napi-build` 2.7.0, `tao` 0.38.0, `wry` 0.58.2, `tray-icon` 0.27.0, `muda` 0.22.0, `windows` 0.62.2, `webview2-com` 0.39.1. Build time from clean: 43 seconds. The binding is 1.2 MB.

| Question | What was run | Result |
|---|---|---|
| Can native code call a JavaScript function while the UI thread is inside the blocking `tao` loop? | A `#[napi]` function creates a hidden `tao` window and a `wry` webview, serves a page from a custom protocol, and enters `run_return`. The page calls `window.ipc.postMessage`. The loop calls the JavaScript function it was given and exits with its return value | The JavaScript function ran once, inside the loop, and its return value came back: `pong<ping from http://webview.localhost> insideLoop=true`. 368 ms from call to result |
| Does a `tao` loop pumped from a Bun timer deliver tray events with no window? | `init` creates a `tao` event loop and a `tray-icon` icon and no window. A Bun `setInterval` at 16 ms calls `pump`, which runs `run_return` until `MainEventsCleared`. Four tray mouse messages are posted to the tray icon's own window, the messages the shell posts for a left and a right click | 4 messages posted, 4 `TrayIconEvent::Click` events delivered to the JavaScript function |
| Does Bun's own loop keep running between pumps? | a second 10 ms `setInterval` and a promise per tick, during 70 pump ticks | 109 timer ticks and 109 promise continuations ran |
| Does `bun build --compile` embed the binding? | the script loads the binding with a literal `require("./spike.node")`; the compiled executable is copied alone into an empty folder and run | the executable passed every check above with no `.node` file beside it |

Limits of these proofs:

- Windows only. No Mac was available on the machine they ran on.
- The tray clicks were the shell's messages posted by the test, not a person clicking.
- The page in the first proof was served through a `wry` custom protocol. The design serves pages through Sweetview's own request handler, which the proof did not exercise.
- The binding was loaded on the main thread only. Loading it again inside a `Worker` is checklist item W1.7.
- They prove the mechanisms, not the features built on them.

## What Sweetview is

Sweetview lets a Bun app open a webview window, put an icon in the tray or menu bar, show notifications, and draw transparent click-through windows on the desktop. The app is TypeScript and compiles to one executable with `bun build --compile`.

## The change

All native code becomes Rust. Bun reaches it through N-API. No C++ remains, and Sweetview's packages import `bun:ffi` nowhere except the few setup files requirement R3 allows.

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

No crate is forked. All of them are used as published on crates.io. What `wry` lacks is built outside it, through the native objects it hands out (`controller()`, `webview()`, `environment()`, `manager()`, `with_webview_configuration`); "What `wry` lacks, and where each is built" lists each behaviour with the `wry` source line it rests on.

## Memory safety

| Code | Unsafe |
|---|---|
| `tao`, `wry`, `muda`, `tray-icon`, `rfd` | inside the crates; their public APIs are safe |
| Sweetview's binding crate and logic crates | none: `#![forbid(unsafe_code)]` at each crate root |
| Sweetview's platform crates, named `sweetview-platform` or `sweetview-platform-<name>`: the webview pieces `wry` lacks, input hooks, notifications, adopted windows, and the single OS calls listed below | yes, under `rust-rewrite/UNSAFE-POLICY.md`: one operation per block, inside a safe function, on a type that owns the OS resource and releases it on drop |
| JavaScript | no native calls at all |

In this document `platform::webview`, `platform::input`, `platform::notify`, `platform::adopt` and `platform::misc` name modules of the platform crates. `hit`, `http`, `menu`, `click` and `resize` name modules of the logic crates. How the modules are grouped into crates is decided when the workspace is built and recorded in `rust-rewrite/DECISIONS.md`.

## What the Rust types enforce

Each row is something the TypeScript `bun:ffi` code does by hand today.

| Today, in TypeScript | In Rust | Example in this repository |
|---|---|---|
| Every handle is a `bigint` | Each is its own type: `tao::window::Window`, `wry::WebView`, `muda::Menu`, `tray_icon::TrayIcon`. Passing one where another belongs does not compile | `win32/api.ts`: every handle is `FFIType.u64` |
| Function signatures are written by hand, one `FFIType` list per call | The crates' signatures are checked by the compiler | commit `83d7411`: `isZoomed` read with the wrong return type, `orderFrontRegardless` called with the wrong arity |
| One hand-made `objc_msgSend` variant per signature shape | Typed methods | `darwin/objc.ts`: `sendRectUIntUIntBool`, `sendPtrSelPtrVoid` and 30 more |
| Structs are byte arrays with numeric offsets | Real structs with named fields | `win32/tray.ts`: `new Uint8Array(976)` with `NID_INFO = 304` |
| COM methods are called by vtable slot number | Typed interfaces | `win32/folder-picker.ts`: slots 3, 9, 10, 17, 20 |
| Release is called by hand | Ownership: values free their OS resources when dropped | `darwin/menu.ts`: `release(inited)`, `release(sub)`, `release(menu)` |
| Callbacks are `JSCallback` pointers kept alive in module-level arrays | The library owns each callback for exactly as long as the OS can call it | `objc.ts`: `const retained: JSCallback[] = []`, never freed |
| Thread rules are comments | UI-thread types are not `Send`. Using one from a worker thread does not compile | "Thread: UI thread" throughout `docs/native.md` |
| Return codes are checked where someone remembered | `Result<T, E>`; an unchecked result is a compiler warning | `win32/menu.ts`: `AppendMenuW` results are not checked |
| Options are strings and numbers | Enums | `edge.includes("left")` |
| TypeScript types for native calls are written by hand | The `.d.ts` is generated from the Rust | every `dlopen` table |

## Every behaviour, and what provides it

### Sweetview

| Behaviour | Provided by |
|---|---|
| Create a window hidden, frameless or framed, transparent, topmost, not focusable, off the taskbar | `tao`: `WindowBuilder::with_visible`, `with_decorations`, `with_transparent`, `with_always_on_top`, `with_focusable`, `with_skip_taskbar`, `with_no_redirection_bitmap` |
| Show, hide, move, resize, raise, bounds, all in outer-frame coordinates | `tao`: `set_visible`, `set_outer_position`, `set_inner_size`, `set_always_on_top`, `outer_position`, `outer_size`. `tao` sets the inner size only, so an outer size is converted by the difference between `outer_size` and `inner_size` |
| `onResize`, `onMove` | `tao`: `WindowEvent::Resized`, `Moved` |
| Minimum size | `tao`: `with_min_inner_size`, converted from the outer size the same way |
| A window Sweetview did not create, wrapped by `Window.fromHandle`, with its events and a webview mounted in it | Sweetview `platform::adopt`: `SetWindowSubclass` on Windows, as `win32/window.ts` does |
| Whole-window click-through | `tao`: `set_ignore_cursor_events` |
| Hit regions: 10 ms poll, polygons, the refine round trip to the page | Sweetview's `hit` module (safe Rust): `tao` `cursor_position` and `set_ignore_cursor_events` |
| "Never flip click-through while a mouse button is down" | Sweetview `platform`: `GetAsyncKeyState` on Windows, `NSEvent::pressedMouseButtons` on macOS |
| Screen, screen at a point, virtual screen, scale | `tao`: `primary_monitor`, `available_monitors`, `monitor_from_point`, `scale_factor` |
| Work area | Sweetview `platform`: `SystemParametersInfoW`, `NSScreen::visibleFrame` |
| Title-bar drag from the page | `tao`: `drag_window` |
| Edge resize from the page, minimum 160x120 | Sweetview's own gesture, as today, in safe Rust on `cursor_position` and `set_outer_position` |
| Minimise; maximise and restore | `tao` `set_minimized`. A framed window maximises through the OS: `set_maximized`, `is_maximized`. A frameless window toggles between its bounds and the work area of the screen it is on, in Sweetview's `resize` module |
| Window icon; light, dark or system frame | `tao`: `set_window_icon`, `set_theme` |
| `colorKey` and `opacity` | Sweetview `platform`: `SetLayeredWindowAttributes`, `NSWindow::setAlphaValue` |
| macOS: above the Dock, on every Space, out of window cycling, over full-screen apps | Sweetview `platform`: `NSWindow::setLevel`, `setCollectionBehavior` |
| A close request goes to the window's `onClose` listeners; with none, the window is disposed. Closing a window never ends the loop | `tao`: the `CloseRequested` event |
| Activation policy | `tao`: `EventLoopExtMacOS::set_activation_policy` before the loop starts, `EventLoopWindowTargetExtMacOS::set_activation_policy_at_runtime` after |
| Tray icon, tooltip, click and double click, menu | `tray-icon`, with the single and double click timing in safe Rust |
| Menus with check marks, icons, submenus, rebuilt on every open | `muda` |
| SF Symbol icons on macOS | Sweetview `platform`: `NSImage::imageWithSystemSymbolName` |
| Windows notifications: WinRT toasts with click, and a balloon on a hidden icon of the notifier's own as the fallback | Sweetview `platform` on the `windows` crate: the WinRT toast types, and `Shell_NotifyIconW` for the fallback |
| macOS notifications with click, data round trip, banners while frontmost | Sweetview `platform` on `objc2-user-notifications` |
| Folder dialog | `rfd` |
| macOS app menu with About, Quit and Edit | `muda` predefined items; the About alert through `rfd` |
| Dock icon at run time | Sweetview `platform`: `NSApplication::setApplicationIconImage` |
| `run()`: the blocking loop, which returns when the app quits | `tao`: `run_return`, left when the loop is asked to exit. `EventLoop::run` never returns to its caller and is not used |
| `runEventLoop`: the loop pumped from a Bun timer | `tao`: `run_return`, called once per tick and left when the queue is empty |
| Webview in a window, or a child webview with bounds | `wry`: `build`, `build_as_child`, `with_bounds` |
| Page-to-host calls with no TCP | Windows: `wry`'s `with_ipc_handler`. macOS: Sweetview's own script message handler |
| Host-to-page replies and events | `wry`: `evaluate_script` |
| The worker's wake-up of the UI thread | `tao`: `EventLoopProxy::send_event` |

### Every addition in the C++ webview fork

All kept.

| Addition | C API today | Provided by |
|---|---|---|
| Background colour and transparency | `webview_set_background_color` | `wry`: `with_transparent`, `with_background_color` |
| Assets at the page's own origin | `webview_set_asset` | Sweetview `platform::webview`: the one request handler described under streamed responses below, which serves assets first |
| Request handler | `webview_set_request_handler`, `webview_complete_request` | the same handler in Sweetview `platform::webview`; header validation, status and size limits in Sweetview's safe Rust, ported from `http_request.hh` with its tests |
| Frames origin, cross-origin from the page | part of the request handler | the same handler, on a second origin: `http://frames.webview.localhost` on Windows, the `webview-frames` scheme on macOS |
| Service-worker, shared-worker and cross-origin iframe requests reaching the handler on Windows | part of the request handler | the same handler, registering its filter with `AddWebResourceRequestedFilterWithRequestSourceKinds` and all source kinds, as `wry`'s own handler and the C++ fork both do |
| Streamed responses | `webview_begin_response`, `webview_write_response_chunk`, `webview_end_response` | Sweetview `platform`, outside `wry`. Windows: its own `WebResourceRequested` handler on `wry`'s `webview()` with its own `IStream`, ported from `streaming_istream.hh`. macOS: its own `WKURLSchemeHandler` on a configuration passed to `with_webview_configuration`, calling `didReceiveData:` per chunk, ported from `cocoa_webkit.hh` |
| External drop control with HTML drops inside the page still working | `webview_set_allow_external_drop` | Windows: `SetAllowExternalDrop` on `wry`'s `controller()`, from Sweetview `platform`. macOS: `wry`'s `with_drag_drop_handler`, with the C++ fork's drag routing kept in Sweetview `platform` |
| File drop paths | `webview_set_file_drop_handler` | Windows: the C++ fork's drop script and `WebMessageReceived` handler on `wry`'s `webview()`, from Sweetview `platform`. macOS: the same drag handler and routing |
| Bindings reachable from the top-level document only | internal | Windows: `wry` as it is, plus a top-frame guard in the bridge script. macOS: Sweetview's own script message handler, added through `wry`'s `manager()`, refuses messages from other frames |
| System-wide mouse hook | `webview_mouse_hook_install`, `webview_mouse_hook_remove` | Sweetview `platform`: `SetWindowsHookExW(WH_MOUSE_LL)`, `CGEventTap`; ported from `mouse_hook.hh` |
| System-wide keyboard hook, DOM key codes | `webview_keyboard_hook_install`, `webview_keyboard_hook_remove` | Sweetview `platform`: `WH_KEYBOARD_LL`, the same event tap; `key_codes.hh` ported with its tests |
| Permission model for the hooks | `webview_feature_permissions`, `webview_permission_status`, `webview_permission_request`, `webview_permission_set_auto_request` | Sweetview `platform`: `CGPreflightPostEventAccess`, `CGRequestPostEventAccess` |
| Teardown hardening | internal | Rust ownership: a webview, its handlers and its open requests are freed together when the `WebView` value is dropped |

### What this project writes in Rust

| Where | What | Unsafe |
|---|---|---|
| Sweetview `platform::webview` | what `wry` lacks, built on the native objects it hands out: streamed response bodies on Windows and macOS; on macOS the C++ fork's drag routing, top-level-only IPC and a navigation-failed event | yes |
| Sweetview `platform::input` | mouse hook, keyboard hook, permissions | yes |
| Sweetview `platform::notify` | Windows: WinRT toasts and the hidden-icon balloon fallback. macOS: notifications | yes |
| Sweetview `platform::adopt` | wrapping a window this process did not create through Sweetview (`Window.fromHandle`): its events by subclassing on Windows, and mounting a webview into it | yes |
| Sweetview `platform::misc` | mouse-button state, work area, `colorKey` and `opacity`, window level and collection behaviour, SF Symbols, Dock icon | yes, one call each |
| Sweetview `hit`, `http`, `menu`, `click`, `resize` | hit-region poll and refine state machine; header validation; menu data; click timing; the resize gesture | no |
| Sweetview `napi_surface`, `callbacks`, `registry`, `threads` | the N-API layer | no |

## Overlay applications: required functions and the gate

Every function of Sweetview, the bindings and the C++ fork is required. The functions below are the ones a full-screen transparent desktop application with click handling exercises directly.

| Function | Provided by | Check that exists today | Proven at |
|---|---|---|---|
| A transparent, frameless, topmost window that never takes focus, above the taskbar or Dock | `tao`, `platform::misc` for the macOS window level | `demos/desktop-pet`, with its `scripts/shot.ps1` and `scripts/flicker.ps1` | W4, M3 |
| A transparent page background, alpha 0 | `wry` `with_transparent`, `with_background_color` | the fork's background colour tests; `demos/desktop-pet` | W2, M1 |
| Whole-window click-through on and off | `tao` `set_ignore_cursor_events` | `demos/desktop-pet/scripts/settings-probe.ps1` | W4, M3 |
| Hit regions: polygons from the page, 10 ms poll, exact answer from the page, no flip while a button is down | Sweetview `hit`, `platform::misc` | `hit-regions.test.ts`; `demos/desktop-pet/scripts/probe.ps1`, which sends real input and reports which window the OS hands each click to | W4, M3 |
| System-wide mouse hook: move, left, right, middle, wheel, modifiers, swallow per event | Sweetview `platform::input` | the bindings' `examples/input-hooks.ts`; the C++ fork's unit tests | W3, M2 |
| System-wide keyboard hook: down, up, repeat, DOM key codes, modifiers, swallow per event | Sweetview `platform::input` | the bindings' `examples/input-hooks.ts`; the C++ fork's key-code unit tests | W3, M2 |
| macOS permission model for the hooks: needed, status, request, auto-request | Sweetview `platform::input` | the bindings' `examples/input-hooks.ts` | W3, M2 |
| Window move and resize driven by the page, every frame | `tao` | `demos/desktop-pet` | W4, M3 |
| Every monitor: screen, screen at a point, virtual screen, scale | `tao` | `demos/desktop-pet` on a second monitor | W4, M3 |
| Assets, models and textures served at the page's origin | Sweetview `platform::webview` request handler | the bindings' `test/request-handler.test.ts` | W2, M1 |
| Page calls answered on the UI thread and in the worker; events to the page | `wry` IPC, the ring | `demos/desktop-pet`, `demos/web-app` | W2, M1 |
| Both loop modes | `tao` | `demos/web-app`, `demos/menubar-only` | W1, M0 |
| One executable from `bun build --compile` | the `.node` binding | each demo's `compile` recipe | W1, M0 |

Nothing in this table works until its checklist group is built and its check passes. This document is a design; it proves nothing by itself.

The gate:

- The current stack stays available throughout as what it is today: the published packages, tag `pre-rust-rewrite` on this branch, and the `main` and `v1-drafting` branches. An application keeps running on it at every point, and nothing published is changed by this work.
- The work happens on branch `v1-rust-rewrite`, one platform at a time. The Windows goal replaces the Windows half and leaves macOS running on today's code; the macOS goal replaces the macOS half and removes the bindings package and the C++ library.
- A platform's old code is deleted only when that platform's checklist is complete: every item ticked with its evidence, every test that passed at the tag still passing, and the upgrade guide exercised.
- An application moves to the result by following `docs/upgrading.md`. The dependents run of requirement R2 does that to a copy of each real application and runs its own checks before the goal can complete.
- A function that cannot be made to work in Rust is first a reason to adjust the design. It stops the work only when no adjustment keeps the requirements, as R9 states.

## What `wry` lacks, and where each is built

No crate is forked. `wry` 0.58.2 does not have the five behaviours below as API. It hands out the native objects they are built on, so each is written in Sweetview `platform::webview`. Source references are to `wry` 0.58.2.

| Behaviour | Where `wry` stops | Built on |
|---|---|---|
| Streamed response bodies, Windows | its responder takes the whole body: `RequestAsyncResponder::respond` (`src/lib.rs:451`), turned into one `SHCreateMemStream` (`src/webview2/mod.rs:1261`) | Sweetview's own `WebResourceRequested` handler on the `ICoreWebView2` from `WebViewExtWindows::webview()`, with responses made by `environment()` (`src/lib.rs:2404-2407`) and its own `IStream` whose `Read` waits for the next chunk; ported from `streaming_istream.hh` |
| Streamed response bodies, macOS | one `didReceiveData` per response (`src/wkwebview/class/url_scheme_handler.rs`) | Sweetview's own `WKURLSchemeHandler`, registered on a `WKWebViewConfiguration` that Sweetview creates and passes to `WebViewBuilderExtMacos::with_webview_configuration` (`src/lib.rs:1672`); it calls `didReceiveData` per chunk; ported from `cocoa_webkit.hh` |
| Page messages from the top-level document only, macOS | its message handler does not check the frame (`src/wkwebview/class/wry_web_view_delegate.rs`, `did_receive`) | Sweetview's own `WKScriptMessageHandler`, added through `WebViewExtMacOS::manager()` (`src/lib.rs:2555`), which returns early unless `frameInfo.isMainFrame`. `wry`'s own IPC handler is not used on macOS |
| Navigation-failed event, macOS | no `didFailNavigation` and no `didFailProvisionalNavigation`; `wry` installs its own navigation delegate (`src/wkwebview/mod.rs:680`) | a Sweetview delegate that forwards every call to `wry`'s delegate and adds the two failure methods, set on the `WKWebView` from `WebViewExtMacOS::webview()` (`src/lib.rs:2553`) |
| Drag routing, macOS: drags from other apps only, file drags to the handler, everything else to WebKit, one route per drag | its drag handler is given `Enter`, `Over`, `Drop` and `Leave` with the dragged paths, and not the drag's source; returning `false` hands the drag to WebKit (`src/wkwebview/drag_drop.rs:79-81`) | `with_drag_drop_handler`, with Sweetview keeping the route chosen at `Enter` until `Drop` or `Leave`; a main-frame script reports `dragstart` and `dragend`, which tells an in-page drag from one that came from another app; routing rules ported from `get_webview_class` in `cocoa_webkit.hh` |

One request handler per platform serves assets, the request handler's routes, the frames origin and streamed responses. `wry`'s custom protocols are not used, so `wry` attaches no request handler of its own (`src/webview2/mod.rs:536`), and both origins are the ones Sweetview registers: `http://webview.localhost` and `http://frames.webview.localhost` on Windows, the `webview` and `webview-frames` schemes on macOS.

What `wry` already does and Sweetview uses as it is:

| Behaviour | Where |
|---|---|
| Creating the WebView2 or WKWebView inside a given window, as the window's content or as a child with bounds | `WebViewBuilder::build`, `build_as_child`, `with_bounds` |
| Scripts at document start, script evaluation, navigation, HTML, devtools, background colour | `with_initialization_script`, `evaluate_script`, `load_url`, `load_html`, `with_devtools`, `with_background_color` |
| Page messages from the top-level document only, Windows | `attach_ipc_handler` in `src/webview2/mod.rs` subscribes `add_WebMessageReceived` on the top-level `ICoreWebView2` only |
| Popups reported instead of opened | `with_new_window_req_handler` |
| Moving a webview to another window | `WebViewExtWindows::reparent` |

On Windows, through `WebViewExtWindows::controller()` and `webview()`:

| Behaviour | How |
|---|---|
| External drop control | `ICoreWebView2Controller4::SetAllowExternalDrop` on `controller()` |
| File drop paths, with WebView2's own drop target left in place | the C++ fork's method: an initialization script that posts the dropped `File` objects with `postMessageWithAdditionalObjects`, and a `WebMessageReceived` handler on `webview()` that reads each `ICoreWebView2File` path. `wry`'s `with_drag_drop_handler` is not used on Windows, because `DragDropController` in `src/webview2/drag_drop.rs` revokes WebView2's drop targets and rejects non-file drags |
| Bridge and drop scripts in the top-level document only | each script starts with `if (window !== window.top) return`, as the C++ fork's do. `wry` adds scripts to every frame on Windows |
| Requests from service workers, shared workers and cross-origin iframes | the request handler registers its filter with `AddWebResourceRequestedFilterWithRequestSourceKinds` and all source kinds when `ICoreWebView2_22` is present |
| Navigation-failed event | `add_NavigationCompleted` on `webview()`, with the failure rules `packages/sweetview/src/tabs/win-webview2.ts` has |
| Accelerator keys, focus, popup position | `add_AcceleratorKeyPressed`, `MoveFocus`, `NotifyParentWindowPositionChanged` on `controller()` |

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
| `WebViewBuilderExtMacos::with_webview_configuration`; `WebViewExtMacOS::webview`, `manager`, `ns_window`, `reparent`; `RequestAsyncResponder::respond`; `DragDropEvent` | `wry` 0.58.2 | yes, in the crate's source |
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
| the other `windows` functions named in this document: `GetAsyncKeyState`, `SystemParametersInfoW`, `SetLayeredWindowAttributes`, `CreateMutexW`, `FindWindowExW`, `SendMessageTimeoutW`, the registry and clipboard calls, the WinRT toast types | `windows` 0.62.2 | not page by page. Every Win32 function in this crate is `unsafe`, and the compiler checks each signature against Windows' own metadata |
| `objc2-core-foundation` `CFMessagePort` functions, used by single instance on macOS | not read | no. Checklist item M5.2 builds on them |
| `napi` `Function` called from inside a native loop; `.node` loading by `require`; embedding by `bun build --compile` | `napi` 3.16.3 on Bun 1.4.4 | built and run; see "Proofs run" |

What these references mean for the design:

- Almost every AppKit call this project makes on macOS is a safe method. The `unsafe` there is the one conversion of `tao`'s `ns_window()` pointer into an `NSWindow` reference, plus `setNextResponder`, `setApplicationIconImage`, `CGEvent::tap_create` and the classes defined with `define_class!`.
- `tao` has no window level or collection-behaviour call, so "above the Dock, on every Space" on macOS is written by this project against `NSWindow`, through the pointer from `ns_window()`.
- `tao` has `set_tabbing_identifier`, the AppKit window-tabbing mechanism that `darwin/tabs.ts` drives by hand.

## Architecture

| Layer | Content | Language |
|---|---|---|
| App | the developer's single `.ts` file | TypeScript |
| Sweetview API | the public API; it changes only where the design is better for it, each change with a row in `docs/upgrading.md` | TypeScript |
| Binding | `sweetview.<target>.node`, loaded with `require` | Rust |

The native package's eleven `Backend` types are the seam. The Rust library implements each one, and `platform.ts` returns it on a platform whose goal is done. The webview gets a seam of the same kind in `packages/sweetview/src/`: the Rust library behind it on Windows, and the bindings' `Webview` class behind it on macOS until the macOS goal replaces that too.

## The N-API surface

Internal to the package. Signatures are the generated TypeScript.

```ts
class Engine {
  static create(debug: boolean, window: bigint | null): Engine;          // fills the window; null makes a window of its own
  static createChild(debug: boolean, window: bigint, bounds: Rect): Engine; // a child of the window, at the given client rectangle
  setBounds(bounds: Rect): void;                                          // for a child
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
  // What the tabs library needs of a tab's webview (packages/sweetview/src/tabs/win-webview2.ts, darwin-webview.ts):
  setVisible(visible: boolean): void;
  moveFocus(): void;
  notifyMoved(): void;
  reparent(window: bigint): void;
  onAcceleratorKey(fn: ((key: KeyData) => boolean) | null): void;      // Windows; true marks the key handled
  onNewWindowRequested(fn: ((url: string) => void) | null): void;
  onNavigationFailed(fn: ((url: string, reason: string) => void) | null): void;
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
function setActivationPolicy(policy: ActivationPolicy): void;

class Window {                                    // implements WindowBackend of window.ts
  static create(options: WindowInit): Window;
  static adopt(handle: bigint): Window;          // Window.fromHandle: a window Sweetview did not create
  readonly handle: bigint;
  readonly detected: { frame: boolean; resizable: boolean } | null;
  isVisible(): boolean; show(): void; hide(): void;
  bounds(): Rect; setBounds(r: Rect): void; moveTo(x: number, y: number): void; resize(w: number, h: number): void; scale(): number;
  setTitle(title: string): void; setIcon(icon: IconBytes | null): void;
  minimize(): void; toggleMaximize(): void; isMaximized(): boolean; setTopmost(on: boolean): void;
  startDrag(): void; startResize(edge: ResizeEdge): void;
  setClickThrough(on: boolean): void;
  setHitRegions(packed: Int32Array | null, refine: ((x: number, y: number, seq: number) => void) | null): void;
  answerHit(seq: number, solid: boolean): void;
  onResize(fn: ((bounds: Rect) => void) | null): void;
  onMove(fn: ((bounds: Rect) => void) | null): void;
  onCloseRequest(fn: (() => void) | null): void;
  onFileDrop(fn: ((paths: string[]) => void) | null): void;
  dispose(): void;
}

function screens(): ScreenData[];
function screenAt(x: number, y: number): ScreenData;
function screenOf(handle: bigint): ScreenData;
function virtualScreen(): Rect;
function cursor(): Point;

class Tray {
  constructor(init: TrayInit);   // icon, tooltip, onClick, onDoubleClick, openMenu, menuChosen
  setTooltip(text: string): void; setIcon(icon: IconBytes): void; setHasMenu(has: boolean): void; dispose(): void;
}

class Notifier {
  constructor(init: NotifierInit);
  notify(n: NotificationInit): boolean; dispose(): void;
}

function pickFolder(owner: bigint | null, title: string): string | null;
function installAppMenu(appName: string, aboutText: string): void;
function setAppIcon(icon: IconBytes): void;
function popupMenu(owner: bigint | null, menu: MenuData, at: Point | null): number | null;   // the chosen item's id
function scheduleTimeout(ms: number, fn: () => void): number;
function cancelTimeout(id: number): void;

function clipboardReadText(): string | null;
function clipboardWriteText(text: string): void;
function clipboardClear(): void;

function registerUrlScheme(scheme: string, init: UrlSchemeInit): void;
function unregisterUrlScheme(scheme: string): void;
function onOpenUrl(fn: ((url: string) => void) | null): void;                 // macOS: the open-URL event
class SingleInstance {
  static acquire(appId: string, payloadJson: string, onSecond: (payloadJson: string) => void): SingleInstance;
  readonly isPrimary: boolean;
  readonly handedOff: boolean;
  dispose(): void;
}

// Tabs on Windows. The frame of a tabbed window is a Window created with `tabStripHeight`:
// its caption is removed and the top `tabStripHeight` DIPs are the strip. It adds:
interface TabFrame extends Window {
  stripRect(): Rect;                    // screen rectangle of the strip, for drops from another window
  pageRect(): Rect;                     // client rectangle below the strip, where the shown tab's webview goes
  isForeground(): boolean;
  onActivate(fn: ((active: boolean) => void) | null): void;
  startDragAt(held: Point): void;       // puts the held point under the cursor first, then hands the drag to the OS
  showSystemMenu(): void;               // Restore, Move, Size, Minimize, Maximize, Close
  setSystemDark(dark: boolean): void;
}
// The strip and each tab are Engines made with `Engine.createChild(debug, frame.handle, rect)`.
```

`discardQuit` has no counterpart. It exists because destroying a webview in the C++ library posts `WM_QUIT`, which one tab of several must take back; dropping a `wry` webview posts nothing.

The data types those signatures use:

```ts
type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
type ActivationPolicy = "regular" | "accessory" | "prohibited";

type RawRequest = { id: bigint; method: string; url: string; headersJson: string; body: Uint8Array | null };

// One icon, as Sweetview's `Icon` type carries it today.
type IconBytes = { ico?: Uint8Array; png?: Uint8Array; symbol?: string; template?: boolean };

type WindowInit = {
  title: string; bounds?: Rect; minWidth?: number; minHeight?: number;
  frame: boolean; resizable: boolean; appearance: "system" | "light" | "dark"; icon?: IconBytes;
  transparent: boolean; colorKey?: string; opacity?: number; topmost: boolean; hideFromTaskbar: boolean; noActivate: boolean;
  tabStripHeight?: number;                   // Windows: makes the window a tabbed window's frame
};
type ScreenData = { bounds: Rect; workArea: Rect; scale: number; primary: boolean };

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

type NotifierInit = {
  appId: string | null;                      // Windows toast identity; null uses "Sweetview.DesktopApp" as today
  appName: string | null;
  onClick: ((id: string, dataJson: string | null) => void) | null;
};
type NotificationInit = { id: string; title: string; body: string; silent: boolean; dataJson: string | null };

type UrlSchemeInit = { appName: string; iconPath: string; command: string };   // Windows registry values
type KeyData = { virtualKey: number; control: boolean; shift: boolean; alt: boolean };

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
| `run()` | `webview_run`, blocking | `run_return`, blocking, entered from `Engine.run()` and left when `Engine.terminate()` asks the loop to exit. `EventLoop::run` never returns to its caller and is not used |
| `runEventLoop` | a Bun `setInterval` calling `pumpEvents`: `PeekMessageW` and `DispatchMessageW`, or `nextEventMatchingMask:` and `sendEvent:` | the same Bun timer calling `pumpEvents`, which calls `run_return` and exits it when the queue is empty |

`tao` documents that `run_return` does not return while a window is being resized. Today's pump has the same property: `DispatchMessageW` does not return during the OS's modal size loop.

## Transport

`Ring`, `ringBytes` and their documented behaviour stay; the ring is pure TypeScript over a `SharedArrayBuffer`.

| Hop | Today | After |
|---|---|---|
| page to UI thread | `webview_bind` of `__sweetview_rpc` | `wry`'s IPC handler on Windows; Sweetview's own script message handler on macOS, which refuses frames other than the top-level document |
| UI thread to worker | `worker.postMessage` | the same |
| worker to UI thread | frame into the ring, then `webview_dispatch` with a `JSCallback` pointer | frame into the ring, then `wake(handle)`, which sends a `tao` user event; the UI thread runs the function given to `setDrain` |
| UI thread to page | `webview_return`, `webview_eval` | `wry` `evaluate_script` |

## Handles and constants

- `Window.handle` and `Webview.unsafeWindowHandle` stay the real OS handles, as `docs/native/windows.md` and the bindings' docs define them: the `HWND` on Windows, the `NSWindow` pointer on macOS, and `null` for a tabbed `Window` on macOS, which stands for a group of windows. `tao` returns them from `WindowExtWindows::hwnd()` and `WindowExtMacOS::ns_window()`.
- A webview is mounted into a window by handle. `wry`'s `build` and `build_as_child` take any `HasWindowHandle`, so `platform::adopt` wraps a raw `HWND` or `NSWindow` pointer in a type that implements it, for windows Sweetview did not create.
- `Webview.unsafeHandle` and the `handle` argument of the worker functions stay in the API as an opaque number that names the webview. The library checks it against its table of live webviews.
- `assetOrigin` keeps its values: `http://webview.localhost` on Windows, `webview://localhost` on macOS.
- `framesOrigin` keeps its values: `http://frames.webview.localhost` on Windows, `webview-frames://localhost` on macOS. This project's own request handler serves those origins, so they do not depend on how `wry` names a custom protocol.
- `WEBVIEW_PATH` names a custom build of the C library today. `SWEETVIEW_NATIVE_PATH` names a custom build of the binding, and `docs/upgrading.md` has the row.

## Packaging

- The native package, `@n1h/sweetview-native`, holds one `.node` binding per target: Windows x64 after the Windows goal, macOS arm64 and x64 after the macOS goal, Linux x64 after the Linux goal. The other five packages stay TypeScript and reach the binding through the native package.
- The binding is loaded with a literal `require` per platform, the form `bun build --compile` embeds. The same `require` runs inside a `Worker`.
- CI builds with `cargo` on one runner per OS. Consumers install no Rust.
- `@n1h/sweetview-webview-bun` is folded into Sweetview's packages. Every name it exports, the input hooks and permissions among them, is exported by a Sweetview package or has a row in `docs/upgrading.md`.

## Module map

| Today | After |
|---|---|
| `win32/api.ts`, `darwin/objc.ts`, `darwin/core-foundation.ts` | gone: the crates replace them |
| `win32/event-loop.ts`, `darwin/event-loop.ts`, `win32/init.ts`, `win32/message-window.ts` | `tao` event loop; `platform` for the hidden first window and native timeouts |
| `win32/window.ts`, `darwin/window.ts` | `tao` windows and events; Sweetview `hit` and `resize`; `platform` for click-through styles, `colorKey`, opacity, window level, adopted windows |
| `win32/screen.ts`, `darwin/screen.ts` | `tao` monitors; `platform` for the work area |
| `win32/tray.ts`, `darwin/tray.ts` | `tray-icon`, Sweetview `click` |
| `win32/menu.ts`, `darwin/menu.ts`, `darwin/app-menu.ts` | `muda`, Sweetview `menu` |
| `win32/notifier.ts`, `win32/winrt-toast.ts`, `darwin/notifier.ts` | `platform::notify` |
| `win32/icon.ts`, `darwin/image.ts`, `darwin/app-icon.ts` | the crates' `Icon` types; `platform` for SF Symbols and the Dock icon |
| `win32/folder-picker.ts`, `darwin/folder-picker.ts` | `rfd` |
| `win32/clipboard.ts`, `darwin/clipboard.ts` | `platform` |
| `win32/activation.ts`, `darwin/activation.ts` | `platform` |
| `win32/tab-window.ts`, `darwin/tabs.ts`, `packages/sweetview/src/tabs/win-webview2.ts`, `packages/sweetview/src/tabs/darwin-webview.ts` | `tao` windows, `wry` child webviews, `webview2-com` handlers, `platform` |
| the FFI in `packages/sweetview/src/app.ts`, `webview-lib.ts`, `worker.ts` | Sweetview `engine` on `wry`, `platform::webview` |
| the bindings' `src/` | Sweetview `engine`; `platform::input` for the hooks |
| C++ fork: backends, `engine_base.hh` | `wry`, and `platform::webview` for what `wry` lacks |
| C++ fork: `http_request.hh` | Sweetview `http`, safe Rust |
| C++ fork: `input_hooks.hh`, `mouse_hook.hh`, `keyboard_hook.hh`, `key_codes.hh` | `platform::input` |
| C++ fork: `streaming_istream.hh` | `platform::webview` |

Kept as TypeScript, untouched: `hit-regions.ts`, `icon.ts`, `menu.ts`, `fs.ts`, `win32/shortcuts.ts`, `win32/strip-shared.ts`, and in `packages/sweetview/src/`: `ring.ts`, `html.ts`, `page.ts`, `window-chrome.ts`, `request-response.ts`, `messages.ts`, `tabs/win-strip-assets.ts`, `tabs/load-failed.ts`; the IPC, WebSocket, settings and build packages.

## Tabs

The public API: `new Window({ tabs: true })`, `WebView.openTab`, `Tab`, `TabOptions`, `createApp({ tabs: true })`. `rust-rewrite/reference/v1-drafting-tabs-and-window.md` is the inventory of what the tabs library does today, behaviour by behaviour; the checklists accept tabs against it.

The tab state machines stay TypeScript: `packages/sweetview/src/tabs/win-tabs.ts` and `darwin-tabs.ts` keep the hosts, the tab records, selection, tear-off and merge. What moves to Rust is what they call: the frame window, the webviews, and the native events.

### Windows

| Behaviour today | Provided by |
|---|---|
| One frame window per tabbed window, caption removed in `WM_NCCALCSIZE`, system border, shadow, snap and maximise kept | `tao` window with `with_decorations(false)` and `with_undecorated_shadow(true)` |
| A 40 DIP strip webview across the top, drawing tabs, `+` and the caption buttons | a `wry` child webview from `build_as_child` with `with_bounds`; the strip's HTML, CSS and script (`win-strip-assets.ts`) and its 15 `strip.*` methods stay TypeScript |
| One WebView2 per tab in a child pane window; one shown at a time | one `wry` child webview per tab, a direct child of the frame, placed over the page area with `set_bounds` and shown or hidden with `set_visible`. The pane windows of `win32/tab-window.ts` exist to give the C library a parent to fill and have no counterpart |
| Tear-off and merge: a tab moves to another window without reloading, by `SetParent` on its pane | `WebViewExtWindows::reparent(hwnd)` on the tab's webview |
| Shortcuts while a page has focus: Ctrl+T, Ctrl+W, Ctrl+F4, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageUp, Ctrl+PageDown, Ctrl+1 to 9, Alt+F4 | `add_AcceleratorKeyPressed` on `controller()`, through the typed handler of `webview2-com`. The mapping in `shortcuts.ts` stays TypeScript |
| `target="_blank"` and `window.open` become a tab | `wry` `with_new_window_req_handler` |
| Keyboard returned to the page after a strip action | `MoveFocus` on `controller()` |
| Popups follow the window when it moves | `NotifyParentWindowPositionChanged` on `controller()` |
| "This site did not open" page on a failed load | `add_NavigationCompleted` on `wry`'s `webview()`, from Sweetview `platform`; the rules for which failures count stay as `win-webview2.ts` has them |
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
| Failed-load page | Sweetview `platform`: a navigation delegate that forwards to `wry`'s and adds the two failure methods |
| Every native call inside an autorelease pool | `objc2::rc::autoreleasepool` |
| Draining the main dispatch queue twice before a tab's webview is destroyed | not needed: it exists because the C++ engine queues replies holding a plain pointer to itself. `wry` guards each task with `check_task_is_valid` |

### Rule kept from today

Showing, hiding, moving and destroying a webview is deferred to its own turn of the loop. A webview is never destroyed inside its own callback.

## The `v1-drafting` features

`rust-rewrite/reference/v1-drafting-features.md` is the inventory of what each feature does today, call by call. Names, limits and wire formats stay exactly as they are, so an old build and a new build of the same app still find each other.

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

`docs/app.md` and the code disagree on one point. On Windows `tab.close()` on a window's last tab is offered to `onClose` listeners first, and the tab stays when one intercepts; `docs/app.md` says it always closes. The rewrite keeps what the code does, and the page is corrected.

## Linux

No Linux code exists in Sweetview today, and the C++ fork's additions do nothing there. Scope of the Linux goal: a `tao` window with a `wry` webview on WebKitGTK, assets and IPC, a tray menu and left click through `tray-icon`'s `ksni` feature, a notification through `notify-rust`. Overlays, hit regions, input hooks and tabs are not in scope on Linux.

## Order of work

The work is three goals, run one after another, each with its checklist under `rust-rewrite/`. The checklists are the order; this table says where each piece of this document lands. The `v1-drafting` features are part of the tree from the start, so they are built inside the group they belong to and not as a later step.

| Piece | Windows goal, `CHECKLIST-windows.md` | macOS goal, `CHECKLIST-macos.md` |
|---|---|---|
| Binding skeleton, the boundary, CI, the proofs | W0, W1 | M0 |
| The webview on `wry`: assets, background colour, bind, request handler, streaming, drops | W2 | M1 |
| Input hooks and permissions | W3 | M2 |
| Event loop, windows, overlays, hit regions, screens, file drops | W4 | M3 |
| Tray, menus, notifications, folder dialog, clipboard, app menu, app icon | W5 | M4 |
| URL schemes and single instance | W6 | M5 |
| Native tabs | W7 | M6 |
| Packaging and `bun build --compile` | W8 | M7 |
| Tauri 2 and Electron IPC transports: page code identical across webview, WebSocket, Tauri 2 and Electron | WT, done once | |
| Removal of the old code, documents, the upgrade guide | W9 | M8 |
| Safety review and handoff | W10 | M9 |

Linux is the third goal, `CHECKLIST-linux.md`, scoped as the Linux section above states.

## Risks and actions

| Risk | Action |
|---|---|
| The two loop mechanisms are proven on Windows and not on macOS | Group M0 of the macOS checklist runs the same proof on a Mac before any macOS module is built. If the timer pump fails there, the pump function dequeues events itself with `NSApplication::nextEventMatchingMask_untilDate_inMode_dequeue` and `sendEvent`, the calls today's `pumpEvents` makes; both are safe methods in `objc2-app-kit`. |
| The tray proof used posted messages, not a person's click | Items W5.5 and M4.5 are `demos/menubar-only` and `demos/menubar-notify` clicked by hand. |
| A rebuilt module behaves differently from today. Every path an overlay application depends on is re-implemented under this proposal, so each one can differ | Each is accepted against its existing tests and demo, and the dependents run of R2 upgrades a copy of each real application and runs its own checks. The published packages and tag `pre-rust-rewrite` stay as they are. |
| The worker cannot load the binding a second time, or cannot wake the UI thread through it | Item W1.7 proves it before any webview work. If the binding cannot load in a `Worker`, the worker wakes the UI thread without it: it posts one window message to the binding's message window with `PostMessageW` through `bun:ffi`, which is one `setup:` file under requirement R3. The change is recorded in `rust-rewrite/DECISIONS.md`. |
| `tao` queues window events while its handler is already running, so a handler that opens a modal loop sees no resize, move or close until it returns | Item W1.8 tests it. Page calls and worker replies arrive through WebView2's own callbacks and the wake message, not through `tao`'s event handler, so they are served inside the modal loop; window events that arrive late are delivered when the handler returns, as the OS queue would deliver them. |
| A later `wry` release changes one of the native objects this project builds on | `wry` is pinned in `Cargo.lock`. Each of the five behaviours has its own test, so an upgrade that breaks one fails that test. |
| `unsafe` spreads | `#![forbid(unsafe_code)]` at the root of every crate that is not a platform crate. `rust-rewrite/verify.ts` fails on `unsafe` outside a platform crate and on a block with no `SAFETY:` comment, and rewrites `rust-rewrite/UNSAFE-LEDGER.md` with the count per file. A reviewer that did not write the code reads every block before a goal completes. |
| `tao`'s undecorated window does not keep everything the tab frame has today: the system border, shadow, snap and maximise with the caption removed | Item W7.2 runs `demos/native-tabs/scripts/win-drive.ts` against it. If one of those is lost, the frame is a window this project creates in `platform`, with the `WM_NCCALCSIZE` handling `win32/tab-window.ts` has, and `tao` adopts nothing of it. |

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
- This repository on `v1-rust-rewrite`, in full: `README.md`; in `packages/sweetview/src/`: `index.ts`, `app.ts`, `worker.ts`, `webview-lib.ts`, `page.ts`; in `packages/sweetview-native/src/`: `index.ts`, `platform.ts`, `internal.ts`, `event-loop.ts`, `window.ts`, `win32/window.ts`, `win32/event-loop.ts`, `win32/init.ts`, `win32/message-window.ts`, `win32/notifier.ts`, `win32/tray.ts`; in `packages/sweetview-ipc/src/`: `frame.ts`, `bridge.ts`, `service.ts`.
- The rest of the native package and the tabs library, through the three inventories in `rust-rewrite/reference/`. Each was written from a full reading of the files it names on `v1-drafting`. The `darwin/` folder, the tabs library and `win32/winrt-toast.ts` are read again in full by the goal that replaces them, before it designs their replacement.
- docs.rs pages of `tao` 0.38.0 (`Window`, `WindowBuilder`, `WindowBuilderExtWindows`, `EventLoopExtRunReturn`), `wry` 0.58.2 (`WebViewBuilder`), `muda` 0.22.0 and `tray-icon` 0.27.0 (crate pages).
- The source of `wry` 0.58.2 (`src/lib.rs`, `src/webview2/mod.rs`, `src/wkwebview/mod.rs`, `src/wkwebview/drag_drop.rs`, `src/wkwebview/class/url_scheme_handler.rs`) and of `tao` 0.38.0 (`src/event_loop.rs`, `src/platform/run_return.rs`, `src/platform/windows.rs`, `src/platform/macos.rs`, `src/window.rs`), for the items "API references" marks as read in source.

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
