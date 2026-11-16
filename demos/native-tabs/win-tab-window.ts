// A tabbed window on Windows. Windows has no window tabbing to borrow (a tab
// is not a window here, as it is on macOS), so the window is ours: a normal
// resizable top-level window whose title bar is given over to the page, with
// child windows inside it:
//
//   the frame        WS_OVERLAPPEDWINDOW, its caption removed in WM_NCCALCSIZE:
//                    the shadow, the rounded corners, the side and bottom
//                    resize borders, snap and maximise stay the system's
//   the strip pane   along the top; hosts the webview that draws the tabs
//   a pane per tab   below it, one shown at a time; each hosts a tab's webview
//
// A pane is the window handed to `createWebviewApp({ window })`. The webview
// library puts its own child in it and never sizes that child again, so a
// pane's procedure does (WM_SIZE). Moving a tab to another window is
// SetParent on its pane: the webview goes with it, page and all.
//
// Windows only, and demo-local for the reason mac-window-tabs.ts is.

import { FFIType, JSCallback, dlopen, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import type { ResizeEdge, WindowHandle } from "@n1h/sweetview/native";
import {
  COINIT_APARTMENTTHREADED,
  DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
  GW_CHILD,
  HTCAPTION,
  RPC_E_CHANGED_MODE,
  SPI_GETWORKAREA,
  SWP_FRAMECHANGED,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  SW_HIDE,
  SW_MINIMIZE,
  SW_RESTORE,
  SW_SHOW,
  WM_CLOSE,
  WM_NCDESTROY,
  WM_NCLBUTTONDOWN,
  WM_NULL,
  WM_SIZE,
  WS_CLIPCHILDREN,
  WS_OVERLAPPEDWINDOW,
  dwmapi,
  hInstance,
  lastError,
  ole32,
  user32,
  wstr,
} from "../../src/native/win32/api";

const extra = dlopen("user32.dll", {
  SetParent: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  IsWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  SetWindowTextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  // (HDC, const RECT*, HBRUSH) -> int
  FillRect: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  // (HWND, const RECT*, BOOL erase) -> BOOL
  InvalidateRect: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  GetSystemMetricsForDpi: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  GetDpiForSystem: { args: [], returns: FFIType.u32 },
  LoadCursorW: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  // (HWND, BOOL revert) -> HMENU: the window's own menu, Restore to Close
  GetSystemMenu: { args: [FFIType.u64, FFIType.i32], returns: FFIType.u64 },
  // (HMENU, UINT item, UINT flags) -> BOOL
  EnableMenuItem: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  // (HMENU, UINT item, UINT byPosition) -> BOOL
  SetMenuDefaultItem: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
}).symbols;
const { CreateSolidBrush } = dlopen("gdi32.dll", { CreateSolidBrush: { args: [FFIType.u32], returns: FFIType.u64 } }).symbols;

const WM_MOVE = 0x0003;
const WM_ACTIVATE = 0x0006;
const WM_ERASEBKGND = 0x0014;
const WM_GETMINMAXINFO = 0x0024;
const WM_NCCALCSIZE = 0x0083;
const WM_DPICHANGED = 0x02e0;
const SIZE_MINIMIZED = 1n;
const SW_MAXIMIZE = 3;
const WS_CHILD = 0x40000000;
const CW_USEDEFAULT = -2147483648; // 0x80000000 as an int
const SM_CXSIZEFRAME = 32;
const SM_CYSIZEFRAME = 33;
const SM_CXPADDEDBORDER = 92;
const IDC_ARROW = 32512n;
const VK_LBUTTON = 0x01;
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const HIT: Record<ResizeEdge, number> = { left: 10, right: 11, top: 12, "top-left": 13, "top-right": 14, bottom: 15, "bottom-left": 16, "bottom-right": 17 };

// What shows for a moment where no page has painted yet (a window growing under the cursor, a
// tab still loading): the strip's colour and the page's, as frontend/strip.css and main.css have them.
const rgb = (r: number, g: number, b: number) => (b << 16) | (g << 8) | r; // COLORREF is 0x00BBGGRR
const BACKDROP = {
  light: { strip: rgb(0xe9, 0xea, 0xee), page: rgb(0xf9, 0xf9, 0xfb) },
  dark: { strip: rgb(0x29, 0x2a, 0x30), page: rgb(0x15, 0x16, 0x1a) },
};

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export type FrameWindowOptions = {
  /** In the taskbar and Alt+Tab; the window draws no title of its own. */
  title: string;
  /** The inside of the window, strip and page together, in DIPs. */
  width: number;
  height: number;
  /** The smallest inside the user can drag the window to, in DIPs. */
  minWidth: number;
  minHeight: number;
  /** How much of the top the strip takes, in DIPs. */
  stripHeight: number;
  /** Where the window's top-left corner goes, in screen pixels. Default: centred on the primary monitor's work area. */
  at?: Point;
  /** The user asked to close the window (the taskbar, Alt+F4 with no page focused). The window stays until `destroy`. */
  onCloseRequest(): void;
  onActivate(active: boolean): void;
  /** The size changed, or the window was maximised or restored. */
  onResized(): void;
  /** The window is somewhere else on screen. */
  onMoved(): void;
};

export type FrameWindow = {
  readonly hwnd: bigint;
  /** Where the strip's webview goes. */
  readonly stripPane: bigint;
  /** A hidden child window the size of the page area, for one tab's webview. */
  createPane(): bigint;
  /** Takes a pane from another frame; it arrives hidden. */
  adoptPane(pane: bigint): void;
  /** Sizes a pane, and the webview in it, to the page area: after the webview library has made its child in the pane, and sized the pane its own way. */
  placePane(pane: bigint): void;
  /** Sizes a pane to the page area and puts it in front. A pane shown before stays shown: hide it afterwards, so the page area is never empty in between. */
  showPane(pane: bigint): void;
  hidePane(pane: bigint): void;
  destroyPane(pane: bigint): void;
  /** Puts the strip and the shown pane where they belong, each with its webview over all of it. */
  layout(): void;
  /** The page area in DIPs: the `width` and `height` to give `createWebviewApp` for a pane. */
  pageSize(): { width: number; height: number };
  show(): void;
  hide(): void;
  setTitle(title: string): void;
  /** The strip on screen, in pixels. */
  stripRect(): Rect;
  /** Pixels per DIP on the monitor the window is on. */
  scale(): number;
  isForeground(): boolean;
  maximized(): boolean;
  minimize(): void;
  toggleMaximize(): void;
  /**
   * Hands a press that is still held to the window manager: the window
   * follows the cursor until the button comes up, snapping as any window
   * does. Returns only then. `held` is where in the strip the press was, in
   * DIPs: the cursor has moved since, and the window is first put back under
   * it, so it does not trail the hand by the time it took to get here.
   */
  startDrag(held?: Point): void;
  /** The same for an edge: the top ones are the page's to offer, the caption that had them being gone. */
  startResize(edge: ResizeEdge, held?: Point): void;
  destroy(): void;
};

/** `live` once createFrameWindow has returned: the owner hears nothing about a window it does not have yet. */
type Frame = { options: FrameWindowOptions; stripPane: bigint; shown: bigint | undefined; live: boolean };
const frames = new Map<bigint, Frame>();
const panes = new Set<bigint>();
let dark = false;

const rect = new Int32Array(4);
const point = new Int32Array(2);
const brushes = new Map<number, bigint>();
const brush = (color: number) => brushes.get(color) ?? (brushes.set(color, CreateSolidBrush(color)), brushes.get(color)!);

const dpiOf = (hwnd: bigint) => user32.GetDpiForWindow(hwnd) || 96;
/** The resize border the system keeps outside the visible window, left, right and bottom. */
const border = (dpi: number) => ({
  x: extra.GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + extra.GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi),
  y: extra.GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + extra.GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi),
});

