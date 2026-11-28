// Unified native Window abstraction replacing NativeWindow and Overlay.
// Always created hidden; call win.show() once positioned and wired.
//
// Coordinates: top-left origin of the primary monitor on both platforms;
// physical pixels on Windows (per-monitor DPI aware), points on macOS.
// `bounds` in options, `bounds()`, and `setBounds()` are all outer window
// frame coordinates on both Windows and macOS.

import type { HitPolygon } from "./hit-regions";
import type { AppIdentity, AppIdentityIcon } from "@n1h/sweetview-settings";
import { icoFromRgba, type Icon } from "./icon";
import { addReachable, noteReachable, releaseAtEnd } from "./lifetime";
import { backend, macosKeepsTagPath } from "./platform";
import type { Point, Rect, WindowHandle } from "./types";

export type { Point, Rect, WindowHandle } from "./types";

/** `#rrggbb` (the `#` optional, either case) as `#rrggbb`; throws for anything else. */
function backgroundColorOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const hex = text.startsWith("#") ? text.slice(1) : text;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`sweetview: background color must be #rrggbb, got ${text}`);
  return `#${hex.toLowerCase()}`;
}

/** A framed window's title bar and frame: light, dark, or following the system. */
export type Appearance = "system" | "light" | "dark";

/** An edge or corner of the window, for startResize. */
export type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * Asked while the cursor is inside a hit polygon, with the cursor in
 * window-local units; whoever knows the exact shape (the page, with a
 * triangle pick) calls `answer` with whether that point is really solid.
 */
export type HitRefiner = (local: Point, answer: (solid: boolean) => void) => void;

/** Minimal tab interface visible from `@n1h/sweetview/native` without importing webview types. */
export interface TabHandle {
  readonly title: string;
  setTitle(title: string): void;
  select(): void;
  close(): void;
  dispose(): void;
}

export type WindowOptions = {
  /** Supplies the default title and window icon. */
  identity?: AppIdentity;
  title?: string;
  /**
   * Outer frame bounds, in window units (physical pixels on Windows, points on
   * macOS). Default: 320x240 centered on the primary work area. Not with
   * `contentSize`.
   */
  bounds?: Rect;
  /**
   * The page area's size in device-independent pixels (CSS pixels of the page),
   * the window centered on the primary screen's work area: the frame is sized
   * around it at that screen's scale, so the page is the same size to the eye
   * on a screen of any scale. A tabbed window's page area is below its strip.
   * Not with `bounds`.
   */
  contentSize?: { width: number; height: number };
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
  /**
   * Make this window a native, OS-framed tabbed container (Windows: a framed
   * window with a tab strip; macOS: an AppKit window tab group, one NSWindow
   * per tab). Tabs are opened with `WebView.openTab`. Default: false.
   *
   * `frame`, `transparent`, `colorKey`, `setClickThrough` and
   * `setHitRegions` do not apply to tabbed windows: click-through and hit
   * regions are for non-tabbed overlay windows only.
   */
  tabs?: boolean;
  /** Alpha-composited transparent window. Default: false. */
  transparent?: boolean;
  /**
   * 1-bit color key (`"#rrggbb"`): pixels of exactly this color are fully
   * transparent and click-through.
   * - Windows: `WS_EX_LAYERED` + `SetLayeredWindowAttributes(LWA_COLORKEY)`.
   * - macOS: unsupported; logs a warning and is ignored. Use
   *   `transparent: true` with a transparent page background instead.
   */
  colorKey?: string;
  /**
   * What the window shows where nothing has painted (`"#rrggbb"`): before its
   * page paints, behind a loading page and after its webview has gone; the
   * attached webview's own background before its page paints is the same
   * color. Default: what the system or `appearance` gives. Not applied to a
   * `transparent` window, which shows what is behind it.
   * - Windows: the window's background and WebView2's default background.
   * - macOS: accepted and ignored until the macOS goal of the Rust rewrite.
   */
  backgroundColor?: string;
  /** Whole-window opacity, 0..1. */
  opacity?: number;
  /** Keep above normal windows. Default: false. */
  topmost?: boolean;
  /**
   * Omit from the taskbar / app switcher. Default: false.
   * - Windows: per window, via `WS_EX_TOOLWINDOW` (and clearing
   *   `WS_EX_APPWINDOW`); hidden from the taskbar and Alt+Tab.
   * - macOS: adds `NSWindowCollectionBehaviorIgnoresCycle` to the window and
   *   switches the whole app to the `accessory` activation policy (no Dock
   *   icon, no Cmd+Tab entry, no menu bar ownership). The policy is
   *   app-wide: it affects every window of the process.
   */
  hideFromTaskbar?: boolean;
  /**
   * Never activate the app or take keyboard focus when shown or clicked.
   * Default: false.
   * - Windows: `WS_EX_NOACTIVATE`, shown with `SW_SHOWNOACTIVATE` and never
   *   brought to the foreground.
   * - macOS: shown with `orderFrontRegardless` instead of
   *   `makeKeyAndOrderFront:` + `activateIgnoringOtherApps:`; a borderless
   *   (`frame: false`) window additionally never becomes key.
   */
  noActivate?: boolean;
  /** Declarative callbacks (used by createWindow; also accepted by new Window). */
  onResize?: (bounds: Rect) => void;
  /** Called with `true` when the window becomes maximized and `false` when it is restored, by any means. */
  onMaximizeChange?: (maximized: boolean) => void;
  onMove?: (bounds: Rect) => void;
  onClose?: () => void;
  onFileDrop?: (paths: string[]) => void;
  /** A new tab was asked for (the strip's +, Ctrl+T / Cmd+T, the tab menu); `origin` is the window it was asked for in, a torn-off one included. */
  onNewTab?: (origin: Window) => void;
  onTabSelect?: (tab: TabHandle) => void;
  onTabClose?: (tab: TabHandle) => void;
};

