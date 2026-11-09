// Turn a window someone else created (the webview's) into an overlay: no
// frame, above everything, off the taskbar, never takes focus, and see-through
// where the page paints the colour key. Then move it around.
//
// Units: physical pixels on Windows (the process is per-monitor DPI aware),
// points on macOS; `scale()` says how many of them one CSS pixel of the page
// is. Origin top-left of the primary screen on both.
//
// The colour key (Windows only) is 1-bit transparency; `transparent` is real
// alpha on both platforms.

import type { HitPolygon } from "./hit-regions";
import type { Icon } from "./icon";
import type { WindowHandle } from "./window";
import { backend } from "./platform";

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/**
 * Asked while the cursor is inside a hit polygon, with the cursor in
 * window-local units; whoever knows the exact shape (the page, with a
 * triangle pick) calls `answer` with whether that point is really solid.
 * Until the answer arrives the polygon's own answer stands; an answer that
 * arrives after the cursor has moved on is dropped.
 */
export type HitRefiner = (local: Point, answer: (solid: boolean) => void) => void;

/** An edge or corner of the window, for startResize. */
export type ResizeEdge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type OverlayOptions = {
  /**
   * Honour the page's alpha: wherever the page is transparent, the desktop
   * shows through, anti-aliased edges and all. Needs the browser to paint a
   * transparent background too (sweetview's `transparent: true`). Clicks on
   * transparent pixels still land on the window; use setClickThrough for
   * whole-window pass-through.
   */
  transparent?: boolean;
  /** `#rrggbb`; pixels of exactly this colour are transparent and click-through. 1-bit; not needed with `transparent`. */
  colorKey?: string;
  /** Whole-window opacity, 0..1. Combines with the colour key. */
  opacity?: number;
  /** Above every normal window. Default true. */
  topmost?: boolean;
  /** No taskbar button, no Alt+Tab entry. Default true. */
  hideFromTaskbar?: boolean;
  /**
   * Clicking it never takes focus from the app the user is in. Default true.
   * `false` makes a frameless window that takes focus and keyboard input (a
   * settings window drawing its own chrome); on macOS that needs the window
   * created by `createOverlayWindow`, which gives it a class that can become key.
   */
  noActivate?: boolean;
};

