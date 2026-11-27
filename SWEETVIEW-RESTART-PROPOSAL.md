# Sweetview restart proposal

Status: proposal. The decisions it rests on are listed under Decisions.

Basis, read on 2026-11-27:

- `n0t-invented-here/sweetview-webview-bun`, branch `v1-drafting`: every file in `src/`, the README, every page in `docs/`, `scripts/build.ts`, the justfile.
- `n0t-invented-here/sweetview-webview`, branch `v1-drafting`: every page in `sweetview/`, and the full diff against upstream `f1a9d6b` of `engine_base.hh`, `win32_edge.hh` and `cocoa_webkit.hh`, plus `input_hooks.hh`.
- This repository on `main`: `README.md`, `docs/app.md`, `docs/native.md`, `docs/webview-library.md`, `webview/README.md`, `src/app.ts`, `src/worker.ts`, `src/webview-lib.ts`, `demos/desktop-pet/`.
- docs.rs API pages of `tao` 0.38.0, `wry` 0.58.2, `muda` 0.22.0 and `tray-icon` 0.27.0.
- Line and file counts come from git.

## The change in one paragraph

Sweetview's native code is rebuilt in safe Rust on libraries that already wrap the OS behind safe APIs, and is called from Bun through N-API. Sweetview's own Rust crate carries `#![forbid(unsafe_code)]`. The public TypeScript API, the behaviour `main` has today, the pure TypeScript modules, the demos and the tests are kept. The TypeScript `bun:ffi` code, the bindings package and the C++ fork are retired.

## What memory safety means here

Win32, COM and AppKit are unsafe interfaces in every route. What differs is who writes the code that calls them.

| Route | Unsafe code this project writes and owns | Memory safe |
|---|---|---|
| Today: TypeScript `bun:ffi`, the bindings package, the C++ fork | all of it: 2,779 lines of TypeScript FFI on `main`, 2,014 in the bindings, and the C++ fork's 2,705 lines on its published branch | no |
| Port each OS call to Rust with the `windows` and `objc2` crates and keep the C++ library | every OS call is an `unsafe` block, and the C++ stays. It gains typed signatures and ownership of buffers and callbacks | no |
| Safe Rust on `tao`, `wry`, `muda` and `tray-icon` | none. The unsafe code is inside those four libraries, which Tauri 2 ships on | this project's code: yes |

This proposal is the third route.

## What exists today

| Part | Where | State |
|---|---|---|
| C++ webview library | `n0t-invented-here/sweetview-webview`, a fork of `webview/webview` at `f1a9d6b` | works. Branch `sweetview` adds 2,705 lines; branch `v1-drafting` adds 8,646 lines in 32 files, 1,687 of them tests |
| Bun bindings for it | `n0t-invented-here/sweetview-webview-bun`, a fork of `tr1ckydev/webview-bun`, published as `@n1h/sweetview-webview-bun` | works. 2,014 lines of TypeScript in `src/`, all `bun:ffi`. 2.7.0 is published; 2.8.0 is the `v1-drafting` branch, unpublished |
| Native layer on `main` | `src/native/win32/` and `src/native/darwin/` | 2,779 lines of TypeScript FFI in 24 files |
| Native tabs on `main` | `demos/native-tabs/` | 2,004 lines of TypeScript FFI in 7 files |
| Native layer on `v1-drafting` | `packages/sweetview-native/src/win32/` and `darwin/` | 6,916 lines of TypeScript FFI in 35 files, plus 2,669 lines in 8 files in the other packages |
| Pure TypeScript | IPC contract and bridge, WebSocket transport, settings store, hit-region geometry, icon encoders, `.app` builder | works; no FFI |
| Tests | 17 test files on `main`, 30 on `v1-drafting` | the acceptance suite |

### What the C++ fork adds to upstream

| Addition | In 2.7.0 | Used by Sweetview `main` |
|---|---|---|
| Background colour and transparency (`webview_set_background_color`) | yes | yes |
| Assets at the page's own origin (`webview_set_asset`) | yes | yes |
| System-wide mouse and keyboard hooks, with a macOS permission model | yes | no; no branch calls them |
| Request handler and a cross-origin frames origin | no | no |
| Streamed responses. On Windows the page receives the body only when the stream ends, a WebView2 limit | no | no |
| External drop control and file drop paths | no | no |

### How Sweetview uses the library on `main`

- `createWebviewApp` creates a `Webview`, in its own window or inside a window from `createOverlayWindow`.
- Page to UI thread: the bound function `__sweetview_rpc`, through `webview_bind`.
- UI thread to worker: `worker.postMessage`.
- Worker to UI thread: JSON frames in a shared-memory ring; the worker wakes the UI thread with `webview_dispatch`, and a `JSCallback` drains the ring inside the OS loop.
- UI thread to page: `webview_return` for replies, `webview_eval` for events.
- The page loads from `webview_set_asset`.
- Two ways to run the loop: `run()`, the library's blocking loop, with app logic in a worker; or `runEventLoop`, pumped from a Bun timer, with no worker.

