# Sweetview: native code in type-safe Rust

Status: proposal and design.

Rule: no functionality is removed. Everything Sweetview, the bindings and the C++ webview fork do today exists afterwards. Where a crate lacks something, this project writes it in Rust.

## What Sweetview is

Sweetview lets a Bun app open a webview window, put an icon in the tray or menu bar, show notifications, and draw transparent click-through windows on the desktop. The app is TypeScript and compiles to one executable with `bun build --compile`.

## The change

All native code becomes Rust. Bun reaches it through N-API. No C++ and no `bun:ffi` remain.

| Piece | Today | After |
|---|---|---|
| The webview | a C++ fork of `webview/webview`, reached through a `bun:ffi` wrapper package | `wry`, plus this project's additions for what the C++ fork has and `wry` lacks |
| Windows, transparent overlays, click-through, event loop | TypeScript `bun:ffi` calling Win32 and AppKit | `tao` |
| Tray or menu-bar icon | TypeScript `bun:ffi` | `tray-icon` |
| Menus | TypeScript `bun:ffi` | `muda` |
| Folder dialog | TypeScript `bun:ffi` | `rfd` |
| Notifications | TypeScript `bun:ffi` | Rust written by this project on `windows` and `objc2-user-notifications`; `notify-rust` on Linux |
| System-wide mouse and keyboard hooks, permission model | C++ in the webview fork | Rust written by this project on `windows` and `objc2-core-graphics` |
| How Bun reaches native code | `bun:ffi` | N-API through `napi` |

## Rust crates

Crates that already wrap the OS behind safe APIs. They are the libraries Tauri 2 is built on.

| Crate | Version read | Job |
|---|---|---|
| `tao` | 0.38.0 | windows and the OS event loop |
| `wry` | 0.58.2 | the webview: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux |
| `muda` | 0.22.0 | menus: `MenuItem`, `CheckMenuItem`, `IconMenuItem`, `Submenu`, `PredefinedMenuItem` |
| `tray-icon` | 0.27.0 | tray and menu-bar icon with click events; the `ksni` feature gives Linux clicks |
| `rfd` | pinned at step 1 | file and folder dialogs |
| `notify-rust` | pinned at step 1 | Linux notifications |

Crates for the N-API layer and for the Rust this project writes itself.

| Crate | Job |
|---|---|
| `napi`, `napi-derive`, `napi-build` | The N-API layer. Rust marked `#[napi]` becomes the JavaScript API, and the crate generates the `.d.ts` from the Rust signatures |
| `windows` | Microsoft's Rust bindings for Win32, COM and WinRT, generated from Windows' own metadata |
| `objc2`, `objc2-foundation`, `objc2-app-kit` | Typed Objective-C: message sends, `define_class!`, `Retained<T>`, `MainThreadMarker` |
| `objc2-user-notifications`, `objc2-core-graphics`, `block2` | macOS notifications, the event tap for the input hooks, Objective-C blocks |

Two of the crates are used as forks this project owns, each carrying a short list of additions: `wry` and `tray-icon`. The additions are listed under "What this project writes in Rust".

## Memory safety

| Code | Unsafe |
|---|---|
| `tao`, `wry`, `muda`, `tray-icon`, `rfd` | inside the crates; their public APIs are safe |
| Sweetview's own crate, except the modules below | none: `#![forbid(unsafe_code)]` |
| Sweetview's `platform` modules: input hooks, notifications, and the single OS calls listed below | yes, one `unsafe` block per OS call |
| This project's additions inside its `wry` and `tray-icon` forks | yes, in the same style as the code around them |
| JavaScript | no native calls at all |

## What the Rust types enforce

Each row is something the TypeScript `bun:ffi` code does by hand today.

