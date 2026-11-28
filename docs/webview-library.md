# The webview

The native webview `@n1h/sweetview` runs on, on each OS, and what it adds to
upstream [webview](https://github.com/webview/webview). Application code
does not call it directly; `WebView.attach` and `createApp` do, through the
`RawWebview` class ([app reference](app.md)). This page is for understanding
what happens underneath, choosing a build, and working on it.

- On Windows the webview is WebView2 driven by Rust: [`wry`](https://github.com/tauri-apps/wry)
  creates it, and this project's `sweetview-platform-webview` crate adds what
  `wry` has no API for (the request handler with streamed bodies, file drops,
  external drop control, the transparent background, removable user scripts,
  and WebView2's own page behaviour where `wry` changes it: see
  [Page behaviour](#page-behaviour)),
  with the request rules in `sweetview-http`. Both are compiled into the
  N-API binding that ships inside `@n1h/sweetview-native`. Nothing else is
  installed, and `bun:ffi` is not involved.
- On macOS, until the macOS goal of the Rust rewrite, the webview is the C++
  webview library: a fork of upstream webview with Sweetview's additions,
  shipped in the optional peer `@n1h/sweetview-webview-bun` and called through
  `bun:ffi`.

The additions below are named by the C functions of the macOS library. The
Windows binding provides the same behaviour as methods of `RawWebview`
(`setBackgroundColor`, `setAsset`, `setRequestHandler`, `completeRequest`,
`beginResponse`, `writeResponseChunk`, `endResponse`,
`setAllowExternalDrop`, `setFileDropHandler`), and reports the same
`webview_error_t` codes, as a `WebviewError` with `code`.

- [Where it comes from](#where-it-comes-from)
- [Why Linux appears here](#why-linux-appears-here)
- [The additions](#the-additions)
  - [webview_set_background_color](#webview_set_background_color)
  - [webview_set_asset](#webview_set_asset)
  - [Dynamic interception and the frames origin](#dynamic-interception-and-the-frames-origin)
  - [Streaming responses](#streaming-responses)
  - [External drops](#external-drops)
  - [File drops over the webview](#file-drops-over-the-webview)
  - [Page behaviour](#page-behaviour)
  - [Teardown](#teardown)
- [Library selection and symbol probing](#library-selection-and-symbol-probing)
- [Source](#source)
- [Rebuilding](#rebuilding)

## Where it comes from

Windows:

- The binding is `prebuilt/sweetview.win32-x64-msvc.node` in
  `@n1h/sweetview-native`, built from the crates under `crates/` of this
  repository by `just native build` ([Rebuilding](#rebuilding)). The published
  package carries it; a clone of the repository does not, and builds it.
- `@n1h/sweetview-webview-bun` is not needed on Windows and is not loaded.

macOS, until the macOS goal of the Rust rewrite:

- The library ships in [`@n1h/sweetview-webview-bun`](https://github.com/n0t-invented-here/sweetview-webview-bun),
  in its `build/` folder, for Windows x64, macOS (universal) and Linux x64.
  The Bun bindings build it from their `webview` submodule, a fork of
  upstream webview with Sweetview's additions.
- `@n1h/sweetview` and `@n1h/sweetview-native` declare the bindings as an
  optional peer dependency, `^2.7.0`, which a macOS application installs. Version 2.7.0 has the window, asset and transparency additions.
  The later additions (request interception through `onRequest`, streaming
  responses, `allowExternalDrop`, and webview file drops) arrive with the
  2.8.0 bindings, which the `^2.7.0` range accepts. Until 2.8.0 is
  published, point `WEBVIEW_PATH` at a library rebuilt from the `v1-drafting`
  branches. Sweetview probes each addition separately
  ([below](#library-selection-and-symbol-probing)), so a 2.7.0 library still
  runs every app that does not use them. The Windows binding has all of them.

## Why Linux appears here

Sweetview supports Windows and macOS. The library is a fork of upstream
webview, which also builds for Linux (GTK and WebKitGTK), and the fork keeps
that build compiling so it stays mergeable with upstream and its C ABI stays
the same on every platform. On Linux each Sweetview addition is therefore
accepted and returns success, but does nothing: no asset serving, no
interception, no drop handling. `WebView.attach` refuses Linux before it gets
that far, so the Linux remarks below matter only to someone using the
library directly. An app that wants a UI on Linux runs its page in a browser
over WebSocket instead: see [browser + WebSocket mode](ipc-ws.md). The
Rust binding is built for Windows only today; its webview crate compiles on
other platforms and reports `WEBVIEW_ERROR_UNSPECIFIED` there.

## The additions

Each addition is a C function in the macOS library's
`core/include/webview/api.h`, shown with the section that explains it; the
Windows bullets describe what the Rust binding does for the same call. The
fork also changes `webview_set_size` on macOS: for a window passed to
`webview_create`, it does nothing, so that window keeps its own style, size
and position.

### webview_set_background_color

```c
webview_error_t webview_set_background_color(webview_t w, int r, int g, int b, int a);
```

Makes the browser's own background transparent (or any color), which
`transparent: true` windows need. Each of `r`, `g`, `b` and `a` is 0 to 255.

- Windows: sets `ICoreWebView2Controller2::DefaultBackgroundColor`. For the
  desktop to show through, the host window also needs composition that
  honours alpha, which `transparent: true` sets up. WebView2 accepts only a
  fully transparent (`a` = 0) or fully opaque (`a` = 255) background; it
  refuses any alpha in between, and the call returns
  `WEBVIEW_ERROR_UNSPECIFIED`. Sweetview passes 0.
- macOS: makes the `WKWebView` layer-backed and paints the RGBA color on its
  backing layer, behind the page, with WebKit's own background
  (`drawsBackground`) turned off for every color. When `a` is below 255 the
  `NSWindow` is made non-opaque with a clear background so the layer shows
  through. An opaque color restores opacity only on a window the library
  created; an adopted window (`WebView.attach` to an existing `NSWindow`)
  keeps its own transparency settings. This is the behaviour of the 2.8.0
  library (and a library rebuilt from the `v1-drafting` branches). The
  published 2.7.0 library instead sets `drawsBackground` to `a != 0` and
  paints the color on the `NSWindow` background (non-opaque unless `a` is
  255): only a fully transparent color turns WebKit's own background off,
  so any other color shows WebKit's default background over the window's.
- Linux: accepted, does nothing.

| Return | When |
|---|---|
| `WEBVIEW_ERROR_OK` (0) | Success. |
| `WEBVIEW_ERROR_INVALID_ARGUMENT` (-2) | A component outside 0 to 255. |
| `WEBVIEW_ERROR_INVALID_STATE` (-3) | Windows: the browser controller does not exist yet. macOS: there is no `WKWebView`. |
| `WEBVIEW_ERROR_UNSPECIFIED` (-1) | Windows: `ICoreWebView2Controller2` is unavailable or refuses the color, including any `a` other than 0 or 255. |

### webview_set_asset

```c
webview_error_t webview_set_asset(webview_t w, const char *path, const char *mime, const void *data, size_t len);
```

Serves bytes at a path of the webview's own origin, so a page is loaded with
`webview_navigate` instead of `webview_set_html` (which Windows caps at
2 MB), fetches its scripts, styles, images and models by relative URL, and
nothing reaches the network.

- `path` is the URL path without the leading `/`; leading slashes are
  stripped. A path that needs percent-encoding is not supported.
- A request's query string and fragment are ignored when matching.
- `mime` is sent as the `Content-Type` header unchanged, so it must be a
  valid header value: printable ASCII and horizontal tabs are allowed; one
  holding CR, LF, NUL or another control character is refused. This
  validation, and the `UINT32_MAX` limit below, are enforced by the Windows
  binding and by the 2.8.0 / `v1-drafting` library on macOS; the published
  2.7.0 library does not check them.
- `len` is at most `UINT32_MAX` (4 GiB - 1), because WebView2 and WebKit take
  body sizes as 32-bit lengths on some paths.
- The bytes are copied into the library. Calling again with the same path
  replaces them. No call removes an asset.
- A request for a path with no asset goes to the request handler, or gets a
  404 with an empty body when none is registered.

| Return | When |
|---|---|
| `WEBVIEW_ERROR_OK` (0) | Success. |
| `WEBVIEW_ERROR_INVALID_ARGUMENT` (-2) | `path` or `mime` is null, `data` is null while `len` is not 0, `mime` is not a valid header value, or `len` is above `UINT32_MAX`. |

| OS | Origin (`ASSET_ORIGIN`) | Served by |
|---|---|---|
| Windows | `http://webview.localhost` | a `WebResourceRequested` filter answering with `CreateWebResourceResponse` |
| macOS | `webview://localhost` | a `WKURLSchemeHandler` for the `webview` scheme, registered on the `WKWebViewConfiguration` before the `WKWebView` is created |
| Linux | | accepted and stored, not served |

On Windows the filters are added with
`ICoreWebView2_22::AddWebResourceRequestedFilterWithRequestSourceKinds` for
every request source kind when the installed WebView2 Runtime has
`ICoreWebView2_22` (Runtime 122, SDK 1.0.2365.46). That also catches requests from service workers,
shared workers and cross-origin iframes. An older Runtime falls back to the
legacy `AddWebResourceRequestedFilter`, which misses those, so on such a
Runtime a service worker or a frames-origin iframe cannot load from these
origins.

### Dynamic interception and the frames origin

```c
webview_error_t webview_set_request_handler(webview_t w, webview_request_handler_t fn, void *arg);
webview_error_t webview_complete_request(webview_t w, uint64_t request_id, int status, const char *headers_json, const void *body, size_t body_len);
```

`webview_set_request_handler` registers a native callback for requests that
miss the asset table at `ASSET_ORIGIN`, and for every request to the second
origin, `FRAMES_ORIGIN`: `http://frames.webview.localhost` on Windows,
`webview-frames://localhost` on macOS. The browser's cross-origin boundary
keeps a page at the first origin from reading the DOM of an iframe at the
second. The RPC binding is installed only when `window === window.top`, and
macOS also rejects messages from subframes with
`WKScriptMessage.frameInfo.isMainFrame`, so framed content cannot call the
app. Both origins use the browser engine's interception: no TCP socket is
opened.

The callback runs on the UI thread. It receives a 64-bit request ID, the
method, the URL, request headers as JSON pairs, a body pointer and byte
length, and the caller's context. The pointers expire when the callback
returns, so Sweetview copies them first. On Windows the binding hands the
handler a copied request object instead (`RawWebview#setRequestHandler`). While a request is open, WebView2
holds an `ICoreWebView2Deferral` and WebKit holds the `WKURLSchemeTask`
(WebKit drops tasks it stops). Linux accepts registration without serving
requests. On macOS the body is what WebKit gives a `WKURLSchemeHandler`: the
parts the page holds in memory. A `Blob` body, or a `FormData` containing a
`File`, arrives empty; see [dynamic requests](app.md#dynamic-requests).

`webview_complete_request` answers a request in one call. It copies the
response, queues delivery, and accepts status 100 to 599, headers as an
object or a list of pairs (repeated names allowed), and raw body bytes. A
repeated completion, or one for a cancelled request, is ignored. Sweetview
calls it on the UI thread for a synchronous `onRequest` handler, and for
worker responses when the streaming symbols are missing.
[Application request API](app.md#dynamic-requests).

### Streaming responses

```c
webview_error_t webview_begin_response(webview_t w, uint64_t request_id, int status, const char *headers_json);
webview_error_t webview_write_response_chunk(webview_t w, uint64_t request_id, const void *chunk, size_t chunk_len);
webview_error_t webview_end_response(webview_t w, uint64_t request_id);
```

`webview_begin_response` sends a response's status and headers,
`webview_write_response_chunk` copies one chunk before returning, and
`webview_end_response` marks the end. Sweetview forwards a worker's
`ReadableStream` body through these as it reads it.

- macOS calls the `WKURLSchemeTask` with the response head, successive
  `didReceiveData:` calls and `didFinish`, so the page receives bytes as
  they arrive. Frames for a stopped task are discarded.
- Windows hands WebView2 an `IStream` that holds unread bytes in the
  binding. Its `Read` waits only while nothing is unread and returns what
  there is at once (a short read), so WebView2 takes each chunk as it is
  written. WebView2 then keeps the whole body itself and gives the response
  to the page only once the stream has ended: the page's `fetch()` does not
  even resolve before that, and an `EventSource` gets every event at the end
  (measured on WebView2 Runtime 158; the tests fail if a later runtime hands
  the page bytes sooner). So a streamed response arrives all at once, and a
  large or endless one grows WebView2's memory until it ends. Use IPC events
  for real-time desktop push.
  [WebView2 Feedback #3519](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3519).
- Windows bounds what the binding holds: a response with 1 MiB unread is
  backlogged until it is read down to 512 KiB. While it is, a
  `webview_write_response_chunk` (`writeResponseChunk`) on any thread but
  the UI thread waits for room, so that writer never has more than 1 MiB and
  one chunk unread, and nothing is dropped or reordered; one on the UI thread
  never waits. For a worker's `ReadableStream` body, Sweetview pauses
  reading that one body while the response is backlogged. With WebView2
  reading every chunk at once, the limit is seldom reached.

### External drops

```c
webview_error_t webview_set_allow_external_drop(webview_t w, int allow);
```

`webview_set_allow_external_drop(w, allow)` controls whether the webview
accepts drags that start in another application: files from Explorer or
Finder, text or links from another app. Nonzero allows them, zero refuses
them; the default is to allow. Drag-and-drop within the page keeps working
either way. Sweetview calls it when `allowExternalDrop` is set on the
webview.

- Windows: sets WebView2's `ICoreWebView2Controller4::AllowExternalDrop`.
  On a WebView2 Runtime too old to have `ICoreWebView2Controller4`, the call
  returns an error, so `WebView.attach` throws
  `webview_set_allow_external_drop failed (<code>)` when `allowExternalDrop`
  is set explicitly. Leave the option unset to keep the engine default on
  such a Runtime.
- macOS: the library's `WKWebView` subclass, `SweetviewWKWebView`, refuses a
  drag whose `NSDraggingInfo.draggingSource` is `nil`. AppKit sets the source
  to `nil` exactly for drags from other applications and to an object for
  drags that start inside the app, so in-page drag-and-drop is untouched.
- Linux: accepted, does nothing.

### File drops over the webview

```c
webview_error_t webview_set_file_drop_handler(webview_t w, webview_file_drop_handler_t fn, void *arg);
```

`webview_set_file_drop_handler(w, fn, arg)` installs a UI-thread callback
`void fn(const char *paths_json, void *arg)` that receives the absolute paths
of files dropped onto the webview, as a JSON array valid for the duration of
the call. A null `fn` removes it, and the engine handles drops as it would
by default. Sweetview installs it while the attached `Window` has at least
one `onFileDrop` listener ([file drops](native/windows.md#file-drops)).

- Windows: WebView2 reports dropped files through `ICoreWebView2File`, read
  while the drop's event arguments are valid. It needs WebView2 Runtime 113
  or later, and external drops allowed. On an older Runtime the handler
  takes nothing: drops are left untouched for the page and the browser's
  default handling, never swallowed. Only drops on the top-level document
  are captured: a drop inside any `<iframe>`, same-origin or cross-origin,
  stays with that iframe and never reaches the handler.
- macOS: `SweetviewWKWebView` takes a drag whose pasteboard carries file
  URLs and whose source allows copying, and resolves the URLs to paths. It
  intercepts Finder file-URL drops anywhere on the `WKWebView` surface,
  iframes included. A drag from Finder is an external drag, so external
  drops must be allowed here too.
- Linux: accepted, does nothing.

### Page behaviour

Not a C function: what the page does for the person using it. The C++
library changed none of WebView2's settings except the developer tools, which
follow `debug`; `wry` changes five, so on Windows the binding puts them back
(`with_page_behaviour` and `WebviewExtras::attach` in
`crates/sweetview-platform-webview`), and its tests read each one back from
WebView2. The result is WebView2's defaults:

| Setting | WebView2 and the C++ library | `wry` 0.58.2 alone | Sweetview 1.0 on Windows |
|---|---|---|---|
| Zoom with Ctrl+wheel, Ctrl+plus, Ctrl+minus, Ctrl+0 (`IsZoomControlEnabled`) | on | off | on |
| Pinch zoom (`IsPinchZoomEnabled`) | on | off | on |
| Back and forward by a horizontal swipe (`IsSwipeNavigationEnabled`) | on | off | on |
| The status bar: a link's address while the pointer is over it (`IsStatusBarEnabled`) | on | off | on |
| CSS `app-region` (`IsNonClientRegionSupportEnabled`) | off | on | off |
| The browser's context menu, its keys (Ctrl+F, Ctrl+P, F5), autofill, script dialogs, the built-in error page, host objects, web messages, SmartScreen (`IsReputationCheckingRequired`) | on | on | on |
| Saving passwords (`IsPasswordAutosaveEnabled`) | off | off | off |
| The developer tools (`AreDevToolsEnabled`) | `debug` | `debug` | `debug` |

The environment is created as the C++ library created it, with no options
(no extra browser arguments, no language, the default scroll bars), which
`wry`'s own environment would add. With `app-region` on, an area marked
`-webkit-app-region: drag` in a stylesheet shared with another shell would
drag the window here and take that area's mouse events from the page, so it
stays off; a frameless window is dragged with `Window.startDrag`. No option
changes any of these yet.

### Teardown

Destroying the webview ends every open request without letting any of them
escape to the network. On Windows the order is: stop accepting new
requests; abort every open streamed response (WebView2's IO thread may be
blocked reading one); close the WebView2 controller, which tears down its
navigation and network stack; then release every deferral still open,
unanswered. Releasing a deferral before the controller closes would let
WebView2 send that request to the network. On macOS, WebKit stops the
outstanding `WKURLSchemeTask`s and later frames for them are discarded.
Answers queued with `webview_complete_request` (`completeRequest` on
Windows) after teardown starts do nothing.

## Library selection and symbol probing

On Windows, `@n1h/sweetview-native` loads its binding on first use with a
literal `require` of `prebuilt/sweetview.win32-x64-msvc.node`, the form
`bun build --compile` embeds in the executable. A `bun build --compile` for
Windows made without that file fails at build time with
`Could not resolve: "../prebuilt/sweetview.win32-x64-msvc.node"`; a build for
macOS does not need it. `SWEETVIEW_NATIVE_PATH`
names a binding you built yourself instead; it is read once, when the
binding first loads, and a file that cannot be loaded throws
`sweetview: the native binding could not be loaded from <path> (SWEETVIEW_NATIVE_PATH): <reason>`.
`WEBVIEW_PATH` has no effect on Windows. The binding has every addition, so
nothing is probed and none of the fallbacks below applies.

On macOS, until the macOS goal of the Rust rewrite,
`@n1h/sweetview` loads the library the way `@n1h/sweetview-webview-bun` does:
`WEBVIEW_PATH` when set, otherwise `libwebview.dll`, `libwebview.dylib` or
`libwebview-<arch>.so` from `@n1h/sweetview-webview-bun/build/`. The
webview, the worker's `webview_dispatch` and the additions all use that one
file, and `bun build --compile` embeds it. Opened libraries are cached per
path, so many windows and tabs do not leak library handles.

Each addition is probed separately, on first use, and cached per path, so a
library that predates one addition still serves everything else:

| Probe | Symbols | When missing |
|---|---|---|
| Transparency | `webview_set_background_color` | `transparent: true` logs a warning; the page stays opaque. |
| Assets | `webview_set_asset` | In asset mode (`page` or `assets` given), `WebView.attach` throws `sweetview: this webview library has no webview_set_asset; ...`. Direct-URL mode (`url` alone) never calls it. |
| Requests | `webview_set_request_handler`, `webview_complete_request` | Setting `onRequest` throws `sweetview: onRequest requires webview_set_request_handler and webview_complete_request from @n1h/sweetview-webview-bun >= 2.8.0 or a compatible WEBVIEW_PATH`. |
| Streaming | `webview_begin_response`, `webview_write_response_chunk`, `webview_end_response`, probed together | Worker response bodies are buffered on the UI thread and sent with one `webview_complete_request`. |
| External drop | `webview_set_allow_external_drop` | Setting `allowExternalDrop` warns once per library path and continues; the engine default (allowed) stays. A library that has the symbol but runs on a WebView2 Runtime without `ICoreWebView2Controller4` is different: the call fails and `WebView.attach` throws (see [External drops](#external-drops)). |
| File drop | `webview_set_file_drop_handler` | `Window.onFileDrop` receives only drops that land on the native window, not on the webview. |

When a symbol exists but returns an error (on Windows, when the binding's
call fails), Sweetview throws with the code:
`webview_set_background_color failed (<code>)`,
`webview_set_asset(<path>) failed (<code>)`,
`webview_set_request_handler failed (<code>)`,
`webview_set_allow_external_drop failed (<code>)`. Failures of
`webview_complete_request`, the streaming calls and
`webview_set_file_drop_handler` are logged instead, since they happen after
the page is running.

## Source

- Windows: this repository, `n0t-invented-here/sweetview`. The webview is
  `crates/sweetview-platform-webview` (what WebView2 needs beyond `wry`) and
  `crates/sweetview-http` (the request rules, ported with the C++ library's
  tests); `crates/sweetview-runtime` creates it with `wry`; the binding is
  `crates/sweetview-napi` and `crates/sweetview-platform-node`. Each crate's
  `README.md` states its job.
- macOS: the C++ library and browser integrations,
  `n0t-invented-here/sweetview-webview`, branch `v1-drafting`; and the Bun
  bindings, native binaries and live tests,
  `n0t-invented-here/sweetview-webview-bun`, branch `v1-drafting`, published
  as `@n1h/sweetview-webview-bun`.
- Desktop facade, worker integration and application docs:
  `n0t-invented-here/sweetview`.
- Files the additions touch in the C++ library: `core/include/webview/api.h`,
  `c_api_impl.hh`, `detail/engine_base.hh`, `detail/backends/win32_edge.hh`,
  `detail/backends/cocoa_webkit.hh`,
  `detail/platform/windows/webview2/loader.hh`.

## Rebuilding

### The Windows binding

From this repository's root, with the Rust toolchain (installed with
[rustup](https://rustup.rs), which on Windows also asks for the Visual Studio
C++ build tools) and the [just](https://github.com/casey/just) recipes,
`just native build` runs `bun install`, then builds
`crates/sweetview-platform-node` in release mode with the napi-rs CLI into
`packages/sweetview-native/prebuilt/` and regenerates `prebuilt/binding.d.ts`
from the Rust signatures. When `cargo` is not on `PATH` it says so, and what to
install, before anything else runs. The recipe is `build` in the `native`
module, whose justfile is `packages/sweetview-native/justfile`.

The built `.node` file is not tracked by git; `binding.d.ts` is. So a clone
has no binding until it is built, and the recipes that run code build it
first: `just check`, `just pack` and `just publish`, and on Windows `just test`
and the demos' `app`, `compile` (`compile-win`) and `drive` recipes. When the
binding is current, the build is cargo's no-op. Running a script directly
(`bun run app.ts`, `bun test`) builds nothing; when the file is not there the
loader's message, `sweetview: the native binding could not be loaded from
@n1h/sweetview-native/prebuilt/sweetview.win32-x64-msvc.node: <reason>`, is
followed by a line that says to run `just native build`. To try a binding
built elsewhere without replacing the prebuilt one, set
`SWEETVIEW_NATIVE_PATH` to its `.node` file.

### The macOS library

Sweetview 1.0.0 on macOS needs the library from the `v1-drafting` branch of
both repositories. The `webview/` recipes of this repository (`just webview ...`,
[webview/README.md](../webview/README.md)) default to `v1-drafting` for both
the bindings checkout and its `webview` submodule, so `just webview clone`
needs no manual checkout step. `just webview status` reports `expected branch
v1-drafting` only when a checkout is on another branch, for example after
setting `SWEETVIEW_WEBVIEW_BRANCH=sweetview` to build the published 2.7.0
line. A separate clone of each repository on `v1-drafting` works the same way,
as long as the bindings' `webview` submodule is on `v1-drafting` too.

Then, on macOS:

1. In the bindings checkout, `just build` builds the library and
   `bun test test/request-handler.test.ts` runs its live interception tests.
2. Set `WEBVIEW_PATH` to the built file (`libwebview.dylib`; Sweetview on
   Windows does not read it) and, from this repository's root, run
   `bun test packages/sweetview/src/request-handler.test.ts`, or run an app
   uncompiled.
