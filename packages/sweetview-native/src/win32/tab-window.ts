// Webview-free Win32 tabbed frame window: a WS_OVERLAPPEDWINDOW whose caption
// is removed in WM_NCCALCSIZE, with a top strip child pane and one child pane
// per tab. Moving a tab between windows is SetParent on its pane.
//
// Zero webview imports — stays strictly inside @n1h/sweetview/native.

import { FFIType, JSCallback, dlopen, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import type { MenuTemplate } from "../menu";
import type { Point, Rect } from "../types";
import type { ResizeEdge } from "../window";
import {
  GW_CHILD,
  HTCAPTION,
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
  WM_CLOSE,
  WM_GETMINMAXINFO,
  WM_MOVE,
  WM_NCDESTROY,
  WM_NCLBUTTONDOWN,
  WM_NULL,
  WM_SIZE,
  WS_CLIPCHILDREN,
  WS_OVERLAPPEDWINDOW,
  dwmapi,
  hInstance,
  lastError,
  user32,
  wstr,
} from "./api";
import { ensureWin32Init } from "./init";
import { popupMenu } from "./menu";
import { cursor as cursorPosition, primary as primaryScreen } from "./screen";

const extra = dlopen("user32.dll", {
  SetParent: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  FillRect: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  InvalidateRect: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetSystemMetricsForDpi: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  LoadCursorW: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  GetSystemMenu: { args: [FFIType.u64, FFIType.i32], returns: FFIType.u64 },
  EnableMenuItem: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  SetMenuDefaultItem: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
}).symbols;
const { CreateSolidBrush } = dlopen("gdi32.dll", { CreateSolidBrush: { args: [FFIType.u32], returns: FFIType.u64 } }).symbols;

const WM_ACTIVATE = 0x0006;
const WM_ERASEBKGND = 0x0014;
const WM_NCCALCSIZE = 0x0083;
const WM_DPICHANGED = 0x02e0;
const SIZE_MINIMIZED = 1n;
const WS_CHILD = 0x40000000;
const CW_USEDEFAULT = -2147483648;
const SM_CXSIZEFRAME = 32;
const SM_CYSIZEFRAME = 33;
const SM_CXPADDEDBORDER = 92;
const IDC_ARROW = 32512n;
const VK_LBUTTON = 0x01;
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const HIT: Record<ResizeEdge, number> = {
  left: 10,
  right: 11,
  top: 12,
  "top-left": 13,
  "top-right": 14,
  bottom: 15,
  "bottom-left": 16,
  "bottom-right": 17,
};

const rgb = (r: number, g: number, b: number) => (b << 16) | (g << 8) | r;
const BACKDROP = {
  light: { strip: rgb(0xe9, 0xea, 0xee), page: rgb(0xf9, 0xf9, 0xfb) },
  dark: { strip: rgb(0x29, 0x2a, 0x30), page: rgb(0x15, 0x16, 0x1a) },
};

export type FrameWindowOptions = {
  title: string;
  /** Outer bounds in pixels (optional; if omitted uses width/height DIPs centered on primary workArea). */
  bounds?: Rect;
  width?: number;
  height?: number;
  minWidth: number;
  minHeight: number;
  stripHeight: number;
  at?: Point;
  onCloseRequest(): void;
  onActivate(active: boolean): void;
  onResized(): void;
  onMoved(): void;
};

export type FrameWindow = {
  readonly hwnd: bigint;
  readonly stripPane: bigint;
  createPane(): bigint;
  adoptPane(pane: bigint): void;
  placePane(pane: bigint): void;
  showPane(pane: bigint): void;
  hidePane(pane: bigint): void;
  destroyPane(pane: bigint): void;
  layout(): void;
  pageSize(): { width: number; height: number };
  show(): void;
  hide(): void;
  isVisible(): boolean;
  bounds(): Rect;
  setBounds(rect: Rect): void;
  setTitle(title: string): void;
  stripRect(): Rect;
  scale(): number;
  isForeground(): boolean;
  isMaximized(): boolean;
  minimize(): void;
  toggleMaximize(): void;
  startDrag(held?: Point): void;
  startResize(edge: ResizeEdge, held?: Point): void;
  addCallbacks(callbacks: Partial<Pick<FrameWindowOptions, "onCloseRequest" | "onActivate" | "onResized" | "onMoved">>): void;
  destroy(): void;
};

type Frame = { options: FrameWindowOptions; stripPane: bigint; shown: bigint | undefined; live: boolean };
const frames = new Map<bigint, Frame>();
const frameApiByHwnd = new Map<bigint, FrameWindow>();
const panes = new Set<bigint>();
let dark = false;

export const getTabFrame = (hwnd: bigint): FrameWindow | undefined => frameApiByHwnd.get(hwnd);

const rect = new Int32Array(4);
const brushes = new Map<number, bigint>();
const brush = (color: number) => brushes.get(color) ?? (brushes.set(color, CreateSolidBrush(color)), brushes.get(color)!);

const dpiOf = (hwnd: bigint) => user32.GetDpiForWindow(hwnd) || 96;
const border = (dpi: number) => ({
  x: extra.GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + extra.GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi),
  y: extra.GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + extra.GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi),
});

