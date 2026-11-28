// Probes of OS state Sweetview has no API for, for the webview fixtures: what
// a window's handle names (its text, client size, visibility, DPI), a
// process's top-level window, the foreground, a message posted and a key
// tapped. Tests only; listed in
// rust-rewrite/ffi-allowlist.txt as a probe.

import { dlopen, FFIType, ptr } from "bun:ffi";

const user32 = dlopen("user32.dll", {
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  GetWindowTextW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetClientRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetDpiForWindow: { args: [FFIType.u64], returns: FFIType.u32 },
  PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  FindWindowExW: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
  AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  BringWindowToTop: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols;
const kernel32 = dlopen("kernel32.dll", {
  GetCurrentThreadId: { args: [], returns: FFIType.u32 },
}).symbols;

export const WM_CLOSE = 0x0010;

const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
const h = (hwnd: number | bigint | null) => BigInt(hwnd ?? 0);

export const isWindow = (hwnd: number | bigint | null) => user32.IsWindow(h(hwnd)) !== 0;
export const isVisible = (hwnd: number | bigint | null) => user32.IsWindowVisible(h(hwnd)) !== 0;
export const dpi = (hwnd: number | bigint | null) => user32.GetDpiForWindow(h(hwnd)) || 96;

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

export const postMessage = (hwnd: number | bigint | null, message: number, wparam = 0n, lparam = 0n) => user32.PostMessageW(h(hwnd), message, wparam, lparam) !== 0;

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

/** The top-level window of process `pid` titled `title`, or null. */
export function topLevelWindowOf(pid: number, title: string): bigint | null {
  const owner = new Uint32Array(1);
  for (let hwnd = user32.FindWindowExW(0n, 0n, null, wide(title)); hwnd !== 0n; hwnd = user32.FindWindowExW(0n, hwnd, null, wide(title))) {
    user32.GetWindowThreadProcessId(hwnd, ptr(owner));
    if (owner[0] === pid) return hwnd;
  }
  return null;
}
