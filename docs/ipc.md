# @n1h/sweetview/ipc

The typed contract between a page and its backend: a `Service` on the backend, a `Bridge` on the page, and the JSON frames a host's transport carries between them. The module imports nothing outside itself and uses no runtime API, so it runs in a browser page, a webview page, a Worker, or Bun. Hosts supply the transport; [`ipc-ws.md`](ipc-ws.md) covers the WebSocket one, and [`../README.md`](../README.md) covers install and the window host.

```ts
import { type CallFrame, type EventFrame, type Frame, type ReplyFrame, defineService, type AnyEvent, type Ctx, type Emit, type EventMap, type Handlers, type MethodMap, type Service, type ServiceDefinition, type Session, type SessionKind, createBridge, type Bridge, type Transport, type TransportKind, memoryTransport } from "@n1h/sweetview/ipc";
```

- [Reference](#reference)
  - [CallFrame](#callframe)
  - [EventFrame](#eventframe)
  - [Frame](#frame)
  - [ReplyFrame](#replyframe)
  - [defineService](#defineservice)
  - [AnyEvent](#anyevent)
  - [Ctx](#ctx)
  - [Emit](#emit)
  - [EventMap](#eventmap)
  - [Handlers](#handlers)
  - [MethodMap](#methodmap)
  - [Service](#service)
  - [ServiceDefinition](#servicedefinition)
  - [Session](#session)
  - [SessionKind](#sessionkind)
  - [createBridge](#createbridge)
  - [Bridge](#bridge)
  - [Transport](#transport)
  - [TransportKind](#transportkind)
  - [memoryTransport](#memorytransport)
- [Example](#example)

## Reference

### CallFrame

```ts
export type CallFrame = { kind: "call"; seq: string | null; method: string; params: unknown };
```

A request from the page to the backend.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"call"` | Frame discriminant. |
| `seq` | `string \| null` | Correlation id chosen by the sender. `null` means fire and forget: no reply frame is sent. |
| `method` | `string` | Method name in the service's `MethodMap`. |
| `params` | `unknown` | The single argument. A method called without an argument carries `null`. |

### EventFrame

```ts
export type EventFrame = { kind: "event"; name: string; payload: unknown };
```

An unsolicited message from the backend to the page.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"event"` | Frame discriminant. |
| `name` | `string` | Event name in the service's `EventMap`. |
| `payload` | `unknown` | The event payload. |

### Frame

```ts
export type Frame = CallFrame | ReplyFrame | EventFrame;
```

Every frame a transport carries, as JSON. A service never sees frames. The host that wraps a service turns each `CallFrame` into a `Service.call` and answers with a `ReplyFrame`. The page's transport matches each `ReplyFrame` to its call by `seq` and ignores a `ReplyFrame` whose `seq` matches no pending call.

### ReplyFrame

```ts
export type ReplyFrame =
  | { kind: "reply"; seq: string; ok: true; result: unknown }
  | { kind: "reply"; seq: string; ok: false; error: string };
```

The backend's answer to one `CallFrame` whose `seq` was not `null`.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"reply"` | Frame discriminant. |
| `seq` | `string` | The `seq` of the call being answered. |
| `ok` | `boolean` | `true` when `Service.call` resolved. `false` when it rejected, including for an unknown method. |
| `result` | `unknown` | The handler's return value. Present when `ok` is `true`. |
| `error` | `string` | The rejection's `message`, or `String(value)` when the rejection is not an `Error`. Present when `ok` is `false`. The page sees it, so it must be safe for the user to see. |

### defineService

```ts
export function defineService<M extends MethodMap, E extends EventMap>(setup: (emit: Emit<E>) => ServiceDefinition<M>): Service<M, E>;
```

Builds a `Service` from a handler table. `setup` runs once, synchronously, inside `defineService`. It receives `emit`. Handlers and background work call `emit` to push events.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `setup` | `(emit: Emit<E>) => ServiceDefinition<M>` | required | Returns the handlers and the optional lifecycle hooks. |

Returns: a `Service<M, E>` whose `call` looks the method up among the own properties of `methods`, so names inherited from `Object.prototype` such as `constructor` are not methods.

Throws: whatever `setup` throws, synchronously.

The returned service behaves as follows.

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

### AnyEvent

```ts
export type AnyEvent<E extends EventMap> = { [N in keyof E & string]: { name: N; payload: E[N] } }[keyof E & string];
```

One event of `E` as a discriminated union of `{ name, payload }`. A listener that switches on `name` gets the matching `payload` type.

### Ctx

```ts
export type Ctx = { session: Session };
```

The second argument of every handler.

| Field | Type | Meaning |
|---|---|---|
| `session` | `Session` | The client that made the call. |

### Emit

```ts
export type Emit<E extends EventMap> = <N extends keyof E & string>(name: N, payload: E[N], to?: string) => void;
```

Calls every `onEvent` listener synchronously with `name`, `payload` and `to`. Hosts and `memoryTransport` deliver an event without `to` to every session, and an event with `to` only to the session whose `id` equals `to`. An event targeted at a session that no longer exists is dropped. An event emitted while nothing is subscribed is lost. Nothing is buffered.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `N` | required | Event name. |
| `payload` | `E[N]` | required | Event payload. It must survive JSON encoding to cross a real transport. |
| `to` | `string` | none | Session id to target. |

### EventMap

```ts
export type EventMap = Record<string, unknown>;
```

Maps each event name to its payload type. It is shared by both sides.

### Handlers

```ts
export type Handlers<M extends MethodMap> = {
  [K in keyof M & string]: (params: M[K][0], ctx: Ctx) => M[K][1] | Promise<M[K][1]>;
};
```

One handler per method of `M`. A handler returns the result or a promise of it. A handler throws to send an error reply. Through a host, the page sees the error's message. Through `memoryTransport`, the page sees the thrown value itself.

### MethodMap

```ts
export type MethodMap = Record<string, [params: unknown, result: unknown]>;
```

Maps each method name to a `[params, result]` tuple. It is shared by both sides. A params type of `void` or `undefined` means the method takes no argument. A method has at most one argument, so several values go in one object.

### Service

```ts
export interface Service<M extends MethodMap, E extends EventMap> {
  call<K extends keyof M & string>(method: K, params: M[K][0], ctx: Ctx): Promise<M[K][1]>;
  onEvent(fn: (name: keyof E & string, payload: E[keyof E], to?: string) => void): () => void;
  endSession(sessionId: string): void;
  dispose(): Promise<void>;
}
```

The backend, free of any transport. A host wraps one service and serves it to its sessions. `defineService` builds one.

| Field | Type | Meaning |
|---|---|---|
| `call` | `(method, params, ctx) => Promise<result>` | Runs one method for the session in `ctx`. |
| `onEvent` | `(fn) => () => void` | Subscribes to every emitted event, with the target session id in `to` when there is one. Returns an unsubscribe function. |
| `endSession` | `(sessionId: string) => void` | A host calls this when a client goes away. The service drops anything it held for that session. |
| `dispose` | `() => Promise<void>` | The process is shutting down. Hosts do not call this; the application does. |

### ServiceDefinition

```ts
export type ServiceDefinition<M extends MethodMap> = {
  methods: Handlers<M>;
  endSession?: (sessionId: string) => void;
  dispose?: () => void | Promise<void>;
};
```

What `setup` returns to `defineService`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `methods` | `Handlers<M>` | required | One handler per method. |
| `endSession` | `(sessionId: string) => void` | none | Called when a session ends. |
| `dispose` | `() => void \| Promise<void>` | none | Called, and awaited, by `Service.dispose`. |

### Session

```ts
export type Session = { id: string; kind: SessionKind };
```

One connected client, as the host identifies it.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Unique within the host. The host assigns it; the page never sends it. |
| `kind` | `SessionKind` | Which kind of host the client came through. |

### SessionKind

```ts
export type SessionKind = "webview" | "web";
```

`"webview"` for a page in a sweetview window. `"web"` for a page in a browser or for `memoryTransport` by default.

### createBridge

```ts
export function createBridge<M extends MethodMap, E extends EventMap>(transport: Transport): Bridge<M, E>;
```

Puts the typed `Bridge` surface on a `Transport`. It subscribes to the transport's events once and fans them out by name.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `transport` | `Transport` | required | The host's transport. |

Returns: a `Bridge<M, E>` with the transport's `kind`.

Throws: whatever `transport.onEvent` throws, synchronously.

The bridge holds its transport subscription for as long as the transport lives. It has no method to release it.

### Bridge

```ts
export interface Bridge<M extends MethodMap, E extends EventMap> {
  readonly kind: TransportKind;
  rpc<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): Promise<M[K][1]>;
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  on<N extends keyof E & string>(name: N, fn: (payload: E[N]) => void): () => void;
}
```

The page's typed view of the service. A method whose params type is `void` or `undefined` takes no argument. The bridge sends `null` as params when the argument is absent or `undefined`.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `TransportKind` | The transport's kind, so a page can tell a window from a browser tab. |
| `rpc` | `(method, params?) => Promise<result>` | Calls a method. Resolves with its result. Rejects with whatever `transport.call` rejects with: through a host, an `Error` carrying the backend's message or the transport's own error. |
| `notify` | `(method, params?) => void` | Calls a method without waiting. No reply comes back and failures are not reported to the caller. |
| `on` | `(name, fn) => () => void` | Runs `fn` with the payload of each event called `name`. Returns an unsubscribe function. Events that arrive while no listener is subscribed are dropped. |

### Transport

```ts
export interface Transport {
  readonly kind: TransportKind;
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onEvent(fn: (name: string, payload: unknown) => void): () => void;
}
```

The one thing a host provides to the page. `@n1h/sweetview/page` provides one for a sweetview window, `@n1h/sweetview/ipc-ws/client` one for a browser, and `memoryTransport` one in the same process.

| Field | Type | Meaning |
|---|---|---|
| `kind` | `TransportKind` | Which host this transport reaches. |
| `call` | `(method: string, params: unknown) => Promise<unknown>` | Resolves with the result. Rejects with an `Error` carrying the backend's message. |
| `notify` | `(method: string, params: unknown) => void` | Fire and forget: no reply. |
| `onEvent` | `(fn) => () => void` | Receives every event addressed to this client. Returns an unsubscribe function. |

### TransportKind

```ts
export type TransportKind = "webview" | "web";
```

The same values as `SessionKind`, seen from the page.

### memoryTransport

```ts
export function memoryTransport<M extends MethodMap, E extends EventMap>(
  service: Service<M, E>,
  session: Session = { id: `memory-${nextId++}`, kind: "web" },
): Transport & { close(): void };
```

A `Transport` straight onto a `Service` in the same process, with no frames and no host. It is meant for tests and for rendering a frontend in plain Bun.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `service` | `Service<M, E>` | required | The service to call. |
| `session` | `Session` | `{ id: "memory-<n>", kind: "web" }` | The session every call runs as. `<n>` counts from 1 across the memory transports created without a `session`. |

Returns: a `Transport` with `kind` set to `session.kind`, plus `close()`.

- `call` passes params and results by reference. Nothing is JSON-encoded, so values that would not survive a real transport still arrive intact.
- `call` rejects with whatever `Service.call` rejects with.
- `notify` discards both the result and any rejection.
- Events reach this transport when they are broadcast or targeted at `session.id`. They are delivered synchronously inside `emit`, so a listener on this transport that throws makes the backend's `emit` throw.
- `close()` stops event delivery and calls `service.endSession(session.id)`. Each further `close()` calls `service.endSession(session.id)` again. Calls made after `close()` still reach the service.

## Example

```ts
import { createBridge, defineService, memoryTransport } from "@n1h/sweetview/ipc";

type Methods = { add: [{ a: number; b: number }, number] };
type Events = { added: { sum: number } };
const service = defineService<Methods, Events>((emit) => ({
  methods: {
    add: ({ a, b }, ctx) => {
      emit("added", { sum: a + b }, ctx.session.id);
      return a + b;
    },
  },
}));
const bridge = createBridge<Methods, Events>(memoryTransport(service));
bridge.on("added", ({ sum }) => console.log("event", sum));
console.log("result", await bridge.rpc("add", { a: 2, b: 3 }));
```