function clientSize(hwnd: bigint): { width: number; height: number } {
  user32.GetClientRect(hwnd, rect);
  return { width: rect[2]!, height: rect[3]! };
}

/** Where a tab's pane goes inside a frame: everything below the strip. */
function pageArea(hwnd: bigint, frame: Frame): Rect {
  const { width, height } = clientSize(hwnd);
  const strip = Math.min(height, Math.round((frame.options.stripHeight * dpiOf(hwnd)) / 96));
  return { x: 0, y: strip, width, height: height - strip };
}

/**
 * Puts a pane at a place in its frame, and the webview library's child over
 * all of it. The child is sized here and not only on WM_SIZE: the library
 * makes it 0 by 0 in a pane that already has its size, and a pane that does
 * not change size is sent no WM_SIZE.
 */
function place(pane: bigint, area: Rect): void {
  user32.MoveWindow(pane, area.x, area.y, area.width, area.height, 1);
  const child = user32.GetWindow(pane, GW_CHILD);
  if (child !== 0n) user32.MoveWindow(child, 0, 0, area.width, area.height, 1);
}

function layout(hwnd: bigint, frame: Frame): void {
  const page = pageArea(hwnd, frame);
  place(frame.stripPane, { x: 0, y: 0, width: page.width, height: page.y });
  // Only the pane on show; one that is hidden is sized when it is shown, so dragging an edge costs one page's layout, not every tab's.
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
      // The first RECT of NCCALCSIZE_PARAMS comes in as the window and goes out as its client
      // area. The default takes a caption and a border off the top; put the top back, so the
      // client area reaches the window's top edge and the strip is the title bar. A maximised
      // window hangs over the monitor's edges by its border, top included: that much stays off.
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
      // MINMAXINFO: five POINTs; ptMinTrackSize is the fourth
      const info = new Int32Array(toArrayBuffer(Number(lParam) as Pointer, 0, 40));
      const dpi = dpiOf(hwnd);
      const edge = border(dpi);
      info[6] = Math.round((frame.options.minWidth * dpi) / 96) + 2 * edge.x;
      info[7] = Math.round((frame.options.minHeight * dpi) / 96) + edge.y;
      return 0n;
    }
    case WM_DPICHANGED: {
      // lParam: the RECT the system suggests for the new monitor's scale
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
      break;
  }
  return user32.DefWindowProcW(hwnd, message, wParam, lParam);
}

