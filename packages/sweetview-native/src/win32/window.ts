// The Windows backend of `Window`, over the Rust binding: `tao` makes the
// window, `sweetview-platform-window` subclasses it for its events and the
// styles `tao` does not model, and the runtime runs the hit-region poll and
// the resize gesture. A tabbed window's frame is such a window too, made
// with a tab strip height; tab-window.ts is its tab side.
//
// Each application handler is wrapped here, so an exception is logged with
// the message Sweetview has always used for that handler.

import { binding } from "../binding";
import { reportCallbackError } from "../callback-errors";
import type { Window as NativeWindow } from "../../prebuilt/binding";
import { packRegions } from "../hit-regions";
import type { Rect, WindowBackend, WindowHandle, WindowOptions } from "../window";
import { STRIP_HEIGHT } from "./strip-shared";
import { keyOf } from "./listener-keys";
import { getTabFrame } from "./tab-window";

/** True when Windows apps are set to the dark theme. */
export function systemIsDark(): boolean {
  return binding().systemIsDark();
}

/** A window handle as the `bigint` the binding takes. Throws for `null`, `0` and `0n`. */
export const asHwnd = (handle: WindowHandle): bigint => {
  if (handle === null || handle === 0 || handle === 0n) throw new Error("sweetview: window handle is NULL");
  return BigInt(handle);
};

/** Diagnostic for tests: what Sweetview still keeps for `hwnd`. */
export function _debugTrackedCount(hwnd: bigint): number {
  return binding().windowTrackedCount(hwnd);
}

type RectHandler = (bounds: Rect) => void;

type ListenerName = "onResize" | "onMove" | "onClose" | "onFileDrop" | "onMaximizeChange";

function callEach<T>(handlers: Set<(value: T) => void>, value: T, name: ListenerName): void {
  for (const fn of [...handlers]) {
    try {
      fn(value);
    } catch (err) {
      reportCallbackError(`window.${name}`, err, `sweetview: ${name} handler threw:`);
    }
  }
}

/**
 * A resize, move or maximise listener: the window's one list of them is the
 * binding's, whichever wrapper adds to it, as tag `pre-rust-rewrite` kept one
 * set per window. Each handler is its own listener there, under its
 * function's key; removing it removes it for every wrapper.
 */
function windowListener<A extends unknown[]>(register: (key: number, listener: ((...args: A) => void) | null) => void, name: ListenerName, live: () => boolean) {
  return <T>(handler: (value: T) => void, from: (...args: A) => T): (() => void) => {
    if (!live()) return () => {};
    const key = keyOf(handler);
    register(key, (...args: A) => {
      try {
        handler(from(...args));
      } catch (err) {
        reportCallbackError(`window.${name}`, err, `sweetview: ${name} handler threw:`);
      }
    });
    return () => {
      if (live()) register(key, null);
    };
  };
}

/**
 * Keeps any number of close or file-drop handlers of one wrapper on the
 * JavaScript side and one listener per event in the binding, registered while
 * there is a handler.
 */
function subscription<T>(register: (listener: ((value: T) => void) | null) => void, name: ListenerName) {
  const handlers = new Set<(value: T) => void>();
  return {
    handlers,
    add(handler: (value: T) => void): () => void {
      // Each subscription can be removed on its own, even for the same function.
      const entry = (value: T) => handler(value);
      if (handlers.size === 0) register((value) => callEach(handlers, value, name));
      handlers.add(entry);
      return () => {
        if (!handlers.delete(entry) || handlers.size > 0) return;
        register(null);
      };
    },
    clear() {
      handlers.clear();
    },
  };
}

