# @n1h/sweetview

The root module opens a webview window, serves the page to it, and connects
the page to a worker that hosts the application's `Service`. It runs on the
UI thread: the main thread of the Bun process, which `run()` hands to the OS
event loop. Install and the overview are in the [package README](../README.md).

```ts
import { createWebviewApp, type Asset, type UiMethods, type WebviewApp, type WebviewAppOptions, assetMime, indexHtml, indexHtmlText, type IndexHtmlOptions, windowChromeMethods, type WindowChromeInfo, type WindowChromeKind, type WindowChromeMethodTable, type WindowChromeMethods, type WindowChromeOptions, Ring, SizeHint, WEBVIEW_VERSION, Webview, runEventLoop, pumpEvents, setActivationPolicy, type EventLoopOptions, type ActivationPolicy } from "@n1h/sweetview";
```

## An app with no window

A menu-bar or tray app has no page to show, so it does not call `createWebviewApp` at all. It creates its tray and notifier from `@n1h/sweetview/native` and runs the OS loop with `runEventLoop`, which pumps OS events from Bun's own event loop; `setTimeout`, promises and I/O then work on the UI thread and no worker is needed. `setActivationPolicy("accessory")` keeps it out of the macOS Dock. All three are also exported from the root module. The reference is under [Event loop](native.md#event-loop) and [App activation](native.md#app-activation); `demos/menubar-only/` is the smallest such app.

## Reference

### createWebviewApp

```ts
export async function createWebviewApp<M extends MethodMap, E extends EventMap>(options: WebviewAppOptions<M>): Promise<WebviewApp<M, E>>
```

Opens a window, serves the page in it and connects the page to the worker
that hosts the application's `Service`. `M` and `E` are the method and event
maps from the [ipc reference](ipc.md). The window loop does not run until
`run()` is called on the result.

What the call does, in order:

1. Refuses any platform other than Windows and macOS, before anything is
   created.
2. Resolves the webview library path, from `WEBVIEW_PATH` or the peer
   dependency.
3. Resolves the page. With `page`: bundles the HTML import under `bun run`,
   or takes the embedded outputs inside a compiled executable, and reads the
   `<title>` of the index. Without an index in `assets`, generates one with
   `indexHtml`.
4. Creates the webview, in the caller's window when `window` is given, and
   sets the title.
5. Sets the background to transparent when `transparent` is set.
6. Allocates the ring and the drain callback.
7. Starts the worker and posts it the ring, the webview handle, the drain
   callback pointer and the library path.
8. Binds `__sweetview_rpc` into the page, with `uiMethods` consulted first.
9. Registers every asset with the library and navigates to the index.

When a step after the webview exists throws, the webview is destroyed and
the error rethrown. When the step is one after the worker started (binding,
asset registration, navigation), the worker is terminated and the drain
callback released first: worker, drain callback, webview.

#### Options

