# Sweetview restart proposal

Status: proposal. The three decisions it rests on are made and listed under Decisions.

Basis, read on 2026-11-27:

- `n0t-invented-here/sweetview-webview-bun`, branch `v1-drafting`: every file in `src/`, the README, every page in `docs/`, `scripts/build.ts`, the justfile.
- `n0t-invented-here/sweetview-webview`, branch `v1-drafting`: every page in `sweetview/`, and the full diff against upstream `f1a9d6b` of `engine_base.hh`, `win32_edge.hh` and `cocoa_webkit.hh`, plus `input_hooks.hh`.
- This repository on `main`: `README.md`, `docs/app.md`, `docs/native.md`, `docs/webview-library.md`, `webview/README.md`, `src/app.ts`, `src/worker.ts`, `src/webview-lib.ts`, `demos/desktop-pet/`.
- Line and file counts come from git.

## The change in one paragraph

Sweetview's native code moves out of TypeScript and into one Rust library, called from Bun through N-API. The behaviour, the features, the public TypeScript API, the tests and the webview library stay. What goes is TypeScript holding raw pointers and calling the OS through `bun:ffi`.

## What exists today

| Part | Where | State |
|---|---|---|
| C++ webview library | `n0t-invented-here/sweetview-webview`, a fork of `webview/webview` at `f1a9d6b` | works. Branch `sweetview` adds 2,705 lines; branch `v1-drafting` adds 8,646 lines in 32 files, 1,687 of them tests |
| Bun bindings for it | `n0t-invented-here/sweetview-webview-bun`, a fork of `tr1ckydev/webview-bun`, published as `@n1h/sweetview-webview-bun` | works. 2,014 lines of TypeScript in `src/`, all `bun:ffi`. Ships the built library in `build/`: `libwebview.dll`, a universal `libwebview.dylib`, and an older `libwebview-x64.so`. 2.7.0 is published; 2.8.0 is the `v1-drafting` branch, unpublished |
| Native layer on `main` | `src/native/win32/` and `src/native/darwin/` | 2,779 lines of TypeScript FFI in 24 files |
| Native tabs on `main` | `demos/native-tabs/` | 2,004 lines of TypeScript FFI in 7 files |
| Native layer on `v1-drafting` | `packages/sweetview-native/src/win32/` and `darwin/` | 6,916 lines of TypeScript FFI in 35 files, plus 2,669 lines in 8 files in the other packages |
| Pure TypeScript | IPC contract and bridge, WebSocket transport, settings store, hit-region geometry, icon encoders, `.app` builder | works; no FFI |
| Tests | 17 test files on `main`, 30 on `v1-drafting` | the acceptance suite for the port |

### What the C++ fork adds to upstream

| Addition | C API | In 2.7.0 | Windows | macOS | Linux |
|---|---|---|---|---|---|
| Background colour and transparency | `webview_set_background_color` | yes | WebView2 default background colour; alpha 0 or 255 only | any alpha, painted on the view's layer | no effect |
| Assets at the page's own origin | `webview_set_asset` | yes | `http://webview.localhost`, WebView2 resource interception | `webview://localhost`, a URL scheme handler | stored, not served |
| System-wide mouse hook | `webview_mouse_hook_install`, `_remove` | yes | `WH_MOUSE_LL` | a session event tap | fails |
| System-wide keyboard hook | `webview_keyboard_hook_install`, `_remove` | yes | `WH_KEYBOARD_LL` | the same event tap | fails |
| Permission model for the hooks | `webview_feature_permissions`, `webview_permission_status`, `_request`, `_set_auto_request` | yes | nothing to ask | Device Control and Data Access | nothing to ask |
| Request handler and a second, cross-origin frames origin | `webview_set_request_handler`, `webview_complete_request` | no | deferred resource requests | the same scheme handler, two schemes | no effect |
| Streamed responses | `webview_begin_response`, `webview_write_response_chunk`, `webview_end_response` | no | the page receives the body only when the stream ends, a WebView2 limit | the page receives each chunk as written | no effect |
| External drop control | `webview_set_allow_external_drop` | no | WebView2 controller setting | enforced in a `WKWebView` subclass | no effect |
| File drop paths | `webview_set_file_drop_handler` | no | a drop script plus WebView2 file objects | read from the drag pasteboard | no effect |

