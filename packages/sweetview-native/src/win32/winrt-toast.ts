import { CFunction, FFIType, cc, dlopen, ptr, read, type Pointer } from "bun:ffi";
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationClick, NotificationOptions, NotifierOptions } from "../notifications";
import { ERROR_FILE_NOT_FOUND, HKEY_CURRENT_USER, KEY_WRITE, REG_SZ, WM_APP, advapi32, kernel32, wstr } from "./api";

export const WM_TOAST_EVENT = WM_APP + 3;
export const ToastEvent = { Dismissed: 0n, Activated: 1n, Failed: 2n } as const;

const P = FFIType.ptr;
const HR = FFIType.i32;
let nextCookie = 0n;

const openWinRt = () => dlopen("combase.dll", {
  RoInitialize: { args: [FFIType.u32], returns: HR },
  RoUninitialize: { args: [], returns: FFIType.void },
  RoGetActivationFactory: { args: [P, P, P], returns: HR },
  RoActivateInstance: { args: [P, P], returns: HR },
  WindowsCreateString: { args: [P, FFIType.u32, P], returns: HR },
  WindowsDeleteString: { args: [P], returns: HR },
}).symbols;
type WinRt = ReturnType<typeof openWinRt>;
let winRt: WinRt | undefined;

function check(status: number, method: string): void {
  if (status < 0) throw new Error(`sweetview: ${method} failed (0x${(status >>> 0).toString(16)})`);
}

function outPointer(method: string, call: (out: Pointer) => number): Pointer {
  const out = new BigUint64Array(1);
  check(call(ptr(out)), method);
  if (out[0] === 0n) throw new Error(`sweetview: ${method} returned a null pointer`);
  return Number(out[0]) as Pointer;
}

function withHString<T>(api: WinRt, value: string, use: (string: Pointer) => T): T {
  const chars = wstr(value);
  const string = outPointer("WindowsCreateString", (out) => api.WindowsCreateString(chars, value.length, out));
  try {
    return use(string);
  } finally {
    api.WindowsDeleteString(string);
  }
}

function guid(value: string): Uint8Array {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}

// IIDs and interface-relative vtable slots from the Windows SDK WinRT headers.
const MANAGER = guid("50ac103f-d235-4598-bbef-98fe4d1a3ad4");
const XML_DOCUMENT = guid("f7f3a506-1e87-42d6-bcfb-b8c809fa5494");
const XML_DOCUMENT_IO = guid("6cd0e74e-ee65-4489-9ebf-ca43e87ba637");
const TOAST_FACTORY = guid("04124b20-82c6-4229-b109-fd9ed4662b53");
const events = [
  { add: 9, iid: guid("61c2402f-0ed0-5a18-ab69-59f4aa99a368"), kind: ToastEvent.Dismissed },
  { add: 11, iid: guid("ab54de2d-97d9-5528-b6ad-105afe156530"), kind: ToastEvent.Activated },
  { add: 13, iid: guid("95e3e803-c969-5e3a-9753-ea2ad22a9a33"), kind: ToastEvent.Failed },
] as const;

function methodPointer(object: Pointer, slot: number): Pointer {
  return read.ptr(read.ptr(object, 0) as Pointer, slot * 8) as Pointer;
}

function comCall(object: Pointer, slot: number, args: FFIType[], ...values: (Pointer | Uint8Array | bigint)[]): number {
  const method = CFunction({ ptr: methodPointer(object, slot), args: [P, ...args], returns: HR });
  try {
    return method(object, ...values);
  } finally {
    method.close();
  }
}

function release(object: Pointer): void {
  comCall(object, 2, []);
}

