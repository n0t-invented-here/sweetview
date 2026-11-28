# @n1h/sweetview/window-chrome

A window chrome drawn by the page: the title bar, the minimise, maximise and close buttons and the resize handles are HTML, and the UI thread carries them out on the native window. The module has two halves joined by one method table: `windowChromeMethods` runs on the UI thread, and `windowChromeControls` and `resizeHandles` run in the browser page. Its imports from `@n1h/sweetview/ipc` and `@n1h/sweetview/native` are type-only, so it loads neither `bun:ffi` nor the webview library and a page bundle can import it.

- [Example](#example)
- [The contract](#the-contract)
- [UI thread: windowChromeMethods](#ui-thread-windowchromemethods)
- [Page: windowChromeControls and resizeHandles](#page-windowchromecontrols-and-resizehandles)
  - [windowChromeControls](#windowchromecontrols)
  - [resizeHandles](#resizehandles)

## Example

A frameless, transparent window whose page draws its own title bar, buttons
and resize handles, in three files. Run it with `bun run host.ts`.

```ts
// host.ts, the UI thread
import { WebView } from "@n1h/sweetview";
import { Window } from "@n1h/sweetview/native";
import { windowChromeMethods, type WindowChromeMethods } from "@n1h/sweetview/window-chrome";
import page from "./index.html";

const win = new Window({ frame: false, transparent: true, bounds: { x: 100, y: 100, width: 900, height: 640 } });
const view = await WebView.attach<WindowChromeMethods>(win, {
  page,
  uiMethods: windowChromeMethods(win, { onClose: () => view.quit() }), // the close button ends the app
});
win.show();
view.run();
```

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Chrome</title>
    <style>
      html, body { margin: 0; height: 100%; background: transparent; font: 14px system-ui, sans-serif; }
      #frame { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden;
               border-radius: 10px; background: #1e1e24; color: #eee; border: 1px solid #3a3a44; }
      #frame.maximized { border-radius: 0; }
      #title-bar { display: flex; align-items: center; height: 36px; padding: 0 8px; background: #16161b;
                   user-select: none; cursor: default; }
      #title { flex: 1; }
      #title-bar button { width: 32px; height: 26px; border: 0; background: none; color: inherit; }
      main { flex: 1; padding: 16px; }
    </style>
  </head>
  <body>
    <div id="frame">
      <div id="title-bar">
        <span id="title">Chrome</span>
        <span id="buttons">
          <button id="minimize" aria-label="Minimise">&#8211;</button>
          <button id="maximize" aria-label="Maximise">&#9633;</button>
          <button id="close" aria-label="Close">&#10005;</button>
        </span>
      </div>
      <main>Drag the title bar, double-click it, or drag an edge.</main>
    </div>
    <script type="module" src="./page.ts"></script>
  </body>
</html>
```

```ts
// page.ts, the page
import { webviewTransport } from "@n1h/sweetview/page";
import { resizeHandles, windowChromeControls } from "@n1h/sweetview/window-chrome";

const chrome = windowChromeControls(webviewTransport());
const frame = document.getElementById("frame")!;
const titleBar = document.getElementById("title-bar")!;
const buttons = document.getElementById("buttons")!;
const maximizeButton = document.getElementById("maximize")!;

// One element per resize handle, positioned from resizeHandles().
const handles = resizeHandles().map((h) => {
  const el = frame.appendChild(document.createElement("div"));
  el.style.position = "absolute";
  el.style.cursor = h.style.cursor;
  for (const key of ["top", "right", "bottom", "left", "width", "height"] as const) {
    const value = h.style[key];
    if (value !== undefined) el.style[key] = `${value}px`; // lengths only; cursor is not a length
  }
  el.addEventListener("pointerdown", chrome.onHandlePointerDown(h.edge));
  return el;
});

// Nothing reports maximise changes, so ask again after each toggle.
const refresh = async () => {
  const { maximized } = await chrome.info();
  frame.classList.toggle("maximized", maximized);
  maximizeButton.setAttribute("aria-label", maximized ? "Restore" : "Maximise");
  for (const el of handles) el.hidden = maximized; // no resizing while maximised
};
const toggleMaximize = () => {
  chrome.toggleMaximize();
  setTimeout(() => void refresh(), 50);
};

const info = await chrome.info();
if (info.chrome === "page") {
  titleBar.addEventListener("pointerdown", chrome.onTitlePointerDown);
  titleBar.addEventListener("dblclick", toggleMaximize);
  // A press on a button must not start a window drag, and a double-click on one must not maximise.
  buttons.addEventListener("pointerdown", (e) => e.stopPropagation());
  buttons.addEventListener("dblclick", (e) => e.stopPropagation());
  document.getElementById("minimize")!.addEventListener("click", () => chrome.minimize());
  maximizeButton.addEventListener("click", toggleMaximize);
  document.getElementById("close")!.addEventListener("click", () => chrome.close());
  await refresh();
} else {
  titleBar.hidden = true; // an OS frame draws the chrome
  for (const el of handles) el.hidden = true;
}
```

`demos/desktop-pet/settings/Chrome.tsx` is the same pattern in React.

## The contract

`WindowChromeMethods` is the method map both halves share, as `[params, result]` pairs. Add it to the method map `M` that `WebView.attach` or `createApp` is called with: `type Methods = WindowChromeMethods & { ... }`. `WindowChromeMethodTable` is the matching handler table (one function per method, from params to result), which `windowChromeMethods` returns.

```ts
import type { WindowChromeInfo, WindowChromeKind, WindowChromeMethods } from "@n1h/sweetview/window-chrome";
```

| Method | Params | Result | What `windowChromeMethods` does on the UI thread |
|---|---|---|---|
| `window.info` | `void` | `WindowChromeInfo` | Returns the configured `chrome` kind and `window.isMaximized()`. |
| `window.drag` | `void` | `void` | Calls `window.startDrag()`: the window follows the cursor until the mouse button is released. Windows: the OS's own move loop runs. macOS: the drag starts from the application's current event, and only while the left mouse button is down. |
| `window.resize` | `ResizeEdge` | `void` | Calls `window.startResize(edge)`. Both Windows and macOS drag the requested edge or corner with the cursor while the left mouse button is held. |
| `window.minimize` | `void` | `void` | Calls `window.minimize()`. |
| `window.maximize` | `void` | `void` | Calls `window.toggleMaximize()`: maximised, or back to the previous bounds when already maximised. |
| `window.close` | `void` | `void` | Calls the `onClose` option. Without one, it calls `window.hide()`: the window disappears and the app keeps running. |

`WindowChromeInfo` is `{ chrome: WindowChromeKind; maximized: boolean }`:

- `chrome` says who draws the frame: `"page"` when the page draws its own chrome, `"os"` when the window has an OS frame and the page renders without one. It is only reported; it does not change the window.
- `maximized` is `window.isMaximized()`: on Windows `IsZoomed` for framed windows and `toggleMaximize()` state for frameless windows; on macOS whether the window is zoomed.

`ResizeEdge` comes from `@n1h/sweetview/native` ([Windows and screens](native/windows.md#types)): `"left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right"`.

## UI thread: windowChromeMethods

`windowChromeMethods(window, options?: WindowChromeOptions): WindowChromeMethodTable`

Builds the `window.*` handlers for one window; pass the result as `uiMethods` (or spread it into yours) on `WebView.attach` or `createApp` ([app.md](app.md)). `window` is a `Window` from `@n1h/sweetview/native` ([Windows and screens](native/windows.md)), or any object with its `hide`, `isMaximized`, `startDrag`, `startResize`, `minimize` and `toggleMaximize` methods, such as a test double. Create a real one with `frame: false` (and usually `transparent: true`) for a page-drawn chrome.

| `WindowChromeOptions` field | Default | Meaning |
|---|---|---|
| `chrome` | `"page"` | What `window.info` reports. Pass `"os"` when the same page is hosted in a plain framed window. |
| `onClose` | `() => window.hide()` | What `window.close` does. The default hides the window and does not quit, so a tray or a menu can show it again. Pass `app.quit` (or `view.quit`) for a main window, so the close button ends the app. |

`windowChromeMethods`, `WindowChromeInfo`, `WindowChromeKind`, `WindowChromeMethods`, `WindowChromeMethodTable` and `WindowChromeOptions` are also exported from the root `@n1h/sweetview`. The page half (`windowChromeControls`, `resizeHandles`) is only in `@n1h/sweetview/window-chrome`.

Throws: on Windows, the `window.resize` handler throws `sweetview: SetTimer failed (<code>)` when the resize timer cannot be created; `WebView` passes the message to the page as a failed call.

Platforms:

- `window.resize` runs `Window.startResize`, Sweetview's own resize loop, on both platforms: every 10 ms while the left button is held (a `SetTimer` on Windows, an `NSTimer` on macOS), it moves the edge or corner with the cursor. It stops at the window's `minWidth` / `minHeight`, or at 160 x 120 window units when neither is set. That 160 x 120 fallback belongs to this custom loop only: resizing a framed window by its native frame, and macOS zoom, use the OS's own limits and `minWidth` / `minHeight`.
- `window.maximize` runs `Window.toggleMaximize`: on a frameless Windows window it toggles between the current monitor's work area (`Screen.of(window).workArea`) and the previous bounds; on a framed Windows window it uses the OS maximize; on macOS it zooms.
- Linux: not available; `new Window()` throws. For a UI on Linux, serve the page to a browser over WebSocket instead: see [browser + WebSocket mode](ipc-ws.md).

Thread: UI thread. Each handler calls the `Window` directly.

## Page: windowChromeControls and resizeHandles

This half runs in the browser page shown in the window. It talks to the UI thread through a `Transport` from `@n1h/sweetview/ipc`, see [ipc.md](ipc.md); inside a webview window that is `webviewTransport()` from `@n1h/sweetview/page`, see [page.md](page.md). It uses no framework.

```ts
import { resizeHandles, windowChromeControls, type ResizeHandle, type WindowChromeControls } from "@n1h/sweetview/window-chrome";
```

### windowChromeControls

`windowChromeControls(transport: Transport): WindowChromeControls` builds the page-side controls over the page's connection to the UI thread (in a webview window, `webviewTransport()`). The members are what the chrome's elements call:

| Member | Meaning |
|---|---|
| `info(): Promise<WindowChromeInfo>` | Calls `window.info` and resolves with the answer. Tells the page whether to draw the chrome at all, and the maximised state for the restore glyph, square corners and hidden resize handles. Nothing reports later changes, so call it again after `toggleMaximize`. Rejects when the call fails. |
| `onTitlePointerDown(event)` | For the title bar's pointer-down. A primary-button press (`event.button` 0) sends `window.drag`. Other buttons are ignored. Buttons inside the title bar stop `pointerdown` propagation so a click on them does not start a drag. |
| `onHandlePointerDown(edge)` | Returns the pointer-down handler for one resize handle. A primary-button press sends `window.resize` with `edge`. Other buttons are ignored. |
| `minimize()` | Sends `window.minimize`. |
| `toggleMaximize()` | Sends `window.maximize`. |
| `close()` | Sends `window.close`. |

Every member except `info` sends through `transport.notify` and returns without waiting. With `webviewTransport()`, a failure on the UI thread is logged to the page's console as `<method> failed: <message>`.

### resizeHandles

`resizeHandles(thickness = 6): ResizeHandle[]` returns the eight resize handles along the window's edges: four edge strips `thickness` CSS pixels wide and four corner squares twice that. Lay them over the page, and hide them while the window is maximised.

A `ResizeHandle` is `{ edge, style }`. Pass `edge` to `onHandlePointerDown`. `style` holds the placement inside the window in CSS pixels (`top`, `right`, `bottom`, `left`, `width`, `height`, each optional) plus the CSS `cursor`; it holds no `position`, so add `position: "absolute"`.

The handles come in this order, with `t` the thickness and `c` twice it:

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