| Today, in TypeScript | In Rust | Example in this repository |
|---|---|---|
| Every handle is a `bigint` | Each is its own type: `tao::window::Window`, `wry::WebView`, `muda::Menu`, `tray_icon::TrayIcon`. Passing one where another belongs does not compile | `src/native/win32/api.ts`: every handle is `FFIType.u64` |
| Function signatures are written by hand, one `FFIType` list per call | The crates' signatures are checked by the compiler | commit `83d7411`: `isZoomed` read with the wrong return type, `orderFrontRegardless` called with the wrong arity |
| One hand-made `objc_msgSend` variant per signature shape | Typed methods | `src/native/darwin/objc.ts`: `sendRectUIntUIntBool`, `sendPtrSelPtrVoid` and 30 more |
| Structs are byte arrays with numeric offsets | Real structs with named fields | `win32/tray.ts`: `new Uint8Array(976)` with `NID_INFO = 304` |
| COM methods are called by vtable slot number | Typed interfaces | `win32/folder-picker.ts`: slots 3, 9, 10, 17, 20 |
| Release is called by hand | Ownership: values free their OS resources when dropped | `darwin/menu.ts`: `release(inited)`, `release(sub)`, `release(menu)` |
| Callbacks are `JSCallback` pointers kept alive in module-level arrays | The library owns each callback for exactly as long as the OS can call it | `objc.ts`: `const retained: JSCallback[] = []`, never freed |
| Thread rules are comments | UI-thread types are not `Send`. Using one from a worker thread does not compile | "Thread: UI thread" throughout `docs/native.md` |
| Return codes are checked where someone remembered | `Result<T, E>`; an unchecked result is a compiler warning | `win32/menu.ts`: `AppendMenuW` results are not checked |
| Options are strings and numbers | Enums | `edge.includes("left")` |
| TypeScript types for native calls are written by hand | The `.d.ts` is generated from the Rust | every `dlopen` table |

## Every behaviour, and what provides it

### Sweetview on `main`

| Behaviour | Provided by |
|---|---|
| Create a window hidden, frameless or framed, transparent, topmost, not focusable, off the taskbar | `tao`: `WindowBuilder::with_visible`, `with_decorations`, `with_transparent`, `with_always_on_top`, `with_focusable`, `with_skip_taskbar`, `with_no_redirection_bitmap` |
| Show, hide, move, resize, raise, bounds | `tao`: `set_visible`, `set_outer_position`, `set_inner_size`, `set_always_on_top`, `outer_position`, `outer_size` |
| Whole-window click-through | `tao`: `set_ignore_cursor_events` |
| Hit regions: 10 ms poll, polygons, the refine round trip to the page | Sweetview's `hit` module (safe Rust): `tao` `cursor_position` and `set_ignore_cursor_events` |
| "Never flip click-through while a mouse button is down" | Sweetview `platform`: `GetAsyncKeyState` on Windows, `NSEvent::pressedMouseButtons` on macOS |
| Screen, screen at a point, virtual screen, scale | `tao`: `primary_monitor`, `available_monitors`, `monitor_from_point`, `scale_factor` |
| Work area | Sweetview `platform`: `SystemParametersInfoW`, `NSScreen::visibleFrame` |
| Title-bar drag from the page | `tao`: `drag_window` |
| Edge resize from the page, minimum 160x120 | Sweetview's own gesture, as today, in safe Rust on `cursor_position` and `set_outer_position` |
| Minimise; maximise to the work area and back | `tao` `set_minimized`; Sweetview's own toggle, as today |
| Window icon; light, dark or system frame | `tao`: `set_window_icon`, `set_theme` |
| `colorKey` and `opacity` | Sweetview `platform`: `SetLayeredWindowAttributes`, `NSWindow::setAlphaValue` |
| macOS: above the Dock, on every Space, out of window cycling, over full-screen apps | Sweetview `platform`: `NSWindow::setLevel`, `setCollectionBehavior` |
| Close button hides the window | `tao`: the `CloseRequested` event |
| Activation policy | `tao`: `EventLoopExtMacOS::set_activation_policy` |
| Tray icon, tooltip, click and double click, menu | `tray-icon`, with the single and double click timing in safe Rust |
| Menus with check marks, icons, submenus, rebuilt on every open | `muda` |
| SF Symbol icons on macOS | Sweetview `platform`: `NSImage::imageWithSystemSymbolName` |
| Windows notifications as the tray's balloon, with click | the `tray-icon` fork: one function and one event |
| macOS notifications with click, data round trip, banners while frontmost | Sweetview `platform` on `objc2-user-notifications` |
| Folder dialog | `rfd` |
| macOS app menu with About, Quit and Edit | `muda` predefined items; the About alert through `rfd` |
| Dock icon at run time | Sweetview `platform`: `NSApplication::setApplicationIconImage` |
| `run()`: the blocking loop | `tao`: `EventLoop::run` |
| `runEventLoop`: the loop pumped from a Bun timer | `tao`: `run_return`, called once per tick |
| Webview in a window, or a child webview with bounds | `wry`: `build`, `build_as_child`, `with_bounds` |
| Page-to-host calls with no TCP | `wry`: `with_ipc_handler` |
| Host-to-page replies and events | `wry`: `evaluate_script` |
| The worker's wake-up of the UI thread | `tao`: `EventLoopProxy::send_event` |

