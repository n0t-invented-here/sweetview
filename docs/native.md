# @n1h/sweetview/native

Native desktop pieces for a Bun app, called over `bun:ffi`: unified `Window` creation and wrapping, `Screen` monitor and cursor queries, `Menu.popup` native context menus, `Tray`, `Notifier`, `HitRelay` click-through hit regions, `pickFolder`, `setAppMenu`, `setAppIcon`, `setActivationPolicy`, `runEventLoop`, and pure-TypeScript icon encoders.

Every function that touches the OS is implemented for Windows and macOS and runs on the UI thread. `@n1h/sweetview/native` imports **no** webview library (`@n1h/sweetview-webview-bun`). Menu templates, icon encoders, and hit-region math are pure TypeScript and run on any thread. Install and the overview are in [../README.md](../README.md).

```ts
import {
  Window,
  createWindow,
  Screen,
  Menu,
  resolveMenu,
  Tray,
  createTray,
  Notifier,
  createNotifier,
  HitRelay,
  createHitRelay,
  convexHull,
  flattenRegions,
  hitRegions,
  packRegions,
  unpackRegions,
  pickFolder,
  setAppMenu,
  setAppIcon,
  setActivationPolicy,
  pumpEvents,
  runEventLoop,
  quitEventLoop,
  APP_ICO_SIZES,
  decodePng,
  dotIcns,
  dotIco,
  dotPng,
  encodeIcns,
  encodeIco,
  encodePng,
  icnsFromPng,
  icnsFromRgba,
  icoFromPng,
  icoFromRgba,
  renderDot,
  trimTransparent,
  type WindowHandle,
  type WindowOptions,
  type Appearance,
  type HitRefiner,
  type Point,
  type Rect,
  type ResizeEdge,
  type TabHandle,
  type ScreenInfo,
  type MenuItem,
  type MenuSource,
  type MenuTemplate,
  type TrayIcon,
  type TrayOptions,
  type NotificationClick,
  type NotificationOptions,
  type NotifierOptions,
  type HitPolygon,
  type HitProbe,
  type AppMenuOptions,
  type ActivationPolicy,
  type EventLoopOptions,
  type DecodedPng,
  type DotIconOptions,
  type Icon,
} from "@n1h/sweetview/native";
```

Every function that touches the OS picks its Windows or macOS backend on first call. On any other OS that call throws `sweetview: <platform> is not supported (win32 and darwin are)`. Importing the module never throws.

On Windows, all native entry points (`Window`, `Screen`, `Tray`, `Notifier`, `Menu`, message windows) share idempotent startup initialization (`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`, COM STA, and the Win11 hidden first-window anchor), so creation order (such as creating a `Tray` or querying `Screen` before creating a `Window`) never degrades DPI awareness or topmost z-order.

