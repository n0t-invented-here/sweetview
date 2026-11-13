// Minimal Objective-C runtime bridge over bun:ffi, shared by the macOS
// native pieces (folder picker, main menu).
//
// Every `id` and `SEL` is carried as a bigint (FFIType.u64), never as a JS
// number. Short NSStrings are tagged pointers with the top bit set
// (0x8000_0000_0000_0000 | ...), which a double cannot hold exactly; passing
// one through `Number()` or `FFIType.ptr` rounds the low bits and the next
// objc_msgSend dereferences garbage.

import { CFunction, CString, FFIType, JSCallback, dlopen, ptr, read, type Pointer } from "bun:ffi";

// Make sure AppKit classes exist even if nothing else has loaded the framework.
dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {
  NSApplicationLoad: { args: [], returns: FFIType.bool },
});

const objc = dlopen("/usr/lib/libobjc.A.dylib", {
  objc_getClass: { args: [FFIType.ptr], returns: FFIType.u64 },
  sel_registerName: { args: [FFIType.ptr], returns: FFIType.u64 },
  objc_msgSend: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  objc_allocateClassPair: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
  objc_registerClassPair: { args: [FFIType.u64], returns: FFIType.void },
  class_addMethod: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
});

export type Id = bigint;
export const NIL: Id = 0n;
export const asId = (v: bigint | number | null): Id => (v === null ? NIL : BigInt(v));

// objc_msgSend is effectively variadic; one CFunction per signature we need.
const msgSendPtr = (objc.symbols.objc_msgSend as unknown as { ptr: Pointer }).ptr;
if (typeof msgSendPtr !== "number" || msgSendPtr === 0) throw new Error("objc_msgSend address unavailable");
const fn = (args: FFIType[], returns: FFIType) =>
  CFunction({ ptr: msgSendPtr, args, returns }) as unknown as (...a: unknown[]) => bigint | number | null;

export const ID = FFIType.u64;
/** [obj sel] -> id */
export const send = fn([ID, ID], ID);
/** [obj sel] -> NSInteger */
export const sendInt = fn([ID, ID], FFIType.i64);
/** [obj sel:BOOL] -> void */
export const sendBool = fn([ID, ID, FFIType.bool], FFIType.void);
/** [obj sel:NSInteger] -> BOOL */
export const sendIntRetBool = fn([ID, ID, FFIType.i64], FFIType.bool);
/** [obj sel:id] -> id */
export const sendPtr = fn([ID, ID, ID], ID);
/** [obj sel:id :SEL :id] -> id  (initWithTitle:action:keyEquivalent:) */
export const sendPtrSelPtr = fn([ID, ID, ID, ID, ID], ID);

/**
 * NUL-terminated UTF-8. Pass the array itself to an FFIType.ptr parameter, never
 * `ptr(cstr(..))`: Bun keeps a TypedArray argument alive for the call, while a
 * bare pointer may be collected by a GC that runs while later arguments are built.
 */
export const cstr = (s: string): Uint8Array => new TextEncoder().encode(s + "\0");
export const sel = (name: string) => asId(objc.symbols.sel_registerName(cstr(name)));
export function cls(name: string): Id {
  const c = asId(objc.symbols.objc_getClass(cstr(name)));
  if (c === NIL) throw new Error(`Objective-C class ${name} not found`);
  return c;
}
/** [obj sel:const char*] -> id  (stringWithUTF8String:) */
export const sendCStr = fn([ID, ID, FFIType.ptr], ID);
export const nsString = (s: string) => asId(sendCStr(cls("NSString"), sel("stringWithUTF8String:"), cstr(s)));
/** JS string from an NSString (UTF8String is a real heap pointer, never tagged). */
export const jsString = (nsstr: Id): string => {
  const utf8 = asId(send(nsstr, sel("UTF8String")));
  return utf8 === NIL ? "" : new CString(Number(utf8) as Pointer).toString();
};
export const alloc = (className: string) => asId(send(allocRaw(className), sel("init")));
/** [Class alloc] only, for objects that get an initWith...: next. */
export const allocRaw = (className: string) => asId(send(cls(className), sel("alloc")));
export const sharedApp = () => asId(send(cls("NSApplication"), sel("sharedApplication")));

