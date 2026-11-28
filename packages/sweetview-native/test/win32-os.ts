// Test support for the Windows tests of this package and of `@n1h/sweetview`:
// reads back from the OS what Sweetview did (a window's styles, rectangles,
// icons and existence, the menus and dialogs this process has open, the
// process's GDI and USER object counts, the monitors) and drives this
// process's own windows the way the shell, the keyboard and an application
// would (messages posted or sent to them, a WM_DROPFILES drop, a window of the
// application's own with its own window procedure). Nothing here presses a key
// system-wide or touches the clipboard, and every input is a message to one of
// this process's own windows, except the move-loop control
// (`moveLoopControl`): it moves the cursor and presses the left button with
// SendInput, only over a window of its own, and always lets go; the right
// button over this process's own popup menu (`injectRightButton`), only when
// that menu is under the cursor; and the shell reader (`trayFromShell`), which
// opens the notification area's overflow flyout with a click when the icon
// sits there, under the same guards. It also asks the shell whether it still
// holds a notification icon (a modify that changes nothing), for the tests of
// what an application leaves behind when it ends. Listed in
// rust-rewrite/ffi-allowlist.txt as a probe.

import { FFIType, JSCallback, dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { fileURLToPath } from "node:url";
import { binding } from "../src/binding";
import { pumpEvents } from "../src/event-loop";

const { u64, u32, i32, i64, u16, i16 } = FFIType;
export const user32 = dlopen("user32.dll", {
  FindWindowExW: { args: [u64, u64, FFIType.ptr, FFIType.ptr], returns: u64 },
  GetWindowThreadProcessId: { args: [u64, FFIType.ptr], returns: u32 },
  IsWindow: { args: [u64], returns: i32 },
  IsWindowVisible: { args: [u64], returns: i32 },
  IsIconic: { args: [u64], returns: i32 },
  IsZoomed: { args: [u64], returns: i32 },
  GetWindow: { args: [u64, u32], returns: u64 },
  GetParent: { args: [u64], returns: u64 },
  GetDlgCtrlID: { args: [u64], returns: i32 },
  GetWindowRect: { args: [u64, FFIType.ptr], returns: i32 },
  GetClientRect: { args: [u64, FFIType.ptr], returns: i32 },
  ClientToScreen: { args: [u64, FFIType.ptr], returns: i32 },
  GetDC: { args: [u64], returns: u64 },
  ReleaseDC: { args: [u64, u64], returns: i32 },
  GetWindowLongPtrW: { args: [u64, i32], returns: i64 },
  GetCursorPos: { args: [FFIType.ptr], returns: i32 },
  GetAsyncKeyState: { args: [i32], returns: i16 },
  GetDoubleClickTime: { args: [], returns: u32 },
  GetSystemMetrics: { args: [i32], returns: i32 },
  // (const RECT*, DWORD flags) -> HMONITOR
  MonitorFromRect: { args: [FFIType.ptr, u32], returns: u64 },
  // (HMONITOR, MONITORINFO*) -> BOOL; cbSize set by the caller
  GetMonitorInfoW: { args: [u64, FFIType.ptr], returns: i32 },
  EndMenu: { args: [], returns: i32 },
  PostMessageW: { args: [u64, u32, u64, i64], returns: i32 },
  SendMessageW: { args: [u64, u32, u64, i64], returns: i64 },
  PostQuitMessage: { args: [i32], returns: FFIType.void },
  RegisterWindowMessageW: { args: [FFIType.ptr], returns: u32 },
  GetMenuItemCount: { args: [u64], returns: i32 },
  GetMenuState: { args: [u64, u32, u32], returns: u32 },
  GetMenuStringW: { args: [u64, u32, FFIType.ptr, i32, u32], returns: i32 },
  GetSubMenu: { args: [u64, i32], returns: u64 },
  GetMenuItemInfoW: { args: [u64, u32, i32, FFIType.ptr], returns: i32 },
  GetMenuItemID: { args: [u64, i32], returns: u32 },
  // (HWND or 0, HMENU, UINT item, RECT*) -> BOOL; with no window, the popup menu window showing hMenu
  GetMenuItemRect: { args: [u64, u64, u32, FFIType.ptr], returns: i32 },
  IsMenu: { args: [u64], returns: i32 },
  // An application's own call on a menu Sweetview handed it (buildMenu): (HMENU, flags, x, y, reserved, HWND, RECT*) -> command
  TrackPopupMenu: { args: [u64, u32, i32, i32, i32, u64, FFIType.ptr], returns: i32 },
  GetClassNameW: { args: [u64, FFIType.ptr, i32], returns: i32 },
  GetWindowTextW: { args: [u64, FFIType.ptr, i32], returns: i32 },
  EnumChildWindows: { args: [u64, FFIType.ptr, i64], returns: i32 },
  GetGuiResources: { args: [u64, u32], returns: u32 },
  // (HWND, COLORREF* key, BYTE* alpha, DWORD* flags) -> BOOL
  GetLayeredWindowAttributes: { args: [u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: i32 },
  // An application's own window: its class, the window and its procedure's default.
  RegisterClassExW: { args: [FFIType.ptr], returns: u16 },
  CreateWindowExW: { args: [u32, FFIType.ptr, FFIType.ptr, u32, i32, i32, i32, i32, u64, u64, u64, FFIType.ptr], returns: u64 },
  DestroyWindow: { args: [u64], returns: i32 },
  DefWindowProcW: { args: [u64, u32, u64, i64], returns: i64 },
  // The move-loop control: real input over a window of its own.
  SetCursorPos: { args: [i32, i32], returns: i32 },
  SendInput: { args: [u32, FFIType.ptr, i32], returns: u32 },
  GetKeyState: { args: [i32], returns: i16 },
  WindowFromPoint: { args: [u64], returns: u64 },
  GetAncestor: { args: [u64, u32], returns: u64 },
  GetGUIThreadInfo: { args: [u32, FFIType.ptr], returns: i32 },
  GetForegroundWindow: { args: [], returns: u64 },
}).symbols;
export const kernel32 = dlopen("kernel32.dll", {
  GetCurrentProcess: { args: [], returns: u64 },
  GetModuleHandleW: { args: [FFIType.ptr], returns: u64 },
  GetLastError: { args: [], returns: u32 },
  GlobalAlloc: { args: [u32, u64], returns: u64 },
  GlobalSize: { args: [u64], returns: u64 },
  GlobalLock: { args: [u64], returns: FFIType.ptr },
  GlobalUnlock: { args: [u64], returns: i32 },
  GlobalFree: { args: [u64], returns: u64 },
  GetCurrentThreadId: { args: [], returns: u32 },
}).symbols;

export const shell32 = dlopen("shell32.dll", {
  // (DWORD message, NOTIFYICONDATAW*) -> BOOL
  Shell_NotifyIconW: { args: [u32, FFIType.ptr], returns: i32 },
}).symbols;

export const gdi32 = dlopen("gdi32.dll", {
  // (HDC, x, y) -> COLORREF 0x00bbggrr; CLR_INVALID (0xffffffff) outside the clip
  GetPixel: { args: [u64, i32, i32], returns: u32 },
}).symbols;

export const dwmapi = dlopen("dwmapi.dll", {
  // (HWND, DWORD attribute, PVOID value, DWORD size) -> HRESULT; 20 is DWMWA_USE_IMMERSIVE_DARK_MODE
  DwmGetWindowAttribute: { args: [u64, u32, FFIType.ptr, u32], returns: i32 },
}).symbols;

export const WM_APP = 0x8000;
export const WM_CLOSE = 0x0010;
export const WM_DROPFILES = 0x0233;
export const WM_GETICON = 0x007f;
export const WM_GETMINMAXINFO = 0x0024;
export const ICON_SMALL = 0n;
export const ICON_BIG = 1n;
export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;
export const WS_THICKFRAME = 0x00040000;
export const WS_MAXIMIZEBOX = 0x00010000;
export const WS_OVERLAPPEDWINDOW = 0x00cf0000;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_LAYERED = 0x00080000;
export const WS_EX_NOACTIVATE = 0x08000000;
export const SM_CXSCREEN = 0;
export const SM_CYSCREEN = 1;
export const MONITOR_DEFAULTTONEAREST = 2;
/** MONITORINFO: cbSize, rcMonitor, rcWork, dwFlags; 40 bytes. */
export const MONITORINFO_SIZE = 40;
const GMEM_MOVEABLE = 0x0002;

/** NUL-terminated UTF-16LE for an LPCWSTR argument; pass the array itself. */
export const wide = (s: string) => new Uint8Array(Buffer.from(s + "\0", "utf16le"));

export const hInstance = (): bigint => kernel32.GetModuleHandleW(null);

/** The process's GDI and USER object counts. */
export function guiObjects(): { gdi: number; user: number } {
  const process = kernel32.GetCurrentProcess();
  return { gdi: user32.GetGuiResources(process, 0), user: user32.GetGuiResources(process, 1) };
}

/** `HWND_MESSAGE`, the parent FindWindowExW searches message-only windows under. */
const HWND_MESSAGE = BigInt.asUintN(64, -3n);

/** The windows of class `className` (and title `title`, when given) that belong to this process. */
export function ownWindows(className: string, title?: string): bigint[] {
  return windowsOf(0n, className, title);
}

/** The message-only windows of class `className` that belong to this process. */
export function ownMessageWindows(className: string): bigint[] {
  return windowsOf(HWND_MESSAGE, className);
}

function windowsOf(parent: bigint, className: string, title?: string): bigint[] {
  const cls = wide(className);
  const name = title === undefined ? null : wide(title);
  const pid = new Uint32Array(1);
  const found: bigint[] = [];
  let after = 0n;
  for (let i = 0; i < 10_000; i++) {
    after = user32.FindWindowExW(parent, after, cls, name);
    if (after === 0n) break;
    user32.GetWindowThreadProcessId(after, pid);
    if (pid[0] === process.pid) found.push(after);
  }
  return found;
}

export const isWindow = (hwnd: bigint): boolean => user32.IsWindow(hwnd) !== 0;

export function windowRect(hwnd: bigint): { left: number; top: number; right: number; bottom: number } {
  const rect = new Int32Array(4);
  user32.GetWindowRect(hwnd, ptr(rect));
  return { left: rect[0]!, top: rect[1]!, right: rect[2]!, bottom: rect[3]! };
}

/** The size of a window's client area, physical pixels. */
export function clientSize(hwnd: bigint): { width: number; height: number } {
  const rect = new Int32Array(4);
  user32.GetClientRect(hwnd, ptr(rect));
  return { width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! };
}

/** A point of a window's client area in screen coordinates. */
export function clientToScreen(hwnd: bigint, x: number, y: number): { x: number; y: number } {
  const point = new Int32Array([x, y]);
  user32.ClientToScreen(hwnd, ptr(point));
  return { x: point[0]!, y: point[1]! };
}

/**
 * The colour the screen shows at `(x, y)`, as `#rrggbb`: what the compositor
 * put there, webviews included. Read it from a topmost window of this
 * process, so no other window covers the point.
 */
export function screenPixel(x: number, y: number): string {
  const dc = user32.GetDC(0n);
  try {
    const bgr = gdi32.GetPixel(dc, x, y);
    // CLR_INVALID: the point is outside what the screen shows; a colour read from nothing is no colour.
    if (bgr === 0xffffffff) throw new Error(`GetPixel(${x}, ${y}) failed: CLR_INVALID`);
    const rgb = ((bgr & 0xff) << 16) | (bgr & 0xff00) | ((bgr >> 16) & 0xff);
    return `#${rgb.toString(16).padStart(6, "0")}`;
  } finally {
    user32.ReleaseDC(0n, dc);
  }
}

export function cursor(): { x: number; y: number } {
  const point = new Int32Array(2);
  user32.GetCursorPos(ptr(point));
  return { x: point[0]!, y: point[1]! };
}

export const doubleClickTime = (): number => user32.GetDoubleClickTime();

/** Closes whatever menu this thread has open, as a click elsewhere would. */
export const endMenu = (): boolean => user32.EndMenu() !== 0;

/** The owner of a top-level window (GW_OWNER). */
export const ownerOf = (hwnd: bigint): bigint => user32.GetWindow(hwnd, 4);

export const post = (hwnd: bigint, message: number, wParam = 0n, lParam = 0n): boolean => user32.PostMessageW(hwnd, message, wParam, lParam) !== 0;

export const registeredMessage = (name: string): number => user32.RegisterWindowMessageW(wide(name));

/** GetLayeredWindowAttributes: the colour key, alpha and flags of a layered window, or null when it is not layered. */
export function layeredAttributes(hwnd: bigint): { key: number; alpha: number; flags: number } | null {
  const key = new Uint32Array(1);
  const alpha = new Uint8Array(1);
  const flags = new Uint32Array(1);
  if (user32.GetLayeredWindowAttributes(hwnd, key, alpha, flags) === 0) return null;
  return { key: key[0]!, alpha: alpha[0]!, flags: flags[0]! };
}

/** MINMAXINFO.ptMinTrackSize as the window's own WM_GETMINMAXINFO answers: the outer minimum, physical pixels. */
export function minTrackSize(hwnd: bigint): [number, number] {
  const info = new Int32Array(10);
  user32.SendMessageW(hwnd, WM_GETMINMAXINFO, 0n, BigInt(ptr(info)));
  return [info[6]!, info[7]!];
}

/** Sends `paths` to `hwnd` as a WM_DROPFILES, as the shell does for a drop. Returns the HDROP, which the receiver frees. */
export function sendDrop(hwnd: bigint, paths: string[]): bigint {
  const body = Buffer.from(paths.join("\0") + "\0\0", "utf16le");
  const dropFiles = Buffer.alloc(20 + body.length);
  dropFiles.writeUInt32LE(20, 0); // DROPFILES.pFiles
  dropFiles.writeInt32LE(1, 16); // fWide
  body.copy(dropFiles, 20);
  const drop = kernel32.GlobalAlloc(GMEM_MOVEABLE, BigInt(dropFiles.length));
  const memory = kernel32.GlobalLock(drop);
  if (!memory) {
    if (drop) kernel32.GlobalFree(drop);
    throw new Error("could not allocate DROPFILES");
  }
  new Uint8Array(toArrayBuffer(memory, 0, dropFiles.length)).set(dropFiles);
  kernel32.GlobalUnlock(drop);
  user32.SendMessageW(hwnd, WM_DROPFILES, drop, 0n);
  return drop;
}

// ---- a window of the application's own ---------------------------------------------------

export type OwnWindow = { readonly hwnd: bigint; destroy(): void };

const ownHandlers = new Map<bigint, (message: number, wParam: bigint, lParam: bigint) => void>();
// Retained for the process: the registered class calls it until exit.
let ownProc: JSCallback | undefined;
const OWN_CLASS = "SweetviewTestOwnWindow";

/**
 * A never-shown top-level window an application made itself through bun:ffi, with its own window
 * procedure, which hands every message to `onMessage` and ignores WM_CLOSE (only `destroy()` ends
 * it). Tests use it as the owner of popups and dialogs, and to prove Sweetview serves a window it
 * did not make.
 */
export function ownWindow(onMessage: (message: number, wParam: bigint, lParam: bigint) => void = () => {}): OwnWindow {
  binding(); // the binding sets per-monitor DPI awareness and COM before any window of this process exists
  if (ownProc === undefined) {
    ownProc = new JSCallback(
      (hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint => {
        try {
          ownHandlers.get(hwnd)?.(message, wParam, lParam);
        } catch (err) {
          console.error("win32-os: own window handler threw:", err);
        }
        return message === WM_CLOSE ? 0n : user32.DefWindowProcW(hwnd, message, wParam, lParam);
      },
      { args: [u64, u32, u64, i64], returns: i64 },
    );
    const SIZE = 80; // WNDCLASSEXW on x64
    const wc = new Uint8Array(SIZE);
    const view = new DataView(wc.buffer);
    const className = wide(OWN_CLASS);
    view.setUint32(0, SIZE, true); // cbSize
    view.setBigUint64(8, BigInt(ownProc.ptr!), true); // lpfnWndProc
    view.setBigUint64(24, hInstance(), true); // hInstance
    view.setBigUint64(64, BigInt(ptr(className)), true); // lpszClassName
    if (user32.RegisterClassExW(wc) === 0) throw new Error(`RegisterClassExW failed (${kernel32.GetLastError()})`);
  }
  const hwnd = user32.CreateWindowExW(WS_EX_TOOLWINDOW, wide(OWN_CLASS), null, 0, 0, 0, 0, 0, 0n, 0n, hInstance(), null);
  if (hwnd === 0n) throw new Error(`CreateWindowExW failed (${kernel32.GetLastError()})`);
  ownHandlers.set(hwnd, onMessage);
  let destroyed = false;
  return {
    hwnd,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ownHandlers.delete(hwnd);
      user32.DestroyWindow(hwnd);
    },
  };
}

// ---- the move-loop control -----------------------------------------------------------------

/** True while this thread is in the OS's move or size loop (GUITHREADINFO's GUI_INMOVESIZE). */
export function inMoveSize(): boolean {
  const info = new Uint8Array(72); // GUITHREADINFO, x64
  const view = new DataView(info.buffer);
  view.setUint32(0, 72, true);
  // This thread by its id: 0 would name the foreground thread, which may be another process's.
  user32.GetGUIThreadInfo(kernel32.GetCurrentThreadId(), ptr(info));
  return (view.getUint32(4, true) & 0x2) !== 0;
}

/** The top-level window under a screen point. */
export function windowAt(x: number, y: number): bigint {
  const hit = user32.WindowFromPoint(BigInt.asUintN(32, BigInt(x)) | (BigInt.asUintN(32, BigInt(y)) << 32n));
  return hit === 0n ? 0n : user32.GetAncestor(hit, 2); // GA_ROOT
}

/** True while any mouse button is down, system-wide. */
export const buttonsDown = (): boolean => [0x01, 0x02, 0x04].some((vk) => user32.GetAsyncKeyState(vk) < 0);

/** Presses or releases the left button with SendInput. */
export function injectLeftButton(down: boolean): void {
  const input = new Uint8Array(40); // INPUT, x64: type, MOUSEINPUT at 8 (dx, dy, mouseData, dwFlags at 20, time, dwExtraInfo)
  const view = new DataView(input.buffer);
  view.setUint32(0, 0, true); // INPUT_MOUSE
  view.setUint32(20, down ? 0x2 : 0x4, true); // MOUSEEVENTF_LEFTDOWN / LEFTUP
  user32.SendInput(1, ptr(input), 40);
}

/**
 * Presses or releases the right button with SendInput. True when the OS took the input; a caller
 * that pressed keeps releasing until a release is taken.
 */
export function injectRightButton(down: boolean): boolean {
  const input = new Uint8Array(40);
  const view = new DataView(input.buffer);
  view.setUint32(0, 0, true); // INPUT_MOUSE
  view.setUint32(20, down ? 0x8 : 0x10, true); // MOUSEEVENTF_RIGHTDOWN / RIGHTUP
  return user32.SendInput(1, ptr(input), 40) === 1;
}

export type Desk = { x: number; y: number; width: number; height: number };

/**
 * Moves the cursor to a screen point as a mouse would: an injected absolute move (what a move loop
 * follows), then SetCursorPos so the point is exact. `desk` is the virtual desktop's rectangle.
 */
export function injectCursorMove(x: number, y: number, desk: Desk): void {
  const input = new Uint8Array(40);
  const view = new DataView(input.buffer);
  view.setUint32(0, 0, true);
  view.setInt32(8, Math.round(((x - desk.x) * 65535) / Math.max(1, desk.width - 1)), true);
  view.setInt32(12, Math.round(((y - desk.y) * 65535) / Math.max(1, desk.height - 1)), true);
  view.setUint32(20, 0x1 | 0x8000 | 0x4000, true); // MOUSEEVENTF_MOVE | ABSOLUTE | VIRTUALDESK
  user32.SendInput(1, ptr(input), 40);
  user32.SetCursorPos(x, y);
}

export type MoveLoopControl = {
  /** True when the OS ran its move loop for the control window and the window followed the cursor. */
  ok: boolean;
  /** Why it could not be run, or did not work, in words. */
  why?: string;
  readings: Record<string, unknown>;
};

let control: Promise<MoveLoopControl> | undefined;

/**
 * Tells "this session's OS runs no move loop for injected input" apart from "Sweetview did not
 * hand the window over". A plain window of the test's own (no Sweetview code in it) is pressed
 * with SendInput (only when no button is down and the window is under the cursor) and sent
 * `WM_NCLBUTTONDOWN` with `HTCAPTION` itself, as a title bar's press is; the OS then runs its move
 * loop, which is read (GUI_INMOVESIZE) and fed an injected cursor move from native timeouts (they
 * fire inside it). Run once per process; later calls answer the first run. The button is always
 * released, a watchdog ends the loop, and the cursor is put back.
 */
export function moveLoopControl(desk: Desk, area: Desk = desk): Promise<MoveLoopControl> {
  return (control ??= runMoveLoopControl(desk, area));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function runMoveLoopControl(desk: Desk, area: Desk): Promise<MoveLoopControl> {
  const native = binding();
  const WS_POPUP = 0x80000000;
  const WS_VISIBLE = 0x10000000;
  const WS_EX_TOPMOST = 0x8;
  // Inside `area` (the primary screen's work area), with room for the move (50, 35).
  const bounds = { x: area.x + 40, y: area.y + 40, width: 240, height: 160 };
  ownWindow().destroy(); // registers the class
  const hwnd = user32.CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE, wide(OWN_CLASS), wide(`move-loop control ${process.pid}`), WS_POPUP | WS_VISIBLE, bounds.x, bounds.y, bounds.width, bounds.height, 0n, 0n, hInstance(), null);
  if (hwnd === 0n) return { ok: false, why: `the control window could not be made (${kernel32.GetLastError()})`, readings: {} };
  const original = cursor();
  const grip = { x: bounds.x + 60, y: bounds.y + 40 };
  const readings: Record<string, unknown> = {};
  let pressed = false;
  const release = () => {
    if (pressed) injectLeftButton(false);
    pressed = false;
  };
  const settle = async (ms: number, until: () => boolean) => {
    for (const end = performance.now() + ms; performance.now() < end; await Bun.sleep(5)) {
      pumpEvents();
      if (until()) return true;
    }
    return until();
  };
  try {
    let why = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await Bun.sleep(500);
      user32.SetCursorPos(grip.x, grip.y);
      await settle(40, () => false);
      if (buttonsDown()) why = "a mouse button was already down on the shared desktop";
      else if (windowAt(grip.x, grip.y) !== hwnd) why = "another window was under the cursor on the shared desktop";
      else {
        why = "";
        break;
      }
    }
    if (why) return { ok: false, why, readings };
    const watchdog = native.scheduleTimeout(10_000, () => {
      readings.watchdog = { inMoveSize: inMoveSize(), leftDown: user32.GetAsyncKeyState(0x01) < 0 };
      release();
      post(hwnd, 0x001f); // WM_CANCELMODE
    });
    injectLeftButton(true);
    pressed = true;
    readings.threadSawThePress = await settle(2000, () => user32.GetKeyState(0x01) < 0);
    native.scheduleTimeout(60, () => void (readings.inLoopBeforeTheMove = inMoveSize()));
    native.scheduleTimeout(120, () => injectCursorMove(grip.x + 50, grip.y + 35, desk));
    // No fixed delay before the reading: a session may apply the move well after the cursor got
    // there (the hosted runner does). From inside the loop, wait until the window is where the
    // cursor took it, or a generous limit passed; then read and release.
    const expected = { x: bounds.x + 50, y: bounds.y + 35 };
    const readInLoop = (end: number) => {
      const r = windowRect(hwnd);
      const there = r.left === expected.x && r.top === expected.y;
      if (!there && Date.now() < end && pressed) {
        native.scheduleTimeout(20, () => readInLoop(end));
        return;
      }
      readings.inLoopAfterTheMove = inMoveSize();
      readings.windowInTheLoop = { x: r.left, y: r.top };
      release();
    };
    native.scheduleTimeout(140, () => readInLoop(Date.now() + 6000));
    // A title bar's press, as DefWindowProc gets it: blocks in the OS move loop until the release.
    const at = BigInt.asUintN(16, BigInt(grip.x)) | (BigInt.asUintN(16, BigInt(grip.y)) << 16n);
    user32.SendMessageW(hwnd, 0x00a1, 2n, at); // WM_NCLBUTTONDOWN, HTCAPTION
    await settle(8000, () => !pressed);
    native.cancelTimeout(watchdog);
    const r = windowRect(hwnd);
    readings.windowAfter = { x: r.left, y: r.top };
    readings.expected = expected;
    // The window must be where the cursor took it while the button is still down, and stay there.
    const ok = readings.inLoopAfterTheMove === true && same(readings.windowInTheLoop, expected) && r.left === expected.x && r.top === expected.y;
    return ok ? { ok, readings } : { ok, why: "the OS started no move loop for the control window, or the window did not follow the cursor", readings };
  } finally {
    release();
    user32.SetCursorPos(original.x, original.y);
    user32.DestroyWindow(hwnd);
  }
}

// ---- the tray ------------------------------------------------------------------------

/** The callback message tray-icon 0.27 registers its icons with; the mouse message rides in lParam. */
const WM_USER_TRAYICON = 6002;
export const TRAY = { LBUTTONDOWN: 0x0201, LBUTTONUP: 0x0202, LBUTTONDBLCLK: 0x0203, RBUTTONDOWN: 0x0204, RBUTTONUP: 0x0205 } as const;

/** Posts to the tray icon's window what the shell posts for these mouse messages over the icon. */
export function postTrayMouse(trayWindow: bigint, ...messages: number[]): void {
  for (const message of messages) {
    if (!post(trayWindow, WM_USER_TRAYICON, 0n, BigInt(message))) throw new Error(`PostMessageW to the tray window failed`);
  }
}

// ---- popup menus ------------------------------------------------------------------------

const MN_GETHMENU = 0x01e1;
const MN_SELECTITEM = 0x01e5;
const MF_BYPOSITION = 0x400;
const WM_KEYDOWN = 0x0100;
export const VK = { RETURN: 0x0d, ESCAPE: 0x1b, RIGHT: 0x27, DOWN: 0x28 } as const;

/** The popup menu window this process has open (class `#32768`), or 0n. */
export function openPopupMenu(): bigint {
  return ownWindows("#32768").find((hwnd) => user32.IsWindowVisible(hwnd) !== 0) ?? 0n;
}

export type MenuEntry = {
  label: string;
  separator: boolean;
  checked: boolean;
  disabled: boolean;
  hasBitmap: boolean;
  submenu?: MenuEntry[];
};

/** Reads a menu back from the OS: what each entry shows and its state, submenus included. */
export function readMenu(hmenu: bigint): MenuEntry[] {
  const count = user32.GetMenuItemCount(hmenu);
  const entries: MenuEntry[] = [];
  for (let position = 0; position < count; position++) {
    const state = user32.GetMenuState(hmenu, position, MF_BYPOSITION);
    const text = new Uint16Array(256);
    const length = user32.GetMenuStringW(hmenu, position, ptr(text), text.length, MF_BYPOSITION);
    // MENUITEMINFOW (x64, 80 bytes): cbSize, fMask = MIIM_BITMAP; hbmpItem at 72.
    const info = new Uint8Array(80);
    const view = new DataView(info.buffer);
    view.setUint32(0, 80, true);
    view.setUint32(4, 0x80, true);
    user32.GetMenuItemInfoW(hmenu, position, 1, ptr(info));
    const sub = user32.GetSubMenu(hmenu, position);
    entries.push({
      label: String.fromCharCode(...text.subarray(0, Math.max(0, length))),
      separator: (state & 0x800) !== 0,
      checked: (state & 0x8) !== 0,
      disabled: (state & 0x3) !== 0,
      hasBitmap: view.getBigUint64(72, true) !== 0n,
      ...(sub !== 0n ? { submenu: readMenu(sub) } : {}),
    });
  }
  return entries;
}

/** The menu shown in a popup menu window. */
export const menuOfWindow = (menuWindow: bigint): bigint => BigInt.asUintN(64, user32.SendMessageW(menuWindow, MN_GETHMENU, 0n, 0n));

/** The screen rectangle of the item at `position` of `hmenu`, while a popup menu window shows it. */
export function menuItemRect(hmenu: bigint, position: number): { left: number; top: number; right: number; bottom: number } {
  const rect = new Int32Array(4);
  if (user32.GetMenuItemRect(0n, hmenu, position, ptr(rect)) === 0) throw new Error("GetMenuItemRect failed");
  return { left: rect[0]!, top: rect[1]!, right: rect[2]!, bottom: rect[3]! };
}

/** The command id the OS keeps for the item at `position` of `hmenu` (0xffffffff for a submenu). */
export const menuItemId = (hmenu: bigint, position: number): number => user32.GetMenuItemID(hmenu, position);

/** Posts key presses to a popup menu window, which its menu loop takes as the keyboard. */
/** Selects the item at `position` of an open menu and presses Enter on it, as the keyboard would, through messages to the menu's own window. */
export function chooseMenuItem(menuWindow: bigint, position: number): void {
  user32.SendMessageW(menuWindow, MN_SELECTITEM, BigInt(position), 0n);
  post(menuWindow, WM_KEYDOWN, BigInt(VK.RETURN), 1n);
}

export function pressKeys(menuWindow: bigint, ...keys: number[]): void {
  for (const key of keys) post(menuWindow, WM_KEYDOWN, BigInt(key), 1n);
}

// ---- the notification area, as the shell shows it ---------------------------------------

/** A notification icon as Explorer shows it: its UI Automation name and the middle pixel of its image. */
export type ShellIcon =
  | { found: true; name: string; where: "taskbar" | "overflow"; pixel: [number, number, number]; rect: [number, number, number, number] }
  | { found: false; where: string }
  | { skip: string };

/**
 * Reads the notification icon whose tooltip is `tooltip` back from Explorer, in a second process
 * (`tray-shell.ps1`: UI Automation and a screen pixel), pumping this thread's loop meanwhile.
 * When the icon sits in the overflow flyout the script opens it with a click and closes it again,
 * only when the shared desktop's mouse is free; otherwise the answer is `{ skip }`.
 */
export async function trayFromShell(tooltip: string): Promise<ShellIcon> {
  const script = fileURLToPath(new URL("./tray-shell.ps1", import.meta.url));
  const child = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-File", script, "-Tooltip", tooltip], { stdout: "pipe", stderr: "pipe" });
  // A last resort only: the script releases every button it presses in a `finally`, which a kill would skip.
  const killer = setTimeout(() => child.kill(), 120_000);
  try {
    while (child.exitCode === null && child.signalCode === null) {
      pumpEvents();
      await Bun.sleep(20);
    }
  } finally {
    clearTimeout(killer);
  }
  const out = (await new Response(child.stdout).text()).trim().split(/\r?\n/).at(-1) ?? "";
  try {
    return JSON.parse(out) as ShellIcon;
  } catch {
    const err = (await new Response(child.stderr).text()).slice(0, 400);
    return { skip: `the shell reader printed no answer (exit ${child.exitCode}): ${out.slice(0, 200)} ${err}` };
  }
}

// ---- notification icons, by the shell's own record ---------------------------------------

/** `sizeof(NOTIFYICONDATAW)` on 64-bit Windows. */
const NOTIFYICONDATAW_SIZE = 976;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIF_STATE = 0x08;

function notifyIconData(hwnd: bigint, uid: number, flags: number): Uint8Array {
  const data = new Uint8Array(NOTIFYICONDATAW_SIZE);
  const view = new DataView(data.buffer);
  view.setUint32(0, NOTIFYICONDATAW_SIZE, true); // cbSize
  view.setBigUint64(8, hwnd, true); // hWnd
  view.setUint32(16, uid, true); // uID
  view.setUint32(20, flags, true); // uFlags
  return data; // dwState and dwStateMask (296, 300) stay 0: a modify of nothing
}

/**
 * Whether the shell still holds a notification icon added under the window `hwnd` with id `uid`:
 * a modify that changes nothing (state, with an empty mask), which the shell accepts only for an
 * icon it holds. The window need not exist any more: an icon whose process ended without deleting
 * it stays in the shell's record (and on the screen) until the shell next posts to its window.
 * It reads nothing a user sees and presses nothing.
 */
export const shellHoldsIcon = (hwnd: bigint, uid: number): boolean =>
  shell32.Shell_NotifyIconW(NIM_MODIFY, ptr(notifyIconData(hwnd, uid, NIF_STATE))) !== 0;

/** Deletes the shell's notification icon `(hwnd, uid)`, for a test that found one left behind. */
export const deleteShellIcon = (hwnd: bigint, uid: number): boolean =>
  shell32.Shell_NotifyIconW(NIM_DELETE, ptr(notifyIconData(hwnd, uid, 0))) !== 0;

// ---- dialogs ------------------------------------------------------------------------------

const WM_SETTEXT = 0x000c;
const BM_CLICK = 0x00f5;

function children(parent: bigint): bigint[] {
  const found: bigint[] = [];
  const callback = new JSCallback(
    (hwnd: bigint) => {
      found.push(hwnd);
      return 1;
    },
    { args: [u64, i64], returns: i32 },
  );
  try {
    user32.EnumChildWindows(parent, callback.ptr, 0n);
  } finally {
    callback.close();
  }
  return found;
}

const classOf = (hwnd: bigint): string => {
  const buffer = new Uint16Array(256);
  const length = user32.GetClassNameW(hwnd, ptr(buffer), buffer.length);
  return String.fromCharCode(...buffer.subarray(0, length));
};

/**
 * Types `path` into the folder dialog's folder field and presses its OK button, as a user would.
 * False while the dialog has not made that field yet.
 */
export function chooseInFolderDialog(dialog: bigint, path: string): boolean {
  // The common item dialog's folder field: the Edit with control id 1152 (edt1), a direct child of the dialog.
  const edit = children(dialog).find((hwnd) => classOf(hwnd) === "Edit" && user32.GetParent(hwnd) === dialog && user32.GetDlgCtrlID(hwnd) === 1152 && user32.IsWindowVisible(hwnd) !== 0);
  if (edit === undefined) return false;
  const ok = children(dialog).find((hwnd) => classOf(hwnd) === "Button" && user32.GetDlgCtrlID(hwnd) === 1); // IDOK
  if (ok === undefined) return false;
  const text = wide(path);
  user32.SendMessageW(edit, WM_SETTEXT, 0n, BigInt(ptr(text)));
  return post(ok, BM_CLICK);
}
