# v1-drafting native feature inventory

Source: branch `v1-drafting`, `packages/sweetview-native/src/**`, `packages/sweetview-settings/src/app-identity.ts`, `docs/native/{activation-and-single-instance,notifications,dialogs-clipboard-files}.md`. Paths below are relative to `packages/sweetview-native/src/` unless they start with `packages/` or `docs/`. Line numbers are from `git show v1-drafting:<path>`.

## URL schemes and single instance

### Public API
- `registerUrlScheme(scheme: string, options?: RegisterUrlSchemeOptions): void` — Windows writes `HKCU\Software\Classes\<scheme>`; macOS only validates the scheme (schemes come from `CFBundleURLTypes` via `makeMacApp({ urlSchemes })`). Docs: call it on every start.
- `unregisterUrlScheme(scheme: string): void` — Windows deletes the key tree; macOS validates only.
- `RegisterUrlSchemeOptions = { identity?: AppIdentity; appName?: string; executablePath?: string; iconPath?: string; command?: string }` (all Windows-only per docs).
- `singleInstance(options: SingleInstanceOptions): Promise<SingleInstanceLock>`.
- `SingleInstanceOptions = { appId?: string; identity?: AppIdentity; urlSchemes?: readonly string[]; args?: readonly string[]; onSecondInstance?: (event: SecondInstanceEvent) => void }`. Docs: `onSecondInstance` is "Called on the primary, on the UI thread".
- `SingleInstanceLock = { readonly isPrimary: boolean; readonly handedOff: boolean; dispose(): void }`. `dispose()` on a secondary is a no-op.
- `SecondInstanceEvent = { readonly args: readonly string[]; readonly cwd: string; readonly url?: string }`.
- `parseSecondInstanceEvent(raw: string): SecondInstanceEvent | undefined` — JSON-parse and shape check.
- `onOpenUrl(handler: (url: string) => void): () => void` — unsubscribe returns `urlListeners.delete(handler)`.
- `signalReady(): void` — first call drains the buffer; later calls do nothing. Also called by the host on the first page handshake of any webview (docs).
- `emitActivationUrl(url: string): void` — enqueue into the pipeline.
- `extractUrlFromArgs(args: readonly string[], schemes?: readonly string[]): string | undefined`.
- `_resetActivationForTest(): void` — resets `activationReady`, buffer and listeners (does not reset `nativeUrlHookInstalled`).

### Behaviour
- Pipeline (`activation.ts`): `dispatchUrl` pushes to `bufferedUrls` while `activationReady` is false; otherwise calls every listener over a snapshot copy; a throwing listener is logged `sweetview: onOpenUrl handler threw:` and the rest still run. `signalReady` sets ready then `shift()`s the buffer in FIFO order through `dispatchUrl`.
- `onOpenUrl` and `singleInstance` each install the native URL hook once (`nativeUrlHookInstalled`) on `win32`/`darwin` only.
- `extractUrlFromArgs`: regex `/^([a-z][a-z0-9+.-]*):\/\//i` per arg; scheme lowercased. With non-empty `schemes`, each is passed through `validateUrlScheme` (throws on invalid) and the first arg whose scheme is in the set is returned. With `schemes` omitted or `[]`, the first arg whose scheme is not `http`, `https` or `file` is returned.
- `singleInstance` order: `appId = (options.appId ?? identity.appId ?? "").trim()`; empty throws `sweetview: singleInstance requires appId or identity`. `schemes = options.urlSchemes ?? identity.urlSchemes`; `args = options.args ?? process.argv.slice(1)`; `url = extractUrlFromArgs(args, schemes)`; install hook; call backend `acquireSingleInstance` with payload `{ args, cwd: process.cwd(), url? }` (url key omitted when none). The wrapped `onSecondInstance` first `dispatchUrl(event.url)` if present, then calls the user handler (throw logged `sweetview: onSecondInstance handler threw:`). After acquisition, if primary and `url`, `dispatchUrl(url)`.
- `parseSecondInstanceEvent` accepts only an object with `args` = array of strings, `cwd` = string, and `url` absent or string; otherwise `undefined` (also on JSON error).
- Windows `registerUrlScheme`: `normalized = validateUrlScheme(scheme)`; `exePath = executablePath ?? process.execPath`; `appName = appName ?? identity.appName ?? normalized`; `icon = iconPath ?? "<exePath>,0"`; `command = command ?? "\"<exePath>\" \"%1\""`. Writes (each via `RegCreateKeyExW` + `RegSetValueExW` REG_SZ + `RegCloseKey`): `Software\Classes\<scheme>` default = `URL:<appName> Protocol`; same key value `URL Protocol` = `""`; `...\DefaultIcon` default = icon; `...\shell\open\command` default = command.
- Windows errors: `sweetview: RegCreateKeyExW(<subKey>) failed (<status>)`; `sweetview: RegSetValueExW(<subKey>, <valueName or "(Default)">) failed (<status>)`; `sweetview: RegDeleteTreeW(<root>) failed (<status>)` (status `ERROR_FILE_NOT_FOUND`=2 is ignored on delete).
- Windows `installUrlEventHandler` is a no-op: URLs arrive as argv or through `singleInstance` WM_COPYDATA.
- Windows `acquireSingleInstance`, in order: `ensureWin32Init()`; `id = appId.replace(/[^a-zA-Z0-9._-]/g, "_")`; `CreateMutexW(null, FALSE, "Local\sweetview.instance.<id>")` (0 → `sweetview: CreateMutexW(<name>) failed (<lastError>)`).
  - If `GetLastError() == ERROR_ALREADY_EXISTS` (183): secondary. Up to 10 attempts of `FindWindowExW(HWND_MESSAGE, 0, "SweetviewSingleInstanceWindow", "sweetview.instance.<id>")`, `Bun.sleep(25)` before each attempt after the first. On a hit: `sendCopyData` once, then stop. Mutex handle closed in `finally`. Returns `{ isPrimary:false, handedOff, dispose(){} }`.
  - `sendCopyData`: `GetWindowThreadProcessId(target)` → if pid > 0 `AllowSetForegroundWindow(pid)`; payload = UTF-8 `JSON.stringify(payload)`; COPYDATASTRUCT 24 bytes: `dwData` = magic `0x53575631` ("SWV1") at 0, `cbData` u32 at 8, `lpData` at 16; `SendMessageTimeoutW(target, WM_COPYDATA, 0, &cds, SMTO_ABORTIFHUNG, 5000, &result)`; `handedOff = (ret != 0 && result == 1)`.
  - Otherwise primary: `ensureIpcClass()` (on throw, close mutex and rethrow); `CreateWindowExW(0, class, title, 0, 0,0,0,0, HWND_MESSAGE, 0, hInstance, null)`; 0 → close mutex, throw `sweetview: CreateWindowExW(SweetviewSingleInstanceWindow) failed (<err>)`. Registers handler in `handlersByHwnd`.
