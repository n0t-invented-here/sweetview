// macOS custom URL scheme handler (NSAppleEventManager) and single-instance
// handoff via a CoreFoundation message port on AppKit's main run loop.

import { FFIType, JSCallback, dlopen, toArrayBuffer, type Pointer } from "bun:ffi";
import { reportCallbackError } from "../callback-errors";
import { createHash } from "node:crypto";
import { validateUrlScheme } from "@n1h/sweetview-settings";
import { parseSecondInstanceEvent, type RegisterUrlSchemeOptions, type SecondInstanceEvent, type SingleInstanceLock } from "../activation";
import { commonRunLoopModes, coreFoundationPath } from "./core-foundation";
import { scheduleNativeTimeout } from "./event-loop";
import {
  NIL,
  type Id,
  asId,
  cls,
  jsString,
  makeTarget,
  sel,
  send,
  sendPtrSelU32U32Void,
  sendU32RetPtr,
  sharedApp,
} from "./objc";

// FourCC constants: 'GURL' = 0x4755524c, '----' = 0x2d2d2d2d
const kInternetEventClass = 0x4755524c;
const kAEGetURL = 0x4755524c;
const keyDirectObject = 0x2d2d2d2d;

let urlTarget: Id = NIL;
let urlDispatch: ((url: string) => void) | undefined;

export function installUrlEventHandler(onUrl: (url: string) => void): void {
  urlDispatch = onUrl;
  if (urlTarget !== NIL) return;
  sharedApp();
  urlTarget = makeTarget("SweetviewUrlEventHandler", {
    "handleGetURLEvent:withReplyEvent:": {
      args: 2,
      impl: (event, _reply) => {
        if (event === NIL) return;
        const descriptor = asId(sendU32RetPtr(event, sel("paramDescriptorForKeyword:"), keyDirectObject));
        if (descriptor === NIL) return;
        const strObj = asId(send(descriptor, sel("stringValue")));
        if (strObj === NIL) return;
        const url = jsString(strObj);
        if (url) urlDispatch?.(url);
      },
    },
  });
  const manager = asId(send(cls("NSAppleEventManager"), sel("sharedAppleEventManager")));
  if (manager !== NIL) {
    sendPtrSelU32U32Void(
      manager,
      sel("setEventHandler:andSelector:forEventClass:andEventID:"),
      urlTarget,
      sel("handleGetURLEvent:withReplyEvent:"),
      kInternetEventClass,
      kAEGetURL,
    );
  }
}

export function registerUrlScheme(scheme: string, _options?: RegisterUrlSchemeOptions): void {
  // Validate syntax; macOS Launch Services registers schemes from Info.plist CFBundleURLTypes (makeMacApp({ urlSchemes })).
  validateUrlScheme(scheme);
}

export function unregisterUrlScheme(scheme: string): void {
  validateUrlScheme(scheme);
}

const P = FFIType.ptr;
const V = FFIType.void;
const I = FFIType.i64; // CFIndex on arm64
const D = FFIType.f64; // CFTimeInterval
const cf = dlopen(coreFoundationPath, {
  CFMessagePortCreateLocal: { args: [P, P, P, P, P], returns: P },
  CFMessagePortCreateRemote: { args: [P, P], returns: P },
  CFMessagePortCreateRunLoopSource: { args: [P, P, I], returns: P },
  CFMessagePortSendRequest: { args: [P, FFIType.i32, P, D, D, P, P], returns: FFIType.i32 },
  CFMessagePortInvalidate: { args: [P], returns: V },
  CFRunLoopSourceInvalidate: { args: [P], returns: V },
  CFRunLoopGetMain: { args: [], returns: P },
  CFRunLoopAddSource: { args: [P, P, P], returns: V },
  CFDataCreate: { args: [P, P, I], returns: P },
  CFDataGetBytePtr: { args: [P], returns: P },
  CFDataGetLength: { args: [P], returns: I },
  CFStringCreateWithCString: { args: [P, P, FFIType.u32], returns: P },
  CFRelease: { args: [P], returns: V },
}).symbols;

