// Unified Win32 Window implementation (replaces win32/overlay.ts + win32/window.ts).
//
// Fixes from the v1 audit:
// - 2.1: Idempotent dispose() destroying owned HWND and cleaning all maps,
//   timers, subclasses, and HICONs; default WM_CLOSE destroys/disposes instead
//   of hiding; WM_DESTROY never calls PostQuitMessage(0) unconditionally.
// - 2.2: isMaximized() uses IsZoomed(hwnd) for framed windows; toggleMaximize()
//   uses SW_MAXIMIZE/SW_RESTORE for framed windows and Screen.of(hwnd).workArea
//   for frameless windows (never primary-monitor SPI_GETWORKAREA).
// - 2.7: Hit-region timer is killed on hide(), setHitRegions(null), setClickThrough(),
//   and dispose().
// - 2.12: Shared ensureWin32Init() runs COM STA, per-monitor DPI v2, and the
//   Win11 25H2 hidden first-window anchor before any window is created.

import { FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { hitRegions, packRegions } from "../hit-regions";
import type { HitRefiner, Point, Rect, ResizeEdge, WindowBackend, WindowHandle, WindowOptions } from "../window";
import {
  DWM_BB_BLURREGION,
  DWM_BB_ENABLE,
  GWL_EXSTYLE,
  GWL_STYLE,
  GW_CHILD,
  HTCAPTION,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  LWA_ALPHA,
  LWA_COLORKEY,
  SWP_FRAMECHANGED,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  SW_HIDE,
  SW_MAXIMIZE,
  SW_MINIMIZE,
  SW_RESTORE,
  SW_SHOW,
  SW_SHOWNOACTIVATE,
  WM_CLOSE,
  WM_DESTROY,
  WM_GETMINMAXINFO,
  WM_MOVE,
  WM_NCDESTROY,
  WM_NCLBUTTONDOWN,
  WM_SETTINGCHANGE,
  WM_SIZE,
  WS_CLIPCHILDREN,
  WS_EX_APPWINDOW,
  WS_EX_LAYERED,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  WS_EX_TRANSPARENT,
  WS_MAXIMIZEBOX,
  WS_OVERLAPPEDWINDOW,
  WS_POPUP,
  WS_THICKFRAME,
  advapi32,
  comctl32,
  dwmapi,
  gdi32,
  hInstance,
  lastError,
  user32,
  wstr,
} from "./api";
import { colorRef } from "./color-ref";
import { clearWindowIcon, setWindowIcon } from "./icon";
import { ensureWin32Init } from "./init";
import { of as screenOf, primary as primaryScreen } from "./screen";
import { STRIP_HEIGHT } from "./strip-shared";
import { createFrameWindow, setDarkWindows } from "./tab-window";

export { colorRef };

export const asHwnd = (handle: WindowHandle): bigint => {
  if (handle === null || handle === 0 || handle === 0n) throw new Error("sweetview: window handle is NULL");
  return BigInt(handle);
};

const rectFrom = (buf: Int32Array): Rect => ({
  x: buf[0]!,
  y: buf[1]!,
  width: buf[2]! - buf[0]!,
  height: buf[3]! - buf[1]!,
});

const rectScratch = new Int32Array(4);
function readBounds(hwnd: bigint): Rect {
  user32.GetWindowRect(hwnd, rectScratch);
  return rectFrom(rectScratch);
}

// ---- per-window state registries (all cleaned up in cleanupHwnd / dispose) ------

type EventBucket = {
  resize: Set<(bounds: Rect) => void>;
  move: Set<(bounds: Rect) => void>;
  close: Set<() => void>;
};

const eventsByHwnd = new Map<bigint, EventBucket>();
const minSizeByHwnd = new Map<bigint, { width: number; height: number }>();
const followsSystem = new Set<bigint>();
const resizers = new Map<bigint, () => void>();
const disposeCallbacks = new Map<bigint, () => void>();

type HitState = {
  packed: Int32Array;
  passThrough: (on: boolean) => void;
  refine?: HitRefiner;
  inPolygon: boolean;
  asked?: Point;
  askSeq: number;
};
const hits = new Map<bigint, HitState>();

function bucketFor(hwnd: bigint): EventBucket {
  let b = eventsByHwnd.get(hwnd);
  if (!b) {
    b = { resize: new Set(), move: new Set(), close: new Set() };
    eventsByHwnd.set(hwnd, b);
  }
  return b;
}

function hasAnyListeners(b: EventBucket | undefined): boolean {
  return b !== undefined && (b.resize.size > 0 || b.move.size > 0 || b.close.size > 0);
}

function fireResize(hwnd: bigint): void {
  const b = eventsByHwnd.get(hwnd);
  if (!b || b.resize.size === 0) return;
  const r = readBounds(hwnd);
  for (const fn of [...b.resize]) {
    try {
      fn(r);
    } catch (err) {
      console.error("sweetview: onResize handler threw:", err);
    }
  }
}

function fireMove(hwnd: bigint): void {
  const b = eventsByHwnd.get(hwnd);
  if (!b || b.move.size === 0) return;
  const r = readBounds(hwnd);
  for (const fn of [...b.move]) {
    try {
      fn(r);
    } catch (err) {
      console.error("sweetview: onMove handler threw:", err);
    }
  }
}

function fireClose(hwnd: bigint): boolean {
  const b = eventsByHwnd.get(hwnd);
  if (!b || b.close.size === 0) return false;
  for (const fn of [...b.close]) {
    try {
      fn();
    } catch (err) {
      console.error("sweetview: onClose handler threw:", err);
    }
  }
  return true;
}

function cleanupHwnd(hwnd: bigint): void {
  user32.KillTimer(hwnd, HIT_TIMER_ID);
  user32.KillTimer(hwnd, RESIZE_TIMER_ID);
  hits.delete(hwnd);
  resizers.delete(hwnd);
  followsSystem.delete(hwnd);
  minSizeByHwnd.delete(hwnd);
  eventsByHwnd.delete(hwnd);
  disposeCallbacks.delete(hwnd);
  clearWindowIcon(hwnd);
}

/** Diagnostic helper for tests to verify zero leftover module-level map entries. */
export function _debugTrackedCount(hwnd: bigint): number {
  let n = 0;
  if (eventsByHwnd.has(hwnd)) n++;
  if (minSizeByHwnd.has(hwnd)) n++;
  if (followsSystem.has(hwnd)) n++;
  if (resizers.has(hwnd)) n++;
  if (hits.has(hwnd)) n++;
  if (disposeCallbacks.has(hwnd)) n++;
  return n;
}

// ---- resize gestures for frameless windows ---------------------------------------

const RESIZE_TIMER_ID = 2n;
const RESIZE_TIMER_MS = 10;
const DEFAULT_MIN_RESIZE = { width: 160, height: 120 };
let resizeProc: JSCallback | undefined;

function ensureResizeProc(): JSCallback {
  resizeProc ??= new JSCallback(
    (hwnd: bigint) => {
      try {
        resizers.get(hwnd)?.();
      } catch (err) {
        console.error("sweetview: resize gesture threw:", err);
      }
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32], returns: FFIType.void },
  );
  if (resizeProc.ptr === null) throw new Error("sweetview: could not allocate the resize timer procedure");
  return resizeProc;
}