// Callbacks the runtime may call for the life of the process; keep them alive.
const retained: JSCallback[] = [];

/** A method body: a one-argument `-(void)name:(id)sender`, or `{ args, impl }` for n object/pointer arguments. */
export type TargetMethod = ((sender: Id) => void) | { args: number; impl: (...args: Id[]) => void };

/**
 * Defines an NSObject subclass whose instance methods are JS functions, and
 * returns one instance of it. Every method returns void and takes object or
 * pointer arguments (blocks included), which is what menu items, buttons and
 * delegates call.
 */
let targetClasses = 0;

/** Registers a fresh NSObject subclass whose selectors call into JavaScript; the name is made unique, so the same base name can be used again. */
export function makeTarget(baseName: string, methods: Record<string, TargetMethod>): Id {
  const className = `${baseName}_${++targetClasses}`;
  const klass = asId(objc.symbols.objc_allocateClassPair(cls("NSObject"), cstr(className), 0n));
  if (klass === NIL) throw new Error(`objc_allocateClassPair(${className}) failed (already registered?)`);
  for (const [selector, method] of Object.entries(methods)) {
    const argc = typeof method === "function" ? 1 : method.args;
    const impl = typeof method === "function" ? (sender: Id) => method(sender) : method.impl;
    const cb = new JSCallback(
      (_self: bigint, _cmd: bigint, ...args: bigint[]) => {
        try {
          impl(...args.map((a) => BigInt(a ?? 0)));
        } catch (err) {
          console.error(`sweetnative: ${className} ${selector} threw:`, err);
        }
      },
      { args: [ID, ID, ...Array<FFIType>(argc).fill(ID)], returns: FFIType.void },
    );
    retained.push(cb);
    if (!objc.symbols.class_addMethod(klass, sel(selector), cb.ptr, cstr("v@:" + "@".repeat(argc)))) {
      throw new Error(`class_addMethod(${className}, ${selector}) failed`);
    }
  }
  objc.symbols.objc_registerClassPair(klass);
  return asId(send(asId(send(klass, sel("alloc"))), sel("init")));
}

/**
 * Register a subclass whose listed selectors answer YES: `defineYesClass("NSWindow",
 * "SweetnativeKeyWindow", ["canBecomeKeyWindow"])` makes a borderless window
 * that can take keyboard focus. Once per class name; a second call is a no-op.
 */
export function defineYesClass(superclass: string, className: string, selectors: string[]): void {
  if (asId(objc.symbols.objc_getClass(cstr(className))) !== NIL) return;
  const klass = asId(objc.symbols.objc_allocateClassPair(cls(superclass), cstr(className), 0n));
  if (klass === NIL) throw new Error(`objc_allocateClassPair(${className}) failed`);
  for (const selector of selectors) {
    const cb = new JSCallback((_self: bigint, _cmd: bigint) => true, { args: [ID, ID], returns: FFIType.bool });
    retained.push(cb);
    if (!objc.symbols.class_addMethod(klass, sel(selector), cb.ptr, cstr("B@:"))) throw new Error(`class_addMethod(${className}, ${selector}) failed`);
  }
  objc.symbols.objc_registerClassPair(klass);
}

const RTLD_NOW = 2;
const dl = dlopen("/usr/lib/libSystem.B.dylib", {
  dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
}).symbols;

/** Address of a data symbol (bun's dlopen binds functions only). */
export function dataSymbolAddress(library: string, name: string): bigint {
  const image = dl.dlopen(cstr(library), RTLD_NOW);
  if (image === null) throw new Error(`dlopen(${library}) failed`);
  const address = dl.dlsym(image, cstr(name));
  if (address === null) throw new Error(`dlsym(${name}) in ${library} returned null`);
  return BigInt(address);
}

const BLOCK_IS_GLOBAL = 1 << 28;
const BLOCK_LITERAL_SIZE = 32;
let globalBlockIsa: bigint | undefined;
const blockDescriptor = new BigUint64Array([0n, BigInt(BLOCK_LITERAL_SIZE)]); // { reserved, size }
const retainedBlocks: Uint8Array[] = [];

