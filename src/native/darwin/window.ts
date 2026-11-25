// Unified macOS Window implementation (replaces darwin/overlay.ts + darwin/window.ts).
//
// Fixes from the v1 audit:
// - 2.1: Explicit idempotent dispose() closing/releasing owned NSWindow and
//   clearing hits, ignoring, observers, and timers.
// - 2.3: Consistent outer-frame bounds on construction (apply setFrame:display:
//   while hidden); honor topmost, opacity, transparent, hideFromTaskbar, and
//   noActivate regardless of `frame`; implement drag-resize loop in startResize.
// - 2.7: Invalidate and release the 10ms hit-region NSTimer when hits.size === 0
//   or on dispose().
// - 2.9: Intercept performClose: on our NSWindow subclass so onClose catches
//   the close button, Cmd+W, programmatic closes, and frameless windows without
//   replacing NSWindow.delegate.

import { FFIType, JSCallback } from "bun:ffi";
import { hitRegions, packRegions } from "../hit-regions";
import type { HitRefiner, Point, Rect, ResizeEdge, WindowBackend, WindowHandle, WindowOptions } from "../window";
import {
  ID,
  NIL,
  allocRaw,
  asId,
  class_addMethod,
  cls,
  cstr,
  makeTarget,
  nsString,
  objc_allocateClassPair,
  objc_getClass,
  objc_registerClassPair,
  release,
  retain,
  retainCallback,
  sel,
  send,
  sendBool,
  sendF64PtrSelPtrBool,
  sendF64Void,
  sendInt,
  sendIntArg,
  sendPoint,
  sendPtr,
  sendPtrPtrPtrVoid,
  sendPtrSelPtrPtrVoid,
  sendRectBool,
  sendRectUIntUIntBool,
  sendRetBool,
  sendSize,
  sendUIntArg,
  sendUIntRetPtr,
  sharedApp,
  type Id,
} from "./objc";
import { cursorPoint, fromCocoa, primary as primaryScreen, primaryHeight, rectOf, toCocoa } from "./screen";

const NSWindowStyleMaskBorderless = 0n;
const NSWindowStyleMaskTitled = 1n;
const NSWindowStyleMaskClosable = 2n;
const NSWindowStyleMaskMiniaturizable = 4n;
const NSWindowStyleMaskResizable = 8n;
const NSBackingStoreBuffered = 2n;
const NSNormalWindowLevel = 0n;
const NSStatusWindowLevel = 25n;
const NSWindowCollectionBehaviorCanJoinAllSpaces = 1n << 0n;
const NSWindowCollectionBehaviorStationary = 1n << 4n;
const NSWindowCollectionBehaviorIgnoresCycle = 1n << 6n;
const NSWindowCollectionBehaviorFullScreenAuxiliary = 1n << 8n;
const NSApplicationActivationPolicyAccessory = 1n;
const NSWindowCloseButton = 0n;

const DEFAULT_MIN_RESIZE = { width: 160, height: 120 };

export const asNSWindow = (handle: WindowHandle): Id => {
  if (handle === null || handle === 0 || handle === 0n) throw new Error("sweetview: window handle is nil");
  return BigInt(handle);
};

// ---- per-window state & observers -----------------------------------------------

type EventBucket = {
  resize: Set<(bounds: Rect) => void>;
  move: Set<(bounds: Rect) => void>;
  close: Set<() => void>;
};

const eventsByWin = new Map<Id, EventBucket>();
const disposeByWin = new Map<Id, () => void>();
const ignoring = new Map<Id, boolean>();

function bucketFor(win: Id): EventBucket {
  let b = eventsByWin.get(win);
  if (!b) {
    b = { resize: new Set(), move: new Set(), close: new Set() };
    eventsByWin.set(win, b);
  }
  return b;
}