### Every addition in the C++ webview fork

All kept.

| Addition | C API today | Provided by |
|---|---|---|
| Background colour and transparency | `webview_set_background_color` | `wry`: `with_transparent`, `with_background_color` |
| Assets at the page's own origin | `webview_set_asset` | `wry`: `with_custom_protocol` |
| Request handler | `webview_set_request_handler`, `webview_complete_request` | `wry`: `with_asynchronous_custom_protocol`; header validation, status and size limits in Sweetview's safe Rust, ported from `http_request.hh` with its tests |
| Frames origin, cross-origin from the page | part of the request handler | `wry`: a second custom protocol scheme |
| Service-worker, shared-worker and cross-origin iframe requests reaching the handler on Windows | part of the request handler | the `wry` fork: `AddWebResourceRequestedFilterWithRequestSourceKinds` |
| Streamed responses | `webview_begin_response`, `webview_write_response_chunk`, `webview_end_response` | the `wry` fork: a streaming body on WebView2 and `didReceiveData:` per chunk on WKWebView, ported from `streaming_istream.hh` and `cocoa_webkit.hh` |
| External drop control with HTML drops inside the page still working | `webview_set_allow_external_drop` | the `wry` fork: the C++ fork's drag routing |
| File drop paths | `webview_set_file_drop_handler` | the `wry` fork: the same drag routing |
| Bindings reachable from the top-level document only | internal | the `wry` fork: IPC messages from other frames are refused |
| System-wide mouse hook | `webview_mouse_hook_install`, `webview_mouse_hook_remove` | Sweetview `platform`: `SetWindowsHookExW(WH_MOUSE_LL)`, `CGEventTap`; ported from `mouse_hook.hh` |
| System-wide keyboard hook, DOM key codes | `webview_keyboard_hook_install`, `webview_keyboard_hook_remove` | Sweetview `platform`: `WH_KEYBOARD_LL`, the same event tap; `key_codes.hh` ported with its tests |
| Permission model for the hooks | `webview_feature_permissions`, `webview_permission_status`, `webview_permission_request`, `webview_permission_set_auto_request` | Sweetview `platform`: `CGPreflightPostEventAccess`, `CGRequestPostEventAccess` |
| Teardown hardening | internal | Rust ownership: a webview, its handlers and its open requests are freed together when the `WebView` value is dropped |

### What this project writes in Rust

| Where | What | Unsafe |
|---|---|---|
| `wry` fork | streamed response bodies; all request source kinds on Windows; the C++ fork's drag routing; top-level-only IPC | yes |
| `tray-icon` fork | the balloon notification and its click event on Windows | yes |
| Sweetview `platform::input` | mouse hook, keyboard hook, permissions | yes |
| Sweetview `platform::notify` | macOS notifications | yes |
| Sweetview `platform::misc` | mouse-button state, work area, `colorKey` and `opacity`, window level and collection behaviour, SF Symbols, Dock icon | yes, one call each |
| Sweetview `hit`, `http`, `menu`, `click`, `resize` | hit-region poll and refine state machine; header validation; menu data; click timing; the resize gesture | no |
| Sweetview `napi_surface`, `callbacks`, `registry`, `threads` | the N-API layer | no |

## The games: required functions and the gate

The owner's transparent desktop games are not in this repository or its siblings on the machine this was written on. So every function of Sweetview, the bindings and the C++ fork is treated as required by them. The functions below are the ones a full-screen transparent game with click handling exercises directly.