function clientSize(hwnd: bigint): { width: number; height: number } {
  user32.GetClientRect(hwnd, rect);
  return { width: rect[2]!, height: rect[3]! };
}

function pageArea(hwnd: bigint, frame: Frame): Rect {
  const { width, height } = clientSize(hwnd);
  const strip = Math.min(height, Math.round((frame.options.stripHeight * dpiOf(hwnd)) / 96));
  return { x: 0, y: strip, width, height: height - strip };
}

function place(pane: bigint, area: Rect): void {
  user32.MoveWindow(pane, area.x, area.y, area.width, area.height, 1);
  const child = user32.GetWindow(pane, GW_CHILD);
  if (child !== 0n) user32.MoveWindow(child, 0, 0, area.width, area.height, 1);
}

function layout(hwnd: bigint, frame: Frame): void {
  const page = pageArea(hwnd, frame);
  place(frame.stripPane, { x: 0, y: 0, width: page.width, height: page.y });
  if (frame.shown !== undefined) place(frame.shown, page);
}

function erase(hwnd: bigint, hdc: bigint, color: number): bigint {
  user32.GetClientRect(hwnd, rect);
  extra.FillRect(hdc, rect, brush(color));
  return 1n;
}

const colors = () => (dark ? BACKDROP.dark : BACKDROP.light);

