# Sweetview restart proposal

Status: proposal.

Rule this proposal follows: no functionality is removed. Everything Sweetview, the bindings and the C++ webview fork do today, they do afterwards.

Basis, read on 2026-11-27:

- `n0t-invented-here/sweetview-webview-bun`, branch `v1-drafting`: every file in `src/`, the README, every page in `docs/`, `scripts/build.ts`, the justfile.
- `n0t-invented-here/sweetview-webview`, branch `v1-drafting`: every page in `sweetview/`, and the full diff against upstream `f1a9d6b` of `engine_base.hh`, `win32_edge.hh` and `cocoa_webkit.hh`, plus `input_hooks.hh`.
- This repository on `main`: `README.md`, `docs/app.md`, `docs/native.md`, `docs/webview-library.md`, `webview/README.md`, `src/app.ts`, `src/worker.ts`, `src/webview-lib.ts`, `demos/desktop-pet/`.
- docs.rs API pages of `tao` 0.38.0, `wry` 0.58.2, `muda` 0.22.0 and `tray-icon` 0.27.0.
- Line and file counts come from git.

## What Sweetview is

Sweetview lets a Bun app open a webview window, put an icon in the tray or menu bar, show notifications, and draw transparent click-through windows on the desktop. The app is TypeScript and compiles to one executable with `bun build --compile`.

## What changes

One thing changes: TypeScript stops calling native code through `bun:ffi`. A compiled native library takes over those calls, and Bun reaches it through N-API.

| Piece | Today | After |
|---|---|---|
| The webview engine | the C++ fork of `webview/webview`, a separate `.dll` or `.dylib` | the same C++ fork, whole and unchanged, linked into the one native library |
| The wrapper around the webview engine | `@n1h/sweetview-webview-bun`: 2,014 lines of TypeScript `bun:ffi` | Rust inside the native library, calling the same C API |
| Windows, overlays, click-through, tray, menus, notifications, dialogs, event loop | 2,779 lines of TypeScript `bun:ffi` on `main` calling Win32 and AppKit | Rust inside the native library, making the same OS calls |
| How Bun reaches native code | `bun:ffi`: hand-written signatures, pointers and callback pointers held in JavaScript | N-API: typed functions, no pointers in JavaScript |

## What does not change

- Every function of the C++ webview fork. The table further down lists each one.
- Everything Sweetview does today.
- What an app developer writes: the same TypeScript API, `bun add`, `bun build --compile`.
- The pure TypeScript parts: the IPC layer, the settings store, the hit-region geometry, the icon encoders, the `.app` builder.
- The demos and tests, which become the acceptance checks.

## What this does for memory safety

Win32, COM and AppKit are unsafe interfaces, and the webview engine is C++. Keeping every function means that code stays. This proposal does not make the native code memory safe. It removes the failure classes that come from doing the calls in TypeScript.

| Failure class | Example in these repositories | After |
|---|---|---|
| Wrong return type or argument count on a native call | Sweetview commit `83d7411`: `isZoomed` read with the wrong return type, `orderFrontRegardless` called with the wrong arity | checked by the compiler |
| A buffer collected while native code reads it | `encodeCString` in the bindings' `src/ffi.ts` exists because a bare pointer to a temporary array can be collected before the call | buffers are owned by Rust for the call |
| A callback freed while native code is inside it | the bindings' `NativeCallback` and `HookCallback` classes exist to defer closing a `JSCallback` until native code has left it | the native library owns every callback |
| COM and Objective-C objects released at the wrong time | Sweetview commit `db5fd1b`: COM cleanup on tab teardown | released when their owner is dropped |
| A pointer forged or kept too long in JavaScript | `unsafeHandle`, passed to workers as a number | JavaScript holds no pointers |

Where unsafe code lives afterwards:

| Code | Language | Unsafe |
|---|---|---|
| The webview engine, including the input hooks | C++, unchanged | yes, as today |
| Platform modules: each OS call Sweetview makes today | Rust | yes: one `unsafe` block per OS call, in `win32/` and `darwin/` modules only |
| Everything else in the native library: the N-API surface, queues, state, the hit-region poll logic | Rust | no: `#![forbid(unsafe_code)]` |
| Sweetview's TypeScript | TypeScript | no native calls at all |

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

### Every addition in the C++ fork