function wrap(native: NativeWindow, owned: boolean, tabbed = false): WindowBackend {
  let disposed = false;
  let ownerDispose: (() => void) | undefined;
  const live = () => !disposed;

  const asRect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
  const resize = windowListener<[number, number, number, number]>((key, l) => native.onResize(key, l), "onResize", live);
  const move = windowListener<[number, number, number, number]>((key, l) => native.onMove(key, l), "onMove", live);
  const maximize = windowListener<[boolean]>((key, l) => native.onMaximizeChange(key, l), "onMaximizeChange", live);
  const close = subscription<void>((l) => native.onCloseRequest(l && (() => l())), "onClose");
  const fileDrop = subscription<string[]>((l) => native.onFileDrop(l), "onFileDrop");

  const self: WindowBackend = {
    handle: native.handle,
    detectedMeta: native.detected ?? undefined,

    isVisible: () => live() && native.isVisible(),
    show: () => {
      if (live()) native.show();
    },
    hide: () => {
      if (live()) native.hide();
    },
    toggle: () => {
      if (self.isVisible()) self.hide();
      else self.show();
    },

    bounds: () => native.bounds(),
    setBounds: (r: Rect) => {
      if (live()) native.setBounds(r);
    },
    moveTo: (x, y) => {
      if (live()) native.moveTo(x, y);
    },
    resize: (width, height) => {
      if (live()) native.resize(width, height);
    },
    scale: () => native.scale(),

    setTitle: (title) => {
      if (live()) native.setTitle(title);
    },
    setIcon: (icon) => {
      if (live()) native.setIcon(icon?.windows?.ico ?? null);
    },
    minimize: () => {
      if (live()) native.minimize();
    },
    toggleMaximize: () => {
      if (live()) native.toggleMaximize();
    },
    isMaximized: () => live() && native.isMaximized(),
    isMinimized: () => live() && native.isMinimized(),
    showSystemMenu: () => {
      if (live()) binding().windowMenu(native.handle);
    },
    setTopmost: (on) => {
      if (live()) native.setTopmost(on);
    },
    // A tab frame hands the press to the OS move and size loops, as its strip does.
    startDrag: () => {
      if (!live()) return;
      if (tabbed) getTabFrame(native.handle)?.startDrag();
      else native.startDrag();
    },
    startResize: (edge) => {
      if (!live()) return;
      if (tabbed) getTabFrame(native.handle)?.startResize(edge);
      else native.startResize(edge);
    },

    // Click-through and hit regions do not apply to tabbed windows.
    setClickThrough: (on) => {
      if (live() && !tabbed) native.setClickThrough(on);
    },
    setHitRegions: (polygons, refine) => {
      if (!live() || tabbed) return;
      if (polygons === null) {
        native.setHitRegions(null, null);
        return;
      }
      const ask = refine
        ? (x: number, y: number, seq: number) => {
            try {
              refine({ x, y }, (solid) => native.answerHit(seq, solid));
            } catch (err) {
              reportCallbackError("hitRegions.refine", err, "sweetview: hit region poll threw:");
            }
          }
        : null;
      native.setHitRegions(packRegions(polygons), ask);
    },

    onResize: (handler: RectHandler) => resize(handler, asRect),
    onMaximizeChange: (handler: (maximized: boolean) => void) => maximize(handler, (maximized: boolean) => maximized),
    onMove: (handler: RectHandler) => move(handler, asRect),
    onClose: (handler: () => void) => (live() ? close.add(handler) : () => {}),
    onFileDrop: (handler: (paths: string[]) => void) => (live() ? fileDrop.add(handler) : () => {}),

    setOwnerDispose(fn) {
      if (owned) ownerDispose = fn;
    },

    preserveGeometry() {
      const id = native.preserveGeometry();
      return () => {
        if (live()) native.restoreGeometry(id);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // The binding takes out the resize, move and maximise listeners this wrapper added.
      for (const s of [close, fileDrop]) s.clear();
      native.dispose();
    },
  };

  if (owned) {
    // A close request no listener takes disposes the Window, which runs its
    // hooks before the native window goes; closing never ends the loop.
    native.onDefaultClose(() => (ownerDispose ?? self.dispose)());
  }
  return self;
}

function icoOf(options: WindowOptions): { ico?: Uint8Array } | undefined {
  const ico = options.icon?.windows?.ico;
  return ico ? { ico } : undefined;
}

export function createWindow(options: WindowOptions): WindowBackend {
  if (options.tabs) {
    // The frame of a tabbed window: framed, never transparent or colour-keyed; the strip replaces the caption.
    const native = binding().Window.create({
      title: options.title ?? "",
      bounds: options.bounds,
      contentSize: options.contentSize,
      backgroundColor: options.backgroundColor,
      minWidth: options.minWidth,
      minHeight: options.minHeight,
      frame: true,
      resizable: options.resizable ?? true,
      appearance: options.appearance ?? "system",
      icon: icoOf(options),
      transparent: false,
      opacity: options.opacity,
      topmost: options.topmost ?? false,
      hideFromTaskbar: options.hideFromTaskbar ?? false,
      noActivate: options.noActivate ?? false,
      tabStripHeight: STRIP_HEIGHT,
    });
    return wrap(native, true, true);
  }
  const frame = options.frame ?? true;
  const native = binding().Window.create({
    title: options.title ?? "",
    bounds: options.bounds,
    contentSize: options.contentSize,
    backgroundColor: options.backgroundColor,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    frame,
    resizable: options.resizable ?? frame,
    appearance: options.appearance ?? "system",
    icon: icoOf(options),
    transparent: options.transparent ?? false,
    colorKey: options.colorKey,
    opacity: options.opacity,
    topmost: options.topmost ?? false,
    hideFromTaskbar: options.hideFromTaskbar ?? false,
    noActivate: options.noActivate ?? false,
  });
  return wrap(native, true);
}

/** Wraps a window by handle; throws when the handle names no window. */
export function fromHandle(handle: WindowHandle): WindowBackend {
  return wrap(binding().Window.adopt(asHwnd(handle)), false);
}
