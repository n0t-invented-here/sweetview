# @n1h/sweetview/ipc-tauri

The [`ipc`](ipc.md) contract in a Tauri 2 webview, so a page built on `createBridge` reaches a backend written in Rust. The page side is `@n1h/sweetview/ipc-tauri/client` (re-exported by `@n1h/sweetview/ipc-tauri`; the standalone package is `@n1h/sweetview-ipc-tauri`). The host side is the Tauri application's own Rust code: one command and one event, specified under [Rust backend](#rust-backend) precisely enough to write it from this page. [`demos/web-app-tauri`](../demos/web-app-tauri/README.md) is a complete application; its [`sweetview_ipc.rs`](../demos/web-app-tauri/src-tauri/src/sweetview_ipc.rs) is the protocol in about eighty lines, written to be copied.

- [Example](#example)
- [Page: `@n1h/sweetview/ipc-tauri/client`](#page-n1hsweetviewipc-tauriclient)
  - [tauriTransport](#tauritransport)
  - [tauriGlobalApi](#tauriglobalapi)
  - [isTauri](#istauri)
- [Rust backend](#rust-backend)
  - [The command](#the-command)
  - [Frames](#frames)
  - [Events](#events)
  - [Sessions](#sessions)
  - [Ordering and errors](#ordering-and-errors)
  - [Permissions](#permissions)

## Example

```ts
// protocol.ts, shared with nothing on the Rust side: Rust implements the same names
export type Methods = { ping: [void, "pong"] };
export type Events = { tick: { count: number } };
```

```ts
// page.ts
import { createBridge } from "@n1h/sweetview/ipc";
import { tauriTransport } from "@n1h/sweetview/ipc-tauri/client";
import type { Events, Methods } from "./protocol";

const bridge = createBridge<Methods, Events>(tauriTransport());
bridge.on("tick", ({ count }) => (document.title = `tick ${count}`));
document.body.textContent = await bridge.rpc("ping");
```

```rust
// src-tauri/src/main.rs, with serde_json; sweetview_ipc.rs copied from the demo
mod sweetview_ipc;
use serde_json::{json, Value};
use tauri::AppHandle;

#[tauri::command]
fn sweetview_ipc(webview: tauri::Webview, frame: Value) -> Result<Value, String> {
    let call = sweetview_ipc::parse_call(frame)?; // not a call frame: Err, and the page's call rejects
    let _session = webview.label();               // one session per webview
    let outcome = match call.method.as_str() {
        "ping" => Ok(json!("pong")),
        other => Err(format!("unknown method {other}")),
    };
    Ok(sweetview_ipc::reply(&call, outcome)) // the ReplyFrame, or null for seq: null
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle: AppHandle = app.handle().clone();
            std::thread::spawn(move || {
                for count in 1.. {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    sweetview_ipc::emit(&handle, "tick", json!({ "count": count }));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sweetview_ipc])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}
```

The capability file grants `core:event:default` to the window ([Permissions](#permissions)). A page that also runs in a Sweetview window, a browser or Electron picks its transport in one line ([Transports](ipc.md#transports)); the rest of the page is unchanged.

## Page: `@n1h/sweetview/ipc-tauri/client`

Runs in the page. It imports types only from `@n1h/sweetview/ipc` and does not import `@tauri-apps/api`, so a page bundle contains no Bun, Node or Tauri package code, and the page needs no bundler setup for Tauri.

```ts
import { TAURI_COMMAND, TAURI_EVENT, isTauri, tauriGlobalApi, tauriTransport, type TauriApi, type TauriTransport } from "@n1h/sweetview/ipc-tauri/client";
```

### tauriTransport

`tauriTransport(api: TauriApi = tauriGlobalApi()): TauriTransport`

Returns a `Transport` with `kind` set to `"tauri"`. It starts listening for [`sweetview-ipc:event`](#events) at once.

```ts
type TauriApi = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
};

type TauriTransport = Transport & {
  readonly ready: Promise<void>;
  dispose(): void;
};
```

| Member | Meaning |
|---|---|
| `api` (argument) | How to reach Tauri. The default reads the page's globals ([tauriGlobalApi](#tauriglobalapi)). A page that bundles `@tauri-apps/api` can pass `{ invoke, listen: (e, h) => getCurrentWebview().listen(e, h) }` from `@tauri-apps/api/core` and `@tauri-apps/api/webview`. `listen` must be scoped to the current webview: the global `listen` from `@tauri-apps/api/event` uses the target `Any`, which Tauri matches against every `emit_to`, so it would also receive events sent to other webviews. |
| `ready` | Resolves once the event listener is registered. Rejects with `listen`'s error, for example when the capability lacks `core:event:default`. Leaving the rejection unhandled is safe. |
| `dispose()` | Unregisters the event listener; later calls reject with `Error("<method>: transport disposed")` and later `notify` calls do nothing. Safe to call twice. |

- `call` waits for `ready` before invoking, so an event the call makes the backend emit is never missed. When `ready` rejects, every call rejects with its error.
- `call` invokes [`sweetview_ipc`](#the-command) with `{ frame }` and resolves with the reply's `result`.
- `call` rejects with an `Error` carrying the backend's message when the reply has `ok: false`.
- `call` rejects with an `Error` carrying Tauri's error when `invoke` rejects: the command is not registered, the command returned `Err`, or the arguments could not be serialised.
- `call` rejects with `Error("<method>: the backend answered without a reply frame")` when the command resolves with anything but a reply frame.
- `notify` invokes the command with `seq: null` and does not wait. When the invoke rejects, it logs `<method> not sent: <message>`.
- Every transport on a page receives every event addressed to that webview. Events received while no `onEvent` listener is subscribed are dropped.

### tauriGlobalApi

`tauriGlobalApi(): TauriApi`

The `TauriApi` from `window.__TAURI_INTERNALS__`, which every Tauri 2 webview has, with or without `app.withGlobalTauri`, and which `@tauri-apps/api` itself calls. `invoke` is `__TAURI_INTERNALS__.invoke`. `listen` does what `getCurrentWebview().listen` does: it invokes `plugin:event|listen` with the target `{ kind: "Webview", label }`, where `label` is this webview's label from `__TAURI_INTERNALS__.metadata`, and its unsubscribe function unregisters the callback and invokes `plugin:event|unlisten`. Throws `Error("not running inside Tauri")` outside a Tauri webview, and `Error("Tauri did not report the current webview's label")` when the metadata is missing.

### isTauri

`isTauri(): boolean`

True when `window.__TAURI_INTERNALS__` exists, which is how a page that runs in several hosts picks this transport.

## Rust backend

What a Tauri 2 application adds so the page's calls reach its backend and its events reach the page. The frames are those of [`ipc.md`](ipc.md#wire-format), as JSON.

### The command

One command, named **`sweetview_ipc`**, with one argument named **`frame`** (a `serde_json::Value`, or a type that deserialises the call frame). Tauri registers a command under its function's name, so the function is `fn sweetview_ipc`. It returns `Result<Value, String>`:

| The command returns | When | The page sees |
|---|---|---|
| `Ok(ReplyFrame)` | a call frame whose `seq` is a string, whether the method succeeded or failed | `call` resolves with `result`, or rejects with `error` |
| `Ok(null)` | a call frame whose `seq` is `null` | nothing (`notify`) |
| `Err(message)` | `frame` is not a call frame: not an object, `kind` is not `"call"`, `seq` is neither a string nor `null`, or `method` is not a string | `call` rejects with `message` |

A method that fails is an `Ok` reply with `ok: false`, not an `Err`: `Err` is for frames the backend cannot read.

### Frames

The page sends, as the `frame` argument:

```json
{ "kind": "call", "seq": "7", "method": "notes.add", "params": { "text": "hello" } }
```

| Field | JSON type | Meaning |
|---|---|---|
| `kind` | string | Always `"call"`. |
| `seq` | string or `null` | Chosen by the page, unique per page: `"1"`, `"2"`, and so on. `null` means fire and forget. Copy it into the reply unchanged; do not parse it. |
| `method` | string | The method name, as in the contract's `Methods`. |
| `params` | any JSON | The single argument; `null` when the method takes none. A page that calls `transport.call` directly with `undefined` omits the key: treat a missing `params` as `null`. |

The command answers a call whose `seq` is a string with exactly one of:

```json
{ "kind": "reply", "seq": "7", "ok": true, "result": { "id": 3, "text": "hello" } }
```

```json
{ "kind": "reply", "seq": "7", "ok": false, "error": "text is required" }
```

| Field | JSON type | Meaning |
|---|---|---|
| `kind` | string | Always `"reply"`. |
| `seq` | string | The call's `seq`. |
| `ok` | boolean | `true` when the method returned, `false` when it failed. |
| `result` | any JSON | With `ok: true`: the method's result. `null` for a method with no result. |
| `error` | string | With `ok: false`: a message shown to the page as the rejection's `message`, so it must be safe for the user to see. For a method the backend does not have, the other hosts send `unknown method <name>`. |

### Events

An event is the Tauri event **`sweetview-ipc:event`** whose payload is an `EventFrame`:

```json
{ "kind": "event", "name": "notes.changed", "payload": [{ "id": 1, "text": "hello", "createdAt": "2026-01-01T00:00:00.000Z" }] }
```

| Field | JSON type | Meaning |
|---|---|---|
| `kind` | string | Always `"event"`. |
| `name` | string | The event name, as in the contract's `Events`. |
| `payload` | any JSON | The event's payload. |

- To every session: `app.emit("sweetview-ipc:event", frame)`.
- To one session: `app.emit_to(EventTarget::webview(label), "sweetview-ipc:event", frame)`, where `label` is that session's webview label. `EventTarget::labeled(label)` works too.

The page listens with the target `{ kind: "Webview", label: <its own label> }`, so it receives events emitted to everyone and events emitted to its own label, and not events emitted to another webview. The page ignores an event whose payload is not an object with `kind: "event"`.

### Sessions

- A session is one webview. Its id is the webview's label (`webview.label()` in the command, which takes a `tauri::Webview` argument); its `kind` is `"tauri"`. The page never sends a session id.
- The backend ends a session when its webview goes away: for a window with one webview, on `WindowEvent::Destroyed` in `on_window_event`.
- A reload keeps the label, so a reloaded page continues the same session. A backend that must drop per-page state on reload can do it in `on_page_load` when the event is `PageLoadEvent::Started`.

### Ordering and errors

- Each call is its own `invoke`, and its reply is that invoke's return value: the page needs no `seq` matching for replies, and replies to concurrent calls can arrive in any order.
- A synchronous command runs on the main thread, one call at a time; an `async` command runs on Tauri's async runtime, and several can run at once.
- Events travel on Tauri's event channel, and replies on the invoke channel. An event the backend emits while handling a call can reach the page before or after that call's reply. Events emitted one after another from one thread reach a webview in that order.
- Values cross as JSON both ways, so a page sees exactly what it would see over the WebSocket or Electron transports.
- A frame is never split: each call is one invoke and each event one Tauri event, whatever its size. The transport's tests carry payloads over 1 MB both ways against a stand-in for Tauri; the size a real webview accepts is Tauri's limit, not this protocol's.
- When a call with `seq: null` fails, the backend has no one to answer; [the demo](../demos/web-app-tauri/src-tauri/src/sweetview_ipc.rs) logs `<method> failed: <message>` to stderr, as the other hosts do.

### Permissions

- The application's own commands, `sweetview_ipc` included, need no permission unless the application declares an app manifest for them in `build.rs`; then the capability must allow `sweetview_ipc`.
- The page's `listen` and `unlisten` are core commands: the window's capability needs `core:event:default`.
- A content security policy must allow the IPC origin: `connect-src 'self' ipc: http://ipc.localhost`.