function query(object: Pointer, iid: Uint8Array, name: string): Pointer {
  return outPointer(name, (out) => comCall(object, 0, [P, P], iid, out));
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
function xmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|\p{Surrogate}/gu, "\ufffd")
    .replace(/[&<>"']/g, (character) => entities[character]!);
}

export function toastXml(notification: NotificationOptions, id: string): string {
  const launch = xmlText(id).replace(/[\t\n\r]/g, (character) => `&#${character.charCodeAt(0)};`);
  const audio = notification.silent ? '<audio silent="true"/>' : "";
  return `<toast launch="${launch}"><visual><binding template="ToastGeneric"><text>${xmlText(notification.title)}</text><text>${xmlText(notification.body ?? "")}</text></binding></visual>${audio}</toast>`;
}

function makeToast(api: WinRt, xml: string): Pointer {
  const instance = withHString(api, "Windows.Data.Xml.Dom.XmlDocument", (name) =>
    outPointer("RoActivateInstance(XmlDocument)", (out) => api.RoActivateInstance(name, out)));
  try {
    const io = query(instance, XML_DOCUMENT_IO, "QueryInterface(IXmlDocumentIO)");
    try {
      withHString(api, xml, (content) => check(comCall(io, 6, [P], content), "IXmlDocumentIO.LoadXml"));
    } finally {
      release(io);
    }
    const document = query(instance, XML_DOCUMENT, "QueryInterface(IXmlDocument)");
    try {
      const factory = withHString(api, "Windows.UI.Notifications.ToastNotification", (name) =>
        outPointer("RoGetActivationFactory(ToastNotification)", (out) => api.RoGetActivationFactory(name, TOAST_FACTORY, out)));
      try {
        return outPointer("CreateToastNotification", (out) => comCall(factory, 6, [P, P], document, out));
      } finally {
        release(factory);
      }
    } finally {
      release(document);
    }
  } finally {
    release(instance);
  }
}

function registerAppId(appId: string, displayName: string): void {
  if (!appId || appId.length > 128 || /[\\\s\0]/u.test(appId)) {
    throw new Error("sweetview: invalid Windows toast appId");
  }
  const subKey = `Software\\Classes\\AppUserModelId\\${appId}`;
  const keyOut = new BigUint64Array(1);
  const status = advapi32.RegCreateKeyExW(HKEY_CURRENT_USER, wstr(subKey), 0, null, 0, KEY_WRITE | 0x0001 /* KEY_QUERY_VALUE */, null, keyOut, null);
  if (status !== 0) throw new Error(`sweetview: RegCreateKeyExW(${subKey}) failed (${status})`);
  const key = keyOut[0]!;
  try {
    const existing = advapi32.RegGetValueW(key, null, wstr("DisplayName"), 0xffff /* RRF_RT_ANY */, null, null, new Uint32Array(1));
    // Only supply a display name when creating the app's registration or when
    // its current key lacks one. Preserve names and icons set by an installer.
    if (existing === ERROR_FILE_NOT_FOUND) {
      const name = wstr(displayName);
      const result = advapi32.RegSetValueExW(key, wstr("DisplayName"), 0, REG_SZ, name, name.byteLength);
      if (result !== 0) throw new Error(`sweetview: RegSetValueExW(DisplayName) failed (${result})`);
    } else if (existing !== 0) {
      throw new Error(`sweetview: RegGetValueW(DisplayName) failed (${existing})`);
    }
  } finally {
    advapi32.RegCloseKey(key);
  }
}

// WinRT may invoke or release a delegate on a COM thread. Its IUnknown and
// Invoke must return synchronously there, so the vtable runs entirely in native
// code. Invoke posts only a cookie and event kind to the owning Bun UI thread.
// Bun's embedded C compiler builds this Windows x64 ABI shim without an SDK.
const delegateSource = String.raw`
typedef unsigned long long U64;
typedef unsigned int U32;
typedef struct Delegate Delegate;
typedef struct {
    int (*query)(Delegate *, const unsigned char *, void **);
    U32 (*add_ref)(Delegate *);
    U32 (*release)(Delegate *);
    int (*invoke)(Delegate *, void *, void *);
} VTable;

struct Delegate {
    const VTable *vtable;
    void *lock; /* Zero-initialized SRWLOCK. */
    U32 refs;
    unsigned char iid[16];
    U64 hwnd, cookie, event;
    U32 message;
};

static int (*post)(U64, U32, U64, U64);
static void *(*local_alloc)(U32, U64);
static void *(*local_free)(void *);
static void (*lock)(void *);
static void (*unlock)(void *);

void initialize(void *post_message, void *alloc, void *free, void *acquire, void *release) {
    post = post_message;
    local_alloc = alloc;
    local_free = free;
    lock = acquire;
    unlock = release;
}

static U32 add_ref(Delegate *self) {
    lock(&self->lock);
    U32 refs = ++self->refs;
    unlock(&self->lock);
    return refs;
}

static U32 release(Delegate *self) {
    lock(&self->lock);
    U32 refs = --self->refs;
    unlock(&self->lock);
    if (!refs) local_free(self);
    return refs;
}

static int equal_guid(const unsigned char *left, const unsigned char *right) {
    for (int index = 0; index < 16; index++) {
        if (left[index] != right[index]) return 0;
    }
    return 1;
}

static int query(Delegate *self, const unsigned char *iid, void **out) {
    static const unsigned char unknown[16] = {0,0,0,0,0,0,0,0,0xc0,0,0,0,0,0,0,0x46};
    static const unsigned char agile[16] = {0x94,0x2b,0xea,0x94,0xcc,0xe9,0xe0,0x49,0xc0,0xff,0xee,0x64,0xca,0x8f,0x5b,0x90};
    if (!out) return 0x80004003; /* E_POINTER */
    *out = 0;
    if (!equal_guid(iid, unknown) && !equal_guid(iid, agile) && !equal_guid(iid, self->iid))
        return 0x80004002; /* E_NOINTERFACE */
    add_ref(self);
    *out = self;
    return 0;
}

static int invoke(Delegate *self, void *sender, void *args) {
    post(self->hwnd, self->message, self->cookie, self->event);
    return 0;
}

static const VTable vtable = {query, add_ref, release, invoke};

Delegate *create(const unsigned char *iid, U64 hwnd, U32 message, U64 cookie, U64 event) {
    Delegate *self = local_alloc(0, sizeof(Delegate)); /* LMEM_FIXED */
    if (!self) return 0;
    self->vtable = &vtable;
    self->lock = 0;
    self->refs = 1;
    for (int index = 0; index < 16; index++) self->iid[index] = iid[index];
    self->hwnd = hwnd;
    self->message = message;
    self->cookie = cookie;
    self->event = event;
    return self;
}
`;

function compileDelegates() {
  const loader = dlopen("kernel32.dll", { GetProcAddress: { args: [FFIType.u64, P], returns: P } });
  let imports: [Pointer, Pointer, Pointer, Pointer, Pointer];
  try {
    const user = kernel32.GetModuleHandleW(wstr("user32.dll"));
    const kernel = kernel32.GetModuleHandleW(wstr("kernel32.dll"));
    function address(module: bigint, name: string): Pointer {
      const symbol = loader.symbols.GetProcAddress(module, Buffer.from(name + "\0"));
      if (!symbol) throw new Error(`sweetview: ${name} is unavailable`);
      return Number(symbol) as Pointer;
    }
    imports = [
      address(user, "PostMessageW"),
      address(kernel, "LocalAlloc"),
      address(kernel, "LocalFree"),
      address(kernel, "AcquireSRWLockExclusive"),
      address(kernel, "ReleaseSRWLockExclusive"),
    ];
  } finally {
    loader.close();
  }

  const dir = mkdtempSync(join(tmpdir(), "sweetview-toast-"));
  const source = join(dir, "delegate.c");
  try {
    writeFileSync(source, delegateSource);
    const delegate = cc({
      source,
      symbols: {
        initialize: { args: [P, P, P, P, P], returns: FFIType.void },
        create: { args: [P, FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u64], returns: P },
      },
    });
    delegate.symbols.initialize(...imports);
    return delegate;
  } finally {
    rmSync(source, { force: true });
    rmdirSync(dir);
  }
}

// Keep the vtable code mapped for the process lifetime. A WinRT thread may
// still be inside Invoke when the owner removes the last subscription.
let delegates: ReturnType<typeof compileDelegates> | undefined;

type ToastEventKind = (typeof ToastEvent)[keyof typeof ToastEvent];

type PendingToast = {
  toast: Pointer;
  subscriptions: { remove: number; token: bigint }[];
  click: NotificationClick;
  fallback?: () => void;
};

export class WinRtToastNotifier {
  readonly #pending = new Map<bigint, PendingToast>();
  readonly #api: WinRt;
  readonly #notifier: Pointer;
  readonly #uninitialize: boolean;
  #disposed = false;

  constructor(readonly hwnd: bigint, private readonly options: NotifierOptions) {
    const api = this.#api = winRt ??= openWinRt();
    const status = api.RoInitialize(0 /* RO_INIT_SINGLETHREADED */);
    // An existing MTA is usable with our agile delegates. Its owner balances it.
    if ((status >>> 0) !== 0x80010106 /* RPC_E_CHANGED_MODE */) check(status, "RoInitialize");
    this.#uninitialize = status >= 0;
    try {
      delegates ??= compileDelegates();
      const appId = options.appId ?? options.identity?.appId ?? "Sweetview.DesktopApp";
      registerAppId(appId, options.identity?.appName ?? (options.appId ? appId : "Sweetview"));
      const manager = withHString(api, "Windows.UI.Notifications.ToastNotificationManager", (name) =>
        outPointer("RoGetActivationFactory(ToastNotificationManager)", (out) => api.RoGetActivationFactory(name, MANAGER, out)));
      try {
        this.#notifier = withHString(api, appId, (id) =>
          outPointer("CreateToastNotifierWithId", (out) => comCall(manager, 7, [P, P], id, out)));
      } finally {
        release(manager);
      }
    } catch (error) {
      if (this.#uninitialize) api.RoUninitialize();
      throw error;
    }
  }

  show(notification: NotificationOptions, click: NotificationClick, fallback?: () => void): bigint {
    if (this.#disposed) throw new Error("sweetview: disposed Windows toast notifier");
    const cookie = ++nextCookie;
    const toast = makeToast(this.#api, toastXml(notification, click.id));
    const entry: PendingToast = { toast, subscriptions: [], click, fallback };
    this.#pending.set(cookie, entry);
    try {
      for (const { add, kind } of events) {
        const handler = this.createHandler(cookie, kind);
        try {
          const token = new BigInt64Array(1);
          check(comCall(toast, add, [P, P], handler, ptr(token)), `IToastNotification.add (slot ${add})`);
          entry.subscriptions.push({ remove: add + 1, token: token[0]! });
        } finally {
          release(handler);
        }
      }
      check(comCall(this.#notifier, 6, [P], toast), "IToastNotifier.Show");
      return cookie;
    } catch (error) {
      this.#remove(cookie);
      throw error;
    }
  }

  protected createHandler(cookie: bigint, kind: ToastEventKind): Pointer {
    const event = events.find((entry) => entry.kind === kind)!;
    const handler = delegates!.symbols.create(event.iid, this.hwnd, WM_TOAST_EVENT, cookie, kind);
    if (!handler) throw new Error("sweetview: could not allocate a toast event handler");
    return Number(handler) as Pointer;
  }

  handleEvent(cookie: bigint, kind: bigint): void {
    if (kind !== ToastEvent.Activated && kind !== ToastEvent.Dismissed && kind !== ToastEvent.Failed) return;
    const entry = this.#remove(cookie);
    if (kind === ToastEvent.Activated && entry) this.options.onClick?.(entry.click);
    if (kind === ToastEvent.Failed) entry?.fallback?.();
  }

  #remove(cookie: bigint): PendingToast | undefined {
    const entry = this.#pending.get(cookie);
    if (!entry) return;
    this.#pending.delete(cookie);
    try {
      for (const { remove, token } of entry.subscriptions) {
        comCall(entry.toast, remove, [FFIType.i64], token);
      }
      if (this.#disposed) comCall(this.#notifier, 7, [P], entry.toast); // IToastNotifier.Hide
    } finally {
      release(entry.toast);
    }
    return entry;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      for (const cookie of this.#pending.keys()) this.#remove(cookie);
    } finally {
      try {
        release(this.#notifier);
      } finally {
        if (this.#uninitialize) this.#api.RoUninitialize();
      }
    }
  }
}
