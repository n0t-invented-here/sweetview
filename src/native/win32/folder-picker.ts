// Native Windows folder picker: IFileOpenDialog (the modern Vista+ dialog)
// driven directly over COM vtables with bun:ffi. No child process.
//
// Must be called on the thread that owns the window (the webview UI thread),
// which is already COM-initialised (apartment threaded) by WebView2.

import { CFunction, FFIType, dlopen, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import type { WindowHandle } from "../window";
import { asPointer, toPointer, wstr } from "./api";

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CoCreateInstance: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
});

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const CLSID_FileOpenDialog = guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
const IID_IFileOpenDialog = guid("D57C7288-D4AD-4768-BE02-9D969532D960");

const FOS_NOCHANGEDIR = 0x8;
const FOS_PICKFOLDERS = 0x20;
const FOS_FORCEFILESYSTEM = 0x40;
const FOS_PATHMUSTEXIST = 0x800;
const SIGDN_FILESYSPATH = 0x80058000;
const HRESULT_CANCELLED = 0x800704c7 | 0; // HRESULT_FROM_WIN32(ERROR_CANCELLED)

// vtable slots (shobjidl_core.h)
const IUnknown_Release = 2;
const IModalWindow_Show = 3;
const IFileDialog_SetOptions = 9;
const IFileDialog_GetOptions = 10;
const IFileDialog_SetTitle = 17;
const IFileDialog_GetResult = 20;
const IShellItem_GetDisplayName = 5;

type Fn = (...args: unknown[]) => number;

function guid(s: string): Uint8Array {
  const hex = s.replace(/-/g, "");
  const b = new Uint8Array(16);
  const view = new DataView(b.buffer);
  view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
  view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
  view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

function method(obj: Pointer, slot: number, args: FFIType[], returns: FFIType): Fn {
  const vtable = asPointer(read.ptr(obj, 0));
  const fn = asPointer(read.ptr(vtable, slot * 8));
  return CFunction({ ptr: fn, args, returns }) as unknown as Fn;
}

function release(obj: Pointer) {
  method(obj, IUnknown_Release, [FFIType.ptr], FFIType.u32)(obj);
}

function readWide(p: Pointer): string {
  let n = 0;
  while (read.u16(p, n * 2) !== 0) n++;
  return new TextDecoder("utf-16le").decode(toArrayBuffer(p, 0, n * 2));
}

function check(hr: number, what: string) {
  if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
}

/** Opens the native folder dialog owned by `owner`. Returns the path, or null if cancelled. */
export function pickFolder(owner: WindowHandle, title: string): string | null {
  const hwnd = toPointer(owner);
  // S_OK or S_FALSE (already initialised on this thread by WebView2).
  check(ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED), "CoInitializeEx");

  const out = new BigUint64Array(1);
  check(
    ole32.symbols.CoCreateInstance(ptr(CLSID_FileOpenDialog), null, CLSCTX_INPROC_SERVER, ptr(IID_IFileOpenDialog), ptr(out)),
    "CoCreateInstance(FileOpenDialog)",
  );
  const dialog = asPointer(out[0]!);

  try {
    const opts = new Uint32Array(1);
    check(method(dialog, IFileDialog_GetOptions, [FFIType.ptr, FFIType.ptr], FFIType.i32)(dialog, ptr(opts)), "GetOptions");
    check(
      method(dialog, IFileDialog_SetOptions, [FFIType.ptr, FFIType.u32], FFIType.i32)(
        dialog,
        (opts[0]! | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR) >>> 0,
      ),
      "SetOptions",
    );
    check(method(dialog, IFileDialog_SetTitle, [FFIType.ptr, FFIType.ptr], FFIType.i32)(dialog, wstr(title)), "SetTitle");

    const hr = method(dialog, IModalWindow_Show, [FFIType.ptr, FFIType.ptr], FFIType.i32)(dialog, hwnd);
    if (hr === HRESULT_CANCELLED) return null;
    check(hr, "Show");

    out[0] = 0n;
    check(method(dialog, IFileDialog_GetResult, [FFIType.ptr, FFIType.ptr], FFIType.i32)(dialog, ptr(out)), "GetResult");
    const item = asPointer(out[0]!);
    try {
      out[0] = 0n;
      check(
        method(item, IShellItem_GetDisplayName, [FFIType.ptr, FFIType.u32, FFIType.ptr], FFIType.i32)(item, SIGDN_FILESYSPATH, ptr(out)),
        "GetDisplayName",
      );
      const pwsz = asPointer(out[0]!);
      try {
        return readWide(pwsz);
      } finally {
        ole32.symbols.CoTaskMemFree(pwsz);
      }
    } finally {
      release(item);
    }
  } finally {
    release(dialog);
  }
}
