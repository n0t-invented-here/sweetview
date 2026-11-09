// Overlay on macOS: a borderless NSWindow that is not opaque with a clear
// background, above the Dock (status window level), on every Space. Units are points (what
// the page sees as CSS pixels), with the origin at the top-left of the
// primary screen like the Win32 side; Cocoa's bottom-left origin is converted
// here.
//
// Click-through by hit regions. AppKit hit-tests a borderless window by its
// alpha only as long as ignoresMouseEvents was never set, and macOS 26.3
// broke even that, so it is done the way Electron, tao and Cap do it: a
// main-thread NSTimer tests the cursor against the rectangles the page sent
// and toggles ignoresMouseEvents. While a mouse button is down nothing
// changes, so a drag survives leaving the rectangles. The cursor comes from
// +[NSEvent mouseLocation] through an NSInvocation (a struct return, which
// bun:ffi cannot receive directly); the webview library reads struct returns
// the same way.

import { hitRegions, packRegions } from "../hit-regions";
import type { HitRefiner, Overlay, OverlayOptions, OverlayWindowOptions, Point, Rect } from "../overlay";
import type { WindowHandle } from "../window";
import {
  NIL,
  allocRaw,
  asId,
  cls,
  defineYesClass,
  makeTarget,
  nsString,
  send,
  sendBool,
  sendBytesLen,
  sendF64PtrSelPtrBool,
  sendF64Void,
  sendInt,
  sendIntArg,
  sendPoint,
  sendPtr,
  sendPtrArg,
  sendRectBool,
  sendRectUIntUIntBool,
  sendUIntArg,
  sendUIntRetPtr,
  sel,
  sharedApp,
  type Id,
} from "./objc";
import { asNSWindow } from "./window";

const NSWindowStyleMaskBorderless = 0n;
const NSWindowStyleMaskTitled = 1n;
const NSWindowStyleMaskClosable = 2n;
const NSWindowStyleMaskMiniaturizable = 4n;
const NSWindowStyleMaskResizable = 8n;
const NSBackingStoreBuffered = 2n;
const NSNormalWindowLevel = 0n;
// Above the Dock (level 20), so an overlay along the bottom of the screen is not hidden behind it.
const NSStatusWindowLevel = 25n;
const NSWindowCollectionBehaviorCanJoinAllSpaces = 1n << 0n;
const NSWindowCollectionBehaviorStationary = 1n << 4n;
const NSWindowCollectionBehaviorIgnoresCycle = 1n << 6n;
const NSWindowCollectionBehaviorFullScreenAuxiliary = 1n << 8n;
const NSApplicationActivationPolicyAccessory = 1n;

// ---- rects out of Cocoa without struct returns -------------------------------

type CocoaRect = { x: number; y: number; w: number; h: number };
const rectBuf = new Float64Array(4);

/** `[obj valueForKey:key]` boxes a struct-returning property into an NSValue; `getValue:size:` copies it out. */
function rectOf(obj: Id, key: string): CocoaRect {
  const value = asId(sendPtr(obj, sel("valueForKey:"), nsString(key)));
  if (value === NIL) throw new Error(`sweetnative: ${key} unavailable`);
  rectBuf.fill(0);
  sendBytesLen(value, sel("getValue:size:"), rectBuf, 32n);
  return { x: rectBuf[0]!, y: rectBuf[1]!, w: rectBuf[2]!, h: rectBuf[3]! };
}

const primaryScreen = (): Id => asId(sendUIntRetPtr(asId(send(cls("NSScreen"), sel("screens"))), sel("objectAtIndex:"), 0n));
const primaryHeight = (): number => rectOf(primaryScreen(), "frame").h;

/**
 * Cursor in our coordinates. +[NSEvent mouseLocation] returns an NSPoint by
 * value, which bun:ffi cannot receive, so the call goes through an
 * NSInvocation and the result is copied out with getReturnValue:.
 */
const pointBuf = new Float64Array(2);
let cursorInvocation: Id = NIL;
let warnedNoCursor = false;
function cursorPoint(): Point | null {
  if (cursorInvocation === NIL) {
    const eventClass = cls("NSEvent");
    const selector = sel("mouseLocation");
    const signature = asId(sendPtr(eventClass, sel("methodSignatureForSelector:"), selector));
    const invocation = signature === NIL ? NIL : asId(sendPtr(cls("NSInvocation"), sel("invocationWithMethodSignature:"), signature));
    if (invocation === NIL) {
      if (!warnedNoCursor) console.error("sweetnative: cannot build the NSInvocation for +[NSEvent mouseLocation]; hit regions will not work");
      warnedNoCursor = true;
      return null;
    }
    sendPtr(invocation, sel("setSelector:"), selector);
    sendPtr(invocation, sel("setTarget:"), eventClass);
    send(invocation, sel("retain")); // the invocation is autoreleased; keep it for the process
    cursorInvocation = invocation;
  }
  send(cursorInvocation, sel("invoke"));
  pointBuf.fill(0);
  sendPtrArg(cursorInvocation, sel("getReturnValue:"), pointBuf);
  return { x: pointBuf[0]!, y: primaryHeight() - pointBuf[1]! };
}

