// Part B rows for the Windows modules that were deleted with the old bun:ffi
// layer, run for real: `src/win32/init.ts` (the binding sets per-monitor DPI
// awareness v2 and an STA on the UI thread when it loads), `win32/message-window`
// (a hidden `Window` is an owner window, and an application's own window is
// served through `Window.fromHandle`), and `src/win32/icon.ts` (`setIcon` on a
// wrapper of any window sets its caption and taskbar icons, `undefined` goes back
// to the stock icon). The OS is read through this fixture's own bun:ffi table, as
// an application's own calls would. Prints one JSON line.

import { FFIType, dlopen } from "bun:ffi";
import { Screen, Window, dotIco } from "@n1h/sweetview-native";

const { u64, u32, i32, i64 } = FFIType;
const user32 = dlopen("user32.dll", {
  GetThreadDpiAwarenessContext: { args: [], returns: i64 },
  GetAwarenessFromDpiAwarenessContext: { args: [i64], returns: i32 },
  SendMessageW: { args: [u64, u32, u64, i64], returns: i64 },
  IsWindowVisible: { args: [u64], returns: i32 },
}).symbols;
const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: [FFIType.ptr, u32], returns: i32 },
  CoUninitialize: { args: [], returns: FFIType.void },
}).symbols;

const report: Record<string, unknown> = {};

// ensureDpiAware / ensureWin32Init: done by the binding once a Window exists.
const owner = new Window({ title: "sweetview compat owner" });
report.perMonitorAware = user32.GetAwarenessFromDpiAwarenessContext(user32.GetThreadDpiAwarenessContext()) === 2; // DPI_AWARENESS_PER_MONITOR_AWARE
const hr = ole32.CoInitializeEx(null, 0x2); // COINIT_APARTMENTTHREADED
report.uiThreadIsSta = hr === 1; // S_FALSE: already an STA
if (hr >= 0) ole32.CoUninitialize(); // releases only the reference this call added

// createMessageWindow as an owner: a hidden Window has a real handle and is never shown.
const hwnd = BigInt(owner.handle!);
report.ownerHidden = user32.IsWindowVisible(hwnd) === 0 && !owner.isVisible();
report.ownerOnAScreen = Screen.of(owner).bounds.width > 0;

// setWindowIcon / loadIcon / clearWindowIcon: Window.fromHandle(handle).setIcon(icon).
const wrapped = Window.fromHandle(owner.handle);
const icons = () => [0n, 1n].map((which) => user32.SendMessageW(hwnd, 0x007f, which, 0n)); // WM_GETICON small, big
wrapped.setIcon({ windows: { ico: dotIco({ sizes: [16, 32] }) } });
const set = icons();
report.iconSet = set.every((h) => h !== 0n);
wrapped.setIcon(undefined);
report.iconBackToStock = icons()[0] !== set[0];
wrapped.dispose();
owner.dispose();

console.log(JSON.stringify(report));
process.exit(0);
