# Sweetview restart proposal

Status: proposal, awaiting decision D at the end.

Basis: the npm registry, the repositories and documentation named under Sources, and git counts of this repository, as of 2026-11-27.

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

A Rust crate owned by this project, exposed to Bun through N-API with `napi-rs`. JavaScript holds no pointers. The crate binds the libraries Tauri 2 itself runs on, used without Tauri.

| Library | Job | Platforms |
|---|---|---|
| `tao` | windows and the OS event loop | Windows, macOS, Linux |
| `wry` | the webview: WebView2, WKWebView, WebKitGTK | Windows, macOS, Linux |
| `muda` | menus: plain, check, icon and submenu items | Windows, macOS, Linux |
| `tray-icon` 0.25 with its `ksni` feature | tray and menu-bar icon with click events | Windows, macOS, Linux |
| `notify-rust` | native notifications | Windows, macOS, Linux |
| `rfd` | file and folder dialogs | Windows, macOS, Linux |

Code this project writes in the crate:

| Part | Content |
|---|---|
| The N-API binding | typed functions over the six libraries above |
| Hit-region click-through | OS hit-testing for transparent windows: "click the sprite, pass through elsewhere" |
| Event loop integration | the OS loop is pumped from a Bun timer, the model today's Sweetview uses in `runEventLoop` and its `menubar-only` demo |

Size reference: `webviewjs/webview`, an existing binding over the same libraries, is 6,082 lines of Rust.

Rule for the crate: `#![forbid(unsafe_code)]` on every file except the hit-testing module. The compiler enforces it.

## Layer 2: TypeScript API

What app developers import. One entry point per journey, each usable without the others.

| Entry point | Journey | Windows | macOS | Linux (minimal) |
|---|---|---|---|---|
| `/tray` | menu bar or system tray, icon clicks, dynamic menus | full | full | menu and left click, on desktops with a StatusNotifierItem host (KDE Plasma, Waybar) |
| `/notify` | native notifications with click events | full | needs a signed `.app` | basic |
| `/webview` | a window rendering a page, N windows | full | full | full |
| `/webview` tabs | tabs in one window | tab strip plus one child webview per tab | native tabs | tab strip plus one child webview per tab |
| `/overlay` | transparent, always on top, hit-region click-through | full | full | not planned |
| `/build` | `.app` bundle helper, compile helper | n/a | n/a | n/a |

`/tray` and `/notify` load no webview code. A tray-only app runs with no window.

## Layer 3: IPC

The service definition, bridge and ready handshake from the Qt template, ported as they are.

Transports, with identical page code across all of them:

| Transport | Used when | Carrier |
|---|---|---|
| webview | the page runs in a Sweetview window | native webview messaging, no TCP |
| WebSocket | the same page runs in a browser | `Bun.serve` WebSocket |
| Tauri 2 | the app has moved to Tauri | `invoke` and events |
| Electron | the app has moved to Electron | preload bridge |

Bailing out to Tauri 2: the page does not change. The service either runs as a Bun sidecar under Tauri or is ported to Rust commands. The native layer is already Tauri's own libraries.

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
- the mandatory worker and the shared-memory ring

## Distribution

- One npm package holding the TypeScript and one prebuilt binary per target: Windows x64, macOS arm64, Linux x64.
- CI builds the binaries on one runner per OS. Consumers never install Rust.
- The binary is loaded with a literal `require` of a fixed path, which is the form `bun build --compile` embeds. All targets ship in the one package, so a Windows executable compiles on a Mac.

## Order of work

1. Crate skeleton with CI producing the three prebuilt binaries in one package, and a tray-only app with no window that receives icon clicks on Windows, macOS and Linux.
2. `/tray` with checkmarks, icons and dynamic menus; `/notify`.
3. `/webview` with the IPC port.
4. Multiple windows and tabs.
5. Hit-region click-through, then port one game.
6. Tauri 2 and Electron transports.
7. Linux minimal pass.

## Risks and actions

