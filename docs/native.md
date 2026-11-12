# @n1h/sweetview/native

Native desktop pieces for a Bun app, called over `bun:ffi`: a tray icon, notifications, control of the webview's window, overlay windows with click-through hit regions, a folder dialog, the macOS app menu and Dock icon, the OS event loop for an app with no webview window, menus as data, and icon encoders. Every function that touches the OS is implemented for Windows and macOS and runs on the UI thread, the thread that owns the window and spins the webview's run loop. The menu, icon and hit-region helpers are plain TypeScript; all but `createHitRelay` run on any thread. Install and the overview are in [../README.md](../README.md).

```ts
import { createTray, createNotifier, nativeWindow, createOverlayWindow, makeOverlay, convexHull, createHitRelay, flattenRegions, hitRegions, packRegions, unpackRegions, pickFolder, installAppMenu, setAppIcon, setActivationPolicy, pumpEvents, runEventLoop, resolveMenu, decodePng, dotIcns, dotIcon, dotPng, encodeIcns, encodeIco, encodePng, icnsFromPng, icnsFromRgba, icoFromPng, icoFromRgba, renderDot, trimTransparent, type Tray, type TrayIcon, type TrayOptions, type NotificationClick, type NotificationOptions, type Notifier, type NotifierOptions, type NativeWindow, type WindowHandle, type Overlay, type OverlayOptions, type OverlayWindowOptions, type HitRefiner, type Point, type Rect, type ResizeEdge, type HitPolygon, type HitProbe, type HitRelay, type AppMenuOptions, type ActivationPolicy, type EventLoopOptions, type MenuItem, type MenuSource, type MenuTemplate, type DecodedPng, type DotIconOptions, type Icon } from "@n1h/sweetview/native";
```

Every function that touches the OS picks its Windows or macOS implementation on its first call. On any other OS that call throws `sweetnative: <platform> is not supported (win32 and darwin are)`. Importing the module does not throw on any OS.

