# Windows and screens

A `Window` is a native top-level window: an `HWND` on Windows, an `NSWindow`
on macOS. It knows nothing about webviews. `WebView.attach` from
`@n1h/sweetview` mounts a page inside one ([app reference](../app.md#webviewattach)),
and `createApp` creates the window and attaches the page in one call. Every
method on this page runs on the UI thread. Part of the
[native module](../native.md).

- [Creating a window](#creating-a-window)
- [Coordinates](#coordinates)
- [WindowOptions](#windowoptions)
- [Kinds of window](#kinds-of-window)
  - [Framed and frameless](#framed-and-frameless)
  - [Transparent](#transparent)
  - [Tabbed](#tabbed)
  - [Stacking, focus and the taskbar](#stacking-focus-and-the-taskbar)
- [Window members](#window-members)
- [Window.fromHandle](#windowfromhandle)
- [Moving and resizing from the page](#moving-and-resizing-from-the-page)
- [Closing](#closing)
- [File drops](#file-drops)
- [Screen](#screen)
- [Types](#types)

## Creating a window

A native window on its own, with no webview: created hidden, shown, kept
alive by the event loop, and disposed when the user closes it.

```ts
import { Window, quitEventLoop, runEventLoop } from "@n1h/sweetview/native";

const win = new Window({
  title: "Settings",
  bounds: { x: 200, y: 200, width: 480, height: 360 },
  minWidth: 320,
  minHeight: 240,
});
win.onClose(() => quitEventLoop()); // a listener keeps the window open; this one ends the app
win.show();

await runEventLoop(); // the script ends here, and Sweetview closes the window
```

Attach a page to it with [`WebView.attach`](../app.md#webviewattach).

`createWindow(options)` is the same as `new Window(options)`.

A window is always created hidden. Position it, subscribe to its events and
attach a webview first, then call `show()`, so the user never sees an empty
or misplaced frame.

When `options.identity` is set (an `AppIdentity` from
[`defineAppIdentity`](../settings-store.md#defineappidentity)), the window
takes its default title from `identity.appName` and, on Windows, its icon from
`identity.icon`. Explicit `title` and `icon` options win.

## Coordinates

Positions and sizes are in window units:

| | Unit | Origin |
|---|---|---|
| Windows | physical pixels (the process is per-monitor DPI aware) | top-left corner of the primary monitor |
| macOS | points | top-left corner of the primary screen (Sweetview flips AppKit's bottom-left origin) |

`options.contentSize` is the other way to size a window, from its page:
the page area in device-independent pixels (CSS pixels), with the window
centred on the primary screen's work area and its frame sized around the page
at that screen's scale. `{ contentSize: { width: 1100, height: 720 } }` is a
1100 x 720 page at 100 % (a 1100 x 720 client area) and at 150 % (1650 x 1080
physical pixels), the same size to the eye. A window that would not fit is cut
to the work area. Give `bounds` or `contentSize`, not both: both throw
`sweetview: bounds and contentSize cannot both be given`. On macOS, where
points already are CSS pixels, it is the content rectangle AppKit frames;
a macOS tabbed window takes it as its frame's size until the macOS goal.

`options.bounds`, `bounds()`, `setBounds()`, `moveTo()`, `resize()`,
`onMove` and `onResize` all use the outer frame: the rectangle that includes
the title bar and borders of a framed window. The same numbers place a window
in the same spot on both platforms, regardless of frame.

`win.scale()` is the number of window units per CSS pixel of the page:
`dpi / 96` on Windows (1.5 on a 150 % monitor) and always `1` on macOS,
because AppKit points already are CSS pixels. It is not the Retina backing
scale; for that, read `Screen.of(win).scale`, which is `2` on a Retina
display. Multiply page coordinates by `win.scale()` to get window units.

## WindowOptions

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | `string` | `identity.appName`, else `""` | Title bar text. |
| `identity` | `AppIdentity` | none | Default title and Windows icon. |
| `bounds` | `Rect` | 320 x 240 centered on the primary work area; tabbed windows a 1040 x 720 page | Initial outer frame, window units. Not with `contentSize`. |
| `contentSize` | `{ width: number; height: number }` | none | The page area in CSS pixels, centered on the primary work area; see [Coordinates](#coordinates). A tabbed window's page is below its strip. Not with `bounds`. |
| `minWidth`, `minHeight` | `number` | none | Minimum outer size, enforced by OS resizing and by `startResize`. |
| `frame` | `boolean` | `true` | OS title bar and borders (`true`) or frameless (`false`). |
| `resizable` | `boolean` | same as `frame` | Whether the OS frame resizes. |
| `appearance` | `"system" \| "light" \| "dark"` | `"system"` | Theme of a framed window's title bar. |
| `icon` | `Icon` | from `identity`, else the stock icon | Windows title bar, taskbar and Alt+Tab icon. Ignored on macOS. |
| `tabs` | `boolean` | `false` | A native tabbed container; see [Tabbed](#tabbed). |
| `transparent` | `boolean` | `false` | Per-pixel alpha; see [Transparent](#transparent). |
| `colorKey` | `string` | none | Windows-only 1-bit color key; see [overlays](overlays-and-hit-regions.md#colorkey-vs-transparent). |
| `backgroundColor` | `string` | the system's, or `appearance`'s | `"#rrggbb"`: what the window shows where nothing has painted: before its page paints, behind a page that leaves its background transparent, and after its webview has gone. The webview `WebView.attach` mounts takes it as the browser's background too, and a tabbed window's page area and its tabs' webviews. Not applied to a `transparent` window (it shows what is behind it). Anything else throws `sweetview: background color must be #rrggbb, got <text>`. macOS: accepted and ignored until the macOS goal. |
| `opacity` | `number` | none | Whole-window opacity, clamped to `0..1`. |
| `topmost` | `boolean` | `false` | Above normal windows. |
| `hideFromTaskbar` | `boolean` | `false` | Omitted from the taskbar and app switcher. |
| `noActivate` | `boolean` | `false` | Never takes focus when shown or clicked. |
| `onResize`, `onMaximizeChange`, `onMove`, `onClose`, `onFileDrop`, `onNewTab`, `onTabSelect`, `onTabClose` | callbacks | none | Subscribed at construction; the same as calling the matching method afterwards. |

`opacity`, `topmost`, `hideFromTaskbar` and `noActivate` apply to framed,
frameless and tabbed windows alike.

## Kinds of window

### Framed and frameless

A framed window (`frame: true`, the default) has the OS title bar, borders,
close / minimize / zoom buttons, and OS move and resize. `resizable` defaults
to `true` for it.

A frameless window (`frame: false`) has none of these, and `resizable`
defaults to `false`, because there is no border to grab. A page-drawn title
bar moves and resizes it with [`startDrag` and `startResize`](#moving-and-resizing-from-the-page);
[`@n1h/sweetview/window-chrome`](../window-chrome.md) packages that pattern.
`toggleMaximize()` on a frameless Windows window toggles between
`Screen.of(win).workArea` and the saved bounds, since Windows' own maximize
assumes a frame.

### Transparent

`transparent: true` makes the window alpha-composited: whatever the page
leaves transparent shows the desktop behind it. Pair it with a page whose
`html` and `body` have `background: transparent`; `WebView.attach` clears
the webview's own background for you. It works on framed and frameless
windows on both platforms, though it is mostly used frameless, for
overlays. Pixels you cannot see still take clicks until you add
[click-through or hit regions](overlays-and-hit-regions.md).

### Tabbed

`tabs: true` makes a native, OS-framed tab container. Tabs are opened with
`WebView.openTab` or `app.openTab` ([app reference](../app.md#webviewopentab)),
each tab hosting its own webview. The platforms build tabs very differently,
and that shows in the `Window` you get back:

| | Windows | macOS |
|---|---|---|
| Structure | one framed `HWND` whose title bar is a Sweetview tab strip; the strip and every tab are WebView2 webviews made as children of that window, one tab shown at a time | an AppKit window tab group: every tab is its own `NSWindow` hosting its own `WKWebView`, and AppKit draws the tab bar |
| `win.handle` | the frame's `HWND` | `null`: the `Window` is virtual and stands for the whole group, because no single `NSWindow` is the container |
| Default size | 1040 x 720 content plus the strip, centered | 1040 x 720 at (100, 100) |
| Appearance | `appearance` themes the frame and strip | `appearance` applies to each tab's `NSWindow` |
| New-window links | an HTTP(S) `target="_blank"` link or `window.open()` opens a new tab after the current one (WebView2 `NewWindowRequested`); other schemes are dropped | the same, through the tab's `WKUIDelegate` (`createWebViewWithConfiguration:`); file open panels keep working |
| Failed loads | a URL tab whose navigation fails shows a "This site did not open" page with the address, the reason and a Try Again link | the same page |

Before the first tab opens, a macOS tabbed `Window` records `show()`,
`setBounds()`, `setTitle()` and `setTopmost()` calls and replays them on the
first tab window. Code that needs a native handle must not assume one on
macOS; `Screen.of(win)` handles the virtual window by resolving its active
tab, or its recorded bounds before any tab exists.

`frame`, `transparent` and `colorKey` do not apply to tabbed windows, and
`setClickThrough` / `setHitRegions` are no-ops on them. A tab strip is
OS-framed chrome; an overlay is a separate non-tabbed `Window`.
[Why](overlays-and-hit-regions.md#tabbed-windows).

`onNewTab(origin)`, `onTabSelect(tab)` and `onTabClose(tab)` fire on the tabbed
window for the "+" button / Ctrl+T / Cmd+T, a tab becoming active, and a tab
closing. Events on a torn-off window are also forwarded to the window it tore
off from. `onNewTab` receives the originating `Window`
(`(origin: Window) => void`), the main window or whichever torn-off window
requested the tab, so a handler in a multi-window tabbed app can call
`WebView.openTab(origin, ...)` to open the tab in the window that asked.

### Stacking, focus and the taskbar

| Option | Windows | macOS |
|---|---|---|
| `topmost` | `HWND_TOPMOST` z-order; `moveTo` re-asserts it | status window level |
| `opacity` | layered-window alpha | `alphaValue` |
| `hideFromTaskbar` | per window: `WS_EX_TOOLWINDOW`, no taskbar button, no Alt+Tab entry | `NSWindowCollectionBehaviorIgnoresCycle` on the window, and the whole app switches to the `accessory` activation policy |
| `noActivate` | `WS_EX_NOACTIVATE`, shown with `SW_SHOWNOACTIVATE` | shown with `orderFrontRegardless`; a frameless window never becomes key |

`hideFromTaskbar` differs because the platforms put taskbar presence in
different places. Windows decides per window. macOS decides per process: the
Dock tile and Cmd+Tab entry belong to the application, so hiding one window
from them means making the whole app an `accessory` app, which also removes
the menu bar. See [`setActivationPolicy`](menus-and-tray.md#setactivationpolicy).

## Window members

| Member | Meaning |
|---|---|
| `handle` | `HWND` on Windows, `NSWindow*` on macOS, `null` for a macOS tabbed window. |
| `Window.visibleWindows()` | Visible windows this process created with `new Window`, minimized ones included. Wrappers from `fromHandle` are not listed. |
| `isVisible()`, `show()`, `hide()`, `toggle()` | Visibility. `isVisible()` is true for a minimized window too; see `isMinimized()`. `show()` restores a minimized Windows window and activates the app on macOS, unless `noActivate`. |
| `bounds()`, `setBounds(rect)` | Outer frame rectangle. |
| `moveTo(x, y)`, `resize(width, height)` | Moves the outer top-left corner keeping the size; resizes keeping the top-left corner. |
| `scale()` | Window units per CSS pixel; see [Coordinates](#coordinates). |
| `setTitle(title)` | Title bar text. |
| `setIcon(icon)` | Windows: title bar, taskbar and Alt+Tab icon from `icon.windows.ico`; `undefined` restores the stock icon. macOS: no-op. [Why](event-loop-and-icons.md#app-icon-vs-window-icon). |
| `minimize()` | Minimizes. |
| `isMinimized()` | Whether the window is minimized: `IsIconic` on Windows (created, frameless, tabbed and `fromHandle` windows alike), `isMiniaturized` on macOS (a tabbed window: its active tab). `isVisible()` is also true for a minimized window, so "on screen" is `isVisible() && !isMinimized()`. A window made hidden, or restored by `show()`, reads `false`. |
| `toggleMaximize()`, `isMaximized()` | Framed Windows: `SW_MAXIMIZE` / `SW_RESTORE` and `IsZoomed`. Frameless Windows: work area vs saved bounds. macOS: `zoom:` and `isZoomed`. |
| `onMaximizeChange(fn: (maximized: boolean) => void)` | Called with `true` when the window becomes maximized and `false` when it is restored, by any means: the frame's button, a snap gesture, a title bar double click, the system menu, `toggleMaximize()` (a frameless window: filling its work area). Once per change: minimizing a maximized window and restoring it reports nothing. Windows: from the window's `WM_SIZE`; macOS: from its resize notifications and `isZoomed`. Replaces polling `isMaximized()`. |
| `showSystemMenu()` | Windows: the window's system menu (Restore, Move, Size, Minimize, Maximize, Close) at the cursor, the choice carried out as the title bar's own menu does; for a page-drawn title bar's right click ([window chrome](../window-chrome.md)). Blocks until it closes. macOS: does nothing; AppKit windows have no such menu. |
| `setTopmost(on)` | Changes `topmost` after creation. |
| `startDrag()`, `startResize(edge)` | Page-driven move and resize; see [below](#moving-and-resizing-from-the-page). |
| `setClickThrough(on)`, `setHitRegions(polygons, refine?)` | See [overlays](overlays-and-hit-regions.md). |
| `onResize(fn)`, `onMove(fn)` | Called with the new outer `Rect`. |
| `onClose(fn)`, `onFileDrop(fn)` | See [Closing](#closing) and [File drops](#file-drops). |
| `onNewTab(fn: (origin: Window) => void)`, `onTabSelect(fn)`, `onTabClose(fn)` | Tab events; see [Tabbed](#tabbed). |
| `dispose()` | Destroys an owned window, or detaches a wrapper's hooks. Releases timers, subclass hooks, observers and icons. A webview attached to an owned window is torn down with it ([lifecycle](../app.md#lifecycle)). On Windows every window is disposed when the application ends ([the end of the application](../app.md#the-end-of-the-application)); call it for one that should go before that. Safe to call twice. |

Every `on*` method accepts any number of listeners and returns a function
that removes that one subscription. A listener that throws is logged with
`console.error` and the others still run.

## Window.fromHandle

```ts
import { Window, type WindowHandle } from "@n1h/sweetview/native";

// hwndOrNsWindow: an HWND (Windows) or NSWindow* (macOS) from a plugin or another library.
export function logForeignBounds(hwndOrNsWindow: WindowHandle): void {
  const wrapped = Window.fromHandle(hwndOrNsWindow);
  console.log(wrapped.bounds());
  wrapped.dispose(); // detaches hooks; the foreign window stays open
}
```

`Window.fromHandle(handle)` wraps a window something else created, such as
one from a plugin or another library. It does not change the window's style
and does not own its lifetime: `dispose()` removes the hooks Sweetview added
and leaves the window alive. It throws `sweetview: window handle is NULL`
(Windows) or `sweetview: window handle is nil` (macOS) for `null`, `0` or
`0n`. On Windows a handle that names no window throws `sweetview: not a
window: 0x…`, and events (`onClose`, `onResize`, `onMove`, `onFileDrop`) can
be observed only on a window of the UI thread; for a window of another thread
they throw `sweetview: a window of another thread cannot be observed`.

The wrapper reads the window's real chrome so `WebView.attach` and
`toggleMaximize` behave correctly: `frame` and `resizable` come from
`GWL_STYLE` (`WS_POPUP`, `WS_THICKFRAME`) on Windows and from `styleMask`
(`Titled`, `Resizable`) on macOS.

macOS limits what a wrapper can intercept, because Sweetview hooks close and
drag-and-drop by subclassing its own `NSWindow` class, which it cannot do to
a foreign window without breaking that window's owner:

- `onClose` catches the standard close button when the window has one, by
  retargeting the button, without replacing the window's `delegate`. A
  `performClose:` call, Cmd+W, and a borderless foreign window are not
  intercepted.
- `onFileDrop` throws `sweetview: file drops require a Sweetview-managed NSWindow`.

On Windows a wrapper subclasses the `HWND`, so `onClose` and `onFileDrop`
work as they do on an owned window.

## Moving and resizing from the page

A frameless window has no title bar or border, so the page asks the OS to run
its move or resize loop. Call these from a UI-thread method invoked while the
left mouse button is down (a `pointerdown` handler in the page).

- `startDrag()` hands the current press to the OS move loop:
  `WM_NCLBUTTONDOWN` with `HTCAPTION` on Windows,
  `performWindowDragWithEvent:` on macOS. Snap layouts and multi-monitor
  moves behave as with a real title bar.
- `startResize(edge)` runs a 10 ms cursor-tracking loop (a `SetTimer` on
  Windows, an `NSTimer` reading `NSEvent.pressedMouseButtons` on macOS) that
  resizes from `edge` until the left button is released. It enforces
  `minWidth` / `minHeight`, or a 160 x 120 floor when neither is set.

Both act on the left button only. Native frame resizing of a framed window
and macOS zoom do not use the 160 x 120 floor; they use the OS limits and
`minWidth` / `minHeight`.

## Closing

`onClose(fn)` intercepts the user's request to close: the close button,
Alt+F4 or Cmd+W, and `performClose:` on macOS. Once at least one listener is
registered, the window stays open and the listener decides what happens:
`hide()`, `dispose()`, or quitting the app. With no listener, closing an
owned window destroys and disposes it. Closing a window never ends the event
loop by itself; `createApp` adds that behaviour for its main window.

```ts
import { Tray, Window, closeToTrayOnLastWindow, dotIco, quitEventLoop, runEventLoop } from "@n1h/sweetview/native";

const win = new Window({ title: "Notes", bounds: { x: 200, y: 200, width: 640, height: 480 } });
const tray = new Tray({
  tooltip: "Notes",
  icon: { windows: { ico: dotIco() }, macos: { symbol: "note.text" } },
  menu: [
    { label: "Show Notes", click: () => win.show() },
    { label: "Quit", click: () => quitEventLoop() },
  ],
});
closeToTrayOnLastWindow(win, () => tray.setTooltip("Notes (hidden)"));
win.show();

await runEventLoop(); // closing the window hides it; Quit ends the loop, and the script
```

`closeToTrayOnLastWindow(win, onHide?)` installs an `onClose` listener that
disposes `win` when another owned window is still visible, and otherwise
hides it and calls `onHide(win)`. It returns the listener's unsubscribe
function. It does not create the tray; wire the tray's reopen action
yourself.

## File drops

```ts
import { Window, quitEventLoop, runEventLoop } from "@n1h/sweetview/native";

const win = new Window({ title: "Drop files here", bounds: { x: 200, y: 200, width: 480, height: 320 } });
win.onFileDrop((paths) => {
  for (const path of paths) console.log("dropped", path);
});
win.onClose(() => quitEventLoop()); // closing a window does not end the loop by itself
win.show();

await runEventLoop();
```

`onFileDrop(fn)` receives absolute file-system paths of files dropped from
Explorer or Finder. It is delivered from two places, depending on what the
pointer is over:

| Drop target | Windows | macOS |
|---|---|---|
| The native window itself (a window without a webview, or its frame) | `WM_DROPFILES` | the Sweetview `NSWindow` subclass registers as a drag destination and resolves Finder file-reference URLs to paths |
| An attached webview's surface | the Rust binding's file drop handler (`sweetview-platform-webview`): WebView2 reports paths through `ICoreWebView2File` (WebView2 Runtime 113 or later; an older Runtime leaves the drop untouched for the page and the browser instead of swallowing it) | the webview library's `webview_set_file_drop_handler` (until the macOS goal of the Rust rewrite): the library's `SweetviewWKWebView` reads Finder file URLs |

Subscribe before or after attaching a webview. The first listener turns
webview surface drops on, and removing the last listener turns them off,
giving the drop back to the browser's default handling (which, for a file,
usually means navigating to it).

The two platforms capture different parts of the webview surface:

- Windows: only drops on the top-level document. A drop inside any
  `<iframe>`, same-origin or cross-origin, stays with that iframe and never
  reaches `onFileDrop`.
- macOS: `SweetviewWKWebView` intercepts Finder file-URL drops anywhere on
  the `WKWebView` surface, iframes included.

A drop over the webview reaches `onFileDrop` only when external drops are
enabled: `allowExternalDrop` must not be `false` on the webview, on Windows
and on macOS alike, because rejecting drags from other apps is exactly what
that option does. Drags within the page keep working either way.

What happens when `allowExternalDrop` cannot be applied depends on why:

- On macOS, a webview library without `webview_set_allow_external_drop`
  logs a warning once per library path and continues with the engine
  default (external drops allowed).
- On Windows, a WebView2 Runtime without `ICoreWebView2Controller4` returns
  an error, and `WebView.attach` throws
  `webview_set_allow_external_drop failed (<code>)` when
  `allowExternalDrop` is specified explicitly.

On macOS, a webview library without `webview_set_file_drop_handler` still
delivers drops that land on the native window. In a tabbed app, drops over a tab's webview are
delivered to the tab's current logical tabbed `Window`, which changes when the
tab tears off or merges.

A wrapper from `Window.fromHandle` on macOS cannot subscribe; see
[Window.fromHandle](#windowfromhandle).

## Screen

```ts
import { Screen, Window } from "@n1h/sweetview/native";

const { workArea } = Screen.primary();
const win = new Window({
  bounds: { x: workArea.x + workArea.width - 340, y: workArea.y + 20, width: 320, height: 240 },
});
```

`Screen` answers monitor and cursor questions without a window. Coordinates
are the same window units as `Window` ([Coordinates](#coordinates)).

| Member | Returns |
|---|---|
| `Screen.primary()` | The primary monitor. |
| `Screen.all()` | Every connected monitor. |
| `Screen.at(point)` | The monitor containing `point`, or the nearest one when it is outside all of them. |
| `Screen.of(window)` | The monitor showing most of `window`: a `Window`, anything with a `handle`, or a raw `WindowHandle`. A macOS tabbed `Window` resolves through its active tab, or through its bounds before any tab exists. |
| `Screen.bounds()` | The bounding rectangle of all monitors. |
| `Screen.cursor()` | The cursor position. |

`ScreenInfo` is `{ bounds, workArea, scale, primary }`. `workArea` excludes
the taskbar, the Dock and the menu bar. `scale` is the monitor's DPI factor
on Windows (1, 1.25, 1.5, 2, ...) and the backing scale factor on macOS (1 or
2). Compare [`Window.scale()`](#coordinates), which is always 1 on macOS.

## Types

| Type | Definition |
|---|---|
| `WindowHandle` | `Pointer \| bigint \| number \| null` |
| `Point` | `{ x: number; y: number }` |
| `Rect` | `{ x: number; y: number; width: number; height: number }` |
| `Appearance` | `"system" \| "light" \| "dark"` |
| `ResizeEdge` | `"left" \| "right" \| "top" \| "bottom" \| "top-left" \| "top-right" \| "bottom-left" \| "bottom-right"` |
| `TabHandle` | `{ readonly title: string; setTitle(title): void; select(): void; close(): void; dispose(): void }`, the part of a tab the native module sees |
| `HitRefiner` | see [overlays](overlays-and-hit-regions.md#sethitregions) |
| `WindowOptions` | see [WindowOptions](#windowoptions) |