// ---- click-through hit regions ---------------------------------------------------

const HIT_TIMER_ID = 1n;
const HIT_TIMER_MS = 10;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_MBUTTON = 0x04;
const mouseButtonsDown = (): boolean => [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].some((vk) => user32.GetAsyncKeyState(vk) < 0);

let timerProc: JSCallback | undefined;
const hitRect = new Int32Array(4);
const hitPoint = new Int32Array(2);

function pollHit(hwnd: bigint) {
  const state = hits.get(hwnd);
  if (!state) return;
  if (mouseButtonsDown()) return;
  if (!user32.GetCursorPos(hitPoint) || !user32.GetWindowRect(hwnd, hitRect)) return;
  const x = hitPoint[0]! - hitRect[0]!;
  const y = hitPoint[1]! - hitRect[1]!;
  const inside = x >= 0 && y >= 0 && x < hitRect[2]! - hitRect[0]! && y < hitRect[3]! - hitRect[1]!;
  refineHit(hwnd, state, inside && hitRegions(state.packed, x, y), x, y);
}

function refineHit(hwnd: bigint, state: HitState, inPolygon: boolean, x: number, y: number) {
  const entered = inPolygon && !state.inPolygon;
  state.inPolygon = inPolygon;
  if (!inPolygon) {
    state.passThrough(true);
    state.asked = undefined;
    return;
  }
  if (!state.refine) {
    state.passThrough(false);
    return;
  }
  if (entered) state.passThrough(false);
  if (state.asked?.x === x && state.asked?.y === y) return;
  state.asked = { x, y };
  const seq = ++state.askSeq;
  state.refine({ x, y }, (solid) => {
    if (hits.get(hwnd) !== state || seq !== state.askSeq || state.asked === undefined) return;
    if (mouseButtonsDown()) return;
    state.passThrough(!solid);
  });
}

