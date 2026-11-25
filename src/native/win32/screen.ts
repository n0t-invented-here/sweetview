// Win32 Screen queries: EnumDisplayMonitors, MonitorFromWindow, MonitorFromRect,
// GetMonitorInfoW, and shcore GetDpiForMonitor. Runs ensureWin32Init() on first
// call so coordinates match before and after new Window().

import { FFIType, JSCallback } from "bun:ffi";
import type { ScreenInfo } from "../screen";
import type { Point, Rect, WindowHandle } from "../types";
import {
  MDT_EFFECTIVE_DPI,
  MONITORINFOF_PRIMARY,
  MONITORINFO_SIZE,
  MONITOR_DEFAULTTONEAREST,
  SM_CXSCREEN,
  SM_CXVIRTUALSCREEN,
  SM_CYSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
  SPI_GETWORKAREA,
  shcore,
  user32,
} from "./api";
import { ensureWin32Init } from "./init";
import { asHwnd } from "./window";

const rectFrom = (buf: Int32Array): Rect => ({
  x: buf[0]!,
  y: buf[1]!,
  width: buf[2]! - buf[0]!,
  height: buf[3]! - buf[1]!,
});

const infoBuf = new Int32Array(MONITORINFO_SIZE / 4);
const dpiX = new Uint32Array(1);
const dpiY = new Uint32Array(1);
const rectBuf = new Int32Array(4);
const pointBuf = new Int32Array(2);

function monitorScale(hmon: bigint): number {
  dpiX[0] = 96;
  dpiY[0] = 96;
  const hr = shcore.GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, dpiX, dpiY);
  if (hr === 0 && dpiX[0]! > 0) return dpiX[0]! / 96;
  return 1;
}

function fallbackPrimary(): ScreenInfo {
  const bounds: Rect = {
    x: 0,
    y: 0,
    width: user32.GetSystemMetrics(SM_CXSCREEN),
    height: user32.GetSystemMetrics(SM_CYSCREEN),
  };
  user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, rectBuf, 0);
  return { bounds, workArea: rectFrom(rectBuf), scale: 1, primary: true };
}

function monitorInfo(hmon: bigint): ScreenInfo {
  if (hmon === 0n) return fallbackPrimary();
  infoBuf.fill(0);
  infoBuf[0] = MONITORINFO_SIZE;
  if (user32.GetMonitorInfoW(hmon, infoBuf) === 0) return fallbackPrimary();
  return {
    bounds: rectFrom(infoBuf.subarray(1, 5)),
    workArea: rectFrom(infoBuf.subarray(5, 9)),
    scale: monitorScale(hmon),
    primary: (infoBuf[9]! & MONITORINFOF_PRIMARY) !== 0,
  };
}

let collected: bigint[] = [];
let enumProc: JSCallback | undefined;

function ensureEnumProc(): JSCallback {
  enumProc ??= new JSCallback(
    (hmon: bigint): number => {
      collected.push(hmon);
      return 1;
    },
    { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
  );
  if (enumProc.ptr === null) throw new Error("sweetview: could not allocate monitor enumeration callback");
  return enumProc;
}

export function all(): ScreenInfo[] {
  ensureWin32Init();
  collected = [];
  user32.EnumDisplayMonitors(0n, null, ensureEnumProc().ptr, 0n);
  const handles = collected;
  collected = [];
  if (handles.length === 0) return [fallbackPrimary()];
  return handles.map(monitorInfo);
}

export function primary(): ScreenInfo {
  const list = all();
  return list.find((s) => s.primary) ?? list[0]!;
}

export function at(point: Point): ScreenInfo {
  ensureWin32Init();
  rectBuf[0] = Math.round(point.x);
  rectBuf[1] = Math.round(point.y);
  rectBuf[2] = rectBuf[0]! + 1;
  rectBuf[3] = rectBuf[1]! + 1;
  const hmon = user32.MonitorFromRect(rectBuf, MONITOR_DEFAULTTONEAREST);
  return monitorInfo(hmon);
}

export function of(handle: WindowHandle): ScreenInfo {
  ensureWin32Init();
  const hmon = user32.MonitorFromWindow(asHwnd(handle), MONITOR_DEFAULTTONEAREST);
  return monitorInfo(hmon);
}

export function bounds(): Rect {
  ensureWin32Init();
  return {
    x: user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

export function cursor(): Point {
  ensureWin32Init();
  user32.GetCursorPos(pointBuf);
  return { x: pointBuf[0]!, y: pointBuf[1]! };
}
