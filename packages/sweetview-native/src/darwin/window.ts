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
  jsString,
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
  sendIntRetBool,
  sendIntArg,
  sendPoint,
  sendPtr,
  sendPtrPtrPtrVoid,
  sendPtrSelPtrPtrVoid,
  sendRectBool,
  sendRectUIntUIntBool,
  sendRetBool,
  sendSize,
  sendSuperPtr,
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
  fileDrop: Set<(paths: string[]) => void>;
};

const eventsByWin = new Map<Id, EventBucket>();
const disposeByWin = new Map<Id, () => void>();
const ignoring = new Map<Id, boolean>();

function bucketFor(win: Id): EventBucket {
  let b = eventsByWin.get(win);
  if (!b) {
    b = { resize: new Set(), move: new Set(), close: new Set(), fileDrop: new Set() };
    eventsByWin.set(win, b);
  }
  return b;
}

const fileUrlType = () => nsString("public.file-url");

function deliverFileDrop(listeners: Set<(paths: string[]) => void>, paths: string[]): void {
  for (const handler of [...listeners]) {
    try {
      handler(paths);
    } catch (err) {
      console.error("sweetview: onFileDrop handler threw:", err);
    }
  }
}

function performFileDrop(win: Id, sender: Id): boolean {
  const listeners = eventsByWin.get(win)?.fileDrop;
  if (!listeners?.size) return false;
  const pasteboard = asId(send(sender, sel("draggingPasteboard")));
  const items = asId(send(pasteboard, sel("pasteboardItems")));
  const count = asId(send(items, sel("count")));
  const type = fileUrlType();
  const paths: string[] = [];
  for (let index = 0n; index < count; index++) {
    const item = asId(sendUIntRetPtr(items, sel("objectAtIndex:"), index));
    const urlString = asId(sendPtr(item, sel("stringForType:"), type));
    if (urlString === NIL) continue;
    const url = asId(sendPtr(cls("NSURL"), sel("URLWithString:"), urlString));
    if (!sendRetBool(url, sel("isFileURL"))) continue;
    const fileUrl = asId(send(url, sel("filePathURL")));
    const path = jsString(asId(send(fileUrl, sel("path"))));
    if (path) paths.push(path);
  }
  if (paths.length === 0) return false;
  deliverFileDrop(listeners, paths);
  return true;
}

