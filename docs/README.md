# @n1h/sweetview reference

Sweetview 1.0.0 reference. Each page documents its module's exports, including
parameters, return value, errors, platform differences and thread rules. The
overview, install and quickstart are in the [package README](../README.md).

| Module | Contents |
|---|---|
| [`@n1h/sweetview`](app.md) | `createApp`, `WebView` (`WebView.attach`, `WebView.openTab`), native tabs (`Tab`, `TabOptions`), `windowChromeMethods`, `runEventLoop`, `indexHtml`, `assetMime`, `Ring`, and `RawWebview` |
| [`@n1h/sweetview/worker`](worker.md) | `hostService`, `hostRequestHandler`, chunked IPC and binary responses |
| [`@n1h/sweetview/page`](page.md) | `isWebview`, `webviewTransport`, `signalReady` |
| [`@n1h/sweetview/ipc`](ipc.md) | the contract: `defineService`, `createBridge`, `memoryTransport`, the wire frames |
| [`@n1h/sweetview/ipc-ws`](ipc-ws.md) | the contract over WebSockets: `wsHost` for `Bun.serve`, `wsTransport` and `wsUrl` for the browser; each side alone as `/ipc-ws/server` and `/ipc-ws/client` |
| [`@n1h/sweetview/native`](native.md) | unified `Window` / `createWindow`, `Screen`, `Menu.popup`, `Tray`, `Notifier`, `HitRelay` and hit regions, `pickFolder`, `setAppMenu`, `setAppIcon`, `runEventLoop` / `quitEventLoop`, icons; the hit-region helpers alone, without FFI, as `/native/hit-regions` |
| [`@n1h/sweetview/settings-store`](settings-store.md) | a JSON settings file in the user's application data folder |
| [`@n1h/sweetview/window-chrome`](window-chrome.md) | a page-drawn title bar and resize handles backed by OS moves and resizes |
| [`@n1h/sweetview/build`](build.md) | `writeIconFiles` and `makeMacApp`; the page also covers the `make-app.ts` script and the `/file-imports` types |
| [the webview library](webview-library.md) | C API, intercepted origins, companion repositories and rebuilds |

The [workspace table](../README.md#documentation) maps each facade subpath
to its publishing package under `packages/`. Direct package imports are
available for IPC, WebSocket IPC, native APIs, settings and build tools.

`page`, `window-chrome` and `native/hit-regions` import types only, so a
page bundle contains no Bun code.

## Planning & Audit

| Document | Contents |
|---|---|
| [v1 API and migration](v1-api.md) | The released API, examples, and breaking changes |
| [Audit & v1 plan](audit-and-v1-plan.md) | Pre-v1 audit findings and the architecture decisions behind the workspace and zero-TCP desktop transport |
| [v1 checklist](v1-checklist.md) | Implementation and verification tracker for the `1.0.0` release |
| [v1 macOS and Linux verification](v1-macos-verification.md) | Native library rebuilds, platform tests and macOS GUI checks |