```ts
export type WebviewAppOptions<M extends MethodMap> = {
  page?: HTMLBundle;
  title?: string;
  assets?: Record<string, Asset>;
  index?: string;
  worker?: URL | string;
  width?: number;
  height?: number;
  debug?: boolean;
  transparent?: boolean;
  window?: WindowHandle;
  resizable?: boolean;
  uiMethods?: UiMethods<M>;
  ringBytes?: number;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `page` | `HTMLBundle` | none | An HTML import, `import index from "./index.html"`. Under `bun run` the host bundles it at start-up with `Bun.build` for the browser target, minified. Inside a `bun build --compile` executable the outputs are embedded and listed on the import's `files`; each is read with `Bun.file`. Every output is served at the page's origin by its file name. The output with the `.html` extension is the index. |
| `title` | `string` | the `<title>` of the index, else the file name of `Bun.main` without its extension | The window title. The `<title>` is read only when `page` is given, with `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;` decoded and surrounding whitespace trimmed; an empty `<title>` falls through to the file name. |
| `assets` | `Record<string, Asset>` | `{}` | Files served at the page's origin by asset path, in addition to the page's outputs: models, images, data the page fetches by relative URL. Without `page`, the whole page goes here, by convention `main.js` and `main.css`. A page output replaces an asset of the same path. |
| `index` | `string` | the page's HTML output, else `"index.html"` | The asset path the webview navigates to. When it is absent from `assets` and the page's outputs, `indexHtml({ title, css })` generates it, with `css` set to `main.css` only when that asset is present. |
| `worker` | `URL \| string` | none | The worker entry, which must call `hostService` from the [worker reference](worker.md). A `URL` is used as given. A string with a scheme is parsed as a URL. A string without one is resolved against `pathToFileURL(Bun.main)`, so `"./worker.ts"` names the file beside the UI-thread entry. Pass that file to `bun build --compile` as the second entry point; the same string then resolves inside the executable. Without `worker`, a page call to a method not in `uiMethods` is rejected. |
| `width` | `number` | `1100`, or `320` with `window` | Client width. |
| `height` | `number` | `800`, or `240` with `window` | Client height. |
| `debug` | `boolean` | `false` | Enables devtools and the context menu. |
| `transparent` | `boolean` | `false` | Sets the browser's background colour to alpha 0, so a page with `background: transparent` shows what is behind the window. Pair it with `createOverlayWindow({ transparent: true })` from the [native reference](native.md). With a library that lacks `webview_set_background_color`, a warning is logged with `console.warn` and the page stays opaque. |
| `window` | `WindowHandle` | none | Hosts the browser in a window created by the caller, such as `createOverlayWindow` from the [native reference](native.md), instead of a window the library creates. The caller shows the window and ends the run loop when the window is destroyed. On Windows, COM must be initialised as an STA on this thread; `createOverlayWindow` does that. |
| `resizable` | `boolean` | `false` | With `window`, keeps the window resizable. Ignored without `window`. |
| `uiMethods` | `UiMethods<M>` | `{}` | Methods answered on the UI thread. A method listed here never reaches the worker. |
| `ringBytes` | `number` | `1048576` | Capacity of the ring that carries worker frames to the UI thread. It must be an integer power of two between 16 and 1073741824. A frame longer than `ringBytes - 4` bytes cannot be sent. The worker blocks while the ring is full. |

The size hint passed to the library follows from `window` and `resizable`:

| `window` | `resizable` | Size hint |
|---|---|---|
| not given | any | `SizeHint.NONE` |
| given | `false` | `SizeHint.FIXED` |
| given | `true` | `SizeHint.NONE` |

Platforms: with `window`, Windows applies `width` and `height` to the window
as DIPs. For an overlay, pass the window's size divided by its scale. For a
framed window, they are the client area and the library sizes the frame
around it. macOS ignores them.

Platforms: `transparent` works on Windows and macOS with the library from
`@n1h/sweetview-webview-bun`. See the [webview library](webview-library.md).

#### The returned app

```ts
export type WebviewApp<M extends MethodMap, E extends EventMap> = {
  readonly webview: Webview;
  readonly window: NativeWindow;
  readonly windowHandle: WindowHandle;
  emit<N extends keyof E & string>(name: N, payload: E[N]): void;
  call<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  onEvent(fn: (event: AnyEvent<E>) => void): () => void;
  run(): void;
  quit(): void;
};
```

| Field | Type | Meaning |
|---|---|---|
| `webview` | `Webview` | The underlying webview instance. |
| `window` | `NativeWindow` | Visibility, show, hide, toggle, the window icon and close handling for `windowHandle`, from the [native reference](native.md). |
| `windowHandle` | `WindowHandle` | `options.window` when given. Otherwise the window the library created: an HWND on Windows, an `NSWindow*` on macOS. |
| `emit(name, payload)` | `void` | Delivers an event to the page by evaluating `__sweetview_emit(name, payload)`. A `payload` of `undefined` is sent as `null`. Listeners registered with `onEvent` do not see it. |
| `call(method, ...params)` | `void` | Posts a call with no reply to the worker, with `params` sent as `null` when omitted. `uiMethods` are not consulted. Whatever the `Service` emits in response arrives as events. Without a worker, it logs `sweetview: <method>: this window has no worker` with `console.error` and sends nothing. |
| `onEvent(fn)` | `() => void` | Registers `fn` for every event the worker sends, called before the page receives it. Returns a function that removes `fn`. |
| `run()` | `void` | Runs the OS loop. Returns when `quit()` is called or, without `window`, when the window closes. With `window`, the caller ends the loop; on Windows `createOverlayWindow` ends it when its window is destroyed. This app's worker is then terminated, the drain callback released and the webview destroyed, in that order. |
| `quit()` | `void` | Calls `webview_terminate`, which makes `run()` return. |

Thread: every member runs on the UI thread. `run()` blocks that thread and
Bun's event loop until it returns, so promises, timers and other asynchronous
callbacks on the UI thread do not run in the meantime.

Code on the UI thread after `run()` starts runs only inside callbacks from
the OS loop: `uiMethods`, `onEvent` listeners and native callbacks. After
`run()` returns, `webview`, `emit` and `quit` must not be used.

One process has one OS loop. With several windows, call `createWebviewApp`
once per window and `run()` on one of them. The other windows live in the
same loop. `run()` terminates the worker and destroys the webview of the app
it was called on only.

#### Errors

Throws:

- `Error` `sweetview: <platform> is not supported (win32 and darwin are): the native module has no backend for it and the webview library does not serve assets there` on any platform other than Windows and macOS, before anything is created.
- `Error` `sweetview: the page bundle has no HTML output` when `page` yields no output with the `.html` extension.
- `Error` `sweetview: webview_create failed for the given window (is COM initialised as an STA on this thread? createOverlayWindow in @n1h/sweetview/native does that)` when `webview_create` fails with `window`.
- `Error` `sweetview: webview_create failed (is the WebView2 runtime installed?)` when `webview_create` fails without `window`.
- `Error` `sweetview: webview_set_background_color failed (<code>)` when `transparent` is set and the call returns a non-zero code.
- `RangeError` `ring capacity must be a power of two between 16 and 2^30, got <value>` when `ringBytes` is out of range.
- `Error` `sweetview: this webview library has no webview_set_asset; it needs the library @n1h/sweetview-webview-bun ships (is WEBVIEW_PATH pointing at a stock one?)` when the library lacks the symbol. The page cannot load without it.
- `Error` `sweetview: webview_set_asset(<path>) failed (<code>)` when the library rejects an asset.
- The read error when a string or `Blob` asset, or the index read for the title, cannot be read, such as a missing file.
- The build error from `Bun.build` when the page fails to bundle under `bun run`.
- `TypeError` from `new URL` when `worker` is a string with a scheme that is not a valid URL.
- The import error when the webview library file is missing from `@n1h/sweetview-webview-bun`.

Platforms: Windows and macOS. The page is served at the origin listed under
[Page loading](#page-loading).

Thread: call on the UI thread, before `run()`. Every asynchronous step of the
setup happens inside this call. Tray icons, notifications, dialogs and other
windows from the [native reference](native.md) are created on the same
thread, between this call and `run()`.

### Asset

```ts
export type Asset = string | Uint8Array | Blob;
```

The bytes served at one path of the page's origin. The Content-Type comes
from the path's extension through `assetMime`.

| Variant | Served as |
|---|---|
| `string` | A file path. The file is read with `Bun.file` during `createWebviewApp`. A path imported `with { type: "file" }` is embedded by `bun build --compile`, so the import's value is the usual asset. |
| `Uint8Array` | The bytes as given. |
| `Blob` | The blob's bytes, read during `createWebviewApp`. `Bun.file(path)`, the outputs of `Bun.build` and the value `indexHtml` returns are Blobs. Inline text is `new Blob([text])`. |

### UiMethods

```ts
export type UiMethods<M extends MethodMap> = { [K in keyof M & string]?: (params: M[K][0]) => M[K][1] };
```

Methods of `M` answered on the UI thread instead of by the worker. Native
dialogs and window state belong here.

| Field | Type | Meaning |
|---|---|---|
| any method name of `M` | `(params: M[K][0]) => M[K][1]` | Called with the page's `params`. The return value is sent to the page as JSON, with `undefined` sent as `null`. A thrown error rejects the page's call with the error's message. |

Thread: runs on the UI thread, inside the OS loop, and must return
synchronously. A method that returns a Promise is not awaited; the page's
call rejects with `<method>: a UI-thread method must return synchronously;
this one returned a Promise`.

### WebviewApp

The window `createWebviewApp` returns; documented under
[the returned app](#the-returned-app).

### WebviewAppOptions

The options of `createWebviewApp`; documented under [Options](#options).

### assetMime

```ts
export const assetMime = (path: string): string
```

Returns the Content-Type for an asset path, from the text after the path's
last `.`, compared in lower case. A path without `.` is compared whole.

| Extension | Content-Type |
|---|---|
| `html` | `text/html; charset=utf-8` |
| `js`, `mjs` | `text/javascript; charset=utf-8` |
| `css` | `text/css; charset=utf-8` |
| `json`, `map` | `application/json` |
| `txt` | `text/plain; charset=utf-8` |
| `svg` | `image/svg+xml` |
| `png` | `image/png` |
| `jpg`, `jpeg` | `image/jpeg` |
| `gif` | `image/gif` |
| `webp` | `image/webp` |
| `ico` | `image/x-icon` |
| `woff` | `font/woff` |
| `woff2` | `font/woff2` |
| `ttf` | `font/ttf` |
| `wasm` | `application/wasm` |
| `glb` | `model/gltf-binary` |
| `gltf` | `model/gltf+json` |
| `mp3` | `audio/mpeg` |
| `ogg` | `audio/ogg` |
| `wav` | `audio/wav` |
| anything else | `application/octet-stream` |

Returns: the Content-Type string.

### indexHtml

```ts
export function indexHtml({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' }: IndexHtmlOptions): Blob
```

Builds an index document that links one stylesheet and loads one module
script, both by asset path, as a `Blob` of type `text/html; charset=utf-8`,
ready for the asset map. Nothing is inlined, so the document stays small
whatever the bundle's size.

| Field | Type | Default | Meaning |
|---|---|---|---|
| options | `IndexHtmlOptions` | required | See `IndexHtmlOptions` below. |

Returns: an HTML5 document with `lang="en"`, a UTF-8 charset and a
device-width viewport. `title`, `js` and `css` are HTML-escaped (`&`, `<`,
`>`, `"`); `head` and `body` are inserted as given. The module script is the
last element of `<body>`.

### indexHtmlText

```ts
export function indexHtmlText({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' }: IndexHtmlOptions): string
```

The same document as `indexHtml` builds, returned as a string instead of a
`Blob`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| options | `IndexHtmlOptions` | required | See `IndexHtmlOptions` below. |

Returns: the document as a string.

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

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | `string` | required | The document title. |
| `js` | `string` | `"main.js"` | Asset path of the page bundle, loaded as a module. |
| `css` | `string` | `"main.css"` | Asset path of the stylesheet. `""` omits the `<link>`. |
| `head` | `string` | `""` | Extra markup for `<head>`. |
| `body` | `string` | `'<div id="root"></div>'` | Markup for `<body>`, placed before the script. |

### windowChromeMethods

```ts
export function windowChromeMethods(window: Overlay, options: WindowChromeOptions = {}): WindowChromeMethodTable
```

The same function as [`windowChromeMethods`](window-chrome.md#windowchromemethods-1)
in `@n1h/sweetview/window-chrome`. Its return type `WindowChromeMethodTable`
is exported from both modules.

### WindowChromeInfo

```ts
export type WindowChromeInfo = { chrome: WindowChromeKind; maximized: boolean };
```

Documented in the [window-chrome reference](window-chrome.md#windowchromeinfo).

### WindowChromeKind

```ts
export type WindowChromeKind = "page" | "os";
```

Documented in the [window-chrome reference](window-chrome.md#windowchromekind).

### WindowChromeMethodTable

```ts
export type WindowChromeMethodTable = { [K in keyof WindowChromeMethods]: (params: WindowChromeMethods[K][0]) => WindowChromeMethods[K][1] };
```

The `uiMethods` table `windowChromeMethods` returns: one synchronous handler
per method of `WindowChromeMethods`. Documented in the
[window-chrome reference](window-chrome.md#windowchromemethodtable).

### WindowChromeMethods

```ts
export type WindowChromeMethods = {
  "window.info": [void, WindowChromeInfo];
  "window.drag": [void, void];
  "window.resize": [ResizeEdge, void];
  "window.minimize": [void, void];
  "window.maximize": [void, void];
  "window.close": [void, void];
};
```

Documented in the [window-chrome reference](window-chrome.md#windowchromemethods).
`ResizeEdge` is documented in the [native reference](native.md).

### WindowChromeOptions

```ts
export type WindowChromeOptions = {
  chrome?: WindowChromeKind;
  close?: () => void;
};
```

Documented in the [window-chrome reference](window-chrome.md#windowchromeoptions).

### Ring

```ts
export class Ring {
  static create(capacity: number): SharedArrayBuffer;
  constructor(sab: SharedArrayBuffer);
  get capacity();
  write(bytes: Uint8Array): void;
  claimWakeup(): boolean;
  acknowledgeWakeup(): void;
  *drain(): Generator<Uint8Array>;
}
```

A single-producer, single-consumer byte ring over a `SharedArrayBuffer`. The
worker writes frames and the UI thread drains them.

Each frame is stored as a 4-byte little-endian length followed by its bytes.
The buffer holds a 16-byte header before the data: the write cursor, the
read cursor and the wakeup flag.

| Field | Type | Meaning |
|---|---|---|
| `Ring.create(capacity)` | `SharedArrayBuffer` | Allocates a buffer of `16 + capacity` bytes. |
| `new Ring(sab)` | `Ring` | Wraps a buffer from `Ring.create`. Producer and consumer each wrap the same buffer. |
| `capacity` | `number` | Data bytes, excluding the header. |
| `write(bytes)` | `void` | Producer side. Appends one frame. Blocks with `Atomics.wait` while the ring lacks room for it. |
| `claimWakeup()` | `boolean` | Producer side. Sets the wakeup flag. Returns `true` when it was clear, so the caller sends one wakeup per burst. |
| `acknowledgeWakeup()` | `void` | Consumer side. Clears the wakeup flag. Call it first in the wakeup, before draining. |
| `drain()` | `Generator<Uint8Array>` | Consumer side. Yields every complete frame present when it starts, in write order, and frees each frame's space as it is yielded. Never blocks. |

Throws:

- `RangeError` `ring capacity must be a power of two between 16 and 2^30, got <value>` from `Ring.create` and the constructor.
- `RangeError` `frame of <n> bytes exceeds ring capacity <capacity>` from `write` when `4 + bytes.length` exceeds `capacity`.

Thread: `write` blocks the calling thread while the ring is full. Exactly one
thread writes and exactly one thread drains.

### SizeHint

```ts
export const enum SizeHint { NONE, MIN, MAX, FIXED }
```

Re-exported from `@n1h/sweetview-webview-bun`. The size hint of a webview
window.

| Value | Number | Meaning |
|---|---|---|
| `NONE` | 0 | Width and height are the default size. |
| `MIN` | 1 | Width and height are the minimum bounds. |
| `MAX` | 2 | Width and height are the maximum bounds. |
| `FIXED` | 3 | The user cannot change the size. |

### WEBVIEW_VERSION

```ts
export const WEBVIEW_VERSION = "0.12.0";
```

Re-exported from `@n1h/sweetview-webview-bun`: the webview library version
the bindings declare.

### Webview

```ts
export class Webview
```

Re-exported from `@n1h/sweetview-webview-bun`, which documents it at
https://github.com/n0t-invented-here/sweetview-webview-bun. `WebviewApp.webview`
is an instance.

The root module imports `@n1h/sweetview-webview-bun` at load time, which
opens the library, so importing `@n1h/sweetview` fails when that optional
peer dependency is not installed.

Thread: UI thread. Call `run()` on the `WebviewApp`, not on its `webview`:
`Webview.run()` destroys the webview without terminating the worker.

## Page loading

The page is never passed to `webview_set_html`. `createWebviewApp` hands each
asset to the library's `webview_set_asset`, with the path, `assetMime(path)`
and the bytes. The library copies the bytes. After the last asset it
navigates the webview to the origin followed by `/` and `index`.

Relative URLs in the page resolve against that origin, so scripts, styles,
`fetch` and images load from the page's outputs and `assets`.

| OS | Origin | Served by |
|---|---|---|
| Windows | `http://webview.localhost` | A `WebResourceRequested` filter. Nothing reaches the network. |
| macOS | `webview://localhost` | A `WKURLSchemeHandler` for the `webview` scheme. |
| Linux | `http://webview.localhost` | Nothing. `createWebviewApp` throws on Linux before any asset is registered. |

The webview library is the file at the `WEBVIEW_PATH` environment variable
when it is set. Otherwise it is the file `@n1h/sweetview-webview-bun` ships
for the platform:

| OS | Library file |
|---|---|
| Windows | `@n1h/sweetview-webview-bun/build/libwebview.dll` |
| macOS | `@n1h/sweetview-webview-bun/build/libwebview.dylib` |
| Linux | `@n1h/sweetview-webview-bun/build/libwebview-<arch>.so` |

The `Webview` class resolves the same path, and `createWebviewApp` sends it
to the worker, so the process loads one library. `bun build --compile`
embeds the shipped file. `createWebviewApp` probes for the two symbols that
the shipped library adds to the stock one:

| Symbol | When absent | When it returns non-zero |
|---|---|---|
| `webview_set_asset` | Throws `Error`. A `WEBVIEW_PATH` that points at a stock library ends here. | Throws `Error` naming the asset path. |
| `webview_set_background_color` | Only probed with `transparent`. Logs a warning with `console.warn` and the page stays opaque. | Throws `Error`. |

The C API of both symbols is in the [webview library](webview-library.md).

## Transport

`run()` blocks the UI thread and Bun's event loop with it, so the worker owns
the event loop and the `Service`. Three parties talk over five paths:

| Direction | Mechanism |
|---|---|
| page to UI thread | The page calls `__sweetview_rpc(method, params)`, bound with `webview_bind`. It returns a Promise. |
| UI thread to worker | `worker.postMessage`: one init message carrying the ring, the webview handle, the drain callback pointer and the library path, then one call frame per call. It is a synchronous enqueue, so it works while the UI thread is in the OS loop. |
| worker to UI thread | Reply and event frames as JSON in the shared `Ring`. The worker wakes the UI thread with `webview_dispatch`, at most once per burst, and the dispatched callback drains the ring inside the OS loop. |
| UI thread to page, replies | `webview_return(seq, status, json)`. Status 0 resolves the page's Promise with the result. Status 1 rejects it with `{ message }`. |
| UI thread to page, events | `webview_eval` of `__sweetview_emit(name, payload)`. |

A page call goes to the first of these that applies:

| Condition | Answer |
|---|---|
| `uiMethods` has the method as an own property with a truthy value | The function runs on the UI thread and its result or error goes straight back with `webview_return`. |
| `worker` was given | A call frame with the page's `seq` goes to the worker. The worker's reply frame is returned with `webview_return`. |
| neither | The call is rejected with `<method>: this window has no worker and no UI-thread method of that name`. |

Each event frame from the worker goes to every `onEvent` listener first and
then to the page. The worker side is in the [worker reference](worker.md),
the page side in the [page reference](page.md), and the frame types in the
[ipc reference](ipc.md).

## Example

```ts
import { createWebviewApp } from "@n1h/sweetview";
import index from "./index.html";

type Methods = { "notes.list": [void, string[]]; "window.size": [void, number] };
type Events = { "notes.changed": { count: number } };

const app = await createWebviewApp<Methods, Events>({
  page: index,
  worker: "./app-worker.ts",
  uiMethods: { "window.size": () => 800 },
});

app.onEvent((event) => console.log(event.name, event.payload.count));
app.call("notes.list");
app.run();
```