function ensureTimerProc(): JSCallback {
  timerProc ??= new JSCallback(
    (hwnd: bigint) => {
      try {
        pollHit(hwnd);
      } catch (err) {
        console.error("sweetview: hit region poll threw:", err);
      }
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32], returns: FFIType.void },
  );
  if (timerProc.ptr === null) throw new Error("sweetview: could not allocate the hit region timer procedure");
  return timerProc;
}

// ---- DWM transparency & dark title bar ------------------------------------------

function enableAlphaComposition(hwnd: bigint) {
  const region = gdi32.CreateRectRgn(0, 0, -1, -1);
  const bb = new ArrayBuffer(24);
  const view = new DataView(bb);
  view.setUint32(0, DWM_BB_ENABLE | DWM_BB_BLURREGION, true);
  view.setInt32(4, 1, true);
  view.setBigUint64(8, region, true);
  view.setInt32(16, 0, true);
  const hr = dwmapi.DwmEnableBlurBehindWindow(hwnd, new Uint8Array(bb));
  gdi32.DeleteObject(region);
  if (hr < 0) throw new Error(`sweetview: DwmEnableBlurBehindWindow failed (0x${(hr >>> 0).toString(16)})`);
}

const HKEY_CURRENT_USER = 0xffffffff80000001n;
const RRF_RT_REG_DWORD = 0x10;
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const PERSONALIZE_KEY = wstr("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
const APPS_USE_LIGHT_THEME = wstr("AppsUseLightTheme");

export function systemIsDark(): boolean {
  const value = new Uint32Array([1]);
  const bytes = new Uint32Array([4]);
  const status = advapi32.RegGetValueW(HKEY_CURRENT_USER, ptr(PERSONALIZE_KEY), ptr(APPS_USE_LIGHT_THEME), RRF_RT_REG_DWORD, null, ptr(value), ptr(bytes));
  return status === 0 && value[0] === 0;
}

function applyDark(hwnd: bigint, dark: boolean) {
  dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, new Int32Array([dark ? 1 : 0]), 4);
}

/** The webview's widget child fills our client area, like the library's own window does. */
function layoutChild(hwnd: bigint) {
  const child = user32.GetWindow(hwnd, GW_CHILD);
  if (child !== 0n && user32.GetClientRect(hwnd, rectScratch)) {
    user32.MoveWindow(child, 0, 0, rectScratch[2]!, rectScratch[3]!, 1);
  }
}

// ---- owned window class & WndProc ------------------------------------------------

const CLASS_NAME = "SweetviewWindow";
const WNDCLASSEXW_SIZE = 80;
const SIZE_MINIMIZED = 1n;
let classRegistered = false;
let wndProc: JSCallback | undefined;