- Window class registration errors: `sweetview: could not allocate singleInstance window procedure`; `sweetview: RegisterClassExW(SweetviewSingleInstanceWindow) failed (<err>)` (callback closed on that path).
- No explicit payload size limit in the code on either platform.
- macOS `registerUrlScheme`/`unregisterUrlScheme`: `validateUrlScheme(scheme)` only.
- macOS `installUrlEventHandler`: stores `onUrl` in `urlDispatch` every call; first call only: `sharedApp()`, creates target `SweetviewUrlEventHandler` with `handleGetURLEvent:withReplyEvent:`, then `[[NSAppleEventManager sharedAppleEventManager] setEventHandler:target andSelector:@selector(handleGetURLEvent:withReplyEvent:) forEventClass:'GURL' andEventID:'GURL']` (skipped if manager is nil). Handler: `[event paramDescriptorForKeyword:'----']` → `stringValue` → JS string; non-empty → `urlDispatch(url)`; any nil step returns silently.
- macOS `acquireSingleInstance`, in order: `id = sha256(appId).hex` (64 chars). If this process already has a local handler for `id`, call it with the payload and return `{ isPrimary:false, handedOff:true }`. Port name CFString `"sweetview." + id` (UTF-8; null → `sweetview: could not allocate activation port name`). Create JSCallback; `CFMessagePortCreateLocal(NULL, name, callback, NULL, &shouldFreeInfo)`.
  - If port is NULL or `shouldFreeInfo` is true: close callback, release port if any; up to 10 attempts (`Bun.sleep(25)` between) of `CFMessagePortCreateRemote(NULL, name)`; on first non-NULL remote: `sendActivation` and return its result as `handedOff`; remote released. No remote after 10 attempts → `handedOff:false`.
  - `sendActivation`: `CFDataCreate` of UTF-8 JSON (NULL → `sweetview: could not allocate activation payload`); `CFMessagePortSendRequest(remote, msgid 1, data, sendTimeout 1.5, rcvTimeout 0, replyMode NULL, returnData NULL)`; success iff result `== 0`; data released.
  - Primary: `CFMessagePortCreateRunLoopSource(NULL, port, 0)`; NULL → invalidate+release port, close callback, throw `sweetview: could not create activation run-loop source`. `CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes)`; register handler in `localHandlers`.
- macOS handler: only `msgid == 1` with non-NULL data and length > 0 is parsed; invalid JSON is ignored; exceptions logged `sweetview: singleInstance CFMessagePort handler threw:`; always returns NULL (no reply).
- `commonRunLoopModes()` (darwin/core-foundation.ts) throws `sweetview: CoreFoundation common run-loop modes unavailable` if the symbol cannot be resolved.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `RegCreateKeyExW`, `RegSetValueExW`, `RegCloseKey` | advapi32.dll | write protocol keys under HKCU (KEY_WRITE 0x20006, REG_SZ 1) | win32/activation.ts:31-47 |
| `RegDeleteTreeW` | advapi32.dll | delete `Software\Classes\<scheme>` | win32/activation.ts:66 |
| `CreateMutexW`, `CloseHandle`, `GetLastError` | kernel32.dll | named mutex lock | win32/activation.ts:161-180 |
| `GetModuleHandleW(NULL)` (`hInstance`) | kernel32.dll | class/window hInstance | win32/api.ts:215 |
| `RegisterClassExW` | user32.dll | class `SweetviewSingleInstanceWindow`, WNDCLASSEXW 80 bytes: cbSize@0, lpfnWndProc@8, hInstance@24, lpszClassName@64 | win32/activation.ts:107-118 |
| `CreateWindowExW`, `DestroyWindow`, `IsWindow`, `DefWindowProcW` | user32.dll | message-only (`HWND_MESSAGE` = -3) IPC window | win32/activation.ts:195-224, 101 |
| `FindWindowExW` | user32.dll | secondary finds primary's message window | win32/activation.ts:173 |
| `GetWindowThreadProcessId`, `AllowSetForegroundWindow` | user32.dll | let primary take foreground | win32/activation.ts:128-130 |
| `SendMessageTimeoutW` + `WM_COPYDATA` (0x4A), `SMTO_ABORTIFHUNG` (2) | user32.dll | payload handoff, 5000 ms | win32/activation.ts:139-148 |
| `NSApplication sharedApplication` | AppKit | ensure app object | darwin/activation.ts:35 |
| `NSAppleEventManager sharedAppleEventManager`, `setEventHandler:andSelector:forEventClass:andEventID:` | Foundation | kAEGetURL handler ('GURL'=0x4755524c both class and ID) | darwin/activation.ts:50-59 |
| `paramDescriptorForKeyword:` (keyDirectObject '----'=0x2d2d2d2d), `stringValue` | NSAppleEventDescriptor | read URL | darwin/activation.ts:41-45 |
| `objc_allocateClassPair`, `class_addMethod`, `objc_registerClassPair` | libobjc (via `makeTarget`) | handler class `SweetviewUrlEventHandler_<n>` | darwin/objc.ts:102-124 |
| `CFMessagePortCreateLocal/CreateRemote/CreateRunLoopSource/SendRequest/Invalidate` | CoreFoundation | single-instance port | darwin/activation.ts:76-90 |
| `CFRunLoopGetMain`, `CFRunLoopAddSource`, `CFRunLoopSourceInvalidate` | CoreFoundation | serve port on main run loop | darwin/activation.ts:173, 184 |
| `CFDataCreate/GetBytePtr/GetLength`, `CFStringCreateWithCString` (kCFStringEncodingUTF8 0x08000100), `CFRelease` | CoreFoundation | payload and name | darwin/activation.ts:85-104, 121 |
| `dlopen`(RTLD_LAZY=1)/`dlsym("kCFRunLoopCommonModes")`/`dlclose` | /usr/lib/libSystem.B.dylib | read the common-modes sentinel pointer | darwin/core-foundation.ts:10-27 |

### Callbacks from the OS into JavaScript
- Win32 IPC window procedure (`JSCallback`, args `u64 hwnd, u32 msg, u64 wParam, i64 lParam`, returns `i64`), win32/activation.ts:79-104. Called by Windows for the message-only window; thread not stated in comments (docs: handler runs on the UI thread). WM_COPYDATA: reads COPYDATASTRUCT from lParam (x64 layout comment line 83), requires magic `SWV1`, cbData>0, lpData≠0; decodes UTF-8; returns 1 on a delivered valid payload, 0 otherwise; exceptions logged `sweetview: singleInstance WM_COPYDATA handler threw:`. WM_CLOSE returns 0. Others → `DefWindowProcW`. Lifetime: created once per process in `ipcWndProc`, never closed after successful class registration.
- macOS `handleGetURLEvent:withReplyEvent:` (via `makeTarget`, JSCallback args `(self, _cmd, id, id)`, void), darwin/activation.ts:37-48. Called by NSAppleEventManager; thread unclear from the code. Exceptions caught by `makeTarget` and logged `sweetview: <className> <selector> threw:`. Lifetime: retained in `retained[]` for the process.
- macOS CFMessagePort callout (`JSCallback`, args `ptr port, i32 msgid, ptr data, ptr info`, returns `ptr` NULL), darwin/activation.ts:126-146. Called by the main run loop (source added to `CFRunLoopGetMain()`). Lifetime: one per acquisition; closed on failure paths immediately; on `dispose()` closed only when `callbackDepth === 0`, else retried via `scheduleNativeTimeout(1, closeCallback)`.

### State and lifetimes
- Module state (activation.ts): `urlListeners` Set, `bufferedUrls` array, `activationReady`, `nativeUrlHookInstalled` (process lifetime).
- Registry (Windows): `HKCU\Software\Classes\<scheme>` with default value, `URL Protocol`, `DefaultIcon`, `shell\open\command`.
- Mutex: `Local\sweetview.instance.<safeId>`; primary keeps the handle until `dispose()`; secondary closes it before returning.
- Window: class `SweetviewSingleInstanceWindow`, title `sweetview.instance.<safeId>`, parent `HWND_MESSAGE`; `handlersByHwnd` maps HWND → handler. `dispose()` (idempotent): delete map entry, `DestroyWindow` if `IsWindow`, `CloseHandle(mutex)`.
- macOS port name: `sweetview.<sha256-hex(appId)>`. `localHandlers` maps hash → handler. `dispose()` (idempotent): delete map entry, `CFMessagePortInvalidate(port)`, `CFRunLoopSourceInvalidate(source)`, `CFRelease(source)`, `CFRelease(port)`, deferred callback close. Name CFString released in `finally`.
- `commonModes` pointer cached for the process (core-foundation.ts:5).
- macOS URL handler target `urlTarget` created once; `urlDispatch` replaced on each install call.

