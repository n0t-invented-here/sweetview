# 🥐 Sweetview

Desktop applications for **Bun**. This documentation covers Sweetview 1.0.0.

<img width="400" height="55" alt="DesktopPet-MacOS" src="https://github.com/user-attachments/assets/a77f1b5f-dd96-43cd-a01f-5d46cf5861cc" />

Written in TypeScript, with a Rust native layer reached through N-API on
Windows (macOS calls the OS through `bun:ffi` until the macOS goal of the
Rust rewrite). Apps are shipped as one executable.

- [Install](#install)
- [Documentation](#documentation)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Platforms](#platforms)
- [Development](#development)
- [License](#license)

## Install

Requires Bun 1.4.2 or later.

> **1.0.0 is not on npm yet.** It lives on the `v1-rust-rewrite` branch of this
> repository. npm's `latest` for `@n1h/sweetview` is `0.2.1`, which has no
> `createApp` and little of what these pages document, and the seven
> standalone workspace packages (`@n1h/sweetview-ipc`, `-ipc-ws`,
> `-ipc-electron`, `-ipc-tauri`, `-native`, `-settings`, `-build`) are not
> published at all. A plain
> `bun add @n1h/sweetview` installs 0.2.1. Until 1.0.0 is released, use it
> from source.

### From source

Clone the repository on `v1-rust-rewrite` and install the workspace:

```bash
git clone https://github.com/n0t-invented-here/sweetview.git
cd sweetview
git checkout v1-rust-rewrite
bun install
just native build        # Windows: builds the Rust binding (needs the Rust toolchain)
just demos web-app app   # optional: a demo opens in a window
```

On Windows the native layer is a Rust binding,
`packages/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node`. A clone
does not contain it, because it is built from source: `just native build`
compiles the crates under `crates/` into that folder and regenerates its
TypeScript declarations ([Rebuilding](docs/webview-library.md#rebuilding)).
That needs the Rust toolchain, installed with [rustup](https://rustup.rs)
(on Windows it also asks for the Visual Studio C++ build tools); the recipe
says so when `cargo` is missing. The recipes that run code build the binding
first, so `just demos web-app app`, the other demos' `app`, `compile` and
`drive` recipes that load it, and `just test` work on a fresh clone; when it is current the build
is cargo's no-op. Running a script directly (`bun run app.ts`, `bun test`)
does not build it, and fails with a message that says what to run. On macOS,
until the macOS goal of the Rust rewrite, the webview comes from
`@n1h/sweetview-webview-bun` instead and no Rust build is needed.

Every folder under `demos/` is a workspace member, so an app of your own
goes in a new folder there and links the packages from the checkout. Create
`demos/hello/package.json`:

```json
{
  "name": "hello",
  "private": true,
  "type": "module",
  "dependencies": {
    "@n1h/sweetview": "workspace:*"
  }
}
```

On macOS, also add `"@n1h/sweetview-webview-bun": "^2.7.0"` to its
`dependencies`. Run `bun install` again at the repository root, then follow
the [Quickstart](#quickstart) inside `demos/hello/`.

An application in its own repository that depends on `@n1h/sweetview`
`^1.0.0` runs against the checkout instead: `just link` here, then
`just link-sweetview` there, with no path typed on either side
([Running an application against a local Sweetview checkout](docs/local-checkout.md)).

### From npm, once 1.0.0 is published

Name the major version, so the command cannot fall back to 0.2.1. On
Windows a desktop application installs the package alone: the native
binding, WebView2 driven by Rust, ships inside `@n1h/sweetview-native`, which
`@n1h/sweetview` depends on.

```bash
bun add @n1h/sweetview@^1.0.0
```

On macOS, until the macOS goal of the Rust rewrite, a desktop application
also installs the optional peer dependency that holds the native
[webview library](docs/webview-library.md):

```bash
bun add @n1h/sweetview@^1.0.0 @n1h/sweetview-webview-bun
```

On macOS only the root module `@n1h/sweetview` (and the `RawWebview` class
and input hooks of the native module) load that library. Every other module
works without it, so a browser page, a web server or a tray-only app
installs `@n1h/sweetview` alone on either OS.

`SWEETVIEW_NATIVE_PATH` names a custom build of the Rust binding (a `.node`
file); it is read once, when the binding first loads. On Windows it replaces
`WEBVIEW_PATH`, which has no effect there; see
[Upgrading](docs/upgrading.md).

### The webview library version on macOS

On macOS the peer range is `^2.7.0`. A 2.7.0 library runs windows, bundled
pages, assets, transparency, tabs and IPC. Four features need the additions
that arrive with `@n1h/sweetview-webview-bun` 2.8.0, which the range
accepts: dynamic requests (`onRequest`), streamed worker responses,
`allowExternalDrop`, and file drops onto the webview (`Window.onFileDrop`
over a page). Sweetview checks for each one separately when it is used: a
missing request symbol throws with instructions, missing streaming symbols
fall back to buffered responses, and the drop features log a warning or fall
back to drops on the native window. Until 2.8.0 is published, set
`WEBVIEW_PATH` to a library built from the `v1-drafting` branches; see
[the webview library](docs/webview-library.md#where-it-comes-from). On
Windows the Rust binding has all four.

## Documentation

One reference page per module, indexed in the [reference index](docs/README.md).
The native module has an overview page and seven topic guides. The pages
document each export's signature, parameters, return value, errors,
platform differences and thread rules.

| Module | Contents |
|---|---|
| [`@n1h/sweetview`](docs/app.md) | `createApp`, `WebView` (`WebView.attach`, `WebView.openTab`), native tabs (`Tab`, `TabOptions`), `runEventLoop` and `quitEventLoop`, `windowChromeMethods`, `indexHtml`, `assetMime`, `Ring`, and the low-level webview class `RawWebview` |
| [`@n1h/sweetview/worker`](docs/worker.md) | `hostService`, `hostRequestHandler` |
| [`@n1h/sweetview/page`](docs/page.md) | `isWebview`, `webviewTransport`, `signalReady` |
| [`@n1h/sweetview/ipc`](docs/ipc.md) | the contract: `defineService`, `createBridge`, `memoryTransport`, the wire frames |
| [`@n1h/sweetview/ipc-ws`](docs/ipc-ws.md) | the contract over WebSockets: `wsHost` for `Bun.serve`, `wsTransport` and `wsUrl` for the browser; each side alone as `/ipc-ws/server` and `/ipc-ws/client` |
| [`@n1h/sweetview/ipc-electron`](docs/ipc-electron.md) | the contract over Electron IPC: `electronHost` for the main process, `exposeSweetviewIpc` for the preload, `electronTransport` for the page; each alone as `/ipc-electron/server`, `/ipc-electron/preload` and `/ipc-electron/client` |
| [`@n1h/sweetview/ipc-tauri`](docs/ipc-tauri.md) | the contract in a Tauri 2 webview: `tauriTransport` for the page (also as `/ipc-tauri/client`), and the frame protocol a Rust backend implements |
| [`@n1h/sweetview/native`](docs/native.md) | overview, then guides: [windows and screens](docs/native/windows.md), [overlays and hit regions](docs/native/overlays-and-hit-regions.md), [menus and the tray](docs/native/menus-and-tray.md), [notifications](docs/native/notifications.md), [activation and single instance](docs/native/activation-and-single-instance.md), [dialogs, clipboard and files](docs/native/dialogs-clipboard-files.md), [event loop and icons](docs/native/event-loop-and-icons.md); the hit-region helpers alone, without FFI, as `/native/hit-regions` |
| [`@n1h/sweetview/settings-store`](docs/settings-store.md) | a JSON settings file in the user's application data folder, and the shared app identity (`defineAppIdentity`) |
| [`@n1h/sweetview/window-chrome`](docs/window-chrome.md) | a page-drawn title bar and resize handles backed by OS moves and resizes |
| [`@n1h/sweetview/build`](docs/build.md) | `writeIconFiles`, `makeMacApp` and `refreshWindowsIcons`; the page also covers the `make-app.ts` script and the `/file-imports` types |
| [the webview](docs/webview-library.md) | what the webview is on each OS (WebView2 through the Rust binding on Windows, the C++ webview library on macOS), native assets and dynamic requests, transparency, the frames origin, and external drop control |

The workspace publishes eight packages. The facade includes the application,
page and worker entry points and re-exports the standalone packages.

| Workspace directory | Package | Facade entry points |
|---|---|---|
| `packages/sweetview` | `@n1h/sweetview` | root, `/page`, `/worker`, `/window-chrome`, `/file-imports` |
| `packages/sweetview-ipc` | `@n1h/sweetview-ipc` | `/ipc` |
| `packages/sweetview-ipc-ws` | `@n1h/sweetview-ipc-ws` | `/ipc-ws`, `/ipc-ws/client`, `/ipc-ws/server` |
| `packages/sweetview-ipc-electron` | `@n1h/sweetview-ipc-electron` | `/ipc-electron`, `/ipc-electron/client`, `/ipc-electron/preload`, `/ipc-electron/server` |
| `packages/sweetview-ipc-tauri` | `@n1h/sweetview-ipc-tauri` | `/ipc-tauri`, `/ipc-tauri/client` |
| `packages/sweetview-native` | `@n1h/sweetview-native` | `/native`, `/native/hit-regions` |
| `packages/sweetview-settings` | `@n1h/sweetview-settings` | `/settings-store` |
| `packages/sweetview-build` | `@n1h/sweetview-build` | `/build` |

`@n1h/sweetview-ipc-ws`, `-ipc-electron` and `-ipc-tauri` depend on IPC. Native and build helpers depend on settings.

`page`, `window-chrome`, `native/hit-regions`, `ipc-ws/client`,
`ipc-electron/client` and `ipc-tauri/client` import types only, so a page
bundle contains no Bun code.

## Quickstart

An application has three parts, each importing its own module: the UI
thread, which owns the window; a Worker, which hosts the backend; and the
page. They share one typed contract. Six files and two commands. Until 1.0.0
is published, create the files in `demos/hello/` of a source checkout
([From source](#from-source)) and run the commands there:

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
import { signalReady, webviewTransport } from "@n1h/sweetview/page";
import type { Events, Methods } from "./protocol";

const bridge = createBridge<Methods, Events>(webviewTransport());

bridge.on("tick", ({ count }) => {
  document.getElementById("tick")!.textContent = `tick ${count}`;
});

document.getElementById("root")!.textContent = await bridge.rpc("greet", { name: "world" });
signalReady(); // the page has rendered: the window appears now
```

### 5. Create the window in `app.ts`

The UI-thread entry point. `run()` blocks in the OS loop until the window
closes or `quit()` is called. It is the last line: nothing after `run()` is
needed. The process then ends by itself, and as it ends Sweetview releases
the window, the webview and its worker, and anything else it made (trays,
notifiers, hooks), leaving the notifications it showed for the user to read
([the end of the application](docs/app.md#the-end-of-the-application)). That
is Windows; on macOS, until the macOS goal of the Rust rewrite, dispose what
you made and call `process.exit()` after `run()`, as before 1.0.

- `page`: the HTML import. Bun bundles the page's scripts and styles, and
  the host serves every output at the page's own origin.
- `worker`: the worker entry point, as a path relative to the entry script
  `Bun.main`, which is this file. The same path works under `bun run` and
  inside an executable from `bun build --compile`.
- `title` defaults to the page's `<title>`; `assets` adds files the page
  fetches, such as models or images. Windows are created hidden; with
  `showOnReady: true` the window appears when the page calls `signalReady()`
  (or the ready watchdog fires), so it never shows a blank frame. All options:
  [`createApp`](docs/app.md#createapp).

```ts
import { createApp } from "@n1h/sweetview";
import index from "./index.html";
import type { Events, Methods } from "./protocol";

const app = await createApp<Methods, Events>({
  page: index,
  worker: "./worker.ts",
  showOnReady: true,
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

`run()` blocks the UI thread inside the OS loop, so Bun's event loop does not
turn there: an app that uses `run()` needs a worker for any asynchronous
logic. The loop can instead be run from a Bun timer with `runEventLoop`,
which keeps Bun's event loop alive on the UI thread. There the worker is
optional, and a menu-bar app needs no window, page or worker at all.
Tabbed apps always use `runEventLoop`.
[The event loop](docs/app.md#the-event-loop) explains both ways and when to
use which.

## Platforms

Sweetview targets Windows and macOS. Some modules are pure TypeScript and
run wherever Bun runs:

| | Windows x64 | macOS arm64 | Other OSes Bun runs on |
|---|---|---|---|
| Window, asset serving, transparency, native tabs (`WebView.attach`, `createApp`) | yes | yes | no: throws before creating anything |
| Native OS entry points in `native` (`Window`, `Screen`, `Menu.popup`, `Tray`, `Notifier`, `pickFolder`, `Clipboard`, `setAppMenu`, `setAppIcon`, `runEventLoop`, `singleInstance`, ...) | yes | yes | importing works; the first call throws |
| Pure TypeScript: icon encoders and PNG decoder, hit-region geometry, menu templates, file-read helpers, IPC, WebSocket IPC, settings, app identity, build helpers | yes | yes | yes |
| Build host that can embed the Windows exe file icon and name | yes | no, Bun's stock icon and name | no, Bun's stock icon and name |

- Bun accepts `--windows-icon`, and writes the version information of
  `--windows-title` and `--windows-description`, only on a Windows host; the
  demos pass them only there, so a Windows executable built on a Mac has
  Bun's stock icon and is named "Bun" where one built on Windows carries
  the demo's name.
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
| `packages/` | the Sweetview facade, IPC, the WebSocket, Electron and Tauri transports, native helpers, settings and build packages |
| `crates/` | the Rust native layer on Windows (`tao`, `wry`, `muda`, `tray-icon` and `rfd` behind this project's own crates), compiled by `just native build` into the N-API binding `@n1h/sweetview-native` loads |
| `docs/` | the reference pages, indexed by the [reference index](docs/README.md) |
| [`demos/web-app/`](demos/web-app/README.md) | one backend and one React page run two ways: a desktop window with tray and notifications, or `Bun.serve` with WebSockets |
| [`demos/web-app-electron/`](demos/web-app-electron/README.md) | the web-app page unchanged in an Electron shell, its service in the main process |
| [`demos/web-app-tauri/`](demos/web-app-tauri/README.md) | the web-app page unchanged in a Tauri 2 shell, answered by a Rust backend |
| [`demos/desktop-pet/`](demos/desktop-pet/README.md) | a transparent always-on-top pet rendered with Babylon.js, with click-through hit regions and a page-drawn settings window |
| [`demos/menubar-only/`](demos/menubar-only/README.md) | a menu-bar app with no window, no webview and no worker: a status item, its menu and a tooltip clock on a plain `setInterval`, on `runEventLoop` |
| [`demos/menubar-notify/`](demos/menubar-notify/README.md) | a menu-bar app whose menu sends a system notification now or five seconds later, with a window listing what was sent and clicked; a notification click opens it |
| [`demos/native-tabs/`](demos/native-tabs/README.md) | tabs with one webview per tab. macOS: every tab is its own `NSWindow` hosting its own `WKWebView`, behind the tab bar AppKit draws. Windows: a window whose title bar is a tab strip, every tab a child window hosting its own `WebView2` |
| [`webview/`](webview/README.md) | recipes that clone the webview-bun fork, with the webview fork as its submodule, and build the library from it, for working on the library macOS uses; not needed to build the demos |

Bun links the packages and demos through the root workspace. The `paths`
mapping in `tsconfig.json` mirrors the package entry points for typechecking.

Recipes run with [just](https://github.com/casey/just) and PowerShell 7,
from the repository root:

| Recipe | Does |
|---|---|
| `just native build` | builds the Rust binding for this machine into `packages/sweetview-native/prebuilt/` and regenerates its `binding.d.ts`; needs the Rust toolchain (rustup). The recipes below that run code on Windows run it first |
| `just test` | on Windows `just native build`, then `bun test` |
| `just check` | `just native build`, then `tsc --noEmit` over `packages/` and `demos/`, then `bun test` |
| `just demos web-app serve` | the web build on `http://127.0.0.1:4747` (`PORT`, `HOST`) |
| `just demos web-app app`, `just demos desktop-pet app`, `just demos menubar-only app`, `just demos menubar-notify app`, `just demos native-tabs app` | the desktop application from source, with `bun run` (`WEBVIEW_DEBUG=1` opens devtools); on Windows the binding is built first |
| `just demos web-app compile`, `just demos desktop-pet compile`, `just demos menubar-only compile`, `just demos menubar-notify compile` | Windows exe (with the binding, built first, embedded), macOS arm64 binary and `.app` into each demo's `dist/` |
| `just demos web-app-electron app`, `just demos web-app-tauri app` | the web-app page in an Electron or a Tauri 2 shell; `probe` instead of `app` records what the page shows and quits |
| `just compile`, `just clean` | every demo that has that recipe (`native-tabs`, `web-app-electron` and `web-app-tauri` have no `compile`) |
| `just link`, `just unlink` | `just native build`, then registers the eight packages with `bun link` for an application elsewhere to run against ([local checkout](docs/local-checkout.md)); `unlink` removes the registrations |
| `just pack` | `just native build`, then what `bun publish` would upload for each of the eight packages |
| `just publish` | `just native build`, then publishes all eight packages in dependency order, with a registry login |

## License

This software is available under either the [MIT License](LICENSE)
or the [BSD Zero Clause License (0BSD)](LICENSE-0BSD),
at your option.
