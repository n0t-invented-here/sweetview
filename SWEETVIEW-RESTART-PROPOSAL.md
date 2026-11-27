# Sweetview restart proposal

Status: proposal, awaiting decisions D and E at the end.

Basis: git counts of this repository, its README and `webview/README.md`, and the external sources listed at the end, as of 2026-11-27.

## The change in one paragraph

Sweetview's native code moves out of TypeScript and into one Rust library, called from Bun through N-API. The behaviour, the features, the public TypeScript API, the tests and the webview library stay. What goes is TypeScript holding raw pointers and calling the OS through `bun:ffi`.

## What exists today

| Part | Where | State |
|---|---|---|
| Webview library | `n0t-invented-here/sweetview-webview` (C++ fork of `webview/webview`) and `n0t-invented-here/sweetview-webview-bun` | works; carries this project's additions: background colour and transparency, native asset serving, and on its `v1-drafting` branches the request handler, streamed responses and external drop control |
| Native layer on `main` | `src/native/win32/` and `src/native/darwin/` | 2,779 lines of TypeScript FFI in 24 files |
| Native tabs on `main` | `demos/native-tabs/` | 2,004 lines of TypeScript FFI in 7 files |
| Native layer on `v1-drafting` | `packages/sweetview-native/src/win32/` and `darwin/` | 6,916 lines of TypeScript FFI in 35 files, plus 2,669 lines in 8 files in the other packages |
| Pure TypeScript | IPC contract and bridge, WebSocket transport, settings store, hit-region geometry, icon encoders, `.app` builder | works; no FFI |
| Tests | 17 test files on `main`, 30 on `v1-drafting` | the acceptance suite for the port |

## What is kept

- The webview library, as it is. It is linked into the Rust library and called through its existing C API.
- Every native behaviour the port source has: windows, transparent overlays and hit regions for the games, tray, notifications, menus, folder picker, icons, the event loop, native tabs.
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
| A separate `webview.dll` or `libwebview.dylib` loaded at run time | the same C++ code linked into the one native binary |

## What the port fixes

| Class of defect | Example in this repository | After the port |
|---|---|---|
| Wrong return type or argument count on a native call | commit `83d7411`: `isZoomed` read with the wrong return type, `orderFrontRegardless` called with the wrong arity | does not compile |
| Object lifetime errors: use after release, leaks of COM or Objective-C objects | commit `db5fd1b`: COM cleanup on tab teardown | released by the type system when the owner is dropped |
| A callback freed while the OS still holds its pointer | every `JSCallback` site, 65 on `v1-drafting` | the library owns the callback for the life of the registration |
| A buffer moved or collected while the OS writes to it | every `ptr()` site, 63 on `v1-drafting` | buffers are Rust-owned for the duration of the call |

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
| Tray or menu-bar app with icon clicks and menus | port of the existing tray and menu modules; checkmarks, item icons and dynamic menus added where missing | yes | yes | new code |
| Webview app with IPC and no TCP | existing webview library and IPC layer | yes | yes | upstream `webview/webview` supports WebKitGTK; this project's fork additions are ported to it |
| Native notifications | port of the existing notifier modules | yes | yes, from a signed `.app` | new code |
| N windows and tabs | port of the existing window and native-tabs modules | yes | yes | windows yes; tabs not planned |
| Transparent games with hit-region click-through | port of the existing overlay and hit-region modules, with the fork's input handling | yes | yes | not planned |

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
| The C++ webview library stays C++ | The fork's diff against upstream `webview/webview` stays small and is listed in `webview/README.md`. CI builds it with AddressSanitizer and runs the webview tests under it on macOS and Linux. |
| `unsafe` blocks spread through the Rust code | `#![forbid(unsafe_code)]` on every module outside the two platform folders. CI fails when the count of `unsafe` blocks rises without a matching entry in a tracked list. |
| The OS event loop and Bun's loop interact differently through N-API than through `bun:ffi` | Step 1 ends with the `web-app` demo running, which exercises the blocking loop with a worker. Step 3 ends with `menubar-only` running, which exercises the timer-pumped loop with no window. |
| macOS shows no notifications from an unsigned bundle | Unchanged from today: the `.app` builder signs the bundle. |
| Linux has no existing native code to port | Linux is last, scoped to a window with a webview, a tray menu and a notification. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Replace the native layer with Tauri's `tao` and `wry` libraries | loses working features: streamed responses (`wry` accepts whole bodies only), the fork's input handling for transparent games, hit regions, the Windows tab strip. All of it would be written again |
| `webviewjs/webview` | an N-API binding over `tao` and `wry`. Its tray does not deliver events without a window (issue #96, open). It has no menu checkmarks or icons, no hit regions, no Linux tray clicks. One maintainer |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket, broken transparent click-through; excluded by the project owner |
| bunmaska | alpha; its native layer is `bun:ffi` written in TypeScript |
| `Bun.WebView` | headless browser automation; opens no window |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |
| Keep the TypeScript FFI | the defect classes in "What the port fixes" stay possible in every native call |

## Open decisions

D. Should the webview library also be ported from C++ to Rust later, or stay C++ permanently? It works today and its fork diff is small. Porting it means reimplementing the WebView2 and WKWebView hosting that upstream already provides.

E. Which branch is the source of the port? `main` has 2,779 lines of native code plus the native-tabs demo. `v1-drafting` has 6,916 lines and adds URL schemes, single instance, clipboard, WinRT toasts, screen info, the request handler and file drop. Recommended: port `main`, then bring `v1-drafting` features across one at a time, each reviewed as it is ported.

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