export interface WindowMeta {
  title: string;
  /** Current topmost state (initial `WindowOptions.topmost`, updated by `Window.setTopmost`). */
  topmost?: boolean;
  readonly opacity?: number;
  /** `WindowOptions.backgroundColor` as `#rrggbb`; absent when not given or the window is transparent. */
  readonly backgroundColor?: string;
  readonly hideFromTaskbar?: boolean;
  readonly noActivate?: boolean;
  readonly frame: boolean;
  readonly resizable: boolean;
  readonly transparent: boolean;
  readonly tabs: boolean;
  readonly appearance: Appearance;
  readonly icon?: Icon;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly owned: boolean;
}

export interface WindowBackend {
  readonly handle: WindowHandle;
  /**
   * Set by `fromHandle`: chrome detected from the native window's styles
   * (Windows `GWL_STYLE` `WS_POPUP` / `WS_THICKFRAME`; macOS `styleMask`
   * `NSWindowStyleMaskTitled` / `NSWindowStyleMaskResizable`).
   */
  readonly detectedMeta?: { frame: boolean; resizable: boolean };
  isVisible(): boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  bounds(): Rect;
  setBounds(rect: Rect): void;
  moveTo(x: number, y: number): void;
  resize(width: number, height: number): void;
  scale(): number;
  setTitle(title: string): void;
  setIcon(icon: Icon | undefined): void;
  minimize(): void;
  toggleMaximize(): void;
  isMaximized(): boolean;
  isMinimized(): boolean;
  showSystemMenu(): void;
  setTopmost(on: boolean): void;
  startDrag(): void;
  startResize(edge: ResizeEdge): void;
  setClickThrough(on: boolean): void;
  setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void;
  onResize(handler: (bounds: Rect) => void): () => void;
  onMaximizeChange(handler: (maximized: boolean) => void): () => void;
  onMove(handler: (bounds: Rect) => void): () => void;
  onClose(handler: () => void): () => void;
  onFileDrop(handler: (paths: string[]) => void): () => void;
  /** Internal: lets Window wire default native close -> outer Window.dispose(). */
  setOwnerDispose?(fn: () => void): void;
  /** Internal: snapshots native window styles and outer bounds before WebView attach and returns a restore thunk. */
  preserveGeometry?(): () => void;
  dispose(): void;
}

type Backend = {
  createWindow(options: WindowOptions): WindowBackend;
  fromHandle(handle: WindowHandle): WindowBackend;
};

const impl = backend<Backend>(
  () => require("./win32/window"),
  () => require("./darwin/window"),
);

type TabListeners = {
  newTab: Set<(origin: Window) => void>;
  tabSelect: Set<(tab: TabHandle) => void>;
  tabClose: Set<(tab: TabHandle) => void>;
};