/**
 * A global Objective-C block (captures nothing, lives for the process) whose
 * body is a JS function. `argTypes` are the block's own parameters, after the
 * implicit block pointer. Object parameters must be FFIType.u64.
 *
 * `threadsafe` blocks are for completion handlers that AppKit calls on a
 * background queue; Bun then queues the JS body for the event loop, which is
 * blocked while the webview runs, so such a body effectively never runs and
 * the block is fire-and-forget.
 */
export function makeBlock(body: (...args: bigint[]) => void, argTypes: FFIType[], threadsafe = false): Id {
  globalBlockIsa ??= dataSymbolAddress("/usr/lib/libSystem.B.dylib", "_NSConcreteGlobalBlock");
  const cb = new JSCallback((_block: bigint, ...args: bigint[]) => body(...args), {
    args: [FFIType.u64, ...argTypes],
    returns: FFIType.void,
    threadsafe,
  });
  if (cb.ptr === null) throw new Error("sweetnative: could not allocate a block callback");
  retained.push(cb);
  const literal = new Uint8Array(BLOCK_LITERAL_SIZE);
  const dv = new DataView(literal.buffer);
  dv.setBigUint64(0, globalBlockIsa, true); // isa
  dv.setInt32(8, BLOCK_IS_GLOBAL, true); // flags
  dv.setInt32(12, 0, true); // reserved
  dv.setBigUint64(16, BigInt(cb.ptr), true); // invoke
  dv.setBigUint64(24, BigInt(ptr(blockDescriptor)), true); // descriptor
  retainedBlocks.push(literal);
  return BigInt(ptr(literal));
}

/** Calls a block someone handed us (a completion handler): `invoke(block, ...args)`. */
export function invokeBlock(block: Id, argTypes: FFIType[], ...args: (bigint | number)[]): void {
  if (block === NIL) return;
  const invoke = read.ptr(Number(block) as Pointer, 16) as unknown as Pointer | bigint | null;
  if (invoke === null) throw new Error("sweetnative: block has no invoke pointer");
  const fn = CFunction({ ptr: Number(invoke) as Pointer, args: [FFIType.u64, ...argTypes], returns: FFIType.void }) as unknown as (...a: unknown[]) => void;
  fn(block, ...args);
}

/** [obj sel:double] -> id  (statusItemWithLength:) */
export const sendF64 = fn([ID, ID, FFIType.f64], ID);
/** [obj sel] -> double  (doubleClickInterval) */
export const sendRetF64 = fn([ID, ID], FFIType.f64);
/** [obj sel] -> BOOL  (isVisible) */
export const sendRetBool = fn([ID, ID], FFIType.bool);
/** [obj sel:NSInteger] -> void  (setState:) */
export const sendIntArg = fn([ID, ID, FFIType.i64], FFIType.void);
/** [obj sel:NSUInteger :id] -> void  (requestAuthorizationWithOptions:completionHandler:) */
export const sendUIntPtrVoid = fn([ID, ID, FFIType.u64, ID], FFIType.void);
/** [obj sel:id :id :id] -> id  (requestWithIdentifier:content:trigger:) */
export const sendPtrPtrPtr = fn([ID, ID, ID, ID, ID], ID);
/** [obj sel:NSUInteger] -> id  (standardWindowButton:) */
export const sendUIntRetPtr = fn([ID, ID, FFIType.u64], ID);
/** [obj sel:NSUInteger] -> NSInteger  (sendActionOn:) */
export const sendUInt = fn([ID, ID, FFIType.u64], FFIType.i64);
/** [obj sel:id :id] -> id  (imageWithSystemSymbolName:accessibilityDescription:) */
export const sendPtrPtr = fn([ID, ID, ID, ID], ID);
/** [obj sel:bytes :NSUInteger] -> id  (dataWithBytes:length:) */
export const sendBytesLen = fn([ID, ID, FFIType.ptr, FFIType.u64], ID);
/** [obj sel:SEL :id :double] -> void  (performSelector:withObject:afterDelay:) */
export const sendSelPtrF64 = fn([ID, ID, ID, ID, FFIType.f64], FFIType.void);
/** [obj sel:id :SEL :id] -> void  (cancelPreviousPerformRequestsWithTarget:selector:object:) */
export const sendPtrSelPtrVoid = fn([ID, ID, ID, ID, ID], FFIType.void);