| Function | Provided by | Check that exists today | Proven at |
|---|---|---|---|
| A transparent, frameless, topmost window that never takes focus, above the taskbar or Dock | `tao`, `platform::misc` for the macOS window level | `demos/desktop-pet`; `scripts/shot.ps1`, `scripts/flicker.ps1` | step 5 |
| A transparent page background, alpha 0 | `wry` `with_transparent`, `with_background_color` | the fork's background colour tests; `demos/desktop-pet` | step 2 |
| Whole-window click-through on and off | `tao` `set_ignore_cursor_events` | `scripts/settings-probe.ps1` | step 5 |
| Hit regions: polygons from the page, 10 ms poll, exact answer from the page, no flip while a button is down | Sweetview `hit`, `platform::misc` | `hit-regions.test.ts`; `scripts/probe.ps1`, which sends real input and reports which window the OS hands each click to | step 5 |
| System-wide mouse hook: move, left, right, middle, wheel, modifiers, swallow per event | Sweetview `platform::input` | `examples/input-hooks.ts`; the fork's unit tests | step 4 |
| System-wide keyboard hook: down, up, repeat, DOM key codes, modifiers, swallow per event | Sweetview `platform::input` | `examples/input-hooks.ts`; the fork's key-code unit tests | step 4 |
| macOS permission model for the hooks: needed, status, request, auto-request | Sweetview `platform::input` | `examples/input-hooks.ts` | step 4 |
| Window move and resize driven by the page, every frame | `tao` | `demos/desktop-pet` | step 5 |
| Every monitor: screen, screen at a point, virtual screen, scale | `tao` | `demos/desktop-pet` on a second monitor | step 5 |
| Assets, models and textures served at the page's origin | `wry` custom protocol | `test/request-handler.test.ts` | step 2 |
| Page calls answered on the UI thread and in the worker; events to the page | `wry` IPC, the ring | `demos/desktop-pet`, `demos/web-app` | step 2 |
| Both loop modes | `tao` | `demos/web-app`, `demos/menubar-only` | step 1 |
| One executable from `bun build --compile` | the `.node` binding | each demo's `compile` recipe | step 1 |

Nothing in this table works until its step is built and its check passes. This document is a design; it proves nothing by itself.

The gate:

- The current stack stays intact, published and usable throughout: the TypeScript FFI, `@n1h/sweetview-webview-bun` and the C++ fork. A game keeps running on it at every point.
- The Rust library ships beside it under its own package version. A game moves to it by changing a dependency and moves back the same way.
- Nothing of the current stack is deleted until every check in this document passes on Windows and macOS, and the owner's games run on the Rust library.
- A function that cannot be made to work in Rust stops the migration at that step. The current stack remains the shipping one.

## Architecture

| Layer | Content | Language |
|---|---|---|
| App | the developer's single `.ts` file | TypeScript |
| Sweetview API | the public API of today, unchanged | TypeScript |
| Binding | `sweetview.<target>.node`, loaded with `require` | Rust |

Sweetview's native layer already has the seam this design uses. Each module declares a `Backend` type and picks an implementation with `backend(win32, darwin)` in `src/native/platform.ts`: `event-loop`, `window`, `overlay`, `tray`, `notifications`, `folder-picker`, `app-menu`, `app-icon`. The Rust library implements those eight `Backend` types and `platform.ts` returns it. The bindings' `Webview` class keeps its public shape and calls the Rust library in place of `lib.symbols.*`.

## The N-API surface

Internal to the package. Signatures are the generated TypeScript.