const mouseButtonsDown = (): boolean => BigInt(sendInt(cls("NSEvent"), sel("pressedMouseButtons")) ?? 0) !== 0n;

// ---- hit regions: the click-through poll ----------------------------------------

type HitState = { packed: Int32Array; refine?: HitRefiner; inPolygon: boolean; asked?: Point; askSeq: number };
const hits = new Map<Id, HitState>(); // window -> regions, while set
const ignoring = new Map<Id, boolean>();
let timer: Id = NIL;
let tickTarget: Id = NIL;

function setIgnoring(win: Id, on: boolean) {
  if (ignoring.get(win) === on) return;
  ignoring.set(win, on);
  sendBool(win, sel("setIgnoresMouseEvents:"), on);
}

function pollHits() {
  if (hits.size === 0) return;
  if (mouseButtonsDown()) return; // never flip mid-click or mid-drag
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

/** The polygon answer, then the refiner's if there is one and the cursor is inside a polygon. */
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
  if (entered) setIgnoring(win, false); // take clicks until the exact answer arrives; a polygon update alone keeps the last answer
  if (state.asked?.x === x && state.asked?.y === y) return;
  state.asked = { x, y };
  const seq = ++state.askSeq;
  state.refine({ x, y }, (solid) => {
    if (hits.get(win) !== state || seq !== state.askSeq || state.asked === undefined) return; // moved on, or the regions were replaced or cleared
    if (mouseButtonsDown()) return; // never flip mid-click or mid-drag; the next tick applies the answer
    setIgnoring(win, !solid);
  });
}

