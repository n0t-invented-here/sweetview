
// W4.3: a topmost overlay above the taskbar, as the first Sweetview window of a fresh process.
// Run by src/win32/overlay.test.ts with `windowsHide` (STARTUPINFO: STARTF_USESHOWWINDOW,
// SW_HIDE), as a launcher can start an app. The overlay is placed over 240 px of the taskbar's
// rectangle; WindowFromPoint at the taskbar's centre must return it while it is shown, and the
// taskbar again once it is hidden. The process's own top-level windows are listed before and
// with it (the event loop's hidden window comes with the first Sweetview window). Prints
// `RESULT <json>`; with no taskbar to cover, `skipped` with the reason.
//
// Probes of the OS (the taskbar's window and rectangle, WindowFromPoint, the process's own
// top-level windows) are why this fixture uses bun:ffi.

import { FFIType, dlopen, ptr } from "bun:ffi";

const { u64, u32, i32, i64 } = FFIType;
const user32 = dlopen("user32.dll", {
  FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: u64 },
  FindWindowExW: { args: [u64, u64, FFIType.ptr, FFIType.ptr], returns: u64 },
  GetWindowRect: { args: [u64, FFIType.ptr], returns: i32 },
  WindowFromPoint: { args: [u64], returns: u64 },
  GetAncestor: { args: [u64, u32], returns: u64 },
  IsWindowVisible: { args: [u64], returns: i32 },
  GetWindowThreadProcessId: { args: [u64, FFIType.ptr], returns: u32 },
  GetClassNameW: { args: [u64, FFIType.ptr, i32], returns: i32 },
  GetWindowLongPtrW: { args: [u64, i32], returns: i64 },
}).symbols;

const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));
const mode = "sweetview";
const report: Record<string, unknown> = { mode };
const done = () => {
  console.log("RESULT " + JSON.stringify(report));
  process.exit(0);
};

function rectOf(hwnd: bigint) {
  const r = new Int32Array(4);
  user32.GetWindowRect(hwnd, ptr(r));
  return { left: r[0]!, top: r[1]!, right: r[2]!, bottom: r[3]! };
}
const rootAt = (x: number, y: number) => {
  const hit = user32.WindowFromPoint(BigInt.asUintN(32, BigInt(x)) | (BigInt.asUintN(32, BigInt(y)) << 32n));
  return hit === 0n ? 0n : user32.GetAncestor(hit, 2); // GA_ROOT
};
function className(hwnd: bigint): string {
  const buffer = new Uint16Array(256);
  const length = user32.GetClassNameW(hwnd, ptr(buffer), buffer.length);
  return String.fromCharCode(...buffer.subarray(0, length));
}
/** This process's top-level windows, in z-order, with their class and visibility. */
function ownTopLevel(): { hwnd: string; cls: string; visible: boolean }[] {
  const pid = new Uint32Array(1);
  const found: { hwnd: string; cls: string; visible: boolean }[] = [];
  for (let hwnd = user32.FindWindowExW(0n, 0n, null, null); hwnd !== 0n; hwnd = user32.FindWindowExW(0n, hwnd, null, null)) {
    user32.GetWindowThreadProcessId(hwnd, ptr(pid));
    if (pid[0] === process.pid) found.push({ hwnd: `0x${hwnd.toString(16)}`, cls: className(hwnd), visible: user32.IsWindowVisible(hwnd) !== 0 });
  }
  return found;
}

// The taskbar of this session, and a point well inside it.
const taskbar = user32.FindWindowW(wide("Shell_TrayWnd"), null);
if (taskbar === 0n) {
  report.skipped = "this session has no taskbar (no Shell_TrayWnd window)";
  done();
}
const bar = rectOf(taskbar);
const point = { x: Math.round((bar.left + bar.right) / 2), y: Math.round((bar.top + bar.bottom) / 2) };
report.taskbar = { ...bar, point };
report.rootBefore = rootAt(point.x, point.y) === taskbar;
if (!report.rootBefore) {
  report.skipped = `the taskbar is not the window at its own centre (${point.x},${point.y}): hidden (auto-hide) or covered`;
  done();
}
// The overlay covers 240 px of the taskbar around the point, its full height.
const overlay = { x: point.x - 120, y: bar.top, width: 240, height: bar.bottom - bar.top };

{
  const { Window } = await import("../../src/window");
  const { pumpEvents } = await import("../../src/event-loop");
  report.ownWindowsBeforeFirstSweetviewWindow = ownTopLevel();
  const win = new Window({ title: `overlay-taskbar ${process.pid}`, frame: false, topmost: true, noActivate: true, hideFromTaskbar: true, bounds: overlay });
  const hwnd = BigInt(win.handle!);
  report.ownWindowsWithIt = ownTopLevel();
  win.show();
  for (let i = 0; i < 20; i++) {
    pumpEvents();
    await Bun.sleep(10);
  }
  report.visible = user32.IsWindowVisible(hwnd) !== 0;
  report.topmostBit = (BigInt.asUintN(32, user32.GetWindowLongPtrW(hwnd, -20)) & 0x8n) !== 0n;
  report.overlayAtPoint = rootAt(point.x, point.y) === hwnd;
  win.hide();
  for (let i = 0; i < 10; i++) {
    pumpEvents();
    await Bun.sleep(10);
  }
  report.taskbarAtPointAfterHide = rootAt(point.x, point.y) === taskbar;
  win.dispose();
  done();
}

