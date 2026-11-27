# Web App in Tauri 2

The [web-app demo](../web-app/README.md)'s page in a Tauri 2 shell, answered
by a backend written in Rust. The page is the same source as in the
Sweetview window and the browser: its
[`bridge.ts`](../web-app/packages/web-app-frontend/src/bridge.ts) picks
`tauriTransport()` because it runs in a Tauri webview. The Rust side
implements the frame protocol of [`ipc-tauri`](../../docs/ipc-tauri.md#rust-backend)
and enough of the web-app service for the page to work.

| Recipe | Does |
|---|---|
| `just demos web-app-tauri app` | Builds the page, writes the icon, builds the Rust shell (`tauri build --debug --no-bundle`), and opens the window. |
| `just demos web-app-tauri probe` | The same, with `WEB_APP_PROBE=1`: logs every call and event the backend handles, records what the page shows as one `PROBE {...}` line on stdout, and exits. |
| `just demos web-app-tauri clean` | Removes `build/` and runs `cargo clean` for `src-tauri`. |

Run the recipes from the repository root after `bun install`. They need
Rust and Cargo, and on Windows the WebView2 runtime. `@tauri-apps/cli` is
this demo's devDependency; the page does not use `@tauri-apps/api`.
`src-tauri/Cargo.toml` has its own empty `[workspace]`, so the crate never
joins a Cargo workspace at the repository root.

## What the Rust backend implements

[`src-tauri/src/backend.rs`](src-tauri/src/backend.rs) answers the methods of
[`protocol.ts`](../web-app/packages/web-app-backend/src/protocol.ts):

| Method | Answer |
|---|---|
| `info.get` | Runtime info: `runtime` is `Rust backend, Tauri <version>`, `host` is `"tauri"`, with the platform, architecture, process id, working folder and session count. |
| `notes.list` | The shared notes. |
| `notes.add` | Adds a note, emits `notes.changed` to every webview, returns the note. `text is required` for empty text. |
| `notes.remove` | Removes a note, emits `notes.changed`. `note <id> not found` for an unknown id. |
| `watch.status`, `watch.stop` | Not watching; `watch.stop` also emits `watch.status` to the calling webview only. |
| `watch.start` | An error: this backend does not watch folders. |
| `ui.theme` | Nothing (`null`). |
| `pick.folder`, `notify.status`, `notify.onChanges`, `notify.test` | An error, as on the web; the page does not call them outside the Sweetview desktop app. |

Events it sends: `notes.changed` to everyone, `watch.status` to one webview.

## How it is put together

| Path | Is |
|---|---|
| [`index.html`](index.html) | The page's HTML entry; `bun build ./index.html --outdir build` bundles the web-app frontend from it. `build/` is Tauri's `frontendDist`. |
| [`src-tauri/src/sweetview_ipc.rs`](src-tauri/src/sweetview_ipc.rs) | The protocol: decodes a `CallFrame`, builds the `ReplyFrame`, and emits `EventFrame`s as the `sweetview-ipc:event` Tauri event, to everyone or to one webview. Self-contained, to copy into another app. |
| [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | The `sweetview_ipc` command (one webview label = one session), the session end on window close, and the probe. |
| [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json), [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json) | The window, a content security policy that allows Tauri's IPC origin, and `core:event:default` so the page can listen. |
| [`scripts/write-icon.ts`](scripts/write-icon.ts) | Writes `src-tauri/icons/icon.ico`, the web-app demo's sparkle tile, which `tauri-build` embeds. |

`src-tauri/target/`, `src-tauri/gen/` and `src-tauri/icons/` are build output
and are not committed.
