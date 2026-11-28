# @n1h/sweetview/worker

The worker module runs inside the Bun Worker that `WebView.attach` or
`createApp` starts from its `worker` option ([app.md](app.md)). It hosts the
app's IPC `Service`, dynamic HTTP-style routes, or both. The worker owns a
Bun event loop of its own, which keeps working while the UI thread is blocked
in the OS loop by `webview.run()`.

- [hostService](#hostservice)
- [hostRequestHandler](#hostrequesthandler)
- [Initialization order](#initialization-order)
- [Backpressure](#backpressure)
- [Protocol](#protocol)
  - [Messages from the UI thread](#messages-from-the-ui-thread)
  - [Replies and events](#replies-and-events)
  - [Response frames](#response-frames)
- [writeWorkerFrame](#writeworkerframe)

## hostService

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

`hostService(service, options?: { onRequest?: RequestHandler }): void`
connects `service` to the window that started this worker: page calls not
answered by a UI-thread method run `service.call(method, params, ctx)`, and
the Service's events go to the page. `Service`, `MethodMap` and `EventMap`
are in [ipc.md](ipc.md). `options.onRequest` registers a route handler, the
same as [`hostRequestHandler`](#hostrequesthandler).

Every call gets the same `ctx`: `{ session: { id: "webview", kind: "webview" } }`.
Each webview has its own worker, so there is one session per worker.
`hostService` never calls the Service's `endSession` or `dispose`; the UI
thread terminates the worker when `run()` returns, when the webview is
disposed, when the application ends, or when `WebView.attach` fails after
starting it. On Windows the worker never keeps the process alive by itself: a
timer or watcher inside it does not hold the process open after the
application has quit; on macOS, until the macOS goal of the Rust rewrite, it
does, as before 1.0 ([the end of the application](app.md#the-end-of-the-application)).

## hostRequestHandler

A worker entry that serves a JSON route and a streamed export. The notes live
in memory; `exportStream` yields one `Uint8Array` per line.

```ts
import { hostRequestHandler } from "@n1h/sweetview/worker";

const notes = ["Buy milk", "Ship v1"];

const loadNotes = async (): Promise<string[]> => notes;

const exportStream = (): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < notes.length) controller.enqueue(encoder.encode(`${notes[i++]}\n`));
      else controller.close();
    },
  });
};

hostRequestHandler(async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/notes") return Response.json({ notes: await loadNotes() });
  if (pathname === "/api/export") {
    return new Response(exportStream(), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response("Not Found", { status: 404 });
});
```

The page fetches these at its own origin, for example
`await (await fetch("/api/notes")).json()`, when its webview sets
`onRequest: "worker"`.

`hostRequestHandler(handler: RequestHandler): void`, where `RequestHandler`
is `(request: Request) => Response | Promise<Response>`, registers the
worker's route handler, with or without a Service. The webview
must opt in with `onRequest: "worker"` together with `worker`
([dynamic requests](app.md#dynamic-requests)); otherwise no requests reach
the worker.

- The handler receives a standard `Request`. `GET`, `HEAD` and requests with
  zero body bytes have no body.
- It returns a `Response`, or a promise for one. A thrown error, a rejected
  promise, or a status outside 100 to 599 becomes a plain 500.
- A worker with no handler registered answers 404.
- A response body is read with `getReader()` and forwarded chunk by chunk as
  it arrives. A `ReadableStream` must yield `Uint8Array` chunks.

A request-only worker (one that calls `hostRequestHandler` and never
`hostService`) answers IPC calls that reach it with the error
`This worker has no service`; fire-and-forget notifications are dropped.

## Initialization order

`hostService` and `hostRequestHandler` share one worker host. The first call
of either sets `self.onmessage`, replacing any handler already there; later
calls reuse it, so calling both, in either order, works. Make the call
synchronously at the top level of the worker entry, before any `await`, so
the handler exists when the UI thread's `init` message arrives.

Frames the Service emits before `init` arrives are queued and sent once the
ring exists. Requests cannot arrive before `init`.

## Backpressure

The worker writes replies, events and response bytes into a shared-memory
ring of `ringBytes` (default 1 MiB) that the UI thread drains. Writing is
synchronous: when the ring is full, the worker thread blocks with
`Atomics.wait` until the UI thread drains it. Nothing is dropped and the ring
never holds more than its capacity in flight, but a slow UI thread slows the
worker. This applies between reads of a streaming response too: the worker
reads the next chunk from your stream only after the previous one is in the
ring, so a fast producer is throttled to the speed of the UI thread.

The ring capacity bounds only the bytes in flight between the two threads.
Two buffers sit outside it:

- **Before `init`.** Frames the Service emits before the UI thread's `init`
  message arrives wait in an in-memory queue with no size limit (see
  [Initialization order](#initialization-order)). Emitting a flood of events
  at the top level of the worker grows that queue.
- **Without streaming symbols.** A library that has request interception but
  not the streaming symbols makes the UI thread collect a streamed response's
  chunks in memory and complete the request once, at the end
  ([Response frames](#response-frames)). The worker is still throttled by the
  ring, but the UI thread holds the whole body.

A JSON frame larger than `ringBytes - 4` is split into ordered
[chunk envelopes](ipc.md#chunkframe) with base64 payloads and reassembled on
the UI thread before it reaches the page. A reply that cannot be serialized
(a `BigInt`, a circular reference) or cannot fit becomes an error reply with
a message clamped to fit, so the page's call never hangs; an event that
cannot be sent is logged and dropped.

## Protocol

This section describes what crosses between the threads, for debugging and
for anyone writing a compatible host.

### Messages from the UI thread

| Message | Shape | Effect |
|---|---|---|
| init | `{ kind: "init"; ring: SharedArrayBuffer; wake: WorkerWake }` | Sets up how the worker wakes the UI thread and flushes queued frames. `wake` is `{ kind: "native"; token: number }` on Windows, a token the Rust binding (loaded again inside the worker) posts to the UI thread's signal window; on macOS, until the macOS goal of the Rust rewrite, it is `{ kind: "library"; libPath; webviewHandle; drainCallbackPtr; drainToken }`, and the worker opens the webview library at the same path as the UI thread. |
| call | `{ kind: "call"; seq: string \| null; method: string; params: unknown }` | Runs the Service method. `seq: null` is a notification: no reply. |
| http-request | `{ kind: "http-request"; id: bigint; method: string; url: string; headers: [string, string][]; body: Uint8Array }` | Runs the route handler. The UI thread copies the native request and transfers a nonempty body. |

After writing a frame, the worker wakes the UI thread (through the binding's
wake on Windows, `webview_dispatch` on macOS) only when no wakeup is already
pending, so a burst of frames costs one dispatch. The UI thread closes that
dispatch gate before it destroys the webview.

### Replies and events

| Outcome | Frame |
|---|---|
| A call resolves, `seq` set | `{ kind: "reply", seq, ok: true, result }` |
| A call rejects, `seq` set | `{ kind: "reply", seq, ok: false, error }`, `error` being the error's `message` or `String(err)` |
| A call rejects, `seq` is `null` | none; logged as `"<method> failed:"` |
| The Service emits with no `to`, or `to: "webview"` | `{ kind: "event", name, payload }` |
| The Service emits to any other session | none; dropped |

### Response frames

HTTP responses share the ring with JSON IPC. A response frame starts with a
`0x00` byte, which JSON never does, then a frame type byte, a little-endian
32-bit metadata length, UTF-8 JSON metadata, and raw body bytes.

| Type | Meaning |
|---|---|
| `0x01` | A whole response. |
| `0x02` | A numbered part of a response too large for one frame. |
| `0x03` | Stream begin: status and headers. |
| `0x04` | Stream chunk. |
| `0x05` | Stream end. |
| `0x06` | Stream reader failure. |

Every frame carries the request ID as a decimal string, keeping all 64 bits.
Chunks larger than the ring are split. If the headers alone cannot fit, the
worker answers 500.

When the engine has streamed responses (always on Windows; on macOS, a
webview library with the streaming symbols), the UI thread forwards each
chunk to the native response as it arrives; a reader failure after the begin frame ends the
response with the bytes already sent. With a macOS library that only has
`webview_complete_request`, the UI thread buffers the body and answers 500 on
reader failure. Disposal discards partial responses.

WKWebView hands streamed bytes to the page as they arrive. On Windows, in
every case measured, the page got the whole response when the stream ended
and nothing before, as under the C++ library
([the webview](webview-library.md#streaming-responses)). So for real-time
push on Windows use IPC events (`emit` in the Service, `bridge.on` in the
page), and do not stream a body that never ends there.
[WebView2 Feedback #3519](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3519).

## writeWorkerFrame

```ts
writeWorkerFrame(ring: Ring, frame: Frame, wake: () => void, encoder?: TextEncoder): void
```

The low-level function `hostService` uses to put one JSON frame into the
ring, with the chunking and error-reply fallback described in
[Backpressure](#backpressure). It is exported for Sweetview's own tests and
for custom hosts; it is a transport internal, not part of the API an app
needs, and its behaviour may change with the ring protocol.
