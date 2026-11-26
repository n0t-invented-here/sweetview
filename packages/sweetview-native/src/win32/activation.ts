// Windows custom URL scheme registration (HKCU\Software\Classes\<scheme>) and
// single-instance lock + handoff (CreateMutexW + HWND_MESSAGE + WM_COPYDATA +
// AllowSetForegroundWindow). No admin/UAC required.

import { FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { validateUrlScheme } from "@n1h/sweetview-settings";
import type { RegisterUrlSchemeOptions, SecondInstanceEvent, SingleInstanceLock } from "../activation";
import {
  ERROR_ALREADY_EXISTS,
  ERROR_FILE_NOT_FOUND,
  HKEY_CURRENT_USER,
  HWND_MESSAGE,
  KEY_WRITE,
  REG_SZ,
  SMTO_ABORTIFHUNG,
  WM_CLOSE,
  WM_COPYDATA,
  advapi32,
  hInstance,
  kernel32,
  lastError,
  user32,
  wstr,
} from "./api";
import { ensureWin32Init } from "./init";

const IPC_CLASS_NAME = "SweetviewSingleInstanceWindow";
const WNDCLASSEXW_SIZE = 80;
const COPYDATA_MAGIC = 0x5357_5631n; // "SWV1"

function setRegString(subKey: string, valueName: string | null, data: string): void {
  const keyOut = new BigUint64Array(1);
  const status = advapi32.RegCreateKeyExW(HKEY_CURRENT_USER, wstr(subKey), 0, null, 0, KEY_WRITE, null, ptr(keyOut), null);
  if (status !== 0) {
    throw new Error(`sweetview: RegCreateKeyExW(${subKey}) failed (${status})`);
  }
  const hKey = keyOut[0]!;
  try {
    const buf = wstr(data);
    const setStatus = advapi32.RegSetValueExW(hKey, valueName === null ? null : wstr(valueName), 0, REG_SZ, buf, buf.byteLength);
    if (setStatus !== 0) {
      throw new Error(`sweetview: RegSetValueExW(${subKey}, ${valueName ?? "(Default)"}) failed (${setStatus})`);
    }
  } finally {
    advapi32.RegCloseKey(hKey);
  }
}

export function registerUrlScheme(scheme: string, options: RegisterUrlSchemeOptions = {}): void {
  const normalized = validateUrlScheme(scheme);
  const exePath = options.executablePath ?? process.execPath;
  const appName = options.appName ?? options.identity?.appName ?? normalized;
  const icon = options.iconPath ?? `${exePath},0`;
  const command = options.command ?? `"${exePath}" "%1"`;

  const root = `Software\\Classes\\${normalized}`;
  setRegString(root, null, `URL:${appName} Protocol`);
  setRegString(root, "URL Protocol", "");
  setRegString(`${root}\\DefaultIcon`, null, icon);
  setRegString(`${root}\\shell\\open\\command`, null, command);
}

export function unregisterUrlScheme(scheme: string): void {
  const normalized = validateUrlScheme(scheme);
  const root = `Software\\Classes\\${normalized}`;
  const status = advapi32.RegDeleteTreeW(HKEY_CURRENT_USER, wstr(root));
  if (status !== 0 && status !== ERROR_FILE_NOT_FOUND) {
    throw new Error(`sweetview: RegDeleteTreeW(${root}) failed (${status})`);
  }
}

// ---- single-instance WM_COPYDATA window -----------------------------------------

const handlersByHwnd = new Map<bigint, (event: SecondInstanceEvent) => void>();
let ipcWndProc: JSCallback | undefined;

function ensureIpcClass(): void {
  if (ipcWndProc !== undefined) return;
  ipcWndProc = new JSCallback(
    (hwnd: bigint, message: number, _wParam: bigint, lParam: bigint): bigint => {
      if (message === WM_COPYDATA && lParam !== 0n) {
        try {
          // COPYDATASTRUCT on x64: ULONG_PTR dwData (8), DWORD cbData (4), pad (4), PVOID lpData (8)
          const dv = new DataView(toArrayBuffer(Number(lParam) as Pointer, 0, 24));
          const magic = dv.getBigUint64(0, true);
          const cbData = dv.getUint32(8, true);
          const lpData = dv.getBigUint64(16, true);
          if (magic === COPYDATA_MAGIC && cbData > 0 && lpData !== 0n) {
            const bytes = new Uint8Array(toArrayBuffer(Number(lpData) as Pointer, 0, cbData));
            const payload = JSON.parse(new TextDecoder().decode(bytes)) as SecondInstanceEvent;
            handlersByHwnd.get(hwnd)?.(payload);
            return 1n;
          }
        } catch (err) {
          console.error("sweetview: singleInstance WM_COPYDATA handler threw:", err);
        }
        return 0n;
      }
      if (message === WM_CLOSE) return 0n;
      return user32.DefWindowProcW(hwnd, message, _wParam, lParam);
    },
    { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  );
  if (ipcWndProc.ptr === null) throw new Error("sweetview: could not allocate singleInstance window procedure");

  const wc = new Uint8Array(WNDCLASSEXW_SIZE);
  const dv = new DataView(wc.buffer);
  const className = wstr(IPC_CLASS_NAME);
  dv.setUint32(0, WNDCLASSEXW_SIZE, true);
  dv.setBigUint64(8, BigInt(ipcWndProc.ptr), true);
  dv.setBigUint64(24, hInstance(), true);
  dv.setBigUint64(64, BigInt(ptr(className)), true);
  if (user32.RegisterClassExW(ptr(wc)) === 0) {
    throw new Error(`sweetview: RegisterClassExW(${IPC_CLASS_NAME}) failed (${lastError()})`);
  }
}

function safeId(appId: string): string {
  return appId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sendCopyData(targetHwnd: bigint, payload: SecondInstanceEvent): boolean {
  const pidBuf = new Uint32Array(1);
  user32.GetWindowThreadProcessId(targetHwnd, ptr(pidBuf));
  if (pidBuf[0] && pidBuf[0] > 0) {
    user32.AllowSetForegroundWindow(pidBuf[0]);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const cds = new Uint8Array(24);
  const dv = new DataView(cds.buffer);
  dv.setBigUint64(0, COPYDATA_MAGIC, true);
  dv.setUint32(8, bytes.byteLength, true);
  dv.setBigUint64(16, BigInt(ptr(bytes)), true);
  const resultOut = new BigUint64Array(1);
  const sent = user32.SendMessageTimeoutW(
    targetHwnd,
    WM_COPYDATA,
    0n,
    BigInt(ptr(cds)),
    SMTO_ABORTIFHUNG,
    5000,
    ptr(resultOut),
  );
  return sent !== 0n && resultOut[0] === 1n;
}

export async function acquireSingleInstance(params: {
  appId: string;
  payload: SecondInstanceEvent;
  onSecondInstance: (event: SecondInstanceEvent) => void;
}): Promise<SingleInstanceLock> {
  ensureWin32Init();
  const id = safeId(params.appId);
  const mutexName = `Local\\sweetview.instance.${id}`;
  const windowTitle = `sweetview.instance.${id}`;

  const mutex = kernel32.CreateMutexW(null, 0, wstr(mutexName));
  if (mutex === 0n) {
    throw new Error(`sweetview: CreateMutexW(${mutexName}) failed (${lastError()})`);
  }

  if (lastError() === ERROR_ALREADY_EXISTS) {
    let handedOff = false;
    try {
      const target = user32.FindWindowExW(HWND_MESSAGE, 0n, wstr(IPC_CLASS_NAME), wstr(windowTitle));
      if (target !== 0n) {
        handedOff = sendCopyData(target, params.payload);
      }
    } finally {
      kernel32.CloseHandle(mutex);
    }
    return {
      isPrimary: false,
      handedOff,
      dispose() {},
    };
  }

  ensureIpcClass();
  const hwnd = user32.CreateWindowExW(
    0,
    wstr(IPC_CLASS_NAME),
    wstr(windowTitle),
    0,
    0,
    0,
    0,
    0,
    HWND_MESSAGE,
    0n,
    hInstance(),
    null,
  );
  if (hwnd === 0n) {
    kernel32.CloseHandle(mutex);
    throw new Error(`sweetview: CreateWindowExW(${IPC_CLASS_NAME}) failed (${lastError()})`);
  }

  handlersByHwnd.set(hwnd, params.onSecondInstance);
  let disposed = false;
  return {
    isPrimary: true,
    handedOff: false,
    dispose() {
      if (disposed) return;
      disposed = true;
      handlersByHwnd.delete(hwnd);
      if (user32.IsWindow(hwnd) !== 0) user32.DestroyWindow(hwnd);
      kernel32.CloseHandle(mutex);
    },
  };
}

export function installUrlEventHandler(_onUrl: (url: string) => void): void {
  // Windows delivers custom URL launches as argv[1] to the process (or via singleInstance WM_COPYDATA).
}
