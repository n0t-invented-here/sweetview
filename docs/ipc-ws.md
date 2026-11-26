# @n1h/sweetview/ipc-ws

The [`ipc`](ipc.md) contract over WebSockets, so a `Service` served by `Bun.serve` reaches a page in an ordinary browser. `@n1h/sweetview/ipc-ws/server` runs in Bun and hosts the service; `@n1h/sweetview/ipc-ws/client` runs in the browser page and provides its `Transport`. `@n1h/sweetview/ipc-ws` re-exports both, and the standalone package is `@n1h/sweetview-ipc-ws`. Neither module touches Bun or browser globals until one of its functions is called. Import each side from its own path so a page bundle never pulls in the server's types.

- [Example](#example)
- [Server: `@n1h/sweetview/ipc-ws/server`](#server-n1hsweetviewipc-wsserver)
  - [wsHost](#wshost)
  - [Origin checks](#origin-checks)
- [Client: `@n1h/sweetview/ipc-ws/client`](#client-n1hsweetviewipc-wsclient)
  - [wsTransport](#wstransport)
  - [wsUrl](#wsurl)
- [Wire protocol](#wire-protocol)

## Example

A server and the browser page it serves, sharing one contract. Run
`bun run server.ts` and open `http://127.0.0.1:3000`; the page shows the
reply to `ping` and counts the server's `tick` events. Bun bundles the page's
script because `index.html` is an HTML import in `routes`.

```ts
// protocol.ts
export type Methods = { ping: [void, "pong"] };
export type Events = { tick: { count: number } };
```

```ts
// server.ts
import { defineService } from "@n1h/sweetview/ipc";
import { wsHost } from "@n1h/sweetview/ipc-ws/server";
import index from "./index.html";
import type { Events, Methods } from "./protocol";

const service = defineService<Methods, Events>((emit) => {
  let count = 0;
  const timer = setInterval(() => emit("tick", { count: ++count }), 1000);
  return {
    methods: { ping: () => "pong" },
    dispose: () => clearInterval(timer),
  };
});
const host = wsHost(service);

const server = Bun.serve({
  hostname: "127.0.0.1", // loopback only: keeps the service off the network
  port: 3000,
  routes: { "/": index },
  fetch(req, server) {
    if (new URL(req.url).pathname !== "/ws") return new Response("not found", { status: 404 });
    return host.upgrade(req, server) ? undefined : new Response("expected a websocket", { status: 400 });
  },
  websocket: host.websocket,
});
console.log(`http://127.0.0.1:${server.port}`);

process.on("SIGINT", async () => {
  host.dispose();          // closes every socket; each ends its session
  await service.dispose(); // the host never disposes the service
  server.stop(true);
  process.exit(0);
});
```

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Ping</title>
  </head>
  <body>
    <p id="pong"></p>
    <p id="tick"></p>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

```ts
// main.ts, the browser client
import { createBridge } from "@n1h/sweetview/ipc";
import { wsTransport } from "@n1h/sweetview/ipc-ws/client";
import type { Events, Methods } from "./protocol";

const transport = wsTransport(); // ws://<this page's host>/ws
const bridge = createBridge<Methods, Events>(transport);

bridge.on("tick", ({ count }) => {
  document.getElementById("tick")!.textContent = `tick ${count}`;
});
transport.onClose(() => {
  document.getElementById("tick")!.textContent = "disconnected";
});

document.getElementById("pong")!.textContent = await bridge.rpc("ping"); // queued until the socket opens
```

A page that also runs in a Sweetview window picks `webviewTransport()` when
`isWebview()` is true ([page](page.md#connecting-to-the-host)); the rest of
`main.ts` is unchanged.

## Server: `@n1h/sweetview/ipc-ws/server`

Bun only. Its types come from `bun`. It works with `Bun.serve`, on the main thread or in a Worker.

```ts
import { wsHost, type WsData, type WsHost, type WsHostOptions } from "@n1h/sweetview/ipc-ws/server";
```

### wsHost

`wsHost<M, E>(service: Service<M, E>, options?: WsHostOptions): WsHost`

Hosts a `Service` behind a `Bun.serve` WebSocket handler. Each socket is one session. The host subscribes to the service's events when `wsHost` is called and forwards them until `dispose()`. Pass the returned `websocket` to `Bun.serve` and call `upgrade` from `fetch`. The host never calls `service.dispose()`; the application disposes the service after `host.dispose()`.

```ts
type WsData = { session: Session }; // what Bun attaches to each upgraded socket

type WsHost = {
  upgrade(req: Request, server: Server<WsData>): boolean;
  websocket: WebSocketHandler<WsData>;
  readonly sessions: number;
  dispose(): void;
};

type WsHostOptions = {
  allowOrigin?: string[] | ((origin: string, req: Request) => boolean);
};
```

| Member | Meaning |
|---|---|
| `WsData.session` | The socket's session. `id` is `ws-<n>`, where `<n>` counts from 1 per host; an upgrade that Bun refuses still uses a number. `kind` is always `"web"`. |
| `upgrade(req, server)` | Checks the request's `Origin` ([origin checks](#origin-checks)), assigns a new session, and upgrades the request. Returns `false` when the host is disposed, the `Origin` is refused, or Bun did not upgrade the request; `fetch` must then return its own error response. Throws whatever an `allowOrigin` predicate throws. |
| `websocket` | The `websocket` option for `Bun.serve`. |
| `sessions` | Number of open sockets. |
| `dispose()` | Stops forwarding events, closes every socket, and refuses further upgrades. Each closed socket still ends its session on the service. It does not dispose the service. Safe to call twice. |
| `allowOrigin` (option) | A list of allowed `Origin` values, compared as exact strings, or a predicate that decides. Default: the `Origin` host equals the `Host` header. |

After `dispose()`, `upgrade` returns `false`, and a socket whose upgrade was accepted just before `dispose()` is closed as soon as it opens instead of being served. Stop the `Bun.serve` server as well to stop answering HTTP.

### Origin checks

`allowOrigin` decides which browser pages may connect. Browsers do not apply the same-origin policy to WebSockets, so without a check any page the user has open could call the service. The check, in order:

1. A request without an `Origin` header is accepted, whatever `allowOrigin` says: a predicate is not even called. Browsers always send `Origin` on a WebSocket upgrade, so a request without one comes from a non-browser client (a script, `curl`, another server), which the same-origin concern does not apply to. If those clients must be refused too, authenticate them in `fetch` before calling `upgrade`.
2. With a predicate, its return value decides.
3. With a list, the `Origin` must equal one entry exactly, scheme and port included.
4. With no `allowOrigin`, the request is accepted when the host part of `Origin` (hostname and port) equals the request's `Host` header. The scheme is not compared, so `http://` and `https://` pages on the same host and port both pass. An `Origin` that is not a valid URL, such as `null` from a sandboxed iframe or a `file:` page, is refused.

Binding `Bun.serve` to `127.0.0.1` keeps the service off the network.

## Client: `@n1h/sweetview/ipc-ws/client`

Runs in a browser page, or in any runtime with a global `WebSocket`, such as Bun. `wsUrl`, and `wsTransport` called without a `url`, need the global `location`.

```ts
import { wsTransport, wsUrl, type WsTransport } from "@n1h/sweetview/ipc-ws/client";
```

### wsTransport

`wsTransport(url: string = wsUrl()): WsTransport`

Opens one WebSocket to `url` (the `ws://` or `wss://` URL of the host's upgrade path) and returns a `Transport` over it, with `kind` set to `"web"`. Calls made before the socket opens are queued and sent on open. When the socket closes, every pending call rejects and the transport stays closed; it never reconnects.

`WsTransport` is the [`Transport`](ipc.md#transport) plus the socket's lifecycle:

| Member | Meaning |
|---|---|
| `ready` | `Promise<void>`. Resolves when the socket opens. Rejects with `Error("websocket closed")` when it closes first. Leaving the rejection unhandled is safe. |
| `onClose(fn)` | Runs `fn` once, when the socket closes for any reason. If the socket is already closed, runs `fn` synchronously and returns a no-op unsubscribe function. Otherwise returns an unsubscribe function. |
| `dispose()` | Closes the socket. The transport cannot be reopened; a new `wsTransport` is a new session. |

Throws the `WebSocket` constructor's error when `url` is not a valid WebSocket URL, and a `ReferenceError` when `url` is omitted and no global `location` exists.

- `call` rejects with `Error("websocket closed")` when the socket is closing or closed, and when it closes before the reply arrives.
- `call` rejects with an `Error` carrying the backend's message when the reply has `ok: false`.
- `call` rejects with the `JSON.stringify` error when `params` cannot be serialised as JSON.
- `call` sends `params` as given. Called directly with `undefined`, the frame has no `params` key; a [`Bridge`](ipc.md#createbridge) always sends `null` instead.
- `notify` sends `seq: null`: wire-level fire and forget, with no reply. It never throws. When the socket is closing or closed, or `params` cannot be serialised as JSON, it logs `<method> not sent: <message>` to the console instead.
- A `notify` queued before the socket opens is dropped without a log when the socket closes before opening.
- Events received while no `onEvent` listener is subscribed are dropped.

### wsUrl

`wsUrl(path = "/ws"): string`

Builds the WebSocket URL for the page's own origin, `<ws: or wss:>//<location.host><path>`: `wss:` when the page was loaded over `https:`, `ws:` otherwise. `path` starts with `/`. Throws a `ReferenceError` where no global `location` exists, as in Bun.

## Wire protocol

Each socket carries the `Frame` types documented in [`ipc.md`](ipc.md#wire-format), one JSON text message per frame.

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

- The server accepts binary messages as well as text: it decodes the bytes as UTF-8 and parses the result as JSON, exactly like a text message. A client that sends frames as `Uint8Array` therefore works, but the server always answers with text messages.
- The server ignores a message that is not valid JSON. It sends no reply and logs nothing.
- The server ignores a JSON value that is not an object: `null`, a number, a string or a boolean. The client does the same.
- When a result or an event payload cannot be serialised as JSON (a `BigInt`, a cycle), the server answers the call with an error reply `<seq>: the result is not serialisable: <message>`; an event that cannot be serialised is logged and dropped.
- The server ignores an array, and an object whose `kind` is not `"call"`.
- The server does not check the types of `seq`, `method` or `params` in a call frame.
- When a call with `seq: null` fails, the server logs `<method> failed: <message>` to its console.
- The client ignores messages that are not JSON, frames whose `kind` is neither `"reply"` nor `"event"`, and replies whose `seq` it is not waiting for. A binary message, which a browser delivers as a `Blob`, is not JSON.

Close behaviour:

- When a socket closes from either side, the host stops tracking it and calls `service.endSession` with its session id.
- A reply is dropped when its socket closed, or `WsHost.dispose()` ran, before the call finished. The handler still runs to completion.
- `WsHost.dispose()` closes every socket with no close code or reason given.
- On the client, a close rejects every pending call with `Error("websocket closed")` and runs the `onClose` listeners.
- Neither side reconnects.
- The protocol defines no heartbeat of its own. The `websocket` handler sets no idle timeout or ping options, so Bun's defaults apply.
