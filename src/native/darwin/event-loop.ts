// The OS loop without a webview: send AppKit every event it has queued, then
// return. [NSApp run] would block the thread; this leaves Bun's event loop in
// charge, so timers, promises and I/O keep working on the UI thread.
//
// finishLaunching runs once, as [NSApp run] would do it: the app registers
// with the window server, status items appear, and notification delegates get
// their callbacks. Each pump has its own autorelease pool, so objects the
// handlers autorelease are freed per tick rather than piling up for the
// process.

import type { ActivationPolicy } from "../event-loop";
import { NIL, type Id, allocRaw, asId, cls, nsString, retain, sel, send, sendIntRetBool, sendPtr, sendUIntPtrPtrBool, sharedApp } from "./objc";

const NSEventMaskAny = 0xffff_ffff_ffff_ffffn;
const NSApplicationActivationPolicy: Record<ActivationPolicy, bigint> = { regular: 0n, accessory: 1n, prohibited: 2n };

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

export function setActivationPolicy(policy: ActivationPolicy): void {
  sendIntRetBool(sharedApp(), sel("setActivationPolicy:"), NSApplicationActivationPolicy[policy]);
}
