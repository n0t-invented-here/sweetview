# The webview library

The library `@n1h/sweetview` runs on, and what differs from upstream webview.

- Shipped by [`@n1h/sweetview-webview-bun`](https://github.com/n0t-invented-here/sweetview-webview-bun)
  in its `build/` folder for Windows x64, macOS (universal) and Linux x64.
- Built from https://github.com/n0t-invented-here/sweetview-webview, branch
  `sweetview`: [webview/webview](https://github.com/webview/webview) at
  `f1a9d6b` plus the two C API calls below.
- The Linux arm64 file in the same folder, `libwebview-arm64.so`, is the
  upstream build and lacks the two calls.

```c
webview_error_t webview_set_background_color(webview_t w, int r, int g, int b, int a);
webview_error_t webview_set_asset(webview_t w, const char *path, const char *mime, const void *data, size_t len);
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
- A request for a path with no asset gets a 404 with an empty body.

| Return | When |
|---|---|
| `WEBVIEW_ERROR_OK` (0) | Success. |
| `WEBVIEW_ERROR_INVALID_ARGUMENT` (-2) | `path` or `mime` is null, or `data` is null while `len` is not 0. |

- Windows: origin `http://webview.localhost`. A `WebResourceRequested` filter
  for that origin answers every request from the table with
  `CreateWebResourceResponse` (200 with the given Content-Type, or 404).
- macOS: origin `webview://localhost`. A `WKURLSchemeHandler` for the scheme
  `webview` is registered on the `WKWebViewConfiguration` before the
  `WKWebView` is created. It answers every `webview:` request from the same
  table with an HTTP response: 200 with the given Content-Type and the byte
  length, or 404.
- Linux: accepted and stored, not served.

`@n1h/sweetview` loads the library file the way `@n1h/sweetview-webview-bun`
does.

- `WEBVIEW_PATH` when set; otherwise `libwebview.dll`, `libwebview.dylib` or
  `libwebview-<arch>.so` from `@n1h/sweetview-webview-bun/build/`.
- The webview, the worker's `webview_dispatch` and the two extra calls use
  that one file, and `bun build --compile` embeds it.
- `createWebviewApp` looks the two symbols up at run time ([app.md](app.md)):

| Situation | Behaviour |
|---|---|
| `transparent: true` and no `webview_set_background_color` | Logs a warning; the page stays opaque. |
| `webview_set_background_color` returns an error | Throws `sweetview: webview_set_background_color failed (<code>)`. |
| No `webview_set_asset` | Throws; the page cannot load without it. |
| `webview_set_asset` returns an error | Throws `sweetview: webview_set_asset(<path>) failed (<code>)`. |
| Asset `mime` | From the path's extension; unknown extensions get `application/octet-stream`. |

## Source

- Library: https://github.com/n0t-invented-here/sweetview-webview, default
  branch `sweetview`.
- Bindings: https://github.com/n0t-invented-here/sweetview-webview-bun,
  default branch `sweetview`, with the library as its submodule; published as
  `@n1h/sweetview-webview-bun`.
- Files the change touches: `core/include/webview/api.h`, `c_api_impl.hh`,
  `detail/engine_base.hh`, `detail/backends/win32_edge.hh`,
  `detail/backends/cocoa_webkit.hh`, `detail/platform/windows/webview2/loader.hh`.

## Rebuilding

The recipes that clone the forks and build the library from them live in
[`webview/`](../webview/README.md) in this repository. A change to the library
reaches this package through a new `@n1h/sweetview-webview-bun` release and a
matching bump of the `@n1h/sweetview-webview-bun` peer dependency.