const utf8 = 0x08000100; // kCFStringEncodingUTF8
const localHandlers = new Map<string, (event: SecondInstanceEvent) => void>();

function sendActivation(remote: Pointer, payload: SecondInstanceEvent): boolean {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const data = cf.CFDataCreate(null, bytes, BigInt(bytes.byteLength));
  if (!data) throw new Error("sweetview: could not allocate activation payload");
  try {
    // No reply mode: return as soon as Mach accepts the message, even if
    // the primary is still starting and hasn't begun pumping its run loop.
    return cf.CFMessagePortSendRequest(remote, 1, data, 1.5, 0, null, null) === 0;
  } finally {
    cf.CFRelease(data);
  }
}

export async function acquireSingleInstance(params: {
  appId: string;
  payload: SecondInstanceEvent;
  onSecondInstance: (event: SecondInstanceEvent) => void;
}): Promise<SingleInstanceLock> {
  // A fixed-length name fits the Mach bootstrap namespace regardless of app ID length.
  const id = createHash("sha256").update(params.appId).digest("hex");
  const localHandler = localHandlers.get(id);
  if (localHandler) {
    localHandler(params.payload);
    return { isPrimary: false, handedOff: true, dispose() {} };
  }

  const name = cf.CFStringCreateWithCString(null, Buffer.from("sweetview." + id + "\0"), utf8);
  if (!name) throw new Error("sweetview: could not allocate activation port name");
  try {
    const commonModes = commonRunLoopModes();
    let callbackDepth = 0;
    const callback = new JSCallback(
      (_port, messageId, data: Pointer | null) => {
        callbackDepth++;
        try {
          if (messageId === 1 && data) {
            const length = Number(cf.CFDataGetLength(data));
            const bytes = cf.CFDataGetBytePtr(data);
            if (bytes && length > 0) {
              const payload = parseSecondInstanceEvent(new TextDecoder().decode(toArrayBuffer(bytes, 0, length)));
              if (payload !== undefined) params.onSecondInstance(payload);
            }
          }
        } catch (err) {
          reportCallbackError("singleInstance.onSecondInstance", err, "sweetview: singleInstance CFMessagePort handler threw:");
        } finally {
          callbackDepth--;
        }
        return null;
      },
      { args: [P, FFIType.i32, P, P], returns: P },
    );
    // shouldFreeInfo also tells us if CF returned a cached local object
    // whose installed callback belongs to a different acquisition.
    const existing = new Uint8Array(1);
    const port = cf.CFMessagePortCreateLocal(null, name, callback.ptr, null, existing);
    if (!port || existing[0]) {
      callback.close();
      if (port) cf.CFRelease(port);
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) await Bun.sleep(25);
        const remote = cf.CFMessagePortCreateRemote(null, name);
        if (!remote) continue;
        try {
          return { isPrimary: false, handedOff: sendActivation(Number(remote) as Pointer, params.payload), dispose() {} };
        } finally {
          cf.CFRelease(remote);
        }
      }
      return { isPrimary: false, handedOff: false, dispose() {} };
    }
    const source = cf.CFMessagePortCreateRunLoopSource(null, port, 0n);
    if (!source) {
      cf.CFMessagePortInvalidate(port);
      cf.CFRelease(port);
      callback.close();
      throw new Error("sweetview: could not create activation run-loop source");
    }
    cf.CFRunLoopAddSource(cf.CFRunLoopGetMain(), source, commonModes);
    localHandlers.set(id, params.onSecondInstance);
    let disposed = false;
    return {
      isPrimary: true,
      handedOff: false,
      dispose() {
        if (disposed) return;
        disposed = true;
        localHandlers.delete(id);
        cf.CFMessagePortInvalidate(port);
        cf.CFRunLoopSourceInvalidate(source);
        cf.CFRelease(source);
        cf.CFRelease(port);
        // A handler is allowed to release the lock. Keep the native trampoline
        // alive until the outermost CFMessagePort callback has returned.
        const closeCallback = () => {
          if (callbackDepth === 0) callback.close();
          else scheduleNativeTimeout(1, closeCallback);
        };
        closeCallback();
      },
    };
  } finally {
    cf.CFRelease(name);
  }
}
