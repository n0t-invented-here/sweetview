# Sweetview: native code in type-safe Rust

Status: proposal and design.

Rule: no functionality is removed. Everything Sweetview, the bindings and the C++ webview fork do today, they do afterwards.

## What Sweetview is

Sweetview lets a Bun app open a webview window, put an icon in the tray or menu bar, show notifications, and draw transparent click-through windows on the desktop. The app is TypeScript and compiles to one executable with `bun build --compile`.

## The change

TypeScript stops calling native code through `bun:ffi`. One native library written in Rust takes over those calls. Bun reaches it through N-API.

| Piece | Today | After |
|---|---|---|
| The webview engine | the C++ fork of `webview/webview`, `libwebview.dll` / `.dylib` | the same file, unchanged |
| The wrapper around the engine | `@n1h/sweetview-webview-bun`: 2,014 lines of TypeScript `bun:ffi` | Rust, calling the same C API |
| Windows, overlays, click-through, tray, menus, notifications, dialogs, event loop | 2,779 lines of TypeScript `bun:ffi` on `main` | Rust, making the same OS calls |
| How Bun reaches native code | `bun:ffi` | N-API |

## Rust crates

| Crate | Job |
|---|---|
| `napi`, `napi-derive`, `napi-build` | The N-API layer. Rust functions and classes marked `#[napi]` become the JavaScript API, and the crate generates the `.d.ts` from the Rust signatures |
| `windows` | Microsoft's Rust bindings for Win32, COM and WinRT, generated from Windows' own metadata |
| `objc2` | The Objective-C runtime: typed message sends, class definition with `define_class!`, `Retained<T>` for retain and release, `MainThreadMarker` |
| `objc2-foundation`, `objc2-app-kit`, `objc2-user-notifications` | Typed bindings for Foundation, AppKit and UserNotifications |
| `block2` | Objective-C blocks, for notification completion handlers |
| `libloading` | Loads the webview engine library at run time |
| `bindgen` (build time) | Generates the Rust declarations of the engine's C API from the fork's `api.h` and `types.h` |

Versions are pinned in `Cargo.lock`.

## What the Rust types enforce

Each row is something the TypeScript `bun:ffi` code does by hand today and the Rust compiler checks afterwards.

| Today, in TypeScript | In Rust | Example in this repository |
|---|---|---|
| Every handle is a `bigint`: windows, menus, icons, Objective-C objects | Each is its own type: `HWND`, `HMENU`, `HICON`, `Retained<NSWindow>`, `Retained<NSMenuItem>`. Passing one where another belongs does not compile | `src/native/win32/api.ts`: every handle is `FFIType.u64` |
| Function signatures are written by hand, one `FFIType` list per call | Signatures come from the OS metadata. A wrong argument count or type does not compile | commit `83d7411`: `isZoomed` read with the wrong return type, `orderFrontRegardless` called with the wrong arity |
| One hand-made `objc_msgSend` variant per signature shape | Typed AppKit methods | `src/native/darwin/objc.ts`: `sendRectUIntUIntBool`, `sendPtrSelPtrVoid` and 30 more |
| Structs are byte arrays with numeric offsets | Real structs with named fields: `NOTIFYICONDATAW`, `WNDCLASSEXW`, `MENUITEMINFOW`, `MSG`, `MONITORINFO` | `win32/tray.ts`: `new Uint8Array(976)` with `NID_INFO = 304` |
| COM methods are called by vtable slot number | Typed interfaces: `IFileOpenDialog::SetOptions`, `IShellItem::GetDisplayName` | `win32/folder-picker.ts`: slots 3, 9, 10, 17, 20 |
| Struct returns need workarounds | Returned by value | `darwin/overlay.ts`: `NSInvocation` to read `+[NSEvent mouseLocation]`, `valueForKey:` to read a frame |
| Release is called by hand | Ownership: `Retained<T>` releases on drop; icons, menus and bitmaps sit in types whose `Drop` frees them | `darwin/menu.ts`: `release(inited)`, `release(sub)`, `release(menu)` |
| Callbacks are `JSCallback` pointers kept alive in module-level arrays | The library owns each callback for exactly as long as the OS can call it | `objc.ts`: `const retained: JSCallback[] = []`, never freed |
| Thread rules are comments | UI-thread objects are not `Send`. Using one from a worker thread does not compile | "Thread: UI thread" in every section of `docs/native.md` |
| Return codes are checked where someone remembered | `Result<T, E>`; an unchecked result is a compiler warning | `win32/menu.ts`: `AppendMenuW` results are not checked |
| Options are strings and numbers | Enums: `ResizeEdge`, `ActivationPolicy`, the hit-test state | `"top-left"` matched with `edge.includes("left")` |
| TypeScript types for native calls are written by hand | The `.d.ts` is generated from the Rust, so the two cannot drift | every `dlopen` table |