| Risk | Action |
|---|---|
| Tray events are lost when the OS loop is pumped from a timer with no window. `webviewjs/webview` has exactly this bug (issue #96) | Step 1 is the tray-only app with no window. No other feature is built until it receives clicks on all three OSes. The tray module pumps the OS loop itself (`PeekMessage` on Windows, `NSApplication` event polling on macOS) the way today's `menubar-only` demo does. |
| `tray-icon` up to 0.24 emits no click events on Linux | The crate uses `tray-icon` 0.25 with the `ksni` feature, which delivers left click through StatusNotifierItem (tauri-apps/tray-icon#201, merged 2026-09-08). |
| GNOME has no StatusNotifierItem host without an extension | `/tray` exposes `supportsIconClick`. Where it is false, the app's click action is the first menu item. |
| Transparent windows on Windows turn opaque intermittently | `/overlay` creates transparent windows without a redirection bitmap, the fix recorded in webviewjs issue #59. |
| Hit-testing requires unsafe Rust | It lives in one module. Every other file carries `#![forbid(unsafe_code)]`. |
| macOS shows no notifications from an unsigned bundle | The `/build` helper signs every `.app` it produces. `/notify` throws an error naming the missing signature when called outside a signed bundle. |
| `wry` cannot stream response bodies | Large payloads use the chunked IPC framing carried over from `v1-drafting`. Decision D confirms this. |
| Handle leaks on Windows when windows are disposed (reported against webviewjs `0.4.4`, issue #54) | CI runs a create-and-dispose cycle test that counts process handles on Windows. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| `webviewjs/webview`, as a dependency or as a fork | See the next section |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket, broken transparent click-through, Zig, Objective-C and C++ native layer; excluded by the project owner |
| bunmaska | alpha; its native layer is `bun:ffi` written in TypeScript |
| `Bun.WebView` | headless browser automation; opens no window |
| Deno desktop, Neutralinojs | not Bun |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |
| Own Rust crate on raw OS bindings | the same unsafe OS calls in another language |

## Why not `webviewjs/webview`

It is an N-API binding over `tao`, `wry`, `muda`, `tray-icon` and `notify-rust` for Bun, Node.js and Deno. It is used here as reading material only.

| Finding | Evidence |
|---|---|
| Its tray is broken for the first journey | Issue #96, open, filed 2026-11-25 against `0.6.0`: with no window, tray events do not fire. With a window, they arrive only once the window gains focus or receives mouse events. |
| No icon clicks on Linux | It pins `tray-icon` 0.24.1, which emits no events on Linux. Its docs state "Linux does not emit tray pointer events." |
| No checkmarks or icons on menu items | Its menu item type has `id`, `label`, `enabled`, `accelerator`, `submenu`, `role` and nothing else. |
| No hit-region click-through | Only `setIgnoreCursorEvents(boolean)` for the whole window. |
| Young event loop | `app.run()` blocked JavaScript until `0.4.0` on 2026-06-29. That month the engine went from `tao` to `winit` and back to a patched `tao`. |
| One maintainer, with a gap | 202 of 215 commits by one person. No release between 2026-01-11 and 2026-06-20. |
| Issue history | 60 issues, 52 closed. Closed ones include a Windows memory and handle leak (#54), intermittently opaque transparent windows (#59), a macOS blank-window regression in `0.4.0` (#47) and four binary-install failures (#23, #29, #48, #69). |

## Open decision

D. Is losing streamed responses acceptable, with large payloads sent as chunked IPC messages instead?

## Sources

- https://github.com/tauri-apps/tao
- https://github.com/tauri-apps/wry
- https://github.com/tauri-apps/muda
- https://github.com/tauri-apps/tray-icon
- https://docs.rs/tauri/latest/tauri/tray/enum.TrayIconEvent.html
- https://v2.tauri.app/learn/system-tray/
- https://docs.rs/ksni/latest/ksni/trait.Tray.html
- https://github.com/webviewjs/webview
- https://github.com/webviewjs/webview/issues?q=is%3Aissue
- https://github.com/webviewjs/webview/issues/96
- https://github.com/webviewjs/webview/issues/59
- https://github.com/webviewjs/webview/issues/54
- https://github.com/webviewjs/webview/issues/37
- https://github.com/webviewjs/webview/issues/89
- https://webview.js.org/api/tray/
- https://webview.js.org/api/menu/
- https://bun.com/docs/compiler/executables
- https://github.com/blackboardsh/electrobun
- https://github.com/blackboardsh/electrobun/issues/263
- https://github.com/ipfizz/bunmaska
- https://bun.com/blog/bun-v1.4