The `v1-drafting` branch also hardens teardown: a registry of live webviews, alive tokens on queued work, COM references held by an owning wrapper, and an owned dispatch queue.

### How Sweetview uses the library on `main`

- `createWebviewApp` creates a `Webview`, in its own window or inside a window from `createOverlayWindow`.
- Page to UI thread: the bound function `__sweetview_rpc`, through `webview_bind`.
- UI thread to worker: `worker.postMessage`.
- Worker to UI thread: JSON frames in a shared-memory ring; the worker wakes the UI thread with `webview_dispatch`, and a `JSCallback` drains the ring inside the OS loop.
- UI thread to page: `webview_return` for replies, `webview_eval` for events.
- The page loads from `webview_set_asset`, never from `webview_set_html`.
- Two ways to run the loop: `run()`, the library's blocking loop, with app logic in a worker; or `runEventLoop`, pumped from a Bun timer, with no worker.
- Sweetview refuses to start on Linux.
- No branch of this repository calls the mouse hook, the keyboard hook or the permission model.

### What Sweetview's native layer on `main` already does

| Journey | Present on `main` |
|---|---|
| Tray or menu-bar app | `createTray`: icon, tooltip, `onClick`, `onDoubleClick`, menus with `checked`, `icon`, submenus and separators. A menu given as a function is rebuilt every time it opens. On macOS a tray with a menu opens the menu on any click and its click handlers do not fire |
| Tray-only app, single file, no worker | `demos/menubar-only/app.ts`, 42 lines, on `runEventLoop` |
| Notifications | `createNotifier` with click events. Windows: the tray icon's balloon, so the tray must exist first. macOS: the user notification centre, from a signed `.app` |
| Webview app with IPC and no TCP | `createWebviewApp`, described above |
| N windows | one `createOverlayWindow({ frame: true })` and one `createWebviewApp` per window, all in one loop |
| Tabs | `demos/native-tabs/` only; `v1-drafting` moves them into the library |
| Transparent click-through | `createOverlayWindow({ transparent: true })` with `setHitRegions`: a 10 ms cursor poll toggles the window's pass-through state against polygons the page sends, and the page answers exact hits through `createHitRelay`. `demos/desktop-pet/` runs on it |

## What is kept

- The C++ webview library, as it is. It is linked into the Rust library and called through its existing C API.
- Every native behaviour the port source has: windows, transparent overlays and hit regions for the games, tray, notifications, menus, folder picker, icons, both ways of running the event loop, native tabs.
- The public TypeScript API. App code, demos and docs keep working.
- All pure TypeScript modules, unchanged.
- The tests. Each ported module passes the tests its TypeScript version passes.

## What is replaced

Each TypeScript FFI file becomes a Rust module making the same OS calls.

| Today | After |
|---|---|
| `bun:ffi` `dlopen` of `user32`, `shell32`, `dwmapi` and others, with hand-written signatures | the `windows` crate, whose signatures are generated from Microsoft's own metadata |
| Hand-rolled `objc_msgSend` calls in `darwin/objc.ts` | the `objc2` crates, with typed AppKit bindings and automatic retain and release |
| `JSCallback` function pointers handed to the OS | Rust callbacks owned by the library, delivered to JavaScript through N-API |
| Pointers and buffers held in JavaScript | none; JavaScript receives objects and plain values |
| The 2,014 lines of `bun:ffi` in `@n1h/sweetview-webview-bun`, including its machinery for closing callbacks only after native code has left them | the Rust library calls the C API directly and owns every callback |
| The shared-memory ring, the `webview_dispatch` wake-up and the drain `JSCallback` | a queue inside the Rust library, drained on the UI thread |
| A separate `libwebview.dll` or `libwebview.dylib` loaded at run time | the same C++ code linked into the one native binary |

