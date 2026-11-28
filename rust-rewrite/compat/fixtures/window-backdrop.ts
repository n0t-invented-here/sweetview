// "What changed for every application", the window's backdrop: a window with no `backgroundColor`,
// neither `transparent` nor colour-keyed, paints its appearance's page colour (#15161a dark,
// #f9f9fb light) where nothing covers it, where it painted white before. What the window paints
// is read without the screen: the window is asked to erase its background (WM_ERASEBKGND) into a
// memory bitmap, and the bitmap's pixel is read. The bitmap starts magenta, so a window that
// paints nothing reads magenta. Prints one JSON line.

import { FFIType, dlopen } from "bun:ffi";
import { Window } from "@n1h/sweetview/native";
import { user32 } from "../../../packages/sweetview-native/test/win32-os";

const gdi = dlopen("gdi32.dll", {
  CreateCompatibleDC: { args: [FFIType.u64], returns: FFIType.u64 },
  CreateCompatibleBitmap: { args: [FFIType.u64, FFIType.i32, FFIType.i32], returns: FFIType.u64 },
  SelectObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  SetPixel: { args: [FFIType.u64, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.u32 },
  GetPixel: { args: [FFIType.u64, FFIType.i32, FFIType.i32], returns: FFIType.u32 },
  DeleteObject: { args: [FFIType.u64], returns: FFIType.i32 },
  DeleteDC: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols;
const WM_ERASEBKGND = 0x0014;
const MAGENTA = 0x00ff00ff;

/** The colour the window erases its background with, `#rrggbb`; `#ff00ff` when it paints nothing. */
function erased(win: Window): string {
  const screen = user32.GetDC(0n);
  const dc = gdi.CreateCompatibleDC(screen);
  const bitmap = gdi.CreateCompatibleBitmap(screen, 8, 8);
  user32.ReleaseDC(0n, screen);
  const old = gdi.SelectObject(dc, bitmap);
  gdi.SetPixel(dc, 2, 2, MAGENTA);
  user32.SendMessageW(BigInt(win.handle as bigint | number), WM_ERASEBKGND, dc, 0n);
  const bgr = gdi.GetPixel(dc, 2, 2);
  gdi.SelectObject(dc, old);
  gdi.DeleteObject(bitmap);
  gdi.DeleteDC(dc);
  const [r, g, b] = [bgr & 0xff, (bgr >> 8) & 0xff, (bgr >> 16) & 0xff];
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

const bounds = { x: 160, y: 160, width: 320, height: 240 };
const make = (title: string, extra: Record<string, unknown>) => new Window({ title: `sweetview compat backdrop: ${title}`, bounds, noActivate: true, ...extra });
const report: Record<string, string> = {};
for (const [name, extra] of [
  ["dark", { appearance: "dark" }],
  ["light", { appearance: "light" }],
  ["backgroundColor", { appearance: "dark", backgroundColor: "#336699" }],
  ["transparent", { appearance: "dark", transparent: true }],
] as const) {
  const win = make(name, extra);
  report[name] = erased(win);
  win.dispose();
}
console.log(JSON.stringify(report));
process.exit(0);