function fireResize(win: Id): void {
  const b = eventsByWin.get(win);
  if (!b || b.resize.size === 0) return;
  const r = fromCocoa(rectOf(win, "frame"));
  for (const fn of [...b.resize]) {
    try {
      fn(r);
    } catch (err) {
      console.error("sweetview: onResize handler threw:", err);
    }
  }
}

function fireMove(win: Id): void {
  const b = eventsByWin.get(win);
  if (!b || b.move.size === 0) return;
  const r = fromCocoa(rectOf(win, "frame"));
  for (const fn of [...b.move]) {
    try {
      fn(r);
    } catch (err) {
      console.error("sweetview: onMove handler threw:", err);
    }
  }
}

function fireClose(win: Id): boolean {
  const b = eventsByWin.get(win);
  if (!b || b.close.size === 0) return false;
  for (const fn of [...b.close]) {
    try {
      fn();
    } catch (err) {
      console.error("sweetview: onClose handler threw:", err);
    }
  }
  return true;
}

let observerTarget: Id | undefined;
function windowObserver(): Id {
  observerTarget ??= makeTarget("SweetviewWindowObserver", {
    "windowDidResize:": (notification) => {
      const win = asId(send(notification, sel("object")));
      if (win !== NIL) fireResize(win);
    },
    "windowDidMove:": (notification) => {
      const win = asId(send(notification, sel("object")));
      if (win !== NIL) fireMove(win);
    },
  });
  return observerTarget;
}

const observedWins = new Set<Id>();
function ensureObserved(win: Id): void {
  if (observedWins.has(win)) return;
  observedWins.add(win);
  const center = asId(send(cls("NSNotificationCenter"), sel("defaultCenter")));
  const obs = windowObserver();
  sendPtrSelPtrPtrVoid(center, sel("addObserver:selector:name:object:"), obs, sel("windowDidResize:"), nsString("NSWindowDidResizeNotification"), win);
  sendPtrSelPtrPtrVoid(center, sel("addObserver:selector:name:object:"), obs, sel("windowDidMove:"), nsString("NSWindowDidMoveNotification"), win);
}

function removeObserved(win: Id): void {
  if (!observedWins.has(win)) return;
  observedWins.delete(win);
  const center = asId(send(cls("NSNotificationCenter"), sel("defaultCenter")));
  const obs = windowObserver();
  sendPtrPtrPtrVoid(center, sel("removeObserver:name:object:"), obs, nsString("NSWindowDidResizeNotification"), win);
  sendPtrPtrPtrVoid(center, sel("removeObserver:name:object:"), obs, nsString("NSWindowDidMoveNotification"), win);
}

// Fallback close-button target for external Window.fromHandle() windows.
let closeButtonTarget: Id | undefined;
function externalCloseTarget(): Id {
  closeButtonTarget ??= makeTarget("SweetviewCloseTarget", {
    "closeRequested:": (sender) => {
      const win = asId(send(sender, sel("window")));
      if (win !== NIL) fireClose(win);
    },
  });
  return closeButtonTarget;
}

// ---- NSWindow subclasses with performClose: interception -------------------------

const OWNED_WINDOW_CLASS = "SweetviewWindow";
const OWNED_KEY_WINDOW_CLASS = "SweetviewKeyWindow";

