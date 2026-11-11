// Overlay on Win32: restyle the HWND in place (WS_POPUP, WS_EX_LAYERED with a
// colour key, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE, HWND_TOPMOST). The webview
// keeps its own window procedure; we only change styles and placement.
//
// Click-through by hit regions: the rectangles the page sent are tested
// against the cursor on a 10 ms SetTimer (and on every update) and the
// answer flips WS_EX_TRANSPARENT | WS_EX_LAYERED, which the window manager
// honours across processes. No window region: SetWindowRgn forces a repaint
// of the window and the browser in it every time it changes, which a scene
// that changes every frame cannot afford.

import { FFIType, JSCallback, ptr } from "bun:ffi";
import { hitRegions, packRegions } from "../hit-regions";
import type { HitRefiner, Overlay, OverlayOptions, OverlayWindowOptions, Point, Rect, ResizeEdge } from "../overlay";
import type { WindowHandle } from "../window";
import {
  COINIT_APARTMENTTHREADED,
  DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
  DWM_BB_BLURREGION,
  DWM_BB_ENABLE,
  GW_CHILD,
  HTCAPTION,
  RPC_E_CHANGED_MODE,
  GWL_EXSTYLE,
  GWL_STYLE,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  LWA_ALPHA,
  LWA_COLORKEY,
  MONITORINFO_SIZE,
  MONITOR_DEFAULTTONEAREST,
  SM_CXSCREEN,
  SM_CXVIRTUALSCREEN,
  SM_CYSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
  SPI_GETWORKAREA,
  SWP_FRAMECHANGED,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  SW_HIDE,
  SW_MINIMIZE,
  SW_SHOW,
  SW_SHOWNOACTIVATE,
  WM_CLOSE,
  WM_NCLBUTTONDOWN,
  WM_DESTROY,
  WM_SIZE,
  WS_EX_APPWINDOW,
  WS_EX_LAYERED,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  WS_EX_TRANSPARENT,
  WS_CLIPCHILDREN,
  WS_OVERLAPPEDWINDOW,
  WS_POPUP,
  dwmapi,
  gdi32,
  hInstance,
  lastError,
  ole32,
  user32,
  wstr,
} from "./api";
import { setWindowIcon } from "./icon";
import { createMessageWindow, type MessageWindow } from "./message-window";
import { asHwnd } from "./window";

import { colorRef } from "./color-ref";
export { colorRef };

const rectFrom = (buf: Int32Array): Rect => ({ x: buf[0]!, y: buf[1]!, width: buf[2]! - buf[0]!, height: buf[3]! - buf[1]! });

// ---- resize gestures for frameless windows ---------------------------------------

const RESIZE_TIMER_ID = 2n;
const RESIZE_TIMER_MS = 10;
const MIN_RESIZE = { width: 160, height: 120 };
const resizers = new Map<bigint, () => void>(); // hwnd -> one tick of its resize gesture
let resizeProc: JSCallback | undefined; // retained for the process

function ensureResizeProc(): JSCallback {
  resizeProc ??= new JSCallback(
    (hwnd: bigint) => {
      try {
        resizers.get(hwnd)?.();
      } catch (err) {
        console.error("sweetnative: resize gesture threw:", err); // never unwind into user32
      }
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32], returns: FFIType.void },
  );
  if (resizeProc.ptr === null) throw new Error("sweetnative: could not allocate the resize timer procedure");
  return resizeProc;
}

// ---- hit regions: the click-through poll ----------------------------------------

const HIT_TIMER_ID = 1n;
const HIT_TIMER_MS = 10; // USER_TIMER_MINIMUM
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_MBUTTON = 0x04;
const mouseButtonsDown = (): boolean => [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].some((vk) => user32.GetAsyncKeyState(vk) < 0);

type HitState = {
  packed: Int32Array;
  passThrough: (on: boolean) => void;
  refine?: HitRefiner;
  /** Whether the cursor was inside a polygon at the last tick; entering is when the window turns solid until the refiner answers. */
  inPolygon: boolean;
  /** The last point the refiner was asked about, or undefined once the cursor left the polygons or the polygons changed. */
  asked?: Point;
  askSeq: number;
};
const hits = new Map<bigint, HitState>(); // hwnd -> regions, while set
let timerProc: JSCallback | undefined; // retained for the process: SetTimer calls it until KillTimer
const hitRect = new Int32Array(4);
const hitPoint = new Int32Array(2);

