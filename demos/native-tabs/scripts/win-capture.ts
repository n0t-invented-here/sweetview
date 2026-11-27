// A PNG of one of this process's own windows, as the compositor draws its
// inside: the strip and the page on show, WebView2's pixels included
// (PrintWindow with PW_RENDERFULLCONTENT). The window need not be in front,
// and nothing on screen is read but the window asked for.
//
// `captureScreen` is the other kind: the pixels of a piece of the screen,
// for what the window manager draws around a window (its border, its rounded
// corners, its shadow), which is not part of the window. It shows whatever
// is there, so it is only for a window known to be in front.

import { FFIType, dlopen, toArrayBuffer, type Pointer } from "bun:ffi";
import { deflateSync } from "node:zlib";
import { gdi32, user32 } from "@n1h/sweetview-native/win32/api";

const { u64, u32, i32 } = FFIType;
const windows = dlopen("user32.dll", {
  GetDC: { args: [u64], returns: u64 },
  ReleaseDC: { args: [u64, u64], returns: i32 },
  PrintWindow: { args: [u64, u64, u32], returns: i32 }, // (HWND, HDC, flags)
}).symbols;
const graphics = dlopen("gdi32.dll", {
  CreateCompatibleDC: { args: [u64], returns: u64 },
  SelectObject: { args: [u64, u64], returns: u64 },
  DeleteDC: { args: [u64], returns: i32 },
  // (HDC to, x, y, width, height, HDC from, fromX, fromY, DWORD operation)
  BitBlt: { args: [u64, i32, i32, i32, i32, u64, i32, i32, u32], returns: i32 },
}).symbols;

const PW_CLIENTONLY = 0x1; // the window's inside: no resize border, which this window keeps outside what is visible
const PW_RENDERFULLCONTENT = 0x2; // what DirectComposition draws too: the webviews

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "ascii"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGB PNG from top-down BGRA rows. */
function png(width: number, height: number, bgra: Uint8Array): Uint8Array {
  const rows = new Uint8Array(height * (1 + width * 3)); // each row: filter byte 0, then RGB
  for (let y = 0, to = 0, from = 0; y < height; y++) {
    to++;
    for (let x = 0; x < width; x++, from += 4) {
      rows[to++] = bgra[from + 2]!;
      rows[to++] = bgra[from + 1]!;
      rows[to++] = bgra[from]!;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array(0))]);
}

const SRCCOPY = 0x00cc0020;

/** Writes a PNG of the inside of a window (an HWND) and returns its size in pixels. */
export async function captureWindow(hwnd: bigint, path: string): Promise<{ width: number; height: number }> {
  const size = new Int32Array(4);
  user32.GetClientRect(hwnd, size);
  if (size[2]! <= 0 || size[3]! <= 0) throw new Error("capture: the window has no inside (minimised?)");
  return draw(size[2]!, size[3]!, path, (memory) => windows.PrintWindow(hwnd, memory, PW_CLIENTONLY | PW_RENDERFULLCONTENT) !== 0);
}

/** Writes a PNG of a rectangle of the screen, in pixels, as it looks right now. */
export function captureScreen(area: { x: number; y: number; width: number; height: number }, path: string): Promise<{ width: number; height: number }> {
  return draw(area.width, area.height, path, (memory, screen) => graphics.BitBlt(memory, 0, 0, area.width, area.height, screen, area.x, area.y, SRCCOPY) !== 0);
}

/** A bitmap of that size, filled by `paint`, written as a PNG. */
async function draw(width: number, height: number, path: string, paint: (memory: bigint, screen: bigint) => boolean): Promise<{ width: number; height: number }> {
  // BITMAPINFOHEADER for 32 bits a pixel, top-down (a negative height)
  const info = new Uint8Array(40);
  const view = new DataView(info.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, -height, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  const bits = new BigUint64Array(1);
  const screen = windows.GetDC(0n);
  const memory = graphics.CreateCompatibleDC(screen);
  const bitmap = gdi32.CreateDIBSection(memory, info, 0, bits, 0n, 0);
  try {
    if (bitmap === 0n || bits[0] === 0n) throw new Error("capture: CreateDIBSection failed");
    const before = graphics.SelectObject(memory, bitmap);
    const drawn = paint(memory, screen);
    graphics.SelectObject(memory, before);
    if (!drawn) throw new Error("capture: the window or screen could not be drawn");
    const pixels = new Uint8Array(toArrayBuffer(Number(bits[0]) as Pointer, 0, width * height * 4)).slice(); // a copy: the section goes below
    await Bun.write(path, png(width, height, pixels));
    return { width, height };
  } finally {
    if (bitmap !== 0n) gdi32.DeleteObject(bitmap);
    graphics.DeleteDC(memory);
    windows.ReleaseDC(0n, screen);
  }
}