```ts
class Engine {
  static create(debug: boolean, window: bigint | null): Engine;
  readonly handle: bigint;
  readonly windowHandle: bigint;
  setTitle(title: string): void;
  setSize(width: number, height: number, hint: number): void;
  navigate(url: string): void;
  setHtml(html: string): void;
  init(source: string): void;
  eval(source: string): void;
  bind(name: string, fn: (seq: string, req: string) => void): number;
  unbind(name: string): number;
  returnValue(seq: string, status: number, result: string): void;
  run(): void;
  terminate(): void;
  destroy(): void;
  setAsset(path: string, mime: string, data: Uint8Array): number;
  setBackgroundColor(r: number, g: number, b: number, a: number): number;
  setRequestHandler(fn: ((req: RawRequest) => void) | null): number;
  setFileDropHandler(fn: ((paths: string[]) => void) | null): number;
  setAllowExternalDrop(allow: boolean): number;
  setDrain(fn: (() => void) | null): void;
}

// Callable from any thread:
function completeRequest(handle: bigint, id: bigint, status: number, headersJson: string | null, body: Uint8Array | null): number;
function beginResponse(handle: bigint, id: bigint, status: number, headersJson: string | null): number;
function writeResponseChunk(handle: bigint, id: bigint, chunk: Uint8Array): number;
function endResponse(handle: bigint, id: bigint): number;
function wake(handle: bigint): void;

function installMouseHook(fn: (event: number, x: number, y: number, wheel: number, modifiers: number) => boolean): number;
function removeMouseHook(): number;
function installKeyboardHook(fn: (event: number, code: string, raw: number, modifiers: number) => boolean): number;
function removeKeyboardHook(): number;
function featurePermissions(feature: number): number;
function permissionStatus(permission: number): number;
function permissionRequest(permission: number): number;
function permissionSetAutoRequest(on: boolean): number;

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
  constructor(init: TrayInit);   // icon, tooltip, onClick, onDoubleClick, openMenu, menuChosen
  setTooltip(text: string): void; setIcon(icon: IconBytes): void; setHasMenu(has: boolean): void; dispose(): void;
  showBalloon(n: BalloonInit): boolean;
  onBalloonClick(fn: (() => void) | null): void;
}

class Notifier {
  constructor(onClick: ((id: string, dataJson: string | null) => void) | null);
  notify(n: NotificationInit): boolean; dispose(): void;
}

function pickFolder(owner: bigint | null, title: string): string | null;
function installAppMenu(appName: string, aboutText: string): void;
function setAppIcon(icon: IconBytes): void;
```

- Numeric results keep the `webview_error_t` codes of today, so `WebviewError` and every documented code stay as they are.
- Menus stay data. When a menu is about to open the library calls `openMenu()`; TypeScript resolves the template, keeps the click handlers by item number, and returns plain data. The library builds the `muda` menu and calls `menuChosen(itemNumber)`.

## Threads

| Thread | May call |
|---|---|
| UI thread: the Bun main thread | everything |
| Worker threads | `completeRequest`, `beginResponse`, `writeResponseChunk`, `endResponse`, `wake`, as today |

- UI-thread state lives in `thread_local!` storage and in types that are not `Send`.
- Any other function called from a worker throws `sweetview: this call must be made on the UI thread`. Today that mistake is undefined behaviour.
- A worker reaches the UI thread through `tao`'s `EventLoopProxy`, which is `Send`.

## Callbacks from native code into JavaScript

Today a `JSCallback` lets the OS call JavaScript on the UI thread while that thread is inside the loop.

- The library keeps a reference to each JavaScript function and calls it synchronously on the UI thread, inside the native call that is running the loop.
- Each call opens its own handle scope.
- A JavaScript exception is caught at the boundary and logged with the message the TypeScript logs today. Nothing unwinds into the OS. The fallback results match today's: a hook returns "do not swallow", a request handler answers 500.
- A callback may remove or replace itself, or destroy its owner, from inside its own call. The library holds it for the duration of the call. The bindings' `NativeCallback`, `HookCallback`, `closeReleasedCallbacks` and `closeOrphans` exist only to do this by hand and go away.

## Event loop

| Mode | Today | After |
|---|---|---|
| `run()` | `webview_run`, blocking | `EventLoop::run`, blocking, entered from `Engine.run()` |
| `runEventLoop` | a Bun `setInterval` calling `pumpEvents`: `PeekMessageW` and `DispatchMessageW`, or `nextEventMatchingMask:` and `sendEvent:` | the same Bun timer calling `pumpEvents`, which calls `run_return` and exits it when the queue is empty |

`tao` documents that `run_return` does not return while a window is being resized. Today's pump has the same property: `DispatchMessageW` does not return during the OS's modal size loop.

## Transport

`Ring`, `ringBytes` and their documented behaviour stay; the ring is pure TypeScript over a `SharedArrayBuffer`.

| Hop | Today | After |
|---|---|---|
| page to UI thread | `webview_bind` of `__sweetview_rpc` | `wry`'s IPC handler |
| UI thread to worker | `worker.postMessage` | the same |
| worker to UI thread | frame into the ring, then `webview_dispatch` with a `JSCallback` pointer | frame into the ring, then `wake(handle)`, which sends a `tao` user event; the UI thread runs the function given to `setDrain` |
| UI thread to page | `webview_return`, `webview_eval` | `wry` `evaluate_script` |

## Handles and constants