### What Sweetview's native layer on `main` already does

| Journey | Present on `main` |
|---|---|
| Tray or menu-bar app | `createTray`: icon, tooltip, `onClick`, `onDoubleClick`, menus with `checked`, `icon`, submenus and separators. A menu given as a function is rebuilt every time it opens |
| Tray-only app, single file, no worker | `demos/menubar-only/app.ts`, 42 lines, on `runEventLoop` |
| Notifications | `createNotifier` with click events. Windows: the tray icon's balloon. macOS: the user notification centre, from a signed `.app` |
| Webview app with IPC and no TCP | `createWebviewApp` |
| N windows | one `createOverlayWindow({ frame: true })` and one `createWebviewApp` per window, in one loop |
| Tabs | `demos/native-tabs/` only |
| Transparent click-through | `setHitRegions`: a 10 ms cursor poll toggles the window's pass-through state against polygons the page sends, and the page answers exact hits through `createHitRelay`. `demos/desktop-pet/` runs on it |

## Coverage by safe library APIs

Every call in this table is declared safe on its docs.rs page.

| Behaviour on `main` | Safe call | Library |
|---|---|---|
| Create a window hidden, frameless, transparent, topmost, not focusable, off the taskbar | `WindowBuilder::with_visible`, `with_decorations`, `with_transparent`, `with_always_on_top`, `with_focusable`, `with_skip_taskbar` | `tao` 0.38.0 |
| Transparent window without intermittent opacity on Windows | `with_no_redirection_bitmap` | `tao` |
| Show, hide, move, resize, raise | `set_visible`, `set_outer_position`, `set_inner_size`, `set_always_on_top` | `tao` |
| Click-through on and off | `set_ignore_cursor_events` | `tao` |
| Cursor position for the hit-region poll | `cursor_position` | `tao` |
| Screen, screen at a point, work area, scale | `primary_monitor`, `available_monitors`, `monitor_from_point`, `scale_factor` | `tao` |
| Page-drawn title bar and resize handles | `drag_window`, `drag_resize_window`. The second is unsupported on macOS, where `startResize` on `main` already does nothing | `tao` |
| Minimise, maximise, window icon, light or dark frame | `set_minimized`, `set_maximized`, `is_maximized`, `set_window_icon`, `set_theme` | `tao` |
| A webview filling a window, or a child webview with bounds | `WebViewBuilder::build`, `build_as_child`, `with_bounds` | `wry` 0.58.2 |
| Assets at the page's own origin; a request handler on further schemes | `with_custom_protocol`, `with_asynchronous_custom_protocol` | `wry` |
| Page-to-host calls with no TCP | `with_ipc_handler` | `wry` |
| Transparent page background | `with_transparent`, `with_background_color` | `wry` |
| Bridge script in the top-level document only | `with_initialization_script_for_main_only` | `wry` |
| File drop paths | `with_drag_drop_handler` | `wry` |
| Tray icon, tooltip, menu, click events | `TrayIconBuilder::with_icon`, `with_tooltip`, `with_menu`; `TrayIconEvent::set_event_handler` | `tray-icon` 0.27.0 |
| Linux tray with clicks | the `ksni` feature, which needs no GTK loop | `tray-icon` |
| Menus with check marks, icons and submenus; click events | `CheckMenuItem`, `IconMenuItem`, `Submenu`; `MenuEvent::set_event_handler` | `muda` 0.22.0 |

## Not covered by a safe API

| Behaviour | Fact | Action |
|---|---|---|
| Streamed response bodies | `wry`'s protocol responder takes a whole body | Not provided. `main` does not use them; they exist only in the unpublished 2.8.0 library |
| System-wide mouse and keyboard hooks, permission model | none of the four libraries has them | Not provided. No Sweetview branch calls them |
| A popup menu shown at a point | `muda`'s `show_context_menu_for_hwnd` and `show_context_menu_for_nsview` are `unsafe` calls | Not provided. `main` has no such call; it is a `v1-drafting` addition |
| "Do not flip click-through while a mouse button is down" | `tao` has no call for global button state | The page reports pointer-down and pointer-up over IPC and the poll holds its state between them. A drag begun in another app is no longer exempt |
| The loop pumped from a Bun timer (`runEventLoop`) | `tao` documents `run_return` as discouraged; it does not return while a window is being resized | Step 1 runs the tray-only demo and a resizing window on `run_return` called from a Bun timer, on Windows and macOS. Where it stalls or drops events, that app runs on the blocking loop with its timers in a worker, as windowed apps on `main` do |
| Windows notifications | not checked against a library in this reading | Step 3 uses `notify-rust`; its API is read before that step starts |

## Kept and retired

