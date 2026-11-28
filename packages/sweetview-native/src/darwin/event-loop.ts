// The OS loop without a webview: send AppKit every event it has queued, then
// return. [NSApp run] would block the thread; this leaves Bun's event loop in
// charge, so timers, promises and I/O keep working on the UI thread.
//
// finishLaunching runs once, as [NSApp run] would do it: the app registers
// with the window server, status items appear, and notification delegates get
// their callbacks. Each pump has its own autorelease pool, so objects the
// handlers autorelease are freed per tick rather than piling up for the
// process.

import { FFIType, dlopen } from "bun:ffi";
import type { ActivationPolicy } from "../event-loop";
import { commonRunLoopModes, coreFoundationPath } from "./core-foundation";
import { NIL, type Id, allocRaw, asId, cls, makeTarget, nsString, release, retain, sel, send, sendF64PtrSelPtrBool, sendIntRetBool, sendPtr, sendUIntPtrPtrBool, sharedApp } from "./objc";

const NSEventMaskAny = 0xffff_ffff_ffff_ffffn;
const NSApplicationActivationPolicy: Record<ActivationPolicy, bigint> = { regular: 0n, accessory: 1n, prohibited: 2n };
const cf = dlopen(coreFoundationPath, {
  CFRunLoopRunInMode: { args: [FFIType.u64, FFIType.f64, FFIType.bool], returns: FFIType.i32 },
  CFRunLoopGetMain: { args: [], returns: FFIType.ptr },
  CFRunLoopAddTimer: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
}).symbols;

let launched = false;
let defaultMode: Id = NIL; // NSDefaultRunLoopMode, retained for the process
let distantPast: Id = NIL; // [NSDate distantPast], retained for the process

export function pumpEvents(): boolean {
  const app = sharedApp();
  if (!launched) {
    launched = true;
    defaultMode = retain(nsString("kCFRunLoopDefaultMode"));
    distantPast = retain(asId(send(cls("NSDate"), sel("distantPast"))));
    send(app, sel("finishLaunching"));
  }
  const pool = asId(send(allocRaw("NSAutoreleasePool"), sel("init")));
  try {
    // The nonblocking NSEvent fetch can return before driving timers, Mach
    // messages or WebKit's main-queue dispatches. Give those sources a pass.
    cf.CFRunLoopRunInMode(defaultMode, 0, false);
    for (;;) {
      const event = asId(sendUIntPtrPtrBool(app, sel("nextEventMatchingMask:untilDate:inMode:dequeue:"), NSEventMaskAny, distantPast, defaultMode, true));
      if (event === NIL) break;
      sendPtr(app, sel("sendEvent:"), event);
    }
    send(app, sel("updateWindows"));
  } finally {
    send(pool, sel("drain"));
  }
  return true; // AppKit has no WM_QUIT; terminate: ends the process itself
}

/** Windows only: AppKit has no quit request to take back. */
export function discardQuit(): void {}

export function setActivationPolicy(policy: ActivationPolicy): void {
  sendIntRetBool(sharedApp(), sel("setActivationPolicy:"), NSApplicationActivationPolicy[policy]);
}

const timers = new Map<Id, () => void>();
let timerTarget: Id = NIL;
let timerTargetClass: Id = NIL;

export function scheduleNativeTimeout(ms: number, fn: () => void): () => void {
  sharedApp();
  const commonModes = commonRunLoopModes();
  if (timerTarget === NIL) {
    if (timerTargetClass === NIL) {
      timerTarget = makeTarget("SweetviewNativeTimeout", { "fire:": (timer) => timers.get(timer)?.() }, "NSObject", { "fire:": "timeout" });
      timerTargetClass = asId(send(timerTarget, sel("class")));
    } else {
      timerTarget = asId(send(asId(send(timerTargetClass, sel("alloc"))), sel("init")));
    }
  }
  const timer = retain(asId(sendF64PtrSelPtrBool(
    cls("NSTimer"), sel("scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:"),
    ms / 1000, timerTarget, sel("fire:"), NIL, false,
  )));
  if (timer === NIL) {
    if (!timers.size) {
      release(timerTarget);
      timerTarget = NIL;
    }
    throw new Error("sweetview: could not schedule NSTimer");
  }
  let active = true;
  const cancel = () => {
    if (!active) return;
    active = false;
    timers.delete(timer);
    send(timer, sel("invalidate"));
    release(timer);
    if (timers.size === 0) {
      release(timerTarget);
      timerTarget = NIL;
    }
  };
  timers.set(timer, () => {
    cancel();
    fn();
  });
  cf.CFRunLoopAddTimer(cf.CFRunLoopGetMain(), timer, commonModes);
  return cancel;
}
