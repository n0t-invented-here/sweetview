# @n1h/sweetview

The root module mounts a webview inside a native `Window`, serves bundled pages
or assets to it, connects the page to an optional worker that hosts the
application's `Service`, and provides built-in native tabs and the Layer 2
`createApp` helper. It runs on the UI thread: the main thread of the Bun
process. Install and the overview are in the [package README](../README.md).

Each section below imports what it uses. On Windows the webview is WebView2
driven by the Rust binding that ships inside `@n1h/sweetview-native`; nothing
else is installed. On macOS, until the macOS goal of the Rust rewrite, the
root module requires the native webview library from the optional peer
`@n1h/sweetview-webview-bun` ([the webview](webview-library.md)).
`WebView.attach` and `createApp` support Windows and macOS.

Most apps need one call and one loop: `createApp` with a `page` and a
`worker`, shown when the page signals ready (`showOnReady`, with `readyTimeoutMs`
for a page that fails first), then `app.run()`, as in the
[Quickstart](../README.md#quickstart) and the
[single-window example](#single-window-with-createapp). Read
[the event loop](#the-event-loop) first: which loop an app runs decides where
its logic lives. The [Reference](#reference) then covers each export once.

- [The event loop](#the-event-loop)
  - [`run()`: the blocking loop](#run-the-blocking-loop)
  - [`runEventLoop`: the loop on a Bun timer](#runeventloop-the-loop-on-a-bun-timer)
  - [Choosing](#choosing)
  - [The end of the application](#the-end-of-the-application)
- [Reference](#reference)
  - [WebView](#webview)
  - [WebView.attach](#webviewattach)
  - [WebView.openTab](#webviewopentab)
  - [WebViewOptions](#webviewoptions)
  - [Tab and TabOptions](#tab-and-taboptions)
  - [createApp](#createapp)
    - [Closing and quitting](#closing-and-quitting)
  - [App and AppOptions](#app-and-appoptions)
  - [Asset](#asset)
  - [UiMethods](#uimethods)
  - [assetMime](#assetmime)
  - [indexHtml, indexHtmlText and IndexHtmlOptions](#indexhtml)
  - [windowChromeMethods](#windowchromemethods)
  - [Ring](#ring)
  - [Event loop re-exports](#event-loop-re-exports)
  - [Activation and identity re-exports](#activation-and-identity-re-exports)
  - [SizeHint, WEBVIEW_VERSION, RawWebview](#sizehint-webview_version-rawwebview)
- [Page loading](#page-loading)
  - [The RPC trust boundary](#the-rpc-trust-boundary)
- [Startup and deferred UI](#startup-and-deferred-ui)
- [Dynamic requests](#dynamic-requests)
- [Exceptions in page calls, requests and the worker](#exceptions-in-page-calls-requests-and-the-worker)
- [Transport](#transport)
- [Examples](#examples)

## The event loop

One process has one OS event loop, on the UI thread, the main thread of the Bun process. Every window, tray, notifier and menu is created on that thread and every handler runs on it, from inside the loop, while the loop is on the stack: a handler returns quickly and cannot wait for anything that needs the loop to turn. There are two ways to run the loop, and an app uses exactly one.

### `run()`: the blocking loop

`webview.run()` (and `app.run()` on a non-tabbed app) runs the platform's own blocking loop: on Windows the Rust runtime's loop (`tao`'s, with Sweetview's signal window for wakes and timers); on macOS, until the macOS goal of the Rust rewrite, the webview library's `webview_run`, which is `[NSApp run]`. It returns when `quit()` is called, or when the window the webview is attached to is disposed (closing a window with no `onClose` listener disposes it). When `run()` returns, it tears its own webview down: the worker is terminated, the drain callback released, and the webview destroyed, in that order. Everything else the application made (its window, trays, notifiers, other windows) stays until the application's process ends, so code after `run()` and a second `run()` can still use it ([the end of the application](#the-end-of-the-application)). How `createApp` decides when to quit is under [Closing and quitting](#closing-and-quitting).

Calling `app.dispose()`, `view.dispose()` or `win.dispose()` while `run()` is active (from a `uiMethods` handler, a tray or menu click, or a window callback) never tears the native window or webview down re-entrantly inside the running loop. It stops the worker and the watchdogs and requests loop exit with `quit()`; the webview is destroyed and the native window released as `run()` unwinds.

While `run()` runs, Bun's event loop on the UI thread does not turn: no `setTimeout`, no promise continuation, no I/O completes there. That is why a single-window app using `run()` keeps its async logic in a worker, which owns Bun's event loop; the page talks to the worker through the UI thread and the shared ring, and the worker wakes the UI thread (through the Rust binding on Windows, the webview library's `webview_dispatch` on macOS). Code on the UI thread after `run()` starts runs only inside callbacks: `uiMethods`, `onEvent` listeners, tray and menu handlers, window callbacks, and notification clicks.

### `runEventLoop`: the loop on a Bun timer

`runEventLoop` from `@n1h/sweetview/native` (also re-exported from `@n1h/sweetview`) never blocks. Every `intervalMs` (default 16) it calls `pumpEvents`, which dispatches every OS event waiting for the thread and returns: the Rust runtime's pump of `tao`'s loop on Windows, `nextEventMatchingMask:` / `sendEvent:` on macOS with `finishLaunching` once. Between pumps the thread is Bun's, so `setTimeout`, promises and I/O work on the UI thread and the app needs no worker. The returned promise resolves when `quitEventLoop()` is called, or when the OS ends the loop (`WM_QUIT` on Windows). A click reaches its handler at most one interval late; a menu, once open, tracks at native speed inside the pump.

A worker is therefore required for async work in a `run()` app, and optional under `runEventLoop()`: the `worker` option still works there, but the UI thread can also run the app's logic itself.

Tabbed apps (`createApp({ tabs: true })`) use `runEventLoop()` automatically so `openTab()` (which is async) and per-tab `dispose()` work while the app is running. Single-window apps can also host a `Window` + `WebView.attach` under `await runEventLoop()` and call `view.dispose()` and `win.dispose()` afterward.

The page below is two in-memory assets: `index.html` from `indexHtml` (with
`css: ""`, so it links no stylesheet) and the `main.js` it loads, which
installs the `__sweetview_emit` receiver that `view.emit` calls. A bundled
page gets the same receiver from `webviewTransport()` and `bridge.on`
([page](page.md)).

```ts
import { WebView, indexHtml, quitEventLoop, runEventLoop } from "@n1h/sweetview";
import { Tray, Window } from "@n1h/sweetview/native";

const mainJs = new Blob([
  `window.__sweetview_emit = (name, payload) => {
     if (name === "tick") document.getElementById("tick").textContent = new Date(payload).toLocaleTimeString();
   };`,
]);

const win = new Window({ title: "Hello", bounds: { x: 200, y: 200, width: 640, height: 480 } });
const view = await WebView.attach(win, {
  assets: {
    "index.html": indexHtml({ title: "Hello", css: "", body: '<h1>Hello</h1><p id="tick"></p>' }),
    "main.js": mainJs,
  },
});
const tray = new Tray({
  tooltip: "Hello",
  menu: () => [
    { label: "Show", click: () => win.show() },
    { label: "Quit", click: quitEventLoop },
  ],
});
win.show();
// unref(): the application's own timer does not keep the process alive after Quit.
setInterval(() => view.emit("tick", Date.now()), 1000).unref();
await runEventLoop();
```

Bun exits when nothing keeps its event loop alive. Nothing Sweetview makes
does once the loop has ended: after Quit the script ends, and Sweetview
releases the tray, the webview and the window as the process exits
([the end of the application](#the-end-of-the-application)). A timer or
other handle of the application's own still counts: `unref()` it, as above,
or clear it. That is Windows; macOS, until the macOS goal of the Rust rewrite,
is under [the end of the application](#the-end-of-the-application).

### Choosing

| | `webview.run()` | `runEventLoop()` |
|---|---|---|
| Loop | the platform's blocking loop | pumped from a Bun timer |
| Bun on the UI thread | blocked: timers, promises, I/O wait | alive |
| App logic | in a worker | on the UI thread, or in a worker if you want one |
| Ends when | `quit()` (or main window closes in `createApp`) | `quitEventLoop()`, or `WM_QUIT` |
| Cleanup | automatic: on return, and at exit (Windows) | automatic: when the script ends, at exit (Windows) |
| Idle cost | none | one wake per interval, about 0.5 % CPU at 16 ms |
| Worker | required for async logic | optional |
| Native tabs | no | yes (`createApp({ tabs: true }).run()` uses this) |

### The end of the application

An application's last line is `app.run()` (or `webview.run()`), or under
`runEventLoop` the end of its script. Nothing after it is required: no
`dispose()`, no `process.exit()`. When the application's process ends,
Sweetview releases everything it made that is still alive, and nothing of
Sweetview keeps the process from ending: after Quit the script's last line
runs, and the process ends by itself, a few milliseconds later, with the exit
code the application set (0 unless it set another).

The release happens once, when the process ends for any reason Bun reports to
JavaScript through its `exit` event: the script ends, `process.exit(code)` is
called, or an exception is not caught. The exit code is the one the
application or Bun set; the release never changes it. Nothing is released
while the process runs: code after `run()`, a second `run()` (a sign-in
window first, the main window after it), or a blocking `run()` inside
`runEventLoop` keeps every tray, notifier, window, hook and single-instance
lock the application made, and the lock keeps turning a second launch away.
`run()` returning tears down only its own webview, as it always has.

What is released, in this order:

1. input hooks (`installMouseHook`, `installKeyboardHook`): a system-wide
   hook that no loop answers holds up the desktop's input;
2. webviews: each one's worker is terminated and its drain released, then
   the webview is destroyed, before the window it lives in;
3. tray icons;
4. notifiers: their click handlers end and their hidden notification icons
   go, but the notifications they showed are left for the user to read (see
   below);
5. single-instance locks, so the next launch becomes the primary;
6. windows, a tabbed window with its tabs, a torn-off window too;
7. on Windows, whatever the native layer still holds for the application
   (menus, timers and callbacks it made), in the same order. A step that
   fails is reported on stderr and the others still run.

**Notifications shown before the end stay.** A notification the application
showed just before quitting ("export finished") is the user's to read: on
Windows a toast stays on the screen and in the notification centre after the
process ends, and on macOS a delivered notification stays in Notification
Center. On Windows a click on one after the process is gone does not reach
the application; on macOS it launches the application again, and the click
goes to the notifier it makes first
([notifications on macOS](native/notifications.md#macos)). A Windows
balloon (the fallback when toasts are not available) is the exception: it
lives on its notifier's hidden notification icon, which goes with the process.
To take a notification back before the end, call `notifier.dispose()`: on
Windows that withdraws the toasts still showing (on the screen, or not yet
reported) and the balloons; on macOS it only stops routing clicks to the
notifier and leaves delivered notifications where they are
([notifications](native/notifications.md)).

A webview's worker never keeps the process alive by itself: while the loop
runs, the loop does, and once the application has quit the worker goes with
the webview. Only what belongs to the application itself (its own timers,
servers, sockets or workers) keeps a process running after Quit; `unref()`
or close those.

`dispose()` stays on every object, idempotent, for what an application wants
gone before it ends: a second window it closes, a tray it removes, a lock it
gives up early, a notification it takes back. Disposing by hand and then
quitting releases nothing twice and logs nothing. When the process exits from
inside a callback, a webview whose own callback is on the stack is left to the
OS, which reclaims it with the process.

On macOS, until the macOS goal of the Rust rewrite, none of this section
applies: macOS runs the code it ran before 1.0, which releases nothing at exit,
and a webview's worker keeps the process alive there, so a macOS application
disposes what it made and calls `process.exit()` after its loop, as the demos
do there.

## Reference

### WebView

```ts
import { WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import page from "./index.html";

const win = new Window({ title: "Notes", bounds: { x: 120, y: 120, width: 960, height: 640 } });
const view = await WebView.attach(win, { page, worker: "./worker.ts" });
win.show();
view.run();
```

`WebView<M, E>` is typed by the app's `Methods` and `Events` maps
([the contract](ipc.md)). Its two static constructors are
[`WebView.attach`](#webviewattach) and [`WebView.openTab`](#webviewopentab).

| Member | Meaning |
|---|---|
| `raw` | The underlying `RawWebview` instance (the `Webview` class of `@n1h/sweetview-native`). |
| `window` | The `Window` this webview was attached to. For a tab's webview on Windows it is the tabbed window the tab is in now (`tab.window`), which changes on tear-off and merge; on macOS it is a borrowed wrapper of the tab's own `NSWindow`, not the logical tabbed window, which `tab.window` is. |
| `emit(name, payload)` | Delivers an event to the page by evaluating `__sweetview_emit(name, payload)`. A `payload` of `undefined` is sent as `null`. Listeners registered with `onEvent` do not see it. |
| `notify(method, ...params)` | Posts a fire-and-forget call (`seq: null`) to the worker, with `params` sent as `null` when omitted. `uiMethods` are not consulted. Without a worker, logs `sweetview: <method>: this window has no worker` with `console.error` and sends nothing. |
| `onEvent(fn)` | Registers `fn` for every event the worker sends, called before the page receives it. Returns an unsubscribe function. |
| `run()` | Runs the blocking OS loop until `quit()` is called, then terminates the worker, closes the drain callback, and destroys the webview. Everything else stays until the process ends ([the end of the application](#the-end-of-the-application)). |
| `quit()` | Ends the running loop (on macOS, `webview_terminate`), causing `run()` to return. |
| `dispose()` | Tears down the worker, drain callback, and webview without running `run()`, for apps hosted under `runEventLoop`. It takes back any pending quit request the teardown leaves (`discardQuit`), so other windows keep running. Under `runEventLoop`, call it from a Bun turn (timer or after `await`), not from inside a `uiMethods` handler or window procedure. While `run()` is active it is safe from any callback: it stops the worker and watchdogs and calls `quit()`, and the webview is destroyed as `run()` unwinds (see [`run()`](#run-the-blocking-loop)). Idempotent. Disposing the `Window` does the same for its webview, see [Lifecycle](#lifecycle). Every webview still alive is disposed when the application ends; call it for one that should go before that. |

### WebView.attach

`WebView.attach(window, options: WebViewOptions<M>): Promise<WebView<M, E>>`

Mounts a webview inside an existing `Window` created by `new Window(...)` or `Window.fromHandle(...)`. Geometry (the window's own: its client area, in physical pixels on Windows and points on macOS), DPI scale, `resizable`, `transparent`, `backgroundColor`, and default `title` are read directly from `window`, so callers never duplicate window options. The window's visibility is left as it is: a hidden window stays hidden until the page calls `signalReady()` with `showOnReady` set, or, when `readyTimeoutMs` is given, until the ready watchdog fires (without `readyTimeoutMs` there is no watchdog); without `showOnReady`, call `win.show()` when it is to appear. A window already shown stays shown.

What `WebView.attach` does, in order:

1. Refuses any platform other than Windows and macOS before creating anything.
2. Validates the options: no method name in both `uiMethods` and `deferredUiMethods`, and a `worker` when `onRequest` is `"worker"`.
3. Gets the webview engine: on Windows the Rust binding, which has every feature; on macOS, until the macOS goal of the Rust rewrite, the webview library path from `WEBVIEW_PATH` or `@n1h/sweetview-webview-bun` (caching the `dlopen` handle per path), and, when `onRequest` is set, checks that library for the request symbols.
4. Chooses the loading mode. Direct-URL mode applies only when `url` is set and both `page` and `assets` are undefined: the webview navigates to `url` and no asset is registered. Otherwise it is asset mode: `page` is bundled, its `<title>` read, and an `index.html` generated with `indexHtml` when `index` names no asset. In asset mode `url` is ignored.
5. Refuses a disposed window, or one whose handle is null, and checks `ringBytes`.
6. Creates the `RawWebview` inside `window.handle` using the window's bounds, scale and `resizable` hint, then restores the window's styles and outer bounds in case the engine changed them.
7. Applies `title` (and mirrors it onto an untitled owned `window`).
8. Clears the browser background when `window` was created with `transparent: true` (on Windows a window's `backgroundColor` is the browser's background from the moment WebView2 makes it, at step 6, on a WebView2 Runtime with `ICoreWebView2ControllerOptions3`; when that holds, and what shows otherwise, is under [`backgroundColor`](native/windows.md#windowoptions)), and applies `allowExternalDrop` when it is set.
9. Allocates the shared `Ring`, subscribes webview file drops to the window's `onFileDrop` listeners, and starts `worker` if configured.
10. Registers the request handler when `onRequest` is set.
11. Binds `__sweetview_rpc`: the reserved ready method first, then `uiMethods`, then `deferredUiMethods`, then the worker. The binding exists before the first navigation and dispatches by method name only; see [the trust boundary](#the-rpc-trust-boundary). A direct-URL webview with no UI methods, no worker and no ready options gets no binding.
12. Registers every asset (`RawWebview#setAsset`, the library's `webview_set_asset` on macOS) and navigates to `${ASSET_ORIGIN}/${index}`, or navigates to `url` in direct-URL mode.
13. Arms the `readyTimeoutMs` watchdog when it is positive.

If any step after creating the webview throws, the worker is terminated, the drain callback and request handler are released, and the webview is destroyed before rethrowing.

#### Lifecycle

A webview lives until one of these happens, each of which runs the same teardown (cancel the watchdog and queued deferred calls, detach file drops, release the request handler, stop the ring's native wakeups, terminate the worker, destroy the webview):

- `run()` returns.
- The application ends ([the end of the application](#the-end-of-the-application)).
- `webview.dispose()` (or `app.dispose()`) is called. Inside `run()`, this stops the worker and watchdogs and calls `quit()`; the webview is destroyed when the loop returns.
- The `Window` it is attached to is disposed directly, with `win.dispose()` or by closing a window that has no `onClose` listener. Inside `run()`, disposing the window ends the loop, and `run()` finishes the teardown when the loop returns.

A webview on a borrowed window (a tab's child window, or a `Window.fromHandle` wrapper) is torn down by its owner instead: disposing that window stops the webview's watchdog, deferred calls and file drops, and the tab driver (or your code) disposes the webview. After teardown, `emit` and RPC replies are dropped silently.

#### Errors

Before anything is created, `WebView.attach` throws:

- `Error` `sweetview: <platform> is not supported (win32 and darwin are): the native module has no backend for it and the webview library does not serve assets there` on unsupported OSes.
- `Error` `sweetview: <name> is defined in both uiMethods and deferredUiMethods` for a duplicate local method name.
- `Error` `sweetview: onRequest: "worker" requires a worker entry point` when `onRequest: "worker"` is set without `worker`.
- `Error` `sweetview: onRequest requires webview_set_request_handler and webview_complete_request from @n1h/sweetview-webview-bun >= 2.8.0 or a compatible WEBVIEW_PATH` when `onRequest` is set and the library lacks the request symbols (macOS only; the Windows engine always has them).
- `Error` `sweetview: the page bundle has no HTML output` when `page` has no `.html` output.
- `Error` `sweetview: cannot attach WebView to a disposed window`.
- `Error` `sweetview: cannot attach WebView to a window with a NULL handle` when `window.handle` is null or 0. That includes a macOS tabbed `Window`; open tabs with `openTab` instead.
- `RangeError` `sweetview: ringBytes must be a power of two between 128 and 2^30, got <value>`.
- `Error` `sweetview: webview_create failed for the given window (is the WebView2 runtime installed?)` on Windows, or `sweetview: webview_create failed for the given window` on macOS.

After the webview is created (it is destroyed before the error propagates):

- `Error` `sweetview: webview_set_background_color failed (<code>)` when transparency setup fails.
- `Error` `sweetview: webview_set_allow_external_drop failed (<code>)`.
- `Error` `sweetview: webview_set_request_handler failed (<code>)`.
- `Error` `sweetview: this webview library has no webview_set_asset; it needs the library @n1h/sweetview-webview-bun ships (is WEBVIEW_PATH pointing at a stock one?)`, in asset mode only, on macOS only.
- `Error` `sweetview: webview_set_asset(<path>) failed (<code>)` when an asset is rejected.
- `Error` `sweetview: the window was disposed during WebView.attach` when the window is disposed while assets are being registered.
- `RangeError` `sweetview: native timeout must be greater than 0 and at most 2147483647 ms, got <value>` when `readyTimeoutMs` is positive but above 2147483647, or `Infinity`.

### WebView.openTab

`WebView.openTab(window, options: TabOptions<M>): Promise<Tab<M, E>>`

Start the loop before opening tabs: a tab's webview finishes initializing
while the loop turns. Closing the window ends the loop here, and the script
with it: Sweetview then closes the tabbed window and its tabs, and a window a
tab was torn off into (`tab.window`) too.

```ts
import { WebView, quitEventLoop, runEventLoop } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import tabPage from "./tab.html";

const win = new Window({ title: "Browser", bounds: { x: 100, y: 100, width: 1040, height: 760 }, tabs: true });
win.onClose(() => quitEventLoop());

const loop = runEventLoop();
await WebView.openTab(win, { page: tabPage, title: "New Tab" });
win.show();
await loop;
```

Opens a new native tab hosting its own webview inside a tabbed `Window` created with `{ tabs: true }`:

- **Windows**: creates a WebView2 webview as a child of the tabbed window's frame (the strip is one too), placed over the page area below the tab strip and shown while its tab is selected; hooks accelerator keys (`Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+1..9`, etc.), new-window requests and failed navigations; and wires native right-click menus, tear-off dragging and window merging. Tear-off and merge move the tab's webview to the other window's frame without reloading its page.
- **macOS**: creates an `NSWindow` participating in AppKit window tabbing (`addTabbedWindow:ordered:`), attaches a `WKWebView`, keeps the tab bar visible, hooks new-window requests and load errors, and detaches message handlers cleanly on close.

Both platforms behave the same inside a tab:

- An HTTP(S) `target="_blank"` link or `window.open()` call opens the address as a new tab right after the current one, in the tab's current tabbed window. Other schemes are dropped.
- A URL tab (one opened with `url`) whose navigation fails, for example on an unreachable host or a certificate error, shows a "This site did not open" page with the address, the reason, and a Try Again link. A navigation cancelled by a newer one is not a failure, and on Windows neither is an HTTP error response, whose page the server supplies (as on macOS).

Run the app under `runEventLoop()` (or `createApp({ tabs: true }).run()`). `WebViewOptions` apply per tab, so set `worker`, `onRequest`, `uiMethods` and the rest on each `openTab()` call. Opening a tab does not show a hidden tabbed window unless that tab sets `showOnReady` (see [Tab and TabOptions](#tab-and-taboptions)); otherwise call `show()` on it.

Throws `sweetview: WebView.openTab requires a Window created with { tabs: true }`, `sweetview: cannot open tab in a disposed window`, `sweetview: native tabs are not supported on <platform> (win32 and darwin only)`, or any `WebView.attach` error for the tab's webview.

### WebViewOptions

Every field is optional. `uiMethods` and `worker` grant the page native and
backend access; give them only to a webview whose top-level document is
trusted ([the RPC trust boundary](#the-rpc-trust-boundary)).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `page` | `HTMLBundle` | none | HTML import (`import index from "./index.html"`). Bundled with `Bun.build` under `bun run`, or read from embedded `files` in a compiled executable. |
| `url` | `string` | none | Direct URL to navigate to (such as `https://example.com`). Used only when `page` and `assets` are both undefined; otherwise ignored. An external site gets the RPC binding too; open it without `uiMethods`, `deferredUiMethods` or `worker`. |
| `title` | `string` | `window`'s title, else `<title>` of `page`, else `Bun.main` basename | Window / tab title. |
| `assets` | `Record<string, Asset>` | `{}` | Extra files served at the page's origin by asset path. |
| `index` | `string` | the page's HTML output, else `"index.html"` | Asset path to navigate to. Generated via `indexHtml` if missing. |
| `worker` | `URL \| string` | none | Worker entry calling `hostService` or `hostRequestHandler`. Relative strings resolve against `pathToFileURL(Bun.main)`. |
| `onRequest` | `"worker" \| ((request: NativeRequest) => NativeResponse)` | none | Handles dynamic requests through the worker or a synchronous UI handler. |
| `allowExternalDrop` | `boolean` | engine default (allowed) | Whether the webview accepts drags from other applications. `false` refuses them on Windows (`ICoreWebView2Controller4::AllowExternalDrop`) and on macOS (`SweetviewWKWebView` refuses drags whose `draggingSource` is `nil`, which AppKit reports for drags from other apps); drag-and-drop within the page keeps working. On macOS, a webview library without `webview_set_allow_external_drop` logs a warning once per library path and keeps the engine default; on a WebView2 Runtime without `ICoreWebView2Controller4` the call fails and `WebView.attach` throws `webview_set_allow_external_drop failed (<code>)`. |
| `debug` | `boolean` | `false` | Enables devtools and the context menu. |
| `uiMethods` | `UiMethods<M>` | `{}` | Synchronous handlers answered on the UI thread before consulting the worker. |
| `deferredUiMethods` | `UiMethods<M>` | `{}` | Synchronous handlers invoked on a later native UI tick. |
| `showOnReady` | `boolean` | `false` | Reveals the window when the page signals readiness, or when the watchdog fires, which it does only with `readyTimeoutMs`. |
| `readyTimeoutMs` | `number` | disabled | A positive value up to 2147483647 arms a native startup watchdog; zero, a negative value or `NaN` leaves it off. |
| `onReady`, `onReadyTimeout` | `() => void` | none | UI-thread hooks for the first ready handshake and for watchdog expiry. |
| `readyFallbackHtml` | `string` | built-in error page | HTML shown on watchdog expiry. |
| `ringBytes` | `number` | `1048576` | Capacity of the worker-to-UI shared-memory ring (power of two, `128..2^30`). |

`Window.onFileDrop` receives OS file drops on the native window and on an
attached webview (always on Windows; on macOS, when the webview library
exports `webview_set_file_drop_handler`).
Subscribe before or after attaching. The first listener turns webview drop
handling on and removing the last one restores the engine's default. Drops
over the webview need external drops enabled, on Windows and macOS alike:
`allowExternalDrop: false` refuses the very drags that carry files from
Explorer or Finder. See [file drops](native/windows.md#file-drops).

### Tab and TabOptions

`TabOptions<M>` is `WebViewOptions<M>` plus `after`. `Tab<M, E>` is the
`TabHandle` that `WebView.openTab` and `app.openTab` resolve with.

| Member | Meaning |
|---|---|
| `after` (`TabOptions`) | Optional `TabHandle` to insert the new tab after. Honored only when that tab is open in the same tabbed window the new tab opens in; otherwise, as when omitted, the tab opens after the selected tab. |
| `webview` | The `WebView` mounted inside this tab. |
| `window` | The logical tabbed `Window` (`tabs: true`) currently hosting this tab. It changes when the tab is torn off into a new window or merged into another. On Windows `tab.webview.window` is the same window; on macOS it is the borrowed window of the tab itself, which never changes and is rarely what app code wants. |
| `title` | Current tab title. |
| `setTitle(title)` | Updates the tab's title in the tab strip / title bar. |
| `select()` | Focuses and activates this tab (and its hosting window). |
| `close()` | Closes the tab: `onTabClose` fires. Closing a window's last tab is a request to close the window. On Windows it is offered to the window's `onClose` listeners first, by `close()` too: while one is registered (closing to the tray, say) the tab stays open; with none, the window and the tab close. On macOS `close()` always closes the last tab, then the window's `onClose` listeners run, or with none the window is disposed; only a close the user asks for there (the close button, Close Tab) is offered to the listeners first. `dispose()` closes a tab regardless. |
| `moveToNewWindow()` | Detaches the tab into its own tabbed window (keeping its webview state intact) and resolves with the new `Window`. |
| `dispose()` | Tears down the tab and its webview. |

Tabs are host-aware: `showOnReady` and the ready watchdog (armed only by `readyTimeoutMs`) reveal the tab's
current logical host (its tabbed window) if that host is hidden, not the
borrowed window the webview was attached to. They do not force the tab to be selected; call
`tab.select()` when a specific tab should be in front. File drops over a tab's webview go to the `onFileDrop` listeners of the tab's
current `tab.window`. After a tear-off or merge, drops go to the new host
only.

### createApp

`createApp<M, E>(options: AppOptions<M>): Promise<App<M, E>>`

```ts
import { createApp } from "@n1h/sweetview";
import index from "./index.html";

const app = await createApp({
  title: "Notes",
  page: index,
  worker: "./worker.ts",
  contentSize: { width: 1100, height: 720 },
  showOnReady: true, // shown when the page calls signalReady()
  readyTimeoutMs: 15_000, // or with a start-up error page, if the page fails first
});
app.run();
```

`contentSize` is the page's size in CSS pixels: the window is centred on the
primary screen and its frame sized around the page at that screen's scale, so
the page looks the same size at 100 % and at 150 %. `bounds` places the outer
frame in physical pixels instead; give one or the other
([WindowOptions](native/windows.md#windowoptions)).

Layer 2 declarative helper that combines `new Window(options)` with `WebView.attach` (or native tab setup when `options.tabs` is `true`). `options` is both `WindowOptions` and `WebViewOptions`.

- The window is created hidden. Set `showOnReady: true` and call `signalReady()` from `@n1h/sweetview/page` once the page has rendered: the window appears then. Set `readyTimeoutMs` (15 s, say) too, so a page that fails before it signals still gets its window, with a start-up error page. Call `app.window.show()` yourself only for a window that is to appear later (from a tray click, say). In a tabbed app, opening a tab does not show the window either, unless that tab sets `showOnReady`.
- When the app quits on its own is under [Closing and quitting](#closing-and-quitting).
- If `WebView.attach` throws during `createApp`, the newly created `Window` is disposed before rethrowing.
- On a non-tabbed app, `app.openTab` throws `sweetview: openTab() requires createApp({ tabs: true })`.

#### Closing and quitting

The two kinds of app end differently.

- **Single-window app, blocking `app.run()`.** Without an `onClose` option, closing the window disposes it. Disposing the window `app.webview` is attached to always ends `app.run()`: the webview's own window-dispose hook stops the worker and calls `quit()`, even when another owned window (a settings window, say) is still visible. A tray application, which keeps running after its window closes, declares it: `closeToTrayOnLastWindow(app.window, onHide)` hides the window when it is the last one visible (when another window is visible it closes as usual, which ends `app.run()`), and the application calls `app.quit()` from its tray menu. Only a window that must never close, whatever else is on the screen, passes an `onClose` of its own that hides it; with `onClose`, nothing quits automatically.
- **Tabbed app, `runEventLoop()`.** Without an `onClose` option, disposing `app.window` calls `quitEventLoop()` only when `Window.visibleWindows()` is empty afterwards, so a visible torn-off window or any other visible owned window keeps the loop running. With `onClose`, nothing quits automatically; the [multi-tab example](#multi-tab-app) quits from it.

### App and AppOptions

`AppOptions<M>` is [`WindowOptions`](native/windows.md#windowoptions) and
[`WebViewOptions<M>`](#webviewoptions) in one object. On a tabbed app,
`onNewTab` is `(origin: Window) => void`: `origin` is the window that asked
for the tab (the main window or a torn-off one), so a multi-window handler can
call `WebView.openTab(origin, ...)` to open the tab there
([example](#multi-tab-app)). `App<M, E>`:

| Member | Single-window app | Tabbed app (`tabs: true`) |
|---|---|---|
| `window` | The app's `Window`. | The tabbed host `Window`. |
| `webview` | The attached `WebView<M, E>`. | `undefined`. Each tab has its own `tab.webview`. |
| `openTab(options)` | Throws `sweetview: openTab() requires createApp({ tabs: true })`. | Opens a tab in `app.window`, resolving with a `Tab`. |
| `mergeAllWindows()` | Nothing to merge. | Merges torn-off windows back into `app.window`. |
| `emit(name, payload)`, `notify(method, ...params)` | `webview.emit` and `webview.notify`. | Send nothing; they log `sweetview: app.emit() is unavailable on a tabbed app; emit on a specific tab.webview instead` (or the `app.notify()` equivalent) with `console.error`. |
| `onEvent(fn)` | `webview.onEvent(fn)`. | Registers nothing and returns an inert unsubscribe function; subscribe on each `tab.webview` instead. |
| `run()` | Blocks in `webview.run()`; returns `void`. After a `dispose()` made inside the loop, it disposes the window once the loop unwinds. The window and everything else are released when the process ends ([the end of the application](#the-end-of-the-application)). | Returns the promise of `runEventLoop()`; `await` it. The tabs and windows are released when the process ends. |
| `quit()` | `webview.quit()`. | `quitEventLoop()`. |
| `dispose()` | Disposes the webview, then the window (inside `run()`, the window waits for `run()` to return). Not needed at the end of the application on Windows (macOS: [the end of the application](#the-end-of-the-application)). Idempotent. | Closes `app.window` and the tabs in it. Torn-off windows created by `moveToNewWindow()` or tab tear-off have their own lifetime; dispose them (or their tabs) separately, or merge them back first with `mergeAllWindows()`. At the end of the application every window is released, torn-off ones included. Idempotent. |

### Asset

```ts
import type { Asset } from "@n1h/sweetview";
```

The bytes served at one path of the page's origin: a `string`, a
`Uint8Array` or a `Blob`. The Content-Type comes from the path's extension
through `assetMime`.

| Variant | Served as |
|---|---|
| `string` | File path read with `Bun.file`. A path imported `with { type: "file" }` is embedded by `bun build --compile`. |
| `Uint8Array` | Raw bytes as given. |
| `Blob` | Blob bytes (`Bun.file(path)`, `Bun.build` outputs, `indexHtml(...)`, or `new Blob([text])`). |

### UiMethods

```ts
import type { UiMethods } from "@n1h/sweetview";
```

`UiMethods<M>` maps any subset of the contract's method names to a function
from that method's params to its result: `{ [K in keyof M]?: (params: M[K][0]) => M[K][1] }`.
Synchronous methods answered on the UI thread instead of by the worker. Returning a Promise is rejected with `<method>: a UI-thread method must return synchronously; this one returned a Promise`. Throwing rejects the page's call with the error's message.

### assetMime

```ts
import { assetMime, indexHtml, indexHtmlText, type IndexHtmlOptions } from "@n1h/sweetview";
```

`assetMime(path: string): string` returns the Content-Type for an asset path from its lowercased extension (`html`, `js`, `mjs`, `css`, `json`, `map`, `txt`, `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`, `woff2`, `ttf`, `wasm`, `glb`, `gltf`, `mp3`, `ogg`, `wav`; fallback `application/octet-stream`).

### indexHtml

`indexHtml(options: IndexHtmlOptions): Blob` builds an HTML5 index document
as a `Blob` (`text/html; charset=utf-8`). `indexHtmlText(options): string`
returns the same document as a string.

The document always loads `js` as a module script, so register an asset at
that path (or pass the path of one you do register). `title`, `js` and `css`
are HTML-escaped; `head` and `body` are inserted verbatim.

| `IndexHtmlOptions` field | Default | Meaning |
|---|---|---|
| `title` | required | The `<title>`. |
| `js` | `"main.js"` | Asset path of the module script. |
| `css` | `"main.css"` | Asset path of the stylesheet; `""` links none. |
| `head` | `""` | Extra markup inside `<head>`. |
| `body` | `'<div id="root"></div>'` | The `<body>` content. |

### windowChromeMethods

Re-exported from [`@n1h/sweetview/window-chrome`](window-chrome.md) together with `windowChromeEvents`, `WindowChromeEvents`, `WindowChromeInfo`, `WindowChromeKind`, `WindowChromeMethodTable`, `WindowChromeMethods`, and `WindowChromeOptions`.

### Ring

```ts
import { Ring } from "@n1h/sweetview";
```

```ts
export class Ring {
  static create(capacity: number): SharedArrayBuffer;
  constructor(sab: SharedArrayBuffer);
  get capacity(): number;
  write(bytes: Uint8Array): void;
  claimWakeup(): boolean;
  acknowledgeWakeup(): void;
  dispatch(wake: () => void): void;
  stopDispatch(): void;
  *drain(): Generator<Uint8Array>;
}
```

Single-producer, single-consumer byte ring over a `SharedArrayBuffer` (16-byte header + power-of-two capacity `16..2^30`). Each frame has a 4-byte little-endian length prefix. `write` blocks with `Atomics.wait` while full; `drain` yields frames without blocking.

`dispatch(wake)` guards the producer's native wake call. `stopDispatch()`
blocks new calls and waits for an active native wake to return before the host
can destroy the webview.

### Event loop re-exports

```ts
import { pumpEvents, quitEventLoop, runEventLoop, setActivationPolicy } from "@n1h/sweetview";
```

`pumpEvents`, `quitEventLoop`, `runEventLoop`, `setActivationPolicy`, `ActivationPolicy` and `EventLoopOptions` are re-exported from `@n1h/sweetview/native`, so a webview app needs one import. They are documented in [Event loop and icons](native/event-loop-and-icons.md#the-event-loop) and [`setActivationPolicy`](native/menus-and-tray.md#setactivationpolicy).

### Activation and identity re-exports

```ts
import { defineAppIdentity, onOpenUrl, registerUrlScheme, singleInstance } from "@n1h/sweetview";
```

The root re-exports `defineAppIdentity`, `AppIdentity` and `AppIdentityInput`
([app identity](settings-store.md#app-identity)) and the activation API:
`registerUrlScheme`, `unregisterUrlScheme`, `singleInstance`,
`extractUrlFromArgs`, `onOpenUrl`, `signalReady`, `RegisterUrlSchemeOptions`,
`SecondInstanceEvent`, `SingleInstanceLock` and `SingleInstanceOptions`
([activation and single instance](native/activation-and-single-instance.md)).
The root `signalReady` is the native, UI-thread one; a page calls its own
from [`@n1h/sweetview/page`](page.md#signalready).

### SizeHint, WEBVIEW_VERSION, RawWebview

```ts
import { RawWebview, SizeHint, WEBVIEW_VERSION } from "@n1h/sweetview";
```

Re-exported from `@n1h/sweetview-native` (its `Webview` class is re-exported as `RawWebview` to avoid colliding with sweetview's `WebView`). It is the class `@n1h/sweetview-webview-bun` exported as `Webview`; on Windows it runs on the Rust binding, and on macOS, until the macOS goal of the Rust rewrite, it hands every call to that package's webview library. Earlier versions re-exported it from `@n1h/sweetview-webview-bun`; see [Upgrading](upgrading.md). `webview.raw` is the `RawWebview` behind a `WebView`.

## Page loading

```ts
import { ASSET_ORIGIN, WebView } from "@n1h/sweetview";
```

In asset mode `WebView.attach` registers every asset (`RawWebview#setAsset`)
and navigates to `${ASSET_ORIGIN}/${index}`. Direct-URL mode applies only when
`url` is set and `page` and `assets` are both undefined; then nothing is
registered and the webview navigates to `url`. To serve the initial page
dynamically, set `` url: `${ASSET_ORIGIN}/dynamic` `` together with
`onRequest`, and leave `page` and `assets` unset.

| OS | Origin | Served by |
|---|---|---|
| Windows | `http://webview.localhost` | `WebResourceRequested` filter (nothing reaches the network) |
| macOS | `webview://localhost` | `WKURLSchemeHandler` for the `webview` scheme |
| Linux | `http://webview.localhost` | Unsupported (`WebView.attach` throws before creating anything) |

On Windows the webview is part of the Rust binding in `@n1h/sweetview-native`, loaded once per process (`SWEETVIEW_NATIVE_PATH` names a custom build). On macOS, until the macOS goal of the Rust rewrite, the native library path comes from `WEBVIEW_PATH` or `@n1h/sweetview-webview-bun/build/`, and `dlopen` handles are cached per path so repeated windows/tabs never leak library handles. See [the webview](webview-library.md#library-selection-and-symbol-probing).

### The RPC trust boundary

When `WebView.attach` binds `__sweetview_rpc`, it does so before the first
navigation, and the dispatcher checks only the method name: it answers the reserved ready method,
then `uiMethods`, `deferredUiMethods` and the worker, whatever document is
loaded at the top level. It does not check the document's origin. A page at
`ASSET_ORIGIN`, a `url` you navigated to, and any top-level page a link or
redirect leads to all get the same methods.

The engine refuses RPC from subframes (`window !== window.top` on Windows,
where the Rust binding installs the binding only in the top-level document;
on macOS, the hardened native library, 2.8.0 or the `v1-drafting` branch,
checks the same and also refuses a `WKScriptMessage` that is not from the main
frame), so a cross-origin iframe on `FRAMES_ORIGIN` or any other foreign
origin cannot call in ([dynamic requests](#dynamic-requests)). The published
2.7.0 library, which only macOS can still use, lacks these native subframe
checks. Even with them the isolation covers cross-origin frames only: a same-origin iframe can reach
`window.top`'s globals under the browser's ordinary same-origin policy, so do
not embed untrusted content at your own origin.

- Give `uiMethods`, `deferredUiMethods` and `worker` only to a webview whose
  top-level document is your own: bundled `page` or `assets`, or a `url` you
  control.
- Show external sites in a separate webview or tab created without those
  options. A direct-URL webview (`url` with no `page` or `assets`) that also
  sets none of `showOnReady`, `readyTimeoutMs` or `onReady` gets no
  `__sweetview_rpc` binding at all. One that sets a ready option gets a
  binding that answers only the ready method and rejects every other call
  with `<method>: this window has no worker and no UI-thread method of that
  name`.

## Startup and deferred UI

```ts
import { createApp } from "@n1h/sweetview";
import index from "./index.html";

const app = await createApp({
  page: index,
  showOnReady: true,
  readyTimeoutMs: 15000,
  onReadyTimeout: () => console.error("the page did not start"),
});
app.run();
```

For a page-controlled reveal, set `showOnReady: true` and call
`await signalReady()` from [`@n1h/sweetview/page`](page.md#the-ready-handshake)
after you install listeners and render the initial UI; set `readyTimeoutMs`
too, or a page that fails before it signals leaves its window hidden, since
the watchdog is off without it. The first signal from
a webview cancels that webview's watchdog, calls the native `signalReady()`,
calls its `onReady`, then shows its window. Later signals resolve without
doing anything again.

Two scopes are involved. The native `signalReady()` is process-wide: the
first webview to become ready drains the buffered URL activations for the
whole app ([activation](native/activation-and-single-instance.md#onopenurl-and-startup-buffering)),
and later webviews find it already done. `onReady`, `onReadyTimeout`,
`showOnReady` and the watchdog (`readyTimeoutMs`) are per webview.

With a positive `readyTimeoutMs`, the watchdog uses a Win32 timer or a macOS
`NSTimer`, so it also runs inside the blocking `app.run()`. If it fires
first, it replaces the page with `readyFallbackHtml` (or a built-in "The app
took too long to start" page), calls `onReadyTimeout`, and reveals the
window when `showOnReady` is set. It does not mark the webview ready and does
not call the native `signalReady()`, so buffered activation URLs stay queued
until a page signals ready or the app calls `signalReady()` itself.
Disposal cancels the timer.

Use `deferredUiMethods` for modal native UI that needs the current bridge
callback to return first. These handlers still return synchronously from their
own invocation. The native dispatch queue runs them in order and defers any
calls received by a modal loop until the active handler returns. Duplicate
method names across the two UI tables throw during attach.

## Dynamic requests

```ts
import { ASSET_ORIGIN, FRAMES_ORIGIN, type NativeRequest, type NativeResponse } from "@n1h/sweetview";
```

`ASSET_ORIGIN` and `FRAMES_ORIGIN` are exports from `@n1h/sweetview`. The
frames origin is `http://frames.webview.localhost` on Windows and
`webview-frames://localhost` on macOS. The browser applies its cross-origin
DOM boundary to iframes loaded there. The engine (the Rust binding on
Windows, the native library on macOS) exposes RPC only
when `window === window.top`. On macOS the library also checks
`WKScriptMessage.frameInfo.isMainFrame` before dispatching. The native handler receives every
request to that origin and any request at the asset origin that misses the
static table. With no handler, those requests return 404.

- Set `onRequest: "worker"` together with `worker`. Use an ordinary
  `Request => Response | Promise<Response>` handler in that worker. See
  [worker routes](worker.md#hostrequesthandler).
- Pass a synchronous `onRequest(request)` for short UI-thread work.
  `NativeRequest` contains `id: bigint`, `method`, `url`, ordered header pairs
  and a copied `Uint8Array` body. An empty request has zero body bytes.
  `NativeResponse` takes optional `status` (default 200), `headers` (object or
  pairs, with repeated names supported), and `body` (UTF-8 string,
  `Uint8Array`, `ArrayBuffer` or `null`). A throw returns 500. Returning a
  Promise gives an immediate 500 with instructions for worker mode.

On macOS a request body that is a `Blob`, or a `FormData` containing a
`File` or `Blob`, reaches the handler empty: WebKit hands its scheme handler
only the body parts the page holds in memory. Strings, `ArrayBuffer` and
typed arrays, `URLSearchParams`, and a `FormData` of text fields arrive
whole. A page that uploads files reads them first, which works on both
platforms: send `await blob.arrayBuffer()`, or for a form
`const encoded = new Response(formData)` and post
`await encoded.arrayBuffer()` with `encoded.headers.get("Content-Type")` as
the `Content-Type`.

Both modes use native interception and zero TCP. On Windows the Rust
binding always has them. On macOS, until the macOS goal of the Rust rewrite,
they require the request symbols that arrive with
`@n1h/sweetview-webview-bun` 2.8.0, which the `^2.7.0` peer range accepts;
before 2.8.0 is published, set `WEBVIEW_PATH` to a library rebuilt from the
`v1-drafting` branches
([the webview](webview-library.md#where-it-comes-from)). In tabbed
apps, set these options on each `openTab()` call.

A worker can return a `Response` with a `ReadableStream<Uint8Array>` body.
When the engine can stream (always on Windows; on macOS, a library with the
streaming symbols), Sweetview forwards each chunk through the shared
ring without collecting the whole body in the worker or UI thread. A macOS
library with request interception but without streaming symbols buffers on
the UI thread and completes the request once. WKWebView can deliver bytes
incrementally. WebView2 buffers intercepted responses until EOF, as observed
in the live Windows test. For real-time SSE-style updates and other desktop
push, use Sweetview IPC events (`emit` and `onEvent`, or `bridge.on` in the
page). [WebView2 Feedback #3519](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3519).

## Exceptions in page calls, requests and the worker

An exception thrown by one of these handlers never reaches
`process.on("uncaughtException")`, and most of them print nothing: the page
or the request gets the failure instead. Each fault stays in its own call: the
other calls, requests and events go on.

| Handler | What the page or the request gets | Printed with no listener | Told to an `onCallbackError` listener |
|---|---|---|---|
| A `uiMethods` method | the call is rejected with the error's message | nothing | no |
| A `deferredUiMethods` method | the call is rejected with the error's message, on the later tick the method ran in; the other calls of that tick are still answered | nothing | no |
| An `onRequest` function | `500 Internal Server Error` | nothing | no |
| `onReady`, `onReadyTimeout` | (no effect on the page) | `sweetview: onReady handler threw:` (`onReadyTimeout`) | no: the line is printed with a listener too |
| An `onEvent` listener | the other listeners and the page still get the event, and the worker's later replies and events are still delivered | `sweetview: UI dispatch failed:` (one error as it was thrown; several thrown in one delivery as one `AggregateError`) | yes, as `worker`, in place of the line; but not for an event Sweetview delivers while it cleans up after the worker failed: that is printed `sweetview: draining the failed worker's replies threw:`, with a listener too |
| A method of the worker's service (`hostService`) | the call is rejected with the error's message | nothing | no |
| The worker's own uncaught exception | the worker ends, and every call waiting on it is rejected | `sweetview: the worker failed:`, once | no: the line is printed with a listener too |
| A worker method called with `notify` (no reply) | nothing | `<method> failed:`, in the worker | no |
| A worker route handler (`onRequest: "worker"`) | `500` ([worker](worker.md)) | nothing | no |

For a UI-thread method and a method of the worker's service alike, the
error's message is the page's text: an `Error`'s `message`, else the value's
`String()` form. A thrown value neither can be read from (a `Proxy` whose
traps throw, an object with no prototype) still rejects its call, with its
`Object.prototype.toString` tag, such as `[object Object]`; the worker sends
its error reply and lives on. A deferred method's such value also prints
`sweetview: UI dispatch failed:` with what its reading threw, once for the
calls answered together, as before.

In an application made with `createApp`, on Windows, an
[`onCallbackError`](native.md#exceptions-thrown-by-your-callbacks) listener
is told about the exceptions of the native module's callbacks the application
sets, on `app.window` and elsewhere (a `Window` listener such as `onClose` or
`onFileDrop`, which a file dropped on the page reaches; a tray, a menu, a
notification, a hook, a single-instance or open-URL listener), and about an
`onEvent` listener's, as `worker` (except during the cleanup after the worker
failed). It is not told about the handlers above
marked "no", a fault inside the worker, a fault in the tab machinery of
`@n1h/sweetview` (moving a tab to a new window, detaching a tab from the
strip, opening a page's new-window request as a tab: those print their error
to the console), or a `Menu.popup` item's `click` (its exception comes out of
`Menu.popup`). On macOS no listener is called.

In the page, `await` each call (or attach a `catch`): a call the page never
awaits is rejected unseen there.

## Transport

| Direction | Mechanism |
|---|---|
| page to UI thread | `__sweetview_rpc(method, params)` bound via `RawWebview#bindRaw` (`wry`'s IPC handler on Windows, `webview_bind` on macOS) |
| UI thread to worker | `worker.postMessage` (synchronous enqueue) |
| worker to UI thread | Chunkable JSON IPC and binary HTTP response frames in shared `Ring` + a wakeup (the binding's signal window on Windows, `webview_dispatch` on macOS) |
| UI thread to page (replies) | `RawWebview#return(seq, status, json)` (`webview_return` on macOS) |
| UI thread to page (events) | `RawWebview#eval` of `__sweetview_emit(name, payload)` (`webview_eval` on macOS) |

## Examples

### Single window with `createApp`

Three files: the page, the worker entry and the app entry.

`index.html` (loaded by `import index from "./index.html"`; it only needs a
module script, which Bun bundles):

```html
<!doctype html>
<html>
  <head><title>Notes</title></head>
  <body>
    <ul id="notes"></ul>
    <script type="module">
      import { createBridge } from "@n1h/sweetview/ipc";
      import { webviewTransport } from "@n1h/sweetview/page";

      const bridge = createBridge(webviewTransport());
      bridge.on("notes.changed", ({ count }) => console.log("notes:", count));
      const notes = await bridge.rpc("notes.list");
      document.getElementById("notes").innerHTML = notes.map((n) => `<li>${n}</li>`).join("");
    </script>
  </body>
</html>
```

`app-worker.ts`:

```ts
import { defineService } from "@n1h/sweetview/ipc";
import { hostService } from "@n1h/sweetview/worker";

type Methods = { "notes.list": [void, string[]] };
type Events = { "notes.changed": { count: number } };

const notes = ["first note"];

hostService(
  defineService<Methods, Events>((emit) => ({
    methods: {
      "notes.list": () => {
        emit("notes.changed", { count: notes.length });
        return notes;
      },
    },
  })),
);
```

`app.ts`:

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
  showOnReady: true,
  readyTimeoutMs: 15_000,
  uiMethods: { "window.size": () => 800 },
});

app.onEvent((event) => console.log(event.name, event.payload.count));
app.notify("notes.list");
app.run(); // the window appears when the page calls signalReady()
```

### Multi-tab app

The loop starts before the first tab opens, since a tab's webview finishes
initializing while the loop turns. Closing the window quits; the script then
ends, and Sweetview closes every window, torn-off ones included, with their tabs.

```ts
import { WebView, createApp, type Tab } from "@n1h/sweetview";
import type { Window } from "@n1h/sweetview/native";
import tabPage from "./tab.html";

const app = await createApp({
  title: "Tabbed App",
  bounds: { x: 100, y: 100, width: 1040, height: 760 },
  tabs: true,
  onNewTab: (origin) => void open(origin).catch(console.error),
  onClose: () => app.quit(),
});

function open(origin?: Window): Promise<Tab> {
  // origin is the window that asked for the tab (main or torn-off); without it, the main window
  return origin ? WebView.openTab(origin, { page: tabPage, title: "New Tab" }) : app.openTab({ page: tabPage, title: "New Tab" });
}

const loop = app.run();
await open();
app.window.show(); // opening a tab without showOnReady does not show the window
await loop;
```