function registerClass() {
  if (classRegistered) return;
  wndProc = new JSCallback(
    (hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint => {
      if (message === WM_SIZE) {
        layoutChild(hwnd);
        if (wParam !== SIZE_MINIMIZED) fireResize(hwnd);
        return 0n;
      }
      if (message === WM_MOVE) {
        if (user32.IsIconic(hwnd) === 0) fireMove(hwnd);
        return 0n;
      }
      if (message === WM_GETMINMAXINFO) {
        const min = minSizeByHwnd.get(hwnd);
        if (min && lParam !== 0n) {
          // MINMAXINFO: ptReserved(8), ptMaxSize(8), ptMaxPosition(8), ptMinTrackSize(8 @ offset 24)
          const view = new DataView(toArrayBuffer(Number(lParam) as Pointer, 0, 40));
          if (min.width > 0) view.setInt32(24, min.width, true);
          if (min.height > 0) view.setInt32(28, min.height, true);
          return 0n;
        }
      }
      if (message === WM_SETTINGCHANGE) {
        try {
          if (followsSystem.has(hwnd)) applyDark(hwnd, systemIsDark());
        } catch (err) {
          console.error("sweetview: following the system's appearance threw:", err);
        }
        return user32.DefWindowProcW(hwnd, message, wParam, lParam);
      }
      if (message === WM_CLOSE) {
        if (fireClose(hwnd)) return 0n;
        // Default close action: actually close & dispose this window without killing the app loop.
        const onDispose = disposeCallbacks.get(hwnd);
        if (onDispose) onDispose();
        else user32.DestroyWindow(hwnd);
        return 0n;
      }
      if (message === WM_DESTROY) {
        cleanupHwnd(hwnd);
        return 0n;
      }
      return user32.DefWindowProcW(hwnd, message, wParam, lParam);
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  );
  if (wndProc.ptr === null) throw new Error("sweetview: could not allocate the window procedure");
  const wc = new Uint8Array(WNDCLASSEXW_SIZE);
  const dv = new DataView(wc.buffer);
  const className = wstr(CLASS_NAME);
  dv.setUint32(0, WNDCLASSEXW_SIZE, true);
  dv.setBigUint64(8, BigInt(wndProc.ptr), true);
  dv.setBigUint64(24, hInstance(), true);
  dv.setBigUint64(64, BigInt(ptr(className)), true);
  if (user32.RegisterClassExW(ptr(wc)) === 0) throw new Error(`sweetview: RegisterClassExW failed (${lastError()})`);
  classRegistered = true;
}

// ---- external handle subclassing (for Window.fromHandle) -------------------------

const SUBCLASS_ID = 0x5357n; // "SW"
const subclassedHwnds = new Set<bigint>();
let subclassProc: JSCallback | undefined;

function ensureSubclassProc(): JSCallback {
  subclassProc ??= new JSCallback(
    (hwnd: bigint, message: number, wParam: bigint, lParam: bigint, _id: bigint, _ref: bigint): bigint => {
      if (message === WM_CLOSE) {
        if (fireClose(hwnd)) return 0n;
      } else if (message === WM_SIZE) {
        if (wParam !== SIZE_MINIMIZED) fireResize(hwnd);
      } else if (message === WM_MOVE) {
        if (user32.IsIconic(hwnd) === 0) fireMove(hwnd);
      } else if (message === WM_NCDESTROY) {
        subclassedHwnds.delete(hwnd);
        cleanupHwnd(hwnd);
        comctl32.RemoveWindowSubclass(hwnd, ensureSubclassProc().ptr, SUBCLASS_ID);
      }
      return comctl32.DefSubclassProc(hwnd, message, wParam, lParam);
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  );
  return subclassProc;
}

function attachSubclass(hwnd: bigint): void {
  if (subclassedHwnds.has(hwnd)) return;
  if (!comctl32.SetWindowSubclass(hwnd, ensureSubclassProc().ptr, SUBCLASS_ID, 0n)) {
    throw new Error("sweetview: SetWindowSubclass failed");
  }
  subclassedHwnds.add(hwnd);
}

function detachSubclassIfUnused(hwnd: bigint): void {
  if (!subclassedHwnds.has(hwnd)) return;
  if (!hasAnyListeners(eventsByHwnd.get(hwnd))) {
    subclassedHwnds.delete(hwnd);
    comctl32.RemoveWindowSubclass(hwnd, ensureSubclassProc().ptr, SUBCLASS_ID);
  }
}

// ---- window construction ---------------------------------------------------------

function defaultBounds(): Rect {
  const area = primaryScreen().workArea;
  const width = 320;
  const height = 240;
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

export function createWindow(options: WindowOptions): WindowBackend {
  ensureWin32Init();
  if (options.tabs) return createTabbedWindow(options);
  registerClass();

  const frame = options.frame ?? true;
  const resizable = options.resizable ?? frame;
  const appearance = options.appearance ?? "system";
  const b = options.bounds ?? defaultBounds();
  const className = wstr(CLASS_NAME);
  const titleW = wstr(options.title ?? "");

  let style = (frame ? WS_OVERLAPPEDWINDOW : WS_POPUP) | WS_CLIPCHILDREN;
  if (frame && !resizable) {
    style &= ~(WS_THICKFRAME | WS_MAXIMIZEBOX);
  }

  const hwnd = user32.CreateWindowExW(0, className, titleW, style, Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height), 0n, 0n, hInstance(), null);
  if (hwnd === 0n) throw new Error(`sweetview: CreateWindowExW failed (${lastError()})`);

  if (options.minWidth !== undefined || options.minHeight !== undefined) {
    minSizeByHwnd.set(hwnd, {
      width: Math.max(0, Math.round(options.minWidth ?? 0)),
      height: Math.max(0, Math.round(options.minHeight ?? 0)),
    });
  }

  if (frame) {
    if (appearance === "system") followsSystem.add(hwnd);
    applyDark(hwnd, appearance === "system" ? systemIsDark() : appearance === "dark");
  }
  if (options.icon?.windows) setWindowIcon(hwnd, options.icon.windows.ico);

  return buildWindow(hwnd, options, frame, true);
}

function createTabbedWindow(options: WindowOptions): WindowBackend {
  const appearance = options.appearance ?? "system";
  if (appearance === "dark") setDarkWindows(true);
  else if (appearance === "light") setDarkWindows(false);
  else setDarkWindows(systemIsDark());

  let disposed = false;
  let ownerDispose = () => self.dispose();
  const frame = createFrameWindow({
    title: options.title ?? "",
    bounds: options.bounds,
    width: options.bounds ? undefined : 1040,
    height: options.bounds ? undefined : 720 + STRIP_HEIGHT,
    minWidth: options.minWidth ?? 560,
    minHeight: options.minHeight ?? 420 + STRIP_HEIGHT,
    stripHeight: STRIP_HEIGHT,
    onCloseRequest() {
      if (fireClose(frame.hwnd)) return;
      ownerDispose();
    },
    onActivate() {},
    onResized() {
      fireResize(frame.hwnd);
    },
    onMoved() {
      fireMove(frame.hwnd);
    },
  });

  if (options.icon?.windows) setWindowIcon(frame.hwnd, options.icon.windows.ico);

  const self: WindowBackend = {
    handle: frame.hwnd,
    isVisible: () => !disposed && frame.isVisible(),
    show: () => {
      if (!disposed) frame.show();
    },
    hide: () => {
      if (!disposed) frame.hide();
    },
    toggle: () => {
      if (self.isVisible()) self.hide();
      else self.show();
    },
    bounds: () => frame.bounds(),
    setBounds: (r) => {
      if (!disposed) frame.setBounds(r);
    },
    moveTo: (x, y) => {
      if (disposed) return;
      const b = frame.bounds();
      frame.setBounds({ x, y, width: b.width, height: b.height });
    },
    resize: (width, height) => {
      if (disposed) return;
      const b = frame.bounds();
      frame.setBounds({ x: b.x, y: b.y, width, height });
    },
    scale: () => frame.scale(),
    setTitle: (title) => {
      if (!disposed) frame.setTitle(title);
    },
    setIcon: (icon) => {
      if (!disposed) setWindowIcon(frame.hwnd, icon?.windows?.ico);
    },
    minimize: () => {
      if (!disposed) frame.minimize();
    },
    toggleMaximize: () => {
      if (!disposed) frame.toggleMaximize();
    },
    isMaximized: () => !disposed && frame.isMaximized(),
    setTopmost: (on) => {
      if (!disposed) user32.SetWindowPos(frame.hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    },
    startDrag: () => {
      if (!disposed) frame.startDrag();
    },
    startResize: (edge) => {
      if (!disposed) frame.startResize(edge);
    },
    setClickThrough() {},
    setHitRegions() {},
    onResize(handler) {
      const b = bucketFor(frame.hwnd);
      b.resize.add(handler);
      return () => b.resize.delete(handler);
    },
    onMove(handler) {
      const b = bucketFor(frame.hwnd);
      b.move.add(handler);
      return () => b.move.delete(handler);
    },
    onClose(handler) {
      const b = bucketFor(frame.hwnd);
      b.close.add(handler);
      return () => b.close.delete(handler);
    },
    setOwnerDispose(fn) {
      ownerDispose = fn;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cleanupHwnd(frame.hwnd);
      frame.destroy();
    },
  };
  return self;
}

export function fromHandle(handle: WindowHandle): WindowBackend {
  ensureWin32Init();
  const hwnd = asHwnd(handle);
  const style = Number(user32.GetWindowLongPtrW(hwnd, GWL_STYLE));
  const framed = (style & WS_POPUP) === 0;
  return buildWindow(hwnd, {}, framed, false);
}

function buildWindow(hwnd: bigint, options: WindowOptions, framed: boolean, owned: boolean): WindowBackend {
  const transparent = options.transparent ?? false;
  const colorKey = options.colorKey;
  const opacity = options.opacity;
  let topmost = options.topmost ?? false;
  const hideFromTaskbar = options.hideFromTaskbar ?? false;
  const noActivate = options.noActivate ?? false;
  const layered = colorKey !== undefined || opacity !== undefined;

  if (owned) {
    let ex = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if (layered) ex |= BigInt(WS_EX_LAYERED);
    if (hideFromTaskbar) ex = (ex | BigInt(WS_EX_TOOLWINDOW)) & ~BigInt(WS_EX_APPWINDOW);
    if (noActivate) ex |= BigInt(WS_EX_NOACTIVATE);
    user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);

    if (layered) {
      const flags = (colorKey !== undefined ? LWA_COLORKEY : 0) | (opacity !== undefined ? LWA_ALPHA : 0);
      const alpha = Math.round(Math.min(1, Math.max(0, opacity ?? 1)) * 255);
      if (!user32.SetLayeredWindowAttributes(hwnd, colorKey !== undefined ? colorRef(colorKey) : 0, alpha, flags)) {
        throw new Error("sweetview: SetLayeredWindowAttributes failed");
      }
    }

    if (transparent) enableAlphaComposition(hwnd);

    user32.SetWindowPos(hwnd, topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }

  const rectBuf = new Int32Array(4);
  const pointBuf = new Int32Array(2);
  let restoreBounds: Rect | undefined;
  let disposed = false;
  let resizing: { edge: ResizeEdge; from: Rect; cursor: Point } | undefined;
  const localUnsubs = new Set<() => void>();
  let ownsHitState = false;

  const minW = options.minWidth ?? DEFAULT_MIN_RESIZE.width;
  const minH = options.minHeight ?? DEFAULT_MIN_RESIZE.height;

  const passBits = BigInt(WS_EX_TRANSPARENT) | (layered ? 0n : BigInt(WS_EX_LAYERED));
  let passing: boolean | undefined;
  const passThrough = (on: boolean) => {
    if (passing === on) return;
    passing = on;
    const cur = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    const next = on ? cur | passBits : cur & ~passBits;
    if (next !== cur) user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
  };

  const self: WindowBackend = {
    handle: hwnd,

    isVisible() {
      return !disposed && user32.IsWindowVisible(hwnd) !== 0;
    },

    show() {
      if (disposed) return;
      if (owned) layoutChild(hwnd);
      if (user32.IsIconic(hwnd) !== 0) {
        user32.ShowWindow(hwnd, SW_RESTORE);
      } else {
        user32.ShowWindow(hwnd, noActivate ? SW_SHOWNOACTIVATE : SW_SHOW);
      }
      if (!noActivate && !topmost) {
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        user32.SetForegroundWindow(hwnd);
      }
      if (hits.has(hwnd)) {
        user32.SetTimer(hwnd, HIT_TIMER_ID, HIT_TIMER_MS, ensureTimerProc().ptr);
      }
    },

    hide() {
      if (disposed) return;
      user32.KillTimer(hwnd, HIT_TIMER_ID);
      user32.ShowWindow(hwnd, SW_HIDE);
    },

    toggle() {
      if (self.isVisible()) self.hide();
      else self.show();
    },

    bounds() {
      user32.GetWindowRect(hwnd, rectBuf);
      return rectFrom(rectBuf);
    },

    setBounds(r) {
      if (disposed) return;
      user32.SetWindowPos(
        hwnd,
        topmost ? HWND_TOPMOST : 0n,
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.width),
        Math.round(r.height),
        (topmost ? 0 : SWP_NOZORDER) | SWP_NOACTIVATE,
      );
    },

    moveTo(x, y) {
      if (disposed) return;
      user32.SetWindowPos(
        hwnd,
        topmost ? HWND_TOPMOST : 0n,
        Math.round(x),
        Math.round(y),
        0,
        0,
        SWP_NOSIZE | (topmost ? 0 : SWP_NOZORDER) | SWP_NOACTIVATE,
      );
    },

    resize(width, height) {
      if (disposed) return;
      user32.SetWindowPos(hwnd, 0n, 0, 0, Math.round(width), Math.round(height), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    },

    scale() {
      const dpi = user32.GetDpiForWindow(hwnd);
      return dpi === 0 ? 1 : dpi / 96;
    },

    setTitle(title) {
      if (disposed) return;
      user32.SetWindowTextW(hwnd, wstr(title));
    },

    setIcon(icon) {
      if (disposed) return;
      setWindowIcon(hwnd, icon?.windows?.ico);
    },

    minimize() {
      if (disposed) return;
      user32.ShowWindow(hwnd, SW_MINIMIZE);
    },

    toggleMaximize() {
      if (disposed) return;
      if (framed) {
        user32.ShowWindow(hwnd, user32.IsZoomed(hwnd) !== 0 ? SW_RESTORE : SW_MAXIMIZE);
      } else {
        if (restoreBounds) {
          self.setBounds(restoreBounds);
          restoreBounds = undefined;
        } else {
          restoreBounds = self.bounds();
          self.setBounds(screenOf(hwnd).workArea);
        }
      }
    },

    isMaximized() {
      if (disposed) return false;
      return framed ? user32.IsZoomed(hwnd) !== 0 : restoreBounds !== undefined;
    },

    setTopmost(on) {
      if (disposed) return;
      topmost = on;
      user32.SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    },

    startDrag() {
      if (disposed) return;
      user32.ReleaseCapture();
      user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, BigInt(HTCAPTION), 0n);
    },

    startResize(edge) {
      if (disposed) return;
      user32.GetCursorPos(pointBuf);
      resizing = { edge, from: self.bounds(), cursor: { x: pointBuf[0]!, y: pointBuf[1]! } };
      if (!resizers.has(hwnd)) {
        resizers.set(hwnd, () => {
          if (!resizing) return;
          if (user32.GetAsyncKeyState(VK_LBUTTON) >= 0) {
            resizing = undefined;
            user32.KillTimer(hwnd, RESIZE_TIMER_ID);
            return;
          }
          user32.GetCursorPos(pointBuf);
          const dx = pointBuf[0]! - resizing.cursor.x;
          const dy = pointBuf[1]! - resizing.cursor.y;
          const { edge: e, from } = resizing;
          let { x, y, width, height } = from;
          if (e.includes("left")) {
            width = Math.max(minW, from.width - dx);
            x = from.x + from.width - width;
          }
          if (e.includes("right")) width = Math.max(minW, from.width + dx);
          if (e.includes("top")) {
            height = Math.max(minH, from.height - dy);
            y = from.y + from.height - height;
          }
          if (e.includes("bottom")) height = Math.max(minH, from.height + dy);
          const cur = self.bounds();
          if (x !== cur.x || y !== cur.y || width !== cur.width || height !== cur.height) {
            self.setBounds({ x, y, width, height });
          }
        });
      }
      if (user32.SetTimer(hwnd, RESIZE_TIMER_ID, RESIZE_TIMER_MS, ensureResizeProc().ptr) === 0n) {
        throw new Error(`sweetview: SetTimer failed (${lastError()})`);
      }
    },

    setClickThrough(on) {
      if (disposed) return;
      ownsHitState = false;
      hits.delete(hwnd);
      user32.KillTimer(hwnd, HIT_TIMER_ID);
      passThrough(on);
    },

    setHitRegions(polygons, refine) {
      if (disposed) return;
      if (polygons === null) {
        ownsHitState = false;
        hits.delete(hwnd);
        user32.KillTimer(hwnd, HIT_TIMER_ID);
        passThrough(false);
        return;
      }
      ownsHitState = true;
      const previous = hits.get(hwnd);
      hits.set(hwnd, {
        packed: packRegions(polygons),
        passThrough,
        refine,
        inPolygon: previous?.inPolygon ?? false,
        askSeq: previous?.askSeq ?? 0,
      });
      if (!previous && user32.IsWindowVisible(hwnd) !== 0) {
        if (user32.SetTimer(hwnd, HIT_TIMER_ID, HIT_TIMER_MS, ensureTimerProc().ptr) === 0n) {
          throw new Error(`sweetview: SetTimer failed (${lastError()})`);
        }
      }
      pollHit(hwnd);
    },

    onResize(handler) {
      if (!owned && !disposeCallbacks.has(hwnd)) attachSubclass(hwnd);
      const b = bucketFor(hwnd);
      b.resize.add(handler);
      const unsub = () => {
        localUnsubs.delete(unsub);
        b.resize.delete(handler);
        if (!owned && !disposeCallbacks.has(hwnd)) detachSubclassIfUnused(hwnd);
      };
      localUnsubs.add(unsub);
      return unsub;
    },

    onMove(handler) {
      if (!owned && !disposeCallbacks.has(hwnd)) attachSubclass(hwnd);
      const b = bucketFor(hwnd);
      b.move.add(handler);
      const unsub = () => {
        localUnsubs.delete(unsub);
        b.move.delete(handler);
        if (!owned && !disposeCallbacks.has(hwnd)) detachSubclassIfUnused(hwnd);
      };
      localUnsubs.add(unsub);
      return unsub;
    },

    onClose(handler) {
      if (!owned && !disposeCallbacks.has(hwnd)) attachSubclass(hwnd);
      const b = bucketFor(hwnd);
      b.close.add(handler);
      const unsub = () => {
        localUnsubs.delete(unsub);
        b.close.delete(handler);
        if (!owned && !disposeCallbacks.has(hwnd)) detachSubclassIfUnused(hwnd);
      };
      localUnsubs.add(unsub);
      return unsub;
    },

    setOwnerDispose(fn) {
      if (owned) disposeCallbacks.set(hwnd, fn);
    },

    preserveGeometry() {
      const beforeStyle = user32.GetWindowLongPtrW(hwnd, GWL_STYLE);
      const beforeExStyle = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      const beforeBounds = self.bounds();
      return () => {
        if (disposed || user32.IsWindow(hwnd) === 0) return;
        let styleChanged = false;
        if (user32.GetWindowLongPtrW(hwnd, GWL_STYLE) !== beforeStyle) {
          user32.SetWindowLongPtrW(hwnd, GWL_STYLE, beforeStyle);
          styleChanged = true;
        }
        if (user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) !== beforeExStyle) {
          user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, beforeExStyle);
          styleChanged = true;
        }
        const after = self.bounds();
        const boundsChanged =
          after.x !== beforeBounds.x ||
          after.y !== beforeBounds.y ||
          after.width !== beforeBounds.width ||
          after.height !== beforeBounds.height;
        if (styleChanged || boundsChanged) {
          const flags = SWP_NOZORDER | SWP_NOACTIVATE | (styleChanged ? SWP_FRAMECHANGED : 0);
          user32.SetWindowPos(
            hwnd,
            0n,
            Math.round(beforeBounds.x),
            Math.round(beforeBounds.y),
            Math.round(beforeBounds.width),
            Math.round(beforeBounds.height),
            flags,
          );
        }
        layoutChild(hwnd);
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      resizing = undefined;
      for (const unsub of [...localUnsubs]) unsub();
      localUnsubs.clear();
      if (!owned) {
        if (ownsHitState) {
          ownsHitState = false;
          hits.delete(hwnd);
          user32.KillTimer(hwnd, HIT_TIMER_ID);
        }
        if (!disposeCallbacks.has(hwnd)) detachSubclassIfUnused(hwnd);
        return;
      }
      cleanupHwnd(hwnd);
      if (user32.IsWindow(hwnd) !== 0) {
        user32.DestroyWindow(hwnd);
      }
    },
  };

  if (owned) disposeCallbacks.set(hwnd, () => self.dispose());
  return self;
}
