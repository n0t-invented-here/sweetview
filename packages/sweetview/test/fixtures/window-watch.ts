// A watcher in a process of its own: what the user sees of another process's
// top-level windows, sampled as fast as the screen can be read, from before
// they appear until the process has exited. For each visible window of the
// process, each sample records whether it exists, is visible, cloaked or
// minimised, how many webview containers (`WRY_WEBVIEW`) it holds, and what
// its client area shows on the screen: the most common colour (to 3 bits per
// channel less) and the share of the area in it, read with BitBlt from the
// screen. It injects no input and changes nothing.
//
//   bun window-watch.ts <pid> <out.jsonl> [maxMs]
//
// It prints `WATCHING` once it runs, then writes one JSON line per sample to
// `out.jsonl` and prints `DONE <samples>` when the process has gone (or after
// `maxMs`, default 60 s). `summarize` reads such a file; the tests and the
// measurement of decision D42 use it.

import { FFIType, JSCallback, dlopen, ptr } from "bun:ffi";
import { writeFileSync } from "node:fs";

const { u64, u32, i32, i64 } = FFIType;

export type Sample = {
  /** Milliseconds since the watcher started. */
  t: number;
  hwnd: string;
  title: string;
  exists: boolean;
  visible: boolean;
  cloaked: boolean;
  iconic: boolean;
  /** `WRY_WEBVIEW` windows anywhere under it: the webviews mounted in it. */
  webviews: number;
  width: number;
  height: number;
  /** The client area's most common colour, `[r, g, b]`, and the share of it (0 to 1). */
  mode: [number, number, number];
  flat: number;
};

/** On the screen: visible, not cloaked by DWM, not minimised, with a client area. */
export const onScreen = (s: Sample) => s.exists && s.visible && !s.cloaked && !s.iconic && s.width > 0 && s.height > 0;
const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** A client area that is one colour (at least 90 % of it), light (luma at least 200). */
export const flatLight = (s: Sample) => onScreen(s) && s.flat >= 0.9 && luma(s.mode) >= 200;

export type Run = { count: number; ms: number; from: number };
export type WindowSummary = {
  hwnd: string;
  title: string;
  samples: number;
  onScreen: number;
  /** Samples on the screen with a flat light client area, and the longest run of them. */
  flatLight: number;
  longestFlatLight: Run;
  /** Samples on the screen with no webview in it after one had been seen in it, and the longest run. */
  emptyAfterWebview: number;
  longestEmptyAfterWebview: Run;
  /** Samples on the screen before any webview was seen in it. */
  beforeWebview: number;
  firstOnScreen: number | null;
  lastOnScreen: number | null;
  /** The last sample in which it held a webview, and the first in which it no longer existed. */
  lastWebview: number | null;
  gone: number | null;
  /** What its client area showed in each sample on the screen, as `#rrggbb share` runs. */
  colours: string[];
};