### Workarounds and constraints stated in comments
- activation.ts:129-133: "Launch Services has no per-user runtime registry an unbundled process can write to: it reads `CFBundleURLTypes` from the signed `.app` bundle's `Info.plist` when the bundle is registered (first launch, or when it is copied into place)."
- activation.ts:59-67 (`handedOff` doc): "It reports transport delivery, not that the primary's `onSecondInstance` handler ran or succeeded. On macOS it is also true when this process already holds the lock for the same app ID".
- win32/activation.ts:83: "COPYDATASTRUCT on x64: ULONG_PTR dwData (8), DWORD cbData (4), pad (4), PVOID lpData (8)".
- win32/activation.ts:231: "Windows delivers custom URL launches as argv[1] to the process (or via singleInstance WM_COPYDATA)."
- darwin/activation.ts:100-101: "No reply mode: return as soon as Mach accepts the message, even if the primary is still starting and hasn't begun pumping its run loop."
- darwin/activation.ts:113: "A fixed-length name fits the Mach bootstrap namespace regardless of app ID length."
- darwin/activation.ts:147-148: "shouldFreeInfo also tells us if CF returned a cached local object whose installed callback belongs to a different acquisition."
- darwin/activation.ts:187-188: "A handler is allowed to release the lock. Keep the native trampoline alive until the outermost CFMessagePort callback has returned."
- darwin/activation.ts:74: "CFIndex on arm64".
- darwin/core-foundation.ts:7: "CoreFoundation recognizes the common-modes sentinel by address."
- docs/native/activation-and-single-instance.md:119-122: under `bun run`, `process.execPath` is `bun.exe`, so pass `command: "\"<execPath>\" \"<Bun.main>\" \"%1\""`.

## Clipboard

### Public API
- `Clipboard.readText(): string | null`, `Clipboard.writeText(text: string): void`, `Clipboard.clear(): void` — "Synchronous text access to the system clipboard on the UI thread." Docs: `writeText` replaces the whole clipboard (other formats cleared); `readText` returns `null` when no text representation.

### Behaviour
- Windows `withClipboard(hwnd, fn)`: up to 5 `OpenClipboard(hwnd)` attempts, `Sleep(5)` between (4 sleeps); `CloseClipboard()` in `finally`; all failing → `sweetview: OpenClipboard failed (<lastError>)`.
- Windows `readText`: open with hwnd 0; `GetClipboardData(CF_UNICODETEXT=13)`; 0 → `null`; `GlobalLock` (null → `sweetview: GlobalLock failed (<err>)`); `GlobalSize` bounds the view (rounded down to even); scan for first U+0000; none → `sweetview: CF_UNICODETEXT has no NUL terminator`; decode UTF-16LE up to it; `GlobalUnlock` in `finally`.
- Windows `writeText`: `ensureWin32Init()`; create a temporary hidden window via `createMessageWindowRaw(() => {})` as owner; open clipboard with it; `GlobalAlloc(GMEM_MOVEABLE=2, byteLength of UTF-16LE text + NUL)` (0 → `sweetview: GlobalAlloc failed (<err>)`); `GlobalLock`, copy, `GlobalUnlock`; `EmptyClipboard` (0 → `sweetview: EmptyClipboard failed (<err>)`); `SetClipboardData(CF_UNICODETEXT, mem)` (0 → `sweetview: SetClipboardData failed (<err>)`); on any failure before transfer `GlobalFree(mem)`; owner window destroyed in `finally`.
- Windows `clear`: open with hwnd 0, `EmptyClipboard`.
- macOS: `[NSPasteboard generalPasteboard]`, type `public.utf8-plain-text`. `readText`: `stringForType:` → nil → `null`. `writeText`: `clearContents`, then `setString:forType:`; NO → `sweetview: NSPasteboard could not write text`. `clear`: `clearContents`. macOS clipboard code does not call `sharedApp()`.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `OpenClipboard`, `CloseClipboard`, `GetClipboardData`, `EmptyClipboard`, `SetClipboardData` | user32.dll | clipboard access | win32/clipboard.ts:8-72 |
| `GlobalAlloc`, `GlobalLock`, `GlobalUnlock`, `GlobalSize`, `GlobalFree`, `Sleep` | kernel32.dll | HGLOBAL text buffer, retry delay | win32/clipboard.ts:15-63 |
| `createMessageWindowRaw` (class `SweetviewMessageWindow`) | win32/message-window.ts | owner HWND for new data | win32/clipboard.ts:42 |
| `NSPasteboard generalPasteboard`, `stringForType:`, `clearContents`, `setString:forType:` | AppKit | pasteboard access | darwin/clipboard.ts:3-20 |

### Callbacks from the OS into JavaScript
- None directly. The temporary owner window's procedure is the shared message-window JSCallback with a no-op handler (win32/clipboard.ts:42).

### State and lifetimes
- No persistent state. The Windows owner window exists only for the duration of `writeText`; the clipboard takes ownership of the HGLOBAL after a successful `SetClipboardData`.

### Workarounds and constraints stated in comments
- win32/clipboard.ts:27: "GlobalSize bounds the scan. Padding after the terminator is not text."
- win32/clipboard.ts:40: "EmptyClipboard assigns the open HWND as owner. NULL cannot own new data."
- docs/native/dialogs-clipboard-files.md:120-123: "Only one process can have the clipboard open at a time, and clipboard managers and remote-desktop clients often hold it briefly, so `OpenClipboard` is retried up to 5 times, 5 ms apart".

## Screen information

### Public API
- `ScreenInfo = { readonly bounds: Rect; readonly workArea: Rect; readonly scale: number; readonly primary: boolean }`.
- `Screen.primary(): ScreenInfo`, `Screen.all(): ScreenInfo[]`, `Screen.at(point: Point): ScreenInfo`, `Screen.of(window: WindowRef): ScreenInfo` (backend receives `unwrapHandle(window)` and the original ref), `Screen.bounds(): Rect` (combined rect of all monitors), `Screen.cursor(): Point`.
- Coordinates (screen.ts:2-3): top-left origin of the primary monitor; physical pixels on Windows (per-monitor DPI aware), points on macOS.

