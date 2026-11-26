import { FFIType, dlopen, read, type Pointer } from "bun:ffi";

export const coreFoundationPath = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

let commonModes: Pointer | undefined;

/** CoreFoundation recognizes the common-modes sentinel by address. */
export function commonRunLoopModes(): Pointer {
  if (commonModes !== undefined) return commonModes;
  const loader = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const handle = loader.symbols.dlopen(Buffer.from(coreFoundationPath + "\0"), 1); // RTLD_LAZY
  try {
    if (handle) {
      const symbol = loader.symbols.dlsym(handle, Buffer.from("kCFRunLoopCommonModes\0"));
      if (symbol) {
        commonModes = Number(read.ptr(symbol)) as Pointer;
        return commonModes;
      }
    }
    throw new Error("sweetview: CoreFoundation common run-loop modes unavailable");
  } finally {
    if (handle) loader.symbols.dlclose(handle);
    loader.close();
  }
}