What the types do not do: each call into Win32, COM, AppKit or the C++ engine is an `unsafe` block, because those interfaces are unsafe. The blocks are confined to the modules listed under Module map. Every other module carries `#![forbid(unsafe_code)]`.

## Architecture

| Layer | Content | Language |
|---|---|---|
| App | the developer's single `.ts` file | TypeScript |
| Sweetview API | the public API of today, unchanged | TypeScript |
| Binding | `sweetview.<target>.node`, loaded with `require` | Rust |
| Engine | `libwebview.dll` / `.dylib`, loaded by the binding | C++, unchanged |

Sweetview's native layer already has the seam this design uses. Each module declares a `Backend` type and picks an implementation with `backend(win32, darwin)` in `src/native/platform.ts`:

| Module | `Backend` today |
|---|---|
| `event-loop.ts` | `pumpEvents()`, `discardQuit()`, `setActivationPolicy(policy)` |
| `window.ts` | `nativeWindow(handle)` |
| `overlay.ts` | `makeOverlay(handle, options)`, `createOverlayWindow(options)` |
| `tray.ts` | `createTray(options)` |
| `notifications.ts` | `createNotifier(options)` |
| `folder-picker.ts` | `pickFolder(owner, title)` |
| `app-menu.ts` | `installAppMenu(options)` |
| `app-icon.ts` | `setAppIcon(icon)` |

The Rust library implements those eight `Backend` types. `platform.ts` returns the Rust implementation in place of the `win32/` or `darwin/` TypeScript folder. Nothing above that line changes.

## The N-API surface

Internal to the package; app developers never import it. Signatures below are the generated TypeScript.

### Engine wrapper

```ts
class Engine {
  static create(debug: boolean, window: bigint | null): Engine;   // webview_create
  readonly handle: bigint;                                        // unsafeHandle
  readonly windowHandle: bigint;                                  // webview_get_window
  setTitle(title: string): void;
  setSize(width: number, height: number, hint: number): void;
  navigate(url: string): void;
  setHtml(html: string): void;
  init(source: string): void;
  eval(source: string): void;
  bind(name: string, fn: (seq: string, req: string) => void): number;
  unbind(name: string): number;
  returnValue(seq: string, status: number, result: string): void;
  run(): void;                                                    // webview_run, blocks
  terminate(): void;
  destroy(): void;
  setAsset(path: string, mime: string, data: Uint8Array): number;
  setBackgroundColor(r: number, g: number, b: number, a: number): number;
  setRequestHandler(fn: ((req: RawRequest) => void) | null): number;
  setFileDropHandler(fn: ((paths: string[]) => void) | null): number;
  setAllowExternalDrop(allow: boolean): number;
  setDrain(fn: (() => void) | null): void;                        // the ring's UI-thread drain
}

// Callable from any thread, as the C API documents:
function completeRequest(handle: bigint, id: bigint, status: number, headersJson: string | null, body: Uint8Array | null): number;
function beginResponse(handle: bigint, id: bigint, status: number, headersJson: string | null): number;
function writeResponseChunk(handle: bigint, id: bigint, chunk: Uint8Array): number;
function endResponse(handle: bigint, id: bigint): number;
function wake(handle: bigint): void;                              // webview_dispatch -> the drain

function installMouseHook(fn: (event: number, x: number, y: number, wheel: number, modifiers: number) => boolean): number;
function removeMouseHook(): number;
function installKeyboardHook(fn: (event: number, code: string, raw: number, modifiers: number) => boolean): number;
function removeKeyboardHook(): number;
function featurePermissions(feature: number): number;
function permissionStatus(permission: number): number;
function permissionRequest(permission: number): number;
function permissionSetAutoRequest(on: boolean): number;
```

