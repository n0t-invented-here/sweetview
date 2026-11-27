// The Windows backend of `Window`, over the Rust binding: `tao` makes the
// window, `sweetview-platform-window` subclasses it for its events and the
// styles `tao` does not model, and the runtime runs the hit-region poll and
// the resize gesture. A tabbed window still comes from tabbed-window.ts.
//
// Each application handler is wrapped here, so an exception is logged with
// the message Sweetview has always used for that handler.

import { binding } from "../binding";
import type { Window as NativeWindow } from "../../prebuilt/binding";
import { packRegions } from "../hit-regions";
import type { Rect, WindowBackend, WindowHandle, WindowOptions } from "../window";
import { createTabbedWindow, systemIsDark, tabbedTrackedCount } from "./tabbed-window";

export { systemIsDark };

/** A window handle as the `bigint` the binding takes. Throws for `null`, `0` and `0n`. */
export const asHwnd = (handle: WindowHandle): bigint => {
  if (handle === null || handle === 0 || handle === 0n) throw new Error("sweetview: window handle is NULL");
  return BigInt(handle);
};

/** Diagnostic for tests: what Sweetview still keeps for `hwnd`, natively and for tabbed windows. */
export function _debugTrackedCount(hwnd: bigint): number {
  return binding().windowTrackedCount(hwnd) + tabbedTrackedCount(hwnd);
}

type RectHandler = (bounds: Rect) => void;

function callEach<T>(handlers: Set<(value: T) => void>, value: T, name: string): void {
  for (const fn of [...handlers]) {
    try {
      fn(value);
    } catch (err) {
      console.error(`sweetview: ${name} handler threw:`, err);
    }
  }
}

/**
 * Keeps any number of handlers per event on the JavaScript side and one
 * listener per event in the binding, registered while there is a handler.
 */
function subscription<T>(register: (listener: ((value: T) => void) | null) => void, name: string) {
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

function wrap(native: NativeWindow, owned: boolean): WindowBackend {
  let disposed = false;
  let ownerDispose: (() => void) | undefined;
  const live = () => !disposed;
  const toRect = (fn: (r: Rect) => void) => (x: number, y: number, width: number, height: number) => fn({ x, y, width, height });

  const resize = subscription<Rect>((l) => native.onResize(l && toRect(l)), "onResize");
  const move = subscription<Rect>((l) => native.onMove(l && toRect(l)), "onMove");
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
    setTopmost: (on) => {
      if (live()) native.setTopmost(on);
    },
    startDrag: () => {
      if (live()) native.startDrag();
    },
    startResize: (edge) => {
      if (live()) native.startResize(edge);
    },

    setClickThrough: (on) => {
      if (live()) native.setClickThrough(on);
    },
    setHitRegions: (polygons, refine) => {
      if (!live()) return;
      if (polygons === null) {
        native.setHitRegions(null, null);
        return;
      }
      const ask = refine
        ? (x: number, y: number, seq: number) => {
            try {
              refine({ x, y }, (solid) => native.answerHit(seq, solid));
            } catch (err) {
              console.error("sweetview: hit region poll threw:", err);
            }
          }
        : null;
      native.setHitRegions(packRegions(polygons), ask);
    },

    onResize: (handler: RectHandler) => (live() ? resize.add(handler) : () => {}),
    onMove: (handler: RectHandler) => (live() ? move.add(handler) : () => {}),
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
      for (const s of [resize, move, close, fileDrop]) s.clear();
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
  if (options.tabs) return createTabbedWindow(options);
  const frame = options.frame ?? true;
  const native = binding().Window.create({
    title: options.title ?? "",
    bounds: options.bounds,
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