### Behaviour
- Windows: every entry point except `primary` calls `ensureWin32Init()` first (`primary` calls `all`).
- Windows `all`: `EnumDisplayMonitors(0, NULL, enumProc, 0)` collects HMONITORs; none → `[fallbackPrimary()]`; else map `monitorInfo`.
- Windows `monitorInfo(hmon)`: hmon 0 or `GetMonitorInfoW` fails → `fallbackPrimary()`. MONITORINFO (40 bytes, cbSize set): rcMonitor → bounds, rcWork → workArea, `dwFlags & MONITORINFOF_PRIMARY(1)` → primary, scale = `GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI=0)` dpiX/96 when HRESULT 0 and dpiX > 0, else 1.
- Windows `fallbackPrimary`: bounds `{0,0,GetSystemMetrics(SM_CXSCREEN=0),GetSystemMetrics(SM_CYSCREEN=1)}`, workArea from `SystemParametersInfoW(SPI_GETWORKAREA=0x30)`, scale 1, primary true.
- Windows `primary`: first entry with `primary` true, else the first entry.
- Windows `at`: 1x1 RECT at rounded point, `MonitorFromRect(rect, MONITOR_DEFAULTTONEAREST=2)`.
- Windows `of`: `MonitorFromWindow(asHwnd(handle), MONITOR_DEFAULTTONEAREST)`.
- Windows `bounds`: `GetSystemMetrics` SM_XVIRTUALSCREEN(76)/SM_YVIRTUALSCREEN(77)/SM_CXVIRTUALSCREEN(78)/SM_CYVIRTUALSCREEN(79).
- Windows `cursor`: `GetCursorPos`. Throws `sweetview: could not allocate monitor enumeration callback` if the JSCallback has no pointer.
- macOS: functions call `sharedApp()` first (directly or via `all`/`primaryScreen`/`cursorPoint`).
- macOS `rectOf(obj, key)`: `[obj valueForKey:key]` → NSValue; nil → `sweetview: <key> unavailable`; `getValue:size:` with 32 bytes into four doubles.
- macOS `primaryScreen()`: `[NSScreen screens]` index 0, or `[NSScreen mainScreen]` if count ≤ 0. `primaryHeight()` = primary screen `frame.h`. Flip: `y = primaryHeight - (y + h)` both directions.
- macOS `all`: iterate `[NSScreen screens]`; `primary` = index 0; empty → `mainScreen` as primary if non-nil. `screenInfo`: bounds from `frame`, workArea from `visibleFrame`, scale = `backingScaleFactor` (`|| 1`).
- macOS `primary`: first of `all()`, else hard-coded `{ bounds 0,0,1440,900; workArea 0,25,1440,875; scale 1; primary true }`.
- macOS `at`: screen with minimum squared distance from point to its bounds (0 inside); none → `primary()`.
- macOS `of`: null/0 handle with a sweetview `Window` (has `handle`) → `getWindowBackend(window)` (undefined → `sweetview: window handle is nil`); active tab NSWindow via `getDarwinTabActiveHandle`; none → `bestFor(backend.bounds())` (largest overlap area, else `at(center)`). Otherwise `asNSWindow(handle)`. `[win screen]` nil → `primary()`; `primary` flag = pointer equality with `primaryScreen()`.
- macOS `bounds`: union of all `bounds`; empty list → `{0,0,0,0}`.
- macOS `cursor`: `cursorPoint() ?? {0,0}`. `cursorPoint` builds (once) an NSInvocation for `+[NSEvent mouseLocation]` (`methodSignatureForSelector:`, `invocationWithMethodSignature:`, `setSelector:`, `setTarget:`, `retain`), then `invoke` + `getReturnValue:` into two doubles; y flipped with `primaryHeight()`. If the invocation cannot be built, logs once `sweetview: cannot build the NSInvocation for +[NSEvent mouseLocation]; cursor queries unavailable` and returns `null`. Why NSInvocation is used is unclear from the code.
- Exported helpers also used elsewhere: `rectOf`, `primaryScreen`, `primaryHeight`, `fromCocoa`, `toCocoa`, `cursorPoint`, type `CocoaRect`.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `EnumDisplayMonitors` | user32.dll | list monitors | win32/screen.ts:89 |
| `GetMonitorInfoW` | user32.dll | rcMonitor/rcWork/dwFlags | win32/screen.ts:62 |
| `MonitorFromRect`, `MonitorFromWindow` | user32.dll | monitor lookup | win32/screen.ts:107, 113 |
| `GetSystemMetrics`, `SystemParametersInfoW`, `GetCursorPos` | user32.dll | fallback, virtual bounds, cursor | win32/screen.ts:51-129 |
| `GetDpiForMonitor` | shcore.dll | effective DPI | win32/screen.ts:42 |
| `NSScreen screens/mainScreen`, `frame`, `visibleFrame`, `backingScaleFactor`, `NSWindow screen` | AppKit | screen data | darwin/screen.ts:40-164 |
| `valueForKey:`, `NSValue getValue:size:` | Foundation | read struct properties | darwin/screen.ts:30-36 |
| `NSEvent mouseLocation` via `NSInvocation` | AppKit/Foundation | cursor | darwin/screen.ts:56-77 |

### Callbacks from the OS into JavaScript
- `enumProc` (`JSCallback`, args `u64 hmon, u64 hdc, ptr rect, i64 lparam`, returns `i32` 1 = continue), win32/screen.ts:74-84. Called by `EnumDisplayMonitors`; code relies on it running during that call (pushes into module `collected`). Created once, kept for the process.

### State and lifetimes
- Windows: module-level reusable buffers `infoBuf`, `dpiX`, `dpiY`, `rectBuf`, `pointBuf`, and `collected`.
- macOS: `rectBuf`, `pointBuf`, retained `cursorInvocation` (process lifetime), `warnedNoCursor`.

### Workarounds and constraints stated in comments
- win32/screen.ts:2-3: "Runs ensureWin32Init() on first call so coordinates match before and after new Window()."
- darwin/screen.ts:2-3: "Calls sharedApp() on first use so coordinates before new Window() match coordinates after."
- darwin/screen.ts:29: "`[obj valueForKey:key]` boxes a struct-returning property into an NSValue; `getValue:size:` copies it out."
- darwin/screen.ts:144-148: "A virtual tabbed `Window` (`tabs: true`) has a null handle: it resolves to its active tab's NSWindow, or, before any tab window exists, to the display best matching `window.bounds()`."

## Native file reading

### Public API
- `readTextFile(path: string, options?: { maxBytes?: number; encoding?: BufferEncoding }): Promise<string>` — default 4 MiB, `utf8`.
- `readFileBytes(path: string, options?: { maxBytes?: number }): Promise<Uint8Array>` — default 32 MiB.
- `openFileHandle(path: string): { handleId: number; size: number }` (sync).
- `readFileChunk(handleId: number, offset: number, length: number): { data: Uint8Array; bytesRead: number; eof: boolean }` (sync, positional).
- `closeFileHandle(handleId: number): void`; `closeAllFileHandles(): void`.
- Docs: Node `fs` only; any OS, any thread including workers; handle tables are per thread.

### Behaviour
- Open flags: `O_RDONLY`, plus `O_NONBLOCK` on non-Windows.
- `readBounded`: validate `maxBytes` (safe integer ≥ 0) else `RangeError sweetview: maxBytes must be a non-negative safe integer`; open; `stat`; not a regular file → `Error sweetview: expected a regular file at <path>`; `size > maxBytes` → `RangeError sweetview: <path> exceeds maxBytes (<maxBytes>)`; then loop reading at position `total` into a buffer of `min(maxBytes - total + 1, 64 KiB)` bytes until 0 bytes read; exceeding `maxBytes` during the read throws the same RangeError; file closed in `finally`.
- `openFileHandle`: `openSync`, `fstatSync`; non-regular → same "expected a regular file" error and fd closed; IDs from `++nextHandleId` (first is 1).
- `readFileChunk`: unknown ID → `Error sweetview: invalid file handle <id>`; offset must be safe integer ≥ 0 else `RangeError sweetview: offset must be a non-negative safe integer`; length must be safe integer 1..16 MiB else `RangeError sweetview: length must be a positive integer of at most 16 MiB`; `readSync(fd, buf, 0, length, offset)`; `eof = bytesRead === 0 || bytesRead >= fstat(fd).size - offset`; returns `data` as a subarray of length `bytesRead`.
- `closeFileHandle`: unknown ID ignored; removes from map then `closeSync`.
- `closeAllFileHandles`: closes each; collected failures → `AggregateError(errors, "sweetview: could not close all file handles")`.
- Missing file / permission: the Node `fs` error is propagated (docs).

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `open`/`file.stat`/`file.read`/`file.close` | node:fs/promises | bounded whole-file read | fs.ts:15-34 |
| `openSync`, `fstatSync`, `readSync`, `closeSync`, `constants.O_RDONLY/O_NONBLOCK` | node:fs | handle API | fs.ts:1-82 |

### Callbacks from the OS into JavaScript
- None.

### State and lifetimes
- Module `handles: Map<number, number>` (handle ID → fd) and `nextHandleId`; never closed automatically (docs: "nothing closes them for you").

### Workarounds and constraints stated in comments
- fs.ts:6: "Opening a POSIX FIFO must not block before we can reject it with fstat."
- fs.ts:22: "Enforce the limit while reading too, in case the same file grows after stat."
- docs/native/dialogs-clipboard-files.md:203-205: "Handle IDs are small opaque numbers, not file descriptors, so they can cross IPC to a page safely."

## WinRT toast notifications

