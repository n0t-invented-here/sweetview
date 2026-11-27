// Test support: finds this process's tray, menu and dialog windows, reads a
// popup menu back from the OS, and drives them with posted messages, the way
// the shell and the keyboard would. Nothing here moves the cursor, presses a
// key system-wide or touches the clipboard: every input is a message posted
// to one of this process's own windows.

import { FFIType, dlopen, ptr } from "bun:ffi";

const { u64, u32, i32, i64 } = FFIType;
const user32 = dlopen("user32.dll", {
  FindWindowExW: { args: [u64, u64, FFIType.ptr, FFIType.ptr], returns: u64 },
  GetWindowThreadProcessId: { args: [u64, FFIType.ptr], returns: u32 },
  IsWindowVisible: { args: [u64], returns: i32 },
  GetWindow: { args: [u64, u32], returns: u64 },
  GetParent: { args: [u64], returns: u64 },
  GetDlgCtrlID: { args: [u64], returns: i32 },
  GetWindowRect: { args: [u64, FFIType.ptr], returns: i32 },
  GetCursorPos: { args: [FFIType.ptr], returns: i32 },
  GetDoubleClickTime: { args: [], returns: u32 },
  EndMenu: { args: [], returns: i32 },
  IsWindow: { args: [u64], returns: i32 },
  PostMessageW: { args: [u64, u32, u64, i64], returns: i32 },
  SendMessageW: { args: [u64, u32, u64, i64], returns: i64 },
  RegisterWindowMessageW: { args: [FFIType.ptr], returns: u32 },
  GetMenuItemCount: { args: [u64], returns: i32 },
  GetMenuState: { args: [u64, u32, u32], returns: u32 },
  GetMenuStringW: { args: [u64, u32, FFIType.ptr, i32, u32], returns: i32 },
  GetSubMenu: { args: [u64, i32], returns: u64 },
  GetMenuItemInfoW: { args: [u64, u32, i32, FFIType.ptr], returns: i32 },
  GetClassNameW: { args: [u64, FFIType.ptr, i32], returns: i32 },
  GetWindowTextW: { args: [u64, FFIType.ptr, i32], returns: i32 },
  EnumChildWindows: { args: [u64, FFIType.ptr, i64], returns: i32 },
  GetGuiResources: { args: [u64, u32], returns: u32 },
}).symbols;
const kernel32 = dlopen("kernel32.dll", { GetCurrentProcess: { args: [], returns: u64 } }).symbols;

/** The process's GDI and USER object counts. */
export function guiObjects(): { gdi: number; user: number } {
  const process = kernel32.GetCurrentProcess();
  return { gdi: user32.GetGuiResources(process, 0), user: user32.GetGuiResources(process, 1) };
}

const wide = (s: string) => new Uint8Array(Buffer.from(s + "\0", "utf16le"));

/** The windows of class `className` (and title `title`, when given) that belong to this process. */
export function ownWindows(className: string, title?: string): bigint[] {
  const cls = wide(className);
  const name = title === undefined ? null : wide(title);
  const pid = new Uint32Array(1);
  const found: bigint[] = [];
  let after = 0n;
  for (let i = 0; i < 10_000; i++) {
    after = user32.FindWindowExW(0n, after, cls, name);
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

/** Posts key presses to a popup menu window, which its menu loop takes as the keyboard. */
export function pressKeys(menuWindow: bigint, ...keys: number[]): void {
  for (const key of keys) post(menuWindow, WM_KEYDOWN, BigInt(key), 1n);
}

// ---- dialogs ------------------------------------------------------------------------------

const WM_SETTEXT = 0x000c;
const BM_CLICK = 0x00f5;
export const WM_CLOSE = 0x0010;

function children(parent: bigint): bigint[] {
  const { JSCallback } = require("bun:ffi") as typeof import("bun:ffi");
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