function paneProc(hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint {
  if (!panes.has(hwnd)) return user32.DefWindowProcW(hwnd, message, wParam, lParam);
  switch (message) {
    case WM_SIZE: {
      // The webview library's child fills the pane.
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
const kept: JSCallback[] = []; // the classes call them until the process ends

function registerClass(name: string, proc: (hwnd: bigint, message: number, wParam: bigint, lParam: bigint) => bigint): void {
  const callback = new JSCallback(
    (hwnd: bigint, message: number, wParam: bigint, lParam: bigint): bigint => {
      try {
        return proc(hwnd, message, wParam, lParam);
      } catch (err) {
        console.error(`native-tabs: ${name} procedure threw:`, err); // never let an exception unwind into user32
        return user32.DefWindowProcW(hwnd, message, wParam, lParam);
      }
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  );
  if (callback.ptr === null) throw new Error("native-tabs: could not allocate a window procedure");
  kept.push(callback);
  const wc = new Uint8Array(WNDCLASSEXW_SIZE);
  const view = new DataView(wc.buffer);
  const className = wstr(name);
  view.setUint32(0, WNDCLASSEXW_SIZE, true); // cbSize
  view.setBigUint64(8, BigInt(callback.ptr), true); // lpfnWndProc
  view.setBigUint64(24, hInstance(), true); // hInstance
  view.setBigUint64(40, extra.LoadCursorW(0n, IDC_ARROW), true); // hCursor
  view.setBigUint64(64, BigInt(ptr(className)), true); // lpszClassName; hbrBackground stays NULL, WM_ERASEBKGND paints
  if (user32.RegisterClassExW(ptr(wc)) === 0) throw new Error(`native-tabs: RegisterClassExW(${name}) failed (${lastError()})`);
}

let ready = false;
function prepare(): void {
  if (ready) return;
  // The webview library does these two only for windows it creates itself. WebView2 needs a
  // single-threaded apartment on this thread, and DPI awareness can only be set before any window exists.
  const hr = ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (hr === RPC_E_CHANGED_MODE) throw new Error("native-tabs: this thread already initialised COM as multi-threaded; WebView2 needs an STA");
  user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  registerClass(FRAME_CLASS, frameProc);
  registerClass(PANE_CLASS, paneProc);
  ready = true;
}

function createPaneIn(parent: bigint, area: Rect): bigint {
  const pane = user32.CreateWindowExW(0, wstr(PANE_CLASS), null, WS_CHILD | WS_CLIPCHILDREN, area.x, area.y, area.width, area.height, parent, 0n, hInstance(), null);
  if (pane === 0n) throw new Error(`native-tabs: CreateWindowExW(pane) failed (${lastError()})`);
  panes.add(pane);
  return pane;
}

function applyDark(hwnd: bigint): void {
  dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, new Int32Array([dark ? 1 : 0]), 4); // the border the system draws around the window
  extra.InvalidateRect(hwnd, null, 1);
}

/** Light or dark, for every tab window: the border the system draws, and what shows before a page has painted. */
export function setDarkWindows(on: boolean): void {
  if (dark === on) return;
  dark = on;
  for (const hwnd of frames.keys()) applyDark(hwnd);
}

/** The handle to give `createWebviewApp({ window })` for a pane. */
export const asWindowHandle = (pane: bigint): WindowHandle => pane;

/** Whether a window still exists: a destroyed pane's does not. */
export const windowExists = (hwnd: bigint): boolean => extra.IsWindow(hwnd) !== 0;

export function cursorPosition(): Point {
  user32.GetCursorPos(point);
  return { x: point[0]!, y: point[1]! };
}

export const leftButtonDown = (): boolean => user32.GetAsyncKeyState(VK_LBUTTON) < 0;

export function createFrameWindow(options: FrameWindowOptions): FrameWindow {
  prepare();
  const hwnd = user32.CreateWindowExW(0, wstr(FRAME_CLASS), wstr(options.title), WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, CW_USEDEFAULT, 0, 0, 0, 0n, 0n, hInstance(), null);
  if (hwnd === 0n) throw new Error(`native-tabs: CreateWindowExW(frame) failed (${lastError()})`);
  const frame: Frame = { options, stripPane: 0n, shown: undefined, live: false };
  frames.set(hwnd, frame);
  applyDark(hwnd);

  // The size, now that the window knows its monitor's scale; SWP_FRAMECHANGED sends the
  // WM_NCCALCSIZE that takes the caption off (the one sent during creation came before `frames` knew the window).
  const dpi = dpiOf(hwnd);
  const edge = border(dpi);
  const width = Math.round((options.width * dpi) / 96) + 2 * edge.x;
  const height = Math.round((options.height * dpi) / 96) + edge.y;
  user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, rect, 0);
  const x = options.at ? options.at.x - edge.x : rect[0]! + Math.round((rect[2]! - rect[0]! - width) / 2);
  const y = options.at ? options.at.y : rect[1]! + Math.max(0, Math.round((rect[3]! - rect[1]! - height) / 2));
  user32.SetWindowPos(hwnd, 0n, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);

  const page = pageArea(hwnd, frame);
  frame.stripPane = createPaneIn(hwnd, { x: 0, y: 0, width: page.width, height: page.y });
  user32.ShowWindow(frame.stripPane, SW_SHOW);

  /** How far the cursor is from a place in the strip it was on when the button went down. */
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
      if (extra.SetParent(pane, hwnd) === 0n) throw new Error(`native-tabs: SetParent failed (${lastError()})`);
    },
    placePane: (pane) => place(pane, pageArea(hwnd, frame)),
    showPane(pane) {
      place(pane, pageArea(hwnd, frame));
      user32.SetWindowPos(pane, 0n /* HWND_TOP */, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | 0x0040 /* SWP_SHOWWINDOW */);
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
    setTitle: (title) => void extra.SetWindowTextW(hwnd, wstr(title)),
    stripRect() {
      user32.GetWindowRect(frame.stripPane, rect);
      return { x: rect[0]!, y: rect[1]!, width: rect[2]! - rect[0]!, height: rect[3]! - rect[1]! };
    },
    scale: () => dpiOf(hwnd) / 96,
    isForeground: () => extra.GetForegroundWindow() === hwnd,
    maximized: () => user32.IsZoomed(hwnd) !== 0,
    minimize: () => void user32.ShowWindow(hwnd, SW_MINIMIZE),
    toggleMaximize: () => void user32.ShowWindow(hwnd, user32.IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE),
    startDrag(held) {
      if (!leftButtonDown()) return; // let go already: there is no gesture to hand over, and the move loop would wait for a click
      if (held !== undefined && !user32.IsZoomed(hwnd)) {
        const travelled = sinceHeld(held);
        user32.GetWindowRect(hwnd, rect);
        user32.SetWindowPos(hwnd, 0n, rect[0]! + travelled.x, rect[1]! + travelled.y, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
      } // a maximised window is restored under the cursor by the window manager itself
      user32.ReleaseCapture();
      user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, BigInt(HTCAPTION), 0n);
    },
    startResize(edge, held) {
      if (!leftButtonDown() || user32.IsZoomed(hwnd)) return;
      if (held !== undefined) {
        // the edge catches up with the cursor: the others stay where they are
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
    destroy: () => void user32.DestroyWindow(hwnd),
  };
  frame.live = true;
  return self;
}

export type MenuEntry = { label: string; enabled?: boolean; click(): void } | "separator";

const MF_STRING = 0x0;
const MF_GRAYED = 0x1;
const MF_SEPARATOR = 0x800;
const TPM_RIGHTBUTTON = 0x0002;
const TPM_RETURNCMD = 0x0100;

/**
 * The system's popup menu at the cursor, owned by a frame. Blocks until the
 * menu closes, then runs the chosen entry. A tab's label after a tab
 * character is its shortcut, right-aligned, as in any Windows menu.
 */
export function popupMenu(owner: bigint, entries: MenuEntry[]): void {
  const menu = user32.CreatePopupMenu();
  if (menu === 0n) throw new Error("native-tabs: CreatePopupMenu failed");
  entries.forEach((entry, index) => {
    if (entry === "separator") user32.AppendMenuW(menu, MF_SEPARATOR, 0n, null);
    else user32.AppendMenuW(menu, MF_STRING | (entry.enabled === false ? MF_GRAYED : 0), BigInt(index + 1), wstr(entry.label.replaceAll("&", "&&"))); // ids are 1-based: 0 is "nothing chosen"
  });
  const at = cursorPosition();
  // The owner has to be the foreground window or the menu does not go away on a click elsewhere;
  // the WM_NULL afterwards is the documented nudge that lets the next one close too (KB 135788).
  user32.SetForegroundWindow(owner);
  const chosen = user32.TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD, at.x, at.y, 0, owner, null);
  user32.PostMessageW(owner, WM_NULL, 0n, 0n);
  user32.DestroyMenu(menu);
  const entry = entries[chosen - 1];
  if (entry !== undefined && entry !== "separator") entry.click();
}

const WM_SYSCOMMAND = 0x0112;
const SC_SIZE = 0xf000;
const SC_MOVE = 0xf010;
const SC_MINIMIZE = 0xf020;
const SC_MAXIMIZE = 0xf030;
const SC_CLOSE = 0xf060;
const SC_RESTORE = 0xf120;

/**
 * The window's own menu (Restore, Move, Size, Minimize, Maximize, Close) at
 * the cursor: what a right-click on a title bar shows. The caption that
 * showed it is gone, so the strip's empty part asks for it. Blocks until the
 * menu closes; what was chosen is the window manager's to carry out.
 */
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
    extra.EnableMenuItem(menu, command, enabled ? MF_STRING : MF_GRAYED); // by command; MF_STRING is also "enabled"
  }
  extra.SetMenuDefaultItem(menu, SC_CLOSE, 0);
  const at = cursorPosition();
  user32.SetForegroundWindow(hwnd);
  const chosen = user32.TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD, at.x, at.y, 0, hwnd, null);
  user32.PostMessageW(hwnd, WM_NULL, 0n, 0n);
  if (chosen !== 0) user32.PostMessageW(hwnd, WM_SYSCOMMAND, BigInt(chosen), 0n);
}