- [Tray](#tray)
  - [createTray](#createtray)
  - [Tray](#tray-1)
  - [TrayIcon](#trayicon)
  - [TrayOptions](#trayoptions)
- [Notifications](#notifications)
  - [createNotifier](#createnotifier)
  - [NotificationOptions](#notificationoptions)
  - [Notifier](#notifier)
  - [NotifierOptions](#notifieroptions)
  - [NotificationClick](#notificationclick)
- [Windows and overlays](#windows-and-overlays)
  - [nativeWindow](#nativewindow)
  - [NativeWindow](#nativewindow-1)
  - [WindowHandle](#windowhandle)
  - [createOverlayWindow](#createoverlaywindow)
  - [makeOverlay](#makeoverlay)
  - [Overlay](#overlay)
  - [OverlayOptions](#overlayoptions)
  - [OverlayWindowOptions](#overlaywindowoptions)
  - [HitRefiner](#hitrefiner)
  - [Point](#point)
  - [Rect](#rect)
  - [ResizeEdge](#resizeedge)
- [Hit regions](#hit-regions)
  - [convexHull](#convexhull)
  - [createHitRelay](#createhitrelay)
  - [flattenRegions](#flattenregions)
  - [hitRegions](#hitregions)
  - [packRegions](#packregions)
  - [unpackRegions](#unpackregions)
  - [HitPolygon](#hitpolygon)
  - [HitProbe](#hitprobe)
  - [HitRelay](#hitrelay)
- [Folder picker](#folder-picker)
  - [pickFolder](#pickfolder)
- [App menu](#app-menu)
  - [installAppMenu](#installappmenu)
  - [AppMenuOptions](#appmenuoptions)
- [App icon](#app-icon)
  - [setAppIcon](#setappicon)
- [Event loop](#event-loop)
  - [runEventLoop](#runeventloop)
  - [pumpEvents](#pumpevents)
  - [EventLoopOptions](#eventloopoptions)
- [App activation](#app-activation)
  - [setActivationPolicy](#setactivationpolicy)
  - [ActivationPolicy](#activationpolicy)
- [Menus](#menus)
  - [resolveMenu](#resolvemenu)
  - [MenuItem](#menuitem)
  - [MenuSource](#menusource)
  - [MenuTemplate](#menutemplate)
- [Icons](#icons)
  - [decodePng](#decodepng)
  - [dotIcns](#doticns)
  - [dotIcon](#doticon)
  - [dotPng](#dotpng)
  - [encodeIcns](#encodeicns)
  - [encodeIco](#encodeico)
  - [encodePng](#encodepng)
  - [icnsFromPng](#icnsfrompng)
  - [icnsFromRgba](#icnsfromrgba)
  - [icoFromPng](#icofrompng)
  - [icoFromRgba](#icofromrgba)
  - [renderDot](#renderdot)
  - [trimTransparent](#trimtransparent)
  - [DecodedPng](#decodedpng)
  - [DotIconOptions](#doticonoptions)
  - [Icon](#icon)
- [Example](#example)

## Tray

### createTray

```ts
function createTray(options: TrayOptions): Tray
```

Adds an icon to the Windows notification area, or a status item to the macOS menu bar, and returns the handle that changes or removes it.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `options` | [`TrayOptions`](#trayoptions) | required | Tooltip, icon, menu and click handlers. |

Returns: a [`Tray`](#tray-1).

Throws:

- Windows, when `options.icon.windows.ico` is not a readable .ico file.
- Windows, when the hidden window that receives the tray's messages cannot be created.
- MacOS, when the system status bar returns no item.

Platforms: Windows: implemented; the menu opens on right click; the icon is added again when Explorer restarts; an icon the shell refuses at login is logged and added once the taskbar appears. macOS: implemented; with a menu set, every click opens the menu and the click handlers never fire. Linux: throws.

Thread: UI thread. The handlers and the menu's `click` functions run on the UI thread from inside the OS message loop, while the webview's run loop is on the stack; they must return quickly and cannot await anything that needs Bun's event loop. The single-click delay is an OS timer, so it fires only while the webview's run loop pumps messages.

### Tray

```ts
interface Tray {
  setTooltip(text: string): void;
  setIcon(icon: TrayIcon): void;
  setMenu(menu: MenuSource | undefined): void;
  dispose(): void;
}
```

| Member | Meaning |
|---|---|
| `setTooltip(text)` | Replaces the hover text. Windows keeps the first 127 UTF-16 code units. No-op after `dispose`. |
| `setIcon(icon)` | Replaces the icon. No-op after `dispose`. Windows: throws when `icon.windows.ico` is not a readable .ico file. |
| `setMenu(menu)` | Replaces the menu source; `undefined` removes the menu. Takes effect at the next click. |
| `dispose()` | Removes the icon. Safe to call twice. |

### TrayIcon

```ts
type TrayIcon = Icon;
```

The tray's icon, an [`Icon`](#icon). Each platform takes the image it needs from it.

| Use | Windows | macOS |
|---|---|---|
| Tray or menu bar | the .ico entry at the system small-icon size, 16 px at 100 % scale | the image at 18x18 points; a PNG wants 36 px for Retina; a template image unless `template: false` |
| Notification | the .ico entry at the system large-icon size, 32 px at 100 % scale | not used |
| No usable image | tray: the stock application icon; notification: the system information icon | a dot character as the item's title |

### TrayOptions

```ts
type TrayOptions = {
  tooltip?: string;
  icon?: TrayIcon;
  menu?: MenuSource;
  onClick?: () => void;
  onDoubleClick?: () => void;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `tooltip` | `string` | `""` | Hover text. Windows keeps the first 127 UTF-16 code units. |
| `icon` | [`TrayIcon`](#trayicon) | stock image | The tray's icon. |
| `menu` | [`MenuSource`](#menusource) | none | Windows: opens on right click. macOS: opens on any click, as menu bar items do. A source that resolves to an empty template opens nothing. |
| `onClick` | `() => void` | none | Left single click. Fires one system double-click interval after the click, and only when no second click follows. macOS: only when no menu is set. |
| `onDoubleClick` | `() => void` | none | Left double click. A double click does not also fire `onClick`. macOS: only when no menu is set. |

## Notifications

### createNotifier

```ts
function createNotifier(options: NotifierOptions = {}): Notifier
```

Creates the object that shows system notifications and reports clicks on them.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `options` | [`NotifierOptions`](#notifieroptions) | `{}` | The click handler. |

Returns: a [`Notifier`](#notifier).

Throws: Windows, when no tray exists: `sweetnative: on Windows, create the tray before the notifier (toasts hang off the tray icon)`.

Platforms: Windows: implemented as the balloon of the most recently created tray that is still alive when `createNotifier` is called; Windows 10 and 11 show it as a toast with the tray's icon, or with the system information icon when the tray has the stock icon; it respects the system's quiet hours; a tray has one click handler, so a later notifier replaces the earlier one's, and disposing the earlier one leaves the later one's handler in place. macOS: implemented with the user notification center; it needs a bundle identifier, so it shows notifications from an .app and nothing from a bare executable; the .app must be signed, which `makeMacApp` does ad-hoc, and not run from a temporary folder, or macOS refuses the permission request outright and no prompt appears; the first notification asks the user for permission; banners show while the app is frontmost too. A refused or denied permission, and a rejected request, are logged to the console in an app on `runEventLoop`; behind a webview's `run()` the log never arrives, because the completion handlers run on Bun's event loop. Linux: throws.

Thread: UI thread. `onClick` runs on the UI thread.

### NotificationOptions

```ts
type NotificationOptions = {
  title: string;
  body?: string;
  silent?: boolean;
  id?: string;
  data?: unknown;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | `string` | required | The heading. Windows keeps the first 63 UTF-16 code units. |
| `body` | `string` | `""` | The text. Windows keeps the first 255 UTF-16 code units. |
| `silent` | `boolean` | `false` | No sound. |
| `id` | `string` | `sweetnative-<n>`, counting up per process | Names the notification; `onClick` reports it. macOS: a new notification with the id of one still showing replaces it. |
| `data` | `unknown` | none | Anything `JSON.stringify` accepts, such as a route or a record id; `onClick` gets it back as parsed JSON. macOS: travels in the request's `userInfo`. Windows: kept in the process for the newest balloon. |

### Notifier

```ts
interface Notifier {
  notify(notification: NotificationOptions): boolean;
  dispose(): void;
}
```

| Member | Meaning |
|---|---|
| `notify(notification)` | Shows a notification. Returns false when nothing is shown: after `dispose`; on Windows once the tray is disposed or when the shell refuses; on macOS without a bundle identifier. macOS returns true without waiting for the permission answer, so a denied permission still returns true. Windows shows one balloon per tray icon, so a new one replaces the one still showing. |
| `dispose()` | Stops showing notifications and stops calling `onClick`. Safe to call twice. |

### NotifierOptions

```ts
type NotifierOptions = {
  onClick?: (click: NotificationClick) => void;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `onClick` | `(click: NotificationClick) => void` | none | The user clicked a notification. An exception it throws is logged and swallowed. Windows: reports the newest balloon shown through this tray, because the shell says only that the balloon was clicked. |

### NotificationClick

```ts
type NotificationClick = { id: string; data: unknown };
```

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | The clicked notification's `id`, given or generated. |
| `data` | `unknown` | Its `data`, parsed from JSON, or `undefined` when it had none. |

macOS delivers a click to the app even when it has quit since: the system launches the bundle and the delegate gets the response once the notifier exists and the loop runs, so create the notifier before `runEventLoop` or `run()`. Windows balloons belong to the running tray icon, so a click reaches only a running app.

## Windows and overlays

Positions and sizes are in window units: physical pixels on Windows when the process is per-monitor DPI aware, which `createOverlayWindow` sets, and points on macOS. The origin is the top-left corner of the primary screen on both. `Overlay.scale()` converts to CSS pixels of the page.

### nativeWindow

```ts
function nativeWindow(handle: WindowHandle): NativeWindow
```

Wraps a window that something else created, typically the webview's, to show it, hide it, set its icon and take over its close button. Creating the wrapper changes nothing about the window.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `handle` | [`WindowHandle`](#windowhandle) | required | The HWND on Windows, the NSWindow pointer on macOS. |

Returns: a [`NativeWindow`](#nativewindow-1).

Throws: when `handle` is `null` or 0.

Platforms: Windows: implemented. macOS: implemented. Linux: throws.

Thread: UI thread.

### NativeWindow

```ts
interface NativeWindow {
  isVisible(): boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  setIcon(icon: Icon | undefined): void;
  onCloseRequest(handler: () => void): () => void;
}
```

| Member | Meaning |
|---|---|
| `isVisible()` | Whether the window is shown. |
| `show()` | Shows the window, brings it to the front and asks for the foreground. Windows: restores it first when it is minimised. macOS: also activates the app. |
| `hide()` | Hides the window. |
| `toggle()` | `hide()` when visible, `show()` otherwise. |
| `setIcon(icon)` | Windows: the title bar, taskbar and Alt+Tab icon, from `icon.windows.ico`; `undefined` restores the stock icon; throws when the bytes are not a readable .ico file. macOS: no-op, because a window has no icon of its own there; [`setAppIcon`](#setappicon) sets the Dock's. |
| `onCloseRequest(handler)` | Calls `handler` instead of closing the window, which would end the app; `handler` is typically `hide`. Returns a function that restores the default close. A second call for the same window replaces the handler, and the restore function from the earlier call then does nothing. Quitting through a menu still works. An exception from `handler` is logged and swallowed. Windows: every close request to the window is intercepted, Alt+F4 included; throws when the window procedure cannot be hooked. macOS: only the close button is intercepted; throws when the window has no close button. |

### WindowHandle

```ts
type WindowHandle = Pointer | bigint | number | null;
```

A native window handle as the webview hands it out: the HWND on Windows, the NSWindow pointer on macOS. `Pointer` is the `bun:ffi` type. Functions that need a window throw on `null` or 0; [`pickFolder`](#pickfolder) accepts `null`.

### createOverlayWindow

```ts
function createOverlayWindow(options: OverlayWindowOptions = {}): Overlay
```

Creates a hidden window, an overlay or with `frame` a normal window, to host the webview: pass `overlay.handle` as the `window` option of [`createWebviewApp`](app.md#createwebviewapp) from the root entry. Use it rather than [`makeOverlay`](#makeoverlay) for a see-through page on Windows, because WebView2 honours transparency only when the host window has it before the browser is created. Call `show()` once the page is set.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `options` | [`OverlayWindowOptions`](#overlaywindowoptions) | `{}` | The window's look and behaviour, including every [`OverlayOptions`](#overlayoptions) field. |

What the call sets up:

| Step | Windows | macOS |
|---|---|---|
| Thread | initialises COM on the calling thread as a single-threaded apartment, which WebView2 needs | creates the shared application object |
| Process | sets per-monitor DPI awareness; a process that already set it keeps its setting | nothing |
| First window | creates one hidden window first, once per process, because the first top-level window a process creates cannot be made topmost | nothing |
| The window | created hidden; a bare popup, or with `frame` an overlapped window with title bar and borders | created hidden; borderless, or with `frame` titled, closable, miniaturizable and resizable; a frameless window with `noActivate: false` gets a class that can become key and take keyboard input |
| Close button | hides the window | hides the window |
| Window destroyed | ends the webview's run loop | not handled here |
| Window resized | resizes the webview's child window to fill the client area | not handled here |
| Default bounds | 320x240, centred on the primary work area | 320x240, centred on the primary work area |

Returns: an [`Overlay`](#overlay) for the new window.

Throws:

- Windows, when the calling thread already initialised COM as multi-threaded: `sweetnative: this thread already initialised COM as multi-threaded; WebView2 needs an STA`.
- Windows, when the window class cannot be registered or the window cannot be created.
- Windows, when `colorKey` is not six hex digits with an optional leading `#`.
- Windows, when the layered-window attributes or the transparent composition cannot be set.
- Windows, when `icon.windows.ico` is not a readable .ico file.
- MacOS, when the window cannot be created.

Platforms: Windows: implemented. macOS: implemented. Linux: throws.

Thread: UI thread, the one that later runs the webview. The window procedure and the overlay's timers run only while the webview's run loop pumps messages on that thread.

### makeOverlay

```ts
function makeOverlay(handle: WindowHandle, options: OverlayOptions = {}): Overlay
```

Restyles an existing window, typically the webview's own, into an overlay in place, and returns the [`Overlay`](#overlay) that controls it.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `handle` | [`WindowHandle`](#windowhandle) | required | The window to restyle. |
| `options` | [`OverlayOptions`](#overlayoptions) | `{}` | The overlay's look and behaviour. |

What it does. Windows: replaces the frame with a bare popup style, keeping visibility; sets the extended styles and layered attributes the options ask for; turns on alpha composition for `transparent`; sets the z-order. macOS: makes the window borderless without a shadow; for `transparent` makes it non-opaque with a clear background; sets its alpha and window level; puts it on every Space, keeps it out of window cycling and lets it show over full-screen apps; for `hideFromTaskbar` switches the app to the accessory activation policy.

What it does not do. It creates no window. It does not initialise COM, set DPI awareness or create the hidden first window, so on Windows `topmost` has no effect when the restyled window is the first top-level window of the process. It installs no window procedure, so the webview's own close, destroy and resize handling stays as it was. It does not make WebView2 transparent: a browser created before the restyle keeps painting its background. On macOS it gives the window no class that can become key, so `noActivate: false` only makes `show()` activate the app.

Returns: an [`Overlay`](#overlay) for the window.

Throws:

- When `handle` is `null` or 0.
- Windows, when `colorKey` is not six hex digits with an optional leading `#`.
- Windows, when the layered-window attributes or the transparent composition cannot be set.

Platforms: Windows: implemented. macOS: implemented. Linux: throws.

Thread: UI thread.

### Overlay

```ts
interface Overlay {
  readonly handle: WindowHandle;
  show(): void;
  hide(): void;
  setIcon(icon: Icon | undefined): void;
  bounds(): Rect;
  moveTo(x: number, y: number): void;
  resize(width: number, height: number): void;
  setBounds(rect: Rect): void;
  setClickThrough(on: boolean): void;
  setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void;
  setTopmost(on: boolean): void;
  startDrag(): void;
  startResize(edge: ResizeEdge): void;
  minimize(): void;
  toggleMaximize(): void;
  maximized(): boolean;
  cursor(): Point;
  screen(): Rect;
  screenAt(point: Point): Rect;
  workArea(): Rect;
  virtualScreen(): Rect;
  scale(): number;
}
```

Control of an overlay window. All members run on the UI thread.

| Member | Meaning |
|---|---|
| `handle` | The HWND or NSWindow pointer as a `bigint`, for the `window` option of `createWebviewApp`. |
| `show()` | Shows the window. With `noActivate` it does not take focus. Windows: first sizes the webview's child window to the client area; without `noActivate` and without `topmost` it also raises the window and asks for the foreground, which a process the user has not clicked yet would not otherwise get. macOS: with `frame` or `noActivate: false` it makes the window key and activates the app; otherwise it orders the window to the front without activating anything. |
| `hide()` | Hides the window. |
| `setIcon(icon)` | Windows: the title bar, taskbar and Alt+Tab icon from `icon.windows.ico`; `undefined` restores the stock one; only a framed window shows it; throws when the bytes are not a readable .ico file. macOS: no-op; [`setAppIcon`](#setappicon) sets the Dock's. |
| `bounds()` | The window's outer position and size, frame included. |
| `moveTo(x, y)` | Moves the top-left corner. Windows: rounds to whole pixels. While the window is topmost, every move asserts the topmost order again, so the taskbar does not win a tie. |
| `resize(width, height)` | Resizes and keeps the top-left corner in place. |
| `setBounds(rect)` | Moves and resizes in one call. |
| `setClickThrough(on)` | Whole window: `true` lets every click fall through to what is underneath; `false` takes every click. Clears any hit regions and stops their polling. |
| `setHitRegions(polygons, refine)` | Makes only the given polygons take clicks; [`setHitRegions`](#sethitregions) below has the details. |
| `setTopmost(on)` | Above every normal window, or not. Windows: the topmost z-order, remembered for later moves. macOS: the status window level, above the Dock, or the normal level. |
| `startDrag()` | Hands the mouse press in progress to the OS as a window move; [`startDrag and startResize`](#startdrag-and-startresize) below has the details. |
| `startResize(edge)` | Resizes from an edge or corner while the button is held; [`startDrag and startResize`](#startdrag-and-startresize) below has the details. |
| `minimize()` | Minimises the window. |
| `toggleMaximize()` | Windows: switches between the primary monitor's work area and the bounds before maximising; the popup's own maximise would cover the taskbar. macOS: zooms. |
| `maximized()` | Windows: true while `toggleMaximize` has the window maximised; the OS's own maximised state is not read. macOS: whether the window is zoomed. |
| `cursor()` | The cursor's position on the screen. macOS: `{ x: 0, y: 0 }` when the position cannot be read. |
| `screen()` | The whole primary monitor. The overlay can draw over the taskbar or Dock there. |
| `screenAt(point)` | The whole monitor that contains `point`, or the nearest one when no monitor does. A window dropped on another monitor finds that monitor's bounds this way. |
| `workArea()` | The primary monitor minus the taskbar or Dock. |
| `virtualScreen()` | The rectangle around every monitor together. |
| `scale()` | Window units per CSS pixel of the page: the window's DPI divided by 96 on Windows, 1 when the DPI is unknown; always 1 on macOS. |

#### setHitRegions

`setHitRegions(polygons, refine?)` makes only the given polygons take clicks. A click anywhere else in the window falls through to whatever is underneath. The polygons are in window-local units, measured from the window's outer top-left corner. `null` makes the whole window take clicks again and stops the polling. The call repaints nothing, so a page can resend its polygons tens of times a second as its drawing moves. The page computes the polygons from what it draws, and this side tests the cursor itself, so the page is never in the click path.

| Aspect | Windows | macOS |
|---|---|---|
| Poll | a timer per window every 10 ms, plus one test on every `setHitRegions` call | one timer for every overlay every 10 ms, plus one test on every call; once started it runs for the life of the process |
| Where the timer runs | inside the webview's message loop on the UI thread | on the main run loop |
| Pass-through state | the transparent extended style, with the layered style unless `colorKey` or `opacity` already made the window layered | the window ignores mouse events |
| Buttons that freeze the state | left, right, middle | any |

The rules on each test:

- Polygons with fewer than three points are dropped, and coordinates are rounded to whole units, as [`packRegions`](#packregions) does.
- While a mouse button is down nothing changes, so a drag that leaves the polygons keeps going.
- With the cursor outside the window, or outside every polygon, the window passes clicks through. Entering the window onto empty space is right from the first pixel. Entering onto a polygon takes one tick.
- With the cursor inside a polygon and no `refine`, the window takes clicks.
- With `refine`, the polygons are the coarse answer, for example a bounding-box hull that includes the gap between a figure's ears. On entering a polygon the window takes clicks at once. `refine` is then called with the cursor's window-local point whenever that point differs from the last one asked, and again after every `setHitRegions` call under a still cursor. The reply sets the state: `solid` true takes clicks, false passes them through. Only the reply to the latest question counts. A reply is dropped when the cursor has since moved to another point or left the polygons, when `setHitRegions` has been called again, or when `setHitRegions(null)` or `setClickThrough` has cleared the regions. Outside every polygon `refine` is not called.
- A refiner that never replies leaves the window in its last state while the cursor stays inside the polygons. The next entry into a polygon takes clicks, so a stalled page degrades to polygon precision.
- [`setClickThrough`](#overlay) clears the regions.

[`createHitRelay`](#createhitrelay) does the UI-thread bookkeeping for a page that answers the questions.

#### startDrag and startResize

`startDrag()` hands the mouse press in progress to the OS as a window move, as a title bar would. Call it from a UI-thread method that the page calls on pointer-down in its own title bar. The window then follows the cursor until the button is released. A page draws its own chrome in a frameless window this way. Windows: the OS's own move loop runs, snapping included, and the call returns when the move ends. macOS: the window drag starts from the application's current event, which must be that mouse-down; with no current event the call does nothing.

`startResize(edge)` resizes the window from `edge` for the page's own resize handles. [window-chrome.md](window-chrome.md) builds a page-drawn title bar and resize handles on these two calls.

| Aspect | Windows | macOS |
|---|---|---|
| Mechanism | this module's own timer moves the edge or corner with the cursor every 10 ms; the OS's size loop needs a thick frame, which brings a visible border | no-op |
| Minimum size | 160x120 window units | not applicable |
| Ends | when the left button is released | not applicable |
| Throws | when the timer cannot be created | never |

### OverlayOptions

```ts
type OverlayOptions = {
  transparent?: boolean;
  colorKey?: string;
  opacity?: number;
  topmost?: boolean;
  hideFromTaskbar?: boolean;
  noActivate?: boolean;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `transparent` | `boolean` | `false` | Honours the page's alpha: wherever the page is transparent, the desktop shows through, anti-aliased edges included. The browser must paint a transparent background too, which is `createWebviewApp`'s `transparent: true`. Clicks on transparent pixels still land on the window; use `setClickThrough` or `setHitRegions` for pass-through. Windows: the desktop compositor blends the client area by its alpha. macOS: a non-opaque window with a clear background. |
| `colorKey` | `string` | none | `#rrggbb`; pixels of exactly this colour are fully transparent and click-through. One bit of transparency; not needed with `transparent`. Windows only: throws when it is not six hex digits. macOS: a warning is logged and the field is ignored. |
| `opacity` | `number` | none | Whole-window opacity, clamped to 0 to 1. Combines with the colour key. |
| `topmost` | `boolean` | `true` | Above every normal window. macOS: the status window level, above the Dock. |
| `hideFromTaskbar` | `boolean` | `true` | Windows: no taskbar button and no Alt+Tab entry. macOS: switches the whole app to the accessory activation policy, so the app has no Dock icon and no Cmd+Tab entry; a menu bar status item still works; [`installAppMenu`](#installappmenu) switches it back. |
| `noActivate` | `boolean` | `true` | Clicking the window never takes focus from the app the user is in. `false` makes a frameless window that takes focus and keyboard input, for a settings window that draws its own chrome. macOS: a frameless window takes keyboard input only when `createOverlayWindow` made it. |

### OverlayWindowOptions

```ts
type OverlayWindowOptions = OverlayOptions & {
  title?: string;
  bounds?: Rect;
  frame?: boolean;
  dark?: boolean;
  icon?: Icon;
};
```

Options of [`createOverlayWindow`](#createoverlaywindow): every [`OverlayOptions`](#overlayoptions) field plus these.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | `string` | `""` | The window's title, shown in the title bar of a framed window. |
| `bounds` | [`Rect`](#rect) | 320x240, centred on the primary work area | Initial bounds, window units. Windows: the outer bounds, frame included. macOS: the content area; with `frame` the title bar is added above it. |
| `frame` | `boolean` | `false` | A normal window instead of an overlay: title bar and close button, a taskbar or Dock presence, activates when clicked, not above other windows, opaque. Still created hidden, so `show()` is the first time it appears, and its close button hides it rather than ending the app. For a settings window next to an overlay, hosted by the same process and run loop. |
| `dark` | `boolean` | `false` | Framed windows: a dark title bar and frame for a dark page. Windows: immersive dark mode, ignored where the OS does not support it. macOS: the dark appearance. |
| `icon` | [`Icon`](#icon) | stock icon | Windows: the title bar, taskbar and Alt+Tab icon, as `Overlay.setIcon`. macOS: ignored. |

With `frame: true` the overlay options behave differently per platform:

| `OverlayOptions` field | Windows with `frame` | macOS with `frame` |
|---|---|---|
| `topmost`, `hideFromTaskbar`, `noActivate` | default to `false`; values given explicitly apply | ignored |
| `transparent`, `colorKey`, `opacity` | apply | ignored |

### HitRefiner

```ts
type HitRefiner = (local: Point, answer: (solid: boolean) => void) => void;
```

Asked while the cursor is inside a hit polygon, with the cursor in window-local units. Whoever knows the exact shape, typically the page with a triangle pick, calls `answer` with whether that point is really solid. `answer` may be called later from another UI-thread callback. Until it is, the window keeps its current state; right after the cursor enters a polygon that state is to take clicks. A call to `answer` is ignored once a later question was asked, the cursor left the polygons, or the regions were replaced or cleared.

Thread: called on the UI thread from the overlay's timer or from `setHitRegions`; `answer` must be called on the UI thread.

### Point

```ts
type Point = { x: number; y: number };
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `x` | `number` | required | Horizontal position, growing to the right. |
| `y` | `number` | required | Vertical position, growing downward. |

### Rect

```ts
type Rect = { x: number; y: number; width: number; height: number };
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `x` | `number` | required | Left edge. |
| `y` | `number` | required | Top edge. |
| `width` | `number` | required | Width. |
| `height` | `number` | required | Height. |

### ResizeEdge

```ts
type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
```

An edge or corner of the window, for `Overlay.startResize`.

## Hit regions

The exports in this section are also available from `@n1h/sweetview/native/hit-regions` alone, which imports no `bun:ffi`, so a page bundle can use them. The usual flow: the page computes polygons, sends them with [`flattenRegions`](#flattenregions) through an IPC method, the UI-thread method turns them back with [`unpackRegions`](#unpackregions) and hands them to a [`HitRelay`](#hitrelay), which calls `Overlay.setHitRegions`.

### convexHull

```ts
function convexHull(points: Point[]): Point[]
```

The convex hull of the points, by the monotone chain algorithm. The hull of a mesh's projected bounding-box corners is the exact silhouette of a box-shaped mesh and a coarse polygon for any other.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `points` | [`Point`](#point)`[]` | required | Any points, in any order. Not modified. |

Returns: the hull, counter-clockwise in a y-up frame, which is clockwise on screen. With three or more input points, collinear and duplicate points are left out. Fewer than three distinct points give fewer than three back.

Thread: any.

### createHitRelay

```ts
function createHitRelay(overlay: Pick<Overlay, "setHitRegions">, probe: (question: HitProbe) => void): HitRelay
```

The UI-thread side of exact click-through. The page sends its coarse polygons; the overlay asks for the exact answer inside one through `probe`, typically an event to the page; the page's reply comes back through `HitRelay.answer`. Each probe replaces the one before, and a reply to anything but the latest probe is dropped. A page that never replies leaves polygon precision.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `overlay` | `Pick<Overlay, "setHitRegions">` | required | Receives `setHitRegions` with the current regions, or `null` while disabled, and the relay's refiner. |
| `probe` | `(question: HitProbe) => void` | required | Sends one question to the page. Called on the UI thread from the overlay's poll, and synchronously from inside `setRegions`, `setEnabled` and `apply` when the cursor is inside a polygon; must return quickly. |

Returns: a [`HitRelay`](#hitrelay), enabled, with no regions. Nothing reaches the overlay until the first call to `setRegions`, `setEnabled` or `apply`.

Thread: UI thread.

### flattenRegions

```ts
function flattenRegions(polygons: HitPolygon[]): number[]
```

Polygons as one flat number array, the shape to send from the page in an IPC method: per polygon a point count, then that many `x, y` pairs. Its JSON is a fraction of the size of an array of point objects.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `polygons` | [`HitPolygon`](#hitpolygon)`[]` | required | The polygons to send. |

Returns: the flat array.

Thread: any.

### hitRegions

```ts
function hitRegions(packed: Int32Array, x: number, y: number): boolean
```

Whether a point is inside any packed polygon. Each polygon's bounds are checked first, then the shape by even-odd ray casting. It allocates nothing, so hundreds of polygons cost microseconds.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `packed` | `Int32Array` | required | Output of [`packRegions`](#packregions). |
| `x` | `number` | required | Window-local x. |
| `y` | `number` | required | Window-local y. |

Returns: true when the point is inside at least one polygon.

Thread: any.

### packRegions

```ts
function packRegions(polygons: HitPolygon[]): Int32Array
```

Packs polygons for [`hitRegions`](#hitregions). Per polygon: `count, minX, minY, maxX, maxY`, then `count` pairs of `x, y`. The minimum bounds are rounded down, the maximum bounds up, and the points to the nearest integer. Polygons with fewer than three points are dropped.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `polygons` | [`HitPolygon`](#hitpolygon)`[]` | required | The polygons, window-local units. |

Returns: the packed array; empty when no polygon has three points.

Thread: any.

### unpackRegions

```ts
function unpackRegions(flat: readonly number[]): HitPolygon[]
```

The inverse of [`flattenRegions`](#flattenregions), for the UI-thread method that receives the polygons. The array is not validated: a truncated array yields points with `undefined` coordinates.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `flat` | `readonly number[]` | required | Output of `flattenRegions`. |

Returns: the polygons.

Thread: any.

### HitPolygon

```ts
type HitPolygon = Point[];
```

One region: a simple polygon in window-local units, any winding. A rectangle is a four-point polygon.

### HitProbe

```ts
type HitProbe = Point & { id: number };
```

A question for the page: is its drawing solid at this window-local point?

| Field | Type | Default | Meaning |
|---|---|---|---|
| `x` | `number` | required | Window-local x of the cursor. |
| `y` | `number` | required | Window-local y of the cursor. |
| `id` | `number` | required | Grows by one with every probe; the reply carries it back. |

### HitRelay

```ts
type HitRelay = {
  setRegions(polygons: HitPolygon[]): void;
  answer(reply: { id: number; solid: boolean }): void;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  apply(): void;
};
```

| Member | Meaning |
|---|---|
| `setRegions(polygons)` | Stores the page's latest polygons, window-local units, and sends them to the overlay at once while enabled. |
| `answer(reply)` | The page's reply to a probe. Applied only when `reply.id` is the latest probe's id. |
| `setEnabled(on)` | `false`: the whole window takes clicks, whatever the regions say, as a click-through toggle. `true`: the regions apply again. Default `true`. |
| `enabled()` | Whether the regions apply. |
| `apply()` | Sends the current state to the overlay again, for example after the webview is created. Before any `setRegions` that state is an empty region list, so the whole window passes clicks through. |

Thread: UI thread for every member.

## Folder picker

### pickFolder

```ts
function pickFolder(owner: WindowHandle, title: string): string | null
```

Opens the OS folder dialog and blocks until the user picks a folder or cancels.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `owner` | [`WindowHandle`](#windowhandle) | required | Windows: the window that owns the dialog; `null` for none. macOS: unused; the panel is modal to the app. |
| `title` | `string` | required | Windows: the dialog's title. macOS: the message shown in the panel. |

Returns: the absolute path of the chosen folder, or `null` when the user cancelled.

Throws:

- Windows, when a COM call fails, including when the calling thread's COM apartment is multi-threaded; the message names the call and its HRESULT.
- MacOS, when the open panel cannot be created.

Platforms: Windows: implemented; only existing file-system folders can be chosen. macOS: implemented; the user can create folders in the panel; the app is activated before the panel opens. Linux: throws.

Thread: UI thread. Windows: the call needs a single-threaded COM apartment and initialises one on a thread that has none. The UI thread, and so the webview, waits until the dialog closes.

## App menu

### installAppMenu

```ts
function installAppMenu(options: AppMenuOptions): void
```

Installs a minimal macOS menu bar, which the webview does not create, so Cmd+Q and the editing shortcuts work. It replaces any main menu the app had.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `options` | [`AppMenuOptions`](#appmenuoptions) | required | The app's name and About text. |

| Menu | Item | Shortcut | Action |
|---|---|---|---|
| `appName` | About `appName`… | none | An alert titled "About `appName`" showing `aboutText` |
| `appName` | Quit `appName` | Cmd+Q | Quits the app |
| Edit | Undo | Cmd+Z | Sent to the focused view |
| Edit | Redo | Cmd+Shift+Z | Sent to the focused view |
| Edit | Cut | Cmd+X | Sent to the focused view |
| Edit | Copy | Cmd+C | Sent to the focused view |
| Edit | Paste | Cmd+V | Sent to the focused view |
| Edit | Select All | Cmd+A | Sent to the focused view |

macOS also switches the app to the regular activation policy, which gives it a Dock icon and a Cmd+Tab entry and undoes `hideFromTaskbar` of an overlay restyled before.

Platforms: macOS: implemented. Windows: no-op; the tray menu is the app's menu. Linux: throws.

Thread: UI thread, before the run loop starts.

### AppMenuOptions

```ts
type AppMenuOptions = { appName: string; aboutText: string };
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `appName` | `string` | required | The app menu's title and the name in its items. |
| `aboutText` | `string` | required | The body text of the About alert. |

## App icon

### setAppIcon

```ts
function setAppIcon(icon: Icon): void
```

Sets the running app's icon. macOS: the Dock tile and the Cmd+Tab switcher, from `icon.macos`, replacing the bundle's icon or the generic icon of a bare executable. The image is full colour unless `template: true`, at the PNG's own size. An icon without a usable `macos` image clears the custom icon.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `icon` | [`Icon`](#icon) | required | The app's icon; only the `macos` section is read. |

Platforms: macOS: implemented. Windows: no-op; Explorer, the taskbar and Alt+Tab take the app's icon from the executable's resources, set at build time with `bun build --compile --windows-icon=app.ico`, and each window's from `NativeWindow.setIcon` or `OverlayWindowOptions.icon`. Linux: throws.

Thread: UI thread.

## Event loop

An app with no webview window, such as a menu-bar app, has nothing to call `run()` on. `createWebviewApp(...).run()` blocks the UI thread inside the OS loop, and Bun's event loop with it, which is why a windowed app keeps its logic in a worker. `runEventLoop` runs the OS loop the other way round: from a Bun timer that drains pending OS events each tick. The UI thread keeps Bun's event loop, so `setTimeout`, promises and I/O work on it, and the tray, notifier and overlay windows need no worker.

### runEventLoop

```ts
function runEventLoop(options: EventLoopOptions = {}): Promise<void>
```

Runs the OS loop from Bun's event loop: calls [`pumpEvents`](#pumpevents) every `intervalMs` until `signal` aborts or the OS ends the loop, then resolves. Create the tray, notifier and windows on the same thread, before or after the call.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `options` | [`EventLoopOptions`](#eventloopoptions) | `{}` | The signal that ends the loop and the tick interval. |

Returns: a promise that resolves when `signal` aborts, at once for a signal already aborted, or when `pumpEvents` returns false. Without a signal the loop runs until the process exits.

Throws: `RangeError` `intervalMs must be a number of at least 1, got <value>` when `intervalMs` is below 1 or not a number. Linux: throws like every other native call, synchronously.

Platforms: Windows: implemented. macOS: implemented. Linux: throws.

Thread: UI thread. Do not combine it with `run()` on a webview app in the same process: one process has one OS loop, and `run()` already runs it.

### pumpEvents

```ts
function pumpEvents(): boolean
```

Dispatches every OS event waiting for this thread and returns at once, for a loop of your own; `runEventLoop` calls it on a timer.

Returns: `false` when the OS asked the loop to end, `true` otherwise.

Platforms: Windows: `PeekMessage`, `TranslateMessage` and `DispatchMessage` until the queue is empty; returns false on `WM_QUIT`, which `PostQuitMessage` queues. macOS: `finishLaunching` on the first call, as `[NSApp run]` would do it, then every event from `nextEventMatchingMask:` is sent with `sendEvent:` and `updateWindows` runs; each call has its own autorelease pool; always returns true, because AppKit has no quit message and `terminate:` ends the process itself. Linux: throws.

Thread: UI thread. Handlers run from inside this call: the tray's click and menu handlers, the notifier's `onClick`, overlay timers.

### EventLoopOptions

```ts
type EventLoopOptions = {
  signal?: AbortSignal;
  intervalMs?: number;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `signal` | `AbortSignal` | none | Ends the loop when aborted. |
| `intervalMs` | `number` | `16` | How often pending events are drained, in milliseconds. The delay before a click reaches its handler is at most this; the menu, once open, tracks at native speed inside the pump. |

## App activation

### setActivationPolicy

```ts
function setActivationPolicy(policy: ActivationPolicy): void
```

macOS: sets how the app appears, through `NSApplication.setActivationPolicy:`. A menu-bar app sets `accessory` before creating its tray, so a bare binary under `bun run` gets no Dock tile; an `.app` bundle gets the same from `LSUIElement` in its `Info.plist`, see the `plist` option of `makeMacApp` in [build.md](build.md). [`installAppMenu`](#installappmenu) sets `regular`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `policy` | [`ActivationPolicy`](#activationpolicy) | required | The policy to set. |

Platforms: Windows: implemented as a no-op; a process with no visible window has no taskbar presence already. macOS: implemented. Linux: throws.

Thread: UI thread.

### ActivationPolicy

```ts
type ActivationPolicy = "regular" | "accessory" | "prohibited";
```

| Value | Meaning |
|---|---|
| `regular` | A Dock tile, an app menu, and the app switcher. |
| `accessory` | No Dock tile and no app menu; windows, menus and status items still show. |
| `prohibited` | Nothing shows; a background process. |

## Menus

A menu is data: a template describes the items, and each platform builds its own native menu from it every time the menu opens.

### resolveMenu

```ts
const resolveMenu: (source: MenuSource | undefined) => MenuTemplate
```

The template a source stands for: the function form is called afresh each time, `undefined` gives an empty template.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `source` | `MenuSource \| undefined` | required | The source to resolve. |

Returns: the template.

Thread: any; the tray calls it on the UI thread when its menu is about to open.

### MenuItem

```ts
type MenuItem =
  | {
      type?: "item";
      label: string;
      enabled?: boolean;
      checked?: boolean;
      icon?: Icon;
      click?: () => void;
    }
  | {
      type?: "submenu";
      label: string;
      enabled?: boolean;
      icon?: Icon;
      submenu: MenuTemplate;
    }
  | { type: "separator" };
```

One entry of a menu: a clickable item, a submenu, or a separator. An entry with `type: "separator"` is a separator; any other entry with a `submenu` field is a submenu; the rest are clickable items.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `type` | `"item" \| "submenu" \| "separator"` | inferred | Required only for a separator. |
| `label` | `string` | required | The item's text. Windows: an ampersand shows as written. |
| `enabled` | `boolean` | `true` | `false` greys the item out and makes it unclickable. |
| `checked` | `boolean` | `false` | Clickable items: shows a check mark. |
| `icon` | [`Icon`](#icon) | none | An image before the label. Windows: the .ico entry at the system small-icon size, 16 px at 100 % scale, scaled in software when there is no exact entry. macOS: a 16-point image, a template image unless `template: false`; shown on macOS 27 too, where menu item images are hidden by default. An image that cannot be decoded is logged and left out. |
| `click` | `() => void` | none | Clickable items: runs on the UI thread when the item is chosen. Windows: after the menu has closed. |
| `submenu` | [`MenuTemplate`](#menutemplate) | required for a submenu | The submenu's items. |

### MenuSource

```ts
type MenuSource = MenuTemplate | (() => MenuTemplate);
```

A template, or a function that produces one. The function form is called every time the menu is about to open, so labels, check marks and enabled state reflect the current app state without bookkeeping.

### MenuTemplate

```ts
type MenuTemplate = MenuItem[];
```

The items of one menu, top to bottom.

## Icons

Icons as bytes, with no image library: one [`Icon`](#icon) shape for every surface, encoders for .ico, .icns and PNG, a PNG decoder, and a coloured disc for an app that has no art yet. Every function here is pure and runs on any thread. Pixel data is top-down RGBA, four bytes per pixel, with straight alpha. Resampling is bilinear and scales up as well as down.

| Function | Sizes it writes, in px |
|---|---|
| `dotIcon` | 16, 24, 32, or `DotIconOptions.sizes` |
| `dotIcns` | 16, 32, 64, 128, 256, 512, 1024, always |
| `icoFromPng`, `icoFromRgba` | 16, 24, 32, 48, 64, or `sizes` |
| `icnsFromPng`, `icnsFromRgba` | 16, 32, 64, 128, 256, or `sizes` |
| `encodeIcns` | the sizes in its map; only 16, 32, 64, 128, 256, 512 and 1024 have an .icns element type |

### decodePng

```ts
function decodePng(bytes: Uint8Array): DecodedPng
```

Decodes a PNG to top-down RGBA. It reads non-interlaced 8-bit greyscale, RGB, palette, greyscale with alpha, and RGBA images, with every row filter. A tRNS chunk gives palette entries their alpha and makes one greyscale or RGB colour transparent. Chunk CRCs are not checked.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `bytes` | `Uint8Array` | required | The PNG file's bytes. |

Returns: a [`DecodedPng`](#decodedpng).

Throws:

- When the bytes do not start with the PNG signature, or a chunk runs past the end of the bytes.
- When there is no IHDR chunk, the image is interlaced, or the bit depth is not 8.
- When the colour type is not one of the five above, or a palette image has no PLTE chunk.
- When the image data does not inflate, or inflates to fewer bytes than the image needs.
- When a row uses an unknown filter type.

### dotIcns

```ts
function dotIcns(opts: DotIconOptions = {}): Uint8Array
```

The coloured disc as an .icns file with every standard size, for a macOS app bundle's `CFBundleIconFile`. `opts.sizes` is ignored.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `opts` | [`DotIconOptions`](#doticonoptions) | `{}` | Colour and ring. |

Returns: the .icns bytes.

### dotIcon

```ts
function dotIcon(opts: DotIconOptions = {}): Uint8Array
```

The coloured disc as a multi-size .ico file, for `Icon.windows.ico`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `opts` | [`DotIconOptions`](#doticonoptions) | `{}` | Colour, ring and sizes. |

Returns: the .ico bytes.

### dotPng

```ts
function dotPng(size: number, opts: DotIconOptions = {}): Uint8Array
```

The coloured disc as a square PNG, for `Icon.macos.png`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `size` | `number` | required | Width and height in px. |
| `opts` | [`DotIconOptions`](#doticonoptions) | `{}` | Colour and ring; `sizes` is ignored. |

Returns: the PNG bytes.

### encodeIcns

```ts
function encodeIcns(images: Map<number, Uint8Array>): Uint8Array
```

Wraps PNGs as an .icns file, smallest first, for a bundle's `CFBundleIconFile`. The PNG bytes and their sizes are not checked.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `images` | `Map<number, Uint8Array>` | required | Pixel size to PNG bytes of that size. |

Returns: the .icns bytes.

Throws: when a size has no .icns element type; the message lists the sizes that do.

### encodeIco

```ts
function encodeIco(images: Map<number, Uint8Array>): Uint8Array
```

Wraps square RGBA images as an .ico file of 32-bit entries, smallest first. A 256 px entry is written with the zero size the format uses for it. The pixel arrays' lengths are not checked.

Throws: when a size is below 1 or above 256.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `images` | `Map<number, Uint8Array>` | required | Size in px to top-down RGBA of that size. Sizes up to 256. |

Returns: the .ico bytes.

### encodePng

```ts
function encodePng(size: number, rgba: Uint8Array): Uint8Array
```

A square RGBA image as an 8-bit RGBA PNG.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `size` | `number` | required | Width and height in px. |
| `rgba` | `Uint8Array` | required | Top-down RGBA, `size * size * 4` bytes. |

Returns: the PNG bytes.

Throws: when `rgba` is not `size * size * 4` bytes long.

### icnsFromPng

```ts
function icnsFromPng(png: Uint8Array, sizes?: number[]): Uint8Array
```

A square PNG as an .icns file, resampled to each size, for `CFBundleIconFile`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `png` | `Uint8Array` | required | A square PNG that [`decodePng`](#decodepng) reads. |
| `sizes` | `number[]` | `[16, 32, 64, 128, 256]` | Sizes to write; each needs an .icns element type. |

Returns: the .icns bytes.

Throws:

- When `decodePng` throws.
- When the PNG is not square.
- When a size has no .icns element type.

### icnsFromRgba

```ts
function icnsFromRgba(size: number, rgba: Uint8Array, sizes: number[] = [16, 32, 64, 128, 256]): Uint8Array
```

Square RGBA as an .icns file, resampled to each size, for `CFBundleIconFile`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `size` | `number` | required | Width and height of `rgba` in px. |
| `rgba` | `Uint8Array` | required | Top-down RGBA, `size * size * 4` bytes. |
| `sizes` | `number[]` | `[16, 32, 64, 128, 256]` | Sizes to write; each needs an .icns element type. |

Returns: the .icns bytes.

Throws: when a size has no .icns element type.

### icoFromPng

```ts
function icoFromPng(png: Uint8Array, sizes?: number[]): Uint8Array
```

A square PNG as a multi-size .ico file of 32-bit entries, resampled to each size, for `Icon.windows.ico`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `png` | `Uint8Array` | required | A square PNG that [`decodePng`](#decodepng) reads. |
| `sizes` | `number[]` | `[16, 24, 32, 48, 64]` | Sizes to write, up to 256. |

Returns: the .ico bytes.

Throws:

- When `decodePng` throws.
- When the PNG is not square.

### icoFromRgba

```ts
function icoFromRgba(size: number, rgba: Uint8Array, sizes: number[] = [16, 24, 32, 48, 64]): Uint8Array
```

Square RGBA as a multi-size .ico file of 32-bit entries, resampled to each size, for `Icon.windows.ico`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `size` | `number` | required | Width and height of `rgba` in px. |
| `rgba` | `Uint8Array` | required | Top-down RGBA, `size * size * 4` bytes. |
| `sizes` | `number[]` | `[16, 24, 32, 48, 64]` | Sizes to write, up to 256. |

Returns: the .ico bytes.

### renderDot

```ts
function renderDot(size: number, opts: DotIconOptions = {}): Uint8Array
```

A filled disc, with an optional outer ring, on a transparent square. The disc's diameter is `size`, so it touches all four edges. The disc's edge is anti-aliased over one pixel. The ring meets the fill with a hard edge.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `size` | `number` | required | Width and height in px. |
| `opts` | [`DotIconOptions`](#doticonoptions) | `{}` | Colour and ring; `sizes` is ignored. |

Returns: top-down RGBA, `size * size * 4` bytes.

### trimTransparent

```ts
function trimTransparent(image: DecodedPng, margin = 1, threshold = 8): DecodedPng
```

Crops an image to its opaque pixels, as a square centred on them with a transparent margin, so art with padding around its subject fills a 16 px menu icon. Where the square runs past the source it is padded with transparency.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `image` | [`DecodedPng`](#decodedpng) | required | The image to crop. |
| `margin` | `number` | `1` | Pixels added beyond the subject on its longer axis; the shorter axis gets more, to make the square. Margin pixels inside the source keep the source's pixels, whose alpha is at most `threshold`. |
| `threshold` | `number` | `8` | A pixel counts as opaque when its alpha is above this. |

Returns: a new square image, or `image` itself, not cropped or squared, when no pixel's alpha is above `threshold`.

### DecodedPng

```ts
type DecodedPng = { width: number; height: number; rgba: Uint8Array };
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `width` | `number` | required | Width in px. |
| `height` | `number` | required | Height in px. |
| `rgba` | `Uint8Array` | required | Top-down RGBA, `width * height * 4` bytes. |

### DotIconOptions

```ts
type DotIconOptions = {
  color?: string;
  ring?: string;
  sizes?: number[];
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `color` | `string` | `"#8b5cf6"`, violet | Fill colour, `#rrggbb` or `#rgb`. |
| `ring` | `string` | none | Colour of an outer ring, `#rrggbb` or `#rgb`. The ring's inner edge is `max(1, size / 10) + 0.5` px inside the disc's edge. |
| `sizes` | `number[]` | `[16, 24, 32]` | Image sizes in px; read by `dotIcon` only. |

### Icon

```ts
type Icon = {
  windows?: {
    ico: Uint8Array;
  };
  macos?: {
    symbol?: string;
    png?: Uint8Array;
    template?: boolean;
  };
};
```

An icon with one section per platform; each platform reads only its own. A missing section means that platform's stock image. The same shape serves the tray, menu items, windows and the app icon.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `windows.ico` | `Uint8Array` | required in `windows` | The bytes of an .ico file. The best-fitting entry is picked for each use: the small-icon size for the tray, menus and a window's small icon, the large-icon size for notifications and a window's big icon. 32-bit and PNG-compressed entries both work. |
| `macos.symbol` | `string` | none | An SF Symbol name. Preferred over `png` when both are given; when no symbol has that name, an error is logged and `png` is used. |
| `macos.png` | `Uint8Array` | none | PNG bytes. Sized by the use: 18x18 points in the menu bar, 16x16 in menus, the PNG's own size in the Dock. Supply 2x pixels for Retina. |
| `macos.template` | `boolean` | `true` in the menu bar and menus, `false` for the Dock | A monochrome image the system recolours for light and dark. A colour image wants `false`. |

## Example

```ts
import { createWebviewApp } from "@n1h/sweetview";
import { createNotifier, createOverlayWindow, createTray, dotIcon, type MenuTemplate } from "@n1h/sweetview/native";

const settings = createOverlayWindow({ frame: true, title: "Settings", bounds: { x: 200, y: 200, width: 480, height: 360 } });
const app = await createWebviewApp({ title: "Settings", window: settings.handle, assets: { "index.html": "<h1>Settings</h1>" } });
let paused = false;
const menu = (): MenuTemplate => [
  { label: "Settings…", click: () => settings.show() },
  { label: "Paused", checked: paused, click: () => { paused = !paused; } },
  { type: "separator" },
  { label: "Quit", click: () => app.quit() },
];
createTray({ tooltip: "My app", icon: { windows: { ico: dotIcon() }, macos: { symbol: "circle.fill" } }, menu, onDoubleClick: () => settings.show() });
createNotifier({ onClick: () => settings.show() }).notify({ title: "My app", body: "Running in the tray" });
app.run();
```

The same tray with no window at all, so the delay below is a plain `setTimeout` on the UI thread:

```ts
import { createNotifier, createTray, dotIcon, runEventLoop, setActivationPolicy, type MenuTemplate } from "@n1h/sweetview/native";

setActivationPolicy("accessory"); // macOS: no Dock tile
const quit = new AbortController();
const notify = () => notifier.notify({ title: "My app", body: "Hello from the menu bar" });
const menu = (): MenuTemplate => [
  { label: "Notify Now", click: notify },
  { label: "Notify in 5 Seconds", click: () => setTimeout(notify, 5000) },
  { type: "separator" },
  { label: "Quit", click: () => quit.abort() },
];
createTray({ tooltip: "My app", icon: { windows: { ico: dotIcon() }, macos: { symbol: "bell.fill" } }, menu });
const notifier = createNotifier();
await runEventLoop({ signal: quit.signal });
```