The bindings' `Webview` class, the worker functions, `installMouseHook`, `installKeyboardHook` and `permissions` keep their public shape. Their bodies call the functions above in place of `lib.symbols.*`. Numeric results are the engine's `webview_error_t` codes, so `WebviewError` and every documented code stay as they are.

### Native layer

```ts
function pumpEvents(): boolean;
function discardQuit(): void;
function setActivationPolicy(policy: ActivationPolicy): void;

class NativeWindow {
  constructor(handle: bigint);
  isVisible(): boolean; show(): void; hide(): void;
  setIcon(ico: Uint8Array | null): void;
  onCloseRequest(fn: (() => void) | null): void;
}

class Overlay {
  static create(options: OverlayWindowInit): Overlay;
  static adopt(handle: bigint, options: OverlayInit): Overlay;
  readonly handle: bigint;
  show(): void; hide(): void; setIcon(ico: Uint8Array | null): void;
  bounds(): Rect; moveTo(x: number, y: number): void; resize(w: number, h: number): void; setBounds(r: Rect): void;
  setClickThrough(on: boolean): void;
  setHitRegions(packed: Int32Array | null, refine: ((x: number, y: number, seq: number) => void) | null): void;
  answerHit(seq: number, solid: boolean): void;
  setTopmost(on: boolean): void; startDrag(): void; startResize(edge: ResizeEdge): void;
  minimize(): void; toggleMaximize(): void; maximized(): boolean;
  cursor(): Point; screen(): Rect; screenAt(x: number, y: number): Rect; workArea(): Rect; virtualScreen(): Rect; scale(): number;
}

class Tray {
  constructor(init: TrayInit);            // icon bytes, tooltip, onClick, onDoubleClick, openMenu, menuChosen
  setTooltip(text: string): void; setIcon(icon: IconBytes): void; setHasMenu(has: boolean): void; dispose(): void;
  showBalloon(n: BalloonInit): boolean;   // Windows: the notifier's channel, as today
  onBalloonClick(fn: (() => void) | null): void;
}

class Notifier {                          // macOS: UNUserNotificationCenter, as today
  constructor(onClick: ((id: string, dataJson: string | null) => void) | null);
  notify(n: NotificationInit): boolean; dispose(): void;
}

function pickFolder(owner: bigint | null, title: string): string | null;
function installAppMenu(appName: string, aboutText: string): void;
function setAppIcon(icon: IconBytes): void;
```

