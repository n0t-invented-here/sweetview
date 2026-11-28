# @n1h/sweetview reference

Sweetview 1.0.0 reference. Each page documents its module's exports, including
parameters, return value, errors, platform differences and thread rules. The
native module is split into an overview and topic guides. The overview,
install and quickstart are in the [package README](../README.md).

Moving an application from an earlier version: [Upgrading to Sweetview 1.0](upgrading.md) maps every earlier export to what you write now.

Running an application in its own repository against a Sweetview checkout, before 1.0.0 is on npm: [Running an application against a local Sweetview checkout](local-checkout.md).

| Module | Contents |
|---|---|
| [`@n1h/sweetview`](app.md) | `createApp`, `WebView` (`WebView.attach`, `WebView.openTab`), native tabs (`Tab`, `TabOptions`), dynamic requests, the ready handshake, `windowChromeMethods`, `indexHtml`, `assetMime`, `Ring`, `RawWebview` (re-exported from `@n1h/sweetview-native`), and re-exports of the event loop, activation and app identity |
| [`@n1h/sweetview/worker`](worker.md) | `hostService`, `hostRequestHandler`, chunked IPC and binary responses |
| [`@n1h/sweetview/page`](page.md) | `isWebview`, `webviewTransport`, `signalReady` |
| [`@n1h/sweetview/ipc`](ipc.md) | the contract: `defineService`, `createBridge`, `memoryTransport`, the wire frames |
| [`@n1h/sweetview/ipc-ws`](ipc-ws.md) | the contract over WebSockets: `wsHost` for `Bun.serve`, `wsTransport` and `wsUrl` for the browser; each side alone as `/ipc-ws/server` and `/ipc-ws/client` |
| [`@n1h/sweetview/ipc-electron`](ipc-electron.md) | the contract over Electron IPC: `electronHost` for the main process, `exposeSweetviewIpc` for the preload, `electronTransport` and `isElectron` for the page; each alone as `/ipc-electron/server`, `/ipc-electron/preload` and `/ipc-electron/client` |
| [`@n1h/sweetview/ipc-tauri`](ipc-tauri.md) | the contract in a Tauri 2 webview: `tauriTransport`, `tauriGlobalApi` and `isTauri` for the page (also as `/ipc-tauri/client`), and the frame protocol a Rust backend implements |
| [`@n1h/sweetview/native`](native.md) | overview of the native module; the hit-region helpers alone, without FFI, as `/native/hit-regions` |
| [Windows and screens](native/windows.md) | `Window`, `createWindow`, `WindowOptions`, framed / frameless / transparent / tabbed windows, `Window.fromHandle`, closing, file drops, `Screen` |
| [Overlays and hit regions](native/overlays-and-hit-regions.md) | `setClickThrough`, `setHitRegions`, `HitRelay`, geometry helpers, `colorKey` |
| [Menus and the tray](native/menus-and-tray.md) | `Menu.popup`, `MenuTemplate`, `resolveMenu`, `Tray`, `setAppMenu`, `setActivationPolicy` |
| [Notifications](native/notifications.md) | `Notifier`, `NotificationOptions` |
| [Activation and single instance](native/activation-and-single-instance.md) | `registerUrlScheme`, `unregisterUrlScheme`, `singleInstance`, `onOpenUrl`, `extractUrlFromArgs`, `signalReady` |
| [Dialogs, clipboard and files](native/dialogs-clipboard-files.md) | `pickFolder`, `Clipboard`, `readTextFile`, `readFileBytes`, chunked file handles |
| [Event loop and icons](native/event-loop-and-icons.md) | `runEventLoop`, `pumpEvents`, `quitEventLoop`, `setAppIcon`, icon encoders, `decodePng` |
| [`@n1h/sweetview/settings-store`](settings-store.md) | a JSON settings file in the user's application data folder; `defineAppIdentity` and `validateUrlScheme` |
| [`@n1h/sweetview/window-chrome`](window-chrome.md) | a page-drawn title bar and resize handles backed by OS moves and resizes |
| [`@n1h/sweetview/build`](build.md) | `writeIconFiles`, `makeMacApp` and `refreshWindowsIcons`; the page also covers the `make-app.ts` script and the `/file-imports` types |
| [the webview](webview-library.md) | what the webview is on each OS (WebView2 through `wry` and the Rust binding on Windows, the C++ webview library on macOS), the additions over upstream webview, intercepted origins, drop control, loading the binding and the macOS library's symbol probing, the macOS `^2.7.0` peer range, companion repositories, and building the binding and the library |

The [workspace table](../README.md#documentation) maps each facade subpath
to its publishing package under `packages/`. Direct package imports are
available for IPC, WebSocket IPC, Electron IPC, Tauri IPC, native APIs,
settings and build tools.

`page`, `window-chrome`, `native/hit-regions`, `ipc-ws/client`,
`ipc-electron/client` and `ipc-tauri/client` import types only, so a page
bundle contains no Bun code.