export interface Overlay {
  /** The HWND / NSWindow*, for handing to sweetview as the host window. */
  readonly handle: WindowHandle;
  /** Shows without taking focus. */
  show(): void;
  hide(): void;
  /**
   * Windows: the title bar, taskbar and Alt+Tab icon from `icon.windows.ico`;
   * undefined restores the stock one. Only a framed window shows it. macOS:
   * no-op, a window has no icon of its own there; `setAppIcon` sets the Dock's.
   */
  setIcon(icon: Icon | undefined): void;
  /** Position and size in window units (see `scale()`). */
  bounds(): Rect;
  moveTo(x: number, y: number): void;
  resize(width: number, height: number): void;
  setBounds(rect: Rect): void;
  /** Whole-window: when on, every click falls through to what is underneath. */
  setClickThrough(on: boolean): void;
  /**
   * Which parts of the window take clicks: polygons in window-local units
   * (see `scale()`); a click anywhere else falls through to whatever is
   * underneath. `null` means the whole window takes clicks again. Meant to
   * be resent as things move, tens of times a second if need be: nothing is
   * repainted for it. The page computes the polygons from what it draws
   * (the convex hull of each mesh's projected bounding-box corners is its
   * exact silhouette for box-shaped meshes; `convexHull` in
   * `@n1h/sweetview/native/hit-regions` is page-safe) and this side answers the
   * cursor itself, so the page is never in the click path.
   *
   * How: a 10 ms timer, and every update, test the cursor against the
   * polygons and flip the window's pass-through state (Windows:
   * WS_EX_TRANSPARENT with WS_EX_LAYERED, the only thing the window manager
   * honours across processes short of a window region, which forces a
   * repaint of the browser each time it changes; macOS: ignoresMouseEvents).
   * Nothing changes while a mouse button is down, so a drag survives leaving
   * the polygons. While the cursor is outside the window the window passes
   * clicks through, so entering onto empty space is right from the first
   * pixel; entering onto a polygon takes one tick.
   *
   * The polygons are the coarse answer: a mesh's bounding-box hull includes
   * the gap between a cat's ears. With `refine`, every time the cursor is
   * inside a polygon (and whenever the polygons change under a still cursor)
   * the refiner is asked for the exact answer and the pass-through state
   * follows its reply, typically a few milliseconds later; outside every
   * polygon nobody is asked. A refiner that never answers leaves polygon
   * precision, so a stalled page degrades, never breaks.
   */
  setHitRegions(polygons: HitPolygon[] | null, refine?: HitRefiner): void;
  setTopmost(on: boolean): void;
  /**
   * Hand the mouse gesture in progress to the OS as a window move, as a
   * title bar would: called from a UI-thread method on the page's
   * pointer-down in its own title bar, the OS then moves the window with the
   * cursor, with snapping and all, until the button is released. A page
   * draws its own chrome this way in a frameless window.
   */
  startDrag(): void;
  /** The same for a resize from an edge or corner (the page's own resize handles). macOS: no-op; a frameless macOS overlay has no resizable mask, so it is not resized by the user at all. */
  startResize(edge: ResizeEdge): void;
  minimize(): void;
  /** Between the work area and the previous bounds (Windows); zoom (macOS). */
  toggleMaximize(): void;
  maximized(): boolean;
  /** Cursor position on the screen, window units. */
  cursor(): Point;
  /** The whole primary monitor, window units. The overlay draws over the taskbar or Dock there. */
  screen(): Rect;
  /** The whole monitor under a point, window units; the nearest one when the point is on none. A window dropped on another monitor finds its new bounds with this. */
  screenAt(point: Point): Rect;
  /** The primary monitor minus the taskbar or Dock, window units. */
  workArea(): Rect;
  /** Every monitor together, window units. */
  virtualScreen(): Rect;
  /** Window units per CSS pixel of the page: the DPI scale on Windows, 1 on macOS. */
  scale(): number;
}

export type OverlayWindowOptions = OverlayOptions & {
  title?: string;
  /** Initial bounds, window units. Default: 320x240 at the work area's centre. */
  bounds?: Rect;
  /**
   * A normal window instead of an overlay: title bar and close button, a
   * taskbar or Dock presence, activates when clicked, not above other
   * windows, opaque. Still created hidden, so `show()` is the first time it
   * appears, and its close button hides it rather than ending the app. For
   * a settings window next to an overlay, hosted by the same process and OS
   * loop. On macOS the overlay options are ignored; on Windows `frame` only
   * changes their defaults (not topmost, in the taskbar, activating, opaque),
   * and an option given explicitly still applies.
   */
  frame?: boolean;
  /** Framed windows: dark title bar and frame (Windows 11's immersive dark mode; the dark appearance on macOS), for a dark page. */
  dark?: boolean;
  /** Windows: the title bar, taskbar and Alt+Tab icon (see `Overlay.setIcon`). macOS: ignored. */
  icon?: Icon;
};

type Backend = {
  makeOverlay(handle: WindowHandle, options: OverlayOptions): Overlay;
  createOverlayWindow(options: OverlayWindowOptions): Overlay;
};
const impl = backend<Backend>(
  () => require("./win32/overlay"),
  () => require("./darwin/overlay"),
);

/** Restyle an existing window (the webview's) into an overlay. */
export function makeOverlay(handle: WindowHandle, options: OverlayOptions = {}): Overlay {
  return impl().makeOverlay(handle, options);
}

/**
 * Create a hidden overlay window of our own, to hand to sweetview as the host
 * (`createWebviewApp({ window: overlay.handle })`). Transparency set up before
 * the browser is created is what WebView2 needs for a see-through page; it
 * ignores a host that turned transparent later. Call `show()` once the page
 * is set. On Windows the window's procedure ends the run loop when the
 * window is destroyed and keeps the browser sized to the client area; on
 * macOS neither happens here.
 */
export function createOverlayWindow(options: OverlayWindowOptions = {}): Overlay {
  return impl().createOverlayWindow(options);
}