function ensureWindowSubclass(className: string, allowKeyWhenBorderless: boolean): void {
  if (asId(objc_getClass(cstr(className))) !== NIL) return;
  const klass = asId(objc_allocateClassPair(cls("NSWindow"), cstr(className), 0n));
  if (klass === NIL) throw new Error(`sweetview: objc_allocateClassPair(${className}) failed`);

  const performCloseCb = new JSCallback(
    (selfWin: bigint, _cmd: bigint, _sender: bigint) => {
      try {
        if (fireClose(selfWin)) return;
        const onDispose = disposeByWin.get(selfWin);
        if (onDispose) onDispose();
        else send(selfWin, sel("close"));
      } catch (err) {
        console.error("sweetview: performClose: threw:", err);
      }
    },
    { args: [ID, ID, ID], returns: FFIType.void },
  );
  retainCallback(performCloseCb);
  if (!class_addMethod(klass, sel("performClose:"), performCloseCb.ptr, cstr("v@:@"))) {
    throw new Error(`sweetview: class_addMethod(${className}, performClose:) failed`);
  }

  if (allowKeyWhenBorderless) {
    for (const name of ["canBecomeKeyWindow", "canBecomeMainWindow"]) {
      const yesCb = new JSCallback((_self: bigint, _cmd: bigint) => true, { args: [ID, ID], returns: FFIType.bool });
      retainCallback(yesCb);
      if (!class_addMethod(klass, sel(name), yesCb.ptr, cstr("B@:"))) {
        throw new Error(`sweetview: class_addMethod(${className}, ${name}) failed`);
      }
    }
  }

  objc_registerClassPair(klass);
}

// ---- hit-region polling timer (invalidated when hits.size === 0) ----------------

const mouseButtonsDown = (): boolean => BigInt(sendInt(cls("NSEvent"), sel("pressedMouseButtons")) ?? 0) !== 0n;

type HitState = { packed: Int32Array; refine?: HitRefiner; inPolygon: boolean; asked?: Point; askSeq: number };
const hits = new Map<Id, HitState>();
let hitTimer: Id = NIL;
let hitTickTarget: Id = NIL;

function setIgnoring(win: Id, on: boolean) {
  if (ignoring.get(win) === on) return;
  ignoring.set(win, on);
  sendBool(win, sel("setIgnoresMouseEvents:"), on);
}

function pollHits() {
  if (hits.size === 0) {
    stopHitTimerIfIdle();
    return;
  }
  if (mouseButtonsDown()) return;
  const cursor = cursorPoint();
  if (!cursor) return;
  for (const [win, state] of hits) {
    const r = fromCocoa(rectOf(win, "frame"));
    const x = Math.floor(cursor.x - r.x);
    const y = Math.floor(cursor.y - r.y);
    const inside = x >= 0 && y >= 0 && x < r.width && y < r.height;
    refineHit(win, state, inside && hitRegions(state.packed, x, y), x, y);
  }
}

function refineHit(win: Id, state: HitState, inPolygon: boolean, x: number, y: number) {
  const entered = inPolygon && !state.inPolygon;
  state.inPolygon = inPolygon;
  if (!inPolygon) {
    setIgnoring(win, true);
    state.asked = undefined;
    return;
  }
  if (!state.refine) {
    setIgnoring(win, false);
    return;
  }
  if (entered) setIgnoring(win, false);
  if (state.asked?.x === x && state.asked?.y === y) return;
  state.asked = { x, y };
  const seq = ++state.askSeq;
  state.refine({ x, y }, (solid) => {
    if (hits.get(win) !== state || seq !== state.askSeq || state.asked === undefined) return;
    if (mouseButtonsDown()) return;
    setIgnoring(win, !solid);
  });
}

