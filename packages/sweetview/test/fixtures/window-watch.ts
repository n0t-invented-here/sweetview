// A watcher in a process of its own: what the user sees of another process's
// top-level windows, sampled as fast as the screen can be read, from before
// they appear until the process has exited. For each visible window of the
// process, each sample records whether it exists, is visible, cloaked or
// minimised, how many webview containers (`WRY_WEBVIEW`) it holds, and what
// its client area shows on the screen: the most common colour (to 3 bits per
// channel less) and the share of the area in it, read with BitBlt from the
// screen. It injects no input and changes nothing.
//
//   bun window-watch.ts <pid> <out.jsonl> [maxMs] [#backstop]
//
// It prints `WATCHING` once it runs, then writes one JSON line per sample to
// `out.jsonl` and prints `DONE <samples>` when the process has gone (or after
// `maxMs`, default 60 s). `summarize` reads such a file; the tests and the
// measurement of decision D49 use it.

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
  /** Webview containers anywhere under it (`WRY_WEBVIEW`, or `webview_widget`): the webviews mounted in it. */
  webviews: number;
  width: number;
  height: number;
  /** The client area's most common colour, `[r, g, b]`, and the share of it (0 to 1). */
  mode: [number, number, number];
  flat: number;
  /** The client area's top-left corner on the screen. */
  left?: number;
  top?: number;
  /**
   * Whether the pixels read are this window's. A read of the screen waits for the next
   * composition, so what is known of the window just before it can be older than the pixels
   * (D49). Before the read the window was visible and the OS named it (its root) as the window
   * at five points of its client area (the centre and four points near the corners); then:
   * still so after the read, the pixels are its own; gone from there after the read (hidden or
   * destroyed meanwhile), the same rectangle is read again once the window is off the screen,
   * and the pixels are its own unless they are what was behind it (`behind`). Another window
   * named at any point before the read: not its own.
   */
  ours?: boolean;
  /** For a read the window left the screen during: that rectangle read again with the window off it. */
  behind?: { mode: [number, number, number]; flat: number };
  /** What the OS named at those points when it was not this window: `title [class] pid`, before or after. */
  coveredBy?: string[];
  /** Visible, not cloaked and not minimised when read again after the screen was. */
  visibleAfter?: boolean;
  /** The wall clock (`Date.now()`) when the read began, to set it beside what other processes log. */
  at?: number;
  /**
   * Who owns the pixels at two points of the client area (its centre, `page`, and 8 pixels below
   * its top edge, `top`): the windows from this one down to the deepest visible child there
   * (`ChildWindowFromPointEx`), each `class pid #handle left,top widthxheight`, outermost first.
   */
  owners?: { page: string[]; top: string[] };
  /**
   * Every window under this one when the read was made, only with `SWEETVIEW_WATCH_OWNERS=1`:
   * each `class #handle visible|hidden`, in `EnumChildWindows` order. When each webview's windows
   * appear, and when each is shown, is read from it.
   */
  tree?: string[];
  /** A read that cannot be judged: a call of the capture failed (`GetClientRect`, `ClientToScreen`, `BitBlt`, `GetDIBits`); what it failed at. */
  failed?: string;
  /** The display's refresh rate when the read was made, in hertz. */
  hz?: number;
  /** With a backstop given: whether the client area lies inside it. */
  insideBackstop?: boolean;
};