// TIMERPROC: runs inside the message loop webview.run() spins, on this thread.
function pollHit(hwnd: bigint) {
  const state = hits.get(hwnd);
  if (!state) return;
  if (mouseButtonsDown()) return; // never flip mid-click or mid-drag
  if (!user32.GetCursorPos(hitPoint) || !user32.GetWindowRect(hwnd, hitRect)) return;
  const x = hitPoint[0]! - hitRect[0]!;
  const y = hitPoint[1]! - hitRect[1]!;
  const inside = x >= 0 && y >= 0 && x < hitRect[2]! - hitRect[0]! && y < hitRect[3]! - hitRect[1]!;
  refineHit(hwnd, state, inside && hitRegions(state.packed, x, y), x, y);
}

/** The polygon answer, then the refiner's if there is one and the cursor is inside a polygon. */
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
  if (entered) state.passThrough(false); // take clicks until the exact answer arrives; a polygon update alone keeps the last answer
  if (state.asked?.x === x && state.asked?.y === y) return; // same spot, same polygons: the answer stands
  state.asked = { x, y };
  const seq = ++state.askSeq;
  state.refine({ x, y }, (solid) => {
    if (hits.get(hwnd) !== state || seq !== state.askSeq || state.asked === undefined) return; // moved on, or the regions were replaced or cleared
    if (mouseButtonsDown()) return; // never flip mid-click or mid-drag; the next tick applies the answer
    state.passThrough(!solid);
  });
}

function ensureTimerProc(): JSCallback {
  timerProc ??= new JSCallback(
    (hwnd: bigint) => {
      try {
        pollHit(hwnd);
      } catch (err) {
        console.error("sweetnative: hit region poll threw:", err); // never unwind into user32
      }
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32], returns: FFIType.void },
  );
  if (timerProc.ptr === null) throw new Error("sweetnative: could not allocate the hit region timer procedure");
  return timerProc;
}

/**
 * DwmEnableBlurBehindWindow with an empty region: no blur, but DWM now
 * composes the window's client area with its alpha, so a transparent page
 * background shows the desktop (the same trick tao/Tauri use on Windows).
 */
function enableAlphaComposition(hwnd: bigint) {
  const region = gdi32.CreateRectRgn(0, 0, -1, -1);
  // DWM_BLURBEHIND { DWORD dwFlags; BOOL fEnable; HRGN hRgnBlur; BOOL fTransitionOnMaximized; } (x64: 4 + 4 + 8 + 4, padded to 24)
  const bb = new ArrayBuffer(24);
  const view = new DataView(bb);
  view.setUint32(0, DWM_BB_ENABLE | DWM_BB_BLURREGION, true);
  view.setInt32(4, 1, true);
  view.setBigUint64(8, region, true);
  view.setInt32(16, 0, true);
  const hr = dwmapi.DwmEnableBlurBehindWindow(hwnd, new Uint8Array(bb));
  gdi32.DeleteObject(region);
  if (hr < 0) throw new Error(`sweetnative: DwmEnableBlurBehindWindow failed (0x${(hr >>> 0).toString(16)})`);
}

// ---- our own overlay window ---------------------------------------------------

const CLASS_NAME = "SweetnativeOverlay";
const WNDCLASSEXW_SIZE = 80;
let classRegistered = false;
let wndProc: JSCallback | undefined; // retained for the process: the class calls it until exit
const rectScratch = new Int32Array(4);

/** The webview's widget child fills our client area, like the library's own window does. */
function layoutChild(hwnd: bigint) {
  const child = user32.GetWindow(hwnd, GW_CHILD);
  if (child !== 0n && user32.GetClientRect(hwnd, rectScratch)) {
    user32.MoveWindow(child, 0, 0, rectScratch[2]!, rectScratch[3]!, 1);
  }
}

