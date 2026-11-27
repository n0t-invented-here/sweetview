# @n1h/sweetview/ipc-electron

The [`ipc`](ipc.md) contract over Electron's IPC, so a `Service` running in Electron's main process reaches a page in a `BrowserWindow`. Three modules, one per process: `@n1h/sweetview/ipc-electron/server` runs in the main process and hosts the service, `@n1h/sweetview/ipc-electron/preload` runs in the window's preload script and exposes a two-function API to the page, and `@n1h/sweetview/ipc-electron/client` runs in the page and provides its `Transport`. `@n1h/sweetview/ipc-electron` re-exports all three, and the standalone package is `@n1h/sweetview-ipc-electron`. None of the modules imports `electron`: the main process passes its `ipcMain`, and the preload its `contextBridge` and `ipcRenderer`, so the package has no dependency on an Electron version and its tests run under plain `bun test`. None uses a Bun API, because Electron's main process and preload run on Node and Chromium.

- [Example](#example)
- [Host: `@n1h/sweetview/ipc-electron/server`](#host-n1hsweetviewipc-electronserver)
  - [electronHost](#electronhost)
- [Preload: `@n1h/sweetview/ipc-electron/preload`](#preload-n1hsweetviewipc-electronpreload)
  - [exposeSweetviewIpc](#exposesweetviewipc)
  - [createSweetviewIpcApi](#createsweetviewipcapi)
- [Page: `@n1h/sweetview/ipc-electron/client`](#page-n1hsweetviewipc-electronclient)
  - [electronTransport](#electrontransport)
  - [isElectron](#iselectron)
- [Wire protocol](#wire-protocol)
- [Bundling](#bundling)

## Example

The main process, the preload and the page, sharing one contract. Electron
runs neither TypeScript nor Bun, so each of the three is bundled first
([Bundling](#bundling)). [`demos/web-app-electron`](../demos/web-app-electron/README.md)
is a complete application built this way.

```ts
// protocol.ts
export type Methods = { ping: [void, "pong"] };
export type Events = { tick: { count: number } };
```

```ts
// main.ts, the main process
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { defineService } from "@n1h/sweetview/ipc";
import { electronHost } from "@n1h/sweetview/ipc-electron/server";
import type { Events, Methods } from "./protocol";

const service = defineService<Methods, Events>((emit) => {
  let count = 0;
  const timer = setInterval(() => emit("tick", { count: ++count }), 1000);
  return { methods: { ping: () => "pong" }, dispose: () => clearInterval(timer) };
});

app.whenReady().then(() => {
  const host = electronHost(service, ipcMain);
  const win = new BrowserWindow({
    webPreferences: {
      preload: join(app.getAppPath(), "build", "preload.cjs"),
      contextIsolation: true, // the defaults, written out
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(join(app.getAppPath(), "build", "index.html"));
  app.on("window-all-closed", async () => {
    host.dispose();          // ends every session
    await service.dispose(); // the host never disposes the service
    app.quit();
  });
});
```

```ts
// preload.ts
import { contextBridge, ipcRenderer } from "electron";
import { exposeSweetviewIpc } from "@n1h/sweetview/ipc-electron/preload";

exposeSweetviewIpc({ contextBridge, ipcRenderer }); // window.sweetviewIpc
```

```ts
// page.ts
import { createBridge } from "@n1h/sweetview/ipc";
import { electronTransport } from "@n1h/sweetview/ipc-electron/client";
import type { Events, Methods } from "./protocol";

const bridge = createBridge<Methods, Events>(electronTransport());
bridge.on("tick", ({ count }) => (document.title = `tick ${count}`));
void bridge.rpc("ping").then((pong) => (document.body.textContent = pong));
```

A page that also runs in a Sweetview window, a browser or Tauri picks its
transport in one line ([Transports](ipc.md#transports)); the rest of the page
is unchanged.

## Host: `@n1h/sweetview/ipc-electron/server`

Runs in Electron's main process (Node). Its types are structural: `IpcMainLike`, `IpcMainEventLike` and `WebContentsLike` are the parts of Electron's `ipcMain`, `IpcMainEvent` and `WebContents` it uses, so Electron's own objects fit them.

```ts
import { electronHost, type ElectronHost, type ElectronHostOptions } from "@n1h/sweetview/ipc-electron/server";
```

### electronHost

`electronHost<M, E>(service: Service<M, E>, ipcMain: IpcMainLike, options?: ElectronHostOptions): ElectronHost`

Hosts a `Service` on `ipcMain`. It listens on the `sweetview-ipc` and `sweetview-ipc:hello` channels as soon as it is called and subscribes to the service's events until `dispose()`. One host serves every window. The host never calls `service.dispose()`; the application disposes the service after `host.dispose()`.

```ts
type ElectronHost = {
  readonly sessions: number;
  sessionOf(webContents: WebContentsLike): Session | undefined;
  dispose(): void;
};

type ElectronHostOptions = {
  allowSender?: (event: IpcMainEventLike) => boolean;
};
```

| Member | Meaning |
|---|---|
| `sessions` | Number of `webContents` with a live session. |
| `sessionOf(webContents)` | The session currently assigned to that `webContents`, or `undefined`. |
| `dispose()` | Stops listening on both channels, stops forwarding events, and ends every session (`service.endSession` once each). Replies to calls still running are dropped. It does not dispose the service. Safe to call twice. |
| `allowSender` (option) | Decides per message whether the sender is served; a refused message is dropped without a reply. Default: every sender. Only pages whose window loads a preload that calls `exposeSweetviewIpc` can send on the channel at all. |

Sessions:

- A session belongs to one page load in one `webContents`. Its `id` is `electron-<n>`, counting from 1 per host; its `kind` is `"electron"`.
- The preload sends `sweetview-ipc:hello` once per page load. The host then assigns a new session to that `webContents`. When the `webContents` already had one (a reload or a navigation), the old session ends first, so `endSession` drops what the old page held.
- A call from a `webContents` the host has not seen (the host was created after the page loaded) assigns its session on that first call.
- When the `webContents` is destroyed (its window closed), its session ends.

## Preload: `@n1h/sweetview/ipc-electron/preload`

Runs in the window's preload script, which Electron runs before the page in an isolated world. It works with `sandbox: true`, because it needs nothing but `contextBridge` and `ipcRenderer`.

```ts
import { createSweetviewIpcApi, exposeSweetviewIpc, type SweetviewIpcApi } from "@n1h/sweetview/ipc-electron/preload";
```

### exposeSweetviewIpc

`exposeSweetviewIpc(electron: { contextBridge; ipcRenderer }, key = "sweetviewIpc"): void`

Exposes the page API as `window[key]` through `contextBridge.exposeInMainWorld`, then sends `sweetview-ipc:hello` so the host starts a session for this page load. The page gets two functions and nothing else; `ipcRenderer` itself never reaches it:

```ts
type SweetviewIpcApi = {
  send(text: string): void;                          // one JSON frame to the main process
  onMessage(fn: (text: string) => void): () => void; // JSON frames from the main process; returns unsubscribe
};
```

`send` throws a `TypeError` when `text` is not a string, so the page cannot use it to send structured values. `onMessage` ignores messages on the channel that are not strings.

### createSweetviewIpcApi

`createSweetviewIpcApi(ipcRenderer: IpcRendererLike): SweetviewIpcApi`

Builds the same API without exposing it. `exposeSweetviewIpc` uses it; call it directly only in a window with `contextIsolation: false`, and assign the result to `window.sweetviewIpc` yourself.

## Page: `@n1h/sweetview/ipc-electron/client`

Runs in the page. It imports types only from `@n1h/sweetview/ipc` and the channel names, so a page bundle contains no Bun, Node or Electron code.

```ts
import { electronTransport, isElectron, type ElectronTransport } from "@n1h/sweetview/ipc-electron/client";
```

### electronTransport

`electronTransport(api: SweetviewIpcApi = window.sweetviewIpc): ElectronTransport`

Returns a `Transport` over the preload's API, with `kind` set to `"electron"`. Pass `window[key]` when the preload used another `key`. Throws `Error("not running inside Electron with the sweetview preload")` when `api` is missing or lacks `send` and `onMessage`.

`ElectronTransport` is the [`Transport`](ipc.md#transport) plus `dispose()`, which stops listening, rejects every pending call with `Error("transport disposed")`, and makes later calls reject with `Error("<method>: transport disposed")` and later `notify` calls do nothing. Safe to call twice. The transport does not end the session; the next page load or the window's close does.

- `call` rejects with an `Error` carrying the backend's message when the reply has `ok: false`, including `unknown method <name>`.
- `call` rejects with the `JSON.stringify` error when `params` cannot be serialised as JSON.
- `call` never times out: a call whose reply never comes (the host refused the sender, or was disposed) stays pending until `dispose()`.
- `notify` sends `seq: null`, wire-level fire and forget. It never throws; a `params` value JSON cannot carry is logged as `<method> not sent: <message>`.
- Several transports on one page share one `seq` counter, so each one's replies reach only its own calls. Every transport receives every event.
- Events received while no `onEvent` listener is subscribed are dropped.

### isElectron

`isElectron(key = "sweetviewIpc"): boolean`

True when `window[key]` is the preload's API, which is how a page that runs in several hosts picks this transport.

## Wire protocol

Each frame from [`ipc.md`](ipc.md#wire-format) crosses Electron IPC as one JSON string, `JSON.stringify(frame)`, on the channel `sweetview-ipc`: from the page with `ipcRenderer.send`, from the main process with `webContents.send`. Sending JSON text rather than objects keeps the values exactly what the WebSocket and Tauri transports deliver, instead of what Electron's structured clone would make of them (a `Date`, a `Map`, `undefined` in an array).

| Direction | Channel | Message | Notes |
|---|---|---|---|
| page to main | `sweetview-ipc:hello` | none | Sent by `exposeSweetviewIpc` once per page load; starts the page's session. |
| page to main | `sweetview-ipc` | `CallFrame` | The page numbers calls `"1"`, `"2"`, and so on, per page. `notify` sends `seq: null`. |
| main to page | `sweetview-ipc` | `ReplyFrame` | One reply per call whose `seq` is not `null`, sent to the `webContents` that called. Calls run concurrently, so replies can arrive in any order and are matched by `seq`. |
| main to page | `sweetview-ipc` | `EventFrame` | Sent for every event the service emits, subject to targeting. |

- An event emitted without `to` goes to every `webContents` with a session; one emitted with `to` goes only to the `webContents` whose session id equals it, and is dropped when there is none.
- When a result or an event payload cannot be serialised as JSON (a `BigInt`, a cycle), the host answers the call with an error reply `<seq>: the result is not serialisable: <message>`; an event that cannot be serialised is logged and dropped.
- The host ignores a message that is not a string, not valid JSON, not an object, or not a call frame. It does not check the types of `seq`, `method` or `params`.
- When a call with `seq: null` fails, the host logs `<method> failed: <message>` to the main process's console.
- The page ignores messages that are not JSON objects, frames whose `kind` is neither `"reply"` nor `"event"`, and replies whose `seq` it is not waiting for.
- A reply is dropped when its `webContents` was destroyed, reloaded, or the host was disposed while the handler ran. The handler still runs to completion.
- A frame is never split: each is one IPC message, whatever its size. The tests carry payloads over 1 MB both ways against a stand-in for Electron's IPC.

## Bundling

Electron's main process and preload run CommonJS or ES modules on Node, not TypeScript, and a sandboxed preload must be a single file that requires nothing but `electron`. Bundle each with Bun, leaving `electron` external:

```bash
bun build main.ts --target=node --format=cjs --external electron --outfile build/main.cjs
bun build preload.ts --target=node --format=cjs --external electron --outfile build/preload.cjs
```

Bun replaces `__dirname` with the source folder when it bundles an ES module source, so a bundled main process finds its files from `app.getAppPath()` instead. The page is bundled as for any browser. Loaded from `file://` as in the example, give it a classic script, `bun build page.ts --format=iife --outdir build`, referenced from `index.html` with a plain `<script src>`; [`demos/web-app-electron`](../demos/web-app-electron/main.ts) serves its page from a custom `app://` scheme instead, which gives the page a real origin and ES module scripts.