## What the port fixes

| Class of defect | Example in this repository | After the port |
|---|---|---|
| Wrong return type or argument count on a native call | commit `83d7411`: `isZoomed` read with the wrong return type, `orderFrontRegardless` called with the wrong arity | does not compile |
| Object lifetime errors: use after release, leaks of COM or Objective-C objects | commit `db5fd1b`: COM cleanup on tab teardown | released by the type system when the owner is dropped |
| A callback freed while the OS still holds its pointer | every `JSCallback` site, 65 on `v1-drafting` | the library owns the callback for the life of the registration |
| A buffer moved or collected while native code reads it | `encodeCString` in the bindings' `src/ffi.ts` exists because a bare pointer to a temporary array can be collected before the call; 63 raw pointer sites on `v1-drafting` | buffers are Rust-owned for the duration of the call |

Each OS call in Rust still sits in an `unsafe` block, because the OS API is unsafe. The count of those blocks is visible to the compiler and to review, and they are confined to the platform modules. Every other module carries `#![forbid(unsafe_code)]`.

## Shape after the port

| Layer | Content | Language |
|---|---|---|
| App | the developer's single `.ts` file | TypeScript |
| Sweetview API | `Window`, `Tray`, `Notifier`, `Menu`, `createApp`, IPC, build helpers | TypeScript, as today |
| Native library | one prebuilt binary per target, loaded through N-API | Rust, plus the existing C++ webview library linked in |

App developers write TypeScript only. `bun add` installs the package with its prebuilt binaries. `bun build --compile` embeds the binary, which is loaded with a literal `require` of a fixed path.

## The five journeys

| Journey | Source of the implementation | Windows | macOS | Linux (minimal) |
|---|---|---|---|---|
| Tray or menu-bar app with icon clicks and menus | port of the existing tray and menu modules, which already have checkmarks, item icons and menus rebuilt on every open | yes | yes; with a menu set, the menu opens on any click | new code |
| Webview app with IPC and no TCP | the existing webview library and IPC layer | yes | yes | new code: the library's upstream GTK backend runs, and each fork addition is implemented for it |
| Native notifications | port of the existing notifier modules | yes | yes, from a signed `.app` | new code |
| N windows and tabs | port of the existing window modules and the native-tabs demo | yes | yes | windows yes; tabs not planned |
| Transparent games with hit-region click-through | port of the existing overlay and hit-region modules. The library's mouse and keyboard hooks are exposed for games that want to swallow right clicks, middle clicks, the wheel or keys over what they draw | yes | yes | not planned |

## IPC and bail-out

The service definition, bridge and ready handshake stay as they are. Two transports are added beside the webview and WebSocket ones: Tauri 2 (`invoke` and events) and Electron (preload bridge). Page code is identical across all four. An app that moves to Tauri 2 keeps its page; its service runs as a Bun sidecar or is ported to Rust commands.

## Distribution

- One npm package holding the TypeScript and one prebuilt binary per target: Windows x64, macOS arm64, Linux x64.
- CI builds the binaries on one runner per OS. Consumers never install Rust or a C++ toolchain.
- The separate `@n1h/sweetview-webview-bun` package is retired; its C++ source is built into the one binary.

## Order of work

1. Rust library skeleton: N-API entry point, the C++ webview library linked in, CI producing the prebuilt binaries. Acceptance: the existing `web-app` demo opens its window through the new binary.
2. Port the event loop and window modules. Acceptance: their existing tests pass.
3. Port tray, menus and notifications. Acceptance: the `menubar-only` and `menubar-notify` demos run unchanged.
4. Port overlays and hit regions. Acceptance: the `desktop-pet` demo and one game run unchanged.
5. Port native tabs. Acceptance: the `native-tabs` demo runs unchanged.
6. Delete the TypeScript FFI files and the run-time loading of the webview library.
7. Tauri 2 and Electron transports.
8. Linux minimal pass.

