// WebView2 COM controller helpers for Windows tabs: visibility, focus,
// position sync, accelerator keys, new-window interception, and DevTools
// commands. Lives in src/tabs/ (webview layer), never in src/native/.

import { CFunction, FFIType, JSCallback, dlopen, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import type { Webview } from "@n1h/sweetview-webview-bun";
import { ole32 } from "../native/win32/api";
import type { Key } from "../native/win32/shortcuts";
import { openWebviewCore } from "../webview-lib";

export type Controller = Pointer;

const WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER = 2;

// ICoreWebView2Controller
const PUT_IS_VISIBLE = 4;
const MOVE_FOCUS = 12;
const ADD_ACCELERATOR_KEY_PRESSED = 19;
const NOTIFY_PARENT_WINDOW_POSITION_CHANGED = 23;
const GET_CORE_WEBVIEW2 = 25;
// ICoreWebView2
const CALL_DEV_TOOLS_PROTOCOL_METHOD = 36;
const ADD_NEW_WINDOW_REQUESTED = 44;
// ICoreWebView2AcceleratorKeyPressedEventArgs
const GET_KEY_EVENT_KIND = 3;
const GET_VIRTUAL_KEY = 4;
const ACCELERATOR_PUT_HANDLED = 8;
// ICoreWebView2NewWindowRequestedEventArgs
const GET_URI = 3;
const NEW_WINDOW_PUT_HANDLED = 6;
// IUnknown
const RELEASE = 2;

const COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC = 0;
const COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN = 0;
const COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN = 2;

const S_OK = 0;
const E_NOINTERFACE = -2147467262;
const IID_IUNKNOWN = "00000000-0000-0000-c000-000000000046";
const IID_ACCELERATOR_KEY_PRESSED_HANDLER = "b29c7e28-fa79-41a8-8e44-65811c76dcb2";
const IID_NEW_WINDOW_REQUESTED_HANDLER = "d4c185fe-c81c-4989-97af-2d3fa7ab5651";

const { GetKeyState } = dlopen("user32.dll", { GetKeyState: { args: [FFIType.i32], returns: FFIType.i16 } }).symbols;

const compiled = new Map<number, (...args: unknown[]) => number>();
function call(object: Pointer, index: number, args: FFIType[], ...values: unknown[]): number {
  const address = read.ptr(read.ptr(object, 0) as Pointer, index * 8);
  let method = compiled.get(address);
  if (method === undefined) {
    method = CFunction({ ptr: address as Pointer, args: [FFIType.ptr, ...args], returns: FFIType.i32 }) as unknown as (...args: unknown[]) => number;
    compiled.set(address, method);
  }
  return method(object, ...values);
}

const failed = (what: string, hr: number) => new Error(`sweetview: ${what} failed (0x${(hr >>> 0).toString(16)})`);

/** The ICoreWebView2Controller of a webview the library made. Reuses the cached libwebview symbols. */
export function controllerOf(webview: Webview, libPath: string): Controller {
  const get = openWebviewCore(libPath).webview_get_native_handle;
  const controller = webview.unsafeHandle === null ? null : get(webview.unsafeHandle, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER);
  if (controller === null) throw new Error("sweetview: the webview has no browser controller");
  return controller;
}

export function setVisible(controller: Controller, visible: boolean): void {
  call(controller, PUT_IS_VISIBLE, [FFIType.i32], visible ? 1 : 0);
}

export function moveFocus(controller: Controller): void {
  call(controller, MOVE_FOCUS, [FFIType.i32], COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}

export function notifyMoved(controller: Controller): void {
  call(controller, NOTIFY_PARENT_WINDOW_POSITION_CHANGED, []);
}

type Invoke = (args: Pointer) => void;
type HandlerKind = { vtable: BigUint64Array; byAddress: Map<number, Invoke>; kept: BigUint64Array[] };

const stable = (slots: number) => new BigUint64Array(new ArrayBuffer(slots * 8));

function guidBytes(guid: string): Uint8Array {
  const hex = guid.replaceAll("-", "");
  const byte = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return Uint8Array.from([3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15], byte);
}

const sameBytes = (address: Pointer, bytes: Uint8Array) =>
  new Uint8Array(toArrayBuffer(address, 0, bytes.length)).every((b, i) => b === bytes[i]);

function handlerKind(iid: string): HandlerKind {
  const iids = [guidBytes(IID_IUNKNOWN), guidBytes(iid)];
  const byAddress = new Map<number, Invoke>();
  const queryInterface = new JSCallback(
    (self: Pointer, riid: Pointer, out: Pointer): number => {
      const known = iids.some((bytes) => sameBytes(riid, bytes));
      new BigUint64Array(toArrayBuffer(out, 0, 8))[0] = known ? BigInt(self) : 0n;
      return known ? S_OK : E_NOINTERFACE;
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const addRef = new JSCallback((): number => 2, { args: [FFIType.ptr], returns: FFIType.u32 });
  const release = new JSCallback((): number => 1, { args: [FFIType.ptr], returns: FFIType.u32 });
  const invoke = new JSCallback(
    (self: Pointer, _sender: Pointer, args: Pointer): number => {
      try {
        byAddress.get(Number(self))?.(args);
      } catch (err) {
        console.error("sweetview: a WebView2 event handler threw:", err);
      }
      return S_OK;
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const vtable = stable(4);
  vtable.set([queryInterface, addRef, release, invoke].map((callback) => BigInt(callback.ptr!)));
  return { vtable, byAddress, kept: [] };
}

function makeHandler(kind: HandlerKind, invoke: Invoke): { object: Pointer; forget(): void } {
  const object = stable(1);
  object[0] = BigInt(ptr(kind.vtable));
  kind.kept.push(object);
  const address = ptr(object);
  kind.byAddress.set(Number(address), invoke);
  return { object: address, forget: () => void kind.byAddress.delete(Number(address)) };
}

let acceleratorHandlers: HandlerKind | undefined;
let newWindowHandlers: HandlerKind | undefined;

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const down = (virtualKey: number) => GetKeyState(virtualKey) < 0;

export function onAcceleratorKey(controller: Controller, taken: (key: Key) => boolean): () => void {
  acceleratorHandlers ??= handlerKind(IID_ACCELERATOR_KEY_PRESSED_HANDLER);
  const number = new Uint32Array(1);
  const handler = makeHandler(acceleratorHandlers, (args) => {
    call(args, GET_KEY_EVENT_KIND, [FFIType.ptr], number);
    if (number[0] !== COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && number[0] !== COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return;
    call(args, GET_VIRTUAL_KEY, [FFIType.ptr], number);
    if (taken({ virtualKey: number[0]!, control: down(VK_CONTROL), shift: down(VK_SHIFT), alt: down(VK_MENU) })) {
      call(args, ACCELERATOR_PUT_HANDLED, [FFIType.i32], 1);
    }
  });
  const hr = call(controller, ADD_ACCELERATOR_KEY_PRESSED, [FFIType.ptr, FFIType.ptr], handler.object, new BigInt64Array(1));
  if (hr !== S_OK) throw failed("add_AcceleratorKeyPressed", hr);
  return handler.forget;
}

function wideString(address: Pointer): string {
  let text = "";
  for (let offset = 0, unit = read.u16(address, 0); unit !== 0; unit = read.u16(address, (offset += 2))) text += String.fromCharCode(unit);
  return text;
}

export function onNewWindowRequested(controller: Controller, opened: (address: string) => void): () => void {
  newWindowHandlers ??= handlerKind(IID_NEW_WINDOW_REQUESTED_HANDLER);
  const out = new BigUint64Array(1);
  const handler = makeHandler(newWindowHandlers, (args) => {
    if (call(args, GET_URI, [FFIType.ptr], out) !== S_OK || out[0] === 0n) return;
    const uri = Number(out[0]) as Pointer;
    const address = wideString(uri);
    ole32.CoTaskMemFree(uri);
    call(args, NEW_WINDOW_PUT_HANDLED, [FFIType.i32], 1);
    setTimeout(() => opened(address), 0);
  });
  let hr = call(controller, GET_CORE_WEBVIEW2, [FFIType.ptr], out);
  if (hr !== S_OK || out[0] === 0n) throw failed("get_CoreWebView2", hr);
  const core = Number(out[0]) as Pointer;
  hr = call(core, ADD_NEW_WINDOW_REQUESTED, [FFIType.ptr, FFIType.ptr], handler.object, new BigInt64Array(1));
  call(core, RELEASE, []);
  if (hr !== S_OK) throw failed("add_NewWindowRequested", hr);
  return handler.forget;
}

const wide = (text: string) => new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));

export function devTools(controller: Controller, method: string, params: object): void {
  const out = new BigUint64Array(1);
  let hr = call(controller, GET_CORE_WEBVIEW2, [FFIType.ptr], out);
  if (hr !== S_OK || out[0] === 0n) throw failed("get_CoreWebView2", hr);
  const core = Number(out[0]) as Pointer;
  hr = call(core, CALL_DEV_TOOLS_PROTOCOL_METHOD, [FFIType.ptr, FFIType.ptr, FFIType.ptr], wide(method), wide(JSON.stringify(params)), null);
  call(core, RELEASE, []);
  if (hr !== S_OK) throw failed(`CallDevToolsProtocolMethod(${method})`, hr);
}
