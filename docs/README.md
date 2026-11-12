# @n1h/sweetview reference

One page per module. Each documents every export of that module: signature,
parameters, return value, errors, platform differences and thread rules. The
overview, install and quickstart are in the [package README](../README.md).

| Module | Contents |
|---|---|
| [`@n1h/sweetview`](app.md) | `createWebviewApp`: the window, the page, assets, the transport between page, UI thread and worker; `indexHtml`, `assetMime`, `Ring`, and `Webview` from the webview library |
| [`@n1h/sweetview/worker`](worker.md) | `hostService` |
| [`@n1h/sweetview/page`](page.md) | `isWebview`, `webviewTransport` |
| [`@n1h/sweetview/ipc`](ipc.md) | the contract: `defineService`, `createBridge`, `memoryTransport`, the wire frames |
| [`@n1h/sweetview/ipc-ws`](ipc-ws.md) | the contract over WebSockets: `wsHost` for `Bun.serve`, `wsTransport` and `wsUrl` for the browser; each side alone as `/ipc-ws/server` and `/ipc-ws/client` |
| [`@n1h/sweetview/native`](native.md) | tray, notifications, windows and overlays, click-through hit regions, folder picker, app menu, the OS event loop for an app with no window, icons; the hit-region helpers alone, without FFI, as `/native/hit-regions` |
| [`@n1h/sweetview/settings-store`](settings-store.md) | a JSON settings file in the user's application data folder |
| [`@n1h/sweetview/window-chrome`](window-chrome.md) | a page-drawn title bar and resize handles backed by OS moves and resizes |
| [`@n1h/sweetview/build`](build.md) | `writeIconFiles` and `makeMacApp`; the page also covers the `make-app.ts` script and the `/file-imports` types |
| [the webview library](webview-library.md) | the two C API additions the package relies on, and how the library is loaded |

Dependencies between the modules point one way. `ipc` imports nothing.
`ipc-ws`, `worker` and `page` import `ipc`. `native`, `settings-store` and
`build` import nothing else in the package. The root module imports `ipc`,
`native`, `window-chrome` and the webview library.

`page`, `window-chrome` and `native/hit-regions` import types only, so a
page bundle contains no Bun code.
