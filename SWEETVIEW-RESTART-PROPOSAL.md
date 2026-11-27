# Sweetview restart proposal

Status: proposal, awaiting decisions C and D at the end.

Basis: the npm registry, the `webviewjs/webview` repository and its documentation, as of 2026-11-27.

The current tree (`main` and `v1-drafting`) is reference material only. Its native code is TypeScript calling Win32 and Objective-C through `bun:ffi`, plus two C++ forks. None of that ships.

| Branch | Platform code (non-test `.ts` under the `win32/` and `darwin/` folders) | Other FFI |
|---|---|---|
| `main` | 2,779 lines in 24 files, under `src/native/` | 2,004 lines in 7 files in the `demos/native-tabs` demo |
| `v1-drafting` | 6,916 lines in 35 files, under `packages/sweetview-native/src/` | 2,669 lines in 8 files in the other packages |

## What this delivers

One package an app developer adds with `bun add`. TypeScript only on their side. Compiled with `bun build --compile`. All native code is one Rust library shipped prebuilt. Targets are Windows, macOS and, minimally, desktop Linux.

Each of these works alone, in a single `.ts` file:

1. A menu-bar or system-tray app: icon, left and right click on the icon, menus with checkmarks, icons and dynamic updates.
2. A webview app whose page talks to Bun over IPC with no TCP.
3. Native OS notifications.
4. A webview app with N windows, and tabs in one window.
5. Transparent full-screen desktop games with hit-region click-through.

An app that grows stays on this stack. An app that wants to leave can move to Tauri 2 (or Electron) without changing its page code.

## Layer 1: native engine

A fork of `webviewjs/webview` (MIT), owned by this project.

### What `webviewjs/webview` is

| Fact | Value |
|---|---|
| What it is | a Rust library exposed to JavaScript through N-API; JavaScript holds no pointers |
| Runtimes | Bun, Node.js, Deno. Its own build and CI run on Bun 1.4.2 |
| Published | on npm as `@webviewjs/webview` since October 2024; 27 versions; `0.6.0` on 2026-10-29, `1.0.0-rc.4` on 2026-10-30 |
| Use | 1,846 npm downloads in the week ending 2026-11-26; repository last pushed 2026-11-19 |
| Prebuilt binaries | 12 platform packages installed automatically by `bun add`, including Windows x64 and arm64, macOS x64 and arm64, Linux x64 and arm64 |
| Size | 6,082 lines of Rust across its 11 main source files; the word `unsafe` appears 5 times |
| Built on | `tao` 0.37 (windows, event loop), `wry` 0.55 (webview), `muda` 0.19 (menus), `tray-icon` 0.24 (tray), `notify-rust` 4.18 (notifications), `rfd` (file dialogs) |
| Tests | runtime tests for application, window, webview, IPC, custom protocol, tray and notification |
| Maintainer | one person, `twlite`, with 202 of the 215 commits |

`tao`, `wry`, `muda` and `tray-icon` are the Tauri team's libraries, the ones Tauri 2 itself runs on, usable without Tauri.

### What it already does

Each row has a runnable example in the repository under `apps/examples/`.

| Capability | Example file |
|---|---|
| Tray icon with left, right and middle click events, menu, dynamic icon and menu | `tray.ts` |
| Application and window menus with submenus, separators, shortcuts | `menu-system.ts`, `window-menus.ts` |
| Notifications with action buttons and click events | `notification.ts` |
| Multiple windows | `multiple.ts` |
| Several webviews in one window, each with its own bounds | `multi-webview.ts` |
| Transparent windows | `transparent.ts` |
| Page-to-host calls with no TCP | `expose.ts` |
| Serving page assets from a custom protocol | `custom-protocol.ts` |
| Frameless windows and drag regions | `undecorated.ts`, `drag-region.ts` |
| Native file drop | `native-file-drop.ts` |

It also has macOS native tabs through a window tabbing identifier, whole-window click-through on Windows and macOS (`setIgnoreCursorEvents`), always-on-top, fullscreen, and an event loop that runs on a Bun timer without blocking JavaScript.

### What the fork adds

| Addition | Why | Size |
|---|---|---|
| Checkmarks and icons on menu items, per-item updates | the binding's `menu.rs` (193 lines) exposes only plain items; `muda` underneath already has check items and icon items | extends one small file |
| Hit-region click-through for transparent windows | it has only a whole-window on/off switch; the games need "click the sprite, pass through elsewhere" | new module with OS hit-testing code |
| All target binaries inside one package | it ships one package per platform, which blocks compiling a Windows executable on a Mac | packaging change |

Rule for the fork: `#![forbid(unsafe_code)]` on every file except the hit-testing module. The compiler enforces it.

## Layer 2: TypeScript API

What app developers import. One entry point per journey, each usable without the others.

| Entry point | Journey | Windows | macOS | Linux (minimal) |
|---|---|---|---|---|
| `/tray` | menu bar or system tray, icon clicks, dynamic menus | full | full | right-click menu only |
| `/notify` | native notifications with click events | full | needs a signed `.app` | basic |
| `/webview` | a window rendering a page, N windows | full | full | full |
| `/webview` tabs | tabs in one window | tab strip plus one child webview per tab | native tabs | tab strip plus one child webview per tab |
| `/overlay` | transparent, always on top, hit-region click-through | full | full | not planned |
| `/build` | `.app` bundle helper, compile helper | n/a | n/a | n/a |

