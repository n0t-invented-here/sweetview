# 🥐 Sweetview

Desktop applications for **Bun**. This documentation covers Sweetview 1.0.0.

<img width="400" height="55" alt="DesktopPet-MacOS" src="https://github.com/user-attachments/assets/a77f1b5f-dd96-43cd-a01f-5d46cf5861cc" />

Written in TypeScript. Apps are shipped as one executable.

- [Install](#install)
- [Documentation](#documentation)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Platforms](#platforms)
- [Development](#development)
- [License](#license)

## Install

Requires Bun 1.4.2 or later. A desktop application installs the package and
its optional peer dependency, the native [webview library](docs/webview-library.md):

```bash
bun add @n1h/sweetview @n1h/sweetview-webview-bun
```

Only the root module `@n1h/sweetview` loads the library, when it is
imported. Every other module works without it, so a browser page or a web
server installs the package alone:

```bash
bun add @n1h/sweetview
```

## Documentation

One reference page per module, indexed in the [reference index](docs/README.md).
Each documents every export: signature, parameters, return value, errors,
platform differences and thread rules.

| Module | Contents |
|---|---|
| [`@n1h/sweetview`](docs/app.md) | `createApp`, `WebView` (`WebView.attach`, `WebView.openTab`), native tabs (`Tab`, `TabOptions`), `runEventLoop` and `quitEventLoop`, `windowChromeMethods`, `indexHtml`, `assetMime`, `Ring`, and `RawWebview` from the webview library |
| [`@n1h/sweetview/worker`](docs/worker.md) | `hostService`, `hostRequestHandler` |
| [`@n1h/sweetview/page`](docs/page.md) | `isWebview`, `webviewTransport`, `signalReady` |
| [`@n1h/sweetview/ipc`](docs/ipc.md) | the contract: `defineService`, `createBridge`, `memoryTransport`, the wire frames |
| [`@n1h/sweetview/ipc-ws`](docs/ipc-ws.md) | the contract over WebSockets: `wsHost` for `Bun.serve`, `wsTransport` and `wsUrl` for the browser; each side alone as `/ipc-ws/server` and `/ipc-ws/client` |
| [`@n1h/sweetview/native`](docs/native.md) | unified `Window` / `createWindow` (`Window.fromHandle`, overlays, frames, tabs), `Screen`, `Menu.popup`, `Tray`, `Notifier`, `HitRelay` & hit regions, `pickFolder`, `setAppMenu`, `setAppIcon`, `runEventLoop` / `quitEventLoop`, icon encoders (`dotIco`, `dotPng`, `dotIcns`); the hit-region helpers alone, without FFI, as `/native/hit-regions` |
| [`@n1h/sweetview/settings-store`](docs/settings-store.md) | a JSON settings file in the user's application data folder |
| [`@n1h/sweetview/window-chrome`](docs/window-chrome.md) | a page-drawn title bar and resize handles backed by OS moves and resizes |
| [`@n1h/sweetview/build`](docs/build.md) | `writeIconFiles` and `makeMacApp`; the page also covers the `make-app.ts` script and the `/file-imports` types |
| [the webview library](docs/webview-library.md) | native assets and dynamic requests, transparency, the frames origin, and external drop control |

The workspace publishes six packages. The facade includes the application,
page and worker entry points and re-exports the standalone packages.

| Workspace directory | Package | Facade entry points |
|---|---|---|
| `packages/sweetview` | `@n1h/sweetview` | root, `/page`, `/worker`, `/window-chrome`, `/file-imports` |
| `packages/sweetview-ipc` | `@n1h/sweetview-ipc` | `/ipc` |
| `packages/sweetview-ipc-ws` | `@n1h/sweetview-ipc-ws` | `/ipc-ws`, `/ipc-ws/client`, `/ipc-ws/server` |
| `packages/sweetview-native` | `@n1h/sweetview-native` | `/native`, `/native/hit-regions` |
| `packages/sweetview-settings` | `@n1h/sweetview-settings` | `/settings-store` |
| `packages/sweetview-build` | `@n1h/sweetview-build` | `/build` |

`@n1h/sweetview-ipc-ws` depends on IPC. Native and build helpers depend on settings.

`page`, `window-chrome` and `native/hit-regions` import types only, so a
page bundle contains no Bun code.

## Quickstart

An application has three parts, each importing its own module: the UI
thread, which owns the window; a Worker, which hosts the backend; and the
page. They share one typed contract. Six files and two commands:

1. [Declare the contract in `protocol.ts`](#1-declare-the-contract-in-protocolts)
2. [Write the backend in `service.ts`](#2-write-the-backend-in-servicets)
3. [Host it in `worker.ts`](#3-host-it-in-workerts)
4. [Write the page in `index.html` and `main.ts`](#4-write-the-page-in-indexhtml-and-maints)
5. [Create the window in `app.ts`](#5-create-the-window-in-appts)
6. [Run and compile](#6-run-and-compile)

### 1. Declare the contract in `protocol.ts`

Each method maps its name to a `[params, result]` pair; each event maps its
name to a payload. Both sides import these types and nothing else from here.

```ts
export type Methods = { greet: [{ name: string }, string] };
export type Events = { tick: { count: number } };
```

### 2. Write the backend in `service.ts`

`defineService` takes a setup function that receives `emit` and returns
`{ methods }`, the method handlers. The result knows nothing about windows
or sockets: the same `service` runs behind a window here, and behind a
WebSocket server when hosted with [`wsHost`](docs/ipc-ws.md#wshost).

```ts
import { defineService } from "@n1h/sweetview/ipc";
import type { Events, Methods } from "./protocol";

export const service = defineService<Methods, Events>((emit) => {
  let count = 0;
  setInterval(() => emit("tick", { count: ++count }), 1000);

  return {
    methods: {
      greet: ({ name }) => `Hello, ${name}`,
    },
  };
});
```

### 3. Host it in `worker.ts`

The Worker entry hosts the service on Bun's event loop and carries calls and
events to and from the UI thread.

```ts
import { hostService } from "@n1h/sweetview/worker";
import { service } from "./service";

hostService(service);
```

### 4. Write the page in `index.html` and `main.ts`

An ordinary page. It references its script and stylesheet by relative path;
Bun bundles them when the application is run or compiled. The `<title>`
becomes the window title.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hello</title>
  </head>
  <body>
    <div id="root"></div>
    <p id="tick"></p>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

Browser code. `webviewTransport()` connects the bridge to the window that
hosts the page; the bridge exposes the contract as `rpc` and `on`. A page
that also runs in a browser picks `wsTransport()` when `isWebview()` is
false, and that is the only place it knows the difference.

```ts
import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import type { Events, Methods } from "./protocol";

const bridge = createBridge<Methods, Events>(webviewTransport());

bridge.on("tick", ({ count }) => {
  document.getElementById("tick")!.textContent = `tick ${count}`;
});

document.getElementById("root")!.textContent = await bridge.rpc("greet", { name: "world" });
```

### 5. Create the window in `app.ts`

The UI-thread entry point. `run()` blocks in the OS loop until the window
closes or `quit()` is called.

- `page`: the HTML import. Bun bundles the page's scripts and styles, and
  the host serves every output at the page's own origin.
- `worker`: the worker entry point, as a path relative to the entry script
  `Bun.main`, which is this file. The same path works under `bun run` and
  inside an executable from `bun build --compile`.
- `title` defaults to the page's `<title>`; `assets` adds files the page
  fetches, such as models or images. Windows are created hidden so you can
  wire trays, menus, or bounds before calling `app.window.show()`. All options:
  [`createApp`](docs/app.md#createapp).

```ts
import { createApp } from "@n1h/sweetview";
import index from "./index.html";
import type { Events, Methods } from "./protocol";

const app = await createApp<Methods, Events>({
  page: index,
  worker: "./worker.ts",
});

app.window.show();
app.run();
```

### 6. Run and compile

Run from source; a window titled "Hello" opens:

```bash
bun run app.ts
```

Compile to one executable. The worker is a second entry point, because Bun
does not discover `new Worker` targets on its own:

```bash
bun build --compile --target=bun-windows-x64 app.ts worker.ts --outfile hello.exe
```

## How it works

| Part | Runs | Does |
|---|---|---|
| UI thread | the OS event loop, blocked in `run()` | Owns the window. Serves the page's files at the page's own origin. Answers `uiMethods` such as native dialogs. Forwards every other call to the worker. |
| Worker | Bun's event loop | Hosts the `Service`: the application's methods and events. |
| Page | the webview, or a browser | Calls methods and receives events through a `Bridge`. |

The page and the worker never see each other's transport. In the window, a
call goes page to UI thread to worker and the reply comes back through a
shared-memory ring; in a browser, the same call goes over a WebSocket.

The contract is the same `Methods` and `Events` types on both sides. The
mechanism is described under [Transport](docs/app.md#transport).

Desktop assets and dynamic routes use the browser engine's native interception
with zero TCP. Static files win at `ASSET_ORIGIN`. Set `onRequest: "worker"` on
the webview and use `hostService(service, { onRequest })` or
`hostRequestHandler(onRequest)` for asynchronous routes. Large IPC messages
and binary responses cross the shared ring in chunks. Use `FRAMES_ORIGIN`
for iframe content that needs a different origin from the app page.
[Dynamic requests](docs/app.md#dynamic-requests).

The shell can wait for the page's ready handshake, run modal UI commands on a
later native tick, and hide the last window to the tray. A shared app identity
ties settings, packaging and native URL activation together. The native package
also provides clipboard, bounded and chunked file reads, and OS file drops.
[Startup and deferred UI](docs/app.md#startup-and-deferred-ui), [native APIs](docs/native.md).

The loop can instead be run from a Bun timer with `runEventLoop`, which keeps
Bun's event loop alive on the UI thread, so an app needs no worker and a
menu-bar app needs no window; [The event loop](docs/app.md#the-event-loop)
explains both ways and when to use which.

## Platforms

| | Windows x64 | macOS arm64 | Linux x64 |
|---|---|---|---|
| Window, asset serving, transparency, native tabs | yes | yes | no: `WebView.attach` / `createApp` throws |
| `native` (window, screen, popup menu, tray, notifications, folder picker, app menu, event loop) | yes | yes | throws on first call; icons and hit regions work |
| Build host that can embed the Windows exe file icon | yes | no, Bun's stock icon | no, Bun's stock icon |

- Bun accepts `--windows-icon` only on a Windows host; the demos pass it
  only there.
- The macOS `.app` bundle is assembled on any OS by `makeMacApp` or
  the [`make-app` command](docs/build.md#make-app-command-line), and signed
  ad-hoc when assembled on macOS. macOS shows no notifications from an unsigned
  bundle, or from one in a temporary folder.
- On a Mac that reports a copied bundle as damaged, these commands remove the
  quarantine flag, restore the executable bit and add an ad-hoc signature:

```bash
xattr -dr com.apple.quarantine "App.app"
chmod +x "App.app/Contents/MacOS/"*
codesign --sign - --force --deep "App.app"
```

## Development

| Path | Contents |
|---|---|
| `packages/` | the Sweetview facade, IPC, WebSocket transport, native helpers, settings and build packages |
| `docs/` | the reference pages, indexed by the [reference index](docs/README.md) |
| `demos/web-app/` | one backend and one React page run two ways: a desktop window with tray and notifications, or `Bun.serve` with WebSockets |
| [`demos/desktop-pet/`](demos/desktop-pet/README.md) | a transparent always-on-top pet rendered with Babylon.js, with click-through hit regions and a page-drawn settings window |
| [`demos/menubar-only/`](demos/menubar-only/README.md) | a menu-bar app with no window, no webview and no worker: a status item, its menu and a tooltip clock on a plain `setInterval`, on `runEventLoop` |
| [`demos/menubar-notify/`](demos/menubar-notify/README.md) | a menu-bar app whose menu sends a system notification now or five seconds later, with a window listing what was sent and clicked; a notification click opens it |
| [`demos/native-tabs/`](demos/native-tabs/README.md) | tabs with one webview per tab. macOS: every tab is its own `NSWindow` hosting its own `WKWebView`, behind the tab bar AppKit draws. Windows: a window whose title bar is a tab strip, every tab a child window hosting its own `WebView2` |
| [`webview/`](webview/README.md) | recipes that clone the webview-bun fork, with the webview fork as its submodule, and build the library from it, for working on the library itself; not needed to build the demos |

Bun links the packages and demos through the root workspace. The `paths`
mapping in `tsconfig.json` mirrors the package entry points for typechecking.

Recipes run with [just](https://github.com/casey/just) and PowerShell 7,
from the repository root:

| Recipe | Does |
|---|---|
| `just check` | `tsc --noEmit` over `packages/` and `demos/`, then `bun test` |
| `just demos web-app serve` | the web build on `http://127.0.0.1:4747` (`PORT`, `HOST`) |
| `just demos web-app app`, `just demos desktop-pet app`, `just demos menubar-only app`, `just demos menubar-notify app`, `just demos native-tabs app` | the desktop application from source, with `bun run` (`WEBVIEW_DEBUG=1` opens devtools) |
| `just demos web-app compile`, `just demos desktop-pet compile`, `just demos menubar-only compile`, `just demos menubar-notify compile` | Windows exe, macOS arm64 binary and `.app` into each demo's `dist/` |
| `just compile`, `just clean` | every demo that has that recipe (`native-tabs` has no `compile`) |
| `just pack` | what `bun publish` would upload for each of the six packages |
| `just publish` | publishes all six packages in dependency order, with a registry login |

## License

This software is available under either the [MIT License](LICENSE)
or the [BSD Zero Clause License (0BSD)](LICENSE-0BSD),
at your option.
