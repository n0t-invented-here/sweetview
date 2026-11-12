// The Win32 symbols this library needs, dlopened once. Handles travel as
// bigint (FFIType.u64) so a NULL handle is 0n, never a JS null.

import { FFIType, dlopen, type Pointer } from "bun:ffi";

export const user32 = dlopen("user32.dll", {
  // (const WNDCLASSEXW*) -> ATOM
  RegisterClassExW: { args: [FFIType.ptr], returns: FFIType.u16 },
  // (DWORD exStyle, LPCWSTR class, LPCWSTR title, DWORD style, int x, int y, int w, int h,
  //  HWND parent, HMENU menu, HINSTANCE, LPVOID param) -> HWND
  CreateWindowExW: {
    args: [
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.u64,
      FFIType.u64,
      FFIType.u64,
      FFIType.ptr,
    ],
    returns: FFIType.u64,
  },
  DestroyWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  // (HWND, UINT, WPARAM, LPARAM) -> LRESULT
  DefWindowProcW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
  RegisterWindowMessageW: { args: [FFIType.ptr], returns: FFIType.u32 },

  ShowWindow: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
  IsIconic: { args: [FFIType.u64], returns: FFIType.i32 },
  IsZoomed: { args: [FFIType.u64], returns: FFIType.i32 },
  ReleaseCapture: { args: [], returns: FFIType.i32 },
  SendMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  SetForegroundWindow: { args: [FFIType.u64], returns: FFIType.i32 },
  GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
  GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
  // (const RECT*, DWORD flags) -> HMONITOR; the monitor with the largest overlap, or the nearest one with MONITOR_DEFAULTTONEAREST
  MonitorFromRect: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
  // (HMONITOR, MONITORINFO*) -> BOOL; cbSize set by the caller
  GetMonitorInfoW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  GetDoubleClickTime: { args: [], returns: FFIType.u32 },
  // (HWND, UINT_PTR id, UINT ms, TIMERPROC) -> UINT_PTR
  SetTimer: { args: [FFIType.u64, FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
  KillTimer: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },

  CreatePopupMenu: { args: [], returns: FFIType.u64 },
  // (HMENU, UINT flags, UINT_PTR idOrSubmenu, LPCWSTR text) -> BOOL
  AppendMenuW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  DestroyMenu: { args: [FFIType.u64], returns: FFIType.i32 },
  // (HMENU, UINT item, BOOL byPosition, const MENUITEMINFOW*) -> BOOL
  SetMenuItemInfoW: { args: [FFIType.u64, FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  // (HMENU, UINT flags, int x, int y, int reserved, HWND owner, const RECT*) -> int
  TrackPopupMenu: {
    args: [FFIType.u64, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },

  // (PBYTE bits, DWORD size, BOOL icon, DWORD version, int cx, int cy, UINT flags) -> HICON
  CreateIconFromResourceEx: {
    args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
    returns: FFIType.u64,
  },
  LoadIconW: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  DestroyIcon: { args: [FFIType.u64], returns: FFIType.i32 },
  // Overlay windows: styles, placement, layered transparency, screen geometry
  GetWindowLongPtrW: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  SetWindowLongPtrW: { args: [FFIType.u64, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
  // (HWND, HWND insertAfter, x, y, cx, cy, flags) -> BOOL
  SetWindowPos: { args: [FFIType.u64, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  GetWindowRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  // (HWND, COLORREF key, BYTE alpha, DWORD flags) -> BOOL
  SetLayeredWindowAttributes: { args: [FFIType.u64, FFIType.u32, FFIType.u8, FFIType.u32], returns: FFIType.i32 },
  SystemParametersInfoW: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  PostQuitMessage: { args: [FFIType.i32], returns: FFIType.void },
  // (MSG*, HWND filter, UINT min, UINT max, UINT flags) -> BOOL; nonzero when a message was fetched
  PeekMessageW: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  TranslateMessage: { args: [FFIType.ptr], returns: FFIType.i32 },
  DispatchMessageW: { args: [FFIType.ptr], returns: FFIType.i64 },
  // (DPI_AWARENESS_CONTEXT) -> BOOL; the webview library does this only for windows it creates itself
  SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i32 },
  GetDpiForWindow: { args: [FFIType.u64], returns: FFIType.u32 },
  // (HWND, UINT cmd) -> HWND
  GetWindow: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u64 },
  GetClientRect: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  MoveWindow: { args: [FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  // (HWND, HRGN, BOOL redraw) -> int; the system owns the region afterwards
  SetWindowRgn: { args: [FFIType.u64, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
}).symbols;

export const kernel32 = dlopen("kernel32.dll", {
  GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.u64 },
  GetLastError: { args: [], returns: FFIType.u32 },
}).symbols;

export const comctl32 = dlopen("comctl32.dll", {
  // (HWND, SUBCLASSPROC, UINT_PTR id, DWORD_PTR refData) -> BOOL
  SetWindowSubclass: { args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  RemoveWindowSubclass: { args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  // (HWND, UINT, WPARAM, LPARAM) -> LRESULT : the next procedure in the subclass chain
  DefSubclassProc: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
}).symbols;

export const ole32 = dlopen("ole32.dll", {
  // (LPVOID reserved, DWORD coinit) -> HRESULT (S_OK, S_FALSE if already initialised, RPC_E_CHANGED_MODE if the other model)
  CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;

export const dwmapi = dlopen("dwmapi.dll", {
  // (HWND, const DWM_BLURBEHIND*) -> HRESULT
  DwmEnableBlurBehindWindow: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  DwmSetWindowAttribute: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;

export const gdi32 = dlopen("gdi32.dll", {
  CreateRectRgn: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.u64 },
  // (const XFORM*, DWORD bytes, const RGNDATA*) -> HRGN
  ExtCreateRegion: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
  DeleteObject: { args: [FFIType.u64], returns: FFIType.i32 },
  // (HDC, const BITMAPINFO*, UINT usage, void** bits, HANDLE section, DWORD offset) -> HBITMAP
  CreateDIBSection: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.u64 },
}).symbols;

export const shell32 = dlopen("shell32.dll", {
  // (DWORD message, PNOTIFYICONDATAW) -> BOOL
  Shell_NotifyIconW: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
}).symbols;

/**
 * NUL-terminated UTF-16LE for LPCWSTR arguments. Pass the array itself to an
 * FFIType.ptr parameter (never `ptr(wstr(..))`): Bun keeps a TypedArray
 * argument alive for the duration of the call, while a bare pointer can be
 * collected by a GC triggered while the remaining arguments are evaluated.
 */
export const wstr = (s: string): Uint8Array => new Uint8Array(Buffer.from(s + "\0", "utf16le"));

/** A non-null pointer from a bigint/number out-parameter; throws on NULL. */
export const asPointer = (v: bigint | number | null): Pointer => {
  if (v === null || v === 0 || v === 0n) throw new Error("sweetnative: unexpected NULL pointer");
  return Number(v) as Pointer;
};

/** A nullable pointer for a Win32 handle argument (HWND etc.) given as bigint, number or null. */
export const toPointer = (v: bigint | number | null): Pointer | null => (v === null || v === 0 || v === 0n ? null : (Number(v) as Pointer));

export const hInstance = (): bigint => kernel32.GetModuleHandleW(null);

export const lastError = () => kernel32.GetLastError();

export const WM_CLOSE = 0x0010;
export const WM_NCDESTROY = 0x0082;
export const WM_TIMER = 0x0113;
export const WM_LBUTTONUP = 0x0202;
export const WM_LBUTTONDBLCLK = 0x0203;
export const WM_RBUTTONUP = 0x0205;
export const WM_NULL = 0x0000;
export const WM_QUIT = 0x0012;
export const WM_APP = 0x8000;
export const WM_SETICON = 0x0080;
export const ICON_SMALL = 0n;
export const ICON_BIG = 1n;

// ShowWindow
export const SW_HIDE = 0;
export const SW_SHOWNOACTIVATE = 4;
export const SW_SHOW = 5;
export const SW_RESTORE = 9;
export const SW_MINIMIZE = 6;
/** Non-client mouse down: with a hit-test code it starts the OS's own move (HTCAPTION) or size loop. */
export const WM_NCLBUTTONDOWN = 0x00a1;
export const HTCAPTION = 2;

export const WM_DESTROY = 0x0002;
export const WM_SIZE = 0x0005;

// GetWindow
export const GW_CHILD = 5;

// GetSystemMetrics
export const SM_CXICON = 11;
export const SM_CXSMICON = 49;
export const SM_CXSCREEN = 0;
export const SM_CYSCREEN = 1;
export const SM_XVIRTUALSCREEN = 76;
export const SM_YVIRTUALSCREEN = 77;
export const SM_CXVIRTUALSCREEN = 78;
export const SM_CYVIRTUALSCREEN = 79;

// MonitorFromRect
export const MONITOR_DEFAULTTONEAREST = 2;
/** MONITORINFO: cbSize, rcMonitor, rcWork, dwFlags; 40 bytes. */
export const MONITORINFO_SIZE = 40;

// Get/SetWindowLongPtr
export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;
export const WS_POPUP = 0x80000000;
export const WS_CLIPCHILDREN = 0x02000000;
export const WS_OVERLAPPEDWINDOW = 0x00cf0000; // caption, sysmenu, thickframe, min/max boxes
export const WS_EX_TRANSPARENT = 0x00000020;
export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_APPWINDOW = 0x00040000;
export const WS_EX_LAYERED = 0x00080000;
export const WS_EX_NOACTIVATE = 0x08000000;

// SetWindowPos
export const HWND_TOPMOST = -1n;
export const HWND_NOTOPMOST = -2n;
export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOZORDER = 0x0004;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_FRAMECHANGED = 0x0020;

// SetLayeredWindowAttributes
export const LWA_COLORKEY = 0x1;
export const LWA_ALPHA = 0x2;

// SystemParametersInfo
export const SPI_GETWORKAREA = 0x0030;

// CoInitializeEx
export const COINIT_APARTMENTTHREADED = 0x2;
export const RPC_E_CHANGED_MODE = -2147417850; // 0x80010106

// SetProcessDpiAwarenessContext
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;

// DWM_BLURBEHIND.dwFlags
export const DWM_BB_ENABLE = 0x1;
export const DWM_BB_BLURREGION = 0x2;

export const PM_REMOVE = 0x0001;