function ensureHitTimer() {
  if (hitTimer !== NIL) return;
  if (hitTickTarget === NIL) {
    hitTickTarget = makeTarget("SweetviewHitTimer", { "tick:": () => pollHits() });
  }
  hitTimer = retain(
    asId(sendF64PtrSelPtrBool(cls("NSTimer"), sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"), 0.01, hitTickTarget, sel("tick:"), NIL, true)),
  );
  if (hitTimer === NIL) throw new Error("sweetview: NSTimer for hit regions failed");
}

function stopHitTimerIfIdle() {
  if (hits.size > 0 || hitTimer === NIL) return;
  send(hitTimer, sel("invalidate"));
  release(hitTimer);
  hitTimer = NIL;
}

// ---- frameless drag-resize timer (macOS implementation of startResize) ----------

const resizers = new Map<Id, () => void>();
let resizeTimer: Id = NIL;
let resizeTickTarget: Id = NIL;

function stopResizeTimerIfIdle() {
  if (resizers.size > 0 || resizeTimer === NIL) return;
  send(resizeTimer, sel("invalidate"));
  release(resizeTimer);
  resizeTimer = NIL;
}

function ensureResizeTimer() {
  if (resizeTimer !== NIL) return;
  if (resizeTickTarget === NIL) {
    resizeTickTarget = makeTarget("SweetviewResizeTimer", {
      "tick:": () => {
        for (const fn of [...resizers.values()]) {
          try {
            fn();
          } catch (err) {
            console.error("sweetview: resize gesture threw:", err);
          }
        }
        stopResizeTimerIfIdle();
      },
    });
  }
  resizeTimer = retain(
    asId(sendF64PtrSelPtrBool(cls("NSTimer"), sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"), 0.01, resizeTickTarget, sel("tick:"), NIL, true)),
  );
}

// ---- window construction --------------------------------------------------------

function defaultBounds(): Rect {
  const area = primaryScreen().workArea;
  const width = 320;
  const height = 240;
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

export function createWindow(options: WindowOptions): WindowBackend {
  sharedApp();
  if (options.tabs) return createVirtualTabbedWindow(options);
  const frame = options.frame ?? true;
  const resizable = options.resizable ?? frame;
  const appearance = options.appearance ?? "system";
  const reqBounds = options.bounds ?? defaultBounds();
  const c = toCocoa(reqBounds);

  let styleMask = frame ? NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable : NSWindowStyleMaskBorderless;
  if (frame && resizable) styleMask |= NSWindowStyleMaskResizable;

  const allowKey = !frame && !(options.noActivate ?? false);
  const className = allowKey ? OWNED_KEY_WINDOW_CLASS : OWNED_WINDOW_CLASS;
  ensureWindowSubclass(className, allowKey);

  const win = asId(
    sendRectUIntUIntBool(
      allocRaw(className),
      sel("initWithContentRect:styleMask:backing:defer:"),
      c.x,
      c.y,
      c.w,
      c.h,
      styleMask,
      NSBackingStoreBuffered,
      false,
    ),
  );
  if (win === NIL) throw new Error("sweetview: NSWindow init failed");

  // Keep lifetime explicitly managed by dispose().
  sendBool(win, sel("setReleasedWhenClosed:"), false);
  // Apply exact outer-frame bounds while hidden so initWithContentRect: never grows framed windows.
  sendRectBool(win, sel("setFrame:display:"), c.x, c.y, c.w, c.h, false);

  if (options.minWidth !== undefined || options.minHeight !== undefined) {
    sendSize(win, sel("setMinSize:"), options.minWidth ?? 0, options.minHeight ?? 0);
  }
  if (options.title) sendPtr(win, sel("setTitle:"), nsString(options.title));
  if (frame && appearance !== "system") {
    const name = appearance === "dark" ? "NSAppearanceNameDarkAqua" : "NSAppearanceNameAqua";
    sendPtr(win, sel("setAppearance:"), asId(sendPtr(cls("NSAppearance"), sel("appearanceNamed:"), nsString(name))));
  }

  return buildWindow(win, options, frame, true);
}

/** Virtual tab-group controller Window on macOS (each tab owns its own NSWindow). */
export type DarwinTabGroupController = {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  bounds(): Rect;
  setBounds(rect: Rect): void;
  setTitle(title: string): void;
  minimize(): void;
  toggleMaximize(): void;
  isMaximized(): boolean;
  dispose(): void;
};

const darwinTabControllers = new Map<WindowBackend, DarwinTabGroupController>();
const darwinTabEvents = new Map<WindowBackend, EventBucket>();

export function bindDarwinTabGroup(backend: WindowBackend, controller: DarwinTabGroupController): {
  fireResize(bounds: Rect): void;
  fireMove(bounds: Rect): void;
  fireClose(): boolean;
} {
  darwinTabControllers.set(backend, controller);
  return {
    fireResize(bounds) {
      const b = darwinTabEvents.get(backend);
      if (!b) return;
      for (const fn of [...b.resize]) {
        try {
          fn(bounds);
        } catch (err) {
          console.error("sweetview: onResize handler threw:", err);
        }
      }
    },
    fireMove(bounds) {
      const b = darwinTabEvents.get(backend);
      if (!b) return;
      for (const fn of [...b.move]) {
        try {
          fn(bounds);
        } catch (err) {
          console.error("sweetview: onMove handler threw:", err);
        }
      }
    },
    fireClose() {
      const b = darwinTabEvents.get(backend);
      if (!b || b.close.size === 0) return false;
      for (const fn of [...b.close]) {
        try {
          fn();
        } catch (err) {
          console.error("sweetview: onClose handler threw:", err);
        }
      }
      return true;
    },
  };
}

function createVirtualTabbedWindow(options: WindowOptions): WindowBackend {
  let storedBounds: Rect = options.bounds ?? { x: 100, y: 100, width: 1040, height: 720 };
  let disposed = false;
  const bucket: EventBucket = { resize: new Set(), move: new Set(), close: new Set() };

  const self: WindowBackend = {
    handle: null,
    isVisible: () => !disposed && (darwinTabControllers.get(self)?.isVisible() ?? false),
    show: () => {
      if (!disposed) darwinTabControllers.get(self)?.show();
    },
    hide: () => {
      if (!disposed) darwinTabControllers.get(self)?.hide();
    },
    toggle: () => {
      if (self.isVisible()) self.hide();
      else self.show();
    },
    bounds: () => darwinTabControllers.get(self)?.bounds() ?? storedBounds,
    setBounds: (r) => {
      storedBounds = r;
      if (!disposed) darwinTabControllers.get(self)?.setBounds(r);
    },
    moveTo: (x, y) => {
      const b = self.bounds();
      self.setBounds({ x, y, width: b.width, height: b.height });
    },
    resize: (width, height) => {
      const b = self.bounds();
      self.setBounds({ x: b.x, y: b.y, width, height });
    },
    scale: () => 1,
    setTitle: (title) => {
      if (!disposed) darwinTabControllers.get(self)?.setTitle(title);
    },
    setIcon() {},
    minimize: () => {
      if (!disposed) darwinTabControllers.get(self)?.minimize();
    },
    toggleMaximize: () => {
      if (!disposed) darwinTabControllers.get(self)?.toggleMaximize();
    },
    isMaximized: () => !disposed && (darwinTabControllers.get(self)?.isMaximized() ?? false),
    setTopmost() {},
    startDrag() {},
    startResize() {},
    setClickThrough() {},
    setHitRegions() {},
    onResize(handler) {
      bucket.resize.add(handler);
      return () => bucket.resize.delete(handler);
    },
    onMove(handler) {
      bucket.move.add(handler);
      return () => bucket.move.delete(handler);
    },
    onClose(handler) {
      bucket.close.add(handler);
      return () => bucket.close.delete(handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      darwinTabControllers.get(self)?.dispose();
      darwinTabControllers.delete(self);
      darwinTabEvents.delete(self);
      bucket.resize.clear();
      bucket.move.clear();
      bucket.close.clear();
    },
  };
  darwinTabEvents.set(self, bucket);
  return self;
}

export function fromHandle(handle: WindowHandle): WindowBackend {
  sharedApp();
  const win = asNSWindow(handle);
  const mask = BigInt(sendInt(win, sel("styleMask")) ?? 0);
  const framed = (mask & NSWindowStyleMaskTitled) !== 0n;
  return buildWindow(win, {}, framed, false);
}

function buildWindow(win: Id, options: WindowOptions, framed: boolean, owned: boolean): WindowBackend {
  const transparent = options.transparent ?? false;
  const opacity = options.opacity;
  const topmost = options.topmost ?? false;
  const hideFromTaskbar = options.hideFromTaskbar ?? false;
  const noActivate = options.noActivate ?? false;
  const minW = options.minWidth ?? DEFAULT_MIN_RESIZE.width;
  const minH = options.minHeight ?? DEFAULT_MIN_RESIZE.height;

  if (owned) {
    if (!framed) {
      sendBool(win, sel("setHasShadow:"), false);
    }
    if (transparent) {
      sendBool(win, sel("setOpaque:"), false);
      sendPtr(win, sel("setBackgroundColor:"), asId(send(cls("NSColor"), sel("clearColor"))));
    }
    if (options.colorKey !== undefined) {
      console.warn("sweetview: colorKey is Windows-only; use transparent on macOS");
    }
    if (opacity !== undefined) {
      sendF64Void(win, sel("setAlphaValue:"), Math.min(1, Math.max(0, opacity)));
    }
    if (topmost) {
      sendIntArg(win, sel("setLevel:"), NSStatusWindowLevel);
    }
    if (!framed || topmost || hideFromTaskbar) {
      let behavior = 0n;
      if (!framed || topmost) {
        behavior |= NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorFullScreenAuxiliary;
      }
      if (hideFromTaskbar) {
        behavior |= NSWindowCollectionBehaviorIgnoresCycle;
        sendIntArg(sharedApp(), sel("setActivationPolicy:"), NSApplicationActivationPolicyAccessory);
      }
      if (behavior !== 0n) sendUIntArg(win, sel("setCollectionBehavior:"), behavior);
    }
  }

  let disposed = false;

  const self: WindowBackend = {
    handle: win,

    isVisible() {
      return !disposed && Boolean(sendRetBool(win, sel("isVisible")));
    },

    show() {
      if (disposed) return;
      if (noActivate) {
        send(win, sel("orderFrontRegardless"));
      } else {
        sendPtr(win, sel("makeKeyAndOrderFront:"), NIL);
        sendBool(sharedApp(), sel("activateIgnoringOtherApps:"), true);
      }
    },

    hide() {
      if (disposed) return;
      sendPtr(win, sel("orderOut:"), NIL);
    },

    toggle() {
      if (self.isVisible()) self.hide();
      else self.show();
    },

    bounds() {
      return fromCocoa(rectOf(win, "frame"));
    },

    setBounds(r) {
      if (disposed) return;
      const c = toCocoa(r);
      sendRectBool(win, sel("setFrame:display:"), c.x, c.y, c.w, c.h, true);
    },

    moveTo(x, y) {
      if (disposed) return;
      const { height } = self.bounds();
      sendPoint(win, sel("setFrameOrigin:"), x, primaryHeight() - (y + height));
    },

    resize(width, height) {
      if (disposed) return;
      const { x, y } = self.bounds();
      self.setBounds({ x, y, width, height });
    },

    scale() {
      return 1;
    },

    setTitle(title) {
      if (disposed) return;
      sendPtr(win, sel("setTitle:"), nsString(title));
    },

    setIcon() {
      // Cocoa windows have no per-window icon; setAppIcon controls the Dock icon.
    },

    minimize() {
      if (disposed) return;
      sendPtr(win, sel("miniaturize:"), NIL);
    },

    toggleMaximize() {
      if (disposed) return;
      sendPtr(win, sel("zoom:"), NIL);
    },

    isMaximized() {
      if (disposed) return false;
      return Boolean(sendRetBool(win, sel("isZoomed")));
    },

    setTopmost(on) {
      if (disposed) return;
      sendIntArg(win, sel("setLevel:"), on ? NSStatusWindowLevel : NSNormalWindowLevel);
    },

    startDrag() {
      if (disposed) return;
      const event = asId(send(sharedApp(), sel("currentEvent")));
      if (event !== NIL) sendPtr(win, sel("performWindowDragWithEvent:"), event);
    },

    startResize(edge: ResizeEdge) {
      if (disposed) return;
      const startCursor = cursorPoint();
      if (!startCursor) return;
      const from = self.bounds();
      resizers.set(win, () => {
        if (disposed || !mouseButtonsDown()) {
          resizers.delete(win);
          return;
        }
        const curPt = cursorPoint();
        if (!curPt) return;
        const dx = curPt.x - startCursor.x;
        const dy = curPt.y - startCursor.y;
        let { x, y, width, height } = from;
        if (edge.includes("left")) {
          width = Math.max(minW, from.width - dx);
          x = from.x + from.width - width;
        }
        if (edge.includes("right")) width = Math.max(minW, from.width + dx);
        if (edge.includes("top")) {
          height = Math.max(minH, from.height - dy);
          y = from.y + from.height - height;
        }
        if (edge.includes("bottom")) height = Math.max(minH, from.height + dy);
        const cur = self.bounds();
        if (x !== cur.x || y !== cur.y || width !== cur.width || height !== cur.height) {
          self.setBounds({ x, y, width, height });
        }
      });
      ensureResizeTimer();
    },

    setClickThrough(on) {
      if (disposed) return;
      hits.delete(win);
      stopHitTimerIfIdle();
      setIgnoring(win, on);
    },

    setHitRegions(polygons, refine) {
      if (disposed) return;
      if (polygons === null) {
        hits.delete(win);
        stopHitTimerIfIdle();
        setIgnoring(win, false);
        return;
      }
      const previous = hits.get(win);
      hits.set(win, { packed: packRegions(polygons), refine, inPolygon: previous?.inPolygon ?? false, askSeq: previous?.askSeq ?? 0 });
      ensureHitTimer();
      pollHits();
    },

    onResize(handler) {
      ensureObserved(win);
      const b = bucketFor(win);
      b.resize.add(handler);
      return () => {
        b.resize.delete(handler);
        if (b.resize.size === 0 && b.move.size === 0) removeObserved(win);
      };
    },

    onMove(handler) {
      ensureObserved(win);
      const b = bucketFor(win);
      b.move.add(handler);
      return () => {
        b.move.delete(handler);
        if (b.resize.size === 0 && b.move.size === 0) removeObserved(win);
      };
    },

    onClose(handler) {
      const b = bucketFor(win);
      if (!owned && b.close.size === 0) {
        // Fallback for externally-created NSWindows whose class we do not own.
        const button = asId(sendUIntRetPtr(win, sel("standardWindowButton:"), NSWindowCloseButton));
        if (button !== NIL) {
          sendPtr(button, sel("setTarget:"), externalCloseTarget());
          sendPtr(button, sel("setAction:"), sel("closeRequested:"));
        }
      }
      b.close.add(handler);
      return () => {
        b.close.delete(handler);
        if (!owned && b.close.size === 0) {
          const button = asId(sendUIntRetPtr(win, sel("standardWindowButton:"), NSWindowCloseButton));
          if (button !== NIL) {
            sendPtr(button, sel("setTarget:"), NIL);
            sendPtr(button, sel("setAction:"), sel("performClose:"));
          }
        }
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      removeObserved(win);
      hits.delete(win);
      stopHitTimerIfIdle();
      resizers.delete(win);
      stopResizeTimerIfIdle();
      ignoring.delete(win);
      const b = eventsByWin.get(win);
      if (!owned && b && b.close.size > 0) {
        const button = asId(sendUIntRetPtr(win, sel("standardWindowButton:"), NSWindowCloseButton));
        if (button !== NIL) {
          sendPtr(button, sel("setTarget:"), NIL);
          sendPtr(button, sel("setAction:"), sel("performClose:"));
        }
      }
      eventsByWin.delete(win);
      disposeByWin.delete(win);
      if (owned) {
        sendPtr(win, sel("orderOut:"), NIL);
        send(win, sel("close"));
        release(win);
      }
    },
  };

  if (owned) disposeByWin.set(win, () => self.dispose());
  return self;
}
