import { CFunction, FFIType, dlopen, type Pointer } from "bun:ffi";
import { expect, test } from "bun:test";
import { _resetActivationForTest } from "../activation";
import { onOpenUrl, pumpEvents, signalReady, singleInstance, type SecondInstanceEvent } from "../index";

test.if(process.platform === "darwin")("CFMessagePort hands off a secondary launch through the native main loop", async () => {
  const appId = `dev.sweetview.test.${crypto.randomUUID()}.${"long".repeat(100)}`;
  let received: SecondInstanceEvent | undefined;
  let lock = await singleInstance({
    appId,
    args: [],
    onSecondInstance: (event) => {
      received = event;
      lock.dispose();
    },
  });
  const payload = ["--extra", "svtest://warm/🥐"];
  const script = `
    import { singleInstance } from "@n1h/sweetview-native";
    const lock = await singleInstance({ appId: ${JSON.stringify(appId)}, args: ${JSON.stringify(payload)} });
    console.log(JSON.stringify({ isPrimary: lock.isPrimary, handedOff: lock.handedOff }));
    lock.dispose();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
  try {
    expect(lock.isPrimary).toBe(true);
    const deadline = performance.now() + 3500;
    do {
      pumpEvents();
      if (received) break;
      Bun.sleepSync(5);
    } while (performance.now() < deadline);
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ isPrimary: false, handedOff: true });
    expect(received).toEqual({ args: payload, url: payload[1], cwd: process.cwd() });
    pumpEvents(); // Drain callback cleanup scheduled by dispose inside the native handler.
    lock = await singleInstance({ appId, args: [] });
    expect(lock.isPrimary).toBe(true);
  } finally {
    lock.dispose();
  }
});

// Delivers a real kAEGetURL ('GURL'/'GURL') Apple Event, direct object '----'
// = the URL, through NSAppleEventManager's dispatch, which calls whichever
// handler is registered for that event at the time: the same path Launch
// Services' `open myapp://...` takes once the event reaches the process.
function deliverGetUrlEvent(url: string): number {
  const objc = require("./objc") as typeof import("./objc");
  const { asId, cls, nsString, sel, send, sendPtr } = objc;
  const msgSend = (dlopen("/usr/lib/libobjc.A.dylib", { objc_msgSend: { args: [], returns: FFIType.void } }).symbols
    .objc_msgSend as unknown as { ptr: Pointer }).ptr;
  const U = FFIType.u64;
  const call = (args: FFIType[], returns: FFIType) => CFunction({ ptr: msgSend, args, returns }) as unknown as (...a: unknown[]) => bigint | number;
  const GURL = 0x4755524c;
  const keyDirectObject = 0x2d2d2d2d;
  const typeNull = 0x6e756c6cn;
  const descriptorClass = cls("NSAppleEventDescriptor");
  const target = asId(send(descriptorClass, sel("currentProcessDescriptor")));
  const event = asId(call([U, U, FFIType.u32, FFIType.u32, U, FFIType.i16, FFIType.i32], U)(
    descriptorClass, sel("appleEventWithEventClass:eventID:targetDescriptor:returnID:transactionID:"), GURL, GURL, target, -1, 0,
  ));
  const direct = asId(sendPtr(descriptorClass, sel("descriptorWithString:"), nsString(url)));
  call([U, U, U, FFIType.u32], FFIType.void)(event, sel("setParamDescriptor:forKeyword:"), direct, keyDirectObject);
  const reply = new BigUint64Array([typeNull, 0n]); // AEDesc { descriptorType, dataHandle }
  const manager = asId(send(cls("NSAppleEventManager"), sel("sharedAppleEventManager")));
  return Number(call([U, U, U, FFIType.ptr, U], FFIType.i16)(
    manager, sel("dispatchRawAppleEvent:withRawReply:handlerRefCon:"), asId(send(event, sel("aeDesc"))), reply, 0n,
  ));
}

test.if(process.platform === "darwin")("kAEGetURL Apple Events reach onOpenUrl, queued until signalReady and delivered once", () => {
  _resetActivationForTest();
  try {
    // Install the native handler, then leave no listener: the first URL arrives before anyone subscribed.
    onOpenUrl(() => {})();
    const first = "svtest://cold/🥐?q=1&r=%20#frag";
    expect(deliverGetUrlEvent(first)).toBe(0);
    pumpEvents(); // finishLaunching must not replace the GURL handler
    const received: string[] = [];
    const unsubscribe = onOpenUrl((url) => received.push(url));
    const second = "svtest://early/\u{1D11E}";
    expect(deliverGetUrlEvent(second)).toBe(0);
    expect(received).toEqual([]);
    signalReady();
    expect(received).toEqual([first, second]);
    signalReady();
    expect(received).toEqual([first, second]);
    const live = "svtest://warm/after-ready";
    expect(deliverGetUrlEvent(live)).toBe(0);
    expect(received).toEqual([first, second, live]);
    unsubscribe();
    expect(deliverGetUrlEvent("svtest://gone")).toBe(0);
    expect(received).toEqual([first, second, live]);
  } finally {
    _resetActivationForTest();
  }
});