All of them are kept, with the same C functions and the same behaviour per platform.

| Addition | C API | In 2.7.0 | After |
|---|---|---|---|
| Background colour and transparency | `webview_set_background_color` | yes | kept |
| Assets at the page's own origin | `webview_set_asset` | yes | kept |
| System-wide mouse hook | `webview_mouse_hook_install`, `webview_mouse_hook_remove` | yes | kept |
| System-wide keyboard hook | `webview_keyboard_hook_install`, `webview_keyboard_hook_remove` | yes | kept |
| Permission model for the hooks | `webview_feature_permissions`, `webview_permission_status`, `webview_permission_request`, `webview_permission_set_auto_request` | yes | kept |
| Request handler, with the frames origin and service-worker requests on Windows | `webview_set_request_handler`, `webview_complete_request` | no | kept |
| Streamed responses | `webview_begin_response`, `webview_write_response_chunk`, `webview_end_response` | no | kept |
| External drop control, with HTML drops inside the page still working | `webview_set_allow_external_drop` | no | kept |
| File drop paths | `webview_set_file_drop_handler` | no | kept |
| Teardown hardening: live-webview registry, alive tokens, owned COM references, owned dispatch queue | internal | no | kept |

The upstream functions are kept too: `webview_create` (own window or a host window), `webview_destroy`, `webview_run`, `webview_terminate`, `webview_dispatch`, `webview_get_window`, `webview_set_title`, `webview_set_size`, `webview_navigate`, `webview_set_html`, `webview_init`, `webview_eval`, `webview_bind`, `webview_unbind`, `webview_return`.

### Everything the bindings expose

All kept, under the same names: `Webview` with `setAsset`, `assetOrigin`, `framesOrigin`, `setRequestHandler`, `completeRequest`, `beginResponse`, `writeResponseChunk`, `endResponse`, `setAllowExternalDrop`, `setFileDropHandler`, `setBackgroundColor`, `bind`, `bindRaw`, `unbind`, `return`, `eval`, `init`, `navigate`, `setHTML`, `run`, `destroy`; the worker functions `completeWebviewRequest`, `beginWebviewResponse`, `writeWebviewResponseChunk`, `endWebviewResponse`; `installMouseHook`, `installKeyboardHook`, `permissions`; `unload`.

### Everything Sweetview does on `main`

All kept.

| Journey | Present on `main` |
|---|---|
| Tray or menu-bar app | `createTray`: icon, tooltip, `onClick`, `onDoubleClick`, menus with `checked`, `icon`, submenus and separators. A menu given as a function is rebuilt every time it opens |
| Tray-only app, single file, no worker | `demos/menubar-only/app.ts`, 42 lines, on `runEventLoop` |
| Notifications | `createNotifier` with click events |
| Webview app with IPC and no TCP | `createWebviewApp` |
| N windows | one `createOverlayWindow({ frame: true })` and one `createWebviewApp` per window, in one loop |
| Tabs | `demos/native-tabs/` |
| Transparent click-through | `createOverlayWindow({ transparent: true })`, `setHitRegions`, `createHitRelay` |
| Both ways of running the loop | `run()`, the library's blocking loop, with a worker; `runEventLoop`, pumped from a Bun timer, with none |
| Folder dialog, app menu, app icon, activation policy, page-drawn window chrome | `pickFolder`, `installAppMenu`, `setAppIcon`, `setActivationPolicy`, `windowChromeMethods` |

### Everything `v1-drafting` adds to Sweetview

All in scope, after `main`'s behaviour is running on the new library: URL schemes and single-instance handoff, clipboard, WinRT toast notifications, screen information, popup menus at a point, native file reading, the request handler and streamed worker responses, file drops, chunked IPC framing, app identity, tabs as library API.

## Shape

| Layer | Content | Language |
|---|---|---|
| App | the developer's single `.ts` file | TypeScript |
| Sweetview API | the API of today, unchanged | TypeScript |
| Native library | one prebuilt binary per target, loaded through N-API | Rust, with the C++ webview engine linked in |

- `bun add` installs one package holding the TypeScript and one prebuilt binary per target.
- CI builds the binaries on one runner per OS. Consumers install no Rust and no C++ toolchain.
- The binary is loaded with a literal `require` of a fixed path, the form `bun build --compile` embeds.
- `@n1h/sweetview-webview-bun` is folded into the one package; its API is re-exported unchanged.