The port goes one module at a time. After each step the tree works, with ported modules in Rust and the rest still in TypeScript.

## Risks and actions

| Risk | Action |
|---|---|
| A ported module behaves differently from its TypeScript original | Each module is ported against its existing tests and demo before the TypeScript version is deleted. Both versions exist side by side until the tests pass on the Rust one. |
| The C++ webview library stays C++: upstream plus 8,646 lines of this project's additions | CI builds it with AddressSanitizer and runs the fork's own unit and functional tests under it on macOS and Linux. |
| A JavaScript callback must run on the UI thread while that thread is inside the blocking loop, which `bun:ffi` does today with `JSCallback` | Step 1 proves the N-API equivalent with the `web-app` demo before any module is ported: a page call answered by a `uiMethods` function while `run()` blocks. |
| `unsafe` blocks spread through the Rust code | `#![forbid(unsafe_code)]` on every module outside the two platform folders. CI fails when the count of `unsafe` blocks rises without a matching entry in a tracked list. |
| The OS event loop and Bun's loop interact differently through N-API than through `bun:ffi` | Step 1 ends with the `web-app` demo running, which exercises the blocking loop with a worker. Step 3 ends with `menubar-only` running, which exercises the timer-pumped loop with no window. |
| macOS shows no notifications from an unsigned bundle | Unchanged from today: the `.app` builder signs the bundle. |
| Linux has no existing native code to port | Linux is last, scoped to a window with a webview, a tray menu and a notification. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Replace the native layer with Tauri's `tao` and `wry` libraries | loses working features: the request handler with its frames origin, streamed responses on macOS (`wry` accepts whole bodies only), the system-wide mouse and keyboard hooks with their permission model, file drop paths, hit regions, the Windows tab strip. All of it would be written again |
| `webviewjs/webview` | an N-API binding over `tao` and `wry`. Its tray does not deliver events without a window (issue #96, open). It has no menu checkmarks or icons, no hit regions, no Linux tray clicks. One maintainer |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket, broken transparent click-through; excluded by the project owner |
| bunmaska | alpha; its native layer is `bun:ffi` written in TypeScript |
| `Bun.WebView` | headless browser automation; opens no window |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |
| Keep the TypeScript FFI | the defect classes in "What the port fixes" stay possible in every native call |

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Language of the webview library | It stays C++ | It works, the fork carries 1,687 lines of its own tests, and upstream maintains the WebView2 and WKWebView hosting. Rewriting it means rewriting upstream's hosting and 8,646 lines of additions |
| Sweetview branch the port starts from | `main` | It is the published line, 2,779 lines of native code plus the native-tabs demo, and every journey already runs on it. `v1-drafting` features (URL schemes, single instance, clipboard, WinRT toasts, screen info, request handler, file drop) cross over one at a time afterwards, each reviewed as it is ported |
| Webview library branch the port links | `sweetview`, the published 2.7.0 | It is what `main` runs on today. The 2.8.0 additions on the library's `v1-drafting` branch come across together with the Sweetview features that use them |

## Sources

- https://github.com/microsoft/windows-rs
- https://github.com/madsmtm/objc2
- https://github.com/napi-rs/napi-rs
- https://github.com/webview/webview
- https://bun.com/docs/compiler/executables
- https://github.com/tauri-apps/wry
- https://github.com/webviewjs/webview
- https://github.com/webviewjs/webview/issues/96
- https://github.com/webviewjs/webview/issues/89
- https://github.com/blackboardsh/electrobun
- https://github.com/ipfizz/bunmaska
- https://bun.com/blog/bun-v1.4
