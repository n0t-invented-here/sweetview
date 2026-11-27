# Sweetview restart proposal

Status: proposal, awaiting decisions C and D at the end. No code has been written for it.

The current tree (`main` and `v1-drafting`) is reference material only. Its native layer is about 6,900 lines of TypeScript calling Win32 and Objective-C through `bun:ffi`, plus two C++ forks. None of that ships.

## What this delivers

One package an app developer adds with `bun add`. TypeScript only on their side. Compiled with `bun build --compile`. All native code is one Rust library shipped prebuilt inside the package. Targets are Windows, macOS and, minimally, desktop Linux.

Each of these works alone, in a single `.ts` file:

1. A menu-bar or system-tray app: icon, left and right click on the icon, menus with checkmarks, icons and dynamic updates.
2. A webview app whose page talks to Bun over IPC with no TCP.
3. Native OS notifications.
4. A webview app with N windows, and tabs in one window.
5. Transparent full-screen desktop games with hit-region click-through.

An app that grows stays on this stack. An app that wants to leave can move to Tauri 2 (or Electron) without changing its page code.

## Layer 1: native engine (Rust, prebuilt)

- One N-API addon. JavaScript never holds a pointer.
- Built on `tao` (windows and the OS event loop) and `wry` (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux). Both are the Tauri team's libraries and are usable without Tauri.
- Starting point: a fork of `webviewjs/webview` (MIT), owned by this project. It already has windows, several webviews per window, tray with click events, menus, notifications, page messaging without TCP, custom protocols, and an event loop driven by a Bun timer that does not block JavaScript.
- Rust added to the fork:
  - hit-region click-through for transparent windows (regions, plus cursor tracking so the page still sees hover)
  - checkmarks, item icons and per-item updates on tray and app menus
- Crate rule: `#![forbid(unsafe_code)]` everywhere except one small module holding the OS hit-testing code. The compiler enforces it.

## Layer 2: TypeScript API

What app developers import. One entry point per journey, each usable without the others.

| Entry point | Journey | Windows | macOS | Linux (minimal) |
|---|---|---|---|---|
| `/tray` | menu bar or system tray, icon clicks, dynamic menus | full | full | right-click menu only |
| `/notify` | native notifications with click events | full | needs a signed `.app` | basic |
| `/webview` | a window rendering a page, N windows | full | full | full |
| `/webview` tabs | tabs in one window | polyfill: tab strip plus one child webview per tab | native tabs | polyfill |
| `/overlay` | transparent, always on top, hit-region click-through | full | full | not planned |
| `/build` | `.app` bundle helper, compile helper | n/a | n/a | n/a |

The API is this project's own shape and small. It is not Electron's `BrowserWindow`. The engine stays hidden behind it so it can be replaced.

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

All pure TypeScript, no FFI:

- IPC contract, WebSocket transport, ready checks
- settings store and app identity
- hit-region geometry, icon encoders, `.app` bundle builder
- the docs as the API reference, the demos as acceptance tests

## Dropped

- every line of `bun:ffi`, and both C++ forks (`n0t-invented-here/sweetview-webview`, `n0t-invented-here/sweetview-webview-bun`)
- streamed responses: `wry` accepts only whole response bodies, so large payloads go as chunked IPC messages
- the mandatory worker and the shared-memory ring: the timer-driven loop makes a worker optional

## Distribution

- One npm package holding the TypeScript and one prebuilt binary per target: Windows x64, macOS arm64, Linux x64.
- CI builds the binaries on one runner per OS. Consumers never install Rust.
- The binary is loaded with a literal `require`, which is what makes `bun build --compile` embed it. All targets ship in the one package so a Windows executable can be compiled on a Mac.

## Order of work

1. Verify `webviewjs/webview` under Bun against the five journeys, including plain `bun build --compile`.
2. Fork it and set up CI that produces the prebuilt binaries.
3. `/tray` and `/notify`.
4. `/webview` with the IPC port.
5. Multiple windows and tabs.
6. Hit-region click-through in Rust, then port one game.
7. Tauri 2 and Electron transports.
8. Linux minimal pass.

## Risks

- `webviewjs/webview` states that it works with Bun (package README: "It works with Node.js, Bun, and Deno"), and its own repo is developed with Bun. This project has read its docs and has not run it. Step 1 settles that before the fork is committed to.
- Upstream has one maintainer and open bugs in basics (file inputs on macOS, tray events without a window). Owning the fork removes the dependency.
- Hit-region click-through is new native code in OS hit-testing, the one place unsafe Rust is unavoidable.
- macOS shows no notifications from an unsigned bundle. That is an OS rule and stays.
- Linux tray support in the underlying libraries is limited to a right-click menu.

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

C. Native engine: fork `webviewjs/webview` and own the fork (recommended), or write a Rust crate on `tao` and `wry` from zero? The fork has windows, tray, menus, notifications and the Bun event loop on day one. From zero, nothing is inherited and every feature is written and debugged by this project's agents.

D. Is losing streamed responses acceptable, with large payloads sent as chunked IPC messages instead?

## Sources

- https://github.com/webviewjs/webview
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