/** Per window: how long it was on the screen flat and light, or empty after its webview went. */
export function summarize(samples: Sample[]): WindowSummary[] {
  const byWindow = new Map<string, Sample[]>();
  for (const s of samples) {
    let list = byWindow.get(s.hwnd);
    if (!list) byWindow.set(s.hwnd, (list = []));
    list.push(s);
  }
  const longest = (list: Sample[], test: (s: Sample, i: number) => boolean): Run => {
    let best: Run = { count: 0, ms: 0, from: -1 };
    let start = -1;
    for (let i = 0; i <= list.length; i++) {
      if (i < list.length && test(list[i]!, i)) {
        if (start < 0) start = i;
        continue;
      }
      if (start >= 0) {
        const count = i - start;
        const end = list[Math.min(i, list.length - 1)]!.t;
        const ms = end - list[start]!.t;
        if (count > best.count) best = { count, ms, from: list[start]!.t };
        start = -1;
      }
    }
    return best;
  };
  const hex = (c: [number, number, number]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return [...byWindow.values()].map((list) => {
    const firstWebview = list.findIndex((s) => s.webviews > 0);
    const empty = (s: Sample, i: number) => firstWebview >= 0 && i > firstWebview && onScreen(s) && s.webviews === 0;
    const shown = list.filter(onScreen);
    const colours: string[] = [];
    for (const s of shown) {
      const label = `${hex(s.mode)} ${s.flat.toFixed(2)}`;
      const last = colours.at(-1);
      if (last?.startsWith(label + " x")) colours[colours.length - 1] = `${label} x${Number(last.split(" x")[1]) + 1}`;
      else colours.push(`${label} x1`);
    }
    const lastWebview = list.findLast((s) => s.webviews > 0);
    return {
      hwnd: list[0]!.hwnd,
      title: list.findLast((s) => s.title)?.title ?? "",
      samples: list.length,
      onScreen: shown.length,
      flatLight: list.filter(flatLight).length,
      longestFlatLight: longest(list, flatLight),
      emptyAfterWebview: list.filter(empty).length,
      longestEmptyAfterWebview: longest(list, empty),
      beforeWebview: list.filter((s, i) => onScreen(s) && (firstWebview < 0 || i < firstWebview)).length,
      firstOnScreen: shown[0]?.t ?? null,
      lastOnScreen: shown.at(-1)?.t ?? null,
      lastWebview: lastWebview?.t ?? null,
      gone: list.find((s) => !s.exists)?.t ?? null,
      colours,
    };
  });
}

if (import.meta.main) {
  const [pidArg, out, maxArg] = process.argv.slice(2);
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0 || !out) {
    console.error("usage: bun window-watch.ts <pid> <out.jsonl> [maxMs]");
    process.exit(2);
  }
  const maxMs = Number(maxArg ?? 60_000);

  const user32 = dlopen("user32.dll", {
    SetProcessDpiAwarenessContext: { args: [i64], returns: i32 },
    EnumWindows: { args: [FFIType.ptr, i64], returns: i32 },
    EnumChildWindows: { args: [u64, FFIType.ptr, i64], returns: i32 },
    GetWindowThreadProcessId: { args: [u64, FFIType.ptr], returns: u32 },
    IsWindow: { args: [u64], returns: i32 },
    IsWindowVisible: { args: [u64], returns: i32 },
    IsIconic: { args: [u64], returns: i32 },
    GetClientRect: { args: [u64, FFIType.ptr], returns: i32 },
    ClientToScreen: { args: [u64, FFIType.ptr], returns: i32 },
    GetClassNameW: { args: [u64, FFIType.ptr, i32], returns: i32 },
    GetWindowTextW: { args: [u64, FFIType.ptr, i32], returns: i32 },
    GetWindow: { args: [u64, u32], returns: u64 },
    GetDC: { args: [u64], returns: u64 },
    ReleaseDC: { args: [u64, u64], returns: i32 },
  }).symbols;
  const gdi32 = dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: [u64], returns: u64 },
    CreateCompatibleBitmap: { args: [u64, i32, i32], returns: u64 },
    SelectObject: { args: [u64, u64], returns: u64 },
    BitBlt: { args: [u64, i32, i32, i32, i32, u64, i32, i32, u32], returns: i32 },
    GetDIBits: { args: [u64, u64, u32, u32, FFIType.ptr, FFIType.ptr, u32], returns: i32 },
    DeleteObject: { args: [u64], returns: i32 },
    DeleteDC: { args: [u64], returns: i32 },
  }).symbols;
  const dwmapi = dlopen("dwmapi.dll", {
    DwmGetWindowAttribute: { args: [u64, u32, FFIType.ptr, u32], returns: i32 },
  }).symbols;
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [u32, i32, u32], returns: u64 },
    WaitForSingleObject: { args: [u64, u32], returns: u32 },
    CloseHandle: { args: [u64], returns: i32 },
  }).symbols;

  // Physical pixels, as the windows of the watched process (per-monitor aware) report them.
  user32.SetProcessDpiAwarenessContext(-4n);
  const SYNCHRONIZE = 0x0010_0000;
  const process_ = kernel32.OpenProcess(SYNCHRONIZE, 0, pid);
  const exited = () => process_ === 0n || kernel32.WaitForSingleObject(process_, 0) === 0;

  const text = new Uint16Array(256);
  const read = (fn: (h: bigint, p: ReturnType<typeof ptr>, n: number) => number, hwnd: bigint) => {
    const n = fn(hwnd, ptr(text), text.length);
    return String.fromCharCode(...text.subarray(0, Math.max(0, n)));
  };
  const pidBuf = new Uint32Array(1);
  const found: bigint[] = [];
  const enumTop = new JSCallback(
    (hwnd: bigint) => {
      user32.GetWindowThreadProcessId(hwnd, ptr(pidBuf));
      if (pidBuf[0] === pid) found.push(hwnd);
      return 1;
    },
    { args: [u64, i64], returns: i32 },
  );
  let webviewCount = 0;
  const enumChild = new JSCallback(
    (hwnd: bigint) => {
      if (read(user32.GetClassNameW, hwnd) === "WRY_WEBVIEW") webviewCount++;
      return 1;
    },
    { args: [u64, i64], returns: i32 },
  );

  const screen = user32.GetDC(0n);
  const memory = gdi32.CreateCompatibleDC(screen);
  let bitmap = 0n;
  let bitmapSize = [0, 0];
  let pixels = new Uint8Array(0);
  const info = new Uint8Array(44);
  const infoView = new DataView(info.buffer);
  const histogram = new Uint32Array(1 << 15);
  const SRCCOPY = 0x00cc0020;
  const CAPTUREBLT = 0x40000000;

  /** The client area on the screen: its most common colour and the share of it. */
  const capture = (hwnd: bigint, rect: Int32Array): { width: number; height: number; mode: [number, number, number]; flat: number } => {
    user32.GetClientRect(hwnd, ptr(rect));
    const width = rect[2]! - rect[0]!;
    const height = rect[3]! - rect[1]!;
    if (width <= 0 || height <= 0) return { width: 0, height: 0, mode: [0, 0, 0], flat: 0 };
    const origin = new Int32Array(2);
    user32.ClientToScreen(hwnd, ptr(origin));
    if (bitmapSize[0] !== width || bitmapSize[1] !== height) {
      if (bitmap !== 0n) gdi32.DeleteObject(bitmap);
      bitmap = gdi32.CreateCompatibleBitmap(screen, width, height);
      bitmapSize = [width, height];
      pixels = new Uint8Array(width * height * 4);
    }
    const old = gdi32.SelectObject(memory, bitmap);
    gdi32.BitBlt(memory, 0, 0, width, height, screen, origin[0]!, origin[1]!, SRCCOPY | CAPTUREBLT);
    gdi32.SelectObject(memory, old);
    info.fill(0);
    infoView.setUint32(0, 40, true);
    infoView.setInt32(4, width, true);
    infoView.setInt32(8, -height, true);
    infoView.setUint16(12, 1, true);
    infoView.setUint16(14, 32, true);
    gdi32.GetDIBits(memory, bitmap, 0, height, ptr(pixels), ptr(info), 0);
    histogram.fill(0);
    let total = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        histogram[((pixels[i + 2]! >> 3) << 10) | ((pixels[i + 1]! >> 3) << 5) | (pixels[i]! >> 3)]!++;
        total++;
      }
    }
    let best = 0;
    for (let bin = 1; bin < histogram.length; bin++) if (histogram[bin]! > histogram[best]!) best = bin;
    const mode: [number, number, number] = [((best >> 10) & 31) << 3, ((best >> 5) & 31) << 3, (best & 31) << 3];
    return { width, height, mode, flat: histogram[best]! / total };
  };

  const known = new Map<bigint, string>();
  const lines: string[] = [];
  const started = performance.now();
  const rect = new Int32Array(4);
  const cloakedBuf = new Uint32Array(1);
  console.log("WATCHING");
  let lastEnum = -1;
  for (;;) {
    const t = performance.now() - started;
    if (t - lastEnum >= 5) {
      found.length = 0;
      user32.EnumWindows(enumTop.ptr, 0n);
      for (const hwnd of found) if (!known.has(hwnd) && user32.IsWindowVisible(hwnd)) known.set(hwnd, "");
      lastEnum = t;
    }
    for (const hwnd of known.keys()) {
      const exists = user32.IsWindow(hwnd) !== 0;
      const sample: Sample = { t: Math.round(t * 10) / 10, hwnd: String(hwnd), title: "", exists, visible: false, cloaked: false, iconic: false, webviews: 0, width: 0, height: 0, mode: [0, 0, 0], flat: 0 };
      if (exists) {
        sample.title = read(user32.GetWindowTextW, hwnd);
        sample.visible = user32.IsWindowVisible(hwnd) !== 0;
        sample.iconic = user32.IsIconic(hwnd) !== 0;
        cloakedBuf[0] = 0;
        dwmapi.DwmGetWindowAttribute(hwnd, 14, ptr(cloakedBuf), 4); // DWMWA_CLOAKED
        sample.cloaked = cloakedBuf[0] !== 0;
        webviewCount = 0;
        user32.EnumChildWindows(hwnd, enumChild.ptr, 0n);
        sample.webviews = webviewCount;
        if (sample.visible && !sample.cloaked && !sample.iconic) Object.assign(sample, capture(hwnd, rect));
      }
      lines.push(JSON.stringify(sample));
    }
    if (exited() || t > maxMs) break;
  }
  // One last look once the process has gone.
  for (const hwnd of known.keys()) lines.push(JSON.stringify({ t: Math.round((performance.now() - started) * 10) / 10, hwnd: String(hwnd), title: "", exists: user32.IsWindow(hwnd) !== 0, visible: false, cloaked: false, iconic: false, webviews: 0, width: 0, height: 0, mode: [0, 0, 0], flat: 0 }));
  writeFileSync(out, lines.join("\n") + "\n");
  if (bitmap !== 0n) gdi32.DeleteObject(bitmap);
  gdi32.DeleteDC(memory);
  user32.ReleaseDC(0n, screen);
  if (process_ !== 0n) kernel32.CloseHandle(process_);
  enumTop.close();
  enumChild.close();
  console.log(`DONE ${lines.length}`);
}