### Public API (internal module win32/winrt-toast.ts)
- `WM_TOAST_EVENT = WM_APP + 3` (0x8003); `ToastEvent = { Dismissed: 0n, Activated: 1n, Failed: 2n }`.
- `toastXml(notification: NotificationOptions, id: string): string`.
- `class WinRtToastNotifier { constructor(hwnd: bigint, options: NotifierOptions); show(notification, click: NotificationClick, fallback?: () => void): bigint; protected createHandler(cookie, kind): Pointer; handleEvent(cookie: bigint, kind: bigint): void; dispose(): void }`.

### Behaviour
- Constructor: `RoInitialize(0 /* RO_INIT_SINGLETHREADED */)`; any failure other than `RPC_E_CHANGED_MODE` (0x80010106) throws `sweetview: RoInitialize failed (0x<hr>)`; `#uninitialize = status >= 0`. Then `compileDelegates()` once per process; `appId = options.appId ?? identity.appId ?? "Sweetview.DesktopApp"`; `registerAppId(appId, identity.appName ?? (options.appId ? appId : "Sweetview"))`; activation factory `Windows.UI.Notifications.ToastNotificationManager` (IID MANAGER) → `CreateToastNotifierWithId(appId)`; factory released. On any error, `RoUninitialize()` if it initialised, then rethrow.
- `registerAppId`: invalid if empty, length > 128, or contains `\`, whitespace or NUL → `sweetview: invalid Windows toast appId`. `RegCreateKeyExW(HKCU, "Software\Classes\AppUserModelId\<appId>", KEY_WRITE|KEY_QUERY_VALUE)` (fail → `sweetview: RegCreateKeyExW(<subKey>) failed (<status>)`); `RegGetValueW(key, NULL, "DisplayName", RRF_RT_ANY 0xffff)`; `ERROR_FILE_NOT_FOUND` → write `DisplayName` REG_SZ (fail → `sweetview: RegSetValueExW(DisplayName) failed (<r>)`); other non-zero → `sweetview: RegGetValueW(DisplayName) failed (<r>)`.
- `toastXml`: `<toast launch="<id>"><visual><binding template="ToastGeneric"><text>title</text><text>body or ""</text></binding></visual>[<audio silent="true"/>]</toast>`. `xmlText` replaces U+0000-0008, 000B, 000C, 000E-001F, FFFE, FFFF and lone surrogates with U+FFFD, then escapes `& < > " '`. In `launch`, tab/LF/CR become `&#9;`/`&#10;`/`&#13;`.
- `makeToast`: `RoActivateInstance("Windows.Data.Xml.Dom.XmlDocument")` → QI IXmlDocumentIO → `LoadXml(HSTRING xml)` → release; QI IXmlDocument; `RoGetActivationFactory("Windows.UI.Notifications.ToastNotification", TOAST_FACTORY)` → `CreateToastNotification(document)`; releases factory, document, instance.
- `show`: disposed → `sweetview: disposed Windows toast notifier`; `cookie = ++nextCookie` (module-global, starts at 1); create toast; record pending entry; for each event (Dismissed, Activated, Failed): create native delegate, `add_<Event>(handler, &token)` (failure → `sweetview: IToastNotification.add (slot <n>) failed (0x..)`), store `{ remove: add+1, token }`, release local handler ref; `IToastNotifier.Show(toast)`; return cookie. Any error → `#remove(cookie)` and rethrow.
- `handleEvent(cookie, kind)`: unknown kind ignored; `#remove(cookie)`; Activated + entry → `options.onClick(entry.click)`; Failed → `entry.fallback()`; Dismissed → only removal.
- `#remove`: removes all subscriptions via `remove_<Event>(token)`; if notifier is disposed, `IToastNotifier.Hide(toast)`; releases toast.
- `dispose` (idempotent): sets disposed, removes all pending (so each is hidden), releases notifier, `RoUninitialize()` if it initialised.
- HRESULT errors: `sweetview: <method> failed (0x<hex>)`; null out pointer → `sweetview: <method> returned a null pointer`.
- `compileDelegates` errors: `sweetview: <name> is unavailable` (GetProcAddress); `createHandler` null → `sweetview: could not allocate a toast event handler`.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `RoInitialize`, `RoUninitialize`, `RoGetActivationFactory`, `RoActivateInstance`, `WindowsCreateString`, `WindowsDeleteString` | combase.dll | WinRT activation, HSTRINGs | winrt-toast.ts:15-22 |
| IUnknown `QueryInterface` slot 0, `Release` slot 2 | COM | QI/release | winrt-toast.ts:79-85 |
| `IToastNotificationManagerStatics` IID `50ac103f-d235-4598-bbef-98fe4d1a3ad4`, slot 7 `CreateToastNotifierWithId` | Windows.UI.Notifications | create notifier | winrt-toast.ts:56, 321 |
| `IXmlDocument` IID `f7f3a506-1e87-42d6-bcfb-b8c809fa5494` | Windows.Data.Xml.Dom | pass to factory | winrt-toast.ts:57, 110 |
| `IXmlDocumentIO` IID `6cd0e74e-ee65-4489-9ebf-ca43e87ba637`, slot 6 `LoadXml` | Windows.Data.Xml.Dom | load toast XML | winrt-toast.ts:58, 106 |
| `IToastNotificationFactory` IID `04124b20-82c6-4229-b109-fd9ed4662b53`, slot 6 `CreateToastNotification` | Windows.UI.Notifications | make toast | winrt-toast.ts:59, 115 |
| `IToastNotification` slots 9/10 Dismissed add/remove (handler IID `61c2402f-0ed0-5a18-ab69-59f4aa99a368`), 11/12 Activated (`ab54de2d-97d9-5528-b6ad-105afe156530`), 13/14 Failed (`95e3e803-c969-5e3a-9753-ea2ad22a9a33`) | Windows.UI.Notifications | event subscriptions | winrt-toast.ts:60-64, 342, 376 |
| `IToastNotifier` slot 6 `Show`, slot 7 `Hide` | Windows.UI.Notifications | show/hide | winrt-toast.ts:348, 378 |
| `RegCreateKeyExW`, `RegGetValueW`, `RegSetValueExW`, `RegCloseKey` | advapi32.dll | AUMID registration | winrt-toast.ts:127-150 |
| `GetModuleHandleW`, `GetProcAddress` | kernel32.dll | resolve imports for the C shim | winrt-toast.ts:247-263 |
| `PostMessageW` (user32), `LocalAlloc`/`LocalFree`/`AcquireSRWLockExclusive`/`ReleaseSRWLockExclusive` (kernel32) | called from C shim | post event, allocate delegate, lock refcount | winrt-toast.ts:176-243 |
| `cc` (Bun embedded C compiler), `CFunction` | bun:ffi | compile delegate shim; per-call vtable function | winrt-toast.ts:70-77, 272 |
- GUID byte order: `guid()` reverses bytes 0-3, 4-5, 6-7 (little-endian Data1/2/3). The shim's `query` accepts IUnknown `00000000-0000-0000-C000-000000000046`, an IID named `agile` in the code (bytes `94 2b ea 94 cc e9 e0 49 c0 ff ee 64 ca 8f 5b 90`), and the delegate's own IID.

### Callbacks from the OS into JavaScript
- No JSCallback. The delegates are native C objects (`Delegate { vtable; SRWLOCK lock; U32 refs; iid[16]; U64 hwnd, cookie, event; U32 message }`, `LocalAlloc(LMEM_FIXED)`, initial refcount 1). `Invoke` calls `PostMessageW(hwnd, WM_TOAST_EVENT, cookie, event)` and returns 0. `Release` frees at refcount 0. JS receives the event on the owner window's procedure (`win32/notifier.ts` routes `WM_TOAST_EVENT` to `handleEvent(wParam, lParam)`).

