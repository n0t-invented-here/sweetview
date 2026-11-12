# @n1h/sweetview/worker

The worker module hosts the app's Service behind a sweetview window. It runs inside the Bun Worker that `createWebviewApp` starts from its `worker` option, described in [app.md](app.md). The worker owns the Bun event loop while the UI thread is blocked in the OS loop.

```ts
import { hostService } from "@n1h/sweetview/worker";
```

- [Reference](#reference)
  - [hostService](#hostservice)
- [Example](#example)

## Reference

### hostService

```ts
export function hostService<M extends MethodMap, E extends EventMap>(service: Service<M, E>): void
```

Connects `service` to the window that started this worker. It subscribes to the Service's events and sets `self.onmessage`, replacing any handler already there, then returns.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `service` | `Service<M, E>` | required | The Service to host. `Service`, `MethodMap` and `EventMap` are documented in [ipc.md](ipc.md). |

Thread: the Bun Worker started by `createWebviewApp`. Call once, at the top level of the worker entry. Writing a frame blocks the worker while the ring is full.

#### Messages from the UI thread

The UI thread posts two kinds of message:

| Message | Shape | Effect |
|---|---|---|
| init | `{ kind: "init"; ring: SharedArrayBuffer; webviewHandle: number; drainCallbackPtr: number; libPath: string }` | Sent once, before any call. The worker wraps `ring`, opens the webview library at `libPath`, and writes any frames produced before this message; a frame that cannot be written is logged to the worker console and the rest still go. When `dlopen` fails, the worker throws and the UI thread logs `sweetview: the worker failed: <message>`. |
| call | `{ kind: "call"; seq: string \| null; method: string; params: unknown }` | Runs `service.call(method, params, ctx)`. A `seq` of `null` means no reply is sent. |

Every call gets the same `ctx`: `{ session: { id: "webview", kind: "webview" } }`. One window is one session.

The worker opens the library with `dlopen` and binds one symbol, `webview_dispatch`. The UI thread runs the OS loop and does not process Bun messages. The worker wakes it with `webview_dispatch`, which queues the UI thread's drain callback on that loop. The worker does not import `@n1h/sweetview-webview-bun`. `libPath` is the library the UI thread loaded, so both threads use the same file.

#### Replies and events

Replies and events go back to the UI thread as JSON frames in the shared ring. After writing a frame, the worker calls `webview_dispatch` only when no wakeup is already pending, so a burst of frames costs one dispatch.

| Outcome | Frame sent |
|---|---|
| `service.call` resolves, `seq` set | `{ kind: "reply", seq, ok: true, result }` |
| `service.call` rejects, `seq` set | `{ kind: "reply", seq, ok: false, error }`, where `error` is the error's `message`, or `String(err)` for a non-`Error` value. |
| `service.call` rejects, `seq` is `null` | None. The worker logs `"<method> failed:"` and the message with `console.error`. |
| the Service emits with no `to`, or `to` equal to `"webview"` | `{ kind: "event", name, payload }` |
| the Service emits with any other `to` | None. The event is dropped. |

`hostService` never calls the Service's `endSession` or `dispose`. The UI thread terminates the worker when `run()` returns, or when `createWebviewApp` throws after starting it.

Writing a frame blocks the worker while the ring is full, until the UI thread drains it. A frame whose UTF-8 JSON is longer than the ring's capacity minus 4 bytes throws `RangeError`. A result or payload that `JSON.stringify` rejects, such as a `BigInt`, throws `TypeError`. For a call with a `seq`, either error becomes an error reply. For an event emitted after the init message, it is thrown out of the Service's emit call. The capacity is `ringBytes` in [app.md](app.md).

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
hostService(service);
```
