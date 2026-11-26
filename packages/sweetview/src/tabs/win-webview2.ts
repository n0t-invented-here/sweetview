// WebView2 COM controller helpers for Windows tabs: visibility, focus,
// position sync, accelerator keys, new-window interception, and DevTools
// commands. Lives in src/tabs/ (webview layer), never in src/native/.

import { CFunction, FFIType, JSCallback, dlopen, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import type { Webview } from "@n1h/sweetview-webview-bun";
import { ole32 } from "@n1h/sweetview-native/win32/api";
import type { Key } from "@n1h/sweetview-native/win32/shortcuts";
import { openWebviewCore } from "../webview-lib";

export type Controller = Pointer;

const WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER = 2;

// ICoreWebView2Controller
const PUT_IS_VISIBLE = 4;
const MOVE_FOCUS = 12;
const ADD_ACCELERATOR_KEY_PRESSED = 19;
const REMOVE_ACCELERATOR_KEY_PRESSED = 20;
const NOTIFY_PARENT_WINDOW_POSITION_CHANGED = 23;
const GET_CORE_WEBVIEW2 = 25;
// ICoreWebView2
const GET_SOURCE = 4;
const ADD_NAVIGATION_STARTING = 7;
const REMOVE_NAVIGATION_STARTING = 8;
const ADD_NAVIGATION_COMPLETED = 15;
const REMOVE_NAVIGATION_COMPLETED = 16;
const CALL_DEV_TOOLS_PROTOCOL_METHOD = 36;
const ADD_NEW_WINDOW_REQUESTED = 44;
const REMOVE_NEW_WINDOW_REQUESTED = 45;
// ICoreWebView2NavigationStartingEventArgs
const STARTING_GET_URI = 3;
const STARTING_GET_NAVIGATION_ID = 9;
// ICoreWebView2NavigationCompletedEventArgs (+ ...Args2 for get_HttpStatusCode)
const GET_IS_SUCCESS = 3;
const GET_WEB_ERROR_STATUS = 4;
const COMPLETED_GET_NAVIGATION_ID = 5;
const GET_HTTP_STATUS_CODE = 6;
// ICoreWebView2AcceleratorKeyPressedEventArgs
const GET_KEY_EVENT_KIND = 3;
const GET_VIRTUAL_KEY = 4;
const ACCELERATOR_PUT_HANDLED = 8;
// ICoreWebView2NewWindowRequestedEventArgs
const GET_URI = 3;
const NEW_WINDOW_PUT_HANDLED = 6;
// IUnknown
const QUERY_INTERFACE = 0;
const ADD_REF = 1;
const RELEASE = 2;

const COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC = 0;
const COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN = 0;
const COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN = 2;

const S_OK = 0;
const E_NOINTERFACE = -2147467262;
const IID_IUNKNOWN = "00000000-0000-0000-c000-000000000046";
const IID_ACCELERATOR_KEY_PRESSED_HANDLER = "b29c7e28-fa79-41a8-8e44-65811c76dcb2";
const IID_NEW_WINDOW_REQUESTED_HANDLER = "d4c185fe-c81c-4989-97af-2d3fa7ab5651";
const IID_NAVIGATION_STARTING_HANDLER = "9adbe429-f36d-432b-9ddc-f8881fbd76e3";
const IID_NAVIGATION_COMPLETED_HANDLER = "d33a35bf-1c49-4f98-93ab-006e0533fe1c";
const IID_NAVIGATION_COMPLETED_EVENT_ARGS2 = "fdf8b738-ee1e-4db2-a329-8d7d7b74d792";

// COREWEBVIEW2_WEB_ERROR_STATUS
const WEB_ERROR_STATUS_CONNECTION_ABORTED = 9;
const WEB_ERROR_STATUS_OPERATION_CANCELED = 14;
const WEB_ERROR_REASONS: Record<number, string> = {
  1: "The site's security certificate names a different host.",
  2: "The site's security certificate has expired.",
  3: "The client certificate contains errors.",
  4: "The site's security certificate has been revoked.",
  5: "The site's security certificate is not valid.",
  6: "The server is unreachable.",
  7: "The connection timed out.",
  8: "The server sent an invalid response.",
  10: "The connection was reset.",
  11: "The network connection was lost.",
  12: "Could not connect to the server.",
  13: "The server's host name could not be found.",
  15: "A redirect failed.",
  16: "An unexpected error occurred.",
  17: "The site requires authentication.",
  18: "The proxy requires authentication.",
};

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
/** One live handler object: `refs` counts COM references (ours included); `invoke` is cleared when its subscription ends. */
type LiveHandler = { readonly object: BigUint64Array; refs: number; invoke?: Invoke };
/**
 * The vtable and JSCallbacks shared by every handler of one event-handler
 * interface. The callbacks live for the process (one set per interface);
 * each handler object is dropped once its COM reference count reaches zero.
 */
type HandlerKind = { readonly vtable: BigUint64Array; readonly live: Map<number, LiveHandler>; release(self: number): number };

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
  const live = new Map<number, LiveHandler>();
  const releaseHandler = (self: number): number => {
    const handler = live.get(self);
    if (handler === undefined) return 0;
    handler.refs -= 1;
    if (handler.refs > 0) return handler.refs;
    // Last reference gone: nothing calls this object again, so its memory can be reclaimed.
    handler.invoke = undefined;
    live.delete(self);
    return 0;
  };
  const queryInterface = new JSCallback(
    (self: Pointer, riid: Pointer, out: Pointer): number => {
      const known = iids.some((bytes) => sameBytes(riid, bytes));
      new BigUint64Array(toArrayBuffer(out, 0, 8))[0] = known ? BigInt(self) : 0n;
      if (!known) return E_NOINTERFACE;
      // QueryInterface hands out a new reference.
      const handler = live.get(Number(self));
      if (handler !== undefined) handler.refs += 1;
      return S_OK;
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const addRef = new JSCallback(
    (self: Pointer): number => {
      const handler = live.get(Number(self));
      if (handler === undefined) return 1;
      handler.refs += 1;
      return handler.refs;
    },
    { args: [FFIType.ptr], returns: FFIType.u32 },
  );
  const release = new JSCallback((self: Pointer): number => releaseHandler(Number(self)), { args: [FFIType.ptr], returns: FFIType.u32 });
  const invoke = new JSCallback(
    (self: Pointer, _sender: Pointer, args: Pointer): number => {
      try {
        live.get(Number(self))?.invoke?.(args);
      } catch (err) {
        console.error("sweetview: a WebView2 event handler threw:", err);
      }
      return S_OK;
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const vtable = stable(4);
  vtable.set([queryInterface, addRef, release, invoke].map((callback) => BigInt(callback.ptr!)));
  return { vtable, live, release: releaseHandler };
}

/**
 * A new handler object holding one reference (ours). `dispose()` stops its
 * invocations and drops that reference; WebView2 drops its own on remove_*
 * (or when the webview closes), and the object is reclaimed at zero.
 */
function makeHandler(kind: HandlerKind, invoke: Invoke): { object: Pointer; dispose(): void } {
  const object = stable(1);
  object[0] = BigInt(ptr(kind.vtable));
  const address = Number(ptr(object));
  const handler: LiveHandler = { object, refs: 1, invoke };
  kind.live.set(address, handler);
  let disposed = false;
  return {
    object: address as Pointer,
    dispose() {
      if (disposed) return;
      disposed = true;
      handler.invoke = undefined;
      kind.release(address);
    },
  };
}

/**
 * Adds `invoke` as a handler of one `add_*`/`remove_*` event pair on `source`,
 * holding a reference to `source` until the returned function removes it, so
 * removal never depends on another object staying alive. The returned
 * function is idempotent; call it before the webview is destroyed.
 */
function subscribe(source: Pointer, add: number, remove: number, kind: HandlerKind, invoke: Invoke, what: string): () => void {
  const handler = makeHandler(kind, invoke);
  const token = new BigInt64Array(1);
  const hr = call(source, add, [FFIType.ptr, FFIType.ptr], handler.object, token);
  if (hr !== S_OK) {
    handler.dispose();
    throw failed(what, hr);
  }
  call(source, ADD_REF, []);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    handler.dispose();
    call(source, remove, [FFIType.i64], token[0]);
    call(source, RELEASE, []);
  };
}

/** Runs `use` with the controller's ICoreWebView2, released afterwards. */
function withCore<T>(controller: Controller, use: (core: Pointer) => T): T {
  const out = new BigUint64Array(1);
  const hr = call(controller, GET_CORE_WEBVIEW2, [FFIType.ptr], out);
  if (hr !== S_OK || out[0] === 0n) throw failed("get_CoreWebView2", hr);
  const core = Number(out[0]) as Pointer;
  try {
    return use(core);
  } finally {
    call(core, RELEASE, []);
  }
}

let acceleratorHandlers: HandlerKind | undefined;
let newWindowHandlers: HandlerKind | undefined;
let navigationStartingHandlers: HandlerKind | undefined;
let navigationCompletedHandlers: HandlerKind | undefined;

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const down = (virtualKey: number) => GetKeyState(virtualKey) < 0;

/** Handles accelerator keys the page would see; the returned function removes the handler. */
export function onAcceleratorKey(controller: Controller, taken: (key: Key) => boolean): () => void {
  acceleratorHandlers ??= handlerKind(IID_ACCELERATOR_KEY_PRESSED_HANDLER);
  const number = new Uint32Array(1);
  return subscribe(controller, ADD_ACCELERATOR_KEY_PRESSED, REMOVE_ACCELERATOR_KEY_PRESSED, acceleratorHandlers, (args) => {
    call(args, GET_KEY_EVENT_KIND, [FFIType.ptr], number);
    if (number[0] !== COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && number[0] !== COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return;
    call(args, GET_VIRTUAL_KEY, [FFIType.ptr], number);
    if (taken({ virtualKey: number[0]!, control: down(VK_CONTROL), shift: down(VK_SHIFT), alt: down(VK_MENU) })) {
      call(args, ACCELERATOR_PUT_HANDLED, [FFIType.i32], 1);
    }
  }, "add_AcceleratorKeyPressed");
}

function wideString(address: Pointer): string {
  let text = "";
  for (let offset = 0, unit = read.u16(address, 0); unit !== 0; unit = read.u16(address, (offset += 2))) text += String.fromCharCode(unit);
  return text;
}

/** Reads a CoTaskMem string property (`get_Uri`, `get_Source`) of `object` and frees it; undefined when unavailable. */
function stringProperty(object: Pointer, index: number): string | undefined {
  const out = new BigUint64Array(1);
  if (call(object, index, [FFIType.ptr], out) !== S_OK || out[0] === 0n) return undefined;
  const address = Number(out[0]) as Pointer;
  const text = wideString(address);
  ole32.CoTaskMemFree(address);
  return text;
}

/** Calls `opened` (on a later tick) instead of opening a window for each new-window request; the returned function removes the handler. */
export function onNewWindowRequested(controller: Controller, opened: (address: string) => void): () => void {
  newWindowHandlers ??= handlerKind(IID_NEW_WINDOW_REQUESTED_HANDLER);
  const kind = newWindowHandlers;
  return withCore(controller, (core) =>
    subscribe(core, ADD_NEW_WINDOW_REQUESTED, REMOVE_NEW_WINDOW_REQUESTED, kind, (args) => {
      const address = stringProperty(args, GET_URI);
      if (address === undefined) return;
      call(args, NEW_WINDOW_PUT_HANDLED, [FFIType.i32], 1);
      setTimeout(() => opened(address), 0);
    }, "add_NewWindowRequested"),
  );
}

/** The response's HTTP status (0 when none arrived), or undefined on runtimes without ICoreWebView2NavigationCompletedEventArgs2. */
function httpStatusOf(args: Pointer): number | undefined {
  const out = new BigUint64Array(1);
  if (call(args, QUERY_INTERFACE, [FFIType.ptr, FFIType.ptr], guidBytes(IID_NAVIGATION_COMPLETED_EVENT_ARGS2), out) !== S_OK || out[0] === 0n) return undefined;
  const args2 = Number(out[0]) as Pointer;
  const status = new Int32Array(1);
  const hr = call(args2, GET_HTTP_STATUS_CODE, [FFIType.ptr], status);
  call(args2, RELEASE, []);
  return hr === S_OK ? status[0] : undefined;
}

export type NavigationFailure = {
  /** The address the failed navigation was loading (its last redirect target). */
  readonly url: string;
  readonly reason: string;
  /** False once a newer navigation has started; a page shown for this failure must not replace that navigation. */
  isCurrent(): boolean;
};

/**
 * Calls `onFailed` when the webview's latest top-level navigation fails
 * without a response. Navigations cancelled by a newer one
 * (OperationCanceled), aborted ones (ConnectionAborted, which a navigation
 * that becomes a download also reports), HTTP error responses (the server's
 * own error page is shown), `about:`/`data:` loads, and navigations a newer
 * one already superseded are not reported. Navigation ids come from
 * NavigationStarting, so register this before the first `navigate` to catch
 * an initial navigation that fails at once. The returned function removes
 * both handlers; call it before the webview is destroyed.
 */
export function onNavigationFailed(controller: Controller, onFailed: (failure: NavigationFailure) => void): () => void {
  navigationStartingHandlers ??= handlerKind(IID_NAVIGATION_STARTING_HANDLER);
  navigationCompletedHandlers ??= handlerKind(IID_NAVIGATION_COMPLETED_HANDLER);
  const startingKind = navigationStartingHandlers;
  const completedKind = navigationCompletedHandlers;
  // Started navigations' addresses by NavigationId; a completed navigation's entry is removed.
  const navUrls = new Map<bigint, string>();
  let latestNavId: bigint | undefined;
  const id = new BigUint64Array(1);
  const success = new Int32Array(1);
  const errorStatus = new Int32Array(1);
  return withCore(controller, (core) => {
    const stopStarting = subscribe(core, ADD_NAVIGATION_STARTING, REMOVE_NAVIGATION_STARTING, startingKind, (args) => {
      if (call(args, STARTING_GET_NAVIGATION_ID, [FFIType.ptr], id) !== S_OK) return;
      const navId = id[0]!;
      latestNavId = navId;
      // A redirect starts again under the same id: keep its latest address.
      navUrls.set(navId, stringProperty(args, STARTING_GET_URI) ?? "");
    }, "add_NavigationStarting");
    let stopCompleted: () => void;
    try {
      stopCompleted = subscribe(core, ADD_NAVIGATION_COMPLETED, REMOVE_NAVIGATION_COMPLETED, completedKind, (args) => {
        if (call(args, COMPLETED_GET_NAVIGATION_ID, [FFIType.ptr], id) !== S_OK) return;
        const navId = id[0]!;
        const started = navUrls.get(navId);
        navUrls.delete(navId);
        // A navigation that started before this handler was added is current until a newer one starts.
        const isCurrent = () => (latestNavId ?? navId) === navId;
        if (!isCurrent()) return;
        if (call(args, GET_IS_SUCCESS, [FFIType.ptr], success) !== S_OK || success[0] !== 0) return;
        if (call(args, GET_WEB_ERROR_STATUS, [FFIType.ptr], errorStatus) !== S_OK) return;
        const status = errorStatus[0]!;
        if (status === WEB_ERROR_STATUS_OPERATION_CANCELED || status === WEB_ERROR_STATUS_CONNECTION_ABORTED) return;
        if ((httpStatusOf(args) ?? 0) > 0) return;
        const url = started || (stringProperty(core, GET_SOURCE) ?? "");
        if (/^(about|data):/i.test(url)) return;
        onFailed({ url, reason: WEB_ERROR_REASONS[status] ?? "The page could not be loaded.", isCurrent });
      }, "add_NavigationCompleted");
    } catch (err) {
      stopStarting();
      throw err;
    }
    return () => {
      stopCompleted();
      stopStarting();
      navUrls.clear();
    };
  });
}

const wide = (text: string) =>new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));

export function devTools(controller: Controller, method: string, params: object): void {
  const out = new BigUint64Array(1);
  let hr = call(controller, GET_CORE_WEBVIEW2, [FFIType.ptr], out);
  if (hr !== S_OK || out[0] === 0n) throw failed("get_CoreWebView2", hr);
  const core = Number(out[0]) as Pointer;
  hr = call(core, CALL_DEV_TOOLS_PROTOCOL_METHOD, [FFIType.ptr, FFIType.ptr, FFIType.ptr], wide(method), wide(JSON.stringify(params)), null);
  call(core, RELEASE, []);
  if (hr !== S_OK) throw failed(`CallDevToolsProtocolMethod(${method})`, hr);
}
