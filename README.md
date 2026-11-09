# 🥐 Sweetview

Desktop applications for **Bun**.

<img width="400" height="55" alt="DesktopPet-MacOS" src="https://github.com/user-attachments/assets/a77f1b5f-dd96-43cd-a01f-5d46cf5861cc" />

Written in TypeScript. Apps are shipped as one executable.

`@n1h/sweetview` is one package with a module per part. This
repository is that package; `demos/` holds two applications built on it.

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
| [`@n1h/sweetview`](docs/app.md) | `createWebviewApp`: the window, the page, assets, the transport between page, UI thread and worker; `indexHtml`, `assetMime`, `Ring`, and `Webview` from the webview library |
| [`@n1h/sweetview/worker`](docs/worker.md) | `hostService` |
| [`@n1h/sweetview/page`](docs/page.md) | `isWebview`, `webviewTransport` |
| [`@n1h/sweetview/ipc`](docs/ipc.md) | the contract: `defineService`, `createBridge`, `memoryTransport`, the wire frames |
| [`@n1h/sweetview/ipc-ws`](docs/ipc-ws.md) | the contract over WebSockets: `wsHost` for `Bun.serve`, `wsTransport` and `wsUrl` for the browser; each side alone as `/ipc-ws/server` and `/ipc-ws/client` |
| [`@n1h/sweetview/native`](docs/native.md) | tray, notifications, windows and overlays, click-through hit regions, folder picker, app menu, icons; the hit-region helpers alone, without FFI, as `/native/hit-regions` |
| [`@n1h/sweetview/settings-store`](docs/settings-store.md) | a JSON settings file in the user's application data folder |
| [`@n1h/sweetview/window-chrome`](docs/window-chrome.md) | a page-drawn title bar and resize handles backed by OS moves and resizes |
| [`@n1h/sweetview/build`](docs/build.md) | `writeIconFiles` and `makeMacApp`; the page also covers the `make-app.ts` script and the `/file-imports` types |
| [the webview library](docs/webview-library.md) | the two C API additions the package relies on, and how the library is loaded |

Dependencies between the modules point one way. `ipc` imports nothing.
`ipc-ws`, `worker` and `page` import `ipc`. `native`, `settings-store` and
`build` import nothing else in the package. The root module imports `ipc`,
`native`, `window-chrome` and the webview library.

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
  fetches, such as models or images. All options:
  [`createWebviewApp`](docs/app.md#createwebviewapp).

```ts
import { createWebviewApp } from "@n1h/sweetview";
import index from "./index.html";
import type { Events, Methods } from "./protocol";

const app = await createWebviewApp<Methods, Events>({
  page: index,
  worker: "./worker.ts",
});

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

## Platforms

| | Windows x64 | macOS arm64 | Linux x64 |
|---|---|---|---|
| Window, asset serving, transparency | yes | yes | no: `createWebviewApp` throws |
| `native` (tray, notifications, overlays, folder picker, app menu) | yes | yes | throws on first call; icons and hit regions work |
| Build host that can embed the Windows exe file icon | yes | no, Bun's stock icon | no, Bun's stock icon |

- Bun accepts `--windows-icon` only on a Windows host; the demos pass it
  only there.
- The macOS `.app` bundle is assembled on any OS by `makeMacApp` or
  `src/make-app.ts`. It is unsigned.
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
| `src/` | the package: `ipc/`, `ipc-ws/`, `native/`, and at the top level the window host, `worker`, `page`, `settings-store`, `window-chrome`, `build` and the `make-app.ts` command line |
| `docs/` | the reference pages, indexed by the [reference index](docs/README.md) |
| `demos/web-app/` | one backend and one React page run two ways: a desktop window with tray and notifications, or `Bun.serve` with WebSockets |
| [`demos/desktop-pet/`](demos/desktop-pet/README.md) | a transparent always-on-top pet rendered with Babylon.js, with click-through hit regions and a page-drawn settings window |
| [`webview/`](webview/README.md) | recipes that clone the webview-bun fork, with the webview fork as its submodule, and build the library from it, for working on the library itself; not needed to build the demos |

Inside this repository `@n1h/sweetview` resolves to `src/` through the
`paths` mapping in `tsconfig.json`, which Bun honours at run time and in
`bun build`.

Recipes run with [just](https://github.com/casey/just) and PowerShell 7,
from the repository root:

| Recipe | Does |
|---|---|
| `just check` | `tsc --noEmit` over `src/` and `demos/`, then `bun test` |
| `just demos web-app serve` | the web build on `http://127.0.0.1:4747` (`PORT`, `HOST`) |
| `just demos web-app app`, `just demos desktop-pet app` | the desktop application from source, with `bun run` (`WEBVIEW_DEBUG=1` opens devtools) |
| `just demos web-app compile`, `just demos desktop-pet compile` | Windows exe, macOS arm64 binary and `.app` into each demo's `dist/` |
| `just compile`, `just clean` | both demos |
| `just pack` | what `bun publish` would upload |
| `just publish` | publishes `@n1h/sweetview`; needs a registry login |

## License

This software is available under either the [MIT License](LICENSE)
or the [BSD Zero Clause License (0BSD)](LICENSE-0BSD),
at your option.
