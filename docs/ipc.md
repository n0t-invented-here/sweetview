# @n1h/sweetview/ipc

The typed contract between a page and its backend: a `Service` on the backend, a `Bridge` on the page, and the JSON frames a host's transport carries between them. The module imports nothing outside itself and uses no runtime API, so it runs in a browser page, a webview page, a Worker, or Bun. It is `@n1h/sweetview/ipc` in the facade and the standalone package `@n1h/sweetview-ipc`. Hosts supply the transport; [Transports](#transports) lists the four, and [`../README.md`](../README.md) covers install and the window host.

- [Example](#example)
- [The mental model](#the-mental-model)
- [Services](#services)
  - [defineService](#defineservice)
  - [Service types](#service-types)
- [Bridges and transports](#bridges-and-transports)
  - [createBridge](#createbridge)
  - [Bridge](#bridge)
  - [Transport](#transport)
  - [memoryTransport](#memorytransport)
  - [Transports](#transports)
- [Wire format](#wire-format)
  - [ChunkFrame](#chunkframe)
  - [createFrameAssembler](#createframeassembler)

## Example

One contract, one service, one bridge. `memoryTransport` connects them in the same process; in an app the bridge sits on one of the four [transports](#transports), and the service code does not change.

```ts
import { createBridge, defineService, memoryTransport } from "@n1h/sweetview/ipc";

// Shared by both sides: method name -> [params, result], event name -> payload.
type Methods = {
  "notes.add": [{ text: string }, { id: number }];
  "notes.list": [void, string[]];
};
type Events = {
  "notes.changed": { count: number }; // broadcast
  "notes.saved": { id: number };      // sent only to the caller
};

// Backend.
const service = defineService<Methods, Events>((emit) => {
  const notes: string[] = [];
  return {
    methods: {
      "notes.add": ({ text }, ctx) => {
        if (!text.trim()) throw new Error("A note needs some text."); // becomes the page's rejection
        notes.push(text);
        emit("notes.changed", { count: notes.length });           // every session
        emit("notes.saved", { id: notes.length }, ctx.session.id); // only this session
        return { id: notes.length };
      },
      "notes.list": () => [...notes],
    },
    endSession: (sessionId) => console.log("client left", sessionId),
  };
});

// Page.
const transport = memoryTransport(service);
const bridge = createBridge<Methods, Events>(transport);
const stopChanged = bridge.on("notes.changed", ({ count }) => console.log("notes:", count));
const stopSaved = bridge.on("notes.saved", ({ id }) => console.log("saved", id));

console.log(await bridge.rpc("notes.add", { text: "Buy milk" })); // { id: 1 }
try {
  await bridge.rpc("notes.add", { text: "  " });
} catch (error) {
  console.log((error as Error).message); // "A note needs some text."
}
console.log(await bridge.rpc("notes.list")); // ["Buy milk"]

// Teardown: page listener, then the session, then the backend.
stopChanged();
stopSaved();
transport.dispose();     // runs endSession for this session
await service.dispose(); // the application's shutdown hook
```

## The mental model

- The contract is two type maps, shared by both sides. `Methods` maps each
  method name to a `[params, result]` tuple; `Events` maps each event name
  to its payload. A method has at most one argument, so several values go in
  one object; a params type of `void` or `undefined` means no argument.
- The backend is a `Service`: a handler table plus `emit`. It knows nothing
  about windows or sockets.
- A host serves one `Service` to its clients, each a `Session`
  (`{ id, kind }`), and passes a `Ctx` (`{ session }`) to every handler. An
  event goes to every session, or to one session when `emit` names it.
- The page holds a `Bridge`, the typed surface over a `Transport` the host
  provides. Swapping the transport (Sweetview window, WebSocket, Electron,
  Tauri, memory) changes nothing else.

## Services

```ts
import { defineService, type Ctx, type Emit, type EventMap, type MethodMap, type Service } from "@n1h/sweetview/ipc";
```

### defineService

`defineService<M, E>(setup: (emit: Emit<E>) => ServiceDefinition<M>): Service<M, E>`

Builds a `Service` from a handler table. `setup` runs once, synchronously, inside `defineService`. It receives `emit`, and returns the handlers and the optional lifecycle hooks. Handlers and background work call `emit` to push events. Whatever `setup` throws, `defineService` throws synchronously.

The returned service behaves as follows.

- `call` looks the method up among the own properties of `methods`, so names inherited from `Object.prototype` such as `constructor` are not methods.
- `call` awaits the handler and resolves with its result.
- `call` rejects with `Error("unknown method <name>")` when `methods` has no own property of that name.
- `call` rejects with whatever the handler throws.
- `onEvent` listeners run synchronously, in subscription order, each time `emit` is called.
- A listener that throws stops `emit`. Later listeners do not run, and the exception propagates to the caller of `emit`.
- `endSession` calls the definition's `endSession`, when present.
- `dispose` awaits the definition's `dispose`, when present, then removes every `onEvent` listener. Events emitted while the definition's `dispose` runs still reach listeners.
- `dispose` removes the listeners even when the definition's `dispose` throws or rejects, and then rejects with that error.
- `dispose` does not end sessions and does not wait for or cancel calls in flight. A disposed service still runs `call` and still accepts `onEvent` subscriptions.

Handlers receive params exactly as the host decoded them. Hosts do not validate params, so a handler that needs a shape checks it.

### Service types

Every type the backend side exports, in one place. `AnyEvent`, `Handlers`, `ServiceDefinition`, `Session` and `SessionKind` are exported as types from the same module.

```ts
type MethodMap = Record<string, [params: unknown, result: unknown]>;
type EventMap = Record<string, unknown>;

type SessionKind = "webview" | "web" | "electron" | "tauri";
type Session = { id: string; kind: SessionKind };
type Ctx = { session: Session };

type Handlers<M extends MethodMap> = {
  [K in keyof M & string]: (params: M[K][0], ctx: Ctx) => M[K][1] | Promise<M[K][1]>;
};
type Emit<E extends EventMap> = <N extends keyof E & string>(name: N, payload: E[N], to?: string) => void;
type AnyEvent<E extends EventMap> = { [N in keyof E & string]: { name: N; payload: E[N] } }[keyof E & string];

type ServiceDefinition<M extends MethodMap> = {
  methods: Handlers<M>;
  endSession?: (sessionId: string) => void;
  dispose?: () => void | Promise<void>;
};

interface Service<M extends MethodMap, E extends EventMap> {
  call<K extends keyof M & string>(method: K, params: M[K][0], ctx: Ctx): Promise<M[K][1]>;
  onEvent(fn: (name: keyof E & string, payload: E[keyof E], to?: string) => void): () => void;
  endSession(sessionId: string): void;
  dispose(): Promise<void>;
}
```

What each one means beyond its shape:

| Type | Meaning |
|---|---|
| `Session` | One connected client, as the host identifies it. `id` is unique within the host; the host assigns it and the page never sends it. `kind` is `"webview"` for a page in a Sweetview window, `"web"` for a page in a browser or for `memoryTransport` by default, `"electron"` for a page in an Electron window, and `"tauri"` for a page in a Tauri 2 webview. |
| `Ctx` | The second argument of every handler: the session that made the call. |
| `Handlers` | One handler per method. A handler returns the result or a promise of it, and throws to send an error reply. Through a host, the page sees the error's message; through `memoryTransport`, the thrown value itself. |
| `Emit` | Calls every `onEvent` listener synchronously with `name`, `payload` and `to`. Hosts and `memoryTransport` deliver an event without `to` to every session, and one with `to` only to the session whose `id` equals it. An event targeted at a session that no longer exists is dropped; one emitted while nothing is subscribed is lost. Nothing is buffered. A payload must survive JSON encoding to cross a real transport. |
| `AnyEvent` | One event of `E` as a discriminated union of `{ name, payload }`; switching on `name` narrows `payload`. |
| `ServiceDefinition` | What `setup` returns. `endSession` is called when a session ends; `dispose` is called, and awaited, by `Service.dispose`. |
| `Service` | The backend, free of any transport. A host wraps one service and serves it to its sessions. `call` runs one method for the session in `ctx`. `onEvent` subscribes to every emitted event, with the target session id in `to` when there is one. A host calls `endSession` when a client goes away, and the service drops anything it held for that session. `dispose` is the process shutting down: hosts do not call it; the application does. |

## Bridges and transports

The page side: a transport from the host, and the typed bridge over it.

```ts
import { createBridge, memoryTransport, type Bridge, type Transport, type TransportKind } from "@n1h/sweetview/ipc";
```

### createBridge

`createBridge<M, E>(transport: Transport): Bridge<M, E>` puts the typed
`Bridge` surface on a `Transport`. It subscribes to the transport's events
once and fans them out by name. The bridge has the transport's `kind`, and
throws synchronously whatever `transport.onEvent` throws. It holds its
transport subscription for as long as the transport lives; it has no method
to release it.

The bridge normalizes params: an omitted argument, `undefined` or `null`
reaches the transport as `null`. A transport called directly does not do
this; see [Transport](#transport).

### Bridge

```ts
interface Bridge<M extends MethodMap, E extends EventMap> {
  readonly kind: TransportKind; // "webview" | "web" | "electron" | "tauri"
  rpc<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): Promise<M[K][1]>;
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  on<N extends keyof E & string>(name: N, fn: (payload: E[N]) => void): () => void;
}
```

The page's typed view of the service. A method whose params type is `void` or `undefined` takes no argument.

- `rpc` calls a method and resolves with its result. It rejects with whatever `transport.call` rejects with: through a host, an `Error` carrying the backend's message or the transport's own error.
- `notify` calls a method without waiting, through `transport.notify`. The caller gets nothing back. Whether a reply exists on the wire depends on the transport (next section).
- `on` runs `fn` with the payload of each event called `name`, and returns an unsubscribe function. Events that arrive while no listener is subscribed are dropped.

### Transport

```ts
interface Transport {
  readonly kind: TransportKind;
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onEvent(fn: (name: string, payload: unknown) => void): () => void;
}
```

The one thing a host provides to the page. `call` resolves with the result
or rejects with an `Error` carrying the backend's message; `onEvent`
receives every event addressed to this client and returns an unsubscribe
function. `TransportKind` has the same values as `SessionKind`, seen from the
page.

`notify` means "the caller does not wait", not always "no reply on the
wire". The transports differ:

| Transport | `notify(method, params)` |
|---|---|
| `webviewTransport()` ([page](page.md#webviewtransport)) | Sends a regular RPC through `__sweetview_rpc`, which gets a reply like any call, and discards the result. A rejection is caught and logged with `console.error` as `"<method> failed:"`. |
| `wsTransport()` ([ipc-ws](ipc-ws.md#wstransport)) | Wire-level fire and forget: a `CallFrame` with `seq: null`. The server sends no reply, and a failing handler is logged on the server. |
| `electronTransport()` ([ipc-electron](ipc-electron.md#electrontransport)) | Wire-level fire and forget: a `CallFrame` with `seq: null`. The host sends no reply, and a failing handler is logged in the main process. |
| `tauriTransport()` ([ipc-tauri](ipc-tauri.md#tauritransport)) | Invokes the command with a `CallFrame` whose `seq` is `null`; the backend returns `null`. A rejected invoke is logged with `console.error` as `"<method> not sent:"`. |
| `memoryTransport` | Calls the service and discards both the result and any rejection. |

On the UI thread, `webview.notify` and `app.notify` send `seq: null` to the
worker, which is wire-level fire and forget too ([app](app.md#webview)).

Params are passed through as given. Through a bridge they are never
`undefined`, but a page that calls `wsTransport().call("x", undefined)`
directly sends a frame with no `params` key, because `JSON.stringify` drops
`undefined`.

### memoryTransport

`memoryTransport<M, E>(service: Service<M, E>, session?: Session): Transport & { dispose(): void }`

A `Transport` straight onto a `Service` in the same process, with no frames and no host. It is meant for tests and for rendering a frontend in plain Bun. `session` defaults to `{ id: "memory-<n>", kind: "web" }`, where `<n>` counts from 1 across the memory transports created without one; every call runs as that session, and the transport's `kind` is `session.kind`.

- `call` passes params and results by reference. Nothing is JSON-encoded, so values that would not survive a real transport still arrive intact.
- `call` rejects with whatever `Service.call` rejects with.
- `notify` discards both the result and any rejection.
- Events reach this transport when they are broadcast or targeted at `session.id`. They are delivered synchronously inside `emit`, so a listener on this transport that throws makes the backend's `emit` throw.
- `dispose()` is idempotent: the first call stops event delivery, clears listeners, and calls `service.endSession(session.id)`. Later `dispose()` calls do nothing. After `dispose()`, `call` rejects with `Error("<method>: transport disposed")` without reaching the service, and `notify` does nothing.

### Transports

A page reaches its backend through one of four transports. Each is
importable in page code with no Bun, Node or shell API in the bundle, and a
page built on `createBridge` runs unchanged on all four: only the line that
picks the transport differs.

```ts
const transport = isWebview() ? webviewTransport() : isElectron() ? electronTransport() : isTauri() ? tauriTransport() : wsTransport();
const bridge = createBridge<Methods, Events>(transport);
```

| Transport | Page import | Host | `kind` | Page |
|---|---|---|---|---|
| `webviewTransport()` | `@n1h/sweetview/page` | a Sweetview window; the service in a Worker with `hostService` | `"webview"` | [page.md](page.md) |
| `wsTransport()` | `@n1h/sweetview/ipc-ws/client` | `Bun.serve` with `wsHost` | `"web"` | [ipc-ws.md](ipc-ws.md) |
| `electronTransport()` | `@n1h/sweetview/ipc-electron/client` | Electron's main process with `electronHost`, and a preload calling `exposeSweetviewIpc` | `"electron"` | [ipc-electron.md](ipc-electron.md) |
| `tauriTransport()` | `@n1h/sweetview/ipc-tauri/client` | a Tauri 2 app whose Rust code handles the `sweetview_ipc` command | `"tauri"` | [ipc-tauri.md](ipc-tauri.md) |

`memoryTransport` (above) is the fifth, for tests and for rendering a page in
plain Bun; it has no host and no frames. Every transport but
`memoryTransport` carries the [frames](#wire-format) as JSON, so a result or
payload arrives as `JSON.parse(JSON.stringify(value))` would make it.
[`demos/web-app`](../demos/web-app/README.md) runs one page on all four:
`demos/web-app-electron` and `demos/web-app-tauri` are its Electron and
Tauri shells.

## Wire format

Application code rarely touches frames; they matter when writing a host or a transport, or when debugging one. A service never sees frames: the host turns each call frame into a `Service.call` and answers with a reply frame, and the page's transport matches replies to calls by `seq`, ignoring a reply whose `seq` matches no pending call. Over a WebSocket each frame is one JSON text message; between a window's worker and its UI thread frames are JSON in the shared ring; over Electron IPC each frame is one JSON string on the `sweetview-ipc` channel; under Tauri a call frame is the argument of one `invoke` and its reply is the command's return value. `memoryTransport` uses no frames at all and passes values by reference.

```ts
import { createFrameAssembler, type CallFrame, type ChunkFrame, type EventFrame, type Frame, type ReplyFrame, type WireFrame } from "@n1h/sweetview/ipc";
```

| Type | Shape | Direction | Notes |
|---|---|---|---|
| `CallFrame` | `{ kind: "call"; seq: string \| null; method: string; params: unknown }` | page to backend | `seq` is chosen by the sender; `null` means fire and forget, with no reply. `params` is the single argument. A call made through a `Bridge` always carries `params` (`null` when there is no argument); a transport called directly with `undefined` omits the key, and the host passes `undefined` to the handler. |
| `ReplyFrame` | `{ kind: "reply"; seq: string; ok: true; result: unknown }` or `{ kind: "reply"; seq: string; ok: false; error: string }` | backend to page | Answers one call whose `seq` was not `null`. `ok: false` covers a rejected handler and an unknown method; `error` is the rejection's `message` (or `String(value)` for a non-`Error`), shown to the page, so it must be safe for the user to see. A result of `undefined` is dropped by `JSON.stringify`: the window host then resolves with `null`, the WebSocket client with `undefined`; return `null` for the same value everywhere. |
| `EventFrame` | `{ kind: "event"; name: string; payload: unknown }` | backend to page | An unsolicited event, already filtered to this client by the host. |
| `ChunkFrame` | `{ kind: "chunk"; id: number; index: number; total: number; data: string }` | worker to UI thread only | One piece of a frame too large for the ring, see [below](#chunkframe). |
| `Frame` | `CallFrame \| ReplyFrame \| EventFrame` | | The protocol's frames. |
| `WireFrame` | `Frame \| ChunkFrame` | | Everything that can appear on the worker-to-UI ring. |

### ChunkFrame

A `ReplyFrame` or `EventFrame` larger than `ringBytes - 4` bytes as UTF-8 JSON does not fit the worker's ring. The worker serializes the frame, base64-encodes it, and splits the text into `total` chunks sharing one `id`, each carrying its position (`index`, `0` to `total - 1`) and a base64 slice in `data`. The UI thread reassembles them with `createFrameAssembler` before the page sees anything. Only the worker-to-UI ring uses chunks; WebSocket messages have no size limit of this kind.

### createFrameAssembler

`createFrameAssembler(): { push(frame: WireFrame): Frame | null; clear(): void }`

Reassembles chunked frames. `push` returns a non-chunk frame unchanged. For a
chunk it stores the piece and returns `null` until every piece of that `id`
has arrived, then returns the decoded `Frame`. Pieces may arrive in any
order; a repeated index replaces the earlier piece, and a chunk with an
invalid `index` or `total` is ignored. `clear()` drops every partial frame,
which a host does on shutdown. Base64 decoding uses `Buffer` when present and
`atob` otherwise, so the assembler also runs in a browser.
