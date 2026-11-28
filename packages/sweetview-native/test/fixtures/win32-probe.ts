// Probes of OS state Sweetview has no API for, for the webview fixtures: what
// a window's handle names (its text, client size, style, visibility, DPI, dark
// title bar), the colour of a pixel on the screen, a process's top-level
// window, the foreground, a message posted and a key tapped. Tests only; listed in
// rust-rewrite/ffi-allowlist.txt as a probe.

import { dlopen, FFIType, ptr } from "bun:ffi";

const user32 = dlopen("user32.dll", {
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  GetWindowTextW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetClientRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetWindowRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetWindowLongPtrW: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  GetDpiForWindow: { args: [FFIType.u64], returns: FFIType.u32 },
  PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
  SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  GetDC: { args: [FFIType.u64], returns: FFIType.u64 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  FindWindowExW: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
  ReleaseDC: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  BringWindowToTop: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols;
const kernel32 = dlopen("kernel32.dll", {
  GetCurrentThreadId: { args: [], returns: FFIType.u32 },
}).symbols;
const gdi32 = dlopen("gdi32.dll", {
  GetPixel: { args: [FFIType.u64, FFIType.i32, FFIType.i32], returns: FFIType.u32 },
}).symbols;
const dwmapi = dlopen("dwmapi.dll", {
  DwmGetWindowAttribute: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;
const advapi32 = dlopen("advapi32.dll", {
  RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
}).symbols;

export const WS_THICKFRAME = 0x0004_0000;
export const WS_MAXIMIZEBOX = 0x0001_0000;
export const WM_CLOSE = 0x0010;

const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
const h = (hwnd: number | bigint | null) => BigInt(hwnd ?? 0);

export const isWindow = (hwnd: number | bigint | null) => user32.IsWindow(h(hwnd)) !== 0;
export const isVisible = (hwnd: number | bigint | null) => user32.IsWindowVisible(h(hwnd)) !== 0;
export const dpi = (hwnd: number | bigint | null) => user32.GetDpiForWindow(h(hwnd)) || 96;
export const style = (hwnd: number | bigint | null) => Number(user32.GetWindowLongPtrW(h(hwnd), -16) & 0xffff_ffffn);

export function windowText(hwnd: number | bigint | null): string {
  const buffer = new Uint16Array(512);
  const length = user32.GetWindowTextW(h(hwnd), ptr(buffer), buffer.length);
  return String.fromCharCode(...buffer.subarray(0, length));
}

function rect(get: (hwnd: bigint, out: ReturnType<typeof ptr>) => number, hwnd: number | bigint | null) {
  const r = new Int32Array(4);
  get(h(hwnd), ptr(r));
  return { x: r[0]!, y: r[1]!, width: r[2]! - r[0]!, height: r[3]! - r[1]! };
}

/** The client area's size in physical pixels. */
export const clientSize = (hwnd: number | bigint | null) => {
  const { width, height } = rect(user32.GetClientRect, hwnd);
  return { width, height };
};

/** The outer frame in screen coordinates. */
export const windowRect = (hwnd: number | bigint | null) => rect(user32.GetWindowRect, hwnd);

/**
 * The window's tracking bounds as its own `WM_GETMINMAXINFO` answers, in
 * physical pixels of the outer frame: what the OS holds the user to when
 * they drag an edge.
 */
export function trackingBounds(hwnd: number | bigint | null) {
  const WM_GETMINMAXINFO = 0x0024;
  const info = new Int32Array(10);
  // Defaults, so an answer that leaves a field alone reads as "no bound".
  info.set([0, 0, 0, 0, 0, 0, 0, 0, 0x7fff, 0x7fff]);
  user32.SendMessageW(h(hwnd), WM_GETMINMAXINFO, 0n, BigInt(ptr(info)));
  return { minWidth: info[6]!, minHeight: info[7]!, maxWidth: info[8]!, maxHeight: info[9]! };
}

export const postMessage = (hwnd: number | bigint | null, message: number, wparam = 0n, lparam = 0n) => user32.PostMessageW(h(hwnd), message, wparam, lparam) !== 0;

/** The colour on the screen at a point, as `#rrggbb`. */
export function screenPixel(x: number, y: number): string {
  const dc = user32.GetDC(0n);
  try {
    const bgr = gdi32.GetPixel(dc, x, y);
    // CLR_INVALID: the point is outside what the screen shows; a colour read from nothing is no colour.
    if (bgr === 0xffffffff) throw new Error(`GetPixel(${x}, ${y}) failed: CLR_INVALID`);
    const [r, g, b] = [bgr & 0xff, (bgr >> 8) & 0xff, (bgr >> 16) & 0xff];
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  } finally {
    user32.ReleaseDC(0n, dc);
  }
}

/** Whether the window's title bar is drawn dark (`DWMWA_USE_IMMERSIVE_DARK_MODE`). */
export function darkTitleBar(hwnd: number | bigint | null): boolean {
  const value = new Int32Array(1);
  const hr = dwmapi.DwmGetWindowAttribute(h(hwnd), 20, ptr(value), 4);
  return hr === 0 && value[0] !== 0;
}

/** Whether the user chose dark mode for applications (`AppsUseLightTheme` is 0). */
export function systemUsesDarkApps(): boolean {
  const HKEY_CURRENT_USER = 0x8000_0001n;
  const RRF_RT_REG_DWORD = 0x10;
  const data = new Uint32Array(1);
  const size = new Uint32Array([4]);
  const status = advapi32.RegGetValueW(
    HKEY_CURRENT_USER,
    wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
    wide("AppsUseLightTheme"),
    RRF_RT_REG_DWORD,
    null,
    ptr(data),
    ptr(size),
  );
  return status === 0 && data[0] === 0;
}

/**
 * Asks for the foreground for `hwnd`; true when it has it afterwards. When the OS refuses it to a
 * background process, the ask is made again with this thread's input briefly attached to the
 * foreground window's thread (the documented way a cooperating thread may hand it over), and
 * detached at once.
 */
export function takeForeground(hwnd: number | bigint | null): boolean {
  user32.SetForegroundWindow(h(hwnd));
  if (user32.GetForegroundWindow() === h(hwnd)) return true;
  const foreground = user32.GetForegroundWindow();
  const theirs = foreground === 0n ? 0 : user32.GetWindowThreadProcessId(foreground, null);
  const ours = kernel32.GetCurrentThreadId();
  if (theirs === 0 || theirs === ours) return false;
  if (user32.AttachThreadInput(ours, theirs, 1) === 0) return false;
  try {
    user32.BringWindowToTop(h(hwnd));
    user32.SetForegroundWindow(h(hwnd));
  } finally {
    user32.AttachThreadInput(ours, theirs, 0);
  }
  return user32.GetForegroundWindow() === h(hwnd);
}

/**
 * Presses and releases one key, as one SendInput batch, only while `hwnd` is
 * the foreground window, so no other window on the shared desktop gets it and
 * the key is never left down. False when `hwnd` was not in the foreground.
 */
export function tapKey(hwnd: number | bigint | null, virtualKey: number): boolean {
  if (user32.GetForegroundWindow() !== h(hwnd)) return false;
  const INPUT_SIZE = 40; // sizeof(INPUT) on x64
  const inputs = new DataView(new ArrayBuffer(INPUT_SIZE * 2));
  for (const [i, up] of [[0, false], [1, true]] as const) {
    inputs.setUint32(i * INPUT_SIZE, 1, true); // INPUT_KEYBOARD
    inputs.setUint16(i * INPUT_SIZE + 8, virtualKey, true);
    inputs.setUint32(i * INPUT_SIZE + 12, up ? 0x0002 : 0, true); // KEYEVENTF_KEYUP
  }
  return user32.SendInput(2, ptr(inputs.buffer), INPUT_SIZE) === 2;
}

/** The first top-level window, of any process, whose title contains `text`, or null. */
export function topLevelWindowContaining(text: string): bigint | null {
  for (let hwnd = user32.FindWindowExW(0n, 0n, null, null); hwnd !== 0n; hwnd = user32.FindWindowExW(0n, hwnd, null, null)) {
    if (windowText(hwnd).includes(text)) return hwnd;
  }
  return null;
}

/** The top-level window of process `pid` titled `title`, or null. */
export function topLevelWindowOf(pid: number, title: string): bigint | null {
  const owner = new Uint32Array(1);
  for (let hwnd = user32.FindWindowExW(0n, 0n, null, wide(title)); hwnd !== 0n; hwnd = user32.FindWindowExW(0n, hwnd, null, wide(title))) {
    user32.GetWindowThreadProcessId(hwnd, ptr(owner));
    if (owner[0] === pid) return hwnd;
  }
  return null;
}