Menus stay data, as today. When a menu is about to open, the library calls `openMenu()`. TypeScript resolves the template (calling the app's function form), keeps the click handlers in a table by item number, and returns plain data: labels, flags, icon bytes, nesting. The library builds the native menu, tracks it, and calls `menuChosen(itemNumber)`. The library never holds a per-item JavaScript function.

## Threads

| Thread | May call |
|---|---|
| UI thread: the Bun main thread | everything |
| Worker threads | `completeRequest`, `beginResponse`, `writeResponseChunk`, `endResponse`, `wake`. These are the calls the C API documents as safe from any thread |

- UI-thread state lives in `thread_local!` storage and in types that are not `Send`. A worker cannot reach it.
- Any other function called from a worker throws `sweetview: this call must be made on the UI thread`. Today that mistake is undefined behaviour.
- A worker loads the same `.node` file. The Rust statics the two threads share are `Send + Sync`: the engine library handle and the table of drain trampolines.

## Callbacks from native code into JavaScript

Today a `JSCallback` lets the OS call JavaScript on the UI thread while that thread is inside `webview_run` or `pumpEvents`. The N-API equivalent:

- The library keeps a reference to each JavaScript function and calls it synchronously on the UI thread, inside the native call that is running the loop.
- Each call opens its own handle scope, so an app that runs for days does not accumulate handles.
- A JavaScript exception is caught at the boundary and logged with the message the TypeScript logs today, for example `sweetnative: tray handler threw:`. Nothing unwinds into the OS or the engine. The fallback results match today's: a hook returns "do not swallow", a request handler answers 500.
- A callback may remove or replace itself, or destroy its owner, from inside its own call. The library holds the callback for the duration of the call and frees it afterwards. The bindings' `NativeCallback`, `HookCallback`, `closeReleasedCallbacks` and `closeOrphans` exist only to do this by hand and go away. `Webview.destroy()`'s deferral of the native teardown until the callback has returned stays in TypeScript, unchanged.
- Callbacks that arrive on a background thread (the macOS notification completion handlers) log from Rust directly.

## Event loop

Both modes are kept.

| Mode | Today | After |
|---|---|---|
| `run()` | `webview_run` through `bun:ffi`, blocking | `Engine.run()`, the same call |
| `runEventLoop` | a Bun `setInterval` calling `pumpEvents`, which is `PeekMessageW` / `DispatchMessageW` on Windows and `nextEventMatchingMask:` / `sendEvent:` on macOS | the same TypeScript timer calling the Rust `pumpEvents`, which makes the same OS calls |

`discardQuit`, the hidden first window on Windows, the STA and DPI setup in `createOverlayWindow`, and the timers (hit poll, resize gesture, single-click delay) are ported as they are.

## Transport

Unchanged in shape. `Ring`, `ringBytes` and their documented behaviour stay, because the ring is pure TypeScript over a `SharedArrayBuffer`.

| Hop | Today | After |
|---|---|---|
| page to UI thread | `webview_bind` of `__sweetview_rpc` | `Engine.bind` |
| UI thread to worker | `worker.postMessage` | the same |
| worker to UI thread | frame into the ring, then `webview_dispatch` with the pointer of a `JSCallback` | frame into the ring, then `wake(handle)`. The library calls `webview_dispatch` with its own trampoline, which runs the function given to `setDrain` on the UI thread |
| UI thread to page | `webview_return`, `webview_eval` | `Engine.returnValue`, `Engine.eval` |

The init message to the worker loses `drainCallbackPtr` and `libPath`.

## Handles

The public API exposes native handles today and keeps doing so: `Webview.unsafeHandle`, `Webview.unsafeWindowHandle`, `Overlay.handle`, `WindowHandle`, and the `handle` argument of the worker functions. They stay opaque numbers. JavaScript no longer builds, reads or frees native memory through them. The library checks every handle it receives against its own table of live windows, and the engine checks webview handles against its registry of live webviews.

## Loading the engine and packaging

- The engine stays a separate library, the file the bindings ship today. The Rust binding loads it with `libloading`.
- `WEBVIEW_PATH` keeps working: when set, that file is loaded.
- The per-feature probing stays: each group of fork functions (assets and background colour, request handler, streaming, external drop, file drop, hooks, permissions) is looked up on first use, so a library without one group still serves the others, as `src/webview.ts` does today.
- One npm package holds the TypeScript, the `.node` binding per target and the engine library per target: Windows x64, macOS (universal, macOS 11.0 and later, as today), Linux x64.
- The binding is loaded with a literal `require` per platform; the engine library is imported `with { type: "file" }`, as today. Both are forms `bun build --compile` embeds.
- CI builds the binding with `cargo` and the engine with the fork's existing CMake recipe, on one runner per OS. Consumers install no Rust and no C++ toolchain.

## Module map

Every native file on `main`, and where its code goes. "Unsafe" marks modules that contain OS calls.

| TypeScript today | Lines | Rust module | Unsafe | OS interfaces |
|---|---|---|---|---|
| `win32/api.ts` | 234 | none: replaced by the `windows` crate | n/a | n/a |
| `win32/event-loop.ts` | 43 | `win32::event_loop` | yes | `PeekMessageW`, `TranslateMessage`, `DispatchMessageW` |
| `win32/window.ts` | 77 | `win32::window` | yes | `ShowWindow`, `IsWindowVisible`, `IsIconic`, `SetForegroundWindow`, `SetWindowSubclass` |
| `win32/message-window.ts` | 72 | `win32::message_window` | yes | `RegisterClassExW`, `CreateWindowExW`, a window procedure |
| `win32/tray.ts` | 230 | `win32::tray` | yes | `Shell_NotifyIconW`, `SetTimer`, `GetDoubleClickTime`, the `TaskbarCreated` message |
| `win32/menu.ts` | 107 | `win32::menu` | yes | `CreatePopupMenu`, `AppendMenuW`, `SetMenuItemInfoW`, `TrackPopupMenu` |
| `win32/notifier.ts` | 28 | `notifier` | no | none; it drives the tray's balloon |
| `win32/icon.ts` | 85 | `win32::icon` | yes | `CreateIconFromResourceEx`, `CreateDIBSection`, `WM_SETICON` |
| `win32/folder-picker.ts` | 121 | `win32::folder_picker` | yes | `IFileOpenDialog`, `IShellItem` |
| `win32/overlay.ts` | 521 | `win32::overlay` | yes | window styles, `SetLayeredWindowAttributes`, `DwmEnableBlurBehindWindow`, `DwmSetWindowAttribute`, `SetWindowPos`, monitors, DPI |
| hit-test logic inside both `overlay.ts` files | about 80 each | `hit` | no | none: the polygon test and the refine state machine, shared by both platforms |
| `darwin/objc.ts` | 251 | none: replaced by `objc2` and `block2` | n/a | n/a |
| `darwin/event-loop.ts` | 48 | `darwin::event_loop` | yes | `NSApplication` event dequeue and dispatch |
| `darwin/window.ts` | 64 | `darwin::window` | yes | `NSWindow`, the close button's target and action |
| `darwin/overlay.ts` | 348 | `darwin::overlay` | yes | `NSWindow` style, level, collection behaviour; `NSScreen`; `NSEvent`; `NSTimer` |
| `darwin/tray.ts` | 129 | `darwin::tray` | yes | `NSStatusItem` and its button |
| `darwin/menu.ts` | 88 | `darwin::menu` | yes | `NSMenu`, `NSMenuItem` |
| `darwin/notifier.ts` | 141 | `darwin::notifier` | yes | `UNUserNotificationCenter`, its delegate, completion blocks |
| `darwin/app-menu.ts` | 88 | `darwin::app_menu` | yes | `NSMenu`, `NSAlert` |
| `darwin/image.ts`, `app-icon.ts`, `folder-picker.ts` | 86 | `darwin::image`, `app_icon`, `folder_picker` | yes | `NSImage`, `NSOpenPanel` |
| the bindings' `src/ffi.ts`, `webview.ts`, `mouse-hook.ts`, `keyboard-hook.ts`, `permissions.ts`, `input-hooks.ts` | 2,014 | `engine` | yes | the engine's C API, declared by `bindgen` |
| none | new | `napi_surface`, `callbacks`, `registry`, `threads` | no | none |

Kept as TypeScript, untouched: `hit-regions.ts`, `icon.ts`, `menu.ts`, `ring.ts`, the IPC modules, `html.ts`, `build.ts`, `make-app.ts`, `settings-store.ts`, `window-chrome.ts`, `page.ts`.

## Not designed yet

Listed so nothing is assumed. For each, the calls it makes are counted and its files have not been read line by line.

| Part | Size | Native interfaces it uses |
|---|---|---|
| `demos/native-tabs` on `main` | 2,004 lines, 3 files with FFI, 6 `JSCallback`s | `ICoreWebView2`, `ICoreWebView2Controller`, `ICoreWebView2AcceleratorKeyPressedEventArgs`, `ICoreWebView2NewWindowRequestedEventArgs`; 34 Win32 and CoreGraphics functions; 59 Objective-C selectors |
| `v1-drafting`: URL schemes and single instance | 431 lines, 2 `JSCallback`s | not read |
| `v1-drafting`: clipboard | 98 lines | not read |
| `v1-drafting`: WinRT toast notifications | 398 lines | not read |
| `v1-drafting`: screen information | 316 lines, 1 `JSCallback` | not read |
| `v1-drafting`: tabs as library API | 1,763 lines, 8 `JSCallback`s | not read |
| Linux | none exists | the engine's upstream GTK backend; everything else is new |

Each is designed at its own step, by the same method: its `Backend` seam, its N-API functions, its module map row.

## Order of work

After every step the tree works, with moved modules in Rust and the rest still on `bun:ffi`.

1. Binding skeleton: `napi` entry point, the engine loaded with `libloading`, CI producing the binaries. Proves the callback mechanism: a function bound with `Engine.bind` is called from the page while `run()` blocks. Accepted by the bindings' `examples/basic.ts` and `examples/bind.ts`.
2. The engine wrapper in full, hooks and permissions included. Accepted by `test/request-handler.test.ts` and `examples/input-hooks.ts`, unchanged.
3. Event loop and `NativeWindow`. Accepted by `demos/web-app` and by `demos/menubar-only` on the timer-pumped loop.
4. Overlays and hit regions. Accepted by `demos/desktop-pet`.
5. Tray, menus, notifier, folder picker, app menu, app icon. Accepted by `demos/menubar-notify`.
6. Native tabs. Accepted by `demos/native-tabs`.
7. Delete `src/native/win32/`, `src/native/darwin/` and the bindings' FFI files.
8. The `v1-drafting` features, one at a time.
9. Tauri 2 and Electron IPC transports: page code identical across webview, WebSocket, Tauri 2 and Electron.
10. Linux.

## Risks and actions

| Risk | Action |
|---|---|
| A JavaScript function called from native code while the UI thread is inside the blocking loop does not behave under Bun's N-API as it does under `bun:ffi` | Step 1 exists to prove it, with the bindings' own examples, before any module is ported. |
| A ported module behaves differently | Each module is accepted against its existing tests and demo before its TypeScript version is deleted. Both exist side by side until then. |
| `unsafe` blocks spread | `#![forbid(unsafe_code)]` on every module marked "no" in the module map. CI counts `unsafe` blocks and fails when the count rises without an entry in a tracked list. |
| The C++ engine has memory errors | CI builds it with AddressSanitizer and runs the fork's 1,687 lines of tests under it on macOS and Linux. |
| A compiled app embeds binaries for platforms it does not target | Step 1 measures the size of a compiled `examples/basic.ts` per target and the build helper excludes the other targets' files. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Replace the C++ engine with `wry` | It removes functionality: streamed responses, service-worker request interception, HTML drops alongside file drops, the system-wide input hooks |
| Replace Sweetview's windows with `tao` | `tao` runs its own event loop; Sweetview's two loop modes are kept |
| Keep the TypeScript FFI | No compiler checks on any native call |
| `webviewjs/webview` | Built on `wry`; its tray does not deliver events without a window |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket; excluded by the project owner |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |

## What was read

- `n0t-invented-here/sweetview-webview-bun`, branch `v1-drafting`: every file in `src/`, the README, every page in `docs/`, `scripts/build.ts`, the justfile.
- `n0t-invented-here/sweetview-webview`, branch `v1-drafting`: every page in `sweetview/`; the full diff against upstream `f1a9d6b` of `engine_base.hh`, `win32_edge.hh` and `cocoa_webkit.hh`; `input_hooks.hh`.
- This repository on `main`: `README.md`, `docs/app.md`, `docs/native.md`, `docs/webview-library.md`, `src/app.ts`, `src/worker.ts`, `src/webview-lib.ts`, `src/ring.ts`, and every file under `src/native/` except `icon.ts` and `hit-regions.ts`.
- Line and file counts come from git.

## Sources

- https://github.com/napi-rs/napi-rs
- https://napi.rs/docs/concepts/function
- https://napi.rs/docs/concepts/threadsafe-function
- https://github.com/microsoft/windows-rs
- https://github.com/madsmtm/objc2
- https://bun.com/docs/api/node-api
- https://bun.com/docs/compiler/executables
- https://github.com/webview/webview