function frameProc(hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint {
  const frame = frames.get(hwnd);
  if (frame === undefined) return user32.DefWindowProcW(hwnd, message, wParam, lParam);
  switch (message) {
    case WM_NCCALCSIZE: {
      if (wParam === 0n) break;
      const client = new Int32Array(toArrayBuffer(Number(lParam) as Pointer, 0, 16));
      const top = client[1]!;
      const result = user32.DefWindowProcW(hwnd, message, wParam, lParam);
      client[1] = top + (user32.IsZoomed(hwnd) ? border(dpiOf(hwnd)).y : 0);
      return result;
    }
    case WM_SIZE:
      if (wParam !== SIZE_MINIMIZED) {
        layout(hwnd, frame);
        if (frame.live) frame.options.onResized();
      }
      return 0n;
    case WM_GETMINMAXINFO: {
      const info = new Int32Array(toArrayBuffer(Number(lParam) as Pointer, 0, 40));
      const dpi = dpiOf(hwnd);
      const edge = border(dpi);
      info[6] = Math.round((frame.options.minWidth * dpi) / 96) + 2 * edge.x;
      info[7] = Math.round((frame.options.minHeight * dpi) / 96) + edge.y;
      return 0n;
    }
    case WM_DPICHANGED: {
      const to = new Int32Array(toArrayBuffer(Number(lParam) as Pointer, 0, 16));
      user32.SetWindowPos(hwnd, 0n, to[0]!, to[1]!, to[2]! - to[0]!, to[3]! - to[1]!, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0n;
    }
    case WM_ERASEBKGND:
      return erase(hwnd, wParam, colors().strip);
    case WM_ACTIVATE:
      if (frame.live) frame.options.onActivate((wParam & 0xffffn) !== 0n);
      break;
    case WM_MOVE:
      if (frame.live) frame.options.onMoved();
      break;
    case WM_CLOSE:
      if (frame.live) frame.options.onCloseRequest();
      return 0n;
    case WM_NCDESTROY:
      frames.delete(hwnd);
      frameApiByHwnd.delete(hwnd);
      break;
  }
  return user32.DefWindowProcW(hwnd, message, wParam, lParam);
}

function paneProc(hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint {
  if (!panes.has(hwnd)) return user32.DefWindowProcW(hwnd, message, wParam, lParam);
  switch (message) {
    case WM_SIZE: {
      const child = user32.GetWindow(hwnd, GW_CHILD);
      if (child !== 0n) user32.MoveWindow(child, 0, 0, Number(lParam & 0xffffn), Number((lParam >> 16n) & 0xffffn), 1);
      return 0n;
    }
    case WM_ERASEBKGND: {
      const parent = [...frames].find(([, frame]) => frame.stripPane === hwnd);
      return erase(hwnd, wParam, parent ? colors().strip : colors().page);
    }
    case WM_NCDESTROY:
      panes.delete(hwnd);
      break;
  }
  return user32.DefWindowProcW(hwnd, message, wParam, lParam);
}

const FRAME_CLASS = "SweetviewTabFrame";
const PANE_CLASS = "SweetviewTabPane";
const WNDCLASSEXW_SIZE = 80;
const kept: JSCallback[] = [];

function registerClass(name: string, proc: (hwnd: bigint, message: number, wParam: bigint, lParam: bigint) => bigint): void {
  const callback = new JSCallback(
    (hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint => {
      try {
        return proc(hwnd, message, wParam, lParam);
      } catch (err) {
        console.error(`sweetview: ${name} procedure threw:`, err);
        return user32.DefWindowProcW(hwnd, message, wParam, lParam);
      }
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  );
  if (callback.ptr === null) throw new Error("sweetview: could not allocate a tab window procedure");
  kept.push(callback);
  const wc = new Uint8Array(WNDCLASSEXW_SIZE);
  const view = new DataView(wc.buffer);
  const className = wstr(name);
  view.setUint32(0, WNDCLASSEXW_SIZE, true);
  view.setBigUint64(8, BigInt(callback.ptr), true);
  view.setBigUint64(24, hInstance(), true);
  view.setBigUint64(40, extra.LoadCursorW(0n, IDC_ARROW), true);
  view.setBigUint64(64, BigInt(ptr(className)), true);
  if (user32.RegisterClassExW(ptr(wc)) === 0) throw new Error(`sweetview: RegisterClassExW(${name}) failed (${lastError()})`);
}

let ready = false;
function prepare(): void {
  if (ready) return;
  ensureWin32Init();
  registerClass(FRAME_CLASS, frameProc);
  registerClass(PANE_CLASS, paneProc);
  ready = true;
}

function createPaneIn(parent: bigint, area: Rect): bigint {
  const pane = user32.CreateWindowExW(0, wstr(PANE_CLASS), null, WS_CHILD | WS_CLIPCHILDREN, area.x, area.y, area.width, area.height, parent, 0n, hInstance(), null);
  if (pane === 0n) throw new Error(`sweetview: CreateWindowExW(pane) failed (${lastError()})`);
  panes.add(pane);
  return pane;
}

function applyDark(hwnd: bigint): void {
  dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, new Int32Array([dark ? 1 : 0]), 4);
  extra.InvalidateRect(hwnd, null, 1);
}

export function setDarkWindows(on: boolean): void {
  if (dark === on) return;
  dark = on;
  for (const hwnd of frames.keys()) applyDark(hwnd);
}

export const windowExists = (hwnd: bigint): boolean => user32.IsWindow(hwnd) !== 0;
export const leftButtonDown = (): boolean => user32.GetAsyncKeyState(VK_LBUTTON) < 0;
export { cursorPosition };

export function createFrameWindow(options: FrameWindowOptions): FrameWindow {
  prepare();
  const hwnd = user32.CreateWindowExW(0, wstr(FRAME_CLASS), wstr(options.title), WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, CW_USEDEFAULT, 0, 0, 0, 0n, 0n, hInstance(), null);
  if (hwnd === 0n) throw new Error(`sweetview: CreateWindowExW(frame) failed (${lastError()})`);
  const frame: Frame = { options, stripPane: 0n, shown: undefined, live: false };
  frames.set(hwnd, frame);
  applyDark(hwnd);

  const dpi = dpiOf(hwnd);
  const edge = border(dpi);
  let x: number;
  let y: number;
  let width: number;
  let height: number;
  if (options.bounds) {
    x = Math.round(options.bounds.x);
    y = Math.round(options.bounds.y);
    width = Math.round(options.bounds.width);
    height = Math.round(options.bounds.height);
  } else {
    width = Math.round(((options.width ?? 1040) * dpi) / 96) + 2 * edge.x;
    height = Math.round(((options.height ?? 760) * dpi) / 96) + edge.y;
    const area = primaryScreen().workArea;
    x = options.at ? options.at.x - edge.x : area.x + Math.round((area.width - width) / 2);
    y = options.at ? options.at.y : area.y + Math.max(0, Math.round((area.height - height) / 2));
  }
  user32.SetWindowPos(hwnd, 0n, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);

  const page = pageArea(hwnd, frame);
  frame.stripPane = createPaneIn(hwnd, { x: 0, y: 0, width: page.width, height: page.y });
  user32.ShowWindow(frame.stripPane, SW_SHOW);

  const sinceHeld = (held: Point): Point => {
    const at = cursorPosition();
    const scale = dpiOf(hwnd) / 96;
    user32.GetWindowRect(frame.stripPane, rect);
    return { x: at.x - (rect[0]! + Math.round(held.x * scale)), y: at.y - (rect[1]! + Math.round(held.y * scale)) };
  };

  const self: FrameWindow = {
    hwnd,
    stripPane: frame.stripPane,
    createPane: () => createPaneIn(hwnd, pageArea(hwnd, frame)),
    adoptPane(pane) {
      user32.ShowWindow(pane, SW_HIDE);
      for (const other of frames.values()) if (other.shown === pane) other.shown = undefined;
      if (extra.SetParent(pane, hwnd) === 0n) throw new Error(`sweetview: SetParent failed (${lastError()})`);
    },
    placePane: (pane) => place(pane, pageArea(hwnd, frame)),
    showPane(pane) {
      place(pane, pageArea(hwnd, frame));
      user32.SetWindowPos(pane, 0n, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | 0x0040);
      frame.shown = pane;
    },
    hidePane(pane) {
      user32.ShowWindow(pane, SW_HIDE);
      if (frame.shown === pane) frame.shown = undefined;
    },
    destroyPane(pane) {
      if (frame.shown === pane) frame.shown = undefined;
      user32.DestroyWindow(pane);
    },
    layout: () => layout(hwnd, frame),
    pageSize() {
      const area = pageArea(hwnd, frame);
      const scale = dpiOf(hwnd) / 96;
      return { width: Math.max(1, Math.round(area.width / scale)), height: Math.max(1, Math.round(area.height / scale)) };
    },
    show() {
      user32.ShowWindow(hwnd, user32.IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
      user32.SetForegroundWindow(hwnd);
    },
    hide: () => void user32.ShowWindow(hwnd, SW_HIDE),
    isVisible: () => user32.IsWindowVisible(hwnd) !== 0,
    bounds() {
      user32.GetWindowRect(hwnd, rect);
      return { x: rect[0]!, y: rect[1]!, width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! };
    },
    setBounds(r) {
      user32.SetWindowPos(hwnd, 0n, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), SWP_NOZORDER | SWP_NOACTIVATE);
    },
    setTitle: (title) => void user32.SetWindowTextW(hwnd, wstr(title)),
    stripRect() {
      user32.GetWindowRect(frame.stripPane, rect);
      return { x: rect[0]!, y: rect[1]!, width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! };
    },
    scale: () => dpiOf(hwnd) / 96,
    isForeground: () => extra.GetForegroundWindow() === hwnd,
    isMaximized: () => user32.IsZoomed(hwnd) !== 0,
    minimize: () => void user32.ShowWindow(hwnd, SW_MINIMIZE),
    toggleMaximize: () => void user32.ShowWindow(hwnd, user32.IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE),
    startDrag(held) {
      if (!leftButtonDown()) return;
      if (held !== undefined && !user32.IsZoomed(hwnd)) {
        const travelled = sinceHeld(held);
        user32.GetWindowRect(hwnd, rect);
        user32.SetWindowPos(hwnd, 0n, rect[0]! + travelled.x, rect[1]! + travelled.y, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
      }
      user32.ReleaseCapture();
      user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, BigInt(HTCAPTION), 0n);
    },
    startResize(edge, held) {
      if (!leftButtonDown() || user32.IsZoomed(hwnd)) return;
      if (held !== undefined) {
        const travelled = sinceHeld(held);
        user32.GetWindowRect(hwnd, rect);
        let [left, top, right] = [rect[0]!, rect[1]!, rect[2]!];
        const bottom = rect[3]!;
        if (edge.includes("top")) top += travelled.y;
        if (edge.includes("left")) left += travelled.x;
        if (edge.includes("right")) right += travelled.x;
        user32.SetWindowPos(hwnd, 0n, left, top, right - left, bottom - top, SWP_NOZORDER | SWP_NOACTIVATE);
      }
      user32.ReleaseCapture();
      user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, BigInt(HIT[edge]), 0n);
    },
    addCallbacks(callbacks) {
      if (callbacks.onCloseRequest) {
        const prev = frame.options.onCloseRequest;
        const next = callbacks.onCloseRequest;
        frame.options.onCloseRequest = () => {
          prev();
          next();
        };
      }
      if (callbacks.onActivate) {
        const prev = frame.options.onActivate;
        const next = callbacks.onActivate;
        frame.options.onActivate = (a) => {
          prev(a);
          next(a);
        };
      }
      if (callbacks.onResized) {
        const prev = frame.options.onResized;
        const next = callbacks.onResized;
        frame.options.onResized = () => {
          prev();
          next();
        };
      }
      if (callbacks.onMoved) {
        const prev = frame.options.onMoved;
        const next = callbacks.onMoved;
        frame.options.onMoved = () => {
          prev();
          next();
        };
      }
    },
    destroy: () => {
      if (user32.IsWindow(hwnd) !== 0) user32.DestroyWindow(hwnd);
    },
  };
  frameApiByHwnd.set(hwnd, self);
  frame.live = true;
  return self;
}

export function showTabPopupMenu(owner: bigint, template: MenuTemplate): boolean {
  return popupMenu(owner, template);
}

const MF_STRING = 0x0;
const MF_GRAYED = 0x1;
const TPM_RIGHTBUTTON = 0x0002;
const TPM_RETURNCMD = 0x0100;
const WM_SYSCOMMAND = 0x0112;
const SC_SIZE = 0xf000;
const SC_MOVE = 0xf010;
const SC_MINIMIZE = 0xf020;
const SC_MAXIMIZE = 0xf030;
const SC_CLOSE = 0xf060;
const SC_RESTORE = 0xf120;

/** Shows the Windows system titlebar menu (Restore, Move, Size, Minimize, Maximize, Close). */
export function windowMenu(hwnd: bigint): void {
  const menu = extra.GetSystemMenu(hwnd, 0);
  if (menu === 0n) return;
  const maximized = user32.IsZoomed(hwnd) !== 0;
  for (const [command, enabled] of [
    [SC_RESTORE, maximized],
    [SC_MOVE, !maximized],
    [SC_SIZE, !maximized],
    [SC_MINIMIZE, true],
    [SC_MAXIMIZE, !maximized],
  ] as const) {
    extra.EnableMenuItem(menu, command, enabled ? MF_STRING : MF_GRAYED);
  }
  extra.SetMenuDefaultItem(menu, SC_CLOSE, 0);
  const at = cursorPosition();
  user32.SetForegroundWindow(hwnd);
  const chosen = user32.TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD, at.x, at.y, 0, hwnd, null);
  user32.PostMessageW(hwnd, WM_NULL, 0n, 0n);
  if (chosen !== 0) user32.PostMessageW(hwnd, WM_SYSCOMMAND, BigInt(chosen), 0n);
}
