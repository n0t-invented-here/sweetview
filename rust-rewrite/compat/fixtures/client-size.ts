// Part A rows `width` and `height` of `WebviewAppOptions`, run for real. In 0.x they were the
// page's client size in DIPs. In 1.0 that is `contentSize: { width, height }`: the page area in
// DIPs at the window's scale, the window centred on the primary work area, the page filling it,
// and `resizable: false` for a fixed size. `bounds` is the window's outer frame in physical pixels:
// a framed window's client area is smaller by the frame, a frameless one's is the same; the two
// options cannot both be given. Prints one JSON line.

import { createApp } from "@n1h/sweetview";
import { Screen } from "@n1h/sweetview/native";
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
/** Within one physical pixel of `dips` at `scale` (the rounding of a fractional scale). */
const near = (pixels: number, dips: number, scale: number) => Math.abs(pixels - dips * scale) <= 1;

const report: Record<string, unknown> = {};

// bounds: the outer frame of a framed window; the client area is smaller.
const framed = await createApp({ title: "sweetview compat size: framed", bounds, noActivate: true, assets: page });
const outer = framed.window.bounds();
const before = clientSize(BigInt(framed.window.handle!));
report.framedBoundsAreOuter = JSON.stringify(outer) === JSON.stringify(bounds) && before.width < bounds.width && before.height < bounds.height;
framed.dispose();

// contentSize: the page area in DIPs, centred on the primary work area, resizable, not shown, the page filling it.
const sized = await createApp({ title: "sweetview compat size: content", contentSize: { width: 500, height: 300 }, noActivate: true, assets: page });
const sizedHwnd = BigInt(sized.window.handle!);
const scale = sized.window.scale();
const client = clientSize(sizedHwnd);
report.contentSizeIsClientDips = near(client.width, 500, scale) && near(client.height, 300, scale);
const area = Screen.primary().workArea;
const placed = sized.window.bounds();
report.contentSizeIsCentred = Math.abs(placed.x + placed.width / 2 - (area.x + area.width / 2)) <= 1 && Math.abs(placed.y + placed.height / 2 - (area.y + area.height / 2)) <= 1;
report.contentSizeKeepsResizable = resizable(sizedHwnd);
report.contentSizeDoesNotShow = !sized.window.isVisible();
const child = user32.GetWindow(sizedHwnd, GW_CHILD);
report.pageFillsClient = child !== 0n && JSON.stringify(size(windowRect(child))) === JSON.stringify(client);
sized.dispose();

// contentSize with resizable: false: the same page area, and the window is not resizable.
const fixed = await createApp({ title: "sweetview compat size: fixed", contentSize: { width: 420, height: 260 }, resizable: false, noActivate: true, assets: page });
const fixedHwnd = BigInt(fixed.window.handle!);
const fixedClient = clientSize(fixedHwnd);
report.fixedContentSizeIsClientDips = near(fixedClient.width, 420, fixed.window.scale()) && near(fixedClient.height, 260, fixed.window.scale());
report.fixedNotResizable = !resizable(fixedHwnd);
fixed.dispose();

// bounds and contentSize together: refused.
let refused = "";
try {
  await createApp({ title: "sweetview compat size: both", bounds, contentSize: { width: 500, height: 300 }, noActivate: true, assets: page });
} catch (err) {
  refused = (err as Error).message;
}
report.boundsAndContentSizeRefused = refused === "sweetview: bounds and contentSize cannot both be given";

// A frameless window: bounds is the page's size too (outer frame and client area are the same).
const frameless = await createApp({ title: "sweetview compat size: frameless", bounds, frame: false, noActivate: true, assets: page });
report.framelessClientIsBounds = JSON.stringify(clientSize(BigInt(frameless.window.handle!))) === JSON.stringify({ width: bounds.width, height: bounds.height });
frameless.dispose();

console.log(JSON.stringify(report));
process.exit(0);
