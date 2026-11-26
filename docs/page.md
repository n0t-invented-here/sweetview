# @n1h/sweetview/page

The page module gives browser code a transport to the window that hosts it,
and the ready handshake. It runs in the page, inside a Sweetview window or a
plain browser. Its only import is a type from `@n1h/sweetview/ipc`, so it
bundles for the browser without Bun or `bun:ffi`. The host side is in
[app.md](app.md).

- [Connecting to the host](#connecting-to-the-host)
  - [isWebview](#iswebview)
  - [webviewTransport](#webviewtransport)
- [The ready handshake](#the-ready-handshake)
  - [signalReady](#signalready)
- [Globals](#globals)

## Connecting to the host

```ts
import { createBridge } from "@n1h/sweetview/ipc";
import { wsTransport } from "@n1h/sweetview/ipc-ws/client";
import { isWebview, webviewTransport } from "@n1h/sweetview/page";

type Methods = { "notes.list": [void, string[]] };
type Events = { "notes.changed": { count: number } };

const bridge = createBridge<Methods, Events>(isWebview() ? webviewTransport() : wsTransport());
bridge.on("notes.changed", ({ count }) => console.log(count));
console.log(await bridge.rpc("notes.list"));
```

A page that runs both in a Sweetview window and in a browser picks its
transport once; everything after that is the same typed `bridge`.

### isWebview

```ts
isWebview(): boolean
```

`true` when `window.__sweetview_rpc` is a function. The host installs that
binding when `WebView.attach` is given `uiMethods`, `deferredUiMethods`, a
`worker`, or a ready option (`showOnReady`, `readyTimeoutMs`, `onReady`); a
direct-URL Sweetview window with none of those has no binding, so
`isWebview()` returns `false` there, as it does in a plain browser and outside
a browser ([RPC trust boundary](app.md#the-rpc-trust-boundary)).

### webviewTransport

```ts
webviewTransport(): Transport
```

A [`Transport`](ipc.md#transport) for the hosting window. Pass it to
`createBridge`.

| Field | Meaning |
|---|---|
| `kind` | `"webview"`. |
| `call(method, params)` | Calls `__sweetview_rpc(method, params)`. Resolves with the result (`undefined` arrives as `null`). Rejects with an `Error` whose message is the host's `message`, or the rejection value as a string. |
| `notify(method, params)` | The same call, result discarded. A failure is logged with `console.error` as `"<method> failed:"` and the message. |
| `onEvent(fn)` | Registers `fn` for every event; returns a function that removes it. |

Throws `Error("not running inside sweetview")` when `__sweetview_rpc` is not
defined, including outside a browser.

All transports created on one page share one set of event listeners. The
first `webviewTransport()` call installs `window.__sweetview_emit`, unless
the page already defined it, in which case `onEvent` listeners receive
nothing. Events the host emits before that first call are lost, so create the
transport early, before anything that might trigger events.

A call goes to the host's `uiMethods` first, then its `deferredUiMethods`,
then the worker. In a window with neither a matching UI method nor a worker
it rejects with `<method>: this window has no worker and no UI-thread method of that name`.

## The ready handshake

The same contract as [Connecting to the host](#connecting-to-the-host). The
event payload (`{ count: number }`) and the RPC result (`string[]`) have
different types, so each gets its own render function.

```ts
import { createBridge } from "@n1h/sweetview/ipc";
import { signalReady, webviewTransport } from "@n1h/sweetview/page";

type Methods = { "notes.list": [void, string[]] };
type Events = { "notes.changed": { count: number } };

const renderNotes = (notes: string[]) => {
  document.getElementById("notes")!.textContent = notes.join("\n");
};
const renderCount = ({ count }: Events["notes.changed"]) => {
  document.getElementById("count")!.textContent = `${count} notes`;
};

const bridge = createBridge<Methods, Events>(webviewTransport());
bridge.on("notes.changed", renderCount);       // 1. install listeners
renderNotes(await bridge.rpc("notes.list"));   // 2. draw the first screen
await signalReady();                           // 3. tell the host
```

A window created with `showOnReady: true` stays hidden until the page says it
is ready, so the user never sees a blank or half-drawn page. Call
`signalReady()` after installing listeners and rendering the initial UI.

### signalReady

```ts
signalReady(): Promise<void>
```

Sends the reserved RPC `__sweetview.ready`. That method name belongs to the
host: it is answered before `uiMethods` and the worker are consulted, so an
app cannot define a method with that name.

On the first signal from a webview, the host:

1. cancels that webview's `readyTimeoutMs` watchdog;
2. calls the native [`signalReady()`](native/activation-and-single-instance.md#signalready),
   which drains buffered activation URLs for the whole app (this happens
   once per process, on the first webview to become ready);
3. calls that webview's `onReady`;
4. shows the window when `showOnReady` is set.

Later signals from the same page resolve without doing anything again.

| Where | Result |
|---|---|
| Plain browser | Resolves immediately; there is nothing to signal. |
| Sweetview window | Resolves when the host acknowledges. Rejects if the host RPC fails, for example when the window is being torn down, with the host's raw rejection value (`{ message }`), not an `Error`. |

## Globals

The module declares both globals as optional properties of `Window`.

| Global | Installed by | Meaning |
|---|---|---|
| `__sweetview_rpc(method, params): Promise<unknown>` | the host, with `webview_bind`, in `WebView.attach` / `createApp` | Sends a call. Resolves with the result (`undefined` as `null`); rejects with `{ message }`. |
| `__sweetview_emit(name, payload): void` | `webviewTransport()`, on its first call | The host evaluates `__sweetview_emit(name, payload)` once per event (`undefined` payload as `null`); it passes the event to every `onEvent` listener. |