export function subscribeDarwinFileDrop(win: Id, handler: (paths: string[]) => void): () => void {
  const b = bucketFor(win);
  if (b.fileDrop.size === 0) {
    const types = asId(sendPtr(cls("NSArray"), sel("arrayWithObject:"), fileUrlType()));
    sendPtr(win, sel("registerForDraggedTypes:"), types);
  }
  const listener = (paths: string[]) => handler(paths);
  b.fileDrop.add(listener);
  return () => {
    if (!b.fileDrop.delete(listener) || b.fileDrop.size > 0 || eventsByWin.get(win) !== b) return;
    send(win, sel("unregisterDraggedTypes"));
    if (b.resize.size === 0 && b.move.size === 0 && b.close.size === 0) eventsByWin.delete(win);
  };
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
const TAB_WINDOW_CLASS = "SweetviewTabWindow";
const tabCloseRequests = new Map<Id, () => boolean>();

export function setDarwinTabCloseRequest(win: Id, request: (() => boolean) | undefined): void {
  if (request) tabCloseRequests.set(win, request);
  else tabCloseRequests.delete(win);
}

function ensureWindowSubclass(className: string, allowKeyWhenBorderless: boolean): Id {
  const existing = asId(objc_getClass(cstr(className)));
  if (existing !== NIL) return existing;
  const superclass = cls("NSWindow");
  const klass = asId(objc_allocateClassPair(superclass, cstr(className), 0n));
  if (klass === NIL) throw new Error(`sweetview: objc_allocateClassPair(${className}) failed`);

  const performCloseCb = new JSCallback(
    (selfWin: bigint, selector: bigint, sender: bigint) => {
      try {
        if (className === TAB_WINDOW_CLASS) {
          if (!tabCloseRequests.get(selfWin)?.()) sendSuperPtr(selfWin, superclass, selector, sender);
        } else {
          if (fireClose(selfWin)) return;
          const onDispose = disposeByWin.get(selfWin);
          if (onDispose) onDispose();
          else send(selfWin, sel("close"));
        }
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

  const enter = new JSCallback(
    (win: bigint) => eventsByWin.get(win)?.fileDrop.size ? 1n : 0n,
    { args: [ID, ID, ID], returns: FFIType.u64 },
  );
  const drop = new JSCallback(
    (win: bigint, _cmd: bigint, sender: bigint) => {
      try {
        return performFileDrop(win, sender);
      } catch (err) {
        console.error("sweetview: could not read dropped files:", err);
        return false;
      }
    },
    { args: [ID, ID, ID], returns: FFIType.bool },
  );
  const prepare = new JSCallback(
    (win: bigint) => Boolean(eventsByWin.get(win)?.fileDrop.size),
    { args: [ID, ID, ID], returns: FFIType.bool },
  );
  retainCallback(enter);
  retainCallback(drop);
  retainCallback(prepare);
  if (!class_addMethod(klass, sel("draggingEntered:"), enter.ptr, cstr("Q@:@"))
    || !class_addMethod(klass, sel("draggingUpdated:"), enter.ptr, cstr("Q@:@"))
    || !class_addMethod(klass, sel("prepareForDragOperation:"), prepare.ptr, cstr("B@:@"))
    || !class_addMethod(klass, sel("performDragOperation:"), drop.ptr, cstr("B@:@"))) {
    throw new Error(`sweetview: could not install drag methods on ${className}`);
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
  return klass;
}

export function darwinTabWindowClass(): Id {
  return ensureWindowSubclass(TAB_WINDOW_CLASS, false);
}

// ---- hit-region polling timer (invalidated when hits.size === 0) ----------------

const pressedMouseButtons = (): bigint => BigInt(sendInt(cls("NSEvent"), sel("pressedMouseButtons")) ?? 0);
/** Any mouse button held (hit polling pauses during any drag, like Windows' L/R/M check). */
const mouseButtonsDown = (): boolean => pressedMouseButtons() !== 0n;
/** Primary (left) button held: bit 0 of `+[NSEvent pressedMouseButtons]`, matching Windows `VK_LBUTTON`. */
const primaryMouseButtonDown = (): boolean => (pressedMouseButtons() & 1n) !== 0n;

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

/**
 * Starts a cursor-following resize of `win` from `edge`, shared by regular
 * windows and macOS tab-group windows. A 10ms NSTimer tracks the cursor while
 * the primary (left) mouse button stays down, clamping to `minW` x `minH`
 * outer points, and stops when the button is released or `isDisposed()`
 * returns true. A new gesture on the same window replaces the previous one.
 */
export function startDarwinWindowResize(
  win: Id,
  edge: ResizeEdge,
  minW: number,
  minH: number,
  getBounds: () => Rect,
  setBounds: (rect: Rect) => void,
  isDisposed: () => boolean,
): void {
  if (isDisposed() || !primaryMouseButtonDown()) return;
  const startCursor = cursorPoint();
  if (!startCursor) return;
  const from = getBounds();
  const tick = () => {
    if (isDisposed() || !primaryMouseButtonDown()) {
      if (resizers.get(win) === tick) resizers.delete(win);
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
    const cur = getBounds();
    if (x !== cur.x || y !== cur.y || width !== cur.width || height !== cur.height) {
      setBounds({ x, y, width, height });
    }
  };
  resizers.set(win, tick);
  ensureResizeTimer();
}

/**
 * Starts an OS-driven move of `win` that follows the cursor, shared by regular
 * windows and macOS tab-group windows. Does nothing unless the primary (left)
 * mouse button is down, like `startDarwinWindowResize` and Windows'
 * `VK_LBUTTON` check: the window server moves a window only while that button
 * is held, and asked without it AppKit logs "Window move completed without
 * beginning".
 */
export function startDarwinWindowDrag(win: Id): void {
  if (!primaryMouseButtonDown()) return;
  const event = asId(send(sharedApp(), sel("currentEvent")));
  if (event !== NIL) sendPtr(win, sel("performWindowDragWithEvent:"), event);
}

/** Cancels an in-progress `startDarwinWindowResize` gesture on `win`, if any. */
export function stopDarwinWindowResize(win: Id): void {
  if (!resizers.delete(win)) return;
  stopResizeTimerIfIdle();
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
  isMinimized(): boolean;
  dispose(): void;
  setFileDropEnabled(enabled: boolean): void;
  /** Sets the window level of every tab NSWindow in the group. */
  setTopmost?(on: boolean): void;
  /** Starts a native drag of the active tab NSWindow from the current event. */
  startDrag?(): void;
  /** Starts a cursor-following resize of the active tab NSWindow (see `startDarwinWindowResize`). */
  startResize?(edge: ResizeEdge): void;
  /** The active tab's `NSWindow*`, or null while the group has no shown tab window. */
  activeHandle?(): Id | null;
};

/** State a virtual tabbed window records before a controller is bound, replayed on bind. */
type VirtualTabState = {
  disposed: boolean;
  /** Set by show()/hide()/toggle() before bind; undefined when neither was called. */
  pendingVisible: boolean | undefined;
  bounds: Rect;
  /** True once setBounds/moveTo/resize stored bounds before bind. */
  boundsChanged: boolean;
  title: string;
  topmost: boolean;
};

const darwinTabControllers = new Map<WindowBackend, DarwinTabGroupController>();
const darwinTabEvents = new Map<WindowBackend, EventBucket>();
const darwinTabStates = new Map<WindowBackend, VirtualTabState>();

/** The active tab `NSWindow*` of a macOS virtual tabbed window, or null when none exists yet (or `backend` is not one). */
export function getDarwinTabActiveHandle(backend: WindowBackend): Id | null {
  const handle = darwinTabControllers.get(backend)?.activeHandle?.() ?? null;
  return handle === NIL ? null : handle;
}

/**
 * Binds the platform tab driver's controller to a virtual tabbed window.
 * File-drop demand is synced synchronously. Other state set before binding
 * (`setTopmost`, `setTitle`, `setBounds`/`moveTo`/`resize`, and the latest
 * `show()`/`hide()`) is applied by the returned `replay()`, which the caller
 * runs synchronously once it has finished initialising the controller. Runs
 * after the first, or after the window is disposed, do nothing.
 */
export function bindDarwinTabGroup(backend: WindowBackend, controller: DarwinTabGroupController): {
  fireResize(bounds: Rect): void;
  fireMove(bounds: Rect): void;
  fireClose(): boolean;
  fireFileDrop(paths: string[]): void;
  replay(): void;
} {
  darwinTabControllers.set(backend, controller);
  if (darwinTabEvents.get(backend)?.fileDrop.size) controller.setFileDropEnabled(true);
  const state = darwinTabStates.get(backend);
  let replayed = false;
  return {
    replay() {
      if (replayed) return;
      replayed = true;
      if (!state || state.disposed || darwinTabControllers.get(backend) !== controller) return;
      const visible = state.pendingVisible;
      state.pendingVisible = undefined;
      try {
        if (state.topmost) controller.setTopmost?.(true);
        if (state.title) controller.setTitle(state.title);
        if (state.boundsChanged) controller.setBounds(state.bounds);
        if (visible === true) controller.show();
      } catch (err) {
        console.error("sweetview: replaying tabbed window state threw:", err);
      }
    },
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
    fireFileDrop(paths) {
      const listeners = darwinTabEvents.get(backend)?.fileDrop;
      if (listeners) deliverFileDrop(listeners, paths);
    },
  };
}

function createVirtualTabbedWindow(options: WindowOptions): WindowBackend {
  const state: VirtualTabState = {
    disposed: false,
    pendingVisible: undefined,
    bounds: options.bounds ?? { x: 100, y: 100, width: 1040, height: 720 },
    boundsChanged: false,
    title: options.title ?? "",
    topmost: options.topmost ?? false,
  };
  const bucket: EventBucket = { resize: new Set(), move: new Set(), close: new Set(), fileDrop: new Set() };
  const controller = () => (state.disposed ? undefined : darwinTabControllers.get(self));

  const self: WindowBackend = {
    handle: null,
    isVisible: () => controller()?.isVisible() ?? false,
    // The latest show()/hide() is always recorded, so a bind's replay applies the newest request.
    show: () => {
      if (state.disposed) return;
      state.pendingVisible = true;
      controller()?.show();
    },
    hide: () => {
      if (state.disposed) return;
      state.pendingVisible = false;
      controller()?.hide();
    },
    toggle: () => {
      if (state.disposed) return;
      const visible = controller() ? self.isVisible() : state.pendingVisible === true;
      if (visible) self.hide();
      else self.show();
    },
    bounds: () => controller()?.bounds() ?? state.bounds,
    setBounds: (r) => {
      if (state.disposed) return;
      state.bounds = r;
      const c = controller();
      if (c) c.setBounds(r);
      else state.boundsChanged = true;
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
      if (state.disposed) return;
      state.title = title;
      controller()?.setTitle(title);
    },
    setIcon() {},
    minimize: () => controller()?.minimize(),
    toggleMaximize: () => controller()?.toggleMaximize(),
    isMaximized: () => controller()?.isMaximized() ?? false,
    isMinimized: () => controller()?.isMinimized() ?? false,
    setTopmost: (on) => {
      if (state.disposed) return;
      state.topmost = on;
      controller()?.setTopmost?.(on);
    },
    startDrag: () => controller()?.startDrag?.(),
    startResize: (edge) => controller()?.startResize?.(edge),
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
    onFileDrop(handler) {
      const listener = (paths: string[]) => handler(paths);
      bucket.fileDrop.add(listener);
      if (bucket.fileDrop.size === 1) controller()?.setFileDropEnabled(true);
      return () => {
        if (bucket.fileDrop.delete(listener) && bucket.fileDrop.size === 0) controller()?.setFileDropEnabled(false);
      };
    },
    dispose() {
      if (state.disposed) return;
      const c = darwinTabControllers.get(self);
      state.disposed = true;
      c?.dispose();
      darwinTabControllers.delete(self);
      darwinTabEvents.delete(self);
      darwinTabStates.delete(self);
      bucket.resize.clear();
      bucket.move.clear();
      bucket.close.clear();
      bucket.fileDrop.clear();
    },
  };
  darwinTabEvents.set(self, bucket);
  darwinTabStates.set(self, state);
  return self;
}

export function fromHandle(handle: WindowHandle): WindowBackend {
  sharedApp();
  const win = asNSWindow(handle);
  const mask = BigInt(sendInt(win, sel("styleMask")) ?? 0);
  const framed = (mask & NSWindowStyleMaskTitled) !== 0n;
  const resizable = (mask & NSWindowStyleMaskResizable) !== 0n;
  return buildWindow(win, {}, framed, false, { frame: framed, resizable });
}

function buildWindow(win: Id, options: WindowOptions, framed: boolean, owned: boolean, detectedMeta?: WindowBackend["detectedMeta"]): WindowBackend {
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
  let hidden = false;
  const localUnsubs = new Set<() => void>();
  let ownsHitState = false;

  const self: WindowBackend = {
    handle: win,
    detectedMeta,

    isVisible() {
      return !disposed && (Boolean(sendRetBool(win, sel("isVisible"))) || (!hidden && Boolean(sendRetBool(win, sel("isMiniaturized")))));
    },

    show() {
      if (disposed) return;
      hidden = false;
      if (noActivate) {
        send(win, sel("orderFrontRegardless"));
      } else {
        sendPtr(win, sel("makeKeyAndOrderFront:"), NIL);
        sendBool(sharedApp(), sel("activateIgnoringOtherApps:"), true);
      }
    },

    hide() {
      if (disposed) return;
      hidden = true;
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

    isMinimized() {
      if (disposed) return false;
      return Boolean(sendRetBool(win, sel("isMiniaturized")));
    },

    setTopmost(on) {
      if (disposed) return;
      sendIntArg(win, sel("setLevel:"), on ? NSStatusWindowLevel : NSNormalWindowLevel);
    },

    startDrag() {
      if (disposed) return;
      startDarwinWindowDrag(win);
    },

    startResize(edge: ResizeEdge) {
      startDarwinWindowResize(win, edge, minW, minH, self.bounds, self.setBounds, () => disposed);
    },

    setClickThrough(on) {
      if (disposed) return;
      ownsHitState = false;
      hits.delete(win);
      stopHitTimerIfIdle();
      setIgnoring(win, on);
    },

    setHitRegions(polygons, refine) {
      if (disposed) return;
      if (polygons === null) {
        ownsHitState = false;
        hits.delete(win);
        stopHitTimerIfIdle();
        setIgnoring(win, false);
        return;
      }
      ownsHitState = true;
      const previous = hits.get(win);
      hits.set(win, { packed: packRegions(polygons), refine, inPolygon: previous?.inPolygon ?? false, askSeq: previous?.askSeq ?? 0 });
      ensureHitTimer();
      pollHits();
    },

    onResize(handler) {
      ensureObserved(win);
      const b = bucketFor(win);
      b.resize.add(handler);
      const unsub = () => {
        localUnsubs.delete(unsub);
        b.resize.delete(handler);
        if (b.resize.size === 0 && b.move.size === 0) removeObserved(win);
      };
      localUnsubs.add(unsub);
      return unsub;
    },

    onMove(handler) {
      ensureObserved(win);
      const b = bucketFor(win);
      b.move.add(handler);
      const unsub = () => {
        localUnsubs.delete(unsub);
        b.move.delete(handler);
        if (b.resize.size === 0 && b.move.size === 0) removeObserved(win);
      };
      localUnsubs.add(unsub);
      return unsub;
    },

    onClose(handler) {
      const b = bucketFor(win);
      const isExternal = !owned && !disposeByWin.has(win);
      if (isExternal && b.close.size === 0) {
        // Fallback for externally-created NSWindows whose class we do not own.
        const button = asId(sendUIntRetPtr(win, sel("standardWindowButton:"), NSWindowCloseButton));
        if (button !== NIL) {
          sendPtr(button, sel("setTarget:"), externalCloseTarget());
          sendPtr(button, sel("setAction:"), sel("closeRequested:"));
        }
      }
      b.close.add(handler);
      const unsub = () => {
        localUnsubs.delete(unsub);
        b.close.delete(handler);
        if (isExternal && b.close.size === 0) {
          const button = asId(sendUIntRetPtr(win, sel("standardWindowButton:"), NSWindowCloseButton));
          if (button !== NIL) {
            sendPtr(button, sel("setTarget:"), NIL);
            sendPtr(button, sel("setAction:"), sel("performClose:"));
          }
        }
      };
      localUnsubs.add(unsub);
      return unsub;
    },

    onFileDrop(handler) {
      const canDrop = [OWNED_WINDOW_CLASS, OWNED_KEY_WINDOW_CLASS, TAB_WINDOW_CLASS].some((name) => {
        const klass = asId(objc_getClass(cstr(name)));
        return klass !== NIL && sendIntRetBool(win, sel("isKindOfClass:"), klass);
      });
      if (!canDrop) {
        throw new Error("sweetview: file drops require a Sweetview-managed NSWindow");
      }
      const unsubscribe = subscribeDarwinFileDrop(win, handler);
      const unsub = () => {
        if (localUnsubs.delete(unsub)) unsubscribe();
      };
      localUnsubs.add(unsub);
      return unsub;
    },

    setOwnerDispose(fn) {
      if (owned) disposeByWin.set(win, fn);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsub of [...localUnsubs]) unsub();
      localUnsubs.clear();
      if (!owned) {
        if (ownsHitState) {
          ownsHitState = false;
          hits.delete(win);
          stopHitTimerIfIdle();
        }
        return;
      }
      removeObserved(win);
      hits.delete(win);
      stopHitTimerIfIdle();
      resizers.delete(win);
      stopResizeTimerIfIdle();
      ignoring.delete(win);
      const fileDrop = eventsByWin.get(win)?.fileDrop;
      if (fileDrop?.size) {
        send(win, sel("unregisterDraggedTypes"));
        fileDrop.clear();
      }
      eventsByWin.delete(win);
      disposeByWin.delete(win);
      sendPtr(win, sel("orderOut:"), NIL);
      send(win, sel("close"));
      release(win);
    },
  };

  if (owned) disposeByWin.set(win, () => self.dispose());
  return self;
}
