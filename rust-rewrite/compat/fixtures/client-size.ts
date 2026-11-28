// Part A rows `width` and `height` of `WebviewAppOptions`, run for real. In 0.x they were the
// page's client size in DIPs, which the webview library applied to the window (its own, or the one
// given as `window`, sizing a frame around it). Now `bounds` is the window's outer frame in physical
// pixels: a framed window's client area is smaller by the frame, a frameless one's is the same.
// `app.webview.raw.size = { width, height, hint }` on the webview of `createApp` still sets the
// client size in DIPs as the library did (`SizeHint.NONE` keeps the window resizable, `FIXED` makes
// it fixed), without moving or showing the window, and the page fills the new client area.
// Prints one JSON line.

import { SizeHint, createApp } from "@n1h/sweetview";
import { ptr } from "bun:ffi";
import { user32, windowRect } from "../../../packages/sweetview-native/test/win32-os";

const GWL_STYLE = -16;
const GW_CHILD = 5;
const WS_THICKFRAME = 0x00040000;
const page = { "index.html": new TextEncoder().encode("<!doctype html><title>compat size</title>") };
const bounds = { x: 150, y: 150, width: 800, height: 600 };

function clientSize(hwnd: bigint): { width: number; height: number } {
  const rect = new Int32Array(4);
  user32.GetClientRect(hwnd, ptr(rect));
  return { width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! };
}
const size = (r: { left: number; top: number; right: number; bottom: number }) => ({ width: r.right - r.left, height: r.bottom - r.top });
const resizable = (hwnd: bigint) => (Number(user32.GetWindowLongPtrW(hwnd, GWL_STYLE)) & WS_THICKFRAME) !== 0;
// The library's scaling, which the binding keeps: MulDiv(value, dpi, 96), rounded.
const toDpi = (value: number, dpi: number) => Math.floor((value * dpi + 48) / 96);

const report: Record<string, unknown> = {};

// A framed window: bounds is the outer frame; the client area is smaller.
const framed = await createApp({ title: "sweetview compat size: framed", bounds, noActivate: true, assets: page });
const framedHwnd = BigInt(framed.window.handle!);
const dpi = Math.round(framed.window.scale() * 96);
const outer = framed.window.bounds();
const before = clientSize(framedHwnd);
report.framedBoundsAreOuter = JSON.stringify(outer) === JSON.stringify(bounds) && before.width < bounds.width && before.height < bounds.height;

// raw.size with SizeHint.NONE: the client area is width x height DIPs; still resizable, not moved, not shown.
framed.webview!.raw.size = { width: 500, height: 300, hint: SizeHint.NONE };
const after = clientSize(framedHwnd);
const moved = framed.window.bounds();
report.sizeNoneSetsClientDips = after.width === toDpi(500, dpi) && after.height === toDpi(300, dpi);
report.sizeNoneKeepsResizable = resizable(framedHwnd);
report.sizeKeepsTopLeft = moved.x === bounds.x && moved.y === bounds.y;
report.sizeDoesNotShow = !framed.window.isVisible();
const child = user32.GetWindow(framedHwnd, GW_CHILD);
report.pageFillsClient = child !== 0n && JSON.stringify(size(windowRect(child))) === JSON.stringify(after);

// raw.size with SizeHint.FIXED: the same client size, and the window is no longer resizable.
framed.webview!.raw.size = { width: 420, height: 260, hint: SizeHint.FIXED };
const fixed = clientSize(framedHwnd);
report.sizeFixedSetsClientDips = fixed.width === toDpi(420, dpi) && fixed.height === toDpi(260, dpi);
report.sizeFixedNotResizable = !resizable(framedHwnd);
framed.dispose();

// A frameless window: bounds is the page's size too (outer frame and client area are the same).
const frameless = await createApp({ title: "sweetview compat size: frameless", bounds, frame: false, noActivate: true, assets: page });
report.framelessClientIsBounds = JSON.stringify(clientSize(BigInt(frameless.window.handle!))) === JSON.stringify({ width: bounds.width, height: bounds.height });
frameless.dispose();

console.log(JSON.stringify(report));
process.exit(0);