| Kept | Retired |
|---|---|
| the public TypeScript API of `main` | `src/native/win32/` and `src/native/darwin/`: 2,779 lines of `bun:ffi` |
| IPC contract and bridge, WebSocket transport, settings store | `@n1h/sweetview-webview-bun`: 2,014 lines of `bun:ffi` |
| hit-region geometry and the hit relay, icon encoders, `.app` builder | the C++ fork `n0t-invented-here/sweetview-webview` |
| the demos and the tests, as acceptance checks | the shared-memory ring, the `webview_dispatch` wake-up and the drain `JSCallback` |
| the docs as the API reference | |

## Shape

| Layer | Content | Language |
|---|---|---|
| App | the developer's single `.ts` file | TypeScript |
| Sweetview API | `createWebviewApp`, `createOverlayWindow`, `createTray`, `createNotifier`, menus, IPC, build helpers | TypeScript, as today |
| Native library | one prebuilt binary per target, loaded through N-API | safe Rust, `#![forbid(unsafe_code)]` |

- `bun add` installs one package holding the TypeScript and one prebuilt binary per target: Windows x64, macOS arm64, Linux x64.
- CI builds the binaries on one runner per OS. Consumers install no Rust and no C++ toolchain.
- The binary is loaded with a literal `require` of a fixed path, the form `bun build --compile` embeds.

## IPC and bail-out

The service definition and bridge stay as they are. Two transports are added beside the webview and WebSocket ones: Tauri 2 (`invoke` and events) and Electron (preload bridge). Page code is identical across all four. The native layer is the same libraries Tauri 2 runs on.

## Order of work

1. Crate skeleton with CI producing the prebuilt binaries. Acceptance: `demos/menubar-only` runs unchanged, and the timer-pumped loop is measured as described above.
2. Windows and overlays, hit regions. Acceptance: the overlay tests pass and `demos/desktop-pet` runs unchanged.
3. Tray, menus, notifications. Acceptance: `demos/menubar-notify` runs unchanged.
4. Webview and IPC. Acceptance: `demos/web-app` runs unchanged.
5. Tabs. Acceptance: `demos/native-tabs` runs unchanged.
6. Delete the TypeScript FFI, drop the bindings dependency.
7. Tauri 2 and Electron transports.
8. Linux minimal pass.

## Risks and actions

| Risk | Action |
|---|---|
| A rebuilt module behaves differently from its TypeScript original | Each module is accepted against its existing tests and demo before the TypeScript version is deleted. |
| A JavaScript callback must run on the UI thread while that thread is inside the blocking loop, which `bun:ffi` does today with `JSCallback` | Step 1 proves the N-API equivalent with the tray demo before any other module is built. |
| A needed behaviour has no safe API | It goes in the "Not covered" table above with its action. Nothing is added to the crate with `unsafe`. |
| The four libraries change or break | Each is pinned to an exact version in `Cargo.lock`; upgrades run the full demo acceptance set. |
| macOS shows no notifications from an unsigned bundle | Unchanged from today: the `.app` builder signs the bundle. |
| Linux has no existing behaviour to match | Linux is last, scoped to a window with a webview, a tray menu and a notification. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Port each OS call to Rust and keep the C++ library | Every OS call stays an `unsafe` block and the C++ stays. It is not memory safe |
| Keep the TypeScript FFI | No checks at all on any native call |
| `webviewjs/webview` | Its tray does not deliver events without a window (issue #96, open). One maintainer. No checkmarks or icons in menus |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket; excluded by the project owner |
| bunmaska | alpha; its native layer is `bun:ffi` written in TypeScript |
| `Bun.WebView` | headless browser automation; opens no window |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Who owns the unsafe code | the `tao`, `wry`, `muda` and `tray-icon` libraries | It is the only route in which this project's code is memory safe |
| The C++ webview library | retired | `wry` covers everything `main` uses from it, through safe calls |
| Behaviour the rebuild matches | Sweetview `main` | It is the published line and every journey runs on it. `v1-drafting` features are added afterwards, one at a time, where a safe API exists |

## Sources

- https://docs.rs/tao/latest/tao/window/struct.Window.html
- https://docs.rs/tao/latest/tao/window/struct.WindowBuilder.html
- https://docs.rs/tao/latest/x86_64-pc-windows-msvc/tao/platform/windows/trait.WindowBuilderExtWindows.html
- https://docs.rs/tao/latest/tao/platform/run_return/trait.EventLoopExtRunReturn.html
- https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html
- https://docs.rs/muda/latest/muda/
- https://docs.rs/tray-icon/latest/tray_icon/
- https://github.com/napi-rs/napi-rs
- https://bun.com/docs/compiler/executables
- https://github.com/webview/webview
- https://github.com/webviewjs/webview/issues/96
- https://github.com/blackboardsh/electrobun
- https://github.com/ipfizz/bunmaska
- https://bun.com/blog/bun-v1.4
