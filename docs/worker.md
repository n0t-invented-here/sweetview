# @n1h/sweetview/worker

The worker module hosts the app's Service behind a sweetview window. It runs inside the Bun Worker that `WebView.attach` / `createApp` starts from its `worker` option, described in [app.md](app.md). The worker owns the Bun event loop while the UI thread is blocked in the OS loop.

```ts
import { hostService, hostRequestHandler, type RequestHandler, type HostServiceOptions } from "@n1h/sweetview/worker";
```

- [Reference](#reference)
  - [hostService](#hostservice)
- [Example](#example)

## Reference

### hostService

```ts
export type RequestHandler = (request: Request) => Response | Promise<Response>;
export type HostServiceOptions = { onRequest?: RequestHandler };
export function hostService<M extends MethodMap, E extends EventMap>(service: Service<M, E>, options?: HostServiceOptions): void;
```

Connects `service` to the window that started this worker. It subscribes to the Service's events and sets `self.onmessage`, replacing any handler already there, then returns.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `service` | `Service<M, E>` | required | The Service to host. `Service`, `MethodMap` and `EventMap` are documented in [ipc.md](ipc.md). |
| `options.onRequest` | `RequestHandler` | none | Handles dynamic routes when the view opts in with `onRequest: "worker"`. |

Thread: the Bun Worker started by `WebView.attach` / `createApp`. Call once, at the top level of the worker entry. Writing a frame blocks the worker while the ring is full.

#### Messages from the UI thread

The UI thread sends an initialization message, then forwards calls and dynamic requests.

| Message | Shape | Effect |
|---|---|---|
| init | `{ kind: "init"; ring: SharedArrayBuffer; webviewHandle: number; drainCallbackPtr: number; drainToken: bigint; libPath: string }` | Opens the library and flushes frames produced before setup. |
| call | `{ kind: "call"; seq: string \| null; method: string; params: unknown }` | Runs `service.call(method, params, ctx)`. A `seq` of `null` means no reply is sent. |
| http-request | `{ kind: "http-request"; id: bigint; method: string; url: string; headers: [string, string][]; body: Uint8Array }` | Copies the native request fields on the UI thread and transfers nonempty body bytes to the worker. |

Every call gets the same `ctx`: `{ session: { id: "webview", kind: "webview" } }`. Each webview has its own worker session.

The worker uses `webview_dispatch` to queue a drain on the native UI loop.
Both threads open the library at the same path. The UI thread owns the
completion calls, and shutdown closes the dispatch gate before destruction.

#### Replies and events

Replies and events go back to the UI thread as JSON frames in the shared ring. After writing a frame, the worker calls `webview_dispatch` only when no wakeup is already pending, so a burst of frames costs one dispatch.

| Outcome | Frame sent |
|---|---|
| `service.call` resolves, `seq` set | `{ kind: "reply", seq, ok: true, result }` |
| `service.call` rejects, `seq` set | `{ kind: "reply", seq, ok: false, error }`, where `error` is the error's `message`, or `String(err)` for a non-`Error` value. |
| `service.call` rejects, `seq` is `null` | None. The worker logs `"<method> failed:"` and the message with `console.error`. |
| the Service emits with no `to`, or `to` equal to `"webview"` | `{ kind: "event", name, payload }` |
| the Service emits with any other `to` | None. The event is dropped. |

`hostService` never calls the Service's `endSession` or `dispose`. The UI thread terminates the worker when `run()` returns, when `dispose()` runs, or when `WebView.attach` throws after starting it.

Writing blocks the worker while the ring is full. Serializable JSON IPC
frames larger than `ringBytes - 4` travel in ordered JSON chunk envelopes
with base64 payloads. The host reassembles them before sending a reply or an
event to the page. Serialization failures and frames that cannot fit a chunk
envelope produce a byte-clamped error reply or a logged, dropped event.

### hostRequestHandler

```ts
export function hostRequestHandler(handler: RequestHandler): void;
```

Registers a route handler in a worker with or without an IPC service. Call it
at worker startup, or pass the same handler in `hostService(service, { onRequest })`.
The webview must select `onRequest: "worker"`.

The handler receives a standard `Request` with URL, method and headers.
GET, HEAD and requests with zero bytes have no body. Return a `Response`
or a promise for one. Exceptions and rejected promises become a plain 500
response. A worker with no registered handler returns 404. The response body
is buffered with `response.arrayBuffer()` before forwarding.

The ring carries response bytes directly. A leading `0x00` distinguishes an
HTTP response from JSON IPC. The next byte is `0x01` for a whole response or
`0x02` for a chunk, followed by the little-endian 32-bit metadata length,
UTF-8 JSON metadata and raw body bytes. Whole frames carry `id`, `status`
and `headers`. Chunk metadata includes `id`, `seq` and `total`. The first
chunk also carries status and headers. IDs are serialized as decimal strings
to preserve all 64 bits. The UI thread assembles chunks by ID and clears
partial responses on disposal. If the header table alone cannot fit, the
worker returns 500. Increase `ringBytes` to support unusually large headers.

## Example

```ts
import { defineService } from "@n1h/sweetview/ipc";
import { hostService } from "@n1h/sweetview/worker";

type Methods = { "notes.list": [void, string[]] };
type Events = { "notes.changed": { count: number } };

const service = defineService<Methods, Events>((emit) => ({
  methods: {
    "notes.list": () => {
      emit("notes.changed", { count: 0 });
      return [];
    },
  },
}));
hostService(service, {
  async onRequest(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/notes") return Response.json({ notes: [] });
    return new Response("Not Found", { status: 404 });
  },
});
```