### State and lifetimes
- `winRt` symbols opened once; `delegates` compiled once and kept for the process. Temp source dir `mkdtemp(<tmpdir>/sweetview-toast-XXXXXX)/delegate.c`, deleted after compile.
- `#pending: Map<cookie, { toast, subscriptions, click, fallback }>`; entry removed on any event, on `show` failure, or on dispose.
- Registry: `HKCU\Software\Classes\AppUserModelId\<appId>` value `DisplayName` (only written when absent).

### Workarounds and constraints stated in comments
- winrt-toast.ts:55: "IIDs and interface-relative vtable slots from the Windows SDK WinRT headers."
- winrt-toast.ts:138-139: "Only supply a display name when creating the app's registration or when its current key lacks one. Preserve names and icons set by an installer."
- winrt-toast.ts:152-155: "WinRT may invoke or release a delegate on a COM thread. Its IUnknown and Invoke must return synchronously there, so the vtable runs entirely in native code. Invoke posts only a cookie and event kind to the owning Bun UI thread. Bun's embedded C compiler builds this Windows x64 ABI shim without an SDK."
- winrt-toast.ts:287-288: "Keep the vtable code mapped for the process lifetime. A WinRT thread may still be inside Invoke when the owner removes the last subscription."
- winrt-toast.ts:310: "An existing MTA is usable with our agile delegates. Its owner balances it."

## Notifier (v1-drafting version)

### Public API
- `class Notifier { constructor(options?: NotifierOptions); notify(n: NotificationOptions): boolean; dispose(): void }` ("Safe to call twice"); `createNotifier(options?) = new Notifier(options)`.
- `NotificationOptions = { title: string; body?: string; silent?: boolean; id?: string; data?: unknown }`.
- `NotificationClick = { id: string; data: unknown }`.
- `NotifierOptions = { onClick?: (click) => void; appId?: string; identity?: AppIdentity }` (`appId`/`identity` are Windows toast identity; docs: `appId` ignored on macOS).
- `NotifierBackend = { notify(n): boolean; dispose(): void }`; `notificationId(n) = n.id ?? "sweetview-<n>"` with a process-wide counter from 1.
- Docs: `true` = handed to the OS; `false` = disposed, Windows balloon fallback failed, or macOS process not bundled. `onClick` runs on the UI thread.

### Behaviour
- Windows `createNotifier`: `ensureWin32Init()`; creates a message window (`createMessageWindow`) whose handler routes `WM_TOAST_EVENT` → `toasts.handleEvent(wParam, lParam)` and `WM_NOTIFIER` (WM_APP+2 = 0x8002) balloon events.
- Windows `notify`: disposed → false. `data` cloned via `JSON.parse(JSON.stringify(data))` (raw value kept if that throws). `click = { id: notificationId(n), data }`. First call only: try `new WinRtToastNotifier(window.hwnd, { ...options, onClick: wrapped })`; failure swallowed. If toasts exist: `toasts.show({ title, body, silent }, click, fallback = () => showBalloon(...))`; success → true; synchronous throw falls through. Otherwise return `showBalloon(n, click)`.
- Wrapped `onClick`: ignored after dispose; throw logged `sweetview: notification onClick threw:`.
- `showBalloon`: disposed → false; `uid = nextNotificationUid++` (module-global, starts 10000); icon bytes from `currentTrayIconBytes()`; small icon `loadIcon(ico)`, large `loadIcon(ico, SM_CXICON)`; balloon icon = large handle only if `largeIcon.owned`. `Shell_NotifyIconW(NIM_ADD, nid)`; failure logs `sweetview: Shell_NotifyIcon notification failed (<err>)`, releases icons, returns false; success records pending uid.
- NOTIFYICONDATAW (976 bytes): cbSize; hWnd@8; uID@16; uFlags@20 = NIF_MESSAGE|NIF_ICON|NIF_TIP|NIF_STATE|NIF_INFO; uCallbackMessage@24 = WM_NOTIFIER; hIcon@32; szTip@40 = title (max 127 UTF-16 units); dwState@296 = dwStateMask@300 = NIS_HIDDEN; szInfo@304 = body (max 255); szInfoTitle@820 = title (max 63); dwInfoFlags@948 = (own icon ? NIIF_USER|NIIF_LARGE_ICON : NIIF_INFO) | NIIF_RESPECT_QUIET_TIME | (silent ? NIIF_NOSOUND); hBalloonIcon@968.
- Balloon events: `event = LOWORD(lParam)`, `uid = wParam`. `NIN_BALLOONUSERCLICK` (0x405) → remove + onClick; `NIN_BALLOONTIMEOUT` (0x404) / `NIN_BALLOONHIDE` (0x403) → remove. Remove = `Shell_NotifyIconW(NIM_DELETE)` + release both icons.
- Windows `dispose` (idempotent): `toasts.dispose()`, then remove every pending balloon, destroy window.
- macOS `createNotifier`: `ensureSharedDelegate()`; adds entry `{ token, onClick }` to `liveNotifiers`; `ensureCenter()` eagerly: requires `[[NSBundle mainBundle] bundleIdentifier]` non-nil; `[UNUserNotificationCenter currentNotificationCenter]`; `setDelegate:` shared delegate.
- macOS `notify`: disposed or no center → false. First call: `requestAuthorizationWithOptions:(Alert 4|Sound 2|Badge 1) completionHandler:sharedAuthBlock`. `id = notificationId(n)`; `recordSent(id, entry)`; `UNMutableNotificationContent` alloc/init; `setTitle:`; `setBody:` if body; `setSound:[UNNotificationSound defaultSound]` unless silent; userInfo `NSMutableDictionary` with `sweetview.process` = PROCESS_TAG and, if data defined, `sweetview.data` = `JSON.stringify(data)`; `[UNNotificationRequest requestWithIdentifier:id content:content trigger:nil]`; `addNotificationRequest:withCompletionHandler:sharedRequestBlock`; release content; return true.
- `PROCESS_TAG = "<pid>-<Date.now() base36>-<8 random base36 chars>"`.
- Delegate `willPresentNotification`: calls completion with `list(8)|banner(16)|sound(2)`.
- Delegate `didReceiveNotificationResponse`: `readClick` (id = request identifier; data = parsed `sweetview.data` JSON or undefined; `fromThisProcess` = tag equals PROCESS_TAG) → `deliverClick`; errors logged `sweetview: notification click handling threw:`; then completion handler invoked.
- `deliverClick`: if id in `sentByThisProcess`: remove it; call owner's onClick only if owner is non-null, still live and has onClick; else drop. Else if `fromThisProcess`: drop. Else (cold-launch): first live notifier (insertion order) with onClick. onClick throws logged `sweetview: notification onClick threw:`.
- `recordSent`: re-insert at end; evict oldest beyond 256 (`MAX_TRACKED_IDS`).
- Auth block: if not granted, logs `sweetview: notification permission denied by the user` when error is nil, else `sweetview: notification permission not granted: turned off for this app in System Settings > Notifications, or refused by macOS because the app is not a signed .app bundle (makeMacApp signs one) or runs from a temporary folder`. Request block: error non-nil → `sweetview: notification not shown: macOS rejected it (permission refused, denied, or not answered yet)`.
- macOS `dispose` (idempotent): remove from `liveNotifiers`; mark its ids as `null` tombstones; when no live notifiers remain and center's delegate is the shared one, `setDelegate:nil`.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `Shell_NotifyIconW` (NIM_ADD 0, NIM_DELETE 2) | shell32.dll | hidden balloon fallback | win32/notifier.ts:108, 138 |
| `createMessageWindow` (class `SweetviewMessageWindow`, real top-level never-shown window) | win32/message-window.ts | event sink | win32/notifier.ts:114 |
| `loadIcon`, `releaseIcon`, `currentTrayIconBytes` | win32/icon.ts, win32/tray.ts | balloon icons (internals not read) | win32/notifier.ts:133-145 |
| `NSBundle mainBundle bundleIdentifier` | Foundation | bundled check | darwin/notifier.ts:61 |
| `UNUserNotificationCenter currentNotificationCenter`, `setDelegate:`, `delegate`, `requestAuthorizationWithOptions:completionHandler:`, `addNotificationRequest:withCompletionHandler:` | UserNotifications | center | darwin/notifier.ts:186-238 |
| `UNMutableNotificationContent` `setTitle:/setBody:/setSound:/setUserInfo:`, `UNNotificationSound defaultSound`, `UNNotificationRequest requestWithIdentifier:content:trigger:` | UserNotifications | build request | darwin/notifier.ts:217-226 |
| `UNNotificationResponse notification.request.identifier/content.userInfo`, `NSDictionary objectForKey:`, `NSMutableDictionary dictionary/setObject:forKey:` | UserNotifications/Foundation | read/write payload | darwin/notifier.ts:52-58, 221-223 |
| `_NSConcreteGlobalBlock` (via `makeBlock`), block invoke at offset 16 (via `invokeBlock`) | libSystem / ObjC blocks ABI | completion blocks | darwin/objc.ts:176-208 |