// Structs by value. On arm64 an NSRect (4 doubles) and an NSPoint (2 doubles)
// are passed in d0..d3 exactly like separate double arguments, and integer
// arguments after them still go in x2.. (Apple Silicon only, as is this package).
/** [obj sel:NSRect :NSUInteger :NSUInteger :BOOL] -> id  (initWithContentRect:styleMask:backing:defer:) */
export const sendRectUIntUIntBool = fn([ID, ID, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.u64, FFIType.u64, FFIType.bool], ID);
/** [obj sel:NSRect :BOOL] -> void  (setFrame:display:) */
export const sendRectBool = fn([ID, ID, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.bool], FFIType.void);
/** [obj sel:NSPoint] -> void  (setFrameOrigin:) */
export const sendPoint = fn([ID, ID, FFIType.f64, FFIType.f64], FFIType.void);
/** [obj sel:NSSize] -> void  (setSize:); NSSize is two doubles like NSPoint, so the same call. */
export const sendSize = sendPoint;
/** [obj sel:NSUInteger] -> void  (setCollectionBehavior:, setStyleMask:) */
export const sendUIntArg = fn([ID, ID, FFIType.u64], FFIType.void);
/** [obj sel:double] -> void  (setAlphaValue:) */
export const sendF64Void = fn([ID, ID, FFIType.f64], FFIType.void);
/** [obj sel:void*] -> id  (getReturnValue:, getValue:) */
export const sendPtrArg = fn([ID, ID, FFIType.ptr], ID);
/** [obj sel:double :id :SEL :id :BOOL] -> id  (scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:) */
export const sendF64PtrSelPtrBool = fn([ID, ID, FFIType.f64, ID, ID, ID, FFIType.bool], ID);

export const retain = (obj: Id): Id => asId(send(obj, sel("retain")));
export const release = (obj: Id): void => {
  if (obj !== NIL) send(obj, sel("release"));
};
/** [obj sel:NSUInteger :id :id :BOOL] -> id  (nextEventMatchingMask:untilDate:inMode:dequeue:) */
export const sendUIntPtrPtrBool = fn([ID, ID, FFIType.u64, ID, ID, FFIType.bool], ID);

/** [obj sel] -> void  (requestWhenInUseAuthorization) */
export const sendVoid = fn([ID, ID], FFIType.void);
/** [obj sel:id] -> void  (requestAuthorization:, requestFullAccessToEventsWithCompletion:) */
export const sendPtrVoid = fn([ID, ID, ID], FFIType.void);
/** [obj sel:id :id] -> void  (requestAccessForMediaType:completionHandler:) */
export const sendPtrPtrVoid = fn([ID, ID, ID, ID], FFIType.void);
/** [obj sel:id] -> NSInteger  (authorizationStatusForMediaType:) */
export const sendPtrRetInt = fn([ID, ID, ID], FFIType.i64);
/** [obj sel:id] -> BOOL  (respondsToSelector:, which takes a SEL) */
export const sendPtrRetBool = fn([ID, ID, ID], FFIType.bool);
/** [obj sel:BOOL] -> id  (numberWithBool:) */
export const sendBoolRetPtr = fn([ID, ID, FFIType.bool], ID);

/** Loads a system framework by name, so its classes exist for `cls` and `findClass`. Loading one twice is free. */
export function loadFramework(name: string): void {
  const path = `/System/Library/Frameworks/${name}.framework/${name}`;
  if (dl.dlopen(cstr(path), RTLD_NOW) === null) throw new Error(`dlopen(${path}) failed`);
}

/** The class, or NIL when this macOS has none by that name (`cls` throws instead). */
export const findClass = (name: string): Id => asId(objc.symbols.objc_getClass(cstr(name)));

/** The object a framework's exported constant points at: `objectConstant("AVFoundation", "AVMediaTypeVideo")` is that NSString. */
export const objectConstant = (framework: string, name: string): Id =>
  asId(read.u64(Number(dataSymbolAddress(`/System/Library/Frameworks/${framework}.framework/${framework}`, name)) as Pointer, 0));
