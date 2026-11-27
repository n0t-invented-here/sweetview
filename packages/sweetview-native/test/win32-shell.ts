// Test support: what reaches the Windows shell. A window of the test's own (test/win32-os.ts,
// `ownWindow`) is registered with SHChangeNotifyRegister for SHCNE_ASSOCCHANGED, so the test sees
// the notification the shell hands every registered window when an application calls
// SHChangeNotify(SHCNE_ASSOCCHANGED). Listed in rust-rewrite/ffi-allowlist.txt as a probe.

import { FFIType, dlopen, ptr } from "bun:ffi";
import { ownWindow, WM_APP } from "./win32-os";

const { u64, u32, i32 } = FFIType;
const shell32 = dlopen("shell32.dll", {
  // (HWND, int fSources, LONG fEvents, UINT wMsg, int cEntries, const SHChangeNotifyEntry*) -> ULONG
  SHChangeNotifyRegister: { args: [u64, i32, i32, u32, i32, FFIType.ptr], returns: u32 },
  SHChangeNotifyDeregister: { args: [u32], returns: i32 },
  // (HWND, int csidl, PIDLIST_ABSOLUTE*) -> HRESULT
  SHGetSpecialFolderLocation: { args: [u64, i32, FFIType.ptr], returns: i32 },
  ILFree: { args: [u64], returns: FFIType.void },
}).symbols;

export const SHCNE_ASSOCCHANGED = 0x0800_0000;
const SHCNRF_INTERRUPT_LEVEL = 0x0001;
const SHCNRF_SHELL_LEVEL = 0x0002;
const CSIDL_DESKTOP = 0;
const WM_SHELL_CHANGE = WM_APP + 0x51;

export type ShellChangeWatch = {
  /** The events (lParam) delivered so far, in order. */
  readonly events: number[];
  /** How many SHCNE_ASSOCCHANGED notifications arrived so far. */
  assocChanged(): number;
  dispose(): void;
};

/** Registers a window of the test's own for SHCNE_ASSOCCHANGED, recursively from the desktop. Delivered while the UI thread's loop runs. */
export function watchAssocChanged(): ShellChangeWatch {
  const events: number[] = [];
  const window = ownWindow((message, _wParam, lParam) => {
    if (message === WM_SHELL_CHANGE) events.push(Number(BigInt.asUintN(32, lParam)));
  });
  const pidlOut = new BigUint64Array(1);
  const hr = shell32.SHGetSpecialFolderLocation(0n, CSIDL_DESKTOP, ptr(pidlOut));
  if (hr !== 0) {
    window.destroy();
    throw new Error(`SHGetSpecialFolderLocation failed (0x${(hr >>> 0).toString(16)})`);
  }
  // SHChangeNotifyEntry: { PCIDLIST_ABSOLUTE pidl; BOOL fRecursive; } — 16 bytes on x64.
  const entry = new DataView(new ArrayBuffer(16));
  entry.setBigUint64(0, pidlOut[0]!, true);
  entry.setInt32(8, 1, true);
  const id = shell32.SHChangeNotifyRegister(window.hwnd, SHCNRF_SHELL_LEVEL | SHCNRF_INTERRUPT_LEVEL, SHCNE_ASSOCCHANGED, WM_SHELL_CHANGE, 1, ptr(entry.buffer));
  shell32.ILFree(pidlOut[0]!);
  if (id === 0) {
    window.destroy();
    throw new Error("SHChangeNotifyRegister refused the registration");
  }
  let disposed = false;
  return {
    events,
    assocChanged: () => events.filter((event) => (event & SHCNE_ASSOCCHANGED) !== 0).length,
    dispose() {
      if (disposed) return;
      disposed = true;
      shell32.SHChangeNotifyDeregister(id);
      window.destroy();
    },
  };
}