function registerClass() {
  if (classRegistered) return;
  wndProc = new JSCallback(
    (hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint => {
      if (message === WM_SIZE) {
        layoutChild(hwnd);
        return 0n;
      }
      if (message === WM_CLOSE) {
        user32.ShowWindow(hwnd, SW_HIDE); // a framed window's close button hides it; the app ends on quit
        return 0n;
      }
      if (message === WM_DESTROY) {
        user32.PostQuitMessage(0); // ends webview_run
        return 0n;
      }
      return user32.DefWindowProcW(hwnd, message, wParam, lParam);
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  );
  if (wndProc.ptr === null) throw new Error("sweetnative: could not allocate the overlay window procedure");
  const wc = new Uint8Array(WNDCLASSEXW_SIZE);
  const dv = new DataView(wc.buffer);
  const className = wstr(CLASS_NAME);
  dv.setUint32(0, WNDCLASSEXW_SIZE, true); // cbSize
  dv.setBigUint64(8, BigInt(wndProc.ptr), true); // lpfnWndProc
  dv.setBigUint64(24, hInstance(), true); // hInstance
  dv.setBigUint64(64, BigInt(ptr(className)), true); // lpszClassName; hbrBackground stays NULL: nothing paints behind the page
  if (user32.RegisterClassExW(ptr(wc)) === 0) throw new Error(`sweetnative: RegisterClassExW failed (${lastError()})`);
  classRegistered = true;
}

// The first top-level window a process creates can never be made topmost:
// SetWindowPos(HWND_TOPMOST) returns success from any process and leaves
// WS_EX_TOPMOST off, for that window only, for its whole life (seen on
// Windows 11 25H2 with a bare overlay, a transparent one, and a framed one;
// every later window is fine, and destroying the first one does not free the
// next). So the first window is a hidden one nobody needs, kept for the
// process. Created after the DPI awareness context is set, which only works
// before any window exists.
let anchor: MessageWindow | undefined;
function ensureFirstWindowIsHidden() {
  anchor ??= createMessageWindow(() => {});
}

export function createOverlayWindow(options: OverlayWindowOptions): Overlay {
  // The webview library does these two only for windows it creates itself.
  // WebView2 needs a single-threaded apartment on this thread; without it
  // webview_create fails and returns NULL.
  const hr = ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (hr === RPC_E_CHANGED_MODE) throw new Error("sweetnative: this thread already initialised COM as multi-threaded; WebView2 needs an STA");
  user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); // fails harmlessly if already set
  ensureFirstWindowIsHidden();
  registerClass();
  const { title = "", bounds, frame = false, dark = false } = options;
  const b = bounds ?? defaultBounds();
  const className = wstr(CLASS_NAME);
  const titleW = wstr(title);
  // Created hidden and bare; restyle sets the rest of the styles and the DWM composition
  // before the caller hands it to the webview, which is the order WebView2 needs.
  const style = (frame ? WS_OVERLAPPEDWINDOW : WS_POPUP) | WS_CLIPCHILDREN;
  const hwnd = user32.CreateWindowExW(0, className, titleW, style, b.x, b.y, b.width, b.height, 0n, 0n, hInstance(), null);
  if (hwnd === 0n) throw new Error(`sweetnative: CreateWindowExW failed (${lastError()})`);
  if (frame && dark) {
    // DWMWA_USE_IMMERSIVE_DARK_MODE (20, Windows 11 and 10 2004+); ignored where unsupported.
    dwmapi.DwmSetWindowAttribute(hwnd, 20, new Int32Array([1]), 4);
  }
  if (options.icon?.windows) setWindowIcon(hwnd, options.icon.windows.ico);
  return restyle(hwnd, options, frame);
}

function defaultBounds(): Rect {
  user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, rectScratch, 0);
  const area = rectFrom(rectScratch);
  const width = 320;
  const height = 240;
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
}

// ---- restyling ---------------------------------------------------------------

export function makeOverlay(handle: WindowHandle, options: OverlayOptions): Overlay {
  return restyle(asHwnd(handle), options, false);
}

