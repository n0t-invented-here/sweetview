# @n1h/sweetview/ipc-ws

The [`ipc`](ipc.md) contract over WebSockets, so a `Service` served by `Bun.serve` reaches a page in an ordinary browser. `@n1h/sweetview/ipc-ws/server` runs in Bun and hosts the service; `@n1h/sweetview/ipc-ws/client` runs in the browser page and provides its `Transport`. `@n1h/sweetview/ipc-ws` re-exports both; neither module touches Bun or browser globals until one of its functions is called.

```ts
import { wsHost, type WsData, type WsHost, type WsHostOptions, wsTransport, wsUrl, type WsTransport } from "@n1h/sweetview/ipc-ws";
```

## Server: `@n1h/sweetview/ipc-ws/server`

Bun only. Its types come from `bun`. It works with `Bun.serve`, on the main thread or in a Worker.

### wsHost

```ts
export function wsHost<M extends MethodMap, E extends EventMap>(service: Service<M, E>, options: WsHostOptions = {}): WsHost;
```

Hosts a `Service` behind a `Bun.serve` WebSocket handler. Each socket is one session. The host subscribes to the service's events when `wsHost` is called and forwards them until `close()`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `service` | `Service<M, E>` | required | The service to host. |
| `options` | `WsHostOptions` | `{}` | Origin policy. |

Returns: a `WsHost`. Pass its `websocket` to `Bun.serve` and call its `upgrade` from `fetch`.

The host never calls `service.dispose()`. The application disposes the service after `close()`.

### WsData

```ts
export type WsData = { session: Session };
```

The data Bun attaches to each socket the host upgrades. It is the type parameter of the `Server` and `WebSocketHandler` the host works with.

| Field | Type | Meaning |
|---|---|---|
| `session` | `Session` | The socket's session. `id` is `ws-<n>`, where `<n>` counts from 1 per host. An upgrade that Bun refuses still uses a number. `kind` is always `"web"`. |

### WsHost

```ts
export type WsHost = {
  upgrade(req: Request, server: Server<WsData>): boolean;
  websocket: WebSocketHandler<WsData>;
  readonly sessions: number;
  close(): void;
};
```

What `wsHost` returns.

| Field | Type | Meaning |
|---|---|---|
| `upgrade` | `(req: Request, server: Server<WsData>) => boolean` | Checks the request's `Origin`, assigns a new session, and upgrades the request. Returns `false` when the `Origin` is refused or Bun did not upgrade the request. On `false`, `fetch` must return its own error response. |
| `websocket` | `WebSocketHandler<WsData>` | The `websocket` option for `Bun.serve`. |
| `sessions` | `number` | Number of open sockets. |
| `close` | `() => void` | Stops forwarding events and closes every socket. Each closed socket still ends its session on the service. It does not dispose the service. |

Throws: `upgrade` throws whatever an `allowOrigin` predicate throws.

`close()` does not stop the host from accepting new sockets. Sockets opened after `close()` can call the service but receive no events. Stop the `Bun.serve` server, or stop calling `upgrade`, to refuse them.

### WsHostOptions

```ts
export type WsHostOptions = {
  allowOrigin?: string[] | ((origin: string, req: Request) => boolean);
};
```

Which browser pages may connect. Browsers do not apply the same-origin policy to WebSockets, so without a check any page the user has open could call the service.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `allowOrigin` | `string[] \| ((origin: string, req: Request) => boolean)` | `Origin` host equals `Host` | A list of allowed `Origin` values, compared as exact strings, or a predicate that decides. |

A request without an `Origin` header is always accepted, because it does not come from a browser. With no `allowOrigin`, a request is accepted when the host of its `Origin` equals its `Host` header. An `Origin` that is not a valid URL, such as `null`, is then refused. Binding `Bun.serve` to `127.0.0.1` keeps the service off the network.

## Client: `@n1h/sweetview/ipc-ws/client`

Runs in a browser page, or in any runtime with a global `WebSocket`, such as Bun. `wsUrl`, and `wsTransport` called without a `url`, need the global `location`.

### wsTransport

```ts
export function wsTransport(url: string = wsUrl()): WsTransport;
```

Opens one WebSocket and returns a `Transport` over it. Calls made before the socket opens are queued and sent on open. When the socket closes, every pending call rejects and the transport stays closed; it never reconnects.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | `string` | `wsUrl()` | The `ws://` or `wss://` URL of the host's upgrade path. |

Returns: a `WsTransport` with `kind` set to `"web"`.

Throws: the `WebSocket` constructor's error when `url` is not a valid WebSocket URL.

Throws: a `ReferenceError` when `url` is omitted and no global `location` exists.

