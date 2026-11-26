# @n1h/sweetview 1.0.0 API and migration

The 1.0.0 API comes from six packages under `packages/`. The desktop
facade uses the patched C++ library from `n0t-invented-here/sweetview-webview`
and the binaries shipped by `n0t-invented-here/sweetview-webview-bun`.
[Workspace entry points](../README.md#documentation) and
[library compatibility](webview-library.md).

---

## Architecture

### Module boundary

The one-way dependency rule stays intact:

* `@n1h/sweetview/native` owns all OS primitives (windows, screens, trays, menus, notifications, hit regions, folder picker, event loop, icons) and **never loads the webview library**.
* `@n1h/sweetview` loads the webview library and layers webviews, tabs, worker IPC, and `createApp` on top of `@n1h/sweetview/native`, `@n1h/sweetview/ipc`, and `@n1h/sweetview/window-chrome`.
* Browser-safe subpaths (`/page`, `/window-chrome`, `/native/hit-regions`, `/ipc`, `/ipc-ws/client`) import types only and pull zero Bun or FFI code.

### Two API layers

* **Layer 1 — Explicit classes**: `Window`, `Tray`, `Menu`, `Notifier`, `HitRelay`, `Screen` (`@n1h/sweetview/native`), `WebView` (`@n1h/sweetview`), and `SettingsStore` (`@n1h/sweetview/settings-store`). Construction and wiring are explicit, listeners are attached imperatively and return unsubscribe functions `() => void`, and every long-lived handle has an idempotent `dispose()`.
* **Layer 2 — Declarative `create*` helpers**: `createWindow`, `createTray`, `createNotifier`, `createHitRelay` (`@n1h/sweetview/native`), `createApp` (`@n1h/sweetview`), and `createSettingsStore` (`@n1h/sweetview/settings-store`). Built directly on Layer 1 with event callbacks inline in options (`onResize`, `onMove`, `onClose`, `onNewTab`, `onTabSelect`, `onTabClose`, `onClick`, `onDoubleClick`).

---

## Examples

### Single-window desktop app (Layer 1 — explicit classes)

Restores saved bounds before first render, dark title bar, saves bounds on resize/move, close button hides to tray, tray menu with checkmark + folder picker + quit, notification click shows window.

```ts
import { WebView } from "@n1h/sweetview";
import { Window, Tray, Notifier, pickFolder, dotIco } from "@n1h/sweetview/native";
import { SettingsStore } from "@n1h/sweetview/settings-store";
import index from "./index.html";

const settings = new SettingsStore({
  app: "my-app",
  defaults: { bounds: { x: 100, y: 100, width: 900, height: 650 } },
});
let pinned = false;

const win = new Window({
  title: "My App",
  appearance: "dark",
  bounds: settings.load().bounds,
});
const webview = await WebView.attach(win, {
  page: index,
  worker: "./worker.ts",
});

win.onResize((bounds) => settings.save({ bounds }));
win.onMove((bounds) => settings.save({ bounds }));
win.onClose(() => win.hide());

const tray = new Tray({
  tooltip: "My App",
  icon: { windows: { ico: dotIco() }, macos: { symbol: "star.fill" } },
  menu: () => [
    { label: win.isVisible() ? "Hide" : "Show", click: () => win.toggle() },
    { label: "Always on Top", checked: pinned, click: () => win.setTopmost((pinned = !pinned)) },
    {
      label: "Pick Folder…",
      click: () => {
        const dir = pickFolder(win, "Choose folder");
        if (dir) webview.notify("folder.set", { dir });
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => webview.quit() },
  ],
});

const notifier = new Notifier({ onClick: () => win.show() });

win.show();
webview.run();
notifier.dispose();
tray.dispose();
win.dispose();
```

### Single-window desktop app (Layer 2 — declarative `create*` helpers)

Same app using `createApp`, `createTray`, `createNotifier`, and `createSettingsStore`:

```ts
import { createApp } from "@n1h/sweetview";
import { createTray, createNotifier, pickFolder, dotIco } from "@n1h/sweetview/native";
import { createSettingsStore } from "@n1h/sweetview/settings-store";
import index from "./index.html";

const settings = createSettingsStore({
  app: "my-app",
  defaults: { bounds: { x: 100, y: 100, width: 900, height: 650 } },
});
let pinned = false;

const app = await createApp({
  title: "My App",
  appearance: "dark",
  bounds: settings.load().bounds,
  page: index,
  worker: "./worker.ts",
  onResize: (bounds) => settings.save({ bounds }),
  onMove: (bounds) => settings.save({ bounds }),
  onClose: () => app.window.hide(),
});

const tray = createTray({
  tooltip: "My App",
  icon: { windows: { ico: dotIco() }, macos: { symbol: "star.fill" } },
  menu: () => [
    { label: app.window.isVisible() ? "Hide" : "Show", click: () => app.window.toggle() },
    { label: "Always on Top", checked: pinned, click: () => app.window.setTopmost((pinned = !pinned)) },
    {
      label: "Pick Folder…",
      click: () => {
        const dir = pickFolder(app.window, "Choose folder");
        if (dir) app.notify("folder.set", { dir });
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ],
});

const notifier = createNotifier({ onClick: () => app.window.show() });

app.window.show();
app.run();
notifier.dispose();
tray.dispose();
app.dispose();
```

### Tabbed app (Layer 1 and Layer 2)

Built-in native tabs (AppKit window tabbing on macOS; captionless frame + tab strip + child `WebView2` panes on Windows), running on `runEventLoop()`.

```ts
// Layer 1
import { WebView } from "@n1h/sweetview";
import { Window, runEventLoop, quitEventLoop } from "@n1h/sweetview/native";
import { SettingsStore } from "@n1h/sweetview/settings-store";
import tabPage from "./tab.html";

const settings = new SettingsStore({
  app: "my-browser",
  defaults: { bounds: { x: 100, y: 100, width: 1040, height: 720 } },
});

const win = new Window({
  title: "Browser",
  appearance: "dark",
  bounds: settings.load().bounds,
  tabs: true,
});

win.onResize((bounds) => settings.save({ bounds }));
win.onMove((bounds) => settings.save({ bounds }));
win.onNewTab(() => void WebView.openTab(win, { page: tabPage }));
win.onTabSelect((tab) => console.log("active tab:", tab.title));
win.onTabClose((tab) => console.log("closed tab:", tab.title));
win.onClose(() => quitEventLoop());

const first = await WebView.openTab(win, { title: "Home", page: tabPage });
const docs  = await WebView.openTab(win, { url: "https://bun.sh" });
first.select();

win.show();
await runEventLoop();
first.dispose();
docs.dispose();
win.dispose();
```

```ts
// Layer 2
import { createApp } from "@n1h/sweetview";
import { createSettingsStore } from "@n1h/sweetview/settings-store";
import tabPage from "./tab.html";

const settings = createSettingsStore({
  app: "my-browser",
  defaults: { bounds: { x: 100, y: 100, width: 1040, height: 720 } },
});

const app = await createApp({
  title: "Browser",
  appearance: "dark",
  bounds: settings.load().bounds,
  tabs: true,
  onResize: (bounds) => settings.save({ bounds }),
  onMove: (bounds) => settings.save({ bounds }),
  onNewTab: () => void app.openTab({ page: tabPage }),
  onTabSelect: (tab) => console.log("active tab:", tab.title),
  onTabClose: (tab) => console.log("closed tab:", tab.title),
  onClose: () => app.quit(),
});

const first = await app.openTab({ title: "Home", page: tabPage });
const docs  = await app.openTab({ url: "https://bun.sh" });
first.select();

app.window.show();
await app.run();
app.dispose();
```

### Frameless transparent window (HUD / desktop pet)

No separate `Overlay` type — just `Window` with frameless / transparent / topmost flags:

```ts
import { WebView } from "@n1h/sweetview";
import { Window, HitRelay, Screen, unpackRegions } from "@n1h/sweetview/native";
import petPage from "./pet.html";

const primary = Screen.primary();
const win = new Window({
  title: "Pet",
  frame: false,
  transparent: true,
  topmost: true,
  hideFromTaskbar: true,
  noActivate: true,
  bounds: { x: primary.bounds.x + 400, y: primary.bounds.height - 256, width: 256, height: 256 },
});

const hits = new HitRelay(win, (probe) => webview.emit("hit.probe", probe));
const webview = await WebView.attach(win, {
  page: petPage,
  uiMethods: {
    "hit.regions": (flat) => hits.setRegions(unpackRegions(flat)),
    "hit.answer": hits.answer,
  },
});

win.show();
hits.apply();
webview.run();
win.dispose();
```

### Native window without a webview

Uses `@n1h/sweetview/native` alone — the webview library is never loaded:

```ts
import { createWindow, Menu, runEventLoop, quitEventLoop } from "@n1h/sweetview/native";

const win = createWindow({
  title: "Plain Native",
  bounds: { x: 100, y: 100, width: 600, height: 400 },
  onResize: (rect) => console.log("resized", rect),
  onClose: () => quitEventLoop(),
});

win.show();
await runEventLoop();
win.dispose();
```

---

## Module Reference

### `@n1h/sweetview/native`

#### `Window` and `createWindow`

Unifies the previous `NativeWindow` and `Overlay` into a single window abstraction. Windows are always created **hidden**; call `win.show()` once positioned and wired.

* **Coordinates**: top-left origin of the primary monitor on both platforms; physical pixels on Windows (per-monitor DPI aware), points on macOS.
* **Bounds consistency**: `bounds` passed to `new Window({ bounds })` / `createWindow({ bounds })`, returned by `win.bounds()`, and passed to `win.setBounds(rect)` are all **outer window frame** coordinates on both Windows and macOS (fixing the previous macOS `initWithContentRect:` vs `frame` mismatch).

```ts
export type Appearance = "system" | "light" | "dark";
export type WindowHandle = Pointer | bigint | number | null;
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type WindowOptions = {
  identity?: AppIdentity;
  onFileDrop?: (paths: string[]) => void;
  title?: string;
  /** Outer frame bounds. Default: 320x240 centered on the primary work area. */
  bounds?: Rect;
  /** Minimum outer size (optional). */
  minWidth?: number;
  minHeight?: number;
  /** Normal OS frame with title bar and borders. Default: true. */
  frame?: boolean;
  /** Allow user resizing. Default: true when frame is true, false when frameless. */
  resizable?: boolean;
  /** Framed title bar theme. Default: "system". */
  appearance?: Appearance;
  /** Windows title bar / taskbar / Alt+Tab icon. */
  icon?: Icon;
  /** Enable native tab bar support on this window. Default: false. */
  tabs?: boolean;
  /** Alpha-composited transparent window. Default: false. */
  transparent?: boolean;
  /** Windows-only 1-bit color key ("#rrggbb"). */
  colorKey?: string;
  /** Whole-window opacity, 0..1. */
  opacity?: number;
  /** Keep above normal windows. Default: false. */
  topmost?: boolean;
  /** Omit from taskbar / Dock / Alt+Tab. Default: false. */
  hideFromTaskbar?: boolean;
  /** Never steal focus on click or show. Default: false. */
  noActivate?: boolean;
  /** Declarative callbacks (used by createWindow; also accepted by new Window). */
  onResize?: (bounds: Rect) => void;
  onMove?: (bounds: Rect) => void;
  onClose?: () => void;
  onNewTab?: () => void;
  onTabSelect?: (tab: Tab) => void;
  onTabClose?: (tab: Tab) => void;
};

export class Window {
  readonly handle: WindowHandle;

  constructor(options?: WindowOptions);
  /** Non-mutating wrapper around an existing HWND or NSWindow*. */
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

  // Event subscriptions (multi-listener where passive; each returns an unsubscribe thunk)
  onResize(handler: (bounds: Rect) => void): () => void;
  onMove(handler: (bounds: Rect) => void): () => void;
  onClose(handler: () => void): () => void;
  onFileDrop(handler: (paths: string[]) => void): () => void;
  onNewTab(handler: () => void): () => void;
  onTabSelect(handler: (tab: Tab) => void): () => void;
  onTabClose(handler: (tab: Tab) => void): () => void;

  /** Releases timers, subclasses, notification observers, and per-window entries. Safe to call twice. */
  dispose(): void;
}

export function createWindow(options?: WindowOptions): Window;
```

Notes on `onResize` / `onMove` / `onClose`:

* All handlers run synchronously on the UI thread; thrown exceptions are caught, logged (`sweetview: ...`), and swallowed so nothing unwinds across `bun:ffi`.
* **Windows**: `WM_SIZE` / `WM_MOVE` / `WM_CLOSE` via our `WndProc` (for `new Window`) or `SetWindowSubclass` (for `Window.fromHandle`).
* **macOS**: `NSWindowDidResizeNotification` / `NSWindowDidMoveNotification` via `NSNotificationCenter` (leaving `NSWindowDelegate` untouched on externally owned `Window.fromHandle` windows), and `performClose:` interception on our `NSWindow` subclass so owned `new Window(...)` instances catch the close button, `Cmd+W`, programmatic closes, and frameless windows. On external windows wrapped via `Window.fromHandle(handle)` (not created by Sweetview), `onClose` retargets `standardWindowButton:(NSWindowCloseButton)` when present without touching the foreign `delegate`, so direct `performClose:` / `Cmd+W` and borderless external windows are not intercepted.

#### `Screen`

Standalone monitor and cursor queries — no window required.

On first call, `Screen` lazily performs the same one-time initialization as `Window`: `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` on Windows and `NSApplication.sharedApplication` on macOS, so coordinates returned before `new Window()` always match coordinates after.

```ts
export type ScreenInfo = {
  readonly bounds: Rect;    // full monitor rect
  readonly workArea: Rect;  // usable area minus taskbar / Dock / menu bar
  readonly scale: number;   // DPI scale factor (1, 1.5, 2, ...)
  readonly primary: boolean;
};

export const Screen: {
  primary(): ScreenInfo;
  all(): ScreenInfo[];
  at(point: Point): ScreenInfo;
  of(window: Window | WindowHandle): ScreenInfo;
  /** Combined bounding rect of all connected monitors. */
  bounds(): Rect;
  /** Current cursor position on screen. */
  cursor(): Point;
};
```

#### `Menu`

Native popup menus backed by Win32 `HMENU` (`CreatePopupMenu` + `TrackPopupMenu`) and AppKit `NSMenu`. Supports icons, checkmarks, submenus, separators, and dynamic menu functions.

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

export const Menu: {
  /** Opens a native popup menu at `at` (default: cursor position). Returns true if an item was chosen. */
  popup(owner: Window | WindowHandle, menu: MenuSource, at?: Point): boolean;
};

export function resolveMenu(source: MenuSource | undefined): MenuTemplate;
```

#### `Tray` and `createTray`

```ts
export type TrayIcon = Icon;
export type TrayOptions = {
  tooltip?: string;
  icon?: TrayIcon;
  menu?: MenuSource;
  onClick?: () => void;
  onDoubleClick?: () => void;
};

export class Tray {
  constructor(options: TrayOptions);
  setTooltip(text: string): void;
  setIcon(icon: TrayIcon): void;
  setMenu(menu: MenuSource | undefined): void;
  dispose(): void;
}

export function createTray(options: TrayOptions): Tray;
```

#### `Notifier` and `createNotifier`

```ts
export type NotificationOptions = {
  title: string;
  body?: string;
  silent?: boolean;
  id?: string;
  data?: unknown;
};
export type NotificationClick = { id: string; data: unknown };
export type NotifierOptions = { onClick?: (click: NotificationClick) => void };

export class Notifier {
  constructor(options?: NotifierOptions);
  notify(notification: NotificationOptions): boolean;
  dispose(): void;
}

export function createNotifier(options?: NotifierOptions): Notifier;
```

#### `HitRelay` and `createHitRelay`

```ts
export class HitRelay {
  constructor(window: Pick<Window, "setHitRegions">, probe: (question: HitProbe) => void);
  setRegions(polygons: HitPolygon[]): void;
  answer(reply: { id: number; solid: boolean }): void;
  setEnabled(on: boolean): void;
  isEnabled(): boolean;
  apply(): void;
}

export function createHitRelay(window: Pick<Window, "setHitRegions">, probe: (question: HitProbe) => void): HitRelay;
```

Pure-TS helpers also available from `@n1h/sweetview/native/hit-regions`: `convexHull`, `flattenRegions`, `unpackRegions`, `packRegions`, `hitRegions`.

#### Dialogs, App Chrome, Event Loop, and Icons

```ts
// Folder picker — accepts Window directly (no need for raw WindowHandle)
export function pickFolder(owner: Window | WindowHandle | null, title: string): string | null;

// App menu & icon & activation policy
export type AppMenuOptions = { appName: string; aboutText: string };
export function setAppMenu(options: AppMenuOptions): void;
export function setAppIcon(icon: Icon): void;
export type ActivationPolicy = "regular" | "accessory" | "prohibited";
export function setActivationPolicy(policy: ActivationPolicy): void;

// OS event loop
export type EventLoopOptions = { intervalMs?: number };
export function runEventLoop(options?: EventLoopOptions): Promise<void>;
export function quitEventLoop(): void;
export function pumpEvents(): boolean;

// Icons (pure TS)
export function dotIco(opts?: DotIconOptions): Uint8Array;
export function dotPng(size: number, opts?: DotIconOptions): Uint8Array;
export function dotIcns(opts?: DotIconOptions): Uint8Array;
export function renderDot(size: number, opts?: DotIconOptions): Uint8Array;
export function decodePng(bytes: Uint8Array): DecodedPng;
export function encodePng(size: number, rgba: Uint8Array): Uint8Array;
export function encodeIco(images: Map<number, Uint8Array>): Uint8Array;
export function encodeIcns(images: Map<number, Uint8Array>): Uint8Array;
export function icoFromPng(png: Uint8Array, sizes?: number[]): Uint8Array;
export function icoFromRgba(size: number, rgba: Uint8Array, sizes?: number[]): Uint8Array;
export function icnsFromPng(png: Uint8Array, sizes?: number[]): Uint8Array;
export function icnsFromRgba(size: number, rgba: Uint8Array, sizes?: number[]): Uint8Array;
export function trimTransparent(image: DecodedPng, margin?: number, threshold?: number): DecodedPng;
export const APP_ICO_SIZES: number[];
```

---

### `@n1h/sweetview`

#### `WebView` and `Tab`

Mounts a webview + optional worker IPC ring onto a Layer 1 `Window` (either filling the whole window via `WebView.attach`, or opening a tab inside a tabbed window via `WebView.openTab`).

`WebView.attach(win, options)` automatically reads `win.handle`, `win.bounds()`, `win.scale()`, title, `resizable`, and `transparent` from `win` — eliminating duplicate size/title/DIP options.

```ts
export type WebViewOptions<M extends MethodMap> = {
  page?: HTMLBundle;
  url?: string;
  title?: string;
  assets?: Record<string, Asset>;
  index?: string;
  worker?: URL | string;
  onRequest?: "worker" | ((request: NativeRequest) => NativeResponse);
  allowExternalDrop?: boolean;
  debug?: boolean;
  uiMethods?: UiMethods<M>;
  deferredUiMethods?: UiMethods<M>;
  showOnReady?: boolean;
  readyTimeoutMs?: number;
  onReady?: () => void;
  onReadyTimeout?: () => void;
  readyFallbackHtml?: string;
  ringBytes?: number;
};

export class WebView<M extends MethodMap = MethodMap, E extends EventMap = EventMap> {
  readonly raw: RawWebview;
  readonly window: Window;

  /** Mounts a webview inside an existing Layer 1 Window. */
  static attach<M extends MethodMap, E extends EventMap>(
    window: Window,
    options: WebViewOptions<M>,
  ): Promise<WebView<M, E>>;

  /** Opens a new tab hosting a webview inside a tabbed Window (`tabs: true`). */
  static openTab<M extends MethodMap, E extends EventMap>(
    window: Window,
    options: TabOptions<M>,
  ): Promise<Tab<M, E>>;

  emit<N extends keyof E & string>(name: N, payload: E[N]): void;
  /** Fire-and-forget call to the worker (renamed from `call`). */
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  onEvent(fn: (event: AnyEvent<E>) => void): () => void;
  run(): void;
  quit(): void;
  dispose(): void;
}

export type TabOptions<M extends MethodMap> = WebViewOptions<M> & {
  /** Insert after this tab instead of the currently selected tab. */
  after?: TabHandle;
};

export interface Tab<M extends MethodMap = MethodMap, E extends EventMap = EventMap> extends TabHandle {
  readonly webview: WebView<M, E>;
  readonly window: Window;
  readonly title: string;
  setTitle(title: string): void;
  select(): void;
  close(): void;
  moveToNewWindow(): Promise<Window>;
  dispose(): void;
}
```

#### `createApp`

Layer 2 declarative helper: creates a `Window` and attaches a `WebView` (or sets up a tabbed window when `tabs: true`) in one call.

```ts
export type AppOptions<M extends MethodMap> = WindowOptions & WebViewOptions<M>;

export interface App<M extends MethodMap = MethodMap, E extends EventMap = EventMap> {
  readonly window: Window;
  readonly webview?: WebView<M, E>; // present when tabs is false
  openTab<TM extends MethodMap = M, TE extends EventMap = E>(options: TabOptions<TM>): Promise<Tab<TM, TE>>;
  mergeAllWindows(): void;
  emit<N extends keyof E & string>(name: N, payload: E[N]): void;
  notify<K extends keyof M & string>(method: K, ...params: M[K][0] extends void ? [] : [M[K][0]]): void;
  onEvent(fn: (event: AnyEvent<E>) => void): () => void;
  run(): void | Promise<void>;
  quit(): void;
  dispose(): void;
}

export function createApp<M extends MethodMap, E extends EventMap>(
  options: AppOptions<M>,
): Promise<App<M, E>>;
```

#### Other root exports

* `windowChromeMethods(window: Window, options?: { chrome?: WindowChromeKind; onClose?: () => void })`
* `indexHtml`, `indexHtmlText`, `assetMime`
* `Ring`
* `pumpEvents`, `quitEventLoop`, `runEventLoop`, `setActivationPolicy`
* `ASSET_ORIGIN`, `FRAMES_ORIGIN`, `NativeRequest` and `NativeResponse` support [zero-TCP dynamic routes](app.md#dynamic-requests).
* `defineAppIdentity`, `AppIdentity` and `AppIdentityInput` share settings and
  packaging defaults. The root also re-exports the [activation APIs](native/activation-and-single-instance.md).
* `RawWebview` (re-export of `Webview` from `@n1h/sweetview-webview-bun`), `SizeHint`, `WEBVIEW_VERSION`

---

### Other Subpaths

#### `@n1h/sweetview/settings-store`

Adds `SettingsStore` class alongside `createSettingsStore` and `appDataDir`:

```ts
export class SettingsStore<T extends object> {
  readonly path: string;
  constructor(options: SettingsStoreOptions<T>);
  load(): T;
  save(settings: T): void;
}
export function createSettingsStore<T extends object>(options: SettingsStoreOptions<T>): SettingsStore<T>;
export function appDataDir(app: string): string;
```

`SettingsStore({ identity, defaults })` uses the identity's slug as the
default app-data directory name. [Settings and identity](settings-store.md).

#### `@n1h/sweetview/ipc`, `/ipc-ws`, `/page`, `/worker`, `/window-chrome`, `/build`

* `wsHost(service, options).dispose()` (renamed from `.close()`)
* `wsTransport(url).dispose()` (renamed from `.close()`)
* `memoryTransport(service, session).dispose()` (renamed from `.close()`)
* `windowChromeMethods(window, { chrome, onClose })` (`onClose` renamed from `close`)
* `signalReady()` in `/page` acknowledges [desktop startup](app.md#startup-and-deferred-ui).
* `hostService(service, { onRequest })` and `hostRequestHandler(onRequest)`
  in `/worker` serve [dynamic routes](worker.md#hostrequesthandler).
* `makeMacApp({ identity, urlSchemes, binary, outDir })` uses identity defaults
  and declares macOS URL schemes. [Build reference](build.md).
* The native package adds `Window.visibleWindows()`, `closeToTrayOnLastWindow`,
  native file drops, `Clipboard` and three tiers of file access.
  [Native reference](native.md).

---

## Breaking Changes (`0.2.x` → `1.0.0`)

| Area | `0.2.x` | `1.0.0` |
|---|---|---|
| Native windows | `NativeWindow` + `Overlay` + `createOverlayWindow` + `makeOverlay` + `nativeWindow` | `Window` + `createWindow` + `Window.fromHandle` (`@n1h/sweetview/native`) |
| Webview host | `createWebviewApp({ window: win.handle, width, height, resizable })` | `WebView.attach(win, options)` (Layer 1) and `createApp(options)` (Layer 2) |
| App window handle | `app.window` (`NativeWindow`) + `app.windowHandle` | `app.window` (`Window`, with `app.window.handle`); `app.windowHandle` removed |
| Screen queries | `win.screen()`, `win.workArea()`, `win.screenAt()`, `win.virtualScreen()`, `win.cursor()` | `Screen.primary()`, `Screen.all()`, `Screen.at()`, `Screen.of(win)`, `Screen.bounds()`, `Screen.cursor()` |
| Context menus | Internal only (`createTray` only) | `Menu.popup(owner, menu, at?)` exported from `@n1h/sweetview/native` |
| Tabs | Demo-only in `demos/native-tabs/` | Built into `Window({ tabs: true })`, `WebView.openTab`, and `createApp({ tabs: true })` |
| Window events | `onCloseRequest` on `NativeWindow` only; no resize/move hooks | `onResize`, `onMove`, `onClose`, `onNewTab`, `onTabSelect`, `onTabClose` on `Window` and `createApp` / `createWindow` options |
| Window teardown | None on `Overlay` / `NativeWindow` | `win.dispose()` |
| macOS `bounds` | `initWithContentRect:` on creation vs `frame` on `bounds()` / `setBounds()` | Outer window frame consistently everywhere |
| Fire-and-forget worker call | `app.call(method, params)` | `webview.notify(method, params)` / `app.notify(method, params)` |
| App menu | `installAppMenu(options)` | `setAppMenu(options)` |
| Dot `.ico` encoder | `dotIcon(opts)` | `dotIco(opts)` |
| Boolean getters | `win.maximized()`, `hits.enabled()` | `win.isMaximized()`, `hits.isEnabled()` |
| Chrome close option | `windowChromeMethods(win, { close })` | `windowChromeMethods(win, { onClose })` |
| Transport teardown | `host.close()`, `wsTransport().close()`, `memoryTransport().close()` | `.dispose()` everywhere |
| Folder picker owner | `pickFolder(handle, title)` | `pickFolder(windowOrHandle, title)` |
| Deprecated window flag | `dark?: boolean` | Removed (use `appearance: "dark"`) |
| Error / internal prefix | `sweetnative:` | `sweetview:` |
| Raw webview export | `Webview` from `@n1h/sweetview` | `RawWebview` (frees `WebView` for the Layer 1 class) |

---

## Implementation Notes

* **Windows DPI awareness**: `Screen.*` and `new Window()` share a single idempotent `ensureDpiAware()` helper calling `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` before any monitor or window metrics are read.
* **macOS `NSApp` init**: `Screen.*` and `new Window()` both call `sharedApp()` before touching `NSScreen` or `NSWindow`.
* **macOS outer-frame `bounds`**: Convert requested outer frame to content rect via `[NSWindow contentRectForFrameRect:styleMask:]` during `initWithContentRect:styleMask:backing:defer:`, or apply `setFrame:display:` immediately while still hidden before returning.
* **macOS resize/move observers**: Subscribe to `NSWindowDidResizeNotification` and `NSWindowDidMoveNotification` via `NSNotificationCenter.defaultCenter` scoped to the `NSWindow` object, removing observers on `win.dispose()`. Never replace `NSWindow.delegate`.
* Native window and tab primitives live under `packages/sweetview-native/`.
  Webview-specific coordination lives in `packages/sweetview/src/tabs/`.
  On macOS, a tabbed `Window({ tabs: true })` coordinates the per-tab
  `NSWindow`s independently of the lifetime of the first tab.
