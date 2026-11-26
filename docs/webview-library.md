# The webview library

The library `@n1h/sweetview` runs on, and what differs from upstream webview.

- Shipped by [`@n1h/sweetview-webview-bun`](https://github.com/n0t-invented-here/sweetview-webview-bun)
  in its `build/` folder for Windows x64, macOS (universal) and Linux x64.
- The Bun bindings ship the patched library from their `webview` submodule.
  The release work for these additions is on `v1-drafting` in both
  companion repositories. The Linux arm64 build is outside Sweetview's
  supported library targets.

```c
webview_error_t webview_set_background_color(webview_t w, int r, int g, int b, int a);
webview_error_t webview_set_asset(webview_t w, const char *path, const char *mime, const void *data, size_t len);
webview_error_t webview_set_request_handler(webview_t w, webview_request_handler_t fn, void *arg);
webview_error_t webview_complete_request(webview_t w, uint64_t request_id, int status, const char *headers_json, const void *body, size_t body_len);
webview_error_t webview_begin_response(webview_t w, uint64_t request_id, int status, const char *headers_json);
webview_error_t webview_write_response_chunk(webview_t w, uint64_t request_id, const void *chunk, size_t chunk_len);
webview_error_t webview_end_response(webview_t w, uint64_t request_id);
webview_error_t webview_set_allow_external_drop(webview_t w, int allow);
webview_error_t webview_set_file_drop_handler(webview_t w, webview_file_drop_handler_t fn, void *arg);
```

`webview_set_background_color`:

- Windows: sets `ICoreWebView2Controller2::DefaultBackgroundColor`. For the
  desktop to show through, the host window also needs composition that
  honours alpha.
- macOS: sets `drawsBackground` on the `WKWebView` to false when `a` is 0 and
  to true otherwise. It makes the `NSWindow` non-opaque when `a` is below 255
  and sets the window's background colour to the given colour.
- Linux: accepted, does nothing.

Each of `r`, `g`, `b` and `a` is 0 to 255.

| Return | When |
|---|---|
| `WEBVIEW_ERROR_OK` (0) | Success. |
| `WEBVIEW_ERROR_INVALID_ARGUMENT` (-2) | A component outside 0 to 255. |
| `WEBVIEW_ERROR_INVALID_STATE` (-3) | Windows: the browser controller does not exist yet. macOS: there is no `WKWebView`. |
| `WEBVIEW_ERROR_UNSPECIFIED` (-1) | Windows: `ICoreWebView2Controller2` is unavailable or refuses the colour. |

The fork also changes `webview_set_size` on macOS: for a window passed to
`webview_create`, it does nothing, so that window keeps its own style, size
and position.

`webview_set_asset` serves bytes at a path of the webview's own origin.

- A page is loaded with `webview_navigate` instead of `webview_set_html`,
  which Windows caps at 2 MB.
- The page fetches scripts, styles, images and models by relative URL.
- The bytes are copied into the library; nothing reaches the network.

- `path` is the URL path without the leading `/`; leading slashes are
  stripped. A path that needs percent-encoding is not supported.
- A request's query string and fragment are ignored when matching.
- `mime` is sent as the `Content-Type` header unchanged.
- Calling again with the same path replaces the bytes. No call removes an
  asset.
- A request for a path with no asset reaches the request handler, or gets a
  404 with an empty body when no handler is registered.

| Return | When |
|---|---|
| `WEBVIEW_ERROR_OK` (0) | Success. |
| `WEBVIEW_ERROR_INVALID_ARGUMENT` (-2) | `path` or `mime` is null, or `data` is null while `len` is not 0. |

- Windows: origin `http://webview.localhost`. A `WebResourceRequested` filter
  for that origin returns static matches with `CreateWebResourceResponse`.
- macOS: origin `webview://localhost`. A `WKURLSchemeHandler` for the scheme
  `webview` is registered on the `WKWebViewConfiguration` before the
  `WKWebView` is created. Static matches get status 200 with the given
  content type and byte length.
- Linux: accepted and stored, not served.

### Dynamic interception and the second origin

`webview_set_request_handler` registers a native callback for misses at
`ASSET_ORIGIN` and all requests to `FRAMES_ORIGIN`. The second origin is
`http://frames.webview.localhost` on Windows and `webview-frames://localhost`
on macOS. A page at the first origin cannot read iframe DOM at the second.
The binding is installed only when `window === window.top`. macOS also
rejects subframe messages using `WKScriptMessage.frameInfo.isMainFrame`.
Requests to either origin use browser-engine interception and zero TCP.

The callback runs on the UI thread. It receives a 64-bit request ID, method,
URL, request headers as JSON pairs, body pointer, byte length and caller
context. The pointers expire when the callback returns. WebView2 holds an
`ICoreWebView2Deferral`. WebKit holds a `WKURLSchemeTask` and drops stopped
tasks. The fork accepts registration on Linux without serving the requests.

`webview_complete_request` copies response data and queues delivery. It
accepts status 100–599, an object or list of header pairs (including repeated
names), and raw body bytes. A repeat completion or a cancelled request is
ignored. Sweetview invokes this API on the UI thread and forwards asynchronous
worker responses through shared memory. [Application request API](app.md#dynamic-requests).

`webview_begin_response` sends the status and headers for a streamed reply.
`webview_write_response_chunk` copies each chunk before returning.
`webview_end_response` marks EOF. Sweetview forwards these frames from the
worker's body reader on the UI thread and falls back to
`webview_complete_request` when any streaming symbol is missing.

- Windows passes an `IStream` to WebView2 and retains unread bytes in the
  native stream. WebView2 buffers the intercepted response until EOF before
  delivering it to the page. Use IPC events for real-time desktop push.
  [WebView2 Feedback #3519](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3519).
- macOS calls `WKURLSchemeTask` with the response head, successive
  `didReceiveData:` calls, and `didFinish`, enabling incremental delivery.
  Stopped tasks discard later frames.

### External drops

`webview_set_allow_external_drop` sets WebView2's
`ICoreWebView2Controller4::AllowExternalDrop`. A nonzero value enables
external content drops and zero disables them. The default is enabled.
macOS and Linux accept the call without changing behavior.

`webview_set_file_drop_handler` installs a UI-thread callback taking
`(const char *paths_json, void *arg)`. The JSON array is valid for the
duration of the callback. Sweetview registers it when the attached
`Window` has `onFileDrop` listeners and passes a null callback when the
last listener unsubscribes or the attachment is torn down.

- Windows uses WebView2's `ICoreWebView2File` to read the real paths of
  dropped files. External drops must be allowed and the Runtime must be
  version 113 or newer.
- macOS uses the `SweetviewWKWebView` drag destination for Finder file URLs.
- Linux accepts the call without changing behavior.

### Library selection

`@n1h/sweetview` loads the library file the way `@n1h/sweetview-webview-bun`
does.

- `WEBVIEW_PATH` when set; otherwise `libwebview.dll`, `libwebview.dylib` or
  `libwebview-<arch>.so` from `@n1h/sweetview-webview-bun/build/`.
- The webview, the worker's `webview_dispatch` and the fork additions use
  that one file, and `bun build --compile` embeds it.
- `WebView.attach` (and `createApp`) caches the opened library per path and probes optional symbols on use:

| Situation | Behaviour |
|---|---|
| `transparent: true` and no `webview_set_background_color` | Logs a warning; the page stays opaque. |
| `webview_set_background_color` returns an error | Throws `sweetview: webview_set_background_color failed (<code>)`. |
| No `webview_set_asset` | Throws; the page cannot load without it. |
| `webview_set_asset` returns an error | Throws `sweetview: webview_set_asset(<path>) failed (<code>)`. |
| Asset `mime` | From the path's extension; unknown extensions get `application/octet-stream`. |
| `onRequest` with missing request symbols | Throws with guidance to load a compatible library through `WEBVIEW_PATH`. |
| Worker responses with missing streaming symbols | Buffers response bodies on the UI thread and completes them in one native call. |
| `Window.onFileDrop` with a missing WebView drop symbol | Delivers drops routed directly to the native window. |
| `allowExternalDrop` with a missing symbol | Warns once per library path and uses the browser default. |

- [Source](#source)
- [Rebuilding](#rebuilding)

## Source

- C++ library and browser integrations on the `v1-drafting` branch of
  `n0t-invented-here/sweetview-webview`.
- Bun bindings, native binaries and live tests on the `v1-drafting` branch of
  `n0t-invented-here/sweetview-webview-bun`, published as `@n1h/sweetview-webview-bun`.
- Desktop facade, worker integration and application docs in
  `n0t-invented-here/sweetview`.
- Files the change touches: `core/include/webview/api.h`, `c_api_impl.hh`,
  `detail/engine_base.hh`, `detail/backends/win32_edge.hh`,
  `detail/backends/cocoa_webkit.hh`, `detail/platform/windows/webview2/loader.hh`.

## Rebuilding

Use the bindings repository's `just build` on the target OS, then
`bun test test/request-handler.test.ts`. The `^2.7.0` peer range accepts
2.8.0. To verify the new symbols before publication, set `WEBVIEW_PATH` to
the rebuilt target binary. [Platform verification](v1-macos-verification.md).