/** The Overlay object for a window; `framed` leaves a normal window's styles alone (see OverlayWindowOptions.frame). */
function restyle(hwnd: bigint, options: OverlayOptions, framed: boolean): Overlay {
  const { transparent = false, colorKey, opacity, topmost: topmostAtStart = !framed, hideFromTaskbar = !framed, noActivate = !framed } = options;
  let topmost = topmostAtStart; // kept current by setTopmost so moves re-assert the right z-order
  const layered = colorKey !== undefined || opacity !== undefined; // WS_EX_LAYERED is part of this window's look, not just click-through

  // Styles. Keep WS_VISIBLE and friends; swap the frame for a bare popup.
  if (!framed) {
    const style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE);
    user32.SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~BigInt(WS_OVERLAPPEDWINDOW)) | BigInt(WS_POPUP) | BigInt(WS_CLIPCHILDREN));
  }

  let ex = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if (colorKey !== undefined || opacity !== undefined) ex |= BigInt(WS_EX_LAYERED);
  if (hideFromTaskbar) ex = (ex | BigInt(WS_EX_TOOLWINDOW)) & ~BigInt(WS_EX_APPWINDOW);
  if (noActivate) ex |= BigInt(WS_EX_NOACTIVATE);
  user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);

  if (colorKey !== undefined || opacity !== undefined) {
    const flags = (colorKey !== undefined ? LWA_COLORKEY : 0) | (opacity !== undefined ? LWA_ALPHA : 0);
    const alpha = Math.round(Math.min(1, Math.max(0, opacity ?? 1)) * 255);
    if (!user32.SetLayeredWindowAttributes(hwnd, colorKey !== undefined ? colorRef(colorKey) : 0, alpha, flags)) {
      throw new Error("sweetnative: SetLayeredWindowAttributes failed");
    }
  }

  if (transparent) enableAlphaComposition(hwnd);

  // Apply the frame change and the z-order in one go.
  user32.SetWindowPos(hwnd, topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);

  const rectBuf = new Int32Array(4);
  const pointBuf = new Int32Array(2);
  let restoreBounds: Rect | undefined; // set while maximised by toggleMaximize
  let resizing: { edge: ResizeEdge; from: Rect; cursor: Point } | undefined; // while a startResize gesture is in progress
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
    const { edge, from } = resizing;
    let { x, y, width, height } = from;
    if (edge.includes("left")) {
      width = Math.max(MIN_RESIZE.width, from.width - dx);
      x = from.x + from.width - width;
    }
    if (edge.includes("right")) width = Math.max(MIN_RESIZE.width, from.width + dx);
    if (edge.includes("top")) {
      height = Math.max(MIN_RESIZE.height, from.height - dy);
      y = from.y + from.height - height;
    }
    if (edge.includes("bottom")) height = Math.max(MIN_RESIZE.height, from.height + dy);
    if (x !== self.bounds().x || y !== self.bounds().y || width !== self.bounds().width || height !== self.bounds().height) self.setBounds({ x, y, width, height });
  });

  // WS_EX_TRANSPARENT alone only hides the window from its own thread's hit
  // testing; with WS_EX_LAYERED the window manager passes input through to
  // other processes' windows (what tao and Electron set). A window that is
  // layered for its colour key or opacity keeps that bit either way. Setting
  // the same bits again is skipped: SetWindowLongPtr is not free.
  const passBits = BigInt(WS_EX_TRANSPARENT) | (layered ? 0n : BigInt(WS_EX_LAYERED));
  let passing: boolean | undefined;
  const passThrough = (on: boolean) => {
    if (passing === on) return;
    passing = on;
    const cur = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    const next = on ? cur | passBits : cur & ~passBits;
    if (next !== cur) user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next); // leaves WS_EX_TOPMOST as it is
  };

  const self: Overlay = {
    handle: hwnd,
    setIcon(icon) {
      setWindowIcon(hwnd, icon?.windows?.ico);
    },
    show() {
      // The webview's child is created 0x0 and only follows WM_SIZE; the first show lays it out.
      layoutChild(hwnd);
      user32.ShowWindow(hwnd, noActivate ? SW_SHOWNOACTIVATE : SW_SHOW);
      if (!noActivate && !topmost) {
        // A process without the foreground right (a GUI exe nobody has clicked yet)
        // gets its window shown behind the active one; a topmost round trip raises it
        // regardless, and SetForegroundWindow then succeeds whenever it is allowed to.
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        user32.SetForegroundWindow(hwnd);
      }
    },
    hide() {
      user32.ShowWindow(hwnd, SW_HIDE);
    },
    bounds() {
      user32.GetWindowRect(hwnd, rectBuf);
      return rectFrom(rectBuf);
    },
    moveTo(x, y) {
      // Re-assert the z-order with every move: the taskbar is topmost too and wins ties otherwise.
      user32.SetWindowPos(hwnd, topmost ? HWND_TOPMOST : 0n, Math.round(x), Math.round(y), 0, 0, SWP_NOSIZE | (topmost ? 0 : SWP_NOZORDER) | SWP_NOACTIVATE);
    },
    resize(width, height) {
      user32.SetWindowPos(hwnd, 0n, 0, 0, Math.round(width), Math.round(height), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    },
    setBounds(r) {
      user32.SetWindowPos(hwnd, topmost ? HWND_TOPMOST : 0n, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), (topmost ? 0 : SWP_NOZORDER) | SWP_NOACTIVATE);
    },
    setClickThrough(on) {
      hits.delete(hwnd); // whole-window mode wins over the regions
      user32.KillTimer(hwnd, HIT_TIMER_ID);
      passThrough(on);
    },
    setHitRegions(polygons, refine) {
      if (polygons === null) {
        hits.delete(hwnd);
        user32.KillTimer(hwnd, HIT_TIMER_ID);
        passThrough(false);
        return;
      }
      const previous = hits.get(hwnd);
      hits.set(hwnd, { packed: packRegions(polygons), passThrough, refine, inPolygon: previous?.inPolygon ?? false, askSeq: previous?.askSeq ?? 0 });
      if (!previous && user32.SetTimer(hwnd, HIT_TIMER_ID, HIT_TIMER_MS, ensureTimerProc().ptr) === 0n) {
        throw new Error(`sweetnative: SetTimer failed (${lastError()})`);
      }
      pollHit(hwnd); // things moved under a still cursor: the polygons are new, so the refiner is asked again
    },
    setTopmost(on) {
      topmost = on;
      user32.SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    },
    startDrag() {
      // Give the gesture to the window manager: it moves the window until the button comes up.
      user32.ReleaseCapture();
      user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, BigInt(HTCAPTION), 0n);
    },
    startResize(edge) {
      // Done here rather than by the OS: the size loop needs WS_THICKFRAME, which brings a
      // visible border and the library's frame arithmetic with it. The cursor's travel
      // since the press becomes the window's new bounds on every tick while the button is down.
      user32.GetCursorPos(pointBuf);
      resizing = { edge, from: self.bounds(), cursor: { x: pointBuf[0]!, y: pointBuf[1]! } };
      if (user32.SetTimer(hwnd, RESIZE_TIMER_ID, RESIZE_TIMER_MS, ensureResizeProc().ptr) === 0n) throw new Error(`sweetnative: SetTimer failed (${lastError()})`);
    },
    minimize() {
      user32.ShowWindow(hwnd, SW_MINIMIZE);
    },
    toggleMaximize() {
      // Done by hand: a popup without a caption maximises to the whole monitor, taskbar and all.
      if (restoreBounds) {
        self.setBounds(restoreBounds);
        restoreBounds = undefined;
      } else {
        restoreBounds = self.bounds();
        self.setBounds(self.workArea());
      }
    },
    maximized() {
      return restoreBounds !== undefined;
    },
    cursor(): Point {
      user32.GetCursorPos(pointBuf);
      return { x: pointBuf[0]!, y: pointBuf[1]! };
    },
    screen() {
      return { x: 0, y: 0, width: user32.GetSystemMetrics(SM_CXSCREEN), height: user32.GetSystemMetrics(SM_CYSCREEN) };
    },
    screenAt(point) {
      // A 1x1 RECT at the point: MonitorFromRect takes a pointer, MonitorFromPoint a POINT by value, which bun:ffi cannot pass.
      rectBuf[0] = Math.round(point.x);
      rectBuf[1] = Math.round(point.y);
      rectBuf[2] = rectBuf[0]! + 1;
      rectBuf[3] = rectBuf[1]! + 1;
      const monitor = user32.MonitorFromRect(rectBuf, MONITOR_DEFAULTTONEAREST);
      const info = new Int32Array(MONITORINFO_SIZE / 4);
      info[0] = MONITORINFO_SIZE;
      if (monitor === 0n || user32.GetMonitorInfoW(monitor, info) === 0) return self.screen();
      return rectFrom(info.subarray(1, 5)); // rcMonitor
    },
    workArea() {
      user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, rectBuf, 0);
      return rectFrom(rectBuf);
    },
    scale() {
      const dpi = user32.GetDpiForWindow(hwnd);
      return dpi === 0 ? 1 : dpi / 96;
    },
    virtualScreen() {
      return {
        x: user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        y: user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        width: user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        height: user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
      };
    },
  };
  return self;
}