function ensureTimer() {
  if (timer !== NIL) return;
  tickTarget = makeTarget("SweetnativeOverlayHitTimer", { "tick:": () => pollHits() });
  // Runs on the main run loop, which is the one webview.run() spins.
  timer = asId(sendF64PtrSelPtrBool(cls("NSTimer"), sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"), 0.01, tickTarget, sel("tick:"), NIL, true));
  if (timer === NIL) throw new Error("sweetnative: NSTimer for the hit regions failed");
}

/** Cocoa (bottom-left origin) -> ours (top-left origin). */
const fromCocoa = (r: CocoaRect): Rect => ({ x: r.x, y: primaryHeight() - (r.y + r.h), width: r.w, height: r.h });
/** Ours -> Cocoa. */
const toCocoa = (r: Rect): CocoaRect => ({ x: r.x, y: primaryHeight() - (r.y + r.height), w: r.width, h: r.height });

// ---- our own overlay window ---------------------------------------------------

function defaultBounds(): Rect {
  const area = fromCocoa(rectOf(primaryScreen(), "visibleFrame"));
  const width = 320;
  const height = 240;
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
}

export function createOverlayWindow(options: OverlayWindowOptions): Overlay {
  sharedApp(); // NSApp must exist before any window
  const b = toCocoa(options.bounds ?? defaultBounds());
  const framed = options.frame === true;
  const styleMask = framed ? NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable : NSWindowStyleMaskBorderless;
  // A borderless NSWindow answers NO to canBecomeKeyWindow, so a frameless
  // window that draws its own chrome (noActivate: false) would never take
  // keyboard input: its text fields could be clicked but not typed into. That
  // one gets a subclass that says YES.
  const activatable = !framed && options.noActivate === false;
  if (activatable) defineYesClass("NSWindow", KEY_WINDOW_CLASS, ["canBecomeKeyWindow", "canBecomeMainWindow"]);
  const win = asId(sendRectUIntUIntBool(allocRaw(activatable ? KEY_WINDOW_CLASS : "NSWindow"), sel("initWithContentRect:styleMask:backing:defer:"), b.x, b.y, b.w, b.h, styleMask, NSBackingStoreBuffered, false));
  if (win === NIL) throw new Error("sweetnative: NSWindow init failed");
  sendBool(win, sel("setReleasedWhenClosed:"), false); // the close button only orders the window out
  if (options.title) sendPtr(win, sel("setTitle:"), nsString(options.title));
  if (framed && options.dark) {
    sendPtr(win, sel("setAppearance:"), asId(sendPtr(cls("NSAppearance"), sel("appearanceNamed:"), nsString("NSAppearanceNameDarkAqua"))));
  }
  return restyle(win, options, framed);
}

// ---- restyling ---------------------------------------------------------------

export function makeOverlay(handle: WindowHandle, options: OverlayOptions): Overlay {
  return restyle(asNSWindow(handle), options, false);
}

const KEY_WINDOW_CLASS = "SweetnativeKeyWindow";

/** The Overlay object for a window; `framed` leaves a normal window's styles alone (see OverlayWindowOptions.frame). */
function restyle(win: Id, options: OverlayOptions, framed: boolean): Overlay {
  // noActivate (the default) needs nothing here: a borderless NSWindow never becomes key, so clicks do not steal focus.
  // noActivate: false is honoured only by createOverlayWindow, which makes the window of a class that can become key; here it decides how show() brings it up.
  const { transparent = false, colorKey, opacity, topmost = true, hideFromTaskbar = true, noActivate = true } = options;

  if (!framed) {
    sendUIntArg(win, sel("setStyleMask:"), NSWindowStyleMaskBorderless);
    sendBool(win, sel("setHasShadow:"), false);
    if (transparent) {
      sendBool(win, sel("setOpaque:"), false);
      sendPtr(win, sel("setBackgroundColor:"), asId(send(cls("NSColor"), sel("clearColor"))));
    }
    if (colorKey !== undefined) console.warn("sweetnative: colorKey is Windows-only; use transparent on macOS");
    if (opacity !== undefined) sendF64Void(win, sel("setAlphaValue:"), Math.min(1, Math.max(0, opacity)));
    sendIntArg(win, sel("setLevel:"), topmost ? NSStatusWindowLevel : NSNormalWindowLevel);
    sendUIntArg(
      win,
      sel("setCollectionBehavior:"),
      NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorFullScreenAuxiliary,
    );
    // No Dock icon or app switcher entry: an accessory app. The menu bar item (tray) still works.
    if (hideFromTaskbar) sendIntArg(sharedApp(), sel("setActivationPolicy:"), NSApplicationActivationPolicyAccessory);
  }

  const self: Overlay = {
    handle: win,
    setIcon() {
      // A Cocoa window has no icon of its own; setAppIcon covers the Dock.
    },
    show() {
      if (framed || !noActivate) {
        sendPtr(win, sel("makeKeyAndOrderFront:"), NIL);
        sendBool(sharedApp(), sel("activateIgnoringOtherApps:"), true);
      } else {
        sendPtr(win, sel("orderFrontRegardless"), NIL);
      }
    },
    hide() {
      sendPtr(win, sel("orderOut:"), NIL);
    },
    bounds() {
      return fromCocoa(rectOf(win, "frame"));
    },
    moveTo(x, y) {
      const { height } = self.bounds();
      sendPoint(win, sel("setFrameOrigin:"), x, primaryHeight() - (y + height));
    },
    resize(width, height) {
      const { x, y } = self.bounds();
      self.setBounds({ x, y, width, height });
    },
    setBounds(r) {
      const c = toCocoa(r);
      sendRectBool(win, sel("setFrame:display:"), c.x, c.y, c.w, c.h, true);
    },
    setClickThrough(on) {
      hits.delete(win); // whole-window mode wins over the regions
      setIgnoring(win, on);
    },
    setHitRegions(polygons, refine) {
      if (polygons === null) {
        hits.delete(win);
        setIgnoring(win, false);
        return;
      }
      const previous = hits.get(win);
      hits.set(win, { packed: packRegions(polygons), refine, inPolygon: previous?.inPolygon ?? false, askSeq: previous?.askSeq ?? 0 });
      ensureTimer();
      pollHits(); // things moved under a still cursor: the polygons are new, so the refiner is asked again
    },
    setTopmost(on) {
      sendIntArg(win, sel("setLevel:"), on ? NSStatusWindowLevel : NSNormalWindowLevel);
    },
    startDrag() {
      // The mouse-down that the page is reacting to is still the current event.
      const event = asId(send(sharedApp(), sel("currentEvent")));
      if (event !== NIL) sendPtr(win, sel("performWindowDragWithEvent:"), event);
    },
    startResize() {
      // Nothing to start: a frameless macOS overlay has no resizable style mask, so the user cannot resize it.
    },
    minimize() {
      sendPtr(win, sel("miniaturize:"), NIL);
    },
    toggleMaximize() {
      sendPtr(win, sel("zoom:"), NIL);
    },
    maximized() {
      return BigInt(sendInt(win, sel("isZoomed")) ?? 0) !== 0n;
    },
    cursor(): Point {
      return cursorPoint() ?? { x: 0, y: 0 };
    },
    screen() {
      return fromCocoa(rectOf(primaryScreen(), "frame"));
    },
    screenAt(point) {
      // The screen whose frame holds the point; otherwise the one whose frame is nearest to it.
      const screens = asId(send(cls("NSScreen"), sel("screens")));
      const count = Number(sendInt(screens, sel("count")));
      let nearest: Rect | undefined;
      let nearestDistance = Infinity;
      for (let i = 0; i < count; i++) {
        const r = fromCocoa(rectOf(asId(sendUIntRetPtr(screens, sel("objectAtIndex:"), BigInt(i))), "frame"));
        const dx = Math.max(r.x - point.x, 0, point.x - (r.x + r.width));
        const dy = Math.max(r.y - point.y, 0, point.y - (r.y + r.height));
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = r;
        }
      }
      return nearest ?? self.screen();
    },
    workArea() {
      return fromCocoa(rectOf(primaryScreen(), "visibleFrame"));
    },
    virtualScreen() {
      const screens = asId(send(cls("NSScreen"), sel("screens")));
      const count = Number(sendInt(screens, sel("count")));
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        const r = fromCocoa(rectOf(asId(sendUIntRetPtr(screens, sel("objectAtIndex:"), BigInt(i))), "frame"));
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },
    scale: () => 1,
  };
  return self;
}