- [Window](#window)
  - [Window and createWindow](#window-and-createwindow)
  - [WindowOptions](#windowoptions)
  - [Window.fromHandle](#windowfromhandle)
  - [setHitRegions](#sethitregions)
  - [startDrag and startResize](#startdrag-and-startresize)
  - [Types (WindowHandle, Appearance, Point, Rect, ResizeEdge, HitRefiner, TabHandle)](#types)
- [Screen](#screen)
- [Menus](#menus)
  - [Menu.popup](#menupopup)
  - [resolveMenu, MenuItem, MenuSource, MenuTemplate](#resolvemenu-menuitem-menusource-menutemplate)
- [Tray](#tray)
- [Notifications](#notifications)
- [Hit regions](#hit-regions)
- [Folder picker](#folder-picker)
- [App menu](#app-menu)
- [App icon](#app-icon)
- [Event loop](#event-loop)
- [App activation](#app-activation)
- [Icons](#icons)
- [Examples](#examples)

## Window

Positions and sizes are in window units: physical pixels on Windows (per-monitor DPI aware) and points on macOS. The origin is the top-left corner of the primary screen on both platforms. `options.bounds`, `win.bounds()`, and `win.setBounds()` all use **outer window frame coordinates** on both Windows and macOS. `win.scale()` converts to CSS pixels of the page.

### Window and createWindow

```ts
export class Window {
  readonly handle: WindowHandle;
  constructor(options?: WindowOptions);
  static fromHandle(handle: WindowHandle): Window;

  // Visibility
  isVisible(): boolean;
  show(): void;
  hide(): void;
  toggle(): void;

  // Geometry (outer frame)
  bounds(): Rect;
  setBounds(rect: Rect): void;
  moveTo(x: number, y: number): void;
  resize(width: number, height: number): void;
  scale(): number;

  // State & chrome
  setTitle(title: string): void;
  setIcon(icon: Icon | undefined): void;
  minimize(): void;
  toggleMaximize(): void;
  isMaximized(): boolean;
  setTopmost(on: boolean): void;
  startDrag(): void;
  startResize(edge: ResizeEdge): void;

  // Click-through & hit regions
  setClickThrough(on: boolean): void;
  setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void;

  // Events (multi-listener; each returns an unsubscribe function)
  onResize(handler: (bounds: Rect) => void): () => void;
  onMove(handler: (bounds: Rect) => void): () => void;
  onClose(handler: () => void): () => void;
  onNewTab(handler: () => void): () => void;
  onTabSelect(handler: (tab: TabHandle) => void): () => void;
  onTabClose(handler: (tab: TabHandle) => void): () => void;

  dispose(): void;
}

export function createWindow(options?: WindowOptions): Window;
```

Windows are always created **hidden**. Call `win.show()` after positioning and wiring events or attaching a `WebView`.

| Member | Meaning |
|---|---|
| `handle` | Native HWND on Windows or `NSWindow*` on macOS (as `bigint` or `Pointer`). |
| `isVisible()` | Whether the window is currently shown. |
| `show()` | Shows the window. Restores minimized windows on Windows; activates the app on macOS unless `noActivate` is set. |
| `hide()` | Hides the window. On Windows, pauses any active hit-region timer until shown again. |
| `toggle()` | `hide()` when visible, `show()` otherwise. |
| `bounds()` | Outer frame rectangle in screen coordinates (top-left primary-monitor origin). |
| `setBounds(rect)` | Moves and resizes the outer frame in one call. |
| `moveTo(x, y)` | Moves the outer top-left corner, preserving size. Re-asserts topmost z-order when topmost. |
| `resize(width, height)` | Resizes outer frame while keeping top-left fixed. |
| `scale()` | Window units per CSS pixel: `dpi / 96` on Windows, `1` on macOS. |
| `setTitle(title)` | Updates the OS title bar text. |
| `setIcon(icon)` | Windows: sets title bar, taskbar, and Alt+Tab icon from `icon.windows.ico`; `undefined` restores stock icon. macOS: no-op (use `setAppIcon`). |
| `minimize()` | Minimizes the window. |
| `toggleMaximize()` | Framed Windows: toggles native `SW_MAXIMIZE` / `SW_RESTORE`. Frameless Windows: toggles between `Screen.of(win).workArea` and saved bounds. macOS: toggles `zoom:`. |
| `isMaximized()` | Framed Windows: `IsZoomed`. Frameless Windows: whether `toggleMaximize` is active. macOS: `isZoomed`. |
| `setTopmost(on)` | Places above normal windows (Win32 `HWND_TOPMOST`, macOS status window level) or restores normal level. |
| `startDrag()` | Hands the current pointer press to the OS move loop. |
| `startResize(edge)` | Starts a drag-resize from `edge` while the left mouse button is held (implemented on both Windows and macOS). |
| `setClickThrough(on)` | Whole-window click-through toggle; clears any hit regions and stops hit polling. |
| `setHitRegions(polygons, refine?)` | Makes only the given polygons accept clicks; `null` restores normal hit testing and stops polling. |
| `onResize(handler)` | Fires on size changes with the new outer `Rect`. Supports multiple listeners. |
| `onMove(handler)` | Fires on position changes with the new outer `Rect`. Supports multiple listeners. |
| `onClose(handler)` | Intercepts user close requests. On Windows (owned and wrapped windows) and on macOS owned windows (`new Window(...)`), catches the close button, Alt+F4 / Cmd+W, programmatic `performClose:`, and frameless windows. On macOS external windows wrapped via `Window.fromHandle(handle)`, intercepts the standard close button when present without replacing the foreign window's `delegate` (direct `performClose:` / `Cmd+W` and borderless foreign windows are not intercepted). When at least one `onClose` listener is registered, the window stays open so the listener decides (`hide()`, `dispose()`, `quit()`, etc.). When no `onClose` listener is registered on an owned window, closing destroys and disposes the window without terminating the process event loop. |
| `onNewTab` / `onTabSelect` / `onTabClose` | Tab lifecycle events emitted on tabbed windows (`tabs: true`). |
| `dispose()` | Destroys an owned window (or detaches hooks on a `Window.fromHandle` wrapper) and releases all timers, subclass hooks, notification observers, icons, and map entries. Idempotent. |

### WindowOptions

```ts
export type WindowOptions = {
  title?: string;
  bounds?: Rect;
  minWidth?: number;
  minHeight?: number;
  frame?: boolean;
  resizable?: boolean;
  appearance?: Appearance;
  icon?: Icon;
  tabs?: boolean;
  transparent?: boolean;
  colorKey?: string;
  opacity?: number;
  topmost?: boolean;
  hideFromTaskbar?: boolean;
  noActivate?: boolean;
  onResize?: (bounds: Rect) => void;
  onMove?: (bounds: Rect) => void;
  onClose?: () => void;
  onNewTab?: () => void;
  onTabSelect?: (tab: TabHandle) => void;
  onTabClose?: (tab: TabHandle) => void;
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | `string` | `""` | Title bar text. |
| `bounds` | `Rect` | `320x240` centered on primary work area | Initial outer frame rectangle on both Windows and macOS. |
| `minWidth`, `minHeight` | `number` | none | Minimum outer frame size enforced during resize. |
| `frame` | `boolean` | `true` | Normal OS window frame (`true`) or borderless/frameless (`false`). |
| `resizable` | `boolean` | `frame` | Whether the window can be resized by the user. |
| `appearance` | `"system" \| "light" \| "dark"` | `"system"` | Framed title bar/window appearance. |
| `icon` | `Icon` | stock icon | Windows window icon. |
| `tabs` | `boolean` | `false` | Enables native tab bar support (`WebView.openTab` / `createApp({ tabs: true })`). |
| `transparent` | `boolean` | `false` | Alpha-composited transparency. Pair with a transparent page. Honored on both framed and frameless windows on Windows and macOS. |
| `colorKey` | `string` | none | Windows-only `#rrggbb` 1-bit transparency color key. |
| `opacity` | `number` | none | Whole-window opacity clamped to `0..1`. Honored regardless of `frame`. |
| `topmost` | `boolean` | `false` | Always-on-top z-order. Honored regardless of `frame`. |
| `hideFromTaskbar` | `boolean` | `false` | Omit from taskbar / Alt+Tab on Windows; sets accessory activation policy on macOS. Honored regardless of `frame`. |
| `noActivate` | `boolean` | `false` | Clicking or showing never steals focus. Honored regardless of `frame`. |
| `onResize`, `onMove`, `onClose`, `onNewTab`, `onTabSelect`, `onTabClose` | callbacks | none | Declarative equivalents of subscribing after construction. |

### Window.fromHandle

```ts
Window.fromHandle(handle: WindowHandle): Window
```

Wraps an existing native window handle (HWND or `NSWindow*`) without altering its style or owning its destruction. `dispose()` detaches any hooks/observers added by the wrapper without destroying the foreign window. Throws if `handle` is `null`, `0`, or `0n`.

### setHitRegions

`setHitRegions(polygons, refine?)` restricts pointer hit-testing to the given window-local polygons. Clicks outside every polygon fall through to whatever is behind the window. Passing `null` restores normal hit-testing and stops the 10 ms polling timer.

- While any mouse button is held, click-through state freezes so drags leaving a polygon continue smoothly.
- When `refine` is supplied, entering a polygon takes clicks immediately and invokes `refine(localPoint, answer)` to refine per-pixel/mesh precision; stale replies are ignored.
- On macOS, the shared 10 ms `NSTimer` is invalidated and released whenever `hits.size === 0` or the window is disposed. On Windows, the per-window timer is killed on `setHitRegions(null)`, `setClickThrough`, `hide()`, and `dispose()`.

### startDrag and startResize

- `startDrag()`: Hands the active mouse press to the OS move loop (`WM_NCLBUTTONDOWN` / `HTCAPTION` on Windows; `performWindowDragWithEvent:` on macOS).
- `startResize(edge)`: Runs a 10 ms cursor-tracking resize loop while the left mouse button is held on both Windows (`SetTimer`) and macOS (`NSTimer` + `NSEvent.pressedMouseButtons`), enforcing `minWidth`/`minHeight` (default floor `160x120`).

### Types

- `WindowHandle = Pointer | bigint | number | null`
- `Appearance = "system" | "light" | "dark"`
- `Point = { x: number; y: number }`
- `Rect = { x: number; y: number; width: number; height: number }`
- `ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right"`
- `HitRefiner = (local: Point, answer: (solid: boolean) => void) => void`
- `TabHandle = { readonly title: string; setTitle(title: string): void; select(): void; close(): void; dispose(): void }`

## Screen

Standalone monitor and cursor queries requiring no window.

```ts
export type ScreenInfo = {
  readonly bounds: Rect;
  readonly workArea: Rect;
  readonly scale: number;
  readonly primary: boolean;
};

export const Screen = {
  primary(): ScreenInfo;
  all(): ScreenInfo[];
  at(point: Point): ScreenInfo;
  of(window: Window | WindowHandle): ScreenInfo;
  bounds(): Rect;
  cursor(): Point;
};
```

| Member | Meaning |
|---|---|
| `Screen.primary()` | Primary monitor bounds, usable `workArea` (minus taskbar/Dock/menu bar), DPI `scale`, and `primary: true`. |
| `Screen.all()` | All connected monitors. |
| `Screen.at(point)` | Monitor containing `point`, or the nearest monitor if outside all monitors. |
| `Screen.of(window)` | Monitor containing the majority of `window` (accepts a `Window` instance or raw `WindowHandle`). |
| `Screen.bounds()` | Combined virtual bounding rectangle spanning every monitor. |
| `Screen.cursor()` | Current cursor position in screen coordinates (top-left primary-monitor origin). |

## Menus

### Menu.popup

```ts
export const Menu = {
  popup(owner: Window | WindowHandle, menu: MenuSource, at?: Point): boolean;
};
```

Opens a native popup/context menu (`TrackPopupMenuEx` on Windows, `NSMenu.popUpMenuPositioningItem:atLocation:inView:` on macOS) anchored to `owner` at screen coordinate `at` (defaulting to the current cursor position). Returns `true` if the user chose an item, `false` if cancelled or empty.

### resolveMenu, MenuItem, MenuSource, MenuTemplate

```ts
export type MenuItem =
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

export type MenuTemplate = MenuItem[];
export type MenuSource = MenuTemplate | (() => MenuTemplate);
export const resolveMenu: (source: MenuSource | undefined) => MenuTemplate;
```

## Tray

```ts
export class Tray {
  constructor(options: TrayOptions);
  setTooltip(text: string): void;
  setIcon(icon: TrayIcon): void;
  setMenu(menu: MenuSource | undefined): void;
  dispose(): void;
}

export function createTray(options: TrayOptions): Tray;
```

Adds an icon to the Windows notification area or a status item to the macOS menu bar. `TrayOptions` accepts `tooltip`, `icon`, `menu`, `onClick`, and `onDoubleClick`. `dispose()` is idempotent. On macOS, a single shared ObjC target routes all tray instances without leaking dynamic classes.

## Notifications

```ts
export class Notifier {
  constructor(options?: NotifierOptions);
  notify(notification: NotificationOptions): boolean;
  dispose(): void;
}

export function createNotifier(options?: NotifierOptions): Notifier;
```

`NotifierOptions = { onClick?: (click: NotificationClick) => void }`  
`NotificationOptions = { title: string; body?: string; silent?: boolean; id?: string; data?: unknown }`  
`NotificationClick = { id: string; data: unknown }`

Platform behavior:

- **Windows**: works standalone **with or without a `Tray`**. Uses per-notification hidden `Shell_NotifyIconW` (`NIS_HIDDEN | NIF_INFO`) channels on a dedicated message window so each notification carries its own UID and clicking an earlier toast delivers that toast's exact `{ id, data }`. Default generated IDs are `sweetview-<n>`.
- **macOS**: uses `UNUserNotificationCenter` and registers its delegate **eagerly in the constructor** (before the first `notify()`), so cold-launch notification clicks are delivered as soon as the event loop pumps. Uses a shared delegate class and shared ObjC blocks so repeated instances do not leak, routes in-process clicks by notification `id` to the notifier that sent them (so multiple `Notifier` instances stay independent), and only clears the center delegate when the last live notifier is disposed. Requires a signed `.app` bundle with a bundle ID outside temporary folders.

## Hit regions

Also importable from `@n1h/sweetview/native/hit-regions` without loading `bun:ffi`.

```ts
export class HitRelay {
  constructor(
    window: { setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void },
    probe: (question: HitProbe) => void,
  );
  setRegions(polygons: HitPolygon[]): void;
  readonly answer: (reply: { id: number; solid: boolean }) => void;
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  apply(): void;
}

export function createHitRelay(
  window: { setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void },
  probe: (question: HitProbe) => void,
): HitRelay;
```

`answer` is an arrow property bound to the `HitRelay` instance, so it can be passed directly into `uiMethods` (`"hit.answer": relay.answer`).

Pure geometry helpers: `convexHull`, `flattenRegions`, `unpackRegions`, `packRegions`, `hitRegions`, `HitPolygon`, `HitProbe`.

## Folder picker

```ts
export function pickFolder(owner: Window | WindowHandle, title: string): string | null
```

Opens the native folder picker dialog (`IFileOpenDialog` on Windows, `NSOpenPanel` on macOS) and blocks until the user selects a folder or cancels (`null`). Accepts a `Window` instance, a raw `WindowHandle`, or `null`.

## App menu

```ts
export function setAppMenu(options: AppMenuOptions): void
export type AppMenuOptions = { appName: string; aboutText: string };
```

Installs the standard macOS menu bar (App menu with About + Quit `Cmd+Q`, Edit menu with Undo/Redo/Cut/Copy/Paste/Select All) and sets the activation policy to `regular`. Uses a shared ObjC target without leaking classes. No-op on Windows.

## App icon

```ts
export function setAppIcon(icon: Icon): void
```

macOS: sets the Dock and Cmd+Tab icon from `icon.macos`. Windows: no-op (use `--windows-icon` at build time and `Window.setIcon` per window).

## Event loop

```ts
export type EventLoopOptions = { intervalMs?: number };
export function runEventLoop(options?: EventLoopOptions): Promise<void>;
export function quitEventLoop(): void;
export function pumpEvents(): boolean;
```

Pumps the OS event loop from a Bun timer (`intervalMs` default `16`) so Bun timers, promises, and I/O remain active on the UI thread. Calling `runEventLoop()` while already running throws `Error("sweetview: runEventLoop is already running")`.

## App activation

```ts
export type ActivationPolicy = "regular" | "accessory" | "prohibited";
export function setActivationPolicy(policy: ActivationPolicy): void;
```

Sets macOS `NSApplication.setActivationPolicy:`. No-op on Windows.

## Icons

Pure-TypeScript icon encoders and PNG decoder (no native FFI; runs on any thread):

- `dotIco(opts?: DotIconOptions): Uint8Array` — multi-size `.ico` (default sizes `[16, 24, 32]`)
- `dotPng(size: number, opts?: DotIconOptions): Uint8Array`
- `dotIcns(opts?: DotIconOptions): Uint8Array`
- `renderDot(size: number, opts?: DotIconOptions): Uint8Array`
- `decodePng(bytes: Uint8Array): DecodedPng`
- `trimTransparent(image: DecodedPng, margin?: number, threshold?: number): DecodedPng`
- `encodePng(size: number, rgba: Uint8Array): Uint8Array`
- `encodeIco(images: Map<number, Uint8Array>): Uint8Array`
- `encodeIcns(images: Map<number, Uint8Array>): Uint8Array`
- `icoFromPng(png: Uint8Array, sizes?: number[]): Uint8Array` (default `APP_ICO_SIZES`)
- `icoFromRgba(size: number, rgba: Uint8Array, sizes?: number[]): Uint8Array` (default `APP_ICO_SIZES`)
- `icnsFromPng(png: Uint8Array, sizes?: number[]): Uint8Array`
- `icnsFromRgba(size: number, rgba: Uint8Array, sizes?: number[]): Uint8Array`

## Examples

### A tray beside a window

```ts
import { WebView } from "@n1h/sweetview";
import { Notifier, Tray, Window, dotIco, type MenuTemplate } from "@n1h/sweetview/native";

const settings = new Window({ title: "Settings", bounds: { x: 200, y: 200, width: 480, height: 360 } });
settings.onClose(() => settings.hide());
const view = await WebView.attach(settings, { assets: { "index.html": "<h1>Settings</h1>" } });

let paused = false;
const menu = (): MenuTemplate => [
  { label: "Settings…", click: () => settings.show() },
  { label: "Paused", checked: paused, click: () => { paused = !paused; } },
  { type: "separator" },
  { label: "Quit", click: () => view.quit() },
];

new Tray({ tooltip: "My app", icon: { windows: { ico: dotIco() }, macos: { symbol: "circle.fill" } }, menu, onDoubleClick: () => settings.show() });
new Notifier({ onClick: () => settings.show() }).notify({ title: "My app", body: "Running in the tray" });
view.run();
```

### A menu-bar app with no window

```ts
import { Notifier, Tray, dotIco, quitEventLoop, runEventLoop, setActivationPolicy, type MenuTemplate } from "@n1h/sweetview/native";

setActivationPolicy("accessory");
const notifier = new Notifier();
const notify = () => notifier.notify({ title: "My app", body: "Hello from the menu bar" });
const menu = (): MenuTemplate => [
  { label: "Notify Now", click: notify },
  { label: "Notify in 5 Seconds", click: () => setTimeout(notify, 5000) },
  { type: "separator" },
  { label: "Quit", click: quitEventLoop },
];
new Tray({ tooltip: "My app", icon: { windows: { ico: dotIco() }, macos: { symbol: "bell.fill" } }, menu });
await runEventLoop();
```
