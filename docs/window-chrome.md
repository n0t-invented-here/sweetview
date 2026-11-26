# @n1h/sweetview/window-chrome

A window chrome drawn by the page: the title bar, the minimise, maximise and close buttons and the resize handles are HTML, and the UI thread carries them out on the native window. The module has two halves joined by one method table: `windowChromeMethods` runs on the UI thread, and `windowChromeControls` and `resizeHandles` run in the browser page. Its imports from `@n1h/sweetview/ipc` and `@n1h/sweetview/native` are type-only, so it loads neither `bun:ffi` nor the webview library and a page bundle can import it.

- [Shared types](#shared-types)
  - [WindowChromeKind](#windowchromekind)
  - [WindowChromeInfo](#windowchromeinfo)
  - [WindowChromeMethods](#windowchromemethods)
  - [WindowChromeMethodTable](#windowchromemethodtable)
- [UI thread](#ui-thread)
  - [WindowChromeOptions](#windowchromeoptions)
  - [windowChromeMethods](#windowchromemethods-1)
- [Page](#page)
  - [WindowChromeControls](#windowchromecontrols)
  - [windowChromeControls](#windowchromecontrols-1)
  - [ResizeHandle](#resizehandle)
  - [resizeHandles](#resizehandles)
- [Example](#example)

## Shared types

These types describe the contract between the two halves. They are usable in both environments.

```ts
import type { WindowChromeInfo, WindowChromeKind, WindowChromeMethods } from "@n1h/sweetview/window-chrome";
```

`ResizeEdge` comes from `@n1h/sweetview/native`, see [Windows and screens](native/windows.md#types). It is `"left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right"`.

### WindowChromeKind

```ts
export type WindowChromeKind = "page" | "os";
```

Who draws the window frame. The value is only reported to the page through `window.info`; it does not change the window.

| Value | Meaning |
|---|---|
| `"page"` | The page draws its own chrome. |
| `"os"` | The window has an OS frame, and the page renders without its own chrome. |

### WindowChromeInfo

```ts
export type WindowChromeInfo = { chrome: WindowChromeKind; maximized: boolean };
```

The answer to `window.info`.

| Field | Type | Meaning |
|---|---|---|
| `chrome` | `WindowChromeKind` | Who draws the frame. |
| `maximized` | `boolean` | `window.isMaximized()`: on Windows `IsZoomed` for framed windows and `toggleMaximize()` state for frameless windows; on macOS whether the window is zoomed. |

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

The UI-thread methods a page-drawn chrome calls, as `[params, result]` pairs. Add it to the method map `M` that `WebView.attach` or `createApp` is called with: `type Methods = WindowChromeMethods & { ... }`.

| Method | Params | Result | What `windowChromeMethods` does on the UI thread |
|---|---|---|---|
| `window.info` | `void` | `WindowChromeInfo` | Returns the configured `chrome` kind and `window.isMaximized()`. |
| `window.drag` | `void` | `void` | Calls `window.startDrag()`: the window follows the cursor until the mouse button is released. Windows: the OS's own move loop runs. macOS: the drag starts from the application's current event. |
| `window.resize` | `ResizeEdge` | `void` | Calls `window.startResize(edge)`. Both Windows and macOS drag the requested edge or corner with the cursor while the left mouse button is held. |
| `window.minimize` | `void` | `void` | Calls `window.minimize()`. |
| `window.maximize` | `void` | `void` | Calls `window.toggleMaximize()`: maximised, or back to the previous bounds when already maximised. |
| `window.close` | `void` | `void` | Calls the `onClose` option. Without one, it calls `window.hide()`: the window disappears and the app keeps running. |

### WindowChromeMethodTable

```ts
export type WindowChromeMethodTable = { [K in keyof WindowChromeMethods]: (params: WindowChromeMethods[K][0]) => WindowChromeMethods[K][1] };
```

One handler per method of `WindowChromeMethods`, each taking that method's params and returning its result. `windowChromeMethods` returns one.

## UI thread

This half runs on the UI thread, inside the process that owns the window. It answers the `window.*` calls through the `uiMethods` option of `WebView.attach` or `createApp`, see [app.md](app.md).

The handlers need the `Window`, so create the window first and attach the
webview to it:

```ts
import { WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { windowChromeMethods, type WindowChromeMethods } from "@n1h/sweetview/window-chrome";
import page from "./index.html";

const win = new Window({ frame: false, transparent: true, bounds: { x: 100, y: 100, width: 900, height: 640 } });
const view = await WebView.attach<WindowChromeMethods>(win, {
  page,
  uiMethods: windowChromeMethods(win, { onClose: () => view.quit() }),
});
win.show();
view.run();
```

`windowChromeMethods`, `WindowChromeInfo`, `WindowChromeKind`, `WindowChromeMethods`, `WindowChromeMethodTable` and `WindowChromeOptions` are also exported from the root `@n1h/sweetview`. The page half (`windowChromeControls`, `resizeHandles`) is only in `@n1h/sweetview/window-chrome`.

### WindowChromeOptions

```ts
export type WindowChromeOptions = {
  chrome?: WindowChromeKind;
  onClose?: () => void;
};
```

The options of `windowChromeMethods`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `chrome` | `WindowChromeKind` | `"page"` | What `window.info` reports. Pass `"os"` when the same page is hosted in a plain framed window. |
| `onClose` | `() => void` | `() => window.hide()` | What `window.close` does. The default hides the window and does not quit, so a tray or a menu can show it again. Pass `app.quit` for a main window, so the close button ends the app. |

### windowChromeMethods

```ts
export function windowChromeMethods(
  window: Pick<Window, "hide" | "isMaximized" | "startDrag" | "startResize" | "minimize" | "toggleMaximize">,
  options: WindowChromeOptions = {},
): WindowChromeMethodTable
```

Builds the `window.*` handlers for one window. Spread the result into `uiMethods`. The table in `WindowChromeMethods` lists what each handler does.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `window` | `Pick<Window, ...>` | required | The window the methods act on: a `Window` from `@n1h/sweetview/native` (see [Windows and screens](native/windows.md)), or any object with those six methods, such as a test double. Create a real one with `frame: false` (and usually `transparent: true`) for a page-drawn chrome. |
| `options` | `WindowChromeOptions` | `{}` | See `WindowChromeOptions`. |

Returns: a `WindowChromeMethodTable` bound to `window`.

Throws: on Windows, the `window.resize` handler throws `sweetview: SetTimer failed (<code>)` when the resize timer cannot be created; `WebView` passes the message to the page as a failed call.

Platforms:

- `window.resize` runs `Window.startResize`, Sweetview's own resize loop, on both platforms: every 10 ms while the left button is held (a `SetTimer` on Windows, an `NSTimer` on macOS), it moves the edge or corner with the cursor. It stops at the window's `minWidth` / `minHeight`, or at 160 x 120 window units when neither is set. That 160 x 120 fallback belongs to this custom loop only: resizing a framed window by its native frame, and macOS zoom, use the OS's own limits and `minWidth` / `minHeight`.
- `window.maximize` runs `Window.toggleMaximize`: on a frameless Windows window it toggles between the current monitor's work area (`Screen.of(window).workArea`) and the previous bounds; on a framed Windows window it uses the OS maximize; on macOS it zooms.
- Linux: not available; `new Window()` throws. For a UI on Linux, serve the page to a browser over WebSocket instead: see [browser + WebSocket mode](ipc-ws.md).

Thread: UI thread. Each handler calls the `Window` directly.

## Page

This half runs in the browser page shown in the window. It talks to the UI thread through a `Transport` from `@n1h/sweetview/ipc`, see [ipc.md](ipc.md); inside a webview window that is `webviewTransport()` from `@n1h/sweetview/page`, see [page.md](page.md). It uses no framework.

```ts
import { resizeHandles, windowChromeControls, type ResizeHandle, type WindowChromeControls } from "@n1h/sweetview/window-chrome";
```

### WindowChromeControls

```ts
export type WindowChromeControls = {
  info(): Promise<WindowChromeInfo>;
  onTitlePointerDown(event: { button: number }): void;
  onHandlePointerDown(edge: ResizeEdge): (event: { button: number }) => void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
};
```

What the chrome's elements call.

| Field | Type | Meaning |
|---|---|---|
| `info` | `() => Promise<WindowChromeInfo>` | Calls `window.info` and resolves with the answer. Tells the page whether to draw the chrome at all, and the maximised state for the restore glyph and square corners. Nothing reports later changes, so call it again after `toggleMaximize`. Rejects when the call fails. |
| `onTitlePointerDown` | `(event: { button: number }) => void` | For the title bar's pointer-down. A primary-button press, `button` 0, sends `window.drag`. Other buttons are ignored. |
| `onHandlePointerDown` | `(edge: ResizeEdge) => (event: { button: number }) => void` | Returns the pointer-down handler for one resize handle. A primary-button press sends `window.resize` with `edge`. Other buttons are ignored. |
| `minimize` | `() => void` | Sends `window.minimize`. |
| `toggleMaximize` | `() => void` | Sends `window.maximize`. |
| `close` | `() => void` | Sends `window.close`. |

Every member except `info` sends through `transport.notify` and returns without waiting. With `webviewTransport()`, a failure on the UI thread is logged to the page's console as `<method> failed: <message>`.

### windowChromeControls

```ts
export function windowChromeControls(transport: Transport): WindowChromeControls
```

Builds the page-side controls over a transport.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `transport` | `Transport` | required | The page's connection to the UI thread. In a webview window, `webviewTransport()`. |

Returns: a `WindowChromeControls`.

Thread: browser page.

### ResizeHandle

```ts
export type ResizeHandle = {
  edge: ResizeEdge;
  style: { top?: number; right?: number; bottom?: number; left?: number; width?: number; height?: number; cursor: string };
};
```

The placement of one resize handle.

| Field | Type | Meaning |
|---|---|---|
| `edge` | `ResizeEdge` | The edge or corner the handle resizes from. Pass it to `onHandlePointerDown`. |
| `style` | `{ top?: number; right?: number; bottom?: number; left?: number; width?: number; height?: number; cursor: string }` | Placement inside the window in CSS pixels, plus the CSS cursor. It holds no `position`; add `position: "absolute"`. |

### resizeHandles

```ts
export function resizeHandles(thickness = 6): ResizeHandle[]
```

Returns the eight resize handles along the window's edges: four edge strips `thickness` CSS pixels wide and four corner squares twice that. Lay them over the page, and hide them while the window is maximised.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `thickness` | `number` | `6` | The strip width in CSS pixels. Corners are `2 * thickness` square. |

Returns: the handles in this order, with `t` the thickness and `c` twice it:

| `edge` | Placement | Size | `cursor` |
|---|---|---|---|
| `top` | `top: 0`, `left: t`, `right: t` | `height: t` | `ns-resize` |
| `bottom` | `bottom: 0`, `left: t`, `right: t` | `height: t` | `ns-resize` |
| `left` | `left: 0`, `top: t`, `bottom: t` | `width: t` | `ew-resize` |
| `right` | `right: 0`, `top: t`, `bottom: t` | `width: t` | `ew-resize` |
| `top-left` | `top: 0`, `left: 0` | `width: c`, `height: c` | `nwse-resize` |
| `bottom-right` | `bottom: 0`, `right: 0` | `width: c`, `height: c` | `nwse-resize` |
| `top-right` | `top: 0`, `right: 0` | `width: c`, `height: c` | `nesw-resize` |
| `bottom-left` | `bottom: 0`, `left: 0` | `width: c`, `height: c` | `nesw-resize` |

## Example

Page side, without a framework:

```ts
import { webviewTransport } from "@n1h/sweetview/page";
import { resizeHandles, windowChromeControls } from "@n1h/sweetview/window-chrome";

const chrome = windowChromeControls(webviewTransport());
const info = await chrome.info();
if (info.chrome === "page") {
  document.getElementById("title-bar")?.addEventListener("pointerdown", chrome.onTitlePointerDown);
  document.getElementById("minimize")?.addEventListener("click", () => chrome.minimize());
  document.getElementById("maximize")?.addEventListener("click", () => chrome.toggleMaximize());
  document.getElementById("close")?.addEventListener("click", () => chrome.close());
  for (const h of info.maximized ? [] : resizeHandles()) {
    const el = document.body.appendChild(document.createElement("div"));
    el.style.position = "absolute";
    el.style.cursor = h.style.cursor;
    for (const key of ["top", "right", "bottom", "left", "width", "height"] as const) {
      const value = h.style[key];
      if (value !== undefined) el.style[key] = `${value}px`; // lengths only; cursor is not a length
    }
    el.addEventListener("pointerdown", chrome.onHandlePointerDown(h.edge));
  }
}
```
