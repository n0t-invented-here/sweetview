# Web App in Electron

The [web-app demo](../web-app/README.md)'s page and service in an Electron
shell. The page is the same source as in the Sweetview window and the
browser: its [`bridge.ts`](../web-app/packages/web-app-frontend/src/bridge.ts)
picks `electronTransport()` because the preload exposed `window.sweetviewIpc`.
The service is the same `createService()` from
[`web-app-backend`](../web-app/packages/web-app-backend/src/index.ts), running
in Electron's main process.

| Recipe | Does |
|---|---|
| `just demos web-app-electron app` | Builds the page, the main process and the preload, and opens the window. The first run downloads the Electron binary. |
| `just demos web-app-electron probe` | The same, with `WEB_APP_PROBE=1`: logs every call and event the host sees, records what the page shows as one `PROBE {...}` line on stdout, and quits. |
| `just demos web-app-electron clean` | Removes `build/`. |

Run the recipes from the repository root after `bun install`. `electron` is
this demo's devDependency.

## How it is put together

| Path | Is |
|---|---|
| [`main.ts`](main.ts) | The main process: hosts the service with [`electronHost`](../../docs/ipc-electron.md#electronhost), serves the built page from `app://web-app/`, and opens the window with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. Bundled to `build/main.cjs` for Node, which `package.json`'s `main` names, so the shell runs `electron .`. |
| [`preload.ts`](preload.ts) | The preload: [`exposeSweetviewIpc`](../../docs/ipc-electron.md#exposesweetviewipc), which gives the page `send` and `onMessage` and nothing of `ipcRenderer`. Bundled to `build/preload.cjs`. |
| [`scripts/write-icon.ts`](scripts/write-icon.ts) | Writes the window icon, the web-app demo's sparkle tile, to `build/icon.ico`. |
| [`../web-app/scripts/shell-probe.js`](../web-app/scripts/shell-probe.js) | What `probe` evaluates in the page: it reads the Runtime card (the `info.get` reply), adds a note through the form, and waits for it to appear, which the page renders only from the `notes.changed` event. |

What works as in the browser: notes (shared, with `notes.changed`), runtime
info, and folder watching (type a path; changes arrive as `fs.change`
events). The folder picker, the tray and system notifications are the
Sweetview desktop app's; the page hides them here, as it does in a browser.