const windowMetaMap = new WeakMap<Window, WindowMeta>();
const windowBackendMap = new WeakMap<Window, WindowBackend>();
const windowTabListeners = new WeakMap<Window, TabListeners>();
const windowDisposeHooks = new WeakMap<Window, Set<() => void>>();
const windowDisposed = new WeakSet<Window>();
const ownedWindows = new Set<Window>();
// A window the application has shown, visible or hidden since (to a tray, say), keeps the pumped
// loop running until it is disposed; one never shown and alone does not (D46).
const shownWindows = new WeakSet<Window>();
addReachable(() => {
  let any = false;
  for (const win of ownedWindows) {
    if (win.isVisible()) {
      shownWindows.add(win);
      noteReachable();
    }
    if (shownWindows.has(win)) any = true;
  }
  return any;
});
// Active native-dispose holds per Window, and Windows whose backend dispose
// waits for the last hold to be released.
const windowNativeDisposeHolds = new WeakMap<Window, number>();
const windowPendingNativeDispose = new WeakSet<Window>();

type FileDropListener = (paths: string[]) => void;
type FileDropChange = (hasListeners: boolean) => void;
const windowFileDropListeners = new WeakMap<Window, Set<FileDropListener>>();
const windowFileDropHooks = new WeakMap<Window, Set<FileDropChange>>();

export function windowFileDropCount(win: Window): number {
  return windowFileDropListeners.get(win)?.size ?? 0;
}

export function emitWindowFileDrop(win: Window, paths: string[]): void {
  const listeners = windowFileDropListeners.get(win);
  if (!listeners || isWindowDisposed(win)) return;
  for (const handler of [...listeners]) {
    try {
      handler(paths);
    } catch (err) {
      console.error("sweetview: onFileDrop handler threw:", err);
    }
  }
}

export function onWindowFileDropListenersChange(win: Window, fn: FileDropChange): () => void {
  let hooks = windowFileDropHooks.get(win);
  if (!hooks) {
    hooks = new Set();
    windowFileDropHooks.set(win, hooks);
  }
  hooks.add(fn);
  return () => hooks.delete(fn);
}

function notifyFileDropChange(win: Window, hasListeners: boolean): void {
  const hooks = windowFileDropHooks.get(win);
  if (hooks) for (const fn of [...hooks]) fn(hasListeners);
}

function windowIcon(icon: AppIdentityIcon | undefined): Icon | undefined {
  if (!icon || process.platform !== "win32") return undefined;
  const { rgba, width, height } = icon;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new RangeError("sweetview: identity icon dimensions do not match its RGBA data");
  }
  const size = Math.max(width, height);
  if (width === height) return { windows: { ico: icoFromRgba(size, rgba) } };
  const square = new Uint8Array(size * size * 4);
  const x = Math.floor((size - width) / 2);
  const y = Math.floor((size - height) / 2);
  for (let row = 0; row < height; row++) {
    square.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * size + x) * 4);
  }
  return { windows: { ico: icoFromRgba(size, square) } };
}

/** Internal metadata read by WebView.attach / tabs coordinator. */
export function getWindowMeta(win: Window): WindowMeta {
  return windowMetaMap.get(win)!;
}

/** Internal backend accessor used by platform tab drivers. */
export function getWindowBackend(win: Window): WindowBackend {
  return windowBackendMap.get(win)!;
}

/** Internal hook invoked right before native Window disposal (used by tabs drivers). */
export function onWindowDispose(win: Window, fn: () => void): () => void {
  let set = windowDisposeHooks.get(win);
  if (!set) {
    set = new Set();
    windowDisposeHooks.set(win, set);
  }
  set.add(fn);
  return () => set.delete(fn);
}

/**
 * Internal: defers releasing the native window (NSWindow / HWND) while held.
 * Window.dispose() still runs its hooks and marks the Window disposed at once,
 * but the backend dispose waits until the last hold is released. WebView.run()
 * holds the window so webview_destroy runs before its native window goes away.
 * The returned release function is idempotent.
 */
