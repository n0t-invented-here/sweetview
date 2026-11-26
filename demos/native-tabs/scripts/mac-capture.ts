// A PNG of one of this process's own windows, as the window server composites
// it: frame, tab bar and the webview's pixels. `screencapture` needs the
// Screen Recording grant; a process asking for its own window does not.

import { dlopen, FFIType } from "bun:ffi";
import { NIL, asId, cls, nsString, sel, sendInt, sendPtr } from "@n1h/sweetview-native/darwin/objc";

const { u64, f64, u32 } = FFIType;
const graphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGWindowListCreateImage: { args: [f64, f64, f64, f64, u32, u32, u32], returns: u64 }, // (CGRect, option, windowID, imageOption)
  CGImageGetWidth: { args: [u64], returns: u64 },
  CGImageGetHeight: { args: [u64], returns: u64 },
  CGImageRelease: { args: [u64], returns: FFIType.void },
}).symbols;
const imageIO = dlopen("/System/Library/Frameworks/ImageIO.framework/ImageIO", {
  CGImageDestinationCreateWithURL: { args: [u64, u64, u64, u64], returns: u64 }, // (url, type, count, options)
  CGImageDestinationAddImage: { args: [u64, u64, u64], returns: FFIType.void },
  CGImageDestinationFinalize: { args: [u64], returns: FFIType.bool },
}).symbols;
const { CFRelease } = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFRelease: { args: [u64], returns: FFIType.void },
}).symbols;

const kCGWindowListOptionIncludingWindow = 1 << 3;
const kCGWindowImageBoundsIgnoreFraming = 1 << 0; // the window without its shadow
const kCGWindowImageBestResolution = 1 << 3;

/** Writes a PNG of the window (an NSWindow*) and returns its size in pixels. */
export function captureWindow(window: bigint, path: string): { width: number; height: number } {
  const windowNumber = Number(sendInt(window, sel("windowNumber")));
  // CGRectNull: the bounds of the window itself
  const image = BigInt(
    graphics.CGWindowListCreateImage(Infinity, Infinity, 0, 0, kCGWindowListOptionIncludingWindow, windowNumber, kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution),
  );
  if (image === NIL) throw new Error(`capture: the window server gave no image for window ${windowNumber}`);
  try {
    const url = asId(sendPtr(cls("NSURL"), sel("fileURLWithPath:"), nsString(path)));
    const destination = BigInt(imageIO.CGImageDestinationCreateWithURL(url, nsString("public.png"), 1n, NIL));
    if (destination === NIL) throw new Error(`capture: cannot write ${path}`);
    try {
      imageIO.CGImageDestinationAddImage(destination, image, NIL);
      if (!imageIO.CGImageDestinationFinalize(destination)) throw new Error(`capture: writing ${path} failed`);
    } finally {
      CFRelease(destination);
    }
    return { width: Number(graphics.CGImageGetWidth(image)), height: Number(graphics.CGImageGetHeight(image)) };
  } finally {
    graphics.CGImageRelease(image);
  }
}
