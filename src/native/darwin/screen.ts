// macOS Screen queries and Cocoa coordinate helpers.
// Calls sharedApp() on first use so coordinates before new Window() match
// coordinates after. Top-left origin of the primary screen in points.

import type { ScreenInfo } from "../screen";
import type { Point, Rect, WindowHandle } from "../types";
import {
  NIL,
  asId,
  cls,
  nsString,
  sel,
  send,
  sendBytesLen,
  sendInt,
  sendPtr,
  sendPtrArg,
  sendRetF64,
  sendUIntRetPtr,
  sharedApp,
  type Id,
} from "./objc";
import { asNSWindow } from "./window";

export type CocoaRect = { x: number; y: number; w: number; h: number };
const rectBuf = new Float64Array(4);

/** `[obj valueForKey:key]` boxes a struct-returning property into an NSValue; `getValue:size:` copies it out. */
export function rectOf(obj: Id, key: string): CocoaRect {
  const value = asId(sendPtr(obj, sel("valueForKey:"), nsString(key)));
  if (value === NIL) throw new Error(`sweetview: ${key} unavailable`);
  rectBuf.fill(0);
  sendBytesLen(value, sel("getValue:size:"), rectBuf, 32n);
  return { x: rectBuf[0]!, y: rectBuf[1]!, w: rectBuf[2]!, h: rectBuf[3]! };
}

export function primaryScreen(): Id {
  sharedApp();
  const screens = asId(send(cls("NSScreen"), sel("screens")));
  const count = Number(sendInt(screens, sel("count")) ?? 0);
  if (count <= 0) return asId(send(cls("NSScreen"), sel("mainScreen")));
  return asId(sendUIntRetPtr(screens, sel("objectAtIndex:"), 0n));
}

export const primaryHeight = (): number => rectOf(primaryScreen(), "frame").h;

/** Cocoa (bottom-left origin) -> sweetview (top-left origin). */
export const fromCocoa = (r: CocoaRect): Rect => ({ x: r.x, y: primaryHeight() - (r.y + r.h), width: r.w, height: r.h });
export const toCocoa = (r: Rect): CocoaRect => ({ x: r.x, y: primaryHeight() - (r.y + r.height), w: r.width, h: r.height });

const pointBuf = new Float64Array(2);
let cursorInvocation: Id = NIL;
let warnedNoCursor = false;

export function cursorPoint(): Point | null {
  sharedApp();
  if (cursorInvocation === NIL) {
    const eventClass = cls("NSEvent");
    const selector = sel("mouseLocation");
    const signature = asId(sendPtr(eventClass, sel("methodSignatureForSelector:"), selector));
    const invocation = signature === NIL ? NIL : asId(sendPtr(cls("NSInvocation"), sel("invocationWithMethodSignature:"), signature));
    if (invocation === NIL) {
      if (!warnedNoCursor) console.error("sweetview: cannot build the NSInvocation for +[NSEvent mouseLocation]; cursor queries unavailable");
      warnedNoCursor = true;
      return null;
    }
    sendPtr(invocation, sel("setSelector:"), selector);
    sendPtr(invocation, sel("setTarget:"), eventClass);
    send(invocation, sel("retain"));
    cursorInvocation = invocation;
  }
  send(cursorInvocation, sel("invoke"));
  pointBuf.fill(0);
  sendPtrArg(cursorInvocation, sel("getReturnValue:"), pointBuf);
  return { x: pointBuf[0]!, y: primaryHeight() - pointBuf[1]! };
}

function screenInfo(screen: Id, isPrimary: boolean): ScreenInfo {
  const scale = Number(sendRetF64(screen, sel("backingScaleFactor")) ?? 1) || 1;
  return {
    bounds: fromCocoa(rectOf(screen, "frame")),
    workArea: fromCocoa(rectOf(screen, "visibleFrame")),
    scale,
    primary: isPrimary,
  };
}

export function all(): ScreenInfo[] {
  sharedApp();
  const screens = asId(send(cls("NSScreen"), sel("screens")));
  const count = Number(sendInt(screens, sel("count")) ?? 0);
  const out: ScreenInfo[] = [];
  for (let i = 0; i < count; i++) {
    const s = asId(sendUIntRetPtr(screens, sel("objectAtIndex:"), BigInt(i)));
    if (s !== NIL) out.push(screenInfo(s, i === 0));
  }
  if (out.length === 0) {
    const main = asId(send(cls("NSScreen"), sel("mainScreen")));
    if (main !== NIL) out.push(screenInfo(main, true));
  }
  return out;
}

export function primary(): ScreenInfo {
  const list = all();
  return list[0] ?? { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, scale: 1, primary: true };
}

export function at(point: Point): ScreenInfo {
  const list = all();
  let nearest: ScreenInfo | undefined;
  let nearestDist = Infinity;
  for (const s of list) {
    const r = s.bounds;
    const dx = Math.max(r.x - point.x, 0, point.x - (r.x + r.width));
    const dy = Math.max(r.y - point.y, 0, point.y - (r.y + r.height));
    const dist = dx * dx + dy * dy;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = s;
    }
  }
  return nearest ?? primary();
}

export function of(handle: WindowHandle): ScreenInfo {
  sharedApp();
  const win = asNSWindow(handle);
  const s = asId(send(win, sel("screen")));
  if (s === NIL) return primary();
  return screenInfo(s, s === primaryScreen());
}

export function bounds(): Rect {
  const list = all();
  if (list.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of list) {
    minX = Math.min(minX, s.bounds.x);
    minY = Math.min(minY, s.bounds.y);
    maxX = Math.max(maxX, s.bounds.x + s.bounds.width);
    maxY = Math.max(maxY, s.bounds.y + s.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function cursor(): Point {
  return cursorPoint() ?? { x: 0, y: 0 };
}