The API is this project's own shape and small. It is not Electron's `BrowserWindow`. The engine stays behind it.

## Layer 3: IPC

The service definition, bridge and ready handshake from the Qt template, ported as they are.

Transports, with identical page code across all of them:

| Transport | Used when | Carrier |
|---|---|---|
| webview | the page runs in a Sweetview window | native webview messaging, no TCP |
| WebSocket | the same page runs in a browser | `Bun.serve` WebSocket |
| Tauri 2 | the app has moved to Tauri | `invoke` and events |
| Electron | the app has moved to Electron | preload bridge |

Bailing out to Tauri 2: the page does not change. The service either runs as a Bun sidecar under Tauri or is ported to Rust commands.

## Carried over from the current tree

All pure TypeScript, no FFI.

| Item | On `main` | On `v1-drafting` |
|---|---|---|
| IPC contract and bridge (`defineService`, `createBridge`) | yes | yes |
| WebSocket transport (`wsHost`, `wsTransport`) | yes | yes |
| Settings store | yes | yes |
| Hit-region geometry | yes | yes |
| Icon encoders | yes | yes |
| `.app` bundle builder (`makeMacApp`) | yes | yes |
| Ready handshake (`signalReady`) | no | yes |
| App identity (`defineAppIdentity`) | no | yes |
| Chunked IPC framing (`ChunkFrame`) | no | yes |

The docs serve as the API reference and the demos as acceptance tests.

## Dropped

- every line of `bun:ffi`, and both C++ forks (`n0t-invented-here/sweetview-webview`, `n0t-invented-here/sweetview-webview-bun`)
- streamed responses: `wry` accepts only whole response bodies, so large payloads go as chunked IPC messages
- the mandatory worker and the shared-memory ring: the timer-driven loop makes a worker optional

## Distribution

- One npm package holding the TypeScript and one prebuilt binary per target: Windows x64, macOS arm64, Linux x64.
- CI builds the binaries on one runner per OS, the same way the upstream `Build.yml` workflow does. Consumers never install Rust.
- The binary is loaded with a literal `require`, which is the form `bun build --compile` embeds.

## Order of work

1. Fork `webviewjs/webview` and `webviewjs/tao`; CI produces the three prebuilt binaries in one package.
2. `/tray` and `/notify`, with checkmarks and icons added to menus.
3. `/webview` with the IPC port.
4. Multiple windows and tabs.
5. Hit-region click-through, then port one game.
6. Tauri 2 and Electron transports.
7. Linux minimal pass.

## Risks and actions

| Risk | Action |
|---|---|
| Upstream has one maintainer | Step 1 forks the repository into this project's organization. This project's CI builds and publishes its own binaries. Upstream commits are merged by choice, never required. |
| Upstream builds against its own patched `tao` (`webviewjs/tao`, pinned by commit) | Step 1 forks that repository too and pins the same commit from this project's copy. |
| macOS shows no notifications from an unsigned bundle | The `/build` helper signs every `.app` it produces. `/notify` throws an error naming the missing signature when called outside a signed bundle. |
| The Linux tray backend delivers no click events | `/tray` exposes `supportsIconClick`, false on Linux. On Linux the icon opens the menu, and the app puts its click action as the first menu item. |
| Hit-testing requires unsafe Rust | It lives in one module. Every other file carries `#![forbid(unsafe_code)]`, so the compiler rejects unsafe code anywhere else. |
| `wry` cannot stream response bodies | Large payloads use the chunked IPC framing carried over from `v1-drafting`. Decision D confirms this. |
| Upstream ships one package per platform, which blocks cross-compiling | Step 1 changes packaging to one package holding all three binaries. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket, broken transparent click-through, Zig, Objective-C and C++ native layer; excluded by the project owner |
| bunmaska | alpha; its native layer is `bun:ffi` written in TypeScript |
| `Bun.WebView` | headless browser automation; opens no window |
| Deno desktop, Neutralinojs | not Bun |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |
| Own Rust crate on raw OS bindings | the same unsafe OS calls in another language |

## Open decisions

C. Native engine: fork `webviewjs/webview` and own the fork (recommended), or write a Rust crate on `tao` and `wry` from zero? The fork starts with 6,082 lines of Rust covering windows, tray, menus, notifications and the event loop. From zero, all of that is written again.

D. Is losing streamed responses acceptable, with large payloads sent as chunked IPC messages instead?

## Sources

- https://github.com/webviewjs/webview
- https://www.npmjs.com/package/@webviewjs/webview
- https://webview.js.org/api/browser-window/
- https://webview.js.org/api/tray/
- https://webview.js.org/api/menu/
- https://webview.js.org/api/notification/
- https://webview.js.org/getting-started/event-loop/
- https://github.com/webviewjs/webview/issues/89
- https://github.com/tauri-apps/wry
- https://github.com/tauri-apps/tao
- https://bun.com/docs/compiler/executables
- https://github.com/blackboardsh/electrobun
- https://github.com/blackboardsh/electrobun/issues/263
- https://github.com/ipfizz/bunmaska
- https://bun.com/blog/bun-v1.4