### Callbacks from the OS into JavaScript
- Windows: message-window JSCallback (in message-window.ts; "Retained for the process") delivers `WM_NOTIFIER` and `WM_TOAST_EVENT` to the handler above.
- macOS delegate methods (`makeTarget("SweetviewNotificationDelegate", ...)`): `userNotificationCenter:willPresentNotification:withCompletionHandler:` ("Called on the main thread while the app is frontmost") and `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:` ("Main thread"). Return void; JSCallbacks retained for the process.
- macOS `sharedAuthBlock` (args `bool granted, u64 error`) and `sharedRequestBlock` (arg `u64 error`): `threadsafe` JSCallbacks; bodies "run later on Bun's event loop"; objc.ts:171-175 says such a body "effectively never runs" while the webview blocks the event loop. Created once per process.

### State and lifetimes
- Windows: per notifier `pending` uid map, `toasts`, `triedWinRt`, message window; balloon uids module-global from 10000.
- macOS: process-wide `sharedDelegate`, `sharedAuthBlock`, `sharedRequestBlock`, `liveNotifiers`, `sentByThisProcess` (≤256). userInfo keys `sweetview.data`, `sweetview.process`.

### Workarounds and constraints stated in comments
- win32/notifier.ts:152: "Clone data through JSON when possible to match macOS behavior cleanly; fallback to raw value if needed."
- win32/notifier.ts:165: "WinRT or per-user identity registration can be unavailable."
- win32/notifier.ts:174: "A synchronous WinRT failure leaves the balloon responsible for delivery."
- darwin/notifier.ts:3-13 (header): eager delegate registration for cold-launch clicks; one shared delegate and block pair "so repeated Notifier creation never leaks runtime classes or blocks"; bounded tombstones; per-process tag "so a click on one whose ID aged out of the map is still recognised as this process's and dropped, never misrouted as a cold-launch click."
- darwin/notifier.ts:146-148: "These bodies run later on Bun's event loop (threadsafe), after the completion handler has returned and its arguments may be freed: compare object arguments with NIL, never send them messages."
- darwin/notifier.ts:152-154: "macOS answers a user's denial (UNErrorDomain 1, \"Notifications are not allowed\") and an unsigned or temporary-folder bundle both with an error, so its presence does not tell the two apart."
- darwin/notifier.ts:93-94: "Strict isolation: if sent in this process and the owning notifier was disposed or had no onClick, do NOT fall through to an unrelated notifier."
- darwin/notifier.ts:99: "never unwind into AppKit".
- darwin/notifier.ts:227: "the request retains it".

## Popup menus (Menu.popup)

### Public API
- `MenuItem = { type?: "item"; label; enabled?; checked?; icon?: Icon; click?: () => void } | { type?: "submenu"; label; enabled?; icon?; submenu: MenuTemplate } | { type: "separator" }`; `MenuTemplate = MenuItem[]`; `MenuSource = MenuTemplate | (() => MenuTemplate)` (function called each time the menu opens).
- `resolveMenu(source)`, `isSeparator(item)`, `isSubmenu(item)` (`"submenu" in item`).
- `Menu.popup(owner: WindowRef, menu: MenuSource, at?: Point): boolean` — "Opens a native popup menu at `at` (default: cursor position). Returns true if an item was chosen." Empty template → false without native calls.
- Win32 internals also exported: `buildMenu`, `destroyMenu`, `escapeLabel`, `bitmapItemInfo`, `MII_SIZE`/`MII_MASK`/`MII_HBMPITEM`, `popupMenuAtCursor(owner: bigint, template)` (tray use). Darwin exports `buildMenu(template): { menu; dispose }`.
- `icon`: "16px from the .ico on Windows, a 16pt template image on macOS."

### Behaviour
- Windows `popupMenu`: `hwnd = asHwnd(owner)`; point = rounded `at`, else `GetCursorPos`; `buildMenu`; `SetForegroundWindow(hwnd)`; `TrackPopupMenu(hmenu, TPM_RIGHTBUTTON|TPM_RETURNCMD, x, y, 0, hwnd, NULL)` (blocks); `PostMessageW(hwnd, WM_NULL, 0, 0)`; `destroyMenu`; then run the chosen command's handler; returns whether a handler existed for the returned id.
- `popupMenuAtCursor`: same with cursor position and `TPM_BOTTOMALIGN` added.
- `buildMenu`: `CreatePopupMenu` (0 → `sweetview: CreatePopupMenu failed`); `fill` recursively; on throw, `destroyMenu` then rethrow.
- `fill`: separator → `AppendMenuW(MF_SEPARATOR)`. Label escaped `&`→`&&`. Grayed when `enabled === false`. Submenu → new popup filled recursively, `AppendMenuW(MF_POPUP|MF_STRING|grayed, hSub, label)`. Item → command id `commands.size + 1` (1-based across the whole tree), handler `click ?? noop`, `AppendMenuW(MF_STRING|grayed|checked, id, label)`. Icon: `item.icon?.windows?.ico` → `iconBitmap(ico)`; non-zero → stored and set via `SetMenuItemInfoW(hmenu, position, TRUE, MENUITEMINFOW{cbSize 80, fMask MIIM_BITMAP 0x80, hbmpItem@72})`; failure logged `sweetview: SetMenuItemInfoW(hbmpItem) failed (<err>)`.
- `destroyMenu`: `DestroyMenu(root)` (takes submenus), then `DeleteObject` for each bitmap.
- macOS `popupMenu`: owner ignored; `sharedApp()`; point = `at ?? cursorPoint() ?? {0,0}`; build; `[menu popUpMenuPositioningItem:nil atLocation:{x, primaryHeight - y} inView:nil]` → BOOL returned; `dispose` in `finally`.
- macOS `buildMenu`: each level `NSMenu alloc/init`, `setAutoenablesItems:NO`. Separator → `[NSMenuItem separatorItem]`. Item → `initWithTitle:label action:NULL keyEquivalent:@""`, `setEnabled:`; icon → `makeImage(icon.macos, 16)` (nil logs `sweetview: menu item "<label>" has no usable macOS image`), `applyImage(item, "setImage:")`, and `setPreferredImageVisibility:1` only if `respondsToSelector:`. Submenu → `setSubmenu:` + release sub. Leaf → `setTarget:` shared target, `setAction:@selector(menuAction:)`, `setState:` 1/0, handler stored by item pointer. Item added then released. Labels are not escaped on macOS.
- macOS `dispose`: deletes the menu's handler entries, releases root menu.
- Whether the macOS click handler runs before `popUpMenuPositioningItem` returns is unclear from the code.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `CreatePopupMenu`, `AppendMenuW`, `SetMenuItemInfoW`, `DestroyMenu`, `TrackPopupMenu`, `SetForegroundWindow`, `PostMessageW`, `GetCursorPos` | user32.dll | build and show menu | win32/menu.ts:45-132 |
| `DeleteObject` | gdi32.dll | free item bitmaps | win32/menu.ts:58 |
| `iconBitmap` | win32/icon.ts | 32bpp item bitmap (internals not read) | win32/menu.ts:82 |
| `NSMenu` `setAutoenablesItems:`, `addItem:`, `popUpMenuPositioningItem:atLocation:inView:` | AppKit | menu | darwin/menu.ts:50-102 |
| `NSMenuItem` `separatorItem`, `initWithTitle:action:keyEquivalent:`, `setEnabled:`, `setSubmenu:`, `setTarget:`, `setAction:`, `setState:`, `setPreferredImageVisibility:` (macOS 27), `respondsToSelector:` | AppKit | items | darwin/menu.ts:54-79 |
| `makeImage`, `applyImage` | darwin/image.ts | item image (internals not read) | darwin/menu.ts:61-63 |