export function holdWindowNativeDispose(win: Window): () => void {
  if (windowDisposed.has(win) && !windowPendingNativeDispose.has(win)) return () => {};
  windowNativeDisposeHolds.set(win, (windowNativeDisposeHolds.get(win) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (windowNativeDisposeHolds.get(win) ?? 1) - 1;
    if (count > 0) {
      windowNativeDisposeHolds.set(win, count);
      return;
    }
    windowNativeDisposeHolds.delete(win);
    if (windowPendingNativeDispose.delete(win)) getWindowBackend(win).dispose();
  };
}

/**
 * Hides a visible window this process made, as the first instant of its teardown, so no window
 * is on the screen with its webview gone and its client area empty (D46): its webviews and the
 * window are destroyed right after. A failure is logged and the teardown goes on.
 */
function concealWindow(win: Window): boolean {
  // macOS keeps the tag's teardown order until its goal (D42): nothing is ordered out first there.
  if (macosKeepsTagPath() || !windowMetaMap.get(win)?.owned) return false;
  const inner = windowBackendMap.get(win);
  if (!inner) return false;
  try {
    if (!inner.isVisible()) return false;
    inner.hide();
    return true;
  } catch (err) {
    console.error("sweetview: hiding a window before its teardown threw:", err);
    return false;
  }
}

/** Internal check for whether Window.dispose() has already run. */
export function isWindowDisposed(win: Window): boolean {
  return windowDisposed.has(win);
}

/** Internal helper used by WebView.attach to preserve window styles & outer bounds across webview creation. */
export function preserveWindowGeometry(win: Window): () => void {
  return getWindowBackend(win).preserveGeometry?.() ?? (() => {});
}

/** Internal emitter used by the tabs coordinator to dispatch Window tab events. */
export function emitWindowNewTab(win: Window, origin: Window = win): void {
  const listeners = windowTabListeners.get(win);
  if (!listeners) return;
  for (const fn of [...listeners.newTab]) {
    try {
      fn(origin);
    } catch (err) {
      console.error("sweetview: onNewTab handler threw:", err);
    }
  }
}

export function emitWindowTabSelect(win: Window, tab: TabHandle): void {
  const listeners = windowTabListeners.get(win);
  if (!listeners) return;
  for (const fn of [...listeners.tabSelect]) {
    try {
      fn(tab);
    } catch (err) {
      console.error("sweetview: onTabSelect handler threw:", err);
    }
  }
}

export function emitWindowTabClose(win: Window, tab: TabHandle): void {
  const listeners = windowTabListeners.get(win);
  if (!listeners) return;
  for (const fn of [...listeners.tabClose]) {
    try {
      fn(tab);
    } catch (err) {
      console.error("sweetview: onTabClose handler threw:", err);
    }
  }
}

/** Forwards tab events emitted on a torn-off window to its parent window's listeners as well. */
export function forwardWindowTabEvents(from: Window, to: Window): void {
  from.onNewTab((origin) => emitWindowNewTab(to, origin));
  from.onTabSelect((tab) => emitWindowTabSelect(to, tab));
  from.onTabClose((tab) => emitWindowTabClose(to, tab));
}

const INTERNAL_CONSTRUCT = Symbol("sweetview.window.internal");

export class Window {
  readonly handle: WindowHandle;
  readonly #inner: WindowBackend;
  readonly #meta: WindowMeta;
  readonly #fileDropListeners = new Set<FileDropListener>();
  #unsubscribeNativeDrop?: () => void;
  readonly #unregister: () => void;
  readonly #unregisterConceal: () => void;
  readonly #tabListeners: TabListeners = {
    newTab: new Set(),
    tabSelect: new Set(),
    tabClose: new Set(),
  };

  constructor(options: WindowOptions = {}) {
    if (options && INTERNAL_CONSTRUCT in (options as Record<PropertyKey, unknown>)) {
      const payload = (options as unknown as { [INTERNAL_CONSTRUCT]: { inner: WindowBackend; meta: WindowMeta } })[INTERNAL_CONSTRUCT];
      this.#inner = payload.inner;
      this.#meta = payload.meta;
      this.handle = payload.inner.handle;
    } else {
      const frame = options.frame ?? true;
      const resizable = options.resizable ?? frame;
      const transparent = options.transparent ?? false;
      const tabs = options.tabs ?? false;
      const appearance = options.appearance ?? "system";
      if (options.bounds !== undefined && options.contentSize !== undefined) throw new Error("sweetview: bounds and contentSize cannot both be given");
      const backgroundColor = backgroundColorOf(options.backgroundColor);
      this.#meta = {
        title: options.title ?? options.identity?.appName ?? "",
        topmost: options.topmost ?? false,
        opacity: options.opacity,
        backgroundColor: transparent && !tabs ? undefined : backgroundColor,
        hideFromTaskbar: options.hideFromTaskbar ?? false,
        noActivate: options.noActivate ?? false,
        frame,
        resizable,
        transparent,
        tabs,
        appearance,
        icon: options.icon ?? windowIcon(options.identity?.icon),
        minWidth: options.minWidth,
        minHeight: options.minHeight,
        owned: true,
      };
      this.#inner = impl().createWindow({
        ...options, frame, resizable, transparent, tabs, appearance,
        title: this.#meta.title,
        icon: this.#meta.icon,
        backgroundColor,
      });
      this.#inner.setOwnerDispose?.(() => this.dispose());
      this.handle = this.#inner.handle;
      if (options.onResize) this.onResize(options.onResize);
      if (options.onMaximizeChange) this.onMaximizeChange(options.onMaximizeChange);
      if (options.onMove) this.onMove(options.onMove);
      if (options.onClose) this.onClose(options.onClose);
      if (options.onFileDrop) this.onFileDrop(options.onFileDrop);
      if (options.onNewTab) this.onNewTab(options.onNewTab);
      if (options.onTabSelect) this.onTabSelect(options.onTabSelect);
      if (options.onTabClose) this.onTabClose(options.onTabClose);
      ownedWindows.add(this);
    }
    windowMetaMap.set(this, this.#meta);
    windowBackendMap.set(this, this.#inner);
    windowTabListeners.set(this, this.#tabListeners);
    // Disposed when the application ends, after its webviews and trays; hidden before any of
    // them goes, so no window is seen with its webview gone (D46).
    this.#unregister = releaseAtEnd("window", () => this.dispose());
    this.#unregisterConceal = releaseAtEnd("conceal", () => void concealWindow(this));
  }

  /** Non-mutating wrapper around an existing HWND or NSWindow*. */
  static fromHandle(handle: WindowHandle): Window {
    const inner = impl().fromHandle(handle);
    const meta: WindowMeta = {
      title: "",
      frame: inner.detectedMeta?.frame ?? true,
      resizable: inner.detectedMeta?.resizable ?? true,
      transparent: false,
      tabs: false,
      appearance: "system",
      owned: false,
    };
    return new Window({ [INTERNAL_CONSTRUCT]: { inner, meta } } as unknown as WindowOptions);
  }

  /** Visible owned windows, including minimized windows. */
  static visibleWindows(): Window[] {
    return [...ownedWindows].filter((win) => win.isVisible());
  }

  // Visibility
  isVisible(): boolean {
    return this.#inner.isVisible();
  }
  show(): void {
    shownWindows.add(this);
    noteReachable();
    this.#inner.show();
  }
  hide(): void {
    this.#inner.hide();
  }
  toggle(): void {
    this.#inner.toggle();
  }

  // Geometry (outer frame)
  bounds(): Rect {
    return this.#inner.bounds();
  }
  setBounds(rect: Rect): void {
    this.#inner.setBounds(rect);
  }
  moveTo(x: number, y: number): void {
    this.#inner.moveTo(x, y);
  }
  resize(width: number, height: number): void {
    this.#inner.resize(width, height);
  }
  scale(): number {
    return this.#inner.scale();
  }

  // State & chrome
  setTitle(title: string): void {
    this.#meta.title = title;
    this.#inner.setTitle(title);
  }
  setIcon(icon: Icon | undefined): void {
    this.#inner.setIcon(icon);
  }
  minimize(): void {
    this.#inner.minimize();
  }
  toggleMaximize(): void {
    this.#inner.toggleMaximize();
  }
  isMaximized(): boolean {
    return this.#inner.isMaximized();
  }
  /**
   * True while the window is minimised (`IsIconic` on Windows, `isMiniaturized`
   * on macOS). `isVisible()` stays true for a minimised window; a hidden window
   * that is not minimised reads as false.
   */
  isMinimized(): boolean {
    return this.#inner.isMinimized();
  }
  /**
   * Shows the window's system menu (Restore, Move, Size, Minimize, Maximize,
   * Close) at the cursor and carries out the chosen command, as a right click
   * on an OS title bar does: for a page-drawn title bar's right click. Blocks
   * until the menu closes. macOS has no such menu: does nothing.
   */
  showSystemMenu(): void {
    this.#inner.showSystemMenu();
  }
  setTopmost(on: boolean): void {
    this.#meta.topmost = on;
    this.#inner.setTopmost(on);
  }
  startDrag(): void {
    this.#inner.startDrag();
  }
  startResize(edge: ResizeEdge): void {
    this.#inner.startResize(edge);
  }

  // Click-through & hit regions
  setClickThrough(on: boolean): void {
    this.#inner.setClickThrough(on);
  }
  setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void {
    this.#inner.setHitRegions(polygons, refine);
  }

  // Event subscriptions (each returns an unsubscribe thunk)
  onResize(handler: (bounds: Rect) => void): () => void {
    return this.#inner.onResize(handler);
  }
  /**
   * Called with `true` when the window becomes maximized and `false` when it
   * is restored, by any means: the frame's button, a snap gesture, a double
   * click on the title bar, `toggleMaximize()` (a frameless window: filling
   * its work area). Minimizing and restoring to the same state reports
   * nothing. Returns the function that removes this listener.
   */
  onMaximizeChange(handler: (maximized: boolean) => void): () => void {
    return this.#inner.onMaximizeChange(handler);
  }
  onMove(handler: (bounds: Rect) => void): () => void {
    return this.#inner.onMove(handler);
  }
  onClose(handler: () => void): () => void {
    return this.#inner.onClose(handler);
  }
  onFileDrop(handler: (paths: string[]) => void): () => void {
    if (windowDisposed.has(this)) return () => {};
    const listeners = this.#fileDropListeners;
    const first = listeners.size === 0;
    if (first) {
      this.#unsubscribeNativeDrop = this.#inner.onFileDrop((paths) => emitWindowFileDrop(this, paths));
      windowFileDropListeners.set(this, listeners);
    }
    // Each subscription can be removed independently, even for the same handler.
    const listener: FileDropListener = (paths) => handler(paths);
    listeners.add(listener);
    if (first) notifyFileDropChange(this, true);
    return () => {
      if (!listeners.delete(listener) || listeners.size !== 0) return;
      this.#unsubscribeNativeDrop?.();
      this.#unsubscribeNativeDrop = undefined;
      notifyFileDropChange(this, false);
    };
  }
  onNewTab(handler: (origin: Window) => void): () => void {
    this.#tabListeners.newTab.add(handler);
    return () => this.#tabListeners.newTab.delete(handler);
  }
  onTabSelect(handler: (tab: TabHandle) => void): () => void {
    this.#tabListeners.tabSelect.add(handler);
    return () => this.#tabListeners.tabSelect.delete(handler);
  }
  onTabClose(handler: (tab: TabHandle) => void): () => void {
    this.#tabListeners.tabClose.add(handler);
    return () => this.#tabListeners.tabClose.delete(handler);
  }

  /**
   * Releases timers, subclasses, notification observers, icons, and per-window entries, and
   * destroys a window this process made. Every window is disposed when the application ends
   * (see `run()`); call it to close one before that. Safe to call twice.
   */
  dispose(): void {
    if (windowDisposed.has(this)) return;
    // Off the screen first, then its webviews (the dispose hooks), then the window: never a
    // window on the screen with its webview gone and its client area empty (D46).
    concealWindow(this);
    windowDisposed.add(this);
    this.#unregister();
    this.#unregisterConceal();
    ownedWindows.delete(this);
    const hooks = windowDisposeHooks.get(this);
    if (hooks) {
      windowDisposeHooks.delete(this);
      for (const fn of [...hooks]) {
        try {
          fn();
        } catch (err) {
          console.error("sweetview: window dispose hook threw:", err);
        }
      }
    }
    this.#tabListeners.newTab.clear();
    this.#tabListeners.tabSelect.clear();
    this.#tabListeners.tabClose.clear();
    this.#unsubscribeNativeDrop?.();
    this.#unsubscribeNativeDrop = undefined;
    this.#fileDropListeners.clear();
    windowFileDropListeners.delete(this);
    windowFileDropHooks.delete(this);
    // A held window (e.g. inside WebView.run()) keeps its native window until the
    // holder releases it, so webview_destroy never touches a released NSWindow/HWND.
    if ((windowNativeDisposeHolds.get(this) ?? 0) > 0) {
      windowPendingNativeDispose.add(this);
      return;
    }
    this.#inner.dispose();
  }
}

export function createWindow(options?: WindowOptions): Window {
  return new Window(options);
}

/** Closes secondary windows normally and hides the last visible window. */
export function closeToTrayOnLastWindow(win: Window, onHide?: (win: Window) => void): () => void {
  return win.onClose(() => {
    if (Window.visibleWindows().some((other) => other !== win)) {
      win.dispose();
    } else {
      win.hide();
      onHide?.(win);
    }
  });
}
