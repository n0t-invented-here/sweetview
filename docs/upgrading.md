# Upgrading to Sweetview 1.0

This page is for developers moving an application to this version of
Sweetview, whose native layer is Rust reached through N-API instead of
TypeScript calling the operating system through `bun:ffi`. It maps every
export of the earlier API surfaces to what an application writes now, one
table row per export, and lists the steps and the behaviour changes an
application notices.

Three kinds of application upgrade here. Find yours, follow its steps, then
look up each import in its part:

- **A.** On the published `@n1h/sweetview` 0.1.x or 0.2.x, with `@n1h/sweetview-webview-bun` 2.x. See [Part A](#part-a-published-0x-packages).
- **B.** On the `v1-drafting` API: `@n1h/sweetview` 1.0.0 and its workspace packages as they were before the native layer moved to Rust (tag `pre-rust-rewrite` of `n0t-invented-here/sweetview`). See [Part B](#part-b-the-v1-drafting-api).
- **C.** Importing the bindings package `@n1h/sweetview-webview-bun` directly (2.x, `n0t-invented-here/sweetview-webview-bun`). See [Part C](#part-c-the-bindings-package).

An application can be more than one kind: a B application that also imports
the input hooks from the bindings package follows the steps of B and of C.

## Reading the tables

Each row has three columns:

- **Old**: the name the application imported, from the entry point the
  section names. A member row names the member (`maximized()`).
- **Write now**: code. The first span is the import. The spans after it say
  what to use: `name(…)` is a function, `new Name(…)` a class,
  `Name.member` a static member or a property of an object, `Name#member` a
  member of an instance, and `Name === value` a constant's value. A row
  whose first span is `import { dlopen } from "bun:ffi"`, followed by
  `dlopen("name.dll", { … })`, means the application declares its own
  `bun:ffi` table for its own calls. A row whose span starts with `type` is a
  declaration the application keeps in its own code.
- **Change**: what is different, in a few words. `unchanged` means the
  import and the call stay as they are.

Every row is run by `rust-rewrite/compat/upgrade-guide.test.ts`, which reads
this page: it imports each new form and checks that it is what the row says.

## What changed for every application

- **The end of the application.** The teardown lines an older application
  has after its loop (`notifier.dispose()`, `tray.dispose()`,
  `app.dispose()`, `win.dispose()`, `lock.dispose()`, `process.exit(0)`)
  are no longer needed, and are harmless
  if left: `dispose()` is idempotent and nothing is released twice. When the
  process ends (the script ends, `process.exit`, an uncaught exception),
  Sweetview releases what it made that is still alive, and a webview's worker
  no longer keeps the process alive, so it ends by itself with the exit code
  the application set. Nothing an application made is taken from it while it
  runs: code after `run()` and a second `run()` keep every tray, notifier,
  window and lock, and notifications it showed stay for the user to read. A
  timer or server of the application's own still keeps the process running
  after Quit: `unref()` or clear it ([the end of the application](app.md#the-end-of-the-application)).
  On macOS, until the macOS goal of the rewrite, keep those lines: macOS still
  runs the code it ran before 1.0, which releases nothing at exit.
- **The engine on Windows.** The webview is WebView2 driven by Rust (`wry`
  and Sweetview's own additions), and windows, the tray, menus, dialogs,
  notifications, input hooks and the event loop are Rust too. The native
  code is one file per target in `@n1h/sweetview-native`:
  `prebuilt/sweetview.win32-x64-msvc.node`. It is loaded with `require`, so
  `bun build --compile` embeds it in the executable. On Windows the package
  `@n1h/sweetview-webview-bun` is not needed and never loaded. On macOS it is
  still the engine until the macOS goal of the rewrite.
- **The macOS engine and the Windows executable.** An application that also
  builds for macOS keeps `@n1h/sweetview-webview-bun` installed. Its Windows
  executable does not contain it: the native package imports it only when
  `process.platform` is `"darwin"`, which `bun build --compile` decides from
  `--target`, so `--target=bun-windows-x64` leaves the package's sources and
  its native library out, and `--target=bun-darwin-arm64` keeps them. No
  build flag is needed.
- **Closing a window.** A close request (the frame's X, Alt+F4) on a
  `Window` with no `onClose` listener disposes the window. When that window is
  a single-window `createApp` app's, disposing it ends `run()`, even while
  another window of the application is visible; a tabbed app's loop
  (`runEventLoop`) ends only when no other window is visible. In 0.x the window of
  `createOverlayWindow` hid itself instead. A listener keeps the window open
  and decides; to hide it as before, pass
  `createApp({ …, onClose: () => app.window.hide() })` or
  `new Window({ …, onClose: () => win.hide() })`, and quit from your own menu
  (`app.quit()`, `quitEventLoop()`).
- **Showing and sizing a window.** `createApp` and `new Window` make the
  window hidden: call `app.window.show()` once it is wired, or pass
  `showOnReady: true`. (0.x's `createWebviewApp` without `window` showed the
  library's window at once.) `bounds` is the outer frame in physical pixels,
  320 x 240 centred on the primary work area by default; 0.x's `width` and
  `height` were the page's client size in DIPs, 1100 x 800 by default. See
  the [`width` row](#webviewappoptions-members-that-changed).
- **Environment variables.** `WEBVIEW_PATH`, which named a custom build of
  the C++ webview library, has no effect on Windows. `SWEETVIEW_NATIVE_PATH`
  names a custom build of the Rust binding (a `.node` file); it is read once,
  when the binding first loads, and a file that cannot be loaded throws
  `sweetview: the native binding could not be loaded from <path> (SWEETVIEW_NATIVE_PATH): <reason>`.
- **Handles.** `Window.handle` and `Webview.unsafeWindowHandle` are still
  the real `HWND` (the `NSWindow` pointer on macOS), for your own native
  calls. `Webview.unsafeHandle` is an opaque number that names the webview to
  the worker functions (`completeWebviewRequest` and the streaming ones) and
  to `new Webview(handle)`; it is not a pointer, so do not pass it to
  `bun:ffi`. The third argument of `bindRaw` is any value, handed back to the
  callback as it is.
- **Enums.** `SizeHint`, `MouseEvent`, `KeyEvent`, `Modifier`, `Feature` and
  `Permission` are ordinary `enum`s. They were `const enum`s, which exist only
  at compile time; now their members are values at run time too
  (`Object.values(MouseEvent)`, `SizeHint[3]`).
- **Errors and threads.** The UI thread is the thread that loads the binding
  first, which is Bun's main thread. `Clipboard.*` and `singleInstance`
  called from a `Worker` throw `sweetview: this call must be made on the UI thread`.
  `Window.fromHandle(h)` with an `h` that names no window throws
  `sweetview: not a window: 0x…` (it used to wrap it silently), and
  subscribing to events (`onClose`, `onResize`, `onMove`, `onFileDrop`) on a
  wrapper of a window that belongs to another thread throws
  `sweetview: a window of another thread cannot be observed`.
- **Window styles.** A frameless `Window` (`frame: false`) no longer has
  `WS_POPUP` in `GWL_STYLE`: it is an undecorated top-level window. An
  application that reads the style itself sees the difference;
  `Window.fromHandle` of Sweetview's own frameless window still reports it as
  frameless. A window moved to a monitor with another DPI is rescaled by the
  standard `WM_DPICHANGED` handling.
- **Menus, the tray and the folder dialog.** A popup menu chooses an item
  on a left or right click or from the keyboard, as before. The tray menu
  opens upward from the cursor, as before. `Menu.popup` opens a menu
  downward from its point and has no option to open upward; a menu of your
  own that opens upward from the cursor, as the tray's does, is
  `popupMenuAtCursor` of `@n1h/sweetview-native/win32/menu`, as it was in
  0.x. Menu item icons are drawn at 16 px. Tray
  click handlers run one loop turn after the click. A tray icon that is not a
  valid `.ico` throws `sweetview: the tray icon could not be decoded: …`.
  `pickFolder` returns `null` for a virtual folder such as "This PC" and when
  the dialog fails, where before it disabled OK or threw.
- **Notifications on Windows.** A `Notifier` shows a WinRT toast and needs
  no `Tray`. 0.x showed the balloon of the application's tray icon (and threw
  without a tray), which Windows shows under the name of the running
  executable. A toast is shown under the identity the notifier is given:
  `identity` (its `appId` and `appName`) or `appId`; with neither, under
  Sweetview's own, the id `Sweetview.DesktopApp` shown as "Sweetview". Pass
  the application's:
  `createNotifier({ identity: defineAppIdentity({ appId: "com.example.my-app", appName: "My App" }), onClick })`
  (`defineAppIdentity` is exported by `@n1h/sweetview/native`). The first
  toast registers the id under `HKCU\Software\Classes\AppUserModelId`. Each
  notifier gets the clicks of its own notifications, and a notification's
  default `id` is `sweetview-<n>` (it was `sweetnative-<n>`).
- **The WebView2 profile folder** is the same as before:
  `%APPDATA%\<exe file name>` (for example `%APPDATA%\bun.exe` under `bun`,
  or `%APPDATA%\my-app.exe` for a compiled executable), so cookies, storage
  and caches carry over. `WEBVIEW2_USER_DATA_FOLDER` still overrides it.
- **Your own `bun:ffi` calls keep working.** An application's own `dlopen`
  tables, including its own modal dialogs and popup menus, run inside
  Sweetview's event loop in both of its modes (the blocking `run()` and the
  loop pumped from a Bun timer by `runEventLoop`). Sweetview's own `bun:ffi`
  tables (`@n1h/sweetview-native/win32/api` and
  `@n1h/sweetview-native/win32/message-window`) were internal, and the
  package does not export those subpaths now: each of their exports has a
  row that names the public call that serves the same use, and for your own
  Win32 calls you declare your own `dlopen` table.

## Steps for each kind of application

### A. Published 0.1.x or 0.2.x

1. In `package.json`, move `@n1h/sweetview` to this version. On Windows,
   drop `@n1h/sweetview-webview-bun`; keep it (`^2.7.0`) for macOS (a Windows
   executable leaves it out by itself). Add, as dependencies of the application
   itself, `@n1h/sweetview-build` when a build recipe runs `make-app.ts` (or
   `refresh-icons.ts`) by path, and `@n1h/sweetview-native` when the
   application imports one of its subpaths (`@n1h/sweetview-native/win32/menu`,
   `/win32/window`, …): with Bun's isolated installs an application's
   `node_modules` holds only the packages it names, so a package that
   `@n1h/sweetview` depends on is not reachable from the application.
   Everything under `@n1h/sweetview` itself needs nothing more.
   Until 1.0.0 is on npm, install it from a Sweetview checkout: [Running an application against a local Sweetview checkout](local-checkout.md).
2. Replace `createWebviewApp(options)` with `createApp(options)` from
   `@n1h/sweetview`. It makes the window as well, and window options
   (`frame`, `transparent`, `topmost`, `icon`, …) go in the same object. What
   it returns is an `App`: `call` is `notify`, `windowHandle` is
   `app.window.handle`, `webview.raw` is the webview class.
3. Sizes: `width` and `height` were the page's client size in DIPs; `bounds`
   is the window's outer frame in physical pixels. Drop them when the window
   already has its bounds (an overlay made with `createOverlayWindow`'s
   `bounds`). To keep a page of `width` x `height` DIPs in a framed window,
   set it after `createApp`:
   `app.webview.raw.size = { width, height, hint: SizeHint.NONE }`
   (`SizeHint.FIXED` for a window that is not resizable).
4. Showing: the window is created hidden. Call `app.window.show()` once it
   is wired, or pass `showOnReady: true`.
5. Closing: a close request on a window with no `onClose` listener disposes
   it and ends `run()`. A window that hid on a close request, as
   `createOverlayWindow`'s did, passes
   `onClose: () => app.window.hide()` (or `onClose: () => win.hide()` on
   `new Window`).
6. Replace `nativeWindow(handle)` with `Window.fromHandle(handle)`, or use
   `app.window`; `onCloseRequest` is `onClose`.
7. An overlay: replace `makeOverlay` and `createOverlayWindow` with window
   options on `createApp` (or on `new Window(...)` and then
   `WebView.attach(win, options)`). `topmost`, `hideFromTaskbar` and
   `noActivate` default to `false` now, so an overlay names them:
   `createApp({ frame: false, transparent: true, topmost: true, hideFromTaskbar: true, noActivate: true, onClose: () => app.window.hide(), … })`.
   The screen questions the overlay answered (`cursor()`, `screen()`,
   `workArea()`, …) are on `Screen`.
8. Notifications: pass the application's identity, or its toasts show as
   "Sweetview":
   `createNotifier({ identity: defineAppIdentity({ appId: "com.example.my-app", appName: "My App" }), onClick })`.
   The tray no longer has to exist first.
9. A build recipe that ran `bun node_modules/@n1h/sweetview/src/make-app.ts …`
   runs `bun node_modules/@n1h/sweetview-build/src/make-app.ts …`, with the
   same flags ([Scripts run by path](#scripts-run-by-path)).
10. Renames: `dotIcon` is `dotIco`, `installAppMenu` is `setAppMenu`,
    `maximized()` is `isMaximized()`, `HitRelay.enabled()` is `isEnabled()`,
    the `close` option of `windowChromeMethods` is `onClose`, and a WebSocket
    host's or transport's `close()` is `dispose()`.
11. If you set `WEBVIEW_PATH`, set `SWEETVIEW_NATIVE_PATH` to a binding you
    built instead, or nothing to use the one in the package.
12. Check what an overlay application notices, in [What changed for every
    application](#what-changed-for-every-application): the opaque
    `unsafeHandle`, the error messages, the UI-thread checks, the frameless
    style.
13. Look up each remaining import in [Part A](#part-a-published-0x-packages).

### B. The `v1-drafting` API

1. In `package.json`, move the Sweetview packages to this version. On
   Windows, drop `@n1h/sweetview-webview-bun`; keep it (`^2.7.0`) for macOS
   (a Windows executable leaves it out by itself).
   `@n1h/sweetview-build` now depends on `@n1h/sweetview-native`, which the
   package manager installs with it; an application that imports
   `@n1h/sweetview-native` itself names it in its own dependencies.
   Until 1.0.0 is on npm, install it from a Sweetview checkout: [Running an application against a local Sweetview checkout](local-checkout.md).
2. The public entry points are unchanged: every export of every entry point
   still exists under the same name. Check the rows marked other than
   `unchanged` in [Part B](#part-b-the-v1-drafting-api).
3. Imports of Sweetview's internal modules by file path or by an internal
   subpath change: the `dlopen` helpers of `webview-lib.ts` are `RawWebview`
   methods, `win32/winrt-toast.ts` and `hiddenBalloonData` are `Notifier`,
   `colorRef` is the `colorKey` option, and every export of
   `@n1h/sweetview-native/win32/api` and `/win32/message-window` has a row
   naming its public call. For your own Win32 calls, declare your own
   `dlopen` table.
4. If you set `WEBVIEW_PATH`, set `SWEETVIEW_NATIVE_PATH` instead.
5. A worker you wrote against the internal init message (`InitMessage`)
   gets `wake` instead of `webviewHandle`, `drainCallbackPtr`, `drainToken`
   and `libPath`; `hostService` and `hostRequestHandler` handle it for you.
6. Check the behaviour changes in [What changed for every
   application](#what-changed-for-every-application).

### C. The bindings package, imported directly

1. In `package.json`, replace `@n1h/sweetview-webview-bun` with
   `@n1h/sweetview-native` (or with `@n1h/sweetview`, and import from
   `@n1h/sweetview/native`). On macOS keep `@n1h/sweetview-webview-bun`
   installed as well: `@n1h/sweetview-native` loads it there, and a Windows
   executable leaves it out ([What changed for every
   application](#what-changed-for-every-application)).
   Until 1.0.0 is on npm, install it from a Sweetview checkout: [Running an application against a local Sweetview checkout](local-checkout.md).
2. Change the module name in each import; every name is the same:
   `import { Webview, installMouseHook, permissions } from "@n1h/sweetview-native"`.
3. Treat `Webview.unsafeHandle` as an opaque number: pass it to
   `completeWebviewRequest` and the streaming functions, or to
   `new Webview(handle)`, and nowhere else. Calls you made on the library
   yourself through `bun:ffi` with that handle are `Webview` methods now.
4. The input-hook and permission enums are values now; code that inlined
   their numbers keeps working.
5. If you set `WEBVIEW_PATH`, set `SWEETVIEW_NATIVE_PATH` instead.
6. `unload()` destroys every live webview; there is no library to close.

## Part A: published 0.x packages

One table per entry point of `@n1h/sweetview` 0.1.x and 0.2.x. A name that
only one of the two versions exported says so. The member tables after them
cover old types and classes whose members have new names.

### `@n1h/sweetview`

| Old | Write now | Change |
|---|---|---|
| `Asset` | `import type { Asset } from "@n1h/sweetview"` | unchanged |
| `IndexHtmlOptions` | `import type { IndexHtmlOptions } from "@n1h/sweetview"` | unchanged |
| `Ring` | `import { Ring } from "@n1h/sweetview"`; `new Ring(sab)` | unchanged; it also has `dispatch` and `stopDispatch` |
| `SizeHint` | `import { SizeHint } from "@n1h/sweetview"`; `SizeHint.NONE === 0`; `SizeHint.MIN === 1`; `SizeHint.MAX === 2`; `SizeHint.FIXED === 3` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `UiMethods` | `import type { UiMethods } from "@n1h/sweetview"` | unchanged |
| `WEBVIEW_VERSION` | `import { WEBVIEW_VERSION } from "@n1h/sweetview"`; `WEBVIEW_VERSION === "0.12.0"` | unchanged |
| `Webview` | `import { RawWebview } from "@n1h/sweetview"`; `new RawWebview(debug, size, window)` | the same class as `RawWebview` (and as `Webview` from `@n1h/sweetview/native`); `unsafeHandle` is an opaque number (Part C) |
| `WebviewApp` | `import type { App } from "@n1h/sweetview"` | `createApp` returns an `App`; members in the table below |
| `WebviewAppOptions` | `import type { AppOptions } from "@n1h/sweetview"` | window options and webview options in one object; members in the table below |
| `WindowChromeInfo` | `import type { WindowChromeInfo } from "@n1h/sweetview"` | unchanged |
| `WindowChromeKind` | `import type { WindowChromeKind } from "@n1h/sweetview"` | unchanged |
| `WindowChromeMethodTable` | `import type { WindowChromeMethodTable } from "@n1h/sweetview"` | unchanged |
| `WindowChromeMethods` | `import type { WindowChromeMethods } from "@n1h/sweetview"` | unchanged |
| `WindowChromeOptions` | `import type { WindowChromeOptions } from "@n1h/sweetview"` | the `close` option is `onClose` |
| `assetMime` | `import { assetMime } from "@n1h/sweetview"`; `assetMime(…)` | unchanged |
| `createWebviewApp` | `import { createApp } from "@n1h/sweetview"`; `createApp(options)` | renamed; it makes the window too, so window options (`bounds`, `frame`, `transparent`, …) go in the same object; the window is created hidden (`app.window.show()`, or `showOnReady: true`), and a close request with no `onClose` listener disposes it and ends `run()`; `width` and `height` are in the table below |
| `indexHtml` | `import { indexHtml } from "@n1h/sweetview"`; `indexHtml({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' })` | unchanged |
| `indexHtmlText` | `import { indexHtmlText } from "@n1h/sweetview"`; `indexHtmlText({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' })` | unchanged |
| `windowChromeMethods` | `import { windowChromeMethods } from "@n1h/sweetview"`; `windowChromeMethods(window, options)` | takes the `Window`; the `close` option is `onClose` |
| `ActivationPolicy` (0.2.x only) | `import type { ActivationPolicy } from "@n1h/sweetview"` | unchanged |
| `EventLoopOptions` (0.2.x only) | `import type { EventLoopOptions } from "@n1h/sweetview"` | unchanged |
| `pumpEvents` (0.2.x only) | `import { pumpEvents } from "@n1h/sweetview"`; `pumpEvents()` | unchanged |
| `quitEventLoop` (0.2.x only) | `import { quitEventLoop } from "@n1h/sweetview"`; `quitEventLoop()` | unchanged |
| `runEventLoop` (0.2.x only) | `import { runEventLoop } from "@n1h/sweetview"`; `runEventLoop(options)` | unchanged |
| `setActivationPolicy` (0.2.x only) | `import { setActivationPolicy } from "@n1h/sweetview"`; `setActivationPolicy(policy)` | unchanged |

### `@n1h/sweetview/worker`

| Old | Write now | Change |
|---|---|---|
| `hostService` | `import { hostService } from "@n1h/sweetview/worker"`; `hostService(service)` | unchanged |

### `@n1h/sweetview/page`

| Old | Write now | Change |
|---|---|---|
| `isWebview` | `import { isWebview } from "@n1h/sweetview/page"`; `isWebview(…)` | unchanged |
| `webviewTransport` | `import { webviewTransport } from "@n1h/sweetview/page"`; `webviewTransport()` | unchanged |

### `@n1h/sweetview/build`

| Old | Write now | Change |
|---|---|---|
| `MacAppOptions` | `import type { MacAppOptions } from "@n1h/sweetview/build"` | unchanged |
| `makeMacApp` | `import { makeMacApp } from "@n1h/sweetview/build"`; `makeMacApp(options)` | unchanged |
| `writeIconFiles` | `import { writeIconFiles } from "@n1h/sweetview/build"`; `writeIconFiles(dir, files)` | unchanged |

### `@n1h/sweetview/settings-store`

| Old | Write now | Change |
|---|---|---|
| `SettingsStore` | `import { SettingsStore } from "@n1h/sweetview/settings-store"`; `new SettingsStore(…)` | a class now: `new SettingsStore(…)`; `createSettingsStore(options)` still returns one |
| `SettingsStoreOptions` | `import type { SettingsStoreOptions } from "@n1h/sweetview/settings-store"` | unchanged |
| `appDataDir` | `import { appDataDir } from "@n1h/sweetview/settings-store"`; `appDataDir(app)` | unchanged |
| `createSettingsStore` | `import { createSettingsStore } from "@n1h/sweetview/settings-store"`; `createSettingsStore(options)` | unchanged |

### `@n1h/sweetview/window-chrome`

| Old | Write now | Change |
|---|---|---|
| `ResizeHandle` | `import type { ResizeHandle } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeControls` | `import type { WindowChromeControls } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeInfo` | `import type { WindowChromeInfo } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeKind` | `import type { WindowChromeKind } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeMethodTable` | `import type { WindowChromeMethodTable } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeMethods` | `import type { WindowChromeMethods } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeOptions` | `import type { WindowChromeOptions } from "@n1h/sweetview/window-chrome"` | the `close` option is `onClose` |
| `resizeHandles` | `import { resizeHandles } from "@n1h/sweetview/window-chrome"`; `resizeHandles(thickness)` | unchanged |
| `windowChromeControls` | `import { windowChromeControls } from "@n1h/sweetview/window-chrome"`; `windowChromeControls(transport)` | unchanged |
| `windowChromeMethods` | `import { windowChromeMethods } from "@n1h/sweetview/window-chrome"`; `windowChromeMethods(window, options)` | takes the `Window`; the `close` option is `onClose` |

### `@n1h/sweetview/ipc`

| Old | Write now | Change |
|---|---|---|
| `AnyEvent` | `import type { AnyEvent } from "@n1h/sweetview/ipc"` | unchanged |
| `Bridge` | `import type { Bridge } from "@n1h/sweetview/ipc"` | unchanged |
| `CallFrame` | `import type { CallFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `Ctx` | `import type { Ctx } from "@n1h/sweetview/ipc"` | unchanged |
| `Emit` | `import type { Emit } from "@n1h/sweetview/ipc"` | unchanged |
| `EventFrame` | `import type { EventFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `EventMap` | `import type { EventMap } from "@n1h/sweetview/ipc"` | unchanged |
| `Frame` | `import type { Frame } from "@n1h/sweetview/ipc"` | unchanged |
| `Handlers` | `import type { Handlers } from "@n1h/sweetview/ipc"` | unchanged |
| `MethodMap` | `import type { MethodMap } from "@n1h/sweetview/ipc"` | unchanged |
| `ReplyFrame` | `import type { ReplyFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `Service` | `import type { Service } from "@n1h/sweetview/ipc"` | unchanged |
| `ServiceDefinition` | `import type { ServiceDefinition } from "@n1h/sweetview/ipc"` | unchanged |
| `Session` | `import type { Session } from "@n1h/sweetview/ipc"` | unchanged |
| `SessionKind` | `import type { SessionKind } from "@n1h/sweetview/ipc"` | unchanged |
| `Transport` | `import type { Transport } from "@n1h/sweetview/ipc"` | unchanged |
| `TransportKind` | `import type { TransportKind } from "@n1h/sweetview/ipc"` | unchanged |
| `createBridge` | `import { createBridge } from "@n1h/sweetview/ipc"`; `createBridge(transport)` | unchanged |
| `defineService` | `import { defineService } from "@n1h/sweetview/ipc"`; `defineService(setup)` | unchanged |
| `memoryTransport` | `import { memoryTransport } from "@n1h/sweetview/ipc"`; `memoryTransport(service, session)` | unchanged |

### `@n1h/sweetview/ipc-ws`

| Old | Write now | Change |
|---|---|---|
| `WsData` | `import type { WsData } from "@n1h/sweetview/ipc-ws"` | unchanged |
| `WsHost` | `import type { WsHost } from "@n1h/sweetview/ipc-ws"` | `close()` is `dispose()` |
| `WsHostOptions` | `import type { WsHostOptions } from "@n1h/sweetview/ipc-ws"` | unchanged |
| `WsTransport` | `import type { WsTransport } from "@n1h/sweetview/ipc-ws"` | `close()` is `dispose()` |
| `wsHost` | `import { wsHost } from "@n1h/sweetview/ipc-ws"`; `wsHost(service, options)` | unchanged |
| `wsTransport` | `import { wsTransport } from "@n1h/sweetview/ipc-ws"`; `wsTransport(url)` | unchanged |
| `wsUrl` | `import { wsUrl } from "@n1h/sweetview/ipc-ws"`; `wsUrl(path)` | unchanged |

### `@n1h/sweetview/ipc-ws/server`

| Old | Write now | Change |
|---|---|---|
| `WsData` | `import type { WsData } from "@n1h/sweetview/ipc-ws/server"` | unchanged |
| `WsHost` | `import type { WsHost } from "@n1h/sweetview/ipc-ws/server"` | `close()` is `dispose()` |
| `WsHostOptions` | `import type { WsHostOptions } from "@n1h/sweetview/ipc-ws/server"` | unchanged |
| `wsHost` | `import { wsHost } from "@n1h/sweetview/ipc-ws/server"`; `wsHost(service, options)` | unchanged |

### `@n1h/sweetview/ipc-ws/client`

| Old | Write now | Change |
|---|---|---|
| `WsTransport` | `import type { WsTransport } from "@n1h/sweetview/ipc-ws/client"` | `close()` is `dispose()` |
| `wsTransport` | `import { wsTransport } from "@n1h/sweetview/ipc-ws/client"`; `wsTransport(url)` | unchanged |
| `wsUrl` | `import { wsUrl } from "@n1h/sweetview/ipc-ws/client"`; `wsUrl(path)` | unchanged |

### `@n1h/sweetview/native`

| Old | Write now | Change |
|---|---|---|
| `AppMenuOptions` | `import type { AppMenuOptions } from "@n1h/sweetview/native"` | unchanged |
| `DecodedPng` | `import type { DecodedPng } from "@n1h/sweetview/native"` | unchanged |
| `DotIconOptions` | `import type { DotIconOptions } from "@n1h/sweetview/native"` | unchanged |
| `HitPolygon` | `import type { HitPolygon } from "@n1h/sweetview/native"` | unchanged |
| `HitProbe` | `import type { HitProbe } from "@n1h/sweetview/native"` | unchanged |
| `HitRefiner` | `import type { HitRefiner } from "@n1h/sweetview/native"` | unchanged |
| `HitRelay` | `import { HitRelay } from "@n1h/sweetview/native"`; `new HitRelay(…)` | a class now: `new HitRelay(…)`; `createHitRelay(window, probe)` still returns one; `enabled()` is `isEnabled()` |
| `Icon` | `import type { Icon } from "@n1h/sweetview/native"` | unchanged |
| `MenuItem` | `import type { MenuItem } from "@n1h/sweetview/native"` | unchanged |
| `MenuSource` | `import type { MenuSource } from "@n1h/sweetview/native"` | unchanged |
| `MenuTemplate` | `import type { MenuTemplate } from "@n1h/sweetview/native"` | unchanged |
| `NativeWindow` | `import { Window } from "@n1h/sweetview/native"`; `Window.fromHandle(handle)` | a `Window` (`app.window` for a window of `createApp`); members in the table below |
| `NotificationOptions` | `import type { NotificationOptions } from "@n1h/sweetview/native"` | the same fields; the default `id` is `sweetview-<n>` (it was `sweetnative-<n>`) |
| `Notifier` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(…)` | a class now: `new Notifier(…)`; `createNotifier(options)` still returns one; Windows: a toast under the notifier's `identity` or `appId`, Sweetview's own without them (see `createNotifier`) |
| `NotifierOptions` | `import type { NotifierOptions } from "@n1h/sweetview/native"` | new `identity` and `appId`, the Windows toast identity: pass `identity` for toasts under the application's own name; 0.1.x: `onClick` is called with `{ id, data }` of the clicked notification |
| `Overlay` | `import { Window } from "@n1h/sweetview/native"`; `new Window(options)` | a `Window`; members in the table below; a close request disposes it unless an `onClose` listener keeps it (`onClose: () => win.hide()` is what the overlay window did) |
| `OverlayOptions` | `import type { WindowOptions } from "@n1h/sweetview/native"`; `WindowOptions#topmost`; `WindowOptions#hideFromTaskbar`; `WindowOptions#noActivate` | the same option names; `topmost`, `hideFromTaskbar` and `noActivate` default to `false` now, so name them |
| `OverlayWindowOptions` | `import type { WindowOptions } from "@n1h/sweetview/native"`; `WindowOptions#frame`; `WindowOptions#appearance` | the same option names but `dark` (use `appearance`); members in the table below; a `frame: true` window's close button disposes it now, where it hid it: pass `onClose: () => win.hide()` |
| `Point` | `import type { Point } from "@n1h/sweetview/native"` | unchanged |
| `Rect` | `import type { Rect } from "@n1h/sweetview/native"` | unchanged |
| `ResizeEdge` | `import type { ResizeEdge } from "@n1h/sweetview/native"` | unchanged |
| `Tray` | `import { Tray } from "@n1h/sweetview/native"`; `new Tray(…)` | a class now: `new Tray(…)`; `createTray(options)` still returns one |
| `TrayIcon` | `import type { TrayIcon } from "@n1h/sweetview/native"` | unchanged |
| `TrayOptions` | `import type { TrayOptions } from "@n1h/sweetview/native"` | unchanged |
| `WindowHandle` | `import type { WindowHandle } from "@n1h/sweetview/native"` | unchanged |
| `convexHull` | `import { convexHull } from "@n1h/sweetview/native"`; `convexHull(points)` | unchanged |
| `createHitRelay` | `import { createHitRelay } from "@n1h/sweetview/native"`; `createHitRelay(window, probe)` | takes the `Window` (anything with `setHitRegions`) |
| `createNotifier` | `import { createNotifier } from "@n1h/sweetview/native"`; `createNotifier(options)` | Windows: it needs no tray (it threw without one) and shows a WinRT toast, where it showed the balloon of the tray's icon, which Windows shows under the running executable's name; the toast is under `identity` (or `appId`), and with neither under Sweetview's own, shown as "Sweetview": pass `createNotifier({ identity: defineAppIdentity({ appId: "com.example.my-app", appName: "My App" }), onClick })`; each notifier gets the clicks of its own notifications |
| `createOverlayWindow` | `import { Window } from "@n1h/sweetview/native"`; `new Window(options)` | pass `frame: false, topmost: true, hideFromTaskbar: true, noActivate: true` (their old defaults), and `onClose: () => win.hide()`: its window hid on a close request, and a `Window` with no `onClose` listener is disposed; host the page with `WebView.attach(win, options)` |
| `createTray` | `import { createTray } from "@n1h/sweetview/native"`; `createTray(options)` | unchanged |
| `decodePng` | `import { decodePng } from "@n1h/sweetview/native"`; `decodePng(bytes)` | unchanged |
| `dotIcns` | `import { dotIcns } from "@n1h/sweetview/native"`; `dotIcns(opts)` | unchanged |
| `dotIcon` | `import { dotIco } from "@n1h/sweetview/native"`; `dotIco(opts)` | renamed |
| `dotPng` | `import { dotPng } from "@n1h/sweetview/native"`; `dotPng(size, opts)` | unchanged |
| `encodeIcns` | `import { encodeIcns } from "@n1h/sweetview/native"`; `encodeIcns(images)` | unchanged |
| `encodeIco` | `import { encodeIco } from "@n1h/sweetview/native"`; `encodeIco(images)` | unchanged |
| `encodePng` | `import { encodePng } from "@n1h/sweetview/native"`; `encodePng(size, rgba)` | unchanged |
| `flattenRegions` | `import { flattenRegions } from "@n1h/sweetview/native"`; `flattenRegions(polygons)` | unchanged |
| `hitRegions` | `import { hitRegions } from "@n1h/sweetview/native"`; `hitRegions(packed, x, y)` | unchanged |
| `icnsFromPng` | `import { icnsFromPng } from "@n1h/sweetview/native"`; `icnsFromPng(png, sizes)` | unchanged |
| `icnsFromRgba` | `import { icnsFromRgba } from "@n1h/sweetview/native"`; `icnsFromRgba(size, rgba, sizes)` | unchanged |
| `icoFromPng` | `import { icoFromPng } from "@n1h/sweetview/native"`; `icoFromPng(png, sizes)` | unchanged |
| `icoFromRgba` | `import { icoFromRgba } from "@n1h/sweetview/native"`; `icoFromRgba(size, rgba, sizes)` | unchanged |
| `installAppMenu` | `import { setAppMenu } from "@n1h/sweetview/native"`; `setAppMenu(options)` | renamed |
| `makeOverlay` | `import { createApp } from "@n1h/sweetview"`; `createApp(options)` | the overlay is made with its page: `createApp({ frame: false, transparent: true, topmost: true, hideFromTaskbar: true, noActivate: true, … })`; a close request (Alt+F4) disposes it and ends `run()`, as the webview's own window it restyled did; to hide it instead, as an overlay made with `createOverlayWindow` did, add `onClose: () => app.window.hide()` |
| `nativeWindow` | `import { Window } from "@n1h/sweetview/native"`; `Window.fromHandle(handle)` | wraps a window by handle; for a window of `createApp` use `app.window` |
| `packRegions` | `import { packRegions } from "@n1h/sweetview/native"`; `packRegions(polygons)` | unchanged |
| `pickFolder` | `import { pickFolder } from "@n1h/sweetview/native"`; `pickFolder(owner, title)` | unchanged; `owner` may be a `Window` or a handle |
| `renderDot` | `import { renderDot } from "@n1h/sweetview/native"`; `renderDot(size, opts)` | unchanged |
| `resolveMenu` | `import { resolveMenu } from "@n1h/sweetview/native"`; `resolveMenu(…)` | unchanged |
| `setAppIcon` | `import { setAppIcon } from "@n1h/sweetview/native"`; `setAppIcon(icon)` | unchanged |
| `trimTransparent` | `import { trimTransparent } from "@n1h/sweetview/native"`; `trimTransparent(image, margin, threshold)` | unchanged |
| `unpackRegions` | `import { unpackRegions } from "@n1h/sweetview/native"`; `unpackRegions(flat)` | unchanged |
| `ActivationPolicy` (0.2.x only) | `import type { ActivationPolicy } from "@n1h/sweetview/native"` | unchanged |
| `Appearance` (0.2.x only) | `import type { Appearance } from "@n1h/sweetview/native"` | unchanged |
| `EventLoopOptions` (0.2.x only) | `import type { EventLoopOptions } from "@n1h/sweetview/native"` | unchanged |
| `NotificationClick` (0.2.x only) | `import type { NotificationClick } from "@n1h/sweetview/native"` | unchanged |
| `pumpEvents` (0.2.x only) | `import { pumpEvents } from "@n1h/sweetview/native"`; `pumpEvents()` | unchanged |
| `quitEventLoop` (0.2.x only) | `import { quitEventLoop } from "@n1h/sweetview/native"`; `quitEventLoop()` | unchanged |
| `runEventLoop` (0.2.x only) | `import { runEventLoop } from "@n1h/sweetview/native"`; `runEventLoop(options)` | unchanged |
| `setActivationPolicy` (0.2.x only) | `import { setActivationPolicy } from "@n1h/sweetview/native"`; `setActivationPolicy(policy)` | unchanged |

### `@n1h/sweetview/native/hit-regions`

| Old | Write now | Change |
|---|---|---|
| `HitPolygon` | `import type { HitPolygon } from "@n1h/sweetview/native/hit-regions"` | unchanged |
| `HitProbe` | `import type { HitProbe } from "@n1h/sweetview/native/hit-regions"` | unchanged |
| `HitRelay` | `import { HitRelay } from "@n1h/sweetview/native/hit-regions"`; `new HitRelay(…)` | a class now: `new HitRelay(…)`; `createHitRelay(window, probe)` still returns one; `enabled()` is `isEnabled()` |
| `convexHull` | `import { convexHull } from "@n1h/sweetview/native/hit-regions"`; `convexHull(points)` | unchanged |
| `createHitRelay` | `import { createHitRelay } from "@n1h/sweetview/native/hit-regions"`; `createHitRelay(window, probe)` | takes the `Window` (anything with `setHitRegions`) |
| `flattenRegions` | `import { flattenRegions } from "@n1h/sweetview/native/hit-regions"`; `flattenRegions(polygons)` | unchanged |
| `hitRegions` | `import { hitRegions } from "@n1h/sweetview/native/hit-regions"`; `hitRegions(packed, x, y)` | unchanged |
| `packRegions` | `import { packRegions } from "@n1h/sweetview/native/hit-regions"`; `packRegions(polygons)` | unchanged |
| `unpackRegions` | `import { unpackRegions } from "@n1h/sweetview/native/hit-regions"`; `unpackRegions(flat)` | unchanged |

### `@n1h/sweetview-webview-bun` 2.x, as a 0.x application imports it

The same names come from `@n1h/sweetview/native` now. Part C has the details of each.

| Old | Write now | Change |
|---|---|---|
| `Feature` | `import { Feature } from "@n1h/sweetview/native"`; `Feature.MouseHook === 0`; `Feature.KeyboardHook === 1` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `KeyEvent` | `import { KeyEvent } from "@n1h/sweetview/native"`; `KeyEvent.Down === 0`; `KeyEvent.Up === 1`; `KeyEvent.Repeat === 2` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `KeyHandler` | `import type { KeyHandler } from "@n1h/sweetview/native"` | unchanged |
| `KeyMessage` | `import type { KeyMessage } from "@n1h/sweetview/native"` | unchanged |
| `KeyboardHook` | `import type { KeyboardHook } from "@n1h/sweetview/native"` | unchanged |
| `Modifier` | `import { Modifier } from "@n1h/sweetview/native"`; `Modifier.Shift === 1`; `Modifier.Control === 2`; `Modifier.Alt === 4`; `Modifier.Meta === 8` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `Modifiers` | `import type { Modifiers } from "@n1h/sweetview/native"` | unchanged |
| `MouseEvent` | `import { MouseEvent } from "@n1h/sweetview/native"`; `MouseEvent.Move === 0`; `MouseEvent.LeftDown === 1`; `MouseEvent.LeftUp === 2`; `MouseEvent.RightDown === 3`; `MouseEvent.RightUp === 4`; `MouseEvent.MiddleDown === 5`; `MouseEvent.MiddleUp === 6`; `MouseEvent.Wheel === 7` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `MouseHandler` | `import type { MouseHandler } from "@n1h/sweetview/native"` | unchanged |
| `MouseHook` | `import type { MouseHook } from "@n1h/sweetview/native"` | unchanged |
| `MouseMessage` | `import type { MouseMessage } from "@n1h/sweetview/native"` | unchanged |
| `Permission` | `import { Permission } from "@n1h/sweetview/native"`; `Permission.DeviceControl === 1`; `Permission.InputMonitoring === 2` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `PermissionStatus` | `import type { PermissionStatus } from "@n1h/sweetview/native"` | unchanged |
| `Size` | `import type { Size } from "@n1h/sweetview/native"` | unchanged |
| `SizeHint` | `import { SizeHint } from "@n1h/sweetview/native"`; `SizeHint.NONE === 0`; `SizeHint.MIN === 1`; `SizeHint.MAX === 2`; `SizeHint.FIXED === 3` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `WEBVIEW_VERSION` | `import { WEBVIEW_VERSION } from "@n1h/sweetview/native"`; `WEBVIEW_VERSION === "0.12.0"` | unchanged |
| `Webview` | `import { Webview } from "@n1h/sweetview/native"`; `new Webview(debug, size, window)` | the same class; `unsafeHandle` is an opaque number (Part C, `Webview` members) |
| `installKeyboardHook` | `import { installKeyboardHook } from "@n1h/sweetview/native"`; `installKeyboardHook(handler)` | unchanged |
| `installMouseHook` | `import { installMouseHook } from "@n1h/sweetview/native"`; `installMouseHook(handler)` | unchanged |
| `modifiersFrom` | `import { modifiersFrom } from "@n1h/sweetview/native"`; `modifiersFrom(bits)` | unchanged |
| `permissions` | `import { permissions } from "@n1h/sweetview/native"` | unchanged |
| `unload` | `import { unload } from "@n1h/sweetview/native"`; `unload()` | destroys every live webview; there is no library to unload |

### Members

#### `WebviewApp` members (the result of `createWebviewApp`)

`createApp(options)` returns an `App`.

| Old | Write now | Change |
|---|---|---|
| `webview` | `import type { App } from "@n1h/sweetview"`; `App#webview` | a `WebView`; its `raw` is the `RawWebview` |
| `window` | `import type { App } from "@n1h/sweetview"`; `App#window` | a `Window` |
| `windowHandle` | `import { Window } from "@n1h/sweetview/native"`; `Window#handle` | `app.window.handle` |
| `emit(name, payload)` | `import type { App } from "@n1h/sweetview"`; `App#emit` | unchanged |
| `call(method, params)` | `import type { App } from "@n1h/sweetview"`; `App#notify` | renamed `notify` |
| `onEvent(fn)` | `import type { App } from "@n1h/sweetview"`; `App#onEvent` | unchanged |
| `run()` | `import type { App } from "@n1h/sweetview"`; `App#run` | unchanged; a close request ends it, as before, unless an `onClose` listener keeps the window |
| `quit()` | `import type { App } from "@n1h/sweetview"`; `App#quit` | unchanged |
| `dispose()` | `import type { App } from "@n1h/sweetview"`; `App#dispose` | unchanged |

#### `WebviewAppOptions` members that changed

Every other option (`page`, `title`, `assets`, `index`, `worker`, `debug`, `uiMethods`, `ringBytes`) keeps its name in `AppOptions`.

| Old | Write now | Change |
|---|---|---|
| `width` | `import type { AppOptions } from "@n1h/sweetview"`; `AppOptions#bounds` | not the same quantity: `width` was the page's client width in DIPs (1100 by default), which the library applied to the window, its own or the one given as `window`; `bounds: { x, y, width, height }` is the window's outer frame in physical pixels (320 by default). With `window`, drop it: the window already has its bounds (for a frameless overlay, the same size). To keep a page `width` DIPs wide in a framed window, set it after `createApp`: `app.webview.raw.size = { width, height, hint: SizeHint.NONE }` (`SizeHint.FIXED` for a window that is not resizable); it sizes the frame around that client area, as the library did, without moving or showing the window |
| `height` | `import type { AppOptions } from "@n1h/sweetview"`; `AppOptions#bounds` | not the same quantity: `height` was the page's client height in DIPs (800 by default); `bounds` is the outer frame in physical pixels (240 by default); drop it, or set the client size with `app.webview.raw.size`, as for `width` |
| `window` | `import { WebView } from "@n1h/sweetview"`; `WebView.attach(window, options)` | mount the page in a window you made: `WebView.attach(win, options)`; it keeps the window's size (the library resized it to `width` x `height`), and showing the window and what a close request does are yours, as before |
| `transparent` | `import type { AppOptions } from "@n1h/sweetview"`; `AppOptions#transparent` | a window option now; it makes the window and the page background transparent |
| `resizable` | `import type { AppOptions } from "@n1h/sweetview"`; `AppOptions#resizable` | a window option; defaults to `true` for a framed window (with `window` it defaulted to `false`) |

#### `NativeWindow` members (the result of `nativeWindow`)

`Window.fromHandle(handle)` or `app.window` gives a `Window`.

| Old | Write now | Change |
|---|---|---|
| `isVisible()` | `import { Window } from "@n1h/sweetview/native"`; `Window#isVisible()` | unchanged |
| `show()` | `import { Window } from "@n1h/sweetview/native"`; `Window#show()` | unchanged |
| `hide()` | `import { Window } from "@n1h/sweetview/native"`; `Window#hide()` | unchanged |
| `toggle()` | `import { Window } from "@n1h/sweetview/native"`; `Window#toggle()` | unchanged |
| `setIcon(icon)` | `import { Window } from "@n1h/sweetview/native"`; `Window#setIcon(icon)` | unchanged |
| `onCloseRequest(handler)` | `import { Window } from "@n1h/sweetview/native"`; `Window#onClose(handler)` | renamed `onClose`; returns the function that unsubscribes; listeners add up (a second call no longer replaces the first), and once none is left a close request disposes a window Sweetview made |

#### `Overlay` members (the result of `makeOverlay` and `createOverlayWindow`)

A `Window` has the window members; the screen questions are `Screen`'s.
The overlay window of `createOverlayWindow` hid itself on a close request
(its frame's X, Alt+F4); a `Window` with no `onClose` listener is disposed
instead, so pass `onClose: () => win.hide()` to keep the old behaviour.

| Old | Write now | Change |
|---|---|---|
| `handle` | `import { Window } from "@n1h/sweetview/native"`; `Window#handle` | unchanged |
| `show()` | `import { Window } from "@n1h/sweetview/native"`; `Window#show()` | unchanged; a `noActivate` window is shown without focus |
| `hide()` | `import { Window } from "@n1h/sweetview/native"`; `Window#hide()` | unchanged |
| `setIcon(icon)` | `import { Window } from "@n1h/sweetview/native"`; `Window#setIcon(icon)` | unchanged |
| `bounds()` | `import { Window } from "@n1h/sweetview/native"`; `Window#bounds()` | the outer frame |
| `moveTo(x, y)` | `import { Window } from "@n1h/sweetview/native"`; `Window#moveTo(x, y)` | unchanged |
| `resize(width, height)` | `import { Window } from "@n1h/sweetview/native"`; `Window#resize(width, height)` | unchanged |
| `setBounds(rect)` | `import { Window } from "@n1h/sweetview/native"`; `Window#setBounds(rect)` | unchanged |
| `setClickThrough(on)` | `import { Window } from "@n1h/sweetview/native"`; `Window#setClickThrough(on)` | unchanged |
| `setHitRegions(polygons, refine)` | `import { Window } from "@n1h/sweetview/native"`; `Window#setHitRegions(polygons, refine)` | unchanged |
| `setTopmost(on)` | `import { Window } from "@n1h/sweetview/native"`; `Window#setTopmost(on)` | unchanged |
| `startDrag()` | `import { Window } from "@n1h/sweetview/native"`; `Window#startDrag()` | unchanged |
| `startResize(edge)` | `import { Window } from "@n1h/sweetview/native"`; `Window#startResize(edge)` | unchanged |
| `minimize()` | `import { Window } from "@n1h/sweetview/native"`; `Window#minimize()` | unchanged |
| `toggleMaximize()` | `import { Window } from "@n1h/sweetview/native"`; `Window#toggleMaximize()` | unchanged |
| `maximized()` | `import { Window } from "@n1h/sweetview/native"`; `Window#isMaximized()` | renamed `isMaximized` |
| `scale()` | `import { Window } from "@n1h/sweetview/native"`; `Window#scale()` | unchanged |
| `cursor()` | `import { Screen } from "@n1h/sweetview/native"`; `Screen.cursor()` | on `Screen` |
| `screen()` | `import { Screen } from "@n1h/sweetview/native"`; `Screen.primary()` | `Screen.primary().bounds` |
| `screenAt(point)` | `import { Screen } from "@n1h/sweetview/native"`; `Screen.at(point)` | `Screen.at(point).bounds` |
| `workArea()` | `import { Screen } from "@n1h/sweetview/native"`; `Screen.primary()` | `Screen.primary().workArea` |
| `virtualScreen()` | `import { Screen } from "@n1h/sweetview/native"`; `Screen.bounds()` | on `Screen` |

#### `OverlayWindowOptions` and `OverlayOptions` members that changed

`title`, `bounds`, `frame`, `icon`, `transparent`, `colorKey` and `opacity` keep their names in `WindowOptions`.

| Old | Write now | Change |
|---|---|---|
| `dark` | `import type { WindowOptions } from "@n1h/sweetview/native"`; `WindowOptions#appearance` | `appearance: "dark"` |
| `topmost` | `import type { WindowOptions } from "@n1h/sweetview/native"`; `WindowOptions#topmost` | defaults to `false`; an overlay passes `true` |
| `hideFromTaskbar` | `import type { WindowOptions } from "@n1h/sweetview/native"`; `WindowOptions#hideFromTaskbar` | defaults to `false`; an overlay passes `true` |
| `noActivate` | `import type { WindowOptions } from "@n1h/sweetview/native"`; `WindowOptions#noActivate` | defaults to `false`; an overlay passes `true` |

#### `HitRelay` members

`HitRelay` is a class now; `createHitRelay(window, probe)` still makes one, given a `Window`.

| Old | Write now | Change |
|---|---|---|
| `setRegions(polygons)` | `import { HitRelay } from "@n1h/sweetview/native"`; `HitRelay#setRegions(polygons)` | unchanged |
| `answer(reply)` | `import { HitRelay } from "@n1h/sweetview/native"`; `HitRelay#answer` | unchanged (a bound function, so it can be passed on) |
| `setEnabled(on)` | `import { HitRelay } from "@n1h/sweetview/native"`; `HitRelay#setEnabled(on)` | unchanged |
| `enabled()` | `import { HitRelay } from "@n1h/sweetview/native"`; `HitRelay#isEnabled()` | renamed `isEnabled` |
| `apply()` | `import { HitRelay } from "@n1h/sweetview/native"`; `HitRelay#apply()` | unchanged |

#### Option and member renames in the page-side and IPC modules

These types keep their names; one member each changed.

| Old | Write now | Change |
|---|---|---|
| `WindowChromeOptions.close` | `import type { WindowChromeOptions } from "@n1h/sweetview/window-chrome"`; `WindowChromeOptions#onClose` | renamed `onClose` |
| `windowChromeMethods(overlay, options)` | `import { windowChromeMethods } from "@n1h/sweetview"`; `windowChromeMethods(window, options)` | takes a `Window` (anything with its `hide`, `isMaximized`, `startDrag`, `startResize`, `minimize`, `toggleMaximize`) |
| `WsHost.close()` | `import type { WsHost } from "@n1h/sweetview/ipc-ws"`; `WsHost#dispose` | renamed `dispose` |
| `WsTransport.close()` | `import type { WsTransport } from "@n1h/sweetview/ipc-ws"`; `WsTransport#dispose` | renamed `dispose` |
| `NotifierOptions.onClick` (0.1.x) | `import type { NotifierOptions } from "@n1h/sweetview/native"`; `NotifierOptions#onClick` | called with `{ id, data }` of the clicked notification (0.2.x already did) |
| `createHitRelay(overlay, probe)` | `import { createHitRelay } from "@n1h/sweetview/native"`; `createHitRelay(window, probe)` | takes the `Window` |

### Internal modules imported by file path

#### `src/webview-lib.ts`

The `dlopen` helpers opened the webview library. On Windows there is no library to open: use the `RawWebview` methods (`app.webview.raw`, or `new RawWebview(...)`). On macOS they move to `darwin-webview-lib.ts` until the macOS goal.

| Old | Write now | Change |
|---|---|---|
| `webviewLibPath` | `import { RawWebview } from "@n1h/sweetview"`; `new RawWebview(debug, size, window)` | no library path on Windows; `SWEETVIEW_NATIVE_PATH` names a binding you built yourself |
| `backgroundColorCall` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setBackgroundColor(r, g, b, a)` | a method |
| `SetBackgroundColor` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setBackgroundColor(r, g, b, a)` | a method |
| `setAssetCall` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setAsset(path, mime, data)` | a method |
| `SetAsset` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setAsset(path, mime, data)` | a method |
| `ASSET_ORIGIN` | `import { ASSET_ORIGIN } from "@n1h/sweetview"` | public: `http://webview.localhost` on Windows, `webview://localhost` on macOS |

#### `src/messages.ts`

What crosses `postMessage` between the UI thread and the worker. `hostService` and `hostRequestHandler` read it; an application does not build it.

| Old | Write now | Change |
|---|---|---|
| `InitMessage` | `import { hostService } from "@n1h/sweetview/worker"`; `hostService(service, options)` | internal; it carries `wake` now, instead of `webviewHandle`, `drainCallbackPtr`, `drainToken` and `libPath` |
| `WorkerMessage` | `import { hostService } from "@n1h/sweetview/worker"`; `hostService(service, options)` | internal |
| `WEBVIEW_SESSION` | `import type { Session } from "@n1h/sweetview/ipc"` | a handler's `ctx.session` is `{ id: "webview", kind: "webview" }` |

#### `src/native/event-loop.ts`, `src/native/win32/color-ref.ts`

The other `src/native/win32/*.ts` files map as `@n1h/sweetview-native/win32/*` does in Part B
(`popupMenuAtCursor` of `win32/menu.ts`, say, is the `@n1h/sweetview-native/win32/menu` row).
A row whose import is from `@n1h/sweetview-native` or one of its subpaths names a package a 0.x
application did not depend on: add `"@n1h/sweetview-native": "^1.0.0"` to the application's own
`dependencies`. With Bun's isolated installs an application's `node_modules` holds only the
packages it names, so the copy `@n1h/sweetview` depends on cannot be imported from the
application. A row whose import is from `@n1h/sweetview` or its subpaths needs nothing more.

| Old | Write now | Change |
|---|---|---|
| `discardQuit` | `import type { App } from "@n1h/sweetview"`; `App#dispose` | `app.dispose()` takes back the quit itself |
| `colorRef` | `import { Window } from "@n1h/sweetview/native"`; `new Window(options)` | pass `colorKey: "#rrggbb"` |

### Scripts run by path

The 0.x package shipped `src/make-app.ts`, which a build recipe ran by path
(`bun node_modules/@n1h/sweetview/src/make-app.ts …`). It is in the build
package now, `@n1h/sweetview-build`, with the same flags and a new
`--url-scheme` ([make-app command line](build.md#make-app-command-line));
`@n1h/sweetview` has no such file. The path exists only when the
application depends on `@n1h/sweetview-build` itself
(`"@n1h/sweetview-build": "^1.0.0"` in `dependencies`): with Bun's isolated
installs the copy `@n1h/sweetview` depends on is not in the application's
`node_modules`. The same holds for `src/refresh-icons.ts`, new in that
package (`bun node_modules/@n1h/sweetview-build/src/refresh-icons.ts`, on
Windows after a compile, refreshes Explorer's icon cache).

| Old | Write now | Change |
|---|---|---|
| `src/make-app.ts` | `import { makeMacApp } from "@n1h/sweetview-build"`; `makeMacApp(options)` | the script is `makeMacApp` as a command: run `bun node_modules/@n1h/sweetview-build/src/make-app.ts --name … --bundle-id … --binary … --out …` (it was `node_modules/@n1h/sweetview/src/make-app.ts`), with `@n1h/sweetview-build` in the application's own `dependencies` |

## Part B: the `v1-drafting` API

One table per entry point of the six workspace packages at tag
`pre-rust-rewrite`, internal subpaths included (`./internal`, `./win32/*`,
`./darwin/*`). An internal subpath export with a public equivalent names the
public call; one with no public equivalent is unchanged while the subpath
exports it.

### `@n1h/sweetview`

| Old | Write now | Change |
|---|---|---|
| `ASSET_ORIGIN` | `import { ASSET_ORIGIN } from "@n1h/sweetview"` | unchanged |
| `ActivationPolicy` | `import type { ActivationPolicy } from "@n1h/sweetview"` | unchanged |
| `App` | `import type { App } from "@n1h/sweetview"` | unchanged |
| `AppIdentity` | `import type { AppIdentity } from "@n1h/sweetview"` | unchanged |
| `AppIdentityInput` | `import type { AppIdentityInput } from "@n1h/sweetview"` | unchanged |
| `AppOptions` | `import type { AppOptions } from "@n1h/sweetview"` | unchanged |
| `Asset` | `import type { Asset } from "@n1h/sweetview"` | unchanged |
| `EventLoopOptions` | `import type { EventLoopOptions } from "@n1h/sweetview"` | unchanged |
| `FRAMES_ORIGIN` | `import { FRAMES_ORIGIN } from "@n1h/sweetview"` | unchanged |
| `IndexHtmlOptions` | `import type { IndexHtmlOptions } from "@n1h/sweetview"` | unchanged |
| `NativeRequest` | `import type { NativeRequest } from "@n1h/sweetview"` | unchanged |
| `NativeResponse` | `import type { NativeResponse } from "@n1h/sweetview"` | unchanged |
| `RawWebview` | `import { RawWebview } from "@n1h/sweetview"`; `new RawWebview(debug, size, window)` | the same class, from `@n1h/sweetview-native` now; `unsafeHandle` is an opaque number (Part C, `Webview` members) |
| `RegisterUrlSchemeOptions` | `import type { RegisterUrlSchemeOptions } from "@n1h/sweetview"` | unchanged |
| `Ring` | `import { Ring } from "@n1h/sweetview"`; `new Ring(sab)` | unchanged |
| `SecondInstanceEvent` | `import type { SecondInstanceEvent } from "@n1h/sweetview"` | unchanged |
| `SingleInstanceLock` | `import type { SingleInstanceLock } from "@n1h/sweetview"` | unchanged |
| `SingleInstanceOptions` | `import type { SingleInstanceOptions } from "@n1h/sweetview"` | unchanged |
| `SizeHint` | `import { SizeHint } from "@n1h/sweetview"`; `SizeHint.NONE === 0`; `SizeHint.MIN === 1`; `SizeHint.MAX === 2`; `SizeHint.FIXED === 3` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `Tab` | `import type { Tab } from "@n1h/sweetview"` | unchanged |
| `TabOptions` | `import type { TabOptions } from "@n1h/sweetview"` | unchanged |
| `UiMethods` | `import type { UiMethods } from "@n1h/sweetview"` | unchanged |
| `WEBVIEW_VERSION` | `import { WEBVIEW_VERSION } from "@n1h/sweetview"`; `WEBVIEW_VERSION === "0.12.0"` | unchanged |
| `WebView` | `import { WebView } from "@n1h/sweetview"`; `WebView.attach(…)` | unchanged |
| `WebViewOptions` | `import type { WebViewOptions } from "@n1h/sweetview"` | unchanged |
| `WindowChromeInfo` | `import type { WindowChromeInfo } from "@n1h/sweetview"` | unchanged |
| `WindowChromeKind` | `import type { WindowChromeKind } from "@n1h/sweetview"` | unchanged |
| `WindowChromeMethodTable` | `import type { WindowChromeMethodTable } from "@n1h/sweetview"` | unchanged |
| `WindowChromeMethods` | `import type { WindowChromeMethods } from "@n1h/sweetview"` | unchanged |
| `WindowChromeOptions` | `import type { WindowChromeOptions } from "@n1h/sweetview"` | unchanged |
| `assetMime` | `import { assetMime } from "@n1h/sweetview"`; `assetMime(…)` | unchanged |
| `createApp` | `import { createApp } from "@n1h/sweetview"`; `createApp(options)` | unchanged |
| `defineAppIdentity` | `import { defineAppIdentity } from "@n1h/sweetview"`; `defineAppIdentity(input)` | unchanged |
| `extractUrlFromArgs` | `import { extractUrlFromArgs } from "@n1h/sweetview"`; `extractUrlFromArgs(args, schemes)` | unchanged |
| `indexHtml` | `import { indexHtml } from "@n1h/sweetview"`; `indexHtml({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' })` | unchanged |
| `indexHtmlText` | `import { indexHtmlText } from "@n1h/sweetview"`; `indexHtmlText({ title, js = "main.js", css = "main.css", head = "", body = '<div id="root"></div>' })` | unchanged |
| `onOpenUrl` | `import { onOpenUrl } from "@n1h/sweetview"`; `onOpenUrl(handler)` | unchanged |
| `pumpEvents` | `import { pumpEvents } from "@n1h/sweetview"`; `pumpEvents()` | unchanged |
| `quitEventLoop` | `import { quitEventLoop } from "@n1h/sweetview"`; `quitEventLoop()` | unchanged |
| `registerUrlScheme` | `import { registerUrlScheme } from "@n1h/sweetview"`; `registerUrlScheme(scheme, options)` | unchanged |
| `runEventLoop` | `import { runEventLoop } from "@n1h/sweetview"`; `runEventLoop(options)` | unchanged |
| `setActivationPolicy` | `import { setActivationPolicy } from "@n1h/sweetview"`; `setActivationPolicy(policy)` | unchanged |
| `signalReady` | `import { signalReady } from "@n1h/sweetview"`; `signalReady()` | unchanged |
| `singleInstance` | `import { singleInstance } from "@n1h/sweetview"`; `singleInstance(options)` | unchanged |
| `unregisterUrlScheme` | `import { unregisterUrlScheme } from "@n1h/sweetview"`; `unregisterUrlScheme(scheme)` | unchanged |
| `windowChromeMethods` | `import { windowChromeMethods } from "@n1h/sweetview"`; `windowChromeMethods(window, options)` | unchanged |

### `@n1h/sweetview/worker`

| Old | Write now | Change |
|---|---|---|
| `HostServiceOptions` | `import type { HostServiceOptions } from "@n1h/sweetview/worker"` | unchanged |
| `RequestHandler` | `import type { RequestHandler } from "@n1h/sweetview/worker"` | unchanged |
| `hostRequestHandler` | `import { hostRequestHandler } from "@n1h/sweetview/worker"`; `hostRequestHandler(handler)` | unchanged |
| `hostService` | `import { hostService } from "@n1h/sweetview/worker"`; `hostService(service, options)` | unchanged |
| `writeWorkerCrash` | `import { writeWorkerCrash } from "@n1h/sweetview/worker"`; `writeWorkerCrash(ring, message, wake, encoder)` | unchanged |
| `writeWorkerFrame` | `import { writeWorkerFrame } from "@n1h/sweetview/worker"`; `writeWorkerFrame(ring, frame, wake, encoder)` | unchanged |

### `@n1h/sweetview/page`

| Old | Write now | Change |
|---|---|---|
| `isWebview` | `import { isWebview } from "@n1h/sweetview/page"`; `isWebview(…)` | unchanged |
| `signalReady` | `import { signalReady } from "@n1h/sweetview/page"`; `signalReady()` | unchanged |
| `webviewTransport` | `import { webviewTransport } from "@n1h/sweetview/page"`; `webviewTransport()` | unchanged |

### `@n1h/sweetview/build`

| Old | Write now | Change |
|---|---|---|
| `AppIdentity` | `import type { AppIdentity } from "@n1h/sweetview/build"` | unchanged |
| `AppIdentityInput` | `import type { AppIdentityInput } from "@n1h/sweetview/build"` | unchanged |
| `MacAppOptions` | `import type { MacAppOptions } from "@n1h/sweetview/build"` | unchanged |
| `defineAppIdentity` | `import { defineAppIdentity } from "@n1h/sweetview/build"`; `defineAppIdentity(input)` | unchanged |
| `makeMacApp` | `import { makeMacApp } from "@n1h/sweetview/build"`; `makeMacApp(options)` | unchanged |
| `refreshWindowsIcons` | `import { refreshWindowsIcons } from "@n1h/sweetview/build"`; `refreshWindowsIcons()` | unchanged |
| `writeIconFiles` | `import { writeIconFiles } from "@n1h/sweetview/build"`; `writeIconFiles(dir, files)` | unchanged |

### `@n1h/sweetview/settings-store`

| Old | Write now | Change |
|---|---|---|
| `SettingsStore` | `import { SettingsStore } from "@n1h/sweetview/settings-store"`; `new SettingsStore(options)` | unchanged |
| `SettingsStoreOptions` | `import type { SettingsStoreOptions } from "@n1h/sweetview/settings-store"` | unchanged |
| `appDataDir` | `import { appDataDir } from "@n1h/sweetview/settings-store"`; `appDataDir(app)` | unchanged |
| `createSettingsStore` | `import { createSettingsStore } from "@n1h/sweetview/settings-store"`; `createSettingsStore(options)` | unchanged |

### `@n1h/sweetview/window-chrome`

| Old | Write now | Change |
|---|---|---|
| `ResizeHandle` | `import type { ResizeHandle } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeControls` | `import type { WindowChromeControls } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeInfo` | `import type { WindowChromeInfo } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeKind` | `import type { WindowChromeKind } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeMethodTable` | `import type { WindowChromeMethodTable } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeMethods` | `import type { WindowChromeMethods } from "@n1h/sweetview/window-chrome"` | unchanged |
| `WindowChromeOptions` | `import type { WindowChromeOptions } from "@n1h/sweetview/window-chrome"` | unchanged |
| `resizeHandles` | `import { resizeHandles } from "@n1h/sweetview/window-chrome"`; `resizeHandles(thickness)` | unchanged |
| `windowChromeControls` | `import { windowChromeControls } from "@n1h/sweetview/window-chrome"`; `windowChromeControls(transport)` | unchanged |
| `windowChromeMethods` | `import { windowChromeMethods } from "@n1h/sweetview/window-chrome"`; `windowChromeMethods(window, options)` | unchanged |

### `@n1h/sweetview/ipc`

| Old | Write now | Change |
|---|---|---|
| `AnyEvent` | `import type { AnyEvent } from "@n1h/sweetview/ipc"` | unchanged |
| `Bridge` | `import type { Bridge } from "@n1h/sweetview/ipc"` | unchanged |
| `CallFrame` | `import type { CallFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `ChunkFrame` | `import type { ChunkFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `Ctx` | `import type { Ctx } from "@n1h/sweetview/ipc"` | unchanged |
| `Emit` | `import type { Emit } from "@n1h/sweetview/ipc"` | unchanged |
| `EventFrame` | `import type { EventFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `EventMap` | `import type { EventMap } from "@n1h/sweetview/ipc"` | unchanged |
| `Frame` | `import type { Frame } from "@n1h/sweetview/ipc"` | unchanged |
| `Handlers` | `import type { Handlers } from "@n1h/sweetview/ipc"` | unchanged |
| `MethodMap` | `import type { MethodMap } from "@n1h/sweetview/ipc"` | unchanged |
| `ReplyFrame` | `import type { ReplyFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `Service` | `import type { Service } from "@n1h/sweetview/ipc"` | unchanged |
| `ServiceDefinition` | `import type { ServiceDefinition } from "@n1h/sweetview/ipc"` | unchanged |
| `Session` | `import type { Session } from "@n1h/sweetview/ipc"` | unchanged |
| `SessionKind` | `import type { SessionKind } from "@n1h/sweetview/ipc"` | unchanged |
| `Transport` | `import type { Transport } from "@n1h/sweetview/ipc"` | unchanged |
| `TransportKind` | `import type { TransportKind } from "@n1h/sweetview/ipc"` | unchanged |
| `WireFrame` | `import type { WireFrame } from "@n1h/sweetview/ipc"` | unchanged |
| `createBridge` | `import { createBridge } from "@n1h/sweetview/ipc"`; `createBridge(transport)` | unchanged |
| `createFrameAssembler` | `import { createFrameAssembler } from "@n1h/sweetview/ipc"`; `createFrameAssembler()` | unchanged |
| `defineService` | `import { defineService } from "@n1h/sweetview/ipc"`; `defineService(setup)` | unchanged |
| `memoryTransport` | `import { memoryTransport } from "@n1h/sweetview/ipc"`; `memoryTransport(service, session)` | unchanged |

### `@n1h/sweetview/ipc-ws`

| Old | Write now | Change |
|---|---|---|
| `WsData` | `import type { WsData } from "@n1h/sweetview/ipc-ws"` | unchanged |
| `WsHost` | `import type { WsHost } from "@n1h/sweetview/ipc-ws"` | unchanged |
| `WsHostOptions` | `import type { WsHostOptions } from "@n1h/sweetview/ipc-ws"` | unchanged |
| `WsTransport` | `import type { WsTransport } from "@n1h/sweetview/ipc-ws"` | unchanged |
| `wsHost` | `import { wsHost } from "@n1h/sweetview/ipc-ws"`; `wsHost(service, options)` | unchanged |
| `wsTransport` | `import { wsTransport } from "@n1h/sweetview/ipc-ws"`; `wsTransport(url)` | unchanged |
| `wsUrl` | `import { wsUrl } from "@n1h/sweetview/ipc-ws"`; `wsUrl(path)` | unchanged |

### `@n1h/sweetview/ipc-ws/server`

| Old | Write now | Change |
|---|---|---|
| `WsData` | `import type { WsData } from "@n1h/sweetview/ipc-ws/server"` | unchanged |
| `WsHost` | `import type { WsHost } from "@n1h/sweetview/ipc-ws/server"` | unchanged |
| `WsHostOptions` | `import type { WsHostOptions } from "@n1h/sweetview/ipc-ws/server"` | unchanged |
| `wsHost` | `import { wsHost } from "@n1h/sweetview/ipc-ws/server"`; `wsHost(service, options)` | unchanged |

### `@n1h/sweetview/ipc-ws/client`

| Old | Write now | Change |
|---|---|---|
| `WsTransport` | `import type { WsTransport } from "@n1h/sweetview/ipc-ws/client"` | unchanged |
| `wsTransport` | `import { wsTransport } from "@n1h/sweetview/ipc-ws/client"`; `wsTransport(url)` | unchanged |
| `wsUrl` | `import { wsUrl } from "@n1h/sweetview/ipc-ws/client"`; `wsUrl(path)` | unchanged |

### `@n1h/sweetview/native`

| Old | Write now | Change |
|---|---|---|
| `APP_ICO_SIZES` | `import { APP_ICO_SIZES } from "@n1h/sweetview/native"` | unchanged |
| `ActivationPolicy` | `import type { ActivationPolicy } from "@n1h/sweetview/native"` | unchanged |
| `AppIdentity` | `import type { AppIdentity } from "@n1h/sweetview/native"` | unchanged |
| `AppIdentityInput` | `import type { AppIdentityInput } from "@n1h/sweetview/native"` | unchanged |
| `AppMenuOptions` | `import type { AppMenuOptions } from "@n1h/sweetview/native"` | unchanged |
| `Appearance` | `import type { Appearance } from "@n1h/sweetview/native"` | unchanged |
| `Clipboard` | `import { Clipboard } from "@n1h/sweetview/native"` | unchanged |
| `DecodedPng` | `import type { DecodedPng } from "@n1h/sweetview/native"` | unchanged |
| `DotIconOptions` | `import type { DotIconOptions } from "@n1h/sweetview/native"` | unchanged |
| `EventLoopOptions` | `import type { EventLoopOptions } from "@n1h/sweetview/native"` | unchanged |
| `HitPolygon` | `import type { HitPolygon } from "@n1h/sweetview/native"` | unchanged |
| `HitProbe` | `import type { HitProbe } from "@n1h/sweetview/native"` | unchanged |
| `HitRefiner` | `import type { HitRefiner } from "@n1h/sweetview/native"` | unchanged |
| `HitRelay` | `import { HitRelay } from "@n1h/sweetview/native"`; `new HitRelay(window, probe)` | unchanged |
| `Icon` | `import type { Icon } from "@n1h/sweetview/native"` | unchanged |
| `Menu` | `import { Menu } from "@n1h/sweetview/native"` | unchanged |
| `MenuItem` | `import type { MenuItem } from "@n1h/sweetview/native"` | unchanged |
| `MenuSource` | `import type { MenuSource } from "@n1h/sweetview/native"` | unchanged |
| `MenuTemplate` | `import type { MenuTemplate } from "@n1h/sweetview/native"` | unchanged |
| `NotificationClick` | `import type { NotificationClick } from "@n1h/sweetview/native"` | unchanged |
| `NotificationOptions` | `import type { NotificationOptions } from "@n1h/sweetview/native"` | unchanged |
| `Notifier` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | unchanged |
| `NotifierOptions` | `import type { NotifierOptions } from "@n1h/sweetview/native"` | unchanged |
| `Point` | `import type { Point } from "@n1h/sweetview/native"` | unchanged |
| `Rect` | `import type { Rect } from "@n1h/sweetview/native"` | unchanged |
| `RegisterUrlSchemeOptions` | `import type { RegisterUrlSchemeOptions } from "@n1h/sweetview/native"` | unchanged |
| `ResizeEdge` | `import type { ResizeEdge } from "@n1h/sweetview/native"` | unchanged |
| `Screen` | `import { Screen } from "@n1h/sweetview/native"` | unchanged |
| `ScreenInfo` | `import type { ScreenInfo } from "@n1h/sweetview/native"` | unchanged |
| `SecondInstanceEvent` | `import type { SecondInstanceEvent } from "@n1h/sweetview/native"` | unchanged |
| `SingleInstanceLock` | `import type { SingleInstanceLock } from "@n1h/sweetview/native"` | unchanged |
| `SingleInstanceOptions` | `import type { SingleInstanceOptions } from "@n1h/sweetview/native"` | unchanged |
| `TabHandle` | `import type { TabHandle } from "@n1h/sweetview/native"` | unchanged |
| `Tray` | `import { Tray } from "@n1h/sweetview/native"`; `new Tray(options)` | unchanged |
| `TrayIcon` | `import type { TrayIcon } from "@n1h/sweetview/native"` | unchanged |
| `TrayOptions` | `import type { TrayOptions } from "@n1h/sweetview/native"` | unchanged |
| `Window` | `import { Window } from "@n1h/sweetview/native"`; `new Window(options)` | unchanged |
| `WindowHandle` | `import type { WindowHandle } from "@n1h/sweetview/native"` | unchanged |
| `WindowOptions` | `import type { WindowOptions } from "@n1h/sweetview/native"` | unchanged |
| `closeAllFileHandles` | `import { closeAllFileHandles } from "@n1h/sweetview/native"`; `closeAllFileHandles()` | unchanged |
| `closeFileHandle` | `import { closeFileHandle } from "@n1h/sweetview/native"`; `closeFileHandle(handleId)` | unchanged |
| `closeToTrayOnLastWindow` | `import { closeToTrayOnLastWindow } from "@n1h/sweetview/native"`; `closeToTrayOnLastWindow(win, onHide)` | unchanged |
| `convexHull` | `import { convexHull } from "@n1h/sweetview/native"`; `convexHull(points)` | unchanged |
| `createHitRelay` | `import { createHitRelay } from "@n1h/sweetview/native"`; `createHitRelay(window, probe)` | unchanged |
| `createNotifier` | `import { createNotifier } from "@n1h/sweetview/native"`; `createNotifier(options)` | unchanged |
| `createTray` | `import { createTray } from "@n1h/sweetview/native"`; `createTray(options)` | unchanged |
| `createWindow` | `import { createWindow } from "@n1h/sweetview/native"`; `createWindow(options)` | unchanged |
| `decodePng` | `import { decodePng } from "@n1h/sweetview/native"`; `decodePng(bytes)` | unchanged |
| `defineAppIdentity` | `import { defineAppIdentity } from "@n1h/sweetview/native"`; `defineAppIdentity(input)` | unchanged |
| `dotIcns` | `import { dotIcns } from "@n1h/sweetview/native"`; `dotIcns(opts)` | unchanged |
| `dotIco` | `import { dotIco } from "@n1h/sweetview/native"`; `dotIco(opts)` | unchanged |
| `dotPng` | `import { dotPng } from "@n1h/sweetview/native"`; `dotPng(size, opts)` | unchanged |
| `encodeIcns` | `import { encodeIcns } from "@n1h/sweetview/native"`; `encodeIcns(images)` | unchanged |
| `encodeIco` | `import { encodeIco } from "@n1h/sweetview/native"`; `encodeIco(images)` | unchanged |
| `encodePng` | `import { encodePng } from "@n1h/sweetview/native"`; `encodePng(size, rgba)` | unchanged |
| `extractUrlFromArgs` | `import { extractUrlFromArgs } from "@n1h/sweetview/native"`; `extractUrlFromArgs(args, schemes)` | unchanged |
| `flattenRegions` | `import { flattenRegions } from "@n1h/sweetview/native"`; `flattenRegions(polygons)` | unchanged |
| `hitRegions` | `import { hitRegions } from "@n1h/sweetview/native"`; `hitRegions(packed, x, y)` | unchanged |
| `icnsFromPng` | `import { icnsFromPng } from "@n1h/sweetview/native"`; `icnsFromPng(png, sizes)` | unchanged |
| `icnsFromRgba` | `import { icnsFromRgba } from "@n1h/sweetview/native"`; `icnsFromRgba(size, rgba, sizes)` | unchanged |
| `icoFromPng` | `import { icoFromPng } from "@n1h/sweetview/native"`; `icoFromPng(png, sizes)` | unchanged |
| `icoFromRgba` | `import { icoFromRgba } from "@n1h/sweetview/native"`; `icoFromRgba(size, rgba, sizes)` | unchanged |
| `onOpenUrl` | `import { onOpenUrl } from "@n1h/sweetview/native"`; `onOpenUrl(handler)` | unchanged |
| `openFileHandle` | `import { openFileHandle } from "@n1h/sweetview/native"`; `openFileHandle(path)` | unchanged |
| `packRegions` | `import { packRegions } from "@n1h/sweetview/native"`; `packRegions(polygons)` | unchanged |
| `pickFolder` | `import { pickFolder } from "@n1h/sweetview/native"`; `pickFolder(owner, title)` | unchanged |
| `pumpEvents` | `import { pumpEvents } from "@n1h/sweetview/native"`; `pumpEvents()` | unchanged |
| `quitEventLoop` | `import { quitEventLoop } from "@n1h/sweetview/native"`; `quitEventLoop()` | unchanged |
| `readFileBytes` | `import { readFileBytes } from "@n1h/sweetview/native"`; `readFileBytes(path, options)` | unchanged |
| `readFileChunk` | `import { readFileChunk } from "@n1h/sweetview/native"`; `readFileChunk(handleId, offset, length)` | unchanged |
| `readTextFile` | `import { readTextFile } from "@n1h/sweetview/native"`; `readTextFile(path, options)` | unchanged |
| `registerUrlScheme` | `import { registerUrlScheme } from "@n1h/sweetview/native"`; `registerUrlScheme(scheme, options)` | unchanged |
| `renderDot` | `import { renderDot } from "@n1h/sweetview/native"`; `renderDot(size, opts)` | unchanged |
| `resolveMenu` | `import { resolveMenu } from "@n1h/sweetview/native"`; `resolveMenu(…)` | unchanged |
| `runEventLoop` | `import { runEventLoop } from "@n1h/sweetview/native"`; `runEventLoop(options)` | unchanged |
| `setActivationPolicy` | `import { setActivationPolicy } from "@n1h/sweetview/native"`; `setActivationPolicy(policy)` | unchanged |
| `setAppIcon` | `import { setAppIcon } from "@n1h/sweetview/native"`; `setAppIcon(icon)` | unchanged |
| `setAppMenu` | `import { setAppMenu } from "@n1h/sweetview/native"`; `setAppMenu(options)` | unchanged |
| `signalReady` | `import { signalReady } from "@n1h/sweetview/native"`; `signalReady()` | unchanged |
| `singleInstance` | `import { singleInstance } from "@n1h/sweetview/native"`; `singleInstance(options)` | unchanged |
| `trimTransparent` | `import { trimTransparent } from "@n1h/sweetview/native"`; `trimTransparent(image, margin, threshold)` | unchanged |
| `unpackRegions` | `import { unpackRegions } from "@n1h/sweetview/native"`; `unpackRegions(flat)` | unchanged |
| `unregisterUrlScheme` | `import { unregisterUrlScheme } from "@n1h/sweetview/native"`; `unregisterUrlScheme(scheme)` | unchanged |

### `@n1h/sweetview/native/hit-regions`

| Old | Write now | Change |
|---|---|---|
| `HitPolygon` | `import type { HitPolygon } from "@n1h/sweetview/native/hit-regions"` | unchanged |
| `HitProbe` | `import type { HitProbe } from "@n1h/sweetview/native/hit-regions"` | unchanged |
| `HitRelay` | `import { HitRelay } from "@n1h/sweetview/native/hit-regions"`; `new HitRelay(window, probe)` | unchanged |
| `convexHull` | `import { convexHull } from "@n1h/sweetview/native/hit-regions"`; `convexHull(points)` | unchanged |
| `createHitRelay` | `import { createHitRelay } from "@n1h/sweetview/native/hit-regions"`; `createHitRelay(window, probe)` | unchanged |
| `flattenRegions` | `import { flattenRegions } from "@n1h/sweetview/native/hit-regions"`; `flattenRegions(polygons)` | unchanged |
| `hitRegions` | `import { hitRegions } from "@n1h/sweetview/native/hit-regions"`; `hitRegions(packed, x, y)` | unchanged |
| `packRegions` | `import { packRegions } from "@n1h/sweetview/native/hit-regions"`; `packRegions(polygons)` | unchanged |
| `unpackRegions` | `import { unpackRegions } from "@n1h/sweetview/native/hit-regions"`; `unpackRegions(flat)` | unchanged |

### `@n1h/sweetview-build`

| Old | Write now | Change |
|---|---|---|
| `AppIdentity` | `import type { AppIdentity } from "@n1h/sweetview-build"` | unchanged |
| `AppIdentityInput` | `import type { AppIdentityInput } from "@n1h/sweetview-build"` | unchanged |
| `MacAppOptions` | `import type { MacAppOptions } from "@n1h/sweetview-build"` | unchanged |
| `defineAppIdentity` | `import { defineAppIdentity } from "@n1h/sweetview-build"`; `defineAppIdentity(input)` | unchanged |
| `makeMacApp` | `import { makeMacApp } from "@n1h/sweetview-build"`; `makeMacApp(options)` | unchanged |
| `refreshWindowsIcons` | `import { refreshWindowsIcons } from "@n1h/sweetview-build"`; `refreshWindowsIcons()` | unchanged |
| `writeIconFiles` | `import { writeIconFiles } from "@n1h/sweetview-build"`; `writeIconFiles(dir, files)` | unchanged |

### `@n1h/sweetview-ipc`

| Old | Write now | Change |
|---|---|---|
| `AnyEvent` | `import type { AnyEvent } from "@n1h/sweetview-ipc"` | unchanged |
| `Bridge` | `import type { Bridge } from "@n1h/sweetview-ipc"` | unchanged |
| `CallFrame` | `import type { CallFrame } from "@n1h/sweetview-ipc"` | unchanged |
| `ChunkFrame` | `import type { ChunkFrame } from "@n1h/sweetview-ipc"` | unchanged |
| `Ctx` | `import type { Ctx } from "@n1h/sweetview-ipc"` | unchanged |
| `Emit` | `import type { Emit } from "@n1h/sweetview-ipc"` | unchanged |
| `EventFrame` | `import type { EventFrame } from "@n1h/sweetview-ipc"` | unchanged |
| `EventMap` | `import type { EventMap } from "@n1h/sweetview-ipc"` | unchanged |
| `Frame` | `import type { Frame } from "@n1h/sweetview-ipc"` | unchanged |
| `Handlers` | `import type { Handlers } from "@n1h/sweetview-ipc"` | unchanged |
| `MethodMap` | `import type { MethodMap } from "@n1h/sweetview-ipc"` | unchanged |
| `ReplyFrame` | `import type { ReplyFrame } from "@n1h/sweetview-ipc"` | unchanged |
| `Service` | `import type { Service } from "@n1h/sweetview-ipc"` | unchanged |
| `ServiceDefinition` | `import type { ServiceDefinition } from "@n1h/sweetview-ipc"` | unchanged |
| `Session` | `import type { Session } from "@n1h/sweetview-ipc"` | unchanged |
| `SessionKind` | `import type { SessionKind } from "@n1h/sweetview-ipc"` | unchanged |
| `Transport` | `import type { Transport } from "@n1h/sweetview-ipc"` | unchanged |
| `TransportKind` | `import type { TransportKind } from "@n1h/sweetview-ipc"` | unchanged |
| `WireFrame` | `import type { WireFrame } from "@n1h/sweetview-ipc"` | unchanged |
| `createBridge` | `import { createBridge } from "@n1h/sweetview-ipc"`; `createBridge(transport)` | unchanged |
| `createFrameAssembler` | `import { createFrameAssembler } from "@n1h/sweetview-ipc"`; `createFrameAssembler()` | unchanged |
| `defineService` | `import { defineService } from "@n1h/sweetview-ipc"`; `defineService(setup)` | unchanged |
| `memoryTransport` | `import { memoryTransport } from "@n1h/sweetview-ipc"`; `memoryTransport(service, session)` | unchanged |

### `@n1h/sweetview-ipc-ws`

| Old | Write now | Change |
|---|---|---|
| `WsData` | `import type { WsData } from "@n1h/sweetview-ipc-ws"` | unchanged |
| `WsHost` | `import type { WsHost } from "@n1h/sweetview-ipc-ws"` | unchanged |
| `WsHostOptions` | `import type { WsHostOptions } from "@n1h/sweetview-ipc-ws"` | unchanged |
| `WsTransport` | `import type { WsTransport } from "@n1h/sweetview-ipc-ws"` | unchanged |
| `wsHost` | `import { wsHost } from "@n1h/sweetview-ipc-ws"`; `wsHost(service, options)` | unchanged |
| `wsTransport` | `import { wsTransport } from "@n1h/sweetview-ipc-ws"`; `wsTransport(url)` | unchanged |
| `wsUrl` | `import { wsUrl } from "@n1h/sweetview-ipc-ws"`; `wsUrl(path)` | unchanged |

### `@n1h/sweetview-ipc-ws/server`

| Old | Write now | Change |
|---|---|---|
| `WsData` | `import type { WsData } from "@n1h/sweetview-ipc-ws/server"` | unchanged |
| `WsHost` | `import type { WsHost } from "@n1h/sweetview-ipc-ws/server"` | unchanged |
| `WsHostOptions` | `import type { WsHostOptions } from "@n1h/sweetview-ipc-ws/server"` | unchanged |
| `wsHost` | `import { wsHost } from "@n1h/sweetview-ipc-ws/server"`; `wsHost(service, options)` | unchanged |

### `@n1h/sweetview-ipc-ws/client`

| Old | Write now | Change |
|---|---|---|
| `WsTransport` | `import type { WsTransport } from "@n1h/sweetview-ipc-ws/client"` | unchanged |
| `wsTransport` | `import { wsTransport } from "@n1h/sweetview-ipc-ws/client"`; `wsTransport(url)` | unchanged |
| `wsUrl` | `import { wsUrl } from "@n1h/sweetview-ipc-ws/client"`; `wsUrl(path)` | unchanged |

### `@n1h/sweetview-native`

| Old | Write now | Change |
|---|---|---|
| `APP_ICO_SIZES` | `import { APP_ICO_SIZES } from "@n1h/sweetview-native"` | unchanged |
| `ActivationPolicy` | `import type { ActivationPolicy } from "@n1h/sweetview-native"` | unchanged |
| `AppIdentity` | `import type { AppIdentity } from "@n1h/sweetview-native"` | unchanged |
| `AppIdentityInput` | `import type { AppIdentityInput } from "@n1h/sweetview-native"` | unchanged |
| `AppMenuOptions` | `import type { AppMenuOptions } from "@n1h/sweetview-native"` | unchanged |
| `Appearance` | `import type { Appearance } from "@n1h/sweetview-native"` | unchanged |
| `Clipboard` | `import { Clipboard } from "@n1h/sweetview-native"` | unchanged |
| `DecodedPng` | `import type { DecodedPng } from "@n1h/sweetview-native"` | unchanged |
| `DotIconOptions` | `import type { DotIconOptions } from "@n1h/sweetview-native"` | unchanged |
| `EventLoopOptions` | `import type { EventLoopOptions } from "@n1h/sweetview-native"` | unchanged |
| `HitPolygon` | `import type { HitPolygon } from "@n1h/sweetview-native"` | unchanged |
| `HitProbe` | `import type { HitProbe } from "@n1h/sweetview-native"` | unchanged |
| `HitRefiner` | `import type { HitRefiner } from "@n1h/sweetview-native"` | unchanged |
| `HitRelay` | `import { HitRelay } from "@n1h/sweetview-native"`; `new HitRelay(window, probe)` | unchanged |
| `Icon` | `import type { Icon } from "@n1h/sweetview-native"` | unchanged |
| `Menu` | `import { Menu } from "@n1h/sweetview-native"` | unchanged |
| `MenuItem` | `import type { MenuItem } from "@n1h/sweetview-native"` | unchanged |
| `MenuSource` | `import type { MenuSource } from "@n1h/sweetview-native"` | unchanged |
| `MenuTemplate` | `import type { MenuTemplate } from "@n1h/sweetview-native"` | unchanged |
| `NotificationClick` | `import type { NotificationClick } from "@n1h/sweetview-native"` | unchanged |
| `NotificationOptions` | `import type { NotificationOptions } from "@n1h/sweetview-native"` | unchanged |
| `Notifier` | `import { Notifier } from "@n1h/sweetview-native"`; `new Notifier(options)` | unchanged |
| `NotifierOptions` | `import type { NotifierOptions } from "@n1h/sweetview-native"` | unchanged |
| `Point` | `import type { Point } from "@n1h/sweetview-native"` | unchanged |
| `Rect` | `import type { Rect } from "@n1h/sweetview-native"` | unchanged |
| `RegisterUrlSchemeOptions` | `import type { RegisterUrlSchemeOptions } from "@n1h/sweetview-native"` | unchanged |
| `ResizeEdge` | `import type { ResizeEdge } from "@n1h/sweetview-native"` | unchanged |
| `Screen` | `import { Screen } from "@n1h/sweetview-native"` | unchanged |
| `ScreenInfo` | `import type { ScreenInfo } from "@n1h/sweetview-native"` | unchanged |
| `SecondInstanceEvent` | `import type { SecondInstanceEvent } from "@n1h/sweetview-native"` | unchanged |
| `SingleInstanceLock` | `import type { SingleInstanceLock } from "@n1h/sweetview-native"` | unchanged |
| `SingleInstanceOptions` | `import type { SingleInstanceOptions } from "@n1h/sweetview-native"` | unchanged |
| `TabHandle` | `import type { TabHandle } from "@n1h/sweetview-native"` | unchanged |
| `Tray` | `import { Tray } from "@n1h/sweetview-native"`; `new Tray(options)` | unchanged |
| `TrayIcon` | `import type { TrayIcon } from "@n1h/sweetview-native"` | unchanged |
| `TrayOptions` | `import type { TrayOptions } from "@n1h/sweetview-native"` | unchanged |
| `Window` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | unchanged |
| `WindowHandle` | `import type { WindowHandle } from "@n1h/sweetview-native"` | unchanged |
| `WindowOptions` | `import type { WindowOptions } from "@n1h/sweetview-native"` | unchanged |
| `closeAllFileHandles` | `import { closeAllFileHandles } from "@n1h/sweetview-native"`; `closeAllFileHandles()` | unchanged |
| `closeFileHandle` | `import { closeFileHandle } from "@n1h/sweetview-native"`; `closeFileHandle(handleId)` | unchanged |
| `closeToTrayOnLastWindow` | `import { closeToTrayOnLastWindow } from "@n1h/sweetview-native"`; `closeToTrayOnLastWindow(win, onHide)` | unchanged |
| `convexHull` | `import { convexHull } from "@n1h/sweetview-native"`; `convexHull(points)` | unchanged |
| `createHitRelay` | `import { createHitRelay } from "@n1h/sweetview-native"`; `createHitRelay(window, probe)` | unchanged |
| `createNotifier` | `import { createNotifier } from "@n1h/sweetview-native"`; `createNotifier(options)` | unchanged |
| `createTray` | `import { createTray } from "@n1h/sweetview-native"`; `createTray(options)` | unchanged |
| `createWindow` | `import { createWindow } from "@n1h/sweetview-native"`; `createWindow(options)` | unchanged |
| `decodePng` | `import { decodePng } from "@n1h/sweetview-native"`; `decodePng(bytes)` | unchanged |
| `defineAppIdentity` | `import { defineAppIdentity } from "@n1h/sweetview-native"`; `defineAppIdentity(input)` | unchanged |
| `dotIcns` | `import { dotIcns } from "@n1h/sweetview-native"`; `dotIcns(opts)` | unchanged |
| `dotIco` | `import { dotIco } from "@n1h/sweetview-native"`; `dotIco(opts)` | unchanged |
| `dotPng` | `import { dotPng } from "@n1h/sweetview-native"`; `dotPng(size, opts)` | unchanged |
| `encodeIcns` | `import { encodeIcns } from "@n1h/sweetview-native"`; `encodeIcns(images)` | unchanged |
| `encodeIco` | `import { encodeIco } from "@n1h/sweetview-native"`; `encodeIco(images)` | unchanged |
| `encodePng` | `import { encodePng } from "@n1h/sweetview-native"`; `encodePng(size, rgba)` | unchanged |
| `extractUrlFromArgs` | `import { extractUrlFromArgs } from "@n1h/sweetview-native"`; `extractUrlFromArgs(args, schemes)` | unchanged |
| `flattenRegions` | `import { flattenRegions } from "@n1h/sweetview-native"`; `flattenRegions(polygons)` | unchanged |
| `hitRegions` | `import { hitRegions } from "@n1h/sweetview-native"`; `hitRegions(packed, x, y)` | unchanged |
| `icnsFromPng` | `import { icnsFromPng } from "@n1h/sweetview-native"`; `icnsFromPng(png, sizes)` | unchanged |
| `icnsFromRgba` | `import { icnsFromRgba } from "@n1h/sweetview-native"`; `icnsFromRgba(size, rgba, sizes)` | unchanged |
| `icoFromPng` | `import { icoFromPng } from "@n1h/sweetview-native"`; `icoFromPng(png, sizes)` | unchanged |
| `icoFromRgba` | `import { icoFromRgba } from "@n1h/sweetview-native"`; `icoFromRgba(size, rgba, sizes)` | unchanged |
| `onOpenUrl` | `import { onOpenUrl } from "@n1h/sweetview-native"`; `onOpenUrl(handler)` | unchanged |
| `openFileHandle` | `import { openFileHandle } from "@n1h/sweetview-native"`; `openFileHandle(path)` | unchanged |
| `packRegions` | `import { packRegions } from "@n1h/sweetview-native"`; `packRegions(polygons)` | unchanged |
| `pickFolder` | `import { pickFolder } from "@n1h/sweetview-native"`; `pickFolder(owner, title)` | unchanged |
| `pumpEvents` | `import { pumpEvents } from "@n1h/sweetview-native"`; `pumpEvents()` | unchanged |
| `quitEventLoop` | `import { quitEventLoop } from "@n1h/sweetview-native"`; `quitEventLoop()` | unchanged |
| `readFileBytes` | `import { readFileBytes } from "@n1h/sweetview-native"`; `readFileBytes(path, options)` | unchanged |
| `readFileChunk` | `import { readFileChunk } from "@n1h/sweetview-native"`; `readFileChunk(handleId, offset, length)` | unchanged |
| `readTextFile` | `import { readTextFile } from "@n1h/sweetview-native"`; `readTextFile(path, options)` | unchanged |
| `registerUrlScheme` | `import { registerUrlScheme } from "@n1h/sweetview-native"`; `registerUrlScheme(scheme, options)` | unchanged |
| `renderDot` | `import { renderDot } from "@n1h/sweetview-native"`; `renderDot(size, opts)` | unchanged |
| `resolveMenu` | `import { resolveMenu } from "@n1h/sweetview-native"`; `resolveMenu(…)` | unchanged |
| `runEventLoop` | `import { runEventLoop } from "@n1h/sweetview-native"`; `runEventLoop(options)` | unchanged |
| `setActivationPolicy` | `import { setActivationPolicy } from "@n1h/sweetview-native"`; `setActivationPolicy(policy)` | unchanged |
| `setAppIcon` | `import { setAppIcon } from "@n1h/sweetview-native"`; `setAppIcon(icon)` | unchanged |
| `setAppMenu` | `import { setAppMenu } from "@n1h/sweetview-native"`; `setAppMenu(options)` | unchanged |
| `signalReady` | `import { signalReady } from "@n1h/sweetview-native"`; `signalReady()` | unchanged |
| `singleInstance` | `import { singleInstance } from "@n1h/sweetview-native"`; `singleInstance(options)` | unchanged |
| `trimTransparent` | `import { trimTransparent } from "@n1h/sweetview-native"`; `trimTransparent(image, margin, threshold)` | unchanged |
| `unpackRegions` | `import { unpackRegions } from "@n1h/sweetview-native"`; `unpackRegions(flat)` | unchanged |
| `unregisterUrlScheme` | `import { unregisterUrlScheme } from "@n1h/sweetview-native"`; `unregisterUrlScheme(scheme)` | unchanged |

### `@n1h/sweetview-native/hit-regions`

| Old | Write now | Change |
|---|---|---|
| `HitPolygon` | `import type { HitPolygon } from "@n1h/sweetview-native/hit-regions"` | unchanged |
| `HitProbe` | `import type { HitProbe } from "@n1h/sweetview-native/hit-regions"` | unchanged |
| `HitRelay` | `import { HitRelay } from "@n1h/sweetview-native/hit-regions"`; `new HitRelay(window, probe)` | unchanged |
| `convexHull` | `import { convexHull } from "@n1h/sweetview-native/hit-regions"`; `convexHull(points)` | unchanged |
| `createHitRelay` | `import { createHitRelay } from "@n1h/sweetview-native/hit-regions"`; `createHitRelay(window, probe)` | unchanged |
| `flattenRegions` | `import { flattenRegions } from "@n1h/sweetview-native/hit-regions"`; `flattenRegions(polygons)` | unchanged |
| `hitRegions` | `import { hitRegions } from "@n1h/sweetview-native/hit-regions"`; `hitRegions(packed, x, y)` | unchanged |
| `packRegions` | `import { packRegions } from "@n1h/sweetview-native/hit-regions"`; `packRegions(polygons)` | unchanged |
| `unpackRegions` | `import { unpackRegions } from "@n1h/sweetview-native/hit-regions"`; `unpackRegions(flat)` | unchanged |

### `@n1h/sweetview-native/internal`

| Old | Write now | Change |
|---|---|---|
| `discardQuit` | `import { discardQuit } from "@n1h/sweetview-native/internal"`; `discardQuit()` | unchanged (internal) |
| `emitActivationUrl` | `import { emitActivationUrl } from "@n1h/sweetview-native/internal"`; `emitActivationUrl(url)` | unchanged (internal) |
| `emitWindowFileDrop` | `import { emitWindowFileDrop } from "@n1h/sweetview-native/internal"`; `emitWindowFileDrop(win, paths)` | unchanged (internal) |
| `emitWindowNewTab` | `import { emitWindowNewTab } from "@n1h/sweetview-native/internal"`; `emitWindowNewTab(win, origin)` | unchanged (internal) |
| `emitWindowTabClose` | `import { emitWindowTabClose } from "@n1h/sweetview-native/internal"`; `emitWindowTabClose(win, tab)` | unchanged (internal) |
| `emitWindowTabSelect` | `import { emitWindowTabSelect } from "@n1h/sweetview-native/internal"`; `emitWindowTabSelect(win, tab)` | unchanged (internal) |
| `forwardWindowTabEvents` | `import { forwardWindowTabEvents } from "@n1h/sweetview-native/internal"`; `forwardWindowTabEvents(from, to)` | unchanged (internal) |
| `getWindowBackend` | `import { getWindowBackend } from "@n1h/sweetview-native/internal"`; `getWindowBackend(win)` | unchanged (internal) |
| `getWindowMeta` | `import { getWindowMeta } from "@n1h/sweetview-native/internal"`; `getWindowMeta(win)` | unchanged (internal) |
| `holdWindowNativeDispose` | `import { holdWindowNativeDispose } from "@n1h/sweetview-native/internal"`; `holdWindowNativeDispose(win)` | unchanged (internal) |
| `isWindowDisposed` | `import { isWindowDisposed } from "@n1h/sweetview-native/internal"`; `isWindowDisposed(win)` | unchanged (internal) |
| `onWindowDispose` | `import { onWindowDispose } from "@n1h/sweetview-native/internal"`; `onWindowDispose(win, fn)` | unchanged (internal) |
| `onWindowFileDropListenersChange` | `import { onWindowFileDropListenersChange } from "@n1h/sweetview-native/internal"`; `onWindowFileDropListenersChange(win, fn)` | unchanged (internal) |
| `preserveWindowGeometry` | `import { preserveWindowGeometry } from "@n1h/sweetview-native/internal"`; `preserveWindowGeometry(win)` | unchanged (internal) |
| `scheduleNativeTimeout` | `import { scheduleNativeTimeout } from "@n1h/sweetview-native/internal"`; `scheduleNativeTimeout(ms, fn)` | unchanged (internal) |
| `windowFileDropCount` | `import { windowFileDropCount } from "@n1h/sweetview-native/internal"`; `windowFileDropCount(win)` | unchanged (internal) |

### `@n1h/sweetview-native/win32/api`

The package does not export this subpath now, and `src/win32/api.ts` is not
in it, so an import of either by file path follows these rows too.

| Old | Write now | Change |
|---|---|---|
| `CF_UNICODETEXT` | `import { Clipboard } from "@n1h/sweetview-native"`; `Clipboard.readText()` | and `Clipboard.writeText(text)`, on the UI thread |
| `COINIT_APARTMENTTHREADED` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | the binding initialises COM on the UI thread when it loads |
| `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` | `import { Window } from "@n1h/sweetview-native"`; `Window#scale()` | the process is per-monitor DPI aware once the binding loads |
| `DWM_BB_BLURREGION` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `transparent: true` |
| `DWM_BB_ENABLE` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `transparent: true` |
| `ERROR_ALREADY_EXISTS` | `import { singleInstance } from "@n1h/sweetview-native"`; `singleInstance(options)` | the lock's `isPrimary` says which instance this is |
| `ERROR_FILE_NOT_FOUND` | `import { unregisterUrlScheme } from "@n1h/sweetview-native"`; `unregisterUrlScheme(scheme)` | unregistering a scheme that is not registered does nothing |
| `GMEM_MOVEABLE` | `import { Clipboard } from "@n1h/sweetview-native"`; `Clipboard.writeText(text)` | on the UI thread |
| `GWL_EXSTYLE` | `import { Window } from "@n1h/sweetview-native"`; `Window#setClickThrough(on)` | extended styles are window options and methods |
| `GWL_STYLE` | `import { Window } from "@n1h/sweetview-native"`; `Window.fromHandle(handle)` | the wrapper reads the frame from the window's style |
| `GW_CHILD` | `import { WebView } from "@n1h/sweetview"`; `WebView.attach(window, options)` | Sweetview places and sizes the webview inside the window itself |
| `HKEY_CURRENT_USER` | `import { registerUrlScheme } from "@n1h/sweetview-native"`; `registerUrlScheme(scheme, options)` | the registry writes are internal |
| `HTCAPTION` | `import { Window } from "@n1h/sweetview-native"`; `Window#startDrag()` | the OS move loop from a page's pointer-down |
| `HWND_MESSAGE` | `import { dlopen } from "bun:ffi"`; `dlopen("user32.dll", { … })` | for a message window of your own, call `CreateWindowExW` from your own table |
| `HWND_NOTOPMOST` | `import { Window } from "@n1h/sweetview-native"`; `Window#setTopmost(on)` | `setTopmost(false)` |
| `HWND_TOPMOST` | `import { Window } from "@n1h/sweetview-native"`; `Window#setTopmost(on)` | or `topmost: true` |
| `ICON_BIG` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | both icon sizes come from the `.ico` |
| `ICON_SMALL` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | both icon sizes come from the `.ico` |
| `KEY_WRITE` | `import { registerUrlScheme } from "@n1h/sweetview-native"`; `registerUrlScheme(scheme, options)` | the registry writes are internal |
| `LWA_ALPHA` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `opacity` from 0 to 1 |
| `LWA_COLORKEY` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `colorKey: "#rrggbb"` |
| `MDT_EFFECTIVE_DPI` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.of(window)` | `scale` of the `ScreenInfo`; `Window.scale()` for a window |
| `MONITORINFOF_PRIMARY` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.all()` | each `ScreenInfo` has `primary` |
| `MONITORINFO_SIZE` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.all()` | every monitor as a `ScreenInfo` |
| `MONITOR_DEFAULTTONEAREST` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.at(point)` | the monitor at a point, or the nearest one |
| `PM_REMOVE` | `import { pumpEvents } from "@n1h/sweetview-native"`; `pumpEvents()` | dispatches every waiting message |
| `REG_SZ` | `import { registerUrlScheme } from "@n1h/sweetview-native"`; `registerUrlScheme(scheme, options)` | the registry writes are internal |
| `RPC_E_CHANGED_MODE` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | the binding initialises COM on the UI thread when it loads |
| `SMTO_ABORTIFHUNG` | `import { singleInstance } from "@n1h/sweetview-native"`; `singleInstance(options)` | the hand-off to the first instance is internal |
| `SM_CXICON` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | Sweetview picks each size from the `.ico` |
| `SM_CXSCREEN` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.primary()` | `bounds` of the `ScreenInfo` |
| `SM_CXSMICON` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | Sweetview picks each size from the `.ico` |
| `SM_CXVIRTUALSCREEN` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.bounds()` | the rectangle around every monitor |
| `SM_CYSCREEN` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.primary()` | `bounds` of the `ScreenInfo` |
| `SM_CYVIRTUALSCREEN` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.bounds()` | the rectangle around every monitor |
| `SM_XVIRTUALSCREEN` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.bounds()` | the rectangle around every monitor |
| `SM_YVIRTUALSCREEN` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.bounds()` | the rectangle around every monitor |
| `SPI_GETWORKAREA` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.primary()` | `workArea` of the `ScreenInfo` |
| `SWP_FRAMECHANGED` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | styles are set when the window is made |
| `SWP_NOACTIVATE` | `import { Window } from "@n1h/sweetview-native"`; `Window#setBounds(rect)` | moving a window never activates it |
| `SWP_NOMOVE` | `import { Window } from "@n1h/sweetview-native"`; `Window#resize(width, height)` | resizes without moving |
| `SWP_NOSIZE` | `import { Window } from "@n1h/sweetview-native"`; `Window#moveTo(x, y)` | moves without resizing |
| `SWP_NOZORDER` | `import { Window } from "@n1h/sweetview-native"`; `Window#setBounds(rect)` | moves and resizes in one step |
| `SW_HIDE` | `import { Window } from "@n1h/sweetview-native"`; `Window#hide()` | use the method |
| `SW_MAXIMIZE` | `import { Window } from "@n1h/sweetview-native"`; `Window#toggleMaximize()` | use the method |
| `SW_MINIMIZE` | `import { Window } from "@n1h/sweetview-native"`; `Window#minimize()` | use the method |
| `SW_RESTORE` | `import { Window } from "@n1h/sweetview-native"`; `Window#show()` | `show()` restores a minimised window |
| `SW_SHOW` | `import { Window } from "@n1h/sweetview-native"`; `Window#show()` | use the method |
| `SW_SHOWNOACTIVATE` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `noActivate: true`; `show()` then never takes focus |
| `WM_APP` | `import { Tray } from "@n1h/sweetview-native"`; `new Tray(options)` | Sweetview's private messages are internal; tray and notification callbacks arrive as `Tray` and `Notifier` events |
| `WM_CLOSE` | `import { Window } from "@n1h/sweetview-native"`; `Window#onClose(handler)` | a close request reaches `onClose` listeners |
| `WM_COPYDATA` | `import { singleInstance } from "@n1h/sweetview-native"`; `singleInstance(options)` | a second instance's arguments arrive at `onSecondInstance` |
| `WM_DESTROY` | `import { Window } from "@n1h/sweetview-native"`; `Window#dispose()` | an owned window is destroyed by `dispose()` |
| `WM_DROPFILES` | `import { Window } from "@n1h/sweetview-native"`; `Window#onFileDrop(handler)` | use the event |
| `WM_GETMINMAXINFO` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `minWidth` and `minHeight` |
| `WM_LBUTTONDBLCLK` | `import { Tray } from "@n1h/sweetview-native"`; `new Tray(options)` | a tray double click is `onDoubleClick` |
| `WM_LBUTTONUP` | `import { Tray } from "@n1h/sweetview-native"`; `new Tray(options)` | a tray click is `onClick` |
| `WM_MOVE` | `import { Window } from "@n1h/sweetview-native"`; `Window#onMove(handler)` | use the event |
| `WM_NCDESTROY` | `import { Window } from "@n1h/sweetview-native"`; `Window#dispose()` | Sweetview releases its hooks in `dispose()` |
| `WM_NCLBUTTONDOWN` | `import { Window } from "@n1h/sweetview-native"`; `Window#startDrag()` | the OS move loop from a page's pointer-down |
| `WM_NULL` | `import { pumpEvents } from "@n1h/sweetview-native"`; `pumpEvents()` | a wake is internal; `pumpEvents()` dispatches what is waiting |
| `WM_QUIT` | `import { quitEventLoop } from "@n1h/sweetview-native"`; `quitEventLoop()` | ends the loop `runEventLoop` runs |
| `WM_RBUTTONUP` | `import { Tray } from "@n1h/sweetview-native"`; `new Tray(options)` | the tray's right-click menu is `menu` |
| `WM_SETICON` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | sets the title bar, taskbar and Alt+Tab icon |
| `WM_SETTINGCHANGE` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `appearance: "system"` follows the system's light or dark setting |
| `WM_SIZE` | `import { Window } from "@n1h/sweetview-native"`; `Window#onResize(handler)` | use the event |
| `WM_TIMER` | `import { runEventLoop } from "@n1h/sweetview-native"`; `runEventLoop(options)` | Bun's own timers run while `runEventLoop` pumps the loop |
| `WS_CLIPCHILDREN` | `import { WebView } from "@n1h/sweetview"`; `WebView.attach(window, options)` | Sweetview hosts the webview in the window itself |
| `WS_EX_APPWINDOW` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `hideFromTaskbar: false`, the default |
| `WS_EX_LAYERED` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `colorKey`, `opacity` or `transparent: true` |
| `WS_EX_NOACTIVATE` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `noActivate: true` |
| `WS_EX_TOOLWINDOW` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `hideFromTaskbar: true` |
| `WS_EX_TRANSPARENT` | `import { Window } from "@n1h/sweetview-native"`; `Window#setClickThrough(on)` | use the method |
| `WS_MAXIMIZEBOX` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `resizable: true` |
| `WS_OVERLAPPEDWINDOW` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `frame: true`, the default |
| `WS_POPUP` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `frame: false`; a frameless window no longer has `WS_POPUP` in `GWL_STYLE` |
| `WS_THICKFRAME` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `resizable: true` |
| `advapi32` | `import { dlopen } from "bun:ffi"`; `dlopen("advapi32.dll", { … })` | declare your own table; URL schemes are `registerUrlScheme` |
| `asPointer` | `import { Window } from "@n1h/sweetview-native"`; `Window.fromHandle(handle)` | a `WindowHandle` (number, bigint or `bun:ffi` pointer) is accepted as it is |
| `comctl32` | `import { dlopen } from "bun:ffi"`; `dlopen("comctl32.dll", { … })` | declare your own table for your own calls |
| `dwmapi` | `import { dlopen } from "bun:ffi"`; `dlopen("dwmapi.dll", { … })` | declare your own table; transparency is `new Window({ transparent: true })` |
| `gdi32` | `import { dlopen } from "bun:ffi"`; `dlopen("gdi32.dll", { … })` | declare your own table for your own calls |
| `hInstance` | `import { dlopen } from "bun:ffi"`; `dlopen("kernel32.dll", { … })` | call `GetModuleHandleW` from your own table |
| `kernel32` | `import { dlopen } from "bun:ffi"`; `dlopen("kernel32.dll", { … })` | declare your own table for your own calls |
| `lastError` | `import { dlopen } from "bun:ffi"`; `dlopen("kernel32.dll", { … })` | Sweetview's calls throw an `Error` that carries the OS error; for your own calls use your own table |
| `ole32` | `import { dlopen } from "bun:ffi"`; `dlopen("ole32.dll", { … })` | declare your own table; the binding initialises COM on the UI thread itself |
| `shcore` | `import { dlopen } from "bun:ffi"`; `dlopen("shcore.dll", { … })` | declare your own table; DPI and scale come from `Screen` and `Window.scale()` |
| `shell32` | `import { dlopen } from "bun:ffi"`; `dlopen("shell32.dll", { … })` | declare your own table; file drops are `Window.onFileDrop` |
| `toPointer` | `import { Window } from "@n1h/sweetview-native"`; `Window.fromHandle(handle)` | a `WindowHandle` (number, bigint or `bun:ffi` pointer) is accepted as it is |
| `user32` | `import { dlopen } from "bun:ffi"`; `dlopen("user32.dll", { … })` | declare your own table for your own calls; Sweetview's window, screen, menu and clipboard calls are `Window`, `Screen`, `Menu`, `Clipboard` |
| `wstr` | `import { Window } from "@n1h/sweetview-native"`; `Window#setTitle(title)` | public calls take JavaScript strings; for your own calls encode with `Buffer.from(text + "\0", "utf16le")` |

### `@n1h/sweetview-native/win32/shortcuts`

| Old | Write now | Change |
|---|---|---|
| `Key` | `import type { Key } from "@n1h/sweetview-native/win32/shortcuts"` | unchanged (internal; the tab strip's layout and keys) |
| `LAST_TAB` | `import { LAST_TAB } from "@n1h/sweetview-native/win32/shortcuts"` | unchanged (internal; the tab strip's layout and keys) |
| `Shortcut` | `import type { Shortcut } from "@n1h/sweetview-native/win32/shortcuts"` | unchanged (internal; the tab strip's layout and keys) |
| `shortcutFor` | `import { shortcutFor } from "@n1h/sweetview-native/win32/shortcuts"`; `shortcutFor(key)` | unchanged (internal; the tab strip's layout and keys) |

### `@n1h/sweetview-native/win32/strip-shared`

| Old | Write now | Change |
|---|---|---|
| `CAPTION_WIDTH` | `import { CAPTION_WIDTH } from "@n1h/sweetview-native/win32/strip-shared"`; `CAPTION_WIDTH === 138` | unchanged (internal; the tab strip's layout and keys) |
| `DRAG_ROOM` | `import { DRAG_ROOM } from "@n1h/sweetview-native/win32/strip-shared"`; `DRAG_ROOM === 56` | unchanged (internal; the tab strip's layout and keys) |
| `NEW_TAB_WIDTH` | `import { NEW_TAB_WIDTH } from "@n1h/sweetview-native/win32/strip-shared"`; `NEW_TAB_WIDTH === 40` | unchanged (internal; the tab strip's layout and keys) |
| `STRIP_HEIGHT` | `import { STRIP_HEIGHT } from "@n1h/sweetview-native/win32/strip-shared"`; `STRIP_HEIGHT === 40` | unchanged (internal; the tab strip's layout and keys) |
| `StripEvents` | `import type { StripEvents } from "@n1h/sweetview-native/win32/strip-shared"` | unchanged (internal; the tab strip's layout and keys) |
| `StripMethods` | `import type { StripMethods } from "@n1h/sweetview-native/win32/strip-shared"` | unchanged (internal; the tab strip's layout and keys) |
| `StripPoint` | `import type { StripPoint } from "@n1h/sweetview-native/win32/strip-shared"` | unchanged (internal; the tab strip's layout and keys) |
| `StripState` | `import type { StripState } from "@n1h/sweetview-native/win32/strip-shared"` | unchanged (internal; the tab strip's layout and keys) |
| `StripTab` | `import type { StripTab } from "@n1h/sweetview-native/win32/strip-shared"` | unchanged (internal; the tab strip's layout and keys) |
| `TABS_LEFT` | `import { TABS_LEFT } from "@n1h/sweetview-native/win32/strip-shared"`; `TABS_LEFT === 8` | unchanged (internal; the tab strip's layout and keys) |
| `TAB_MAX_WIDTH` | `import { TAB_MAX_WIDTH } from "@n1h/sweetview-native/win32/strip-shared"`; `TAB_MAX_WIDTH === 240` | unchanged (internal; the tab strip's layout and keys) |
| `TAB_MIN_WIDTH` | `import { TAB_MIN_WIDTH } from "@n1h/sweetview-native/win32/strip-shared"`; `TAB_MIN_WIDTH === 72` | unchanged (internal; the tab strip's layout and keys) |
| `dropIndex` | `import { dropIndex } from "@n1h/sweetview-native/win32/strip-shared"`; `dropIndex(stripWidth, count, x, scrolled)` | unchanged (internal; the tab strip's layout and keys) |
| `scrollToShow` | `import { scrollToShow } from "@n1h/sweetview-native/win32/strip-shared"`; `scrollToShow(stripWidth, count, index, scrolled)` | unchanged (internal; the tab strip's layout and keys) |
| `tabWidth` | `import { tabWidth } from "@n1h/sweetview-native/win32/strip-shared"`; `tabWidth(stripWidth, count)` | unchanged (internal; the tab strip's layout and keys) |
| `tabsViewport` | `import { tabsViewport } from "@n1h/sweetview-native/win32/strip-shared"`; `tabsViewport(…)` | unchanged (internal; the tab strip's layout and keys) |

### `@n1h/sweetview-native/win32/tab-window`

| Old | Write now | Change |
|---|---|---|
| `FrameCallbacks` | `import type { FrameCallbacks } from "@n1h/sweetview-native/win32/tab-window"`; `FrameCallbacks#onActivate`; `FrameCallbacks#onResized`; `FrameCallbacks#onMoved` | added with `FrameWindow#addCallbacks`; a close request is `Window#onClose` (see the members below); the public events of a tabbed `Window` are its `onClose`, `onResize` and `onMove` |
| `FrameWindow` | `import type { FrameWindow } from "@n1h/sweetview-native/win32/tab-window"`; `FrameWindow#stripRect`; `FrameWindow#stripBounds`; `FrameWindow#pageRect` | the tab side of a `new Window({ tabs: true })`, from `getTabFrame(BigInt(win.handle))`; the members that changed are in the next table |
| `FrameWindowOptions` | `import type { WindowOptions } from "@n1h/sweetview-native"`; `WindowOptions#tabs` | the frame is a binding `Window` now: `new Window({ tabs: true, … })` takes every window option |
| `createFrameWindow` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | the frame is a binding `Window` now: `new Window({ tabs: true, … })`, then `getTabFrame(BigInt(win.handle))` of this subpath; tabs open with `WebView.openTab` |
| `cursorPosition` | `import { Screen } from "@n1h/sweetview-native"`; `Screen.cursor()` | the public cursor position |
| `getTabFrame` | `import { getTabFrame } from "@n1h/sweetview-native/win32/tab-window"`; `getTabFrame(hwnd)` | takes the handle of a `new Window({ tabs: true })` as a bigint, `getTabFrame(BigInt(win.handle))`; `undefined` for any other window |
| `leftButtonDown` | `import { installMouseHook } from "@n1h/sweetview-native"`; `installMouseHook(handler)` | button state from `LeftDown` and `LeftUp` events |
| `setDarkWindows` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | `appearance: "system"` follows the system's setting |
| `showTabPopupMenu` | `import { showTabPopupMenu } from "@n1h/sweetview-native/win32/tab-window"`; `showTabPopupMenu(owner, template)` | unchanged: the menu `Menu.popup(owner, menu)` shows, at the cursor, for any window of the thread |
| `windowExists` | `import { Window } from "@n1h/sweetview-native"`; `Window.fromHandle(handle)` | throws `sweetview: not a window: 0x…` for a handle that names no window |
| `windowMenu` | `import { windowMenu } from "@n1h/sweetview-native/win32/tab-window"`; `windowMenu(hwnd)` | unchanged: the system menu of any window of the thread; for a tab frame, `FrameWindow#showSystemMenu()` is the same menu |

#### `FrameWindow` and `FrameCallbacks` members that changed

The frame is a binding `Window`, and the strip and each tab are child
webviews of it. The pane windows that held them have no counterpart: a
child webview goes in the frame at `stripBounds()` or `pageRect()`, and the
engine of the webview moves, shows, hides and re-parents it.

| Old | Write now | Change |
|---|---|---|
| `stripPane` | `import type { FrameWindow } from "@n1h/sweetview-native/win32/tab-window"`; `FrameWindow#stripBounds` | the strip's rectangle in the frame's client area, physical pixels: make the strip's webview there |
| `createPane(…)` | `import { createChildWebview } from "@n1h/sweetview-native/internal"`; `createChildWebview(debug, frame.hwnd, frame.pageRect())` | a child webview of the frame, at a rectangle of its client area |
| `adoptPane(…)` | `import type { NativeEngine } from "@n1h/sweetview-native/internal"`; `NativeEngine#reparent` | `engineOf(webview).reparent(frame.hwnd)` moves the webview into another frame without reloading it |
| `placePane(…)` | `import type { NativeEngine } from "@n1h/sweetview-native/internal"`; `NativeEngine#setBounds` | `engineOf(webview).setBounds(frame.pageRect())` |
| `showPane(…)` | `import type { NativeEngine } from "@n1h/sweetview-native/internal"`; `NativeEngine#setVisible` | `engineOf(webview).setVisible(true)` |
| `hidePane(…)` | `import type { NativeEngine } from "@n1h/sweetview-native/internal"`; `NativeEngine#setVisible` | `engineOf(webview).setVisible(false)` |
| `destroyPane(…)` | `import { Webview } from "@n1h/sweetview-native"`; `Webview#destroy` | destroy the child webview; there is no pane window |
| `layout()` | `import type { FrameWindow } from "@n1h/sweetview-native/win32/tab-window"`; `FrameWindow#pageRect`; `FrameWindow#pageSize` | on each `Window#onResize`, place the strip at `stripBounds()` and the shown tab at `pageRect()` |
| `destroy()` | `import { Window } from "@n1h/sweetview-native"`; `Window#dispose()` | dispose the `Window` the frame belongs to |
| `stripRect()` | `import type { FrameWindow } from "@n1h/sweetview-native/win32/tab-window"`; `FrameWindow#stripRect` | unchanged: the strip on the screen; new members `stripBounds`, `pageRect`, `pageSize`, `requestClose`, `showSystemMenu`, `setBounds` and `hide` |
| `onCloseRequest` | `import { Window } from "@n1h/sweetview-native"`; `Window#onClose(handler)` | a close request on the frame, its close button or `FrameWindow#requestClose()`, reaches the `Window`'s `onClose` listeners; with none, the window is disposed |

#### `Tab` members that changed (tabs on Windows)

| Old | Write now | Change |
|---|---|---|
| `webview.window` | `import type { Tab } from "@n1h/sweetview"`; `Tab#window` | `tab.webview.window` was a wrapper of the tab's own pane window; no pane exists now, so it is a wrapper of the frame the tab opened in, and `tab.window` is the logical window the tab belongs to |

### `@n1h/sweetview-native/win32/window`

| Old | Write now | Change |
|---|---|---|
| `_debugTrackedCount` | `import { _debugTrackedCount } from "@n1h/sweetview-native/win32/window"`; `_debugTrackedCount(hwnd)` | unchanged (internal) |
| `asHwnd` | `import { asHwnd } from "@n1h/sweetview-native/win32/window"`; `asHwnd(…)` | unchanged (internal) |
| `colorRef` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | pass `colorKey: "#rrggbb"`; Sweetview converts the colour itself |
| `createWindow` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | internal backend; the public window is `new Window(options)` |
| `fromHandle` | `import { Window } from "@n1h/sweetview-native"`; `Window.fromHandle(handle)` | internal backend; the public wrapper is `Window.fromHandle` |
| `systemIsDark` | `import { systemIsDark } from "@n1h/sweetview-native/win32/window"`; `systemIsDark()` | unchanged (internal) |

### `@n1h/sweetview-native/win32/menu`

| Old | Write now | Change |
|---|---|---|
| `MII_HBMPITEM` | `import { Menu } from "@n1h/sweetview-native"`; `Menu.popup(owner, menu, at)` | an item's picture is the `icon` field of its menu item |
| `MII_MASK` | `import { Menu } from "@n1h/sweetview-native"`; `Menu.popup(owner, menu, at)` | an item's picture is the `icon` field of its menu item |
| `MII_SIZE` | `import { Menu } from "@n1h/sweetview-native"`; `Menu.popup(owner, menu, at)` | an item's picture is the `icon` field of its menu item |
| `bitmapItemInfo` | `import { Menu } from "@n1h/sweetview-native"`; `Menu.popup(owner, menu, at)` | an item's picture is the `icon` field of its menu item |
| `buildMenu` | `import { buildMenu } from "@n1h/sweetview-native/win32/menu"`; `buildMenu(template)` | unchanged: `{ hmenu, commands, bitmaps }` for your own `TrackPopupMenu`, command ids from 1 in template order; `bitmaps` is empty, as `destroyMenu` frees the item bitmaps itself |
| `destroyMenu` | `import { destroyMenu } from "@n1h/sweetview-native/win32/menu"`; `destroyMenu(built)` | unchanged: frees the menu, its submenus and its item bitmaps; safe to call twice |
| `escapeLabel` | `import { Menu } from "@n1h/sweetview-native"`; `Menu.popup(owner, menu, at)` | nothing to call: the native layer doubles `&` in a label itself |
| `popupMenu` | `import { popupMenu } from "@n1h/sweetview-native/win32/menu"`; `popupMenu(owner, template, at)` | unchanged (internal): the menu's top-left corner at `at`, or at the cursor without it, so it opens downward; `Menu.popup(owner, menu, at)` is the public call that does the same |
| `popupMenuAtCursor` | `import { popupMenuAtCursor } from "@n1h/sweetview-native/win32/menu"`; `popupMenuAtCursor(owner, template)` | unchanged (internal): the menu's bottom-left corner at the cursor, so it opens upward, as the tray's menu does; no public call does this: `Menu.popup(owner, menu)` opens the menu downward from the cursor and takes no alignment, so an application that wants the upward menu keeps this call, with `@n1h/sweetview-native` in its own dependencies |

### `@n1h/sweetview-native/win32/message-window`

The package does not export this subpath now, and
`src/win32/message-window.ts` is not in it, so an import of either by file
path follows these rows too.

| Old | Write now | Change |
|---|---|---|
| `MessageHandler` | `type MessageHandler = (message: number, wParam: bigint, lParam: bigint) => void` | declare the type in your own code |
| `MessageWindow` | `type MessageWindow = { readonly hwnd: bigint; readonly destroy: () => void }` | declare the type in your own code |
| `createMessageWindow` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)`; `Window#dispose()` | an owner for `Menu.popup` or `pickFolder` is a `Window`, hidden until `show()`, and `dispose()` is `destroy()`; for a window whose messages your own code handles, call `CreateWindowExW` from your own `dlopen` table with a `JSCallback` window procedure, and `Window.fromHandle` serves it |
| `createMessageWindowRaw` | `import { dlopen } from "bun:ffi"`; `dlopen("user32.dll", { … })` | Sweetview's own message windows are internal; for one of your own, call `CreateWindowExW` with `HWND_MESSAGE` from your own table and a `JSCallback` window procedure |

### `@n1h/sweetview-native/darwin/objc`

| Old | Write now | Change |
|---|---|---|
| `ID` | `import { ID } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `Id` | `import type { Id } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `NIL` | `import { NIL } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `TargetMethod` | `import type { TargetMethod } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `alloc` | `import { alloc } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `allocRaw` | `import { allocRaw } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `asId` | `import { asId } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `class_addMethod` | `import { class_addMethod } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `cls` | `import { cls } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `cstr` | `import { cstr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `dataSymbolAddress` | `import { dataSymbolAddress } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `defineYesClass` | `import { defineYesClass } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `invokeBlock` | `import { invokeBlock } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `jsString` | `import { jsString } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `makeBlock` | `import { makeBlock } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `makeTarget` | `import { makeTarget } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `nsString` | `import { nsString } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `objc_allocateClassPair` | `import { objc_allocateClassPair } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `objc_getClass` | `import { objc_getClass } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `objc_registerClassPair` | `import { objc_registerClassPair } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `release` | `import { release } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `retain` | `import { retain } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `retainCallback` | `import { retainCallback } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sel` | `import { sel } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `send` | `import { send } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendBool` | `import { sendBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendBytesLen` | `import { sendBytesLen } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendCStr` | `import { sendCStr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendF64` | `import { sendF64 } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendF64PtrSelPtrBool` | `import { sendF64PtrSelPtrBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendF64Void` | `import { sendF64Void } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendInt` | `import { sendInt } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendIntArg` | `import { sendIntArg } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendIntRetBool` | `import { sendIntRetBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPoint` | `import { sendPoint } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtr` | `import { sendPtr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrArg` | `import { sendPtrArg } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrIntVoid` | `import { sendPtrIntVoid } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrPointPtrRetBool` | `import { sendPtrPointPtrRetBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrPtr` | `import { sendPtrPtr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrPtrPtr` | `import { sendPtrPtrPtr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrPtrPtrVoid` | `import { sendPtrPtrPtrVoid } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrPtrRetBool` | `import { sendPtrPtrRetBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrSelPtr` | `import { sendPtrSelPtr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrSelPtrPtrVoid` | `import { sendPtrSelPtrPtrVoid } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrSelPtrVoid` | `import { sendPtrSelPtrVoid } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendPtrSelU32U32Void` | `import { sendPtrSelU32U32Void } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendRectBool` | `import { sendRectBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendRectUIntUIntBool` | `import { sendRectUIntUIntBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendRetBool` | `import { sendRetBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendRetF64` | `import { sendRetF64 } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendSelPtrF64` | `import { sendSelPtrF64 } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendSize` | `import { sendSize } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendSuperPtr` | `import { sendSuperPtr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendU32RetPtr` | `import { sendU32RetPtr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendUInt` | `import { sendUInt } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendUIntArg` | `import { sendUIntArg } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendUIntPtrPtrBool` | `import { sendUIntPtrPtrBool } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendUIntPtrVoid` | `import { sendUIntPtrVoid } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sendUIntRetPtr` | `import { sendUIntRetPtr } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |
| `sharedApp` | `import { sharedApp } from "@n1h/sweetview-native/darwin/objc"` | unchanged; macOS only, until the macOS goal |

### `@n1h/sweetview-native/darwin/screen`

| Old | Write now | Change |
|---|---|---|
| `CocoaRect` | `import type { CocoaRect } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `all` | `import { all } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `at` | `import { at } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `bounds` | `import { bounds } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `cursor` | `import { cursor } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `cursorPoint` | `import { cursorPoint } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `fromCocoa` | `import { fromCocoa } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `of` | `import { of } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `primary` | `import { primary } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `primaryHeight` | `import { primaryHeight } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `primaryScreen` | `import { primaryScreen } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `rectOf` | `import { rectOf } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |
| `toCocoa` | `import { toCocoa } from "@n1h/sweetview-native/darwin/screen"` | unchanged; macOS only, until the macOS goal |

### `@n1h/sweetview-native/darwin/tabs`

| Old | Write now | Change |
|---|---|---|
| `WindowTabs` | `import type { WindowTabs } from "@n1h/sweetview-native/darwin/tabs"` | unchanged; macOS only, until the macOS goal |
| `WindowTabsOptions` | `import type { WindowTabsOptions } from "@n1h/sweetview-native/darwin/tabs"` | unchanged; macOS only, until the macOS goal |
| `createWindowTabs` | `import { createWindowTabs } from "@n1h/sweetview-native/darwin/tabs"` | unchanged; macOS only, until the macOS goal |
| `installTabMenus` | `import { installTabMenus } from "@n1h/sweetview-native/darwin/tabs"` | unchanged; macOS only, until the macOS goal |
| `pooled` | `import { pooled } from "@n1h/sweetview-native/darwin/tabs"` | unchanged; macOS only, until the macOS goal |

### `@n1h/sweetview-native/darwin/window`

| Old | Write now | Change |
|---|---|---|
| `DarwinTabGroupController` | `import type { DarwinTabGroupController } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `asNSWindow` | `import { asNSWindow } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `bindDarwinTabGroup` | `import { bindDarwinTabGroup } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `createWindow` | `import { createWindow } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `darwinTabWindowClass` | `import { darwinTabWindowClass } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `fromHandle` | `import { fromHandle } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `getDarwinTabActiveHandle` | `import { getDarwinTabActiveHandle } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `setDarwinTabCloseRequest` | `import { setDarwinTabCloseRequest } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `startDarwinWindowDrag` | `import { startDarwinWindowDrag } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `startDarwinWindowResize` | `import { startDarwinWindowResize } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `stopDarwinWindowResize` | `import { stopDarwinWindowResize } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |
| `subscribeDarwinFileDrop` | `import { subscribeDarwinFileDrop } from "@n1h/sweetview-native/darwin/window"` | unchanged; macOS only, until the macOS goal |

### `@n1h/sweetview-settings`

| Old | Write now | Change |
|---|---|---|
| `AppIdentity` | `import type { AppIdentity } from "@n1h/sweetview-settings"` | unchanged |
| `AppIdentityIcon` | `import type { AppIdentityIcon } from "@n1h/sweetview-settings"` | unchanged |
| `AppIdentityInput` | `import type { AppIdentityInput } from "@n1h/sweetview-settings"` | unchanged |
| `SettingsStore` | `import { SettingsStore } from "@n1h/sweetview-settings"`; `new SettingsStore(options)` | unchanged |
| `SettingsStoreOptions` | `import type { SettingsStoreOptions } from "@n1h/sweetview-settings"` | unchanged |
| `appDataDir` | `import { appDataDir } from "@n1h/sweetview-settings"`; `appDataDir(app)` | unchanged |
| `createSettingsStore` | `import { createSettingsStore } from "@n1h/sweetview-settings"`; `createSettingsStore(options)` | unchanged |
| `defineAppIdentity` | `import { defineAppIdentity } from "@n1h/sweetview-settings"`; `defineAppIdentity(input)` | unchanged |
| `validateUrlScheme` | `import { validateUrlScheme } from "@n1h/sweetview-settings"`; `validateUrlScheme(scheme)` | unchanged |

### `@n1h/sweetview-settings/settings-store`

| Old | Write now | Change |
|---|---|---|
| `SettingsStore` | `import { SettingsStore } from "@n1h/sweetview-settings/settings-store"`; `new SettingsStore(options)` | unchanged |
| `SettingsStoreOptions` | `import type { SettingsStoreOptions } from "@n1h/sweetview-settings/settings-store"` | unchanged |
| `appDataDir` | `import { appDataDir } from "@n1h/sweetview-settings/settings-store"`; `appDataDir(app)` | unchanged |
| `createSettingsStore` | `import { createSettingsStore } from "@n1h/sweetview-settings/settings-store"`; `createSettingsStore(options)` | unchanged |

### `@n1h/sweetview-settings/app-identity`

| Old | Write now | Change |
|---|---|---|
| `AppIdentity` | `import type { AppIdentity } from "@n1h/sweetview-settings/app-identity"` | unchanged |
| `AppIdentityIcon` | `import type { AppIdentityIcon } from "@n1h/sweetview-settings/app-identity"` | unchanged |
| `AppIdentityInput` | `import type { AppIdentityInput } from "@n1h/sweetview-settings/app-identity"` | unchanged |
| `defineAppIdentity` | `import { defineAppIdentity } from "@n1h/sweetview-settings/app-identity"`; `defineAppIdentity(input)` | unchanged |
| `validateUrlScheme` | `import { validateUrlScheme } from "@n1h/sweetview-settings/app-identity"`; `validateUrlScheme(scheme)` | unchanged |

Entry points with no exports, unchanged: `@n1h/sweetview/file-imports`, `@n1h/sweetview-build/make-app`, `@n1h/sweetview-build/refresh-icons`.

### Internal modules imported by file path

#### `packages/sweetview/src/webview-lib.ts`

The `dlopen` helpers opened the webview library. On Windows there is no library to open: use the `RawWebview` methods (`app.webview.raw`, or `new RawWebview(...)`). On macOS they move to `darwin-webview-lib.ts` until the macOS goal.

| Old | Write now | Change |
|---|---|---|
| `webviewLibPath` | `import { RawWebview } from "@n1h/sweetview"`; `new RawWebview(debug, size, window)` | no library path on Windows; `SWEETVIEW_NATIVE_PATH` names a binding you built yourself |
| `openWebviewCore` | `import { RawWebview } from "@n1h/sweetview"`; `new RawWebview(debug, size, window)` | the class has every call the symbol table had |
| `WebviewCoreSymbols` | `import { RawWebview } from "@n1h/sweetview"`; `new RawWebview(debug, size, window)` | the class has every call the symbol table had |
| `backgroundColorCall` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setBackgroundColor(r, g, b, a)` | a method |
| `SetBackgroundColor` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setBackgroundColor(r, g, b, a)` | a method |
| `setAssetCall` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setAsset(path, mime, data)` | a method |
| `SetAsset` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setAsset(path, mime, data)` | a method |
| `requestHandlerCalls` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setRequestHandler(handler)` | a method; answer later with `completeRequest` |
| `streamingResponseCalls` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#beginResponse(id, head)` | with `writeResponseChunk` and `endResponse` |
| `fileDropHandlerCall` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setFileDropHandler(handler)` | a method |
| `allowExternalDropCall` | `import { RawWebview } from "@n1h/sweetview"`; `RawWebview#setAllowExternalDrop(allow)` | a method |
| `ASSET_ORIGIN` | `import { ASSET_ORIGIN } from "@n1h/sweetview"` | public: `http://webview.localhost` on Windows, `webview://localhost` on macOS |
| `FRAMES_ORIGIN` | `import { FRAMES_ORIGIN } from "@n1h/sweetview"` | public: `http://frames.webview.localhost` on Windows, `webview-frames://localhost` on macOS |

#### `packages/sweetview/src/messages.ts`

What crosses `postMessage` between the UI thread and the worker. `hostService` and `hostRequestHandler` read it; an application does not build it.

| Old | Write now | Change |
|---|---|---|
| `InitMessage` | `import { hostService } from "@n1h/sweetview/worker"`; `hostService(service, options)` | internal; it carries `wake` now, instead of `webviewHandle`, `drainCallbackPtr`, `drainToken` and `libPath` |
| `WorkerMessage` | `import { hostService } from "@n1h/sweetview/worker"`; `hostService(service, options)` | internal |
| `WEBVIEW_SESSION` | `import type { Session } from "@n1h/sweetview/ipc"` | a handler's `ctx.session` is `{ id: "webview", kind: "webview" }` |
| `NativeRequest` | `import type { NativeRequest } from "@n1h/sweetview"` | public |
| `NativeResponse` | `import type { NativeResponse } from "@n1h/sweetview"` | public |
| `WorkerCrashFrame` | `import { writeWorkerCrash } from "@n1h/sweetview/worker"`; `writeWorkerCrash(ring, message, wake, encoder)` | internal; the public writer |
| `HttpRequestMessage` | `import { hostRequestHandler } from "@n1h/sweetview/worker"`; `hostRequestHandler(handler)` | internal; the worker answers requests with `hostRequestHandler` |

#### `packages/sweetview-native/src/win32/winrt-toast.ts`

Windows toasts are made by the binding; `Notifier` is the public form.

| Old | Write now | Change |
|---|---|---|
| `WinRtToastNotifier` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the public notifier |
| `toastXml` | `import { Notifier } from "@n1h/sweetview/native"`; `Notifier#notify(notification)` | the toast is built from `NotificationOptions` |
| `WM_TOAST_EVENT` | `import { createNotifier } from "@n1h/sweetview/native"`; `createNotifier(options)` | a click arrives at `onClick` |
| `ToastEvent` | `import { createNotifier } from "@n1h/sweetview/native"`; `createNotifier(options)` | a click arrives at `onClick` with `{ id, data }` |

#### `packages/sweetview-native/src/win32/notifier.ts`

| Old | Write now | Change |
|---|---|---|
| `hiddenBalloonData` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the public notifier |
| `createNotifier` | `import { createNotifier } from "@n1h/sweetview/native"`; `createNotifier(options)` | the public function, from the package entry |

#### `packages/sweetview-native/src/win32/tray.ts`

The balloon a tray icon showed is a notification: `Notifier` shows it itself, with the active tray's icon. `createTray`, `currentTray` and `Win32Tray` are still there.

| Old | Write now | Change |
|---|---|---|
| `notifyIconData` | `import { Notifier } from "@n1h/sweetview/native"`; `Notifier#notify(notification)` | the notifier builds the balloon |
| `Balloon` | `import type { NotificationOptions } from "@n1h/sweetview/native"` | `{ title, body, silent }` of a notification |
| `Win32Tray.balloon` | `import { Notifier } from "@n1h/sweetview/native"`; `Notifier#notify(notification)` | the notifier shows the balloon with the active tray's icon |
| `currentTrayIconBytes` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the notifier uses the active tray's icon itself |
| `NID_SIZE` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_HWND` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_UID` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_FLAGS` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_CALLBACK` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_HICON` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_TIP` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_INFO` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_INFO_TITLE` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_INFO_FLAGS` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |
| `NID_BALLOON_ICON` | `import { Notifier } from "@n1h/sweetview/native"`; `new Notifier(options)` | the `NOTIFYICONDATAW` layout is internal; a tray balloon is a notification |

#### `packages/sweetview-native/src/win32/icon.ts`

The file is not in the package now: window icons are set by the binding,
which makes and frees the `HICON`s itself.

| Old | Write now | Change |
|---|---|---|
| `iconBitmap` | `import { Menu } from "@n1h/sweetview/native"`; `Menu.popup(owner, menu, at)` | a menu item's picture is its `icon` field |
| `LoadedIcon` | `import type { Icon } from "@n1h/sweetview-native"` | an icon is the `.ico` bytes, `{ windows: { ico } }`; no `HICON` is handed out |
| `loadIcon` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | for a window's icons; Sweetview picks the small and the 32 px size from the `.ico`; a notification's balloon uses the active tray's icon itself |
| `releaseIcon` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | nothing to free: the binding frees the icons it made when the next ones are set or the window goes |
| `setWindowIcon` | `import { Window } from "@n1h/sweetview-native"`; `Window.fromHandle(handle)`; `Window#setIcon(icon)` | `Window.fromHandle(hwnd).setIcon({ windows: { ico } })` sets the caption and taskbar icons of any window; `undefined` is the stock icon |
| `clearWindowIcon` | `import { Window } from "@n1h/sweetview-native"`; `Window#setIcon(icon)` | `setIcon(undefined)` goes back to the stock icon; the binding frees the icons it made |

#### `packages/sweetview-native/src/win32/init.ts`

The file is not in the package now: the binding sets up the UI thread when
it loads.

| Old | Write now | Change |
|---|---|---|
| `ensureDpiAware` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | nothing to call: the process is per-monitor DPI aware (v2) and the UI thread is a COM STA once the binding has loaded, before any window of Sweetview's exists |
| `ensureWin32Init` | `import { Window } from "@n1h/sweetview-native"`; `new Window(options)` | nothing to call: DPI awareness and the STA are the binding's own set-up, and `topmost: true` or `setTopmost(true)` makes any `Window` topmost |

## Part C: the bindings package

Every export of `@n1h/sweetview-webview-bun` (2.x, up to 2.8.0) and what an
application imports instead. `@n1h/sweetview/native` exports the same names
for an application that depends on `@n1h/sweetview`.

### `@n1h/sweetview-webview-bun`

| Old | Write now | Change |
|---|---|---|
| `Feature` | `import { Feature } from "@n1h/sweetview-native"`; `Feature.MouseHook === 0`; `Feature.KeyboardHook === 1` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `FileDropHandler` | `import type { FileDropHandler } from "@n1h/sweetview-native"` | unchanged |
| `KeyEvent` | `import { KeyEvent } from "@n1h/sweetview-native"`; `KeyEvent.Down === 0`; `KeyEvent.Up === 1`; `KeyEvent.Repeat === 2` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `KeyHandler` | `import type { KeyHandler } from "@n1h/sweetview-native"` | unchanged |
| `KeyMessage` | `import type { KeyMessage } from "@n1h/sweetview-native"` | unchanged |
| `KeyboardHook` | `import type { KeyboardHook } from "@n1h/sweetview-native"` | unchanged |
| `Modifier` | `import { Modifier } from "@n1h/sweetview-native"`; `Modifier.Shift === 1`; `Modifier.Control === 2`; `Modifier.Alt === 4`; `Modifier.Meta === 8` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `Modifiers` | `import type { Modifiers } from "@n1h/sweetview-native"` | unchanged |
| `MouseEvent` | `import { MouseEvent } from "@n1h/sweetview-native"`; `MouseEvent.Move === 0`; `MouseEvent.LeftDown === 1`; `MouseEvent.LeftUp === 2`; `MouseEvent.RightDown === 3`; `MouseEvent.RightUp === 4`; `MouseEvent.MiddleDown === 5`; `MouseEvent.MiddleUp === 6`; `MouseEvent.Wheel === 7` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `MouseHandler` | `import type { MouseHandler } from "@n1h/sweetview-native"` | unchanged |
| `MouseHook` | `import type { MouseHook } from "@n1h/sweetview-native"` | unchanged |
| `MouseMessage` | `import type { MouseMessage } from "@n1h/sweetview-native"` | unchanged |
| `Permission` | `import { Permission } from "@n1h/sweetview-native"`; `Permission.DeviceControl === 1`; `Permission.InputMonitoring === 2` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `PermissionStatus` | `import type { PermissionStatus } from "@n1h/sweetview-native"` | unchanged |
| `RequestHandler` | `import type { RequestHandler } from "@n1h/sweetview-native"` | unchanged |
| `Size` | `import type { Size } from "@n1h/sweetview-native"` | unchanged |
| `SizeHint` | `import { SizeHint } from "@n1h/sweetview-native"`; `SizeHint.NONE === 0`; `SizeHint.MIN === 1`; `SizeHint.MAX === 2`; `SizeHint.FIXED === 3` | an ordinary `enum` now (it was a `const enum`): its members are values at run time |
| `WEBVIEW_VERSION` | `import { WEBVIEW_VERSION } from "@n1h/sweetview-native"`; `WEBVIEW_VERSION === "0.12.0"` | unchanged: the C API version whose calls and error codes the class keeps |
| `Webview` | `import { Webview } from "@n1h/sweetview-native"`; `new Webview(debug, size, window)` | the same class; the members that changed are in the next table |
| `WebviewError` | `import { WebviewError } from "@n1h/sweetview-native"`; `new WebviewError(fn, code)` | unchanged |
| `WebviewRequest` | `import type { WebviewRequest } from "@n1h/sweetview-native"` | unchanged |
| `WebviewResponse` | `import type { WebviewResponse } from "@n1h/sweetview-native"` | unchanged |
| `WebviewResponseHead` | `import type { WebviewResponseHead } from "@n1h/sweetview-native"` | unchanged |
| `beginWebviewResponse` | `import { beginWebviewResponse } from "@n1h/sweetview-native"`; `beginWebviewResponse(handle, id, head)` | `handle` is the opaque number of `Webview.unsafeHandle`, not a pointer; still callable from any thread |
| `completeWebviewRequest` | `import { completeWebviewRequest } from "@n1h/sweetview-native"`; `completeWebviewRequest(handle, id, response)` | `handle` is the opaque number of `Webview.unsafeHandle`, not a pointer; still callable from any thread |
| `endWebviewResponse` | `import { endWebviewResponse } from "@n1h/sweetview-native"`; `endWebviewResponse(handle, id)` | `handle` is the opaque number of `Webview.unsafeHandle`, not a pointer; still callable from any thread |
| `installKeyboardHook` | `import { installKeyboardHook } from "@n1h/sweetview-native"`; `installKeyboardHook(handler)` | unchanged; installed and disposed of on the UI thread |
| `installMouseHook` | `import { installMouseHook } from "@n1h/sweetview-native"`; `installMouseHook(handler)` | unchanged; installed and disposed of on the UI thread |
| `modifiersFrom` | `import { modifiersFrom } from "@n1h/sweetview-native"`; `modifiersFrom(bits)` | unchanged |
| `permissions` | `import { permissions } from "@n1h/sweetview-native"` | unchanged |
| `unload` | `import { unload } from "@n1h/sweetview-native"`; `unload()` | destroys every live webview; there is no library to unload |
| `writeWebviewResponseChunk` | `import { writeWebviewResponseChunk } from "@n1h/sweetview-native"`; `writeWebviewResponseChunk(handle, id, chunk)` | `handle` is the opaque number of `Webview.unsafeHandle`, not a pointer; still callable from any thread |

### `Webview` members that changed

Every other member keeps its name, signature and behaviour.

| Old | Write now | Change |
|---|---|---|
| `unsafeHandle` | `import { Webview } from "@n1h/sweetview-native"`; `Webview#unsafeHandle` | an opaque number that names the webview to the worker functions; not a pointer, do not pass it to `bun:ffi` |
| `unsafeWindowHandle` | `import { Webview } from "@n1h/sweetview-native"`; `Webview#unsafeWindowHandle` | still the real `HWND` (the `NSWindow` pointer on macOS), as a number; `null` once the webview is destroyed |
| `constructor(handle)` | `import { Webview } from "@n1h/sweetview-native"`; `new Webview(handle)` | takes the number `unsafeHandle` gave and wraps that live webview; it no longer sets the default 1024x768 size on its window; a number that names no live webview throws `WebviewError` with `fn` `webview_create` and `code` -1 |
| `destroy()` | `import { Webview } from "@n1h/sweetview-native"`; `Webview#destroy` | still the one teardown (the class has no `terminate`); it ends a `run()` only while this webview's own `run()` is in progress; afterwards `unsafeHandle` is `null`, and `completeRequest`, `setRequestHandler` and the worker functions given its old handle throw `WebviewError` code -3 (`WEBVIEW_ERROR_INVALID_STATE`); a second `destroy()` does nothing |
| `constructor(debug, size, window)` | `import { Webview } from "@n1h/sweetview-native"`; `new Webview(debug, size, window)` | `window` is a `WindowHandle` (number, bigint or `bun:ffi` pointer) |
| `bindRaw(name, callback, arg)` | `import { Webview } from "@n1h/sweetview-native"`; `Webview#bindRaw(name, callback, arg)` | `arg` is any value, handed back to the callback as it is; it was a pointer |

## Added since `v1-drafting`

These are new, so nothing upgrades to them: `@n1h/sweetview-ipc-electron`
and `@n1h/sweetview-ipc-tauri` (also as `@n1h/sweetview/ipc-electron` and
`@n1h/sweetview/ipc-tauri` with their `/client`, `/preload` and `/server`
subpaths), and `@n1h/sweetview-native/shell-icons`. See the [reference](README.md).