- `Webview.unsafeHandle`, `Webview.unsafeWindowHandle`, `Overlay.handle` and the `handle` argument of the worker functions stay in the API as opaque numbers. The library checks each one against its table of live objects.
- `assetOrigin` keeps its values: `http://webview.localhost` on Windows, `webview://localhost` on macOS.
- `framesOrigin` on Windows becomes `http://webview-frames.localhost`; today it is `http://frames.webview.localhost`. Apps read it from the getter.
- `WEBVIEW_PATH` pointed at a custom engine build. `SWEETVIEW_NATIVE_PATH` points at a custom build of the binding.

## Packaging

- One npm package holds the TypeScript and one `.node` binding per target: Windows x64, macOS arm64 and x64, Linux x64.
- The binding is loaded with a literal `require` per platform, the form `bun build --compile` embeds.
- CI builds with `cargo` on one runner per OS. Consumers install no Rust.
- `@n1h/sweetview-webview-bun` is folded into the one package; its API is re-exported unchanged.

## Module map

| TypeScript or C++ today | Lines | After |
|---|---|---|
| `win32/api.ts`, `darwin/objc.ts` | 485 | gone: the crates replace them |
| `win32/event-loop.ts`, `darwin/event-loop.ts` | 91 | `tao` event loop |
| `win32/window.ts`, `darwin/window.ts`, `win32/message-window.ts` | 213 | `tao` windows and events |
| `win32/overlay.ts`, `darwin/overlay.ts` | 869 | `tao`, Sweetview `hit` and `resize`, `platform::misc` |
| `win32/tray.ts`, `darwin/tray.ts` | 359 | `tray-icon` fork, Sweetview `click` |
| `win32/menu.ts`, `darwin/menu.ts`, `darwin/app-menu.ts` | 283 | `muda`, Sweetview `menu` |
| `win32/notifier.ts`, `darwin/notifier.ts` | 169 | `tray-icon` fork balloon; `platform::notify` |
| `win32/icon.ts`, `darwin/image.ts`, `darwin/app-icon.ts` | 142 | the crates' `Icon` types; `platform::misc` for SF Symbols and the Dock icon |
| `win32/folder-picker.ts`, `darwin/folder-picker.ts` | 150 | `rfd` |
| the bindings' `src/` | 2,014 | Sweetview `engine` on `wry` |
| C++ fork: backends, `engine_base.hh` | upstream plus 8,646 added | `wry` and its fork additions |
| C++ fork: `http_request.hh` | 683 | Sweetview `http`, safe Rust |
| C++ fork: `input_hooks.hh`, `mouse_hook.hh`, `keyboard_hook.hh`, `key_codes.hh` | 1,617 | Sweetview `platform::input` |
| C++ fork: `streaming_istream.hh` | 373 | `wry` fork |

Kept as TypeScript, untouched: `hit-regions.ts`, `icon.ts`, `menu.ts`, `ring.ts`, the IPC modules, `html.ts`, `build.ts`, `make-app.ts`, `settings-store.ts`, `window-chrome.ts`, `page.ts`.

## Not designed yet

Their native calls are counted; their files have not been read line by line.

| Part | Size |
|---|---|
| `demos/native-tabs` on `main` | 2,004 lines, 3 files with FFI, 6 `JSCallback`s |
| `v1-drafting`: URL schemes and single instance | 431 lines |
| `v1-drafting`: clipboard | 98 lines |
| `v1-drafting`: WinRT toast notifications | 398 lines |
| `v1-drafting`: screen information | 316 lines |
| `v1-drafting`: tabs as library API | 1,763 lines |
| Linux | none exists |

Each is designed at its own step by the same method: what provides each behaviour, its N-API functions, its module map row.

## Order of work

