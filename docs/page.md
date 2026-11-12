# @n1h/sweetview/page

The page module gives browser code a transport to the window host. It runs in the browser page inside a sweetview window. Its only import is a type from `@n1h/sweetview/ipc`, so it bundles for the browser without Bun or `bun:ffi`.

```ts
import { isWebview, webviewTransport } from "@n1h/sweetview/page";
```

- [Reference](#reference)
  - [isWebview](#iswebview)
  - [webviewTransport](#webviewtransport)
- [Globals](#globals)
- [Example](#example)

## Reference

### isWebview

```ts
export const isWebview = (): boolean
```

Reports whether the page is running inside a sweetview window. It checks that `window` exists and that `window.__sweetview_rpc` is a function.

Returns: `true` inside a sweetview window, `false` elsewhere, including outside a browser.

### webviewTransport

```ts
export function webviewTransport(): Transport
```

Creates a `Transport` for the page's sweetview window. `Transport` is documented in [ipc.md](ipc.md). Pass the result to `createBridge` for the typed surface.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `TransportKind` | Always `"webview"`. |
| `call(method, params)` | `Promise<unknown>` | Calls `__sweetview_rpc(method, params)`. Resolves with the result. A result of `undefined` arrives as `null`. Rejects with an `Error` whose message is the rejection value's `message` field as a string, or the value as a string when it has no `message` field. |
| `notify(method, params)` | `void` | Sends the same call as `call` and discards the result. A failure is logged with `console.error` as `"<method> failed:"` and the message. |
| `onEvent(fn)` | `() => void` | Registers `fn` for every event. Returns a function that removes it. |

Every transport created on one page shares one set of event listeners. The first `webviewTransport()` call installs `window.__sweetview_emit`, unless the page already defined it. In that case `onEvent` listeners receive no events. Events the host emits before the first `webviewTransport()` call find no `__sweetview_emit` and are lost.

Returns: a `Transport` whose `kind` is `"webview"`.

Throws: `Error` with the message `"not running inside sweetview"` when `window.__sweetview_rpc` is not defined.

Outside a browser, where there is no global `window`, it throws the same `Error`.

Thread: the browser page.

## Globals

The module declares both globals as optional properties of `Window`.

| Global | Type | Installed by | Meaning |
|---|---|---|---|
| `__sweetview_rpc` | `(method: string, params: unknown) => Promise<unknown>` | The UI thread, with `webview_bind`, in `createWebviewApp` | Sends a call to the host. A method in `uiMethods` is answered on the UI thread. Any other method goes to the worker. In a window without a worker, any other method rejects. A result of `undefined` resolves as `null`. Rejects with `{ message }` on failure. |
| `__sweetview_emit` | `(name: string, payload: unknown) => void` | `webviewTransport()`, on its first call | The UI thread evaluates `__sweetview_emit(name, payload)` once per event. A payload of `undefined` arrives as `null`. It passes the event to every listener registered with `onEvent`. |

The host side of both is in [app.md](app.md).

## Example

```ts
import { createBridge } from "@n1h/sweetview/ipc";
import { isWebview, webviewTransport } from "@n1h/sweetview/page";

type Methods = { "notes.list": [void, string[]] };
type Events = { "notes.changed": { count: number } };

if (isWebview()) {
  const bridge = createBridge<Methods, Events>(webviewTransport());
  bridge.on("notes.changed", ({ count }) => console.log(count));
  console.log(await bridge.rpc("notes.list"));
}
```