## IPC and bail-out

The service definition and bridge stay as they are. Two transports are added beside the webview and WebSocket ones: Tauri 2 (`invoke` and events) and Electron (preload bridge). Page code is identical across all four.

## Order of work

Each step moves one group of native calls from TypeScript into the native library. After every step the tree works, with moved groups in the library and the rest still on `bun:ffi`.

1. Native library skeleton: N-API entry point, the C++ engine linked in, CI producing the prebuilt binaries. Acceptance: the bindings' own tests pass against it, and `examples/basic.ts` runs unchanged.
2. The webview wrapper: every `Webview` method, the worker functions, the hooks and permissions. Acceptance: the bindings' `test/request-handler.test.ts` and `examples/input-hooks.ts` pass unchanged.
3. Event loop and windows. Acceptance: Sweetview's window tests pass and `demos/web-app` runs unchanged.
4. Overlays and hit regions. Acceptance: `demos/desktop-pet` runs unchanged.
5. Tray, menus, notifications, dialogs. Acceptance: `demos/menubar-only` and `demos/menubar-notify` run unchanged.
6. Native tabs. Acceptance: `demos/native-tabs` runs unchanged.
7. Delete the TypeScript FFI files and the separate bindings package.
8. The `v1-drafting` features, one at a time, each accepted by its own tests.
9. Tauri 2 and Electron transports.
10. Linux minimal pass.

## Risks and actions

| Risk | Action |
|---|---|
| A moved group behaves differently from its TypeScript original | Each group is accepted against its existing tests and demo before the TypeScript version is deleted. Both exist side by side until the tests pass on the library version. |
| A JavaScript callback must run on the UI thread while that thread is inside the blocking loop, which `bun:ffi` does today with `JSCallback` | Step 1 proves the N-API equivalent with a bound function called from the page while `run()` blocks, before anything else is moved. |
| A worker thread calls `webview_dispatch` and the completion and streaming functions today | Those functions stay callable from any thread, as the C API documents; step 2 runs the bindings' worker tests unchanged. |
| `unsafe` blocks spread through the Rust code | `#![forbid(unsafe_code)]` on every module outside `win32/` and `darwin/`. CI fails when the count of `unsafe` blocks rises without a matching entry in a tracked list. |
| The C++ engine has memory errors | CI builds it with AddressSanitizer and runs the fork's own unit and functional tests under it on macOS and Linux. |
| Linux has little existing behaviour to match | Linux is last. The engine's upstream GTK backend runs there; each fork addition and each native module is implemented for it. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Replace the C++ engine with `wry` | It removes functionality: `wry`'s protocol responder takes a whole body, so streamed responses go; it has no service-worker request filter; its drop handler replaces WebView2's drop target, which stops HTML drops inside the page; it has no system-wide input hooks |
| Replace Sweetview's windows with `tao` | `tao` runs its own event loop. Sweetview has two, the engine's blocking loop and the timer pump, and both are kept |
| Keep the TypeScript FFI | No checks at all on any native call |
| `webviewjs/webview` | Built on `wry`, so the same functionality goes. Its tray does not deliver events without a window (issue #96, open) |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket; excluded by the project owner |
| bunmaska | alpha; its native layer is `bun:ffi` written in TypeScript |
| `Bun.WebView` | headless browser automation; opens no window |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Functionality | all of it is kept | the rule this proposal follows |
| The C++ webview engine | kept whole, from the fork's `v1-drafting` branch | it is the only implementation of everything the fork does, and that branch contains every addition |
| Order | `main`'s behaviour first, then each `v1-drafting` feature | `main` is the published line; `v1-drafting` contains `main` |

## Sources

- https://github.com/napi-rs/napi-rs
- https://github.com/microsoft/windows-rs
- https://github.com/madsmtm/objc2
- https://bun.com/docs/compiler/executables
- https://github.com/webview/webview
- https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html
- https://docs.rs/tao/latest/tao/platform/run_return/trait.EventLoopExtRunReturn.html
- https://webview.js.org/api/webview/
- https://github.com/webviewjs/webview/issues/96
- https://github.com/blackboardsh/electrobun
- https://github.com/ipfizz/bunmaska
- https://bun.com/blog/bun-v1.4