/** On the screen: visible, not cloaked by DWM, not minimised, with a client area. */
export const onScreen = (s: Sample) => s.exists && s.visible && !s.cloaked && !s.iconic && s.width > 0 && s.height > 0;
/** On the screen, and the pixels read are its own (see `Sample.ours`). */
export const seen = (s: Sample) => onScreen(s) && s.ours === true;
const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** A client area seen to be one colour (at least 90 % of it), light (luma at least 200). */
export const flatLight = (s: Sample) => seen(s) && s.flat >= 0.9 && luma(s.mode) >= 200;

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
  const [pidArg, out, maxArg, backstopArg] = process.argv.slice(2);
  // The colour of what is behind the watched windows, when the caller put it there: a read that
  // shows it shows what is behind, not the window.
  const backstop = backstopArg ? ([1, 3, 5].map((i) => Number.parseInt(backstopArg.slice(i, i + 2), 16) & 0xf8) as [number, number, number]) : undefined;
  // `#rrggbb@x,y,w,h`: the backstop's rectangle on the screen, which the watched windows must lie inside.
  const backstopRect = backstopArg?.includes("@") ? backstopArg.split("@")[1]!.split(",").map(Number) : undefined;
  const isBackstop = (mode: [number, number, number]) => backstop !== undefined && mode.every((v, i) => Math.abs(v - backstop[i]!) <= 8);
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
    // (POINT by value, packed x | y << 32) -> HWND
    WindowFromPoint: { args: [u64], returns: u64 },
    GetAncestor: { args: [u64, u32], returns: u64 },
    // (HWND parent, POINT by value in its client coordinates, flags) -> HWND
    ChildWindowFromPointEx: { args: [u64, u64, u32], returns: u64 },
    ScreenToClient: { args: [u64, FFIType.ptr], returns: i32 },
    GetWindowRect: { args: [u64, FFIType.ptr], returns: i32 },
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
  let tree: string[] | undefined;
  const enumChild = new JSCallback(
    (hwnd: bigint) => {
      const name = read(user32.GetClassNameW, hwnd);
      if (name === "WRY_WEBVIEW" || name === "webview_widget") webviewCount++;
      tree?.push(`${name} #${hwnd.toString(16)} ${user32.IsWindowVisible(hwnd) !== 0 ? "visible" : "hidden"}`);
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

  /** A rectangle of the screen: its most common colour and the share of it. */
  const capture = (left: number, top: number, width: number, height: number): { width: number; height: number; mode: [number, number, number]; flat: number; failed?: string } => {
    if (width <= 0 || height <= 0) return { width: 0, height: 0, mode: [0, 0, 0], flat: 0 };
    const origin = [left, top];
    if (bitmapSize[0] !== width || bitmapSize[1] !== height) {
      if (bitmap !== 0n) gdi32.DeleteObject(bitmap);
      bitmap = gdi32.CreateCompatibleBitmap(screen, width, height);
      bitmapSize = [width, height];
      pixels = new Uint8Array(width * height * 4);
    }
    if (bitmap === 0n) return { width, height, mode: [0, 0, 0], flat: 0, failed: "CreateCompatibleBitmap" };
    const old = gdi32.SelectObject(memory, bitmap);
    const blitted = gdi32.BitBlt(memory, 0, 0, width, height, screen, origin[0]!, origin[1]!, SRCCOPY);
    gdi32.SelectObject(memory, old);
    // A failed copy would leave the last read's pixels in the bitmap: it is not a read.
    if (blitted === 0) return { width, height, mode: [0, 0, 0], flat: 0, failed: "BitBlt" };
    info.fill(0);
    infoView.setUint32(0, 40, true);
    infoView.setInt32(4, width, true);
    infoView.setInt32(8, -height, true);
    infoView.setUint16(12, 1, true);
    infoView.setUint16(14, 32, true);
    if (gdi32.GetDIBits(memory, bitmap, 0, height, ptr(pixels), ptr(info), 0) !== height) return { width, height, mode: [0, 0, 0], flat: 0, failed: "GetDIBits" };
    histogram.fill(0);
    let total = 0;
    for (let y = 1; y < height; y += 4) {
      for (let x = 1; x < width; x += 4) {
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

  const GA_ROOT = 2;
  /** Reads that the window left the screen during, waiting for the read of what was behind them. */
  const unresolved = new Map<bigint, Sample>();
  const resolve = (sample: Sample) => {
    // With a backstop the answer is certain: the read shows the window unless it shows the
    // backstop. Without one, the rectangle is read again, and the read is the window's unless it
    // shows the same; DWM can still show a window just gone, so that answer is the weaker one.
    if (backstop) {
      sample.ours = !(isBackstop(sample.mode) && sample.flat >= 0.5);
      return;
    }
    const again = capture(sample.left!, sample.top!, sample.width, sample.height);
    sample.behind = { mode: again.mode, flat: again.flat };
    const same = again.mode.every((v, i) => Math.abs(v - sample.mode[i]!) <= 8) && Math.abs(again.flat - sample.flat) <= 0.05;
    sample.ours = !same;
  };
  const CWP_SKIPINVISIBLE = 1;
  const levelRect = new Int32Array(4);
  /** The windows from `hwnd` down to the deepest visible child at a screen point, each `class pid`. */
  const chain = (hwnd: bigint, x: number, y: number): string[] => {
    const levels: string[] = [];
    const point = new Int32Array(2);
    for (let at = hwnd, depth = 0; at !== 0n && depth < 8; depth++) {
      user32.GetWindowThreadProcessId(at, ptr(pidBuf));
      user32.GetWindowRect(at, ptr(levelRect));
      levels.push(`${read(user32.GetClassNameW, at)} ${pidBuf[0]} #${at.toString(16)} ${levelRect[0]},${levelRect[1]} ${levelRect[2]! - levelRect[0]!}x${levelRect[3]! - levelRect[1]!}`);
      point[0] = x;
      point[1] = y;
      user32.ScreenToClient(at, ptr(point));
      const next = user32.ChildWindowFromPointEx(at, BigInt.asUintN(32, BigInt(point[0]!)) | (BigInt.asUintN(32, BigInt(point[1]!)) << 32n), CWP_SKIPINVISIBLE);
      if (next === 0n || next === at) break;
      at = next;
    }
    return levels;
  };

  /**
   * The windows above `hwnd` in the z-order that overlap any part of its client area: visible,
   * not cloaked, not minimised; each described. Every top-level window is enumerated, in z-order
   * from the top, so a partial cover anywhere counts, not only at chosen points.
   */
  const zOrder: bigint[] = [];
  const enumAll = new JSCallback(
    (window: bigint) => {
      zOrder.push(window);
      return 1;
    },
    { args: [u64, i64], returns: i32 },
  );
  const otherRect = new Int32Array(4);
  const otherCloaked = new Uint32Array(1);
  const others = (hwnd: bigint, left: number, top: number, width: number, height: number): string[] => {
    zOrder.length = 0;
    user32.EnumWindows(enumAll.ptr, 0n);
    const found: string[] = [];
    for (const window of zOrder) {
      if (window === hwnd) break;
      // The cheap questions first: most windows above are hidden or elsewhere, and the walk must
      // leave a read within one refresh of the last.
      if (user32.IsWindowVisible(window) === 0) continue;
      if (user32.GetWindowRect(window, ptr(otherRect)) === 0) continue;
      const overlaps = otherRect[0]! < left + width && otherRect[2]! > left && otherRect[1]! < top + height && otherRect[3]! > top;
      if (!overlaps || user32.IsIconic(window) !== 0) continue;
      otherCloaked[0] = 0;
      dwmapi.DwmGetWindowAttribute(window, 14, ptr(otherCloaked), 4);
      if (otherCloaked[0] !== 0) continue;
      user32.GetWindowThreadProcessId(window, ptr(pidBuf));
      found.push(`${read(user32.GetWindowTextW, window)} [${read(user32.GetClassNameW, window)}] ${pidBuf[0]}`);
    }
    return found;
  };
  const gdiCaps = dlopen("gdi32.dll", { GetDeviceCaps: { args: [u64, i32], returns: i32 } }).symbols;

  // The last state written for each window: a window off the screen is written only when it changes.
  const known = new Map<bigint, string>();
  const records: Sample[] = [];
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
      const sample: Sample = { t: Math.round(t * 10) / 10, at: Date.now(), hwnd: String(hwnd), title: "", exists, visible: false, cloaked: false, iconic: false, webviews: 0, width: 0, height: 0, mode: [0, 0, 0], flat: 0 };
      if (exists) {
        sample.title = read(user32.GetWindowTextW, hwnd);
        sample.visible = user32.IsWindowVisible(hwnd) !== 0;
        sample.iconic = user32.IsIconic(hwnd) !== 0;
        cloakedBuf[0] = 0;
        dwmapi.DwmGetWindowAttribute(hwnd, 14, ptr(cloakedBuf), 4); // DWMWA_CLOAKED
        sample.cloaked = cloakedBuf[0] !== 0;
        webviewCount = 0;
        tree = process.env.SWEETVIEW_WATCH_OWNERS === "1" ? [] : undefined;
        user32.EnumChildWindows(hwnd, enumChild.ptr, 0n);
        sample.webviews = webviewCount;
        if (tree) sample.tree = tree;
        if (sample.visible && !sample.cloaked && !sample.iconic) {
          // Whose pixels these are is asked before the screen is read and again after it.
          const origin = new Int32Array(2);
          if (user32.GetClientRect(hwnd, ptr(rect)) === 0) sample.failed = "GetClientRect";
          else if (user32.ClientToScreen(hwnd, ptr(origin)) === 0) sample.failed = "ClientToScreen";
          const [left, top, width, height] = [origin[0]!, origin[1]!, rect[2]! - rect[0]!, rect[3]! - rect[1]!];
          const before = others(hwnd, left, top, width, height);
          sample.hz = gdiCaps.GetDeviceCaps(screen, 116); // VREFRESH
          if (sample.failed === undefined) Object.assign(sample, capture(left, top, width, height));
          if (backstopRect) {
            const [bx, by, bw, bh] = backstopRect as [number, number, number, number];
            sample.insideBackstop = left >= bx && top >= by && left + width <= bx + bw && top + height <= by + bh;
          }
          [sample.left, sample.top] = [left, top];
          cloakedBuf[0] = 0;
          dwmapi.DwmGetWindowAttribute(hwnd, 14, ptr(cloakedBuf), 4);
          sample.visibleAfter = user32.IsWindow(hwnd) !== 0 && user32.IsWindowVisible(hwnd) !== 0 && cloakedBuf[0] === 0 && user32.IsIconic(hwnd) === 0;
          const moved = (() => {
            if (!sample.visibleAfter) return false;
            const now = new Int32Array(2);
            user32.ClientToScreen(hwnd, ptr(now));
            return now[0] !== left || now[1] !== top;
          })();
          const after = sample.visibleAfter ? others(hwnd, left, top, width, height) : [];
          sample.coveredBy = [...new Set([...before, ...after])];
          // Who owns the pixels, only when asked (SWEETVIEW_WATCH_OWNERS=1): walking the windows takes
          // time a read needs to stay within one refresh of the last.
          if (process.env.SWEETVIEW_WATCH_OWNERS === "1") sample.owners = { page: chain(hwnd, left + Math.floor(width / 2), top + Math.floor(height / 2)), top: chain(hwnd, left + Math.floor(width / 2), top + 8) };
          if (before.length > 0 || moved) sample.ours = false;
          // A window that shows the backstop over half of it shows what is behind it, not itself.
          else if (isBackstop(sample.mode) && sample.flat >= 0.5) sample.ours = false;
          else if (sample.visibleAfter) sample.ours = after.length === 0;
          else unresolved.set(hwnd, sample); // decided by what is behind, once the window is off the screen
        }
      }
      const pending = unresolved.get(hwnd);
      if (pending && pending !== sample && !onScreen(sample)) {
        resolve(pending);
        unresolved.delete(hwnd);
      }
      const state = `${sample.exists} ${sample.visible} ${sample.cloaked} ${sample.iconic} ${sample.webviews}`;
      if (!onScreen(sample) && known.get(hwnd) === state) continue;
      known.set(hwnd, state);
      records.push(sample);
    }
    if (exited() || t > maxMs) break;
  }
  // One last look once the process has gone, and what was behind the reads still undecided.
  for (const sample of unresolved.values()) resolve(sample);
  for (const hwnd of known.keys()) records.push({ t: Math.round((performance.now() - started) * 10) / 10, hwnd: String(hwnd), title: "", exists: user32.IsWindow(hwnd) !== 0, visible: false, cloaked: false, iconic: false, webviews: 0, width: 0, height: 0, mode: [0, 0, 0], flat: 0 });
  const lines = records.map((record) => JSON.stringify(record));
  writeFileSync(out, lines.join("\n") + "\n");
  if (bitmap !== 0n) gdi32.DeleteObject(bitmap);
  gdi32.DeleteDC(memory);
  user32.ReleaseDC(0n, screen);
  if (process_ !== 0n) kernel32.CloseHandle(process_);
  enumTop.close();
  enumChild.close();
  console.log(`DONE ${lines.length}`);
}