1. Binding skeleton on `napi`, `tao` and `wry`; CI producing the binaries. Proves two mechanisms: a JavaScript function called from the page while `run()` blocks, and a tray-only app with no window receiving clicks under the timer-pumped loop on Windows and macOS. Accepted by the bindings' `examples/basic.ts`, `examples/bind.ts` and `demos/menubar-only`.
2. The `Webview` API on `wry`: assets, background colour, bind, the request handler. Accepted by the parts of `test/request-handler.test.ts` that cover them.
3. The `wry` fork additions: streaming, request source kinds, drag routing, top-level-only IPC. Accepted by the rest of `test/request-handler.test.ts`, unchanged.
4. Input hooks and permissions. Accepted by the ported key-code tests and `examples/input-hooks.ts`.
5. Windows, overlays, hit regions. Accepted by `demos/web-app` and `demos/desktop-pet`.
6. Tray, menus, notifications, folder dialog, app menu, app icon. Accepted by `demos/menubar-notify`.
7. Native tabs. Accepted by `demos/native-tabs`.
8. The gate: every check in this document passes on Windows and macOS, and the owner's games run on the Rust library. Only then are the TypeScript FFI, the bindings package and the dependency on the C++ fork deleted.
9. The `v1-drafting` features, one at a time.
10. Tauri 2 and Electron IPC transports: page code identical across webview, WebSocket, Tauri 2 and Electron.
11. Linux.

## Risks and actions

| Risk | Action |
|---|---|
| A JavaScript function called from native code while the UI thread is inside the loop does not behave under Bun's N-API as it does under `bun:ffi` | Step 1 proves it before anything else is built. |
| `tao`'s `run_return` under a Bun timer does not deliver tray events with no window | Step 1 proves it with `demos/menubar-only`. The fix belongs in the pump function, which then dequeues OS events itself with `windows` and `objc2`, the calls today's `pumpEvents` makes. |
| A rebuilt module behaves differently from today. Every game-critical path is re-implemented under this proposal, so each one can differ | Each is accepted against its existing tests and demo. The current stack stays the shipping one until the gate in step 8 is passed. |
| The forks of `wry` and `tray-icon` drift from upstream | Each addition is one commit on top of a pinned upstream version, and is offered upstream. |
| `unsafe` spreads | `#![forbid(unsafe_code)]` on every Sweetview module outside `platform`. CI counts `unsafe` blocks and fails when the count rises without an entry in a tracked list. |

## Alternatives ruled out

| Option | Why not |
|---|---|
| Keep the C++ webview engine | It stays memory-unsafe C++ |
| Port each OS call to Rust by hand with `windows` and `objc2` only | Every OS call becomes an `unsafe` block; the safe crates already wrap most of them |
| Keep the TypeScript FFI | No compiler checks on any native call |
| `webviewjs/webview` | Its tray does not deliver events without a window; no check marks or icons in menus; one maintainer |
| Electrobun | own CLI and toolchain, no `bun build --compile`, IPC over a localhost WebSocket; excluded by the project owner |
| Tauri 2 directly | app developers must write Rust and use Tauri's tooling |

## What was read

- `n0t-invented-here/sweetview-webview-bun`, branch `v1-drafting`: every file in `src/`, the README, every page in `docs/`, `scripts/build.ts`, the justfile.
- `n0t-invented-here/sweetview-webview`, branch `v1-drafting`: every page in `sweetview/`; the full diff against upstream `f1a9d6b` of `engine_base.hh`, `win32_edge.hh` and `cocoa_webkit.hh`; `input_hooks.hh`.
- This repository on `main`: `README.md`, `docs/app.md`, `docs/native.md`, `docs/webview-library.md`, `src/app.ts`, `src/worker.ts`, `src/webview-lib.ts`, `src/ring.ts`, and every file under `src/native/` except `icon.ts` and `hit-regions.ts`.
- docs.rs pages of `tao` 0.38.0 (`Window`, `WindowBuilder`, `WindowBuilderExtWindows`, `EventLoopExtRunReturn`), `wry` 0.58.2 (`WebViewBuilder`), `muda` 0.22.0 and `tray-icon` 0.27.0 (crate pages).

## Sources

- https://docs.rs/tao/latest/tao/window/struct.Window.html
- https://docs.rs/tao/latest/tao/window/struct.WindowBuilder.html
- https://docs.rs/tao/latest/x86_64-pc-windows-msvc/tao/platform/windows/trait.WindowBuilderExtWindows.html
- https://docs.rs/tao/latest/tao/platform/run_return/trait.EventLoopExtRunReturn.html
- https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html
- https://docs.rs/muda/latest/muda/
- https://docs.rs/tray-icon/latest/tray_icon/
- https://github.com/napi-rs/napi-rs
- https://github.com/microsoft/windows-rs
- https://github.com/madsmtm/objc2
- https://bun.com/docs/api/node-api
- https://bun.com/docs/compiler/executables