### Callbacks from the OS into JavaScript
- Windows: none; selection comes back as the `TrackPopupMenu` return value (TPM_RETURNCMD) and the handler is called afterwards in JS.
- macOS: shared target `SweetviewMenuTarget` with `menuAction:` (one-arg makeTarget method) looks up `handlers.get(sender)` and calls it. Created once per process; thread unclear from the code.

### State and lifetimes
- Windows: per-showing `{ hmenu, commands, bitmaps }`, destroyed before the handler runs.
- macOS: module `handlers: Map<NSMenuItem, () => void>` (entries removed on dispose); shared target lives for the process.

### Workarounds and constraints stated in comments
- win32/menu.ts:2-5: "Built fresh for every showing, so dynamic labels and check marks cost nothing. Item icons are 32bpp bitmaps (MENUITEMINFO.hbmpItem), which DestroyMenu does not free, so the build keeps a list to delete afterwards."
- win32/menu.ts:29: "A literal ampersand in a menu label is an accelerator prefix unless doubled."
- win32/menu.ts:75: "command ids are 1-based; 0 means \"nothing chosen\"".
- win32/menu.ts:127-129: "The owner must be the foreground window or the menu will not dismiss when the user clicks elsewhere; the WM_NULL afterwards is the documented nudge that makes the menu close correctly next time (KB 135788)."
- darwin/menu.ts:32-35: "macOS 27 hides menu item images by default (NSMenuItemImageVisibilityAutomatic = 0): symbol images for apps linked on the 26 SDK, every image on the 27 SDK. An item keeps its image only by asking for it. The selector is new in 27, so it is sent only where it exists."
- darwin/menu.ts:1-3: "Every item targets one shared NSObject whose `menuAction:` looks the sender up in a map, so item handlers never need their own Objective-C class."

## App identity

### Public API (packages/sweetview-settings/src/app-identity.ts)
- `AppIdentityInput = { appId: string; appName: string; slug?: string; version?: string; urlSchemes?: readonly string[]; icon?: AppIdentityIcon }`.
- `AppIdentity = { readonly appId; appName; slug; version; urlSchemes: readonly string[]; icon?: AppIdentityIcon; dataDir: string }`.
- `AppIdentityIcon = { readonly rgba: Uint8Array; readonly width: number; readonly height: number }`.
- `defineAppIdentity(input): AppIdentity`; `validateUrlScheme(scheme): string`.

### Behaviour
- `validateUrlScheme`: `trim().toLowerCase()`, must match `/^[a-z][a-z0-9+.-]*$/i` else `sweetview: invalid URL scheme <JSON.stringify(scheme)> (must match /^[a-z][a-z0-9+.-]*$/i)`; returns the normalized scheme.
- `defineAppIdentity`: trims appId/appName; empty → `sweetview: defineAppIdentity requires a non-empty appId` / `... appName`. `slug = input.slug.trim() || defaultSlug`; `version = trim() || "0.1.0"`; `urlSchemes` validated and frozen; result frozen; `dataDir = appDataDir(slug)` (not created).
- `defaultSlug`: last non-empty `.`-segment of appId (else appName), lowercased, runs of `[^a-z0-9._-]` → `-`, leading/trailing `-` trimmed; empty → `sweetview-app`.
- `icon`: only automatic consumer is `new Window({ identity })` on Windows.
- `appDataDir` path rules are in settings-store.ts (not read): unclear from the code read here.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| none (`appDataDir` from `./settings-store`) | — | data directory | app-identity.ts:6, 76 |

### Callbacks from the OS into JavaScript
- None.

### State and lifetimes
- None; returns frozen objects.

### Workarounds and constraints stated in comments
- app-identity.ts:1-4: "Zero bun:ffi or webview imports so any build or runtime script can import it on any OS."
- app-identity.ts:28-32: "Tray icons, `writeIconFiles`, and `makeMacApp` do not read it: pass each of them its icon explicitly."

## Shared Win32 initialisation

### Public API (win32/init.ts, internal)
- `ensureDpiAware(): void` — "Sets COM STA and per-monitor DPI awareness v2. Safe to call repeatedly."
- `ensureWin32Init(): void` — `ensureDpiAware()` plus the hidden first-window anchor.

### Behaviour
- `ensureDpiAware`: if COM not settled: `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED=2)`; `RPC_E_CHANGED_MODE` (0x80010106) → settled with stored error `sweetview: this thread already initialised COM as multi-threaded; WebView2 needs an STA`; other negative HRESULT → throw `sweetview: CoInitializeEx failed: HRESULT 0x<hex>` (not settled, later calls retry); success (S_OK/S_FALSE) → settled. Stored error thrown on every call. Then once: `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4)`; return value ignored.
- `ensureWin32Init`: `ensureDpiAware()`; first call creates `anchor = createMessageWindowRaw(() => {})` and keeps it.
- Callers in the files read: `acquireSingleInstance`, clipboard `writeText`, every Win32 Screen entry point, notifier `createNotifier`. Not called by clipboard `readText`/`clear`, `popupMenu`, or `WinRtToastNotifier` directly.

### OS interfaces used
| Interface / function | Owner | Purpose | File:line |
|---|---|---|---|
| `CoInitializeEx` | ole32.dll | COM STA | init.ts:24 |
| `SetProcessDpiAwarenessContext` | user32.dll | per-monitor DPI v2 | init.ts:37 |
| `createMessageWindowRaw` (class `SweetviewMessageWindow`) | win32/message-window.ts | topmost anchor window | init.ts:47 |

### Callbacks from the OS into JavaScript
- The anchor's window procedure is the shared message-window JSCallback (no-op handler), retained for the process per message-window.ts:25.

### State and lifetimes
- `comDone`, `comError`, `dpiDone`, `anchor`: process lifetime; the COM reference and the anchor window are never released.

### Workarounds and constraints stated in comments
- init.ts:2-7: "COM STA initialization (required by WebView2 and IFileOpenDialog)"; "Per-monitor DPI awareness v2 (must run before ANY top-level HWND exists, including hidden message windows for trays/notifiers)"; "Windows 11 25H2 topmost anchor workaround: the first top-level window a process creates can never become HWND_TOPMOST, so create a hidden message window first and keep it for the process."
- init.ts:13-16: "Set once CoInitializeEx has settled this thread's COM state: it succeeded (S_OK/S_FALSE, one reference this process keeps for its lifetime), or COM is already initialised in the other model (RPC_E_CHANGED_MODE, which adds no reference). Any other failure leaves it unset so a later call retries instead of carrying on with COM uninitialised."
- win32/api.ts:107: "the webview library does this only for windows it creates itself" (on `SetProcessDpiAwarenessContext`).
- win32/message-window.ts:1-5: "A never-shown top-level window whose window procedure is a JSCallback. ... It is a real (not message-only) window so it also receives the TaskbarCreated broadcast when Explorer restarts."
