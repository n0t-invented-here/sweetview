# Web App

One backend and one React page, run two ways: as a desktop app in a
Sweetview window, or as a web app from `Bun.serve` in any browser. The page
keeps notes, shows where it is running, and watches a folder for changes.
The desktop build adds a tray icon, system notifications and a native folder
picker.

| Recipe | Does |
|---|---|
| `just demos web-app app` | Builds the page and runs the desktop app uncompiled. `WEBVIEW_DEBUG=1` opens devtools. |
| `just demos web-app serve` | Builds the page and serves the web app on `http://127.0.0.1:4747` (`PORT` and `HOST` change it). |
| `just demos web-app compile` | The Windows exe, the macOS binary and `dist/Web App.app`, into `dist/`. |
| `just demos web-app clean` | Removes `build/` and `dist/`. |

Run the recipes from the repository root, in a checkout of the `v1-drafting`
branch after `bun install` ([Install](../../README.md#install)). Each recipe
first builds the page with
`bun build packages/web-app-frontend/src/main.tsx --outdir build/frontend`.

## How it is put together

The demo is three workspace packages and two entry points:

| Path | Is |
|---|---|
| [`packages/web-app-backend/src/protocol.ts`](packages/web-app-backend/src/protocol.ts) | The contract: `Methods` and `Events`. The page imports only these types. |
| [`packages/web-app-backend/src/index.ts`](packages/web-app-backend/src/index.ts) | `createService()`: the notes, the folder watcher and the session list, as one [`Service`](../../docs/ipc.md). It knows nothing about windows or sockets. |
| [`packages/web-app-frontend/src/`](packages/web-app-frontend/src/bridge.ts) | The React and Mantine page. [`bridge.ts`](packages/web-app-frontend/src/bridge.ts) picks the transport once: `webviewTransport()` inside the app, `electronTransport()` in [the Electron shell](../web-app-electron/README.md), `tauriTransport()` in [the Tauri 2 shell](../web-app-tauri/README.md), `wsTransport()` in a browser. |
| [`app.ts`](app.ts), [`app-worker.ts`](app-worker.ts) | The desktop entry point and its worker. |
| [`web.ts`](web.ts) | The web entry point. |

### Desktop: `app.ts`

- [`createApp`](../../docs/app.md#createapp) opens the window with the built
  page as assets (`index.html` from `indexHtml`, plus `main.js` and
  `main.css`) and starts [`app-worker.ts`](app-worker.ts), which hosts the
  service with [`hostService`](../../docs/worker.md#hostservice). Page calls
  travel page to UI thread to worker over the shared ring.
- The UI thread answers the desktop-only methods itself, as `uiMethods`:
  `pick.folder` (the native folder dialog), `ui.theme`, and the
  `notify.*` methods.
- The tray ([`tray-menu.ts`](tray-menu.ts)) shows and hides the window,
  switches the theme, picks or stops the watched folder, sends a test
  notification, toggles a notification on every folder change, and quits.
  The window's close button hides it to the tray; Quit ends `app.run()`.
- A notification click shows the window and marks the notification as
  clicked in the page. On macOS notifications need the `.app` bundle
  ([notifications](../../docs/native/notifications.md#macos)).
- `setAppMenu` gives macOS its menu bar (About, Quit and the Edit menu), and
  `setAppIcon` its Dock icon.

### Browser: `web.ts`

- `Bun.serve` serves the same built `main.js` and `main.css` with a small
  HTML page, and hosts the same `createService()` behind
  [`wsHost`](../../docs/ipc-ws.md#wshost) at `/ws`. Every browser tab is its
  own session.
- It binds `127.0.0.1` by default, because the service can watch any folder
  on the machine; `HOST=0.0.0.0` exposes it.
- The desktop-only methods reach the service here, which answers
  `pick.folder` and the `notify.*` methods with an error saying they belong
  to the desktop app and ignores `ui.theme`. The page checks `bridge.kind`
  and shows a path field instead of the folder picker, and no notification
  controls, when it is `"web"`.
- Ctrl+C disposes the host and the service and stops the server.
