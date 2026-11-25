# @n1h/sweetview

The root module mounts a webview inside a native `Window`, serves bundled pages
or assets to it, connects the page to an optional worker that hosts the
application's `Service`, and provides built-in native tabs and the Layer 2
`createApp` helper. It runs on the UI thread: the main thread of the Bun
process. Install and the overview are in the [package README](../README.md).

```ts
import {
  createApp,
  WebView,
  type App,
  type AppOptions,
  type Asset,
  type Tab,
  type TabOptions,
  type UiMethods,
  type WebViewOptions,
  assetMime,
  indexHtml,
  indexHtmlText,
  type IndexHtmlOptions,
  windowChromeMethods,
  type WindowChromeInfo,
  type WindowChromeKind,
  type WindowChromeMethodTable,
  type WindowChromeMethods,
  type WindowChromeOptions,
  Ring,
  pumpEvents,
  quitEventLoop,
  runEventLoop,
  setActivationPolicy,
  type ActivationPolicy,
  type EventLoopOptions,
  SizeHint,
  WEBVIEW_VERSION,
  RawWebview,
} from "@n1h/sweetview";
```

- [The event loop](#the-event-loop)
  - [`run()`: the library's loop](#run-the-librarys-loop)
  - [`runEventLoop`: the loop on a Bun timer](#runeventloop-the-loop-on-a-bun-timer)
  - [Choosing](#choosing)
- [Reference](#reference)
  - [WebView](#webview)
  - [WebView.attach](#webviewattach)
  - [WebView.openTab](#webviewopentab)
  - [WebViewOptions](#webviewoptions)
  - [Tab and TabOptions](#tab-and-taboptions)
  - [createApp](#createapp)
  - [App and AppOptions](#app-and-appoptions)
  - [Asset](#asset)
  - [UiMethods](#uimethods)
  - [assetMime](#assetmime)
  - [indexHtml](#indexhtml)
  - [indexHtmlText](#indexhtmltext)
  - [IndexHtmlOptions](#indexhtmloptions)
  - [windowChromeMethods](#windowchromemethods)
  - [Ring](#ring)
  - [Event loop re-exports](#event-loop-re-exports)
  - [SizeHint, WEBVIEW_VERSION, RawWebview](#sizehint-webview_version-rawwebview)
- [Page loading](#page-loading)
- [Transport](#transport)
- [Examples](#examples)

## The event loop

One process has one OS event loop, on the UI thread, the main thread of the Bun process. Every window, tray, notifier and menu is created on that thread and every handler runs on it, from inside the loop, while the loop is on the stack: a handler returns quickly and cannot wait for anything that needs the loop to turn. There are two ways to run the loop, and an app uses exactly one.

### `run()`: the library's loop

`webview.run()` (and `app.run()` on a non-tabbed app) calls the webview library's `webview_run`, which is the platform's own blocking loop: `[NSApp run]` on macOS, a `GetMessage` loop on Windows. It returns when `quit()` is called (`webview_terminate`). On `createApp(...)` without a custom `onClose`, closing the main window disposes the window and calls `quit()` automatically. When `run()` returns, it tears the webview down: the worker is terminated, the drain callback released, and the webview destroyed, in that order.

While `run()` runs, Bun's event loop on the UI thread does not turn: no `setTimeout`, no promise continuation, no I/O completes there. That is why a single-window app using `run()` keeps its async logic in a worker, which owns Bun's event loop; the page talks to the worker through the UI thread and the shared ring, and the worker wakes the UI thread with `webview_dispatch`. Code on the UI thread after `run()` starts runs only inside callbacks: `uiMethods`, `onEvent` listeners, tray and menu handlers, window callbacks, and notification clicks.

### `runEventLoop`: the loop on a Bun timer

`runEventLoop` from `@n1h/sweetview/native` (also re-exported from `@n1h/sweetview`) never blocks. Every `intervalMs` (default 16) it calls `pumpEvents`, which dispatches every OS event waiting for the thread and returns: `PeekMessage` / `DispatchMessage` on Windows, `nextEventMatchingMask:` / `sendEvent:` on macOS with `finishLaunching` once. Between pumps the thread is Bun's, so `setTimeout`, promises and I/O work on the UI thread and the app needs no worker. The returned promise resolves when `quitEventLoop()` is called, or when the OS ends the loop (`WM_QUIT` on Windows). A click reaches its handler at most one interval late; a menu, once open, tracks at native speed inside the pump.

Tabbed apps (`createApp({ tabs: true })`) use `runEventLoop()` automatically so `openTab()` (which is async) and per-tab `dispose()` work while the app is running. Single-window apps can also host a `Window` + `WebView.attach` under `await runEventLoop()` and call `view.dispose()` and `win.dispose()` afterward.

```ts
import { WebView, indexHtml, quitEventLoop, runEventLoop } from "@n1h/sweetview";
import { Tray, Window } from "@n1h/sweetview/native";

const win = new Window({ title: "Hello", bounds: { x: 200, y: 200, width: 640, height: 480 } });
const view = await WebView.attach(win, {
  assets: { "index.html": indexHtml({ title: "Hello", body: "<h1>Hello</h1>" }) },
});
new Tray({
  tooltip: "Hello",
  menu: () => [
    { label: "Show", click: () => win.show() },
    { label: "Quit", click: quitEventLoop },
  ],
});
win.show();
setInterval(() => view.emit("tick", Date.now()), 1000);
await runEventLoop();
view.dispose();
win.dispose();
```

### Choosing

| | `webview.run()` | `runEventLoop()` |
|---|---|---|
| Loop | the platform's blocking loop | pumped from a Bun timer |
| Bun on the UI thread | blocked: timers, promises, I/O wait | alive |
| App logic | in a worker | on the UI thread, or in a worker if you want one |
| Ends when | `quit()` (or main window closes in `createApp`) | `quitEventLoop()`, or `WM_QUIT` |
| Cleanup | automatic on return | `view.dispose()` / `app.dispose()` |
| Idle cost | none | one wake per interval, about 0.5 % CPU at 16 ms |
| Native tabs | no | yes (`createApp({ tabs: true }).run()` uses this) |

## Reference

### WebView

```ts
export class WebView<M extends MethodMap = MethodMap, E extends EventMap = EventMap> {
  readonly raw: RawWebview;
  readonly window: Window;

  static attach<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
    window: Window,
    options: WebViewOptions<M>,
  ): Promise<WebView<M, E>>;

  static openTab<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
    window: Window,
    options: TabOptions<M>,
  ): Promise<Tab<M, E>>;

  emit<N extends keyof E & string>(name: N, payload: E[N]): void;
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  onEvent(fn: (event: AnyEvent<E>) => void): () => void;
  run(): void;
  quit(): void;
  dispose(): void;
}
```

| Member | Meaning |
|---|---|
| `raw` | The underlying `RawWebview` instance from `@n1h/sweetview-webview-bun`. |
| `window` | The `Window` hosting this webview. |
| `emit(name, payload)` | Delivers an event to the page by evaluating `__sweetview_emit(name, payload)`. A `payload` of `undefined` is sent as `null`. Listeners registered with `onEvent` do not see it. |
| `notify(method, ...params)` | Posts a fire-and-forget call (`seq: null`) to the worker, with `params` sent as `null` when omitted. `uiMethods` are not consulted. Without a worker, logs `sweetview: <method>: this window has no worker` with `console.error` and sends nothing. |
| `onEvent(fn)` | Registers `fn` for every event the worker sends, called before the page receives it. Returns an unsubscribe function. |
| `run()` | Runs the blocking OS loop until `quit()` is called, then terminates the worker, closes the drain callback, and destroys the webview. |
| `quit()` | Calls `webview_terminate`, causing `run()` to return. |
| `dispose()` | Tears down the worker, drain callback, and webview without running `run()`, for apps hosted under `runEventLoop`. On Windows, consumes the `WM_QUIT` that destroying a webview posts so other windows keep running. Call from a Bun turn (timer or after `await`), not from inside a `uiMethods` handler or window procedure. Idempotent. |

### WebView.attach

```ts
static async attach<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
  window: Window,
  options: WebViewOptions<M>,
): Promise<WebView<M, E>>
```

Mounts a webview inside an existing `Window` created by `new Window(...)` or `Window.fromHandle(...)`. Geometry (in DIPs), DPI scale, `resizable`, `transparent`, and default `title` are read directly from `window`, so callers never duplicate window options.

What `WebView.attach` does, in order:

1. Refuses any platform other than Windows and macOS before creating anything.
2. Resolves the webview library path from `WEBVIEW_PATH` or `@n1h/sweetview-webview-bun` (caching the `dlopen` handle per `libPath`).
3. Resolves either direct `url` mode (when `url` is set without `page` or `assets`) or asset/page mode (bundling `page`, reading `<title>`, and generating `indexHtml` if needed).
4. Creates the `RawWebview` inside `window.handle` using the window's bounds/scale and `resizable` hint.
5. Applies `title` (and mirrors it onto an untitled owned `window`).
6. Sets transparent browser background when `window` was created with `transparent: true`.
7. Allocates the shared `Ring` and drain `JSCallback`, and starts `worker` if configured.
8. Binds `__sweetview_rpc` with `uiMethods` consulted first, then `worker`.
9. Registers all assets via `webview_set_asset` and navigates to `${ASSET_ORIGIN}/${index}` (or navigates directly to `options.url`).

If any step after creating the webview throws, the worker is terminated, the drain callback is closed, and the webview is destroyed before rethrowing.

#### Errors

Throws:

- `Error` `sweetview: <platform> is not supported (win32 and darwin are): the native module has no backend for it and the webview library does not serve assets there` on unsupported OSes.
- `Error` `sweetview: the page bundle has no HTML output` when `page` has no `.html` output.
- `Error` `sweetview: cannot attach WebView to a window with a NULL handle` when `window.handle` is null or 0.
- `Error` `sweetview: webview_create failed for the given window (is the WebView2 runtime installed?)` on Windows (or without the WebView2 parenthetical on macOS).
- `Error` `sweetview: webview_set_background_color failed (<code>)` when transparency setup fails.
- `RangeError` `ring capacity must be a power of two between 16 and 2^30, got <value>` when `ringBytes` is out of range.
- `Error` `sweetview: this webview library has no webview_set_asset; it needs the library @n1h/sweetview-webview-bun ships (is WEBVIEW_PATH pointing at a stock one?)` when the symbol is missing.
- `Error` `sweetview: webview_set_asset(<path>) failed (<code>)` when an asset is rejected.

### WebView.openTab

```ts
static openTab<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
  window: Window,
  options: TabOptions<M>,
): Promise<Tab<M, E>>
```

Opens a new native tab hosting its own webview inside a tabbed `Window` created with `{ tabs: true }`:

- **Windows**: creates a child pane inside the custom Windows 11 tab-strip frame, attaches a WebView2 instance, hooks accelerator keys (`Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+1..9`, etc.) and `NewWindowRequested`, and wires native right-click menus (`Menu.popup`), tear-off dragging, and window merging.
- **macOS**: creates an `NSWindow` participating in AppKit window tabbing (`addTabbedWindow:ordered:`), attaches a `WKWebView`, keeps the tab bar visible, hooks load errors, and detaches message handlers cleanly on close.

Run the app under `runEventLoop()` (or `createApp({ tabs: true }).run()`).

### WebViewOptions

```ts
export type WebViewOptions<M extends MethodMap = MethodMap> = {
  page?: HTMLBundle;
  url?: string;
  title?: string;
  assets?: Record<string, Asset>;
  index?: string;
  worker?: URL | string;
  debug?: boolean;
  uiMethods?: UiMethods<M>;
  ringBytes?: number;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `page` | `HTMLBundle` | none | HTML import (`import index from "./index.html"`). Bundled with `Bun.build` under `bun run`, or read from embedded `files` in a compiled executable. |
| `url` | `string` | none | Direct URL to navigate to (such as `https://example.com`) when neither `page` nor `assets` is given. |
| `title` | `string` | `window`'s title, else `<title>` of `page`, else `Bun.main` basename | Window / tab title. |
| `assets` | `Record<string, Asset>` | `{}` | Extra files served at the page's origin by asset path. |
| `index` | `string` | the page's HTML output, else `"index.html"` | Asset path to navigate to. Generated via `indexHtml` if missing. |
| `worker` | `URL \| string` | none | Worker entry calling `hostService`. Relative strings resolve against `pathToFileURL(Bun.main)`. |
| `debug` | `boolean` | `false` | Enables devtools and the context menu. |
| `uiMethods` | `UiMethods<M>` | `{}` | Synchronous handlers answered on the UI thread before consulting the worker. |
| `ringBytes` | `number` | `1048576` | Capacity of the worker-to-UI shared-memory ring (power of two, `16..2^30`). |

### Tab and TabOptions

```ts
export type TabOptions<M extends MethodMap = MethodMap> = WebViewOptions<M> & {
  after?: TabHandle;
};

export interface Tab<M extends MethodMap = MethodMap, E extends EventMap = EventMap> extends TabHandle {
  readonly webview: WebView<M, E>;
  readonly window: Window;
  readonly title: string;
  setTitle(title: string): void;
  select(): void;
  close(): void;
  moveToNewWindow(): Promise<Window>;
  dispose(): void;
}
```

| Member | Meaning |
|---|---|
| `after` | Optional `TabHandle` (any `Tab`) to insert the new tab after instead of the currently selected tab. |
| `webview` | The `WebView` mounted inside this tab. |
| `window` | The `Window` currently hosting this tab (updates when torn off or merged). |
| `title` | Current tab title. |
| `setTitle(title)` | Updates the tab's title in the tab strip / title bar. |
| `select()` | Focuses and activates this tab (and its hosting window). |
| `close()` | Requests closing the tab. |
| `moveToNewWindow()` | Detaches the tab into its own tabbed window (keeping its webview state intact) and resolves with the new `Window`. |
| `dispose()` | Tears down the tab and its webview. |

### createApp

```ts
export async function createApp<M extends MethodMap = MethodMap, E extends EventMap = EventMap>(
  options: AppOptions<M>,
): Promise<App<M, E>>
```

Layer 2 declarative helper that combines `new Window(options)` with `WebView.attach` (or native tab setup when `options.tabs` is `true`).

- The window is created **hidden**; call `app.window.show()` once wired, or let `openTab()` show the tabbed window.
- When `options.tabs` is `false` (default) and `options.onClose` is not provided, closing the window automatically disposes it and calls `app.quit()` so `app.run()` exits cleanly.
- When `options.tabs` is `true`, `app.webview` is `undefined`, `app.openTab(...)` opens tabs inside `app.window`, `app.mergeAllWindows()` merges torn-off windows back into `app.window`, `app.run()` returns `runEventLoop()`, and `app.quit()` calls `quitEventLoop()`.
- If `WebView.attach` throws during `createApp`, the newly created `Window` is disposed before rethrowing.

### App and AppOptions

```ts
export type AppOptions<M extends MethodMap = MethodMap> = WindowOptions & WebViewOptions<M>;

export interface App<M extends MethodMap = MethodMap, E extends EventMap = EventMap> {
  readonly window: Window;
  readonly webview?: WebView<M, E>;
  openTab<TM extends MethodMap = M, TE extends EventMap = E>(options: TabOptions<TM>): Promise<Tab<TM, TE>>;
  mergeAllWindows(): void;
  emit<N extends keyof E & string>(name: N, payload: E[N]): void;
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  onEvent(fn: (event: AnyEvent<E>) => void): () => void;
  run(): void | Promise<void>;
  quit(): void;
  dispose(): void;
}
```

### Asset

```ts
export type Asset = string | Uint8Array | Blob;
```

The bytes served at one path of the page's origin. The Content-Type comes from the path's extension through `assetMime`.

| Variant | Served as |
|---|---|
| `string` | File path read with `Bun.file`. A path imported `with { type: "file" }` is embedded by `bun build --compile`. |
| `Uint8Array` | Raw bytes as given. |
| `Blob` | Blob bytes (`Bun.file(path)`, `Bun.build` outputs, `indexHtml(...)`, or `new Blob([text])`). |

### UiMethods

```ts
export type UiMethods<M extends MethodMap> = { [K in keyof M & string]?: (params: M[K][0]) => M[K][1] };
```

Synchronous methods answered on the UI thread instead of by the worker. Returning a Promise is rejected with `<method>: a UI-thread method must return synchronously; this one returned a Promise`. Throwing rejects the page's call with the error's message.

### assetMime

```ts
export const assetMime = (path: string): string
```

Returns the Content-Type for an asset path from its lowercased extension (`html`, `js`, `mjs`, `css`, `json`, `map`, `txt`, `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`, `woff2`, `ttf`, `wasm`, `glb`, `gltf`, `mp3`, `ogg`, `wav`; fallback `application/octet-stream`).

### indexHtml

```ts
export function indexHtml({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' }: IndexHtmlOptions): Blob
```

Builds an HTML5 index document as a `Blob` (`text/html; charset=utf-8`) linking `css` (when non-empty) and loading `js` as a module script. `title`, `js`, and `css` are HTML-escaped; `head` and `body` are inserted verbatim.

### indexHtmlText

```ts
export function indexHtmlText(options: IndexHtmlOptions): string
```

Same document as `indexHtml`, returned as a string.

### IndexHtmlOptions

```ts
export type IndexHtmlOptions = {
  title: string;
  js?: string;
  css?: string;
  head?: string;
  body?: string;
};
```

### windowChromeMethods

Re-exported from [`@n1h/sweetview/window-chrome`](window-chrome.md) together with `WindowChromeInfo`, `WindowChromeKind`, `WindowChromeMethodTable`, `WindowChromeMethods`, and `WindowChromeOptions`.

### Ring

```ts
export class Ring {
  static create(capacity: number): SharedArrayBuffer;
  constructor(sab: SharedArrayBuffer);
  get capacity(): number;
  write(bytes: Uint8Array): void;
  claimWakeup(): boolean;
  acknowledgeWakeup(): void;
  *drain(): Generator<Uint8Array>;
}
```

Single-producer, single-consumer byte ring over a `SharedArrayBuffer` (16-byte header + power-of-two capacity `16..2^30`). Each frame has a 4-byte little-endian length prefix. `write` blocks with `Atomics.wait` while full; `drain` yields frames without blocking.

### Event loop re-exports

`pumpEvents`, `quitEventLoop`, `runEventLoop`, `setActivationPolicy`, `ActivationPolicy`, and `EventLoopOptions` are re-exported from [`@n1h/sweetview/native`](native.md#event-loop).

### SizeHint, WEBVIEW_VERSION, RawWebview

Re-exported from `@n1h/sweetview-webview-bun` (`Webview` is re-exported as `RawWebview` to avoid colliding with sweetview's `WebView`).

## Page loading

`WebView.attach` registers every asset with `webview_set_asset` and navigates to the origin plus `/${index}`:

| OS | Origin | Served by |
|---|---|---|
| Windows | `http://webview.localhost` | `WebResourceRequested` filter (nothing reaches the network) |
| macOS | `webview://localhost` | `WKURLSchemeHandler` for the `webview` scheme |
| Linux | `http://webview.localhost` | Unsupported (`WebView.attach` throws before creating anything) |

The native library path comes from `WEBVIEW_PATH` or `@n1h/sweetview-webview-bun/build/`, and `dlopen` handles are cached per path so repeated windows/tabs never leak library handles. See [the webview library](webview-library.md).

## Transport

| Direction | Mechanism |
|---|---|
| page to UI thread | `__sweetview_rpc(method, params)` bound via `webview_bind` |
| UI thread to worker | `worker.postMessage` (synchronous enqueue) |
| worker to UI thread | JSON frames in shared `Ring` + `webview_dispatch` wakeup |
| UI thread to page (replies) | `webview_return(seq, status, json)` |
| UI thread to page (events) | `webview_eval` of `__sweetview_emit(name, payload)` |

## Examples

### Single window with `createApp`

```ts
import { createApp } from "@n1h/sweetview";
import index from "./index.html";

type Methods = { "notes.list": [void, string[]]; "window.size": [void, number] };
type Events = { "notes.changed": { count: number } };

const app = await createApp<Methods, Events>({
  title: "Notes",
  bounds: { x: 120, y: 120, width: 1000, height: 720 },
  page: index,
  worker: "./app-worker.ts",
  uiMethods: { "window.size": () => 800 },
});

app.onEvent((event) => console.log(event.name, event.payload.count));
app.notify("notes.list");
app.window.show();
app.run();
```

### Multi-tab app

```ts
import { createApp } from "@n1h/sweetview";
import tabPage from "./tab.html";

const app = await createApp({
  title: "Tabbed App",
  bounds: { x: 100, y: 100, width: 1040, height: 760 },
  tabs: true,
});

const open = () => app.openTab({ page: tabPage, title: "New Tab" });
app.window.onNewTab(() => { void open(); });
app.window.onClose(() => app.quit());

await open();
await app.run();
app.dispose();
```