- `call` rejects with `Error("websocket closed")` when the socket is closing or closed, and when it closes before the reply arrives.
- `call` rejects with an `Error` carrying the backend's message when the reply has `ok: false`.
- `call` rejects with the `JSON.stringify` error when `params` cannot be serialised as JSON.
- `notify` never throws. When the socket is closing or closed, or `params` cannot be serialised as JSON, it logs `<method> not sent: <message>` to the console instead.
- A `notify` queued before the socket opens is dropped without a log when the socket closes before opening.
- Events received while no `onEvent` listener is subscribed are dropped.

### wsUrl

```ts
export function wsUrl(path = "/ws"): string;
```

Builds the WebSocket URL for the page's own origin: `wss:` when the page was loaded over `https:`, `ws:` otherwise.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `path` | `string` | `"/ws"` | Path on the page's host, starting with `/`. |

Returns: `<ws: or wss:>//<location.host><path>`.

Throws: a `ReferenceError` where no global `location` exists, as in Bun.

### WsTransport

```ts
export type WsTransport = Transport & {
  readonly ready: Promise<void>;
  onClose(fn: () => void): () => void;
  close(): void;
};
```

The `Transport` from `wsTransport`, plus the socket's lifecycle.

| Field | Type | Meaning |
|---|---|---|
| `ready` | `Promise<void>` | Resolves when the socket opens. Rejects with `Error("websocket closed")` when it closes first. Leaving the rejection unhandled is safe. |
| `onClose` | `(fn: () => void) => () => void` | Runs `fn` once, when the socket closes for any reason. If the socket is already closed, runs `fn` synchronously and returns a no-op unsubscribe function. Otherwise returns an unsubscribe function. |
| `close` | `() => void` | Closes the socket. The transport cannot be reopened; a new `wsTransport` is a new session. |

## Wire protocol

Each socket carries the `Frame` types documented in [`ipc.md`](ipc.md), one JSON text message per frame.

| Direction | Frames | Notes |
|---|---|---|
| page to server | `CallFrame` | The client numbers calls `"1"`, `"2"`, and so on per transport. `notify` sends `seq: null`. |
| server to page | `ReplyFrame` | One reply per call whose `seq` is not `null`. Calls run concurrently, so replies can arrive in any order and are matched by `seq`. |
| server to page | `EventFrame` | Sent for every event the service emits, subject to targeting. |

Session identity:

- The server assigns the session when it upgrades the request. No frame field carries the session id.
- One socket is one session. A page that opens a new socket gets a new session id.
- Handlers see the session in `ctx.session`.

Event targeting:

- An event emitted without `to` goes to every open socket of the host.
- An event emitted with `to` goes only to the socket whose session id equals `to`. It is dropped when no such socket is open.

Messages a side does not expect:

- The server decodes binary messages as UTF-8 text.
- The server ignores a message that is not valid JSON. It sends no reply and logs nothing.
- The server ignores a JSON value that is not an object: `null`, a number, a string or a boolean. The client does the same.
- When a result or an event payload cannot be serialised as JSON (a `BigInt`, a cycle), the server answers the call with an error reply `<seq>: the result is not serialisable: <message>`; an event that cannot be serialised is logged and dropped.
- The server ignores an array, and an object whose `kind` is not `"call"`.
- The server does not check the types of `seq`, `method` or `params` in a call frame.
- When a call with `seq: null` fails, the server logs `<method> failed: <message>` to its console.
- The client ignores messages that are not JSON, frames whose `kind` is neither `"reply"` nor `"event"`, and replies whose `seq` it is not waiting for. A binary message, which a browser delivers as a `Blob`, is not JSON.

Close behaviour:

- When a socket closes from either side, the host stops tracking it and calls `service.endSession` with its session id.
- A reply is dropped when its socket closed, or `WsHost.close()` ran, before the call finished. The handler still runs to completion.
- `WsHost.close()` closes every socket with no close code or reason given.
- On the client, a close rejects every pending call with `Error("websocket closed")` and runs the `onClose` listeners.
- Neither side reconnects.
- The protocol defines no heartbeat of its own. The `websocket` handler sets no idle timeout or ping options, so Bun's defaults apply.

## Example

```ts
import { defineService } from "@n1h/sweetview/ipc";
import { wsHost } from "@n1h/sweetview/ipc-ws/server";

const service = defineService<{ ping: [void, "pong"] }, {}>(() => ({ methods: { ping: () => "pong" } }));
const host = wsHost(service);
Bun.serve({
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (new URL(req.url).pathname !== "/ws") return new Response("not found", { status: 404 });
    return host.upgrade(req, server) ? undefined : new Response("expected a websocket", { status: 400 });
  },
  websocket: host.websocket,
});
```
