# Sweetview v1.0 Implementation & Audit Fix Checklist

Source: `docs/audit-and-v1-plan.md`, `docs/v1-api.md`, and the user's v1.0 directive on branch `v1-drafting`.

## Acceptance criteria

- [x] **AC1: Worker IPC never hangs RPC callers and native webview library loading does not leak `dlopen` handles (Audit 2.4, 2.8)**
  - [x] Wrap `JSON.stringify` and `ring.write` in `packages/sweetview/src/worker.ts` so oversized (`> ringBytes - 4`) or unserializable (`BigInt`, circular) return values emit `{ kind: "reply", seq, ok: false, error }` instead of dropping replies
  - [x] Cache `dlopen` handles per `libPath` in `packages/sweetview/src/webview-lib.ts` and reuse from `packages/sweetview/src/app.ts`
  - [x] Add unit tests in `packages/sweetview/src/worker.test.ts` and `packages/sweetview/src/webview-lib.test.ts` covering oversized replies, unserializable replies, subsequent healthy calls, and `dlopen` caching
  - [x] verify: `bun test packages/sweetview/src/worker.test.ts packages/sweetview/src/ring.test.ts packages/sweetview/src/webview-lib.test.ts` passes with real oversized and circular return values rejecting cleanly

- [x] **AC2: Leaf subpaths match v1.0 API surface and naming (`dispose()`, `SettingsStore`, `HitRelay`, `dotIco`, `sweetview:` prefix)**
  - [x] Rename `.close()` to `.dispose()` on `memoryTransport` (`packages/sweetview-ipc/src/memory.ts`), `wsHost` (`packages/sweetview-ipc-ws/src/server.ts`), and `wsTransport` (`packages/sweetview-ipc-ws/src/client.ts`)
  - [x] Add `SettingsStore` class alongside `createSettingsStore` in `packages/sweetview-settings/src/settings-store.ts`
  - [x] Rename `dotIcon` to `dotIco` in `packages/sweetview-native/src/icon.ts`
  - [x] Add `HitRelay` class with `isEnabled()` alongside `createHitRelay` in `packages/sweetview-native/src/hit-regions.ts`
  - [x] Replace `sweetnative:` error/runtime prefixes with `sweetview:` across `packages/sweetview-native/src/`
  - [x] Update unit tests for `ipc`, `ipc-ws`, `settings-store`, `icon`, `hit-regions`
  - [x] verify: `bun test packages/sweetview-ipc/src packages/sweetview-ipc-ws/src packages/sweetview-settings/src/settings-store.test.ts packages/sweetview-native/src/icon.test.ts packages/sweetview-native/src/hit-regions.test.ts` passes and `rg "sweetnative:" packages/` returns zero matches

- [x] **AC3: Standalone `Screen`, `Menu.popup`, `Tray`, `Notifier`, `setAppMenu`, and `pickFolder` work cleanly with shared DPI/startup init (Audit 2.5, 2.6, 2.10, 2.12)**
  - [x] Win32: add shared idempotent `ensureWin32Init()` calling `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` + `ensureFirstWindowIsHidden()` invoked by `Screen`, `Window`, `createMessageWindow()`, and `WebView`; deduplicate `ole32.dll` in `win32/folder-picker.ts`
  - [x] macOS: add shared `sharedApp()` init called by `Screen` and `Window`
  - [x] Implement `Screen` (`primary`, `all`, `at`, `of`, `bounds`, `cursor`) on Win32 and macOS
  - [x] Export `Menu.popup(owner, menu, at?)` from `@n1h/sweetview/native` on Win32 and macOS
  - [x] Export `Tray` class + `createTray`, rename `installAppMenu` to `setAppMenu`, update `pickFolder` to accept `Window | WindowHandle | null`
  - [x] Export `Notifier` class + `createNotifier`:
    - [x] Win32: decouple `Notifier` from requiring `Tray` first (create its own fallback notification host when no tray exists) and guard/track notification click payloads cleanly
    - [x] macOS: register `UNUserNotificationCenter` delegate eagerly in `Notifier` constructor and reuse/dispose ObjC targets instead of leaking class pairs and blocks per instance
  - [x] Add Win32 FFI tests for `ensureWin32Init` (including tray-before-window DPI awareness), `Screen.*`, `Menu.popup`, and standalone `Notifier` without tray
  - [x] verify: `bun test packages/sweetview-native/src/` passes on Windows with live Win32 `Screen`, `Menu`, `Tray`, and `Notifier` FFI checks

- [x] **AC4: Unified `Window` and `createWindow` replace `NativeWindow` + `Overlay` with clean disposal, events, and multi-monitor/macOS fixes (Audit 2.1, 2.2, 2.3, 2.7, 2.9)**
  - [x] Replace `NativeWindow`, `Overlay`, `createOverlayWindow`, `makeOverlay`, `nativeWindow` with `Window`, `createWindow`, `Window.fromHandle`; remove deprecated `dark` flag
  - [x] Win32 `Window`:
    - [x] Idempotent `dispose()` destroying HWND and clearing `resizers`, `hits`, `followsSystem`, `windowIcons`, subclass handlers, and hit timer
    - [x] Default `WM_CLOSE` closes and disposes the window unless `onClose` intercepts; `WM_DESTROY` no longer unconditionally calls `PostQuitMessage(0)`
    - [x] Wire multi-listener `onResize`, `onMove`, `onClose` with FFI-safe exception handling and unsubscribe thunks
    - [x] Fix `isMaximized()` (`IsZoomed` for framed, restore state for frameless) and `toggleMaximize()` (`SW_MAXIMIZE`/`SW_RESTORE` for framed, `Screen.of(win).workArea` for frameless); cache `bounds()` in drag-resize tick
    - [x] Kill hit-region timer on `hide()` and `dispose()`
  - [x] macOS `Window`:
    - [x] Consistent outer-frame `bounds` on creation (`contentRectForFrameRect:styleMask:` / hidden `setFrame:display:`), `bounds()`, and `setBounds()`
    - [x] Honor `topmost`, `opacity`, `transparent`, `hideFromTaskbar`, and `noActivate` regardless of `frame`
    - [x] Implement drag-resize loop in `startResize(edge)`
    - [x] Intercept `onClose` cleanly for Cmd+W, programmatic `performClose:`, and frameless windows without replacing `webview/webview`'s delegate on `Window.fromHandle`
    - [x] Wire `onResize` and `onMove` via `NSNotificationCenter` and remove observers in `dispose()`
    - [x] Invalidate and release the 10ms hit-region `NSTimer` when `hits.size === 0` or on `dispose()`
    - [x] Idempotent `dispose()` closing/releasing `NSWindow` and cleaning `hits`, `ignoring`, observers, and timers
  - [x] Update `packages/sweetview/src/window-chrome.ts`: `windowChromeMethods(win, { chrome, onClose })` and `win.isMaximized()`
  - [x] Add live Win32 `Window` FFI tests (`packages/sweetview-native/src/win32/window.test.ts`): multi-window close without killing loop, idempotent `dispose()`, `onClose`/`onResize`/`onMove`, `toggleMaximize()`/`isMaximized()`, `Window.fromHandle`
  - [x] verify: `bun test packages/sweetview-native/src/win32/` passes all new Window FFI assertions on Windows

- [x] **AC5: `WebView`, `createApp`, and `RawWebview` work for single-window, overlay, and menubar apps, and all 4 non-tab demos run and compile on v1**
  - [x] Implement `WebView` (`WebView.attach`, `emit`, `notify`, `onEvent`, `run`, `quit`, `dispose`) reading geometry, scale, title, resizable, and transparent from `Window`
  - [x] Implement `createApp` Layer 2 helper and re-export `RawWebview` from `packages/sweetview/src/index.ts`
  - [x] Migrate `demos/web-app`, `demos/desktop-pet`, `demos/menubar-only`, `demos/menubar-notify` to v1 API
  - [x] verify: `just check` passes, `just compile` builds all 4 demos (Windows `.exe` and macOS `.app`), and Windows probe scripts pass

- [x] **AC6: Native Tabs promoted cleanly out of `demos/native-tabs/` into `packages/sweetview-native/src/` (webview-free) and `packages/sweetview/src/tabs/` (webview-aware) (Audit 2.11)**
  - [x] Keep `@n1h/sweetview/native` webview-free: move Win32 tab frame/panes/system-menu, `win-shortcuts.ts`, and `strip-shared.ts` into `packages/sweetview-native/src/win32/` (using `Screen` and `Menu.popup`) and macOS `NSWindow` tabbing primitives into `packages/sweetview-native/src/darwin/` (fixing hardcoded ObjC class names)
  - [x] Move webview-dependent tab pieces (`win-webview2.ts`, embedded strip webview + self-contained asset bundling, macOS `WKWebView` hooks, and cross-platform `Tab` / `WebView.openTab` / `createApp({ tabs: true })` coordinator) into `packages/sweetview/src/tabs/`
  - [x] Support `Window({ tabs: true })`, `onNewTab`, `onTabSelect`, `onTabClose`, `WebView.openTab`, `Tab` (`select`, `close`, `setTitle`, `moveToNewWindow`, `dispose`), and `app.mergeAllWindows()`
  - [x] Rewrite `demos/native-tabs/app.ts` onto the built-in tabs API and keep unit tests + Windows drive/capture scripts working
  - [x] verify: `just check` passes, `@n1h/sweetview/native` imports zero webview modules, and `demos/native-tabs/scripts/win-drive.ts` passes against the migrated tabbed app on Windows

- [x] **AC7: Documentation and macOS verification handoff are accurate and complete**
  - [x] Update `README.md` and `docs/*.md` (`app.md`, `native.md`, `ipc.md`, `ipc-ws.md`, `settings-store.md`, `window-chrome.md`, `README.md`, `v1-api.md`, `audit-and-v1-plan.md`) to match v1.0.0 and remove machine-local paths
  - [x] Write concrete macOS verification steps in `docs/v1-macos-verification.md` (and include in the final done-report) for Mac agents to execute
  - [x] verify: `just check`, `just compile`, and `just pack` succeed cleanly on Windows with zero stale `0.2.x` export errors

- [x] **AC8: Workspace package split into `packages/*` with legacy root source directory removed (Plan Section 1)**
  - [x] Split the former root source tree into 6 workspace packages: `@n1h/sweetview-ipc` (`packages/sweetview-ipc`), `@n1h/sweetview-ipc-ws` (`packages/sweetview-ipc-ws`), `@n1h/sweetview-settings` (`packages/sweetview-settings`), `@n1h/sweetview-native` (`packages/sweetview-native`), `@n1h/sweetview-build` (`packages/sweetview-build`), and `@n1h/sweetview` (`packages/sweetview`)
  - [x] Delete the legacy root source directory (`Test-Path src` is `False`) and convert root `package.json` to a private workspace root
  - [x] Keep all 13 `@n1h/sweetview` subpath exports working and update `tsconfig.json`, `justfile`, and `demos/*`
  - [x] verify: `just check`, `just compile`, `just pack`, browser bundle check, and `just demos native-tabs drive` all pass cleanly

- [x] **AC9: Chunked ring framing for large IPC payloads (Audit 2.8)**
  - [x] Support transparent chunked framing in `packages/sweetview-ipc/src/frame.ts`, `packages/sweetview/src/worker.ts`, and `packages/sweetview/src/app.ts` so valid JSON replies and events larger than `ringBytes - 4` (e.g. > 1 MB) reassemble cleanly on the UI thread instead of failing, while unserializable replies still fall back to a clamped error reply
  - [x] Add unit tests in `packages/sweetview/src/worker.test.ts` covering chunked multi-frame replies/events, tiny-ring fallback, and unserializable replies
  - [x] verify: `bun test packages/sweetview/src/worker.test.ts packages/sweetview/src/ring.test.ts` passes and browser-safe bundle of `@n1h/sweetview/page` pulls zero Bun/FFI code

- [x] **AC10: Custom URL schemes, single-instance lock & handoff, and unified activation pipeline (Plan Section 4)**
  - [x] Implement Windows HKCU protocol registration (`registerUrlScheme`, `unregisterUrlScheme`), `CreateMutexW` single-instance lock, and `WM_COPYDATA` + `AllowSetForegroundWindow` handoff in `packages/sweetview-native/src/win32/activation.ts`
  - [x] Add startup retry on Windows `FindWindowExW` race and upgrade macOS `packages/sweetview-native/src/darwin/activation.ts` to native CoreFoundation `CFMessagePort` (runs inside `NSApp.run()` with zero sockets / zero `node:net`)
  - [x] Implement macOS `makeMacApp({ urlSchemes })` `CFBundleURLTypes` plist generation in `packages/sweetview-build/src/build.ts` (+ `--url-scheme` in `packages/sweetview-build/src/make-app.ts`) and `NSAppleEventManager` `kInternetEventClass`/`kAEGetURL` handler
  - [x] Implement unified activation pipeline (`registerUrlScheme`, `unregisterUrlScheme`, `singleInstance`, `onOpenUrl`, `signalReady`, `extractUrlFromArgs`) with cold-launch event buffering until `signalReady()` in `packages/sweetview-native/src/activation.ts`
  - [x] Add live Windows FFI tests (`packages/sweetview-native/src/win32/activation.test.ts`) for HKCU scheme registration + cleanup, real two-process `WM_COPYDATA` single-instance handoff, and buffered `onOpenUrl` -> `signalReady()` drain, plus `CFBundleURLTypes` tests in `packages/sweetview-build/src/build.test.ts`
  - [x] verify: `bun test packages/sweetview-native/src/win32/activation.test.ts packages/sweetview-build/src/build.test.ts` passes on Windows and zero `node:net` remains in `sweetview-native`

- [x] **AC11: Shell architecture improvements from `delightful-qt-web-shell` (Plan Section 5)**
  - [x] Opt-in ready handshake + native main-loop startup watchdog (`scheduleNativeTimeout`): page `signalReady()` in `packages/sweetview/src/page.ts`, host `__sweetview.ready` handling, `readyTimeoutMs`, `onReady`, `onReadyTimeout`, `readyFallbackHtml`, `showOnReady` in `packages/sweetview/src/app.ts`
  - [x] Close-to-tray only on last visible window: `Window.visibleWindows()` and `closeToTrayOnLastWindow` helper in `packages/sweetview-native/src/window.ts`
  - [x] Deferred modal OS dialogs off synchronous bridge callback: `deferredUiMethods` on `WebViewOptions` scheduled onto the next native UI tick via `webview_dispatch` (never re-entering the active RPC callback)
  - [x] Three-tier native file access (`readTextFile`, `readFileBytes`, `openFileHandle`, `readFileChunk`, `closeFileHandle`, `closeAllFileHandles`), native `Clipboard` (`readText`, `writeText`, `clear` on Win32 + macOS), and OS drag-and-drop file paths (`Window.onFileDrop` via Win32 `WM_DROPFILES` + macOS `NSWindow` drag destination)
  - [x] Unified `defineAppIdentity` (`AppIdentity`) shared across `SettingsStore`, `singleInstance`, `registerUrlScheme`, `Window`, and `makeMacApp`
  - [x] Add tests (`packages/sweetview-native/src/fs.test.ts`, `packages/sweetview-native/src/clipboard.test.ts`, `packages/sweetview-settings/src/app-identity.test.ts`, `packages/sweetview/src/app.test.ts`, `packages/sweetview-native/src/win32/window.test.ts`) verifying all capabilities
  - [x] verify: `just check`, `just compile`, `just pack`, and `just demos native-tabs drive` all pass cleanly on Windows

- [ ] **AC12: Native dynamic request handler, second cross-origin (`frames`), and external drop control across `sweetview-webview`, `sweetview-webview-bun`, and `sweetview` (Plan Section 3 Option B)**
  - [x] `n0t-invented-here/sweetview-webview` (branch `v1-drafting`): add `webview_set_request_handler`, `webview_complete_request` (async `ICoreWebView2Deferral` on Windows + `WKURLSchemeTask` with `stopURLSchemeTask:` cancellation on macOS), second cross-origin (`http://frames.webview.localhost` / `webview-frames://localhost`), and `webview_set_allow_external_drop` (`ICoreWebView2Controller4::put_AllowExternalDrop`)
  - [x] `n0t-invented-here/sweetview-webview-bun` (branch `v1-drafting`): expose `framesOrigin`, `setRequestHandler` / `completeRequest`, and `setAllowExternalDrop`. The Windows C++ build, `build/libwebview.dll`, and Bun bindings are built and verified on the `v1-drafting` checkouts with zero TCP ports.
  - [x] `n0t-invented-here/sweetview` (branch `v1-drafting`): wire native dynamic `onRequest`, `FRAMES_ORIGIN`, and `allowExternalDrop` with no sockets. Verify static precedence, worker HTML and POST routes, dynamic images, binary ring chunking, iframe isolation, and shutdown in live WebView2.
  - [x] verify: `sweetview-webview` builds cleanly on Windows, `sweetview-webview-bun` live WebView2 test passes, and `sweetview` end-to-end zero-TCP dynamic request + frames origin tests pass
  - [ ] Rebuild macOS `build/libwebview.dylib` and Linux `build/libwebview-x64.so` in `n0t-invented-here/sweetview-webview-bun` (`v1-drafting`, submodule already pinned to the final reviewed `sweetview-webview` commit) and verify the artifacts on their target platforms. See [macOS and Linux verification](v1-macos-verification.md).
  - [ ] After the macOS and Linux builds and verification, publish `@n1h/sweetview-webview-bun@2.8.0` to npm. Then raise `sweetview`'s `^2.7.0` dependency ranges to `^2.8.0`, refresh `bun.lock`, and re-run the live Windows and macOS request tests against the published package.

- [x] **AC13: Updated docs and macOS/Linux verification instructions**
  - [x] Update `README.md`, `docs/README.md`, `docs/app.md`, `docs/native.md`, `docs/page.md`, `docs/build.md`, `docs/settings-store.md`, `docs/worker.md`, `docs/webview-library.md`, and `docs/v1-macos-verification.md` (including macOS `libwebview.dylib` and Linux `libwebview-x64.so` rebuild steps for `sweetview-webview-bun` on `v1-drafting`)

- [x] **AC14: Native streaming and WebView surface drops work through the Sweetview facade on Windows**
  - [x] Worker routes send chunks through native interception with zero TCP and without buffering the whole body on either Sweetview thread when the DLL supports streaming.
  - [x] The frame tests verify ordering, oversized chunk splitting, and reader failure. A live WebView2 receives all three chunks, first reads the response after EOF, and shuts down with a separate stream still open.
  - [x] The previous Windows DLL, which exports request completion but lacks the streaming and surface-drop symbols, passes the live worker routes using the completion fallback.
  - [x] Live WebView2 verifies subscriptions before and after attachment, removal of the last listener, a Unicode file path delivered by `ICoreWebView2File`, and disposal with a listener still installed.
  - [x] The references describe the WebView2 EOF limit, IPC push, WKWebView streaming and drop paths, iframe RPC guards, and WinRT AUMID registration and balloon fallback.
  - [x] verify: `just check` passes with 163 passed, 4 skipped, and 0 failed, including the Windows notification tests. `bun build packages/sweetview/src/page.ts --target=browser`, `just compile`, `just pack`, and `just demos native-tabs drive` also pass.
  - [ ] Verify live WKWebView streaming and Finder drops on the rebuilt library. See [macOS verification](v1-macos-verification.md#4-macos-activation-startup-and-request-routes).

## Review passes

- [x] Native streaming and drops verified against both Windows DLLs. The current DLL exercised chunk delivery, EOF timing, active-stream shutdown, and the real WebView2 drop callback. The previous DLL exercised the UI-thread buffering fallback. Typecheck caught an overly narrow typed-array parameter in the frame writer, which was corrected before the final gates.

- [x] Adversarial review pass 1 against real built artifacts, test outputs, GUI probe outputs, and diff against `main` (pass 1)
  - Finding 1 (AC1): `writeWorkerFrame` clamped by UTF-16 length rather than JSON-escaped UTF-8 byte length (overflowing on quotes/NUL/multibyte) and `WebView.attach` allowed tiny `ringBytes` (e.g. `32`) too small for a JSON error reply. Fixed: exact byte-length binary search clamping in `packages/sweetview/src/worker.ts` + minimum `ringBytes >= 128` validation in `packages/sweetview/src/app.ts` + regression tests in `packages/sweetview/src/worker.test.ts` and `packages/sweetview/src/app.test.ts`.
  - Finding 2 (AC4, AC5): `WebView.attach` passed outer-frame bounds to `RawWebview` whose `webview_set_size` grew framed Windows windows by titlebar/borders (`640x480` -> `656x519`). Fixed: restore exact outer `winBounds` on owned windows right after `RawWebview` creation in `packages/sweetview/src/app.ts` + live test in `packages/sweetview/src/app.test.ts`.
  - Finding 3 (AC4): Disposing a borrowed `Window.fromHandle` wrapper wiped the owner's `onClose` listener and shared HWND state. Fixed: per-wrapper `localUnsubs` and `ownsHitState` tracking in `packages/sweetview-native/src/win32/window.ts` and `packages/sweetview-native/src/darwin/window.ts` + live Win32 test in `packages/sweetview-native/src/win32/window.test.ts`.
  - Finding 4 (AC4, AC6): Calling `win.dispose()` directly on a Layer 1 tabbed `Window({ tabs: true })` left child tab webviews undisposed and allowed stale `openTab` calls to fail with Win32 error 1400. Fixed: added webview-free `onWindowDispose` / `isWindowDisposed` internal hooks in `packages/sweetview-native/src/window.ts` wired into `packages/sweetview/src/tabs/win-tabs.ts` and `packages/sweetview/src/tabs/darwin-tabs.ts` + live test in `packages/sweetview/src/app.test.ts`.
  - Finding 5 (AC3): macOS `Notifier` used a single `activeHandler` slot, overwriting earlier notifiers and clearing the delegate while other notifiers were still alive. Fixed: per-notification-id ownership map and `liveNotifiers` set in `packages/sweetview-native/src/darwin/notifier.ts`.
  - Finding 6 (AC4, AC7): macOS `Window.fromHandle().onClose` on foreign `NSWindow`s only retargets the close button (not `Cmd+W` / borderless foreign windows) without clobbering `delegate`. Fixed: when wrapping an owned Sweetview window via `Window.fromHandle`, reuse subclass `performClose:`; documented the foreign-window caveat accurately in `docs/native.md` and `docs/v1-api.md`.
  - Finding 7 (AC4, AC6): macOS tabs called `makeKeyAndOrderFront:` during `openTab` before `window.show()` and never forwarded `NSWindowDidResizeNotification` / `NSWindowDidMoveNotification` to the virtual `Window` controller. Fixed: queue pending tabs until `window.show()` and wire resize/move notifications in `packages/sweetview-native/src/darwin/tabs.ts` and `packages/sweetview/src/tabs/darwin-tabs.ts`.
  - Finding 8 (AC2, AC7): `package.json` still emitted `0.2.2`, `docs/ipc.md` overstated `memoryTransport.dispose()` repeat calls, and `demos/native-tabs/scripts/mac-drive.ts` did not cover all checks claimed in `docs/v1-macos-verification.md`. Fixed: bumped `package.json` to `1.0.0`, updated `docs/ipc.md`, expanded `mac-drive.ts` with responder-chain `newWindowForTab:`, resize event, unreachable-site fallback, screenshot capture, and detach/merge assertions, and aligned `docs/v1-macos-verification.md`.
  - Finding 9 (Scope check): `apm.yml` change came from pre-existing branch commit `adf4c74` ("APM manager change") on `v1-drafting` prior to our v1 work; APM-managed files must not be edited or reverted per repo rules.
- [x] Adversarial review pass 2 (only if pass 1 had findings) (pass 2)
  - Finding 1 (AC1, AC5): Failed `WebView.attach` called `raw.destroy()` without `discardQuit()`, leaving a queued `WM_QUIT` that caused subsequent attaches to fail. Fixed: call `discardQuit()` in `WebView.attach` error catch block (`packages/sweetview/src/app.ts`) + live test in `packages/sweetview/src/app.test.ts`.
  - Finding 2 (AC4, AC6): Closing a Windows tabbed `Window` via `WM_CLOSE` with no `onClose` listener invoked backend `dispose()` directly, bypassing outer `Window.dispose()` hooks so child tab webviews leaked. Fixed: wired `WindowBackend.setOwnerDispose` from `Window` constructor into `win32/window.ts` and `darwin/window.ts` so default close runs outer `Window.dispose()` + live test in `packages/sweetview/src/app.test.ts`.
  - Finding 3 (AC1): `WebView.attach` `ringBytes` guard only checked `>= 128`, letting non-power-of-two / `> 2^30` values fail late after creating the webview. Fixed: full power-of-two `128..2^30` validation upfront before `new RawWebview` + test in `packages/sweetview/src/app.test.ts`.
  - Finding 4 & Finding 5 (AC4, AC5): On Windows, `WebView.attach` onto a `Window.fromHandle` wrapper or a `frame: false, resizable: true` window let upstream `webview_set_size` mutate `GWL_STYLE` (`WS_THICKFRAME | WS_MAXIMIZEBOX`) and expand bounds. Fixed: pass `SizeHint.FIXED` for frameless windows and snapshot/restore exact `GWL_STYLE`, `GWL_EXSTYLE`, outer bounds, and child layout via `preserveWindowGeometry` in `packages/sweetview-native/src/win32/window.ts` + live tests in `packages/sweetview/src/app.test.ts`.
  - Finding 6 (AC4, AC5, AC7): Disproved against our fork (`n0t-invented-here/sweetview-webview` branch `sweetview` patches `webview_set_size` on macOS to be a no-op for caller-provided windows, documented in `docs/webview-library.md:37-39`). Added an explicit frameless `styleMask === 0` check to `docs/v1-macos-verification.md` so macOS agents confirm it live.
  - Finding 7 (AC3): macOS `Notifier.dispose()` deleted owner IDs so later clicks on disposed or handler-less notifiers could fall through to another live notifier, and the ID map was unbounded. Fixed: bounded `sentByThisProcess` map (max 256 entries) with `null` tombstones on `dispose()` in `packages/sweetview-native/src/darwin/notifier.ts`.
  - Finding 8 (AC4, AC6): On macOS tabs, closing the last tab with no `onClose` listener did not dispose the host, and `createApp({ tabs: true })` did not auto-quit when `onClose` was omitted. Fixed: default dispose on last-tab close in `packages/sweetview/src/tabs/darwin-tabs.ts` and default `onClose` auto-quit in `packages/sweetview/src/app.ts` `createApp({ tabs: true })`.
  - Finding 9 (AC6): macOS `tab.moveToNewWindow()` before `show()` flushed unrelated hidden tabs and returned a non-tabbed `Window.fromHandle`. Fixed: detach only the target tab and return a real tabbed `Window({ tabs: true })` bound to a detached `MacTabHost` sharing the tabbing group in `packages/sweetview/src/tabs/darwin-tabs.ts`, updated `demos/native-tabs/scripts/mac-drive.ts`.
- [x] Adversarial review Pass 3A covered `sweetview-webview` and `sweetview-webview-bun`.
  - Findings 1 and 5 covered request completion racing teardown and ownership of queued Windows dispatch callbacks. The C++ fix tracks live webviews, guards queued completions with an invalidated lifetime flag, and owns and clears the Windows dispatch queue. The rebuilt Windows DLL passed 26 C++ tests and 2 Bun binding tests. The Cocoa teardown path awaits a macOS build and live verification.
  - Findings 2, 6, 9, and 10 covered Windows Service Worker interception and fail-closed responses, COM ownership, failed body-stream reads on both platforms, and oversized Windows responses. The fix registers all available WebView2 request source kinds, uses a minimal HTTP 500 fallback and scoped resource ownership, rejects failed reads, and checks the body size before copying.
  - Findings 4 and 11 covered Bun FFI buffer lifetime and request-handler examples and shutdown guidance. The bindings pass typed arrays directly to FFI and document the synchronous callback, worker completion pattern, and platform-specific teardown.
  - Findings 7 and 8 covered malformed response-header JSON and Cocoa header handling. The C++ fix validates JSON, Unicode, and HTTP headers before dispatch. Cocoa groups headers case-insensitively and keeps the first `Set-Cookie` value, as documented in the companion repos.
- [x] Adversarial review Pass 3B covered the Sweetview workspace and AC8–AC13.
  - Findings 1 and 2 identified the `^2.7.0` dependency and the older macOS dylib as release blockers. The open AC12 items track the companion builds, npm publish, and dependency update.
  - Finding 3 identified the request-handler tests assuming that an explicit or sibling library had the new symbols. The live tests now probe the resolved library for both request symbols before launching a fixture.
  - Finding 4 identified unchecked `WM_COPYDATA` payloads. Both native receivers use the same `SecondInstanceEvent` validator, with unit coverage for malformed JSON, invalid fields, and valid messages.
  - The file-drop flag identified possible interception by WebView2 or WKWebView. The app and native references now describe window and webview drop routing. The [live Finder probe](v1-macos-verification.md#drop-over-wkwebview) measures delivery over the page on macOS.
- [x] Verification passes 4A, 4B, and 5A verified all Pass 3A/3B/4A fixes across all three repositories.
  - Pass 4B (`sweetview` at `5cf3ca3`): CLEAN — zero remaining code findings (`just check` 159 pass / 4 skip / 0 fail; `just pack` all 6 packages).
  - Pass 4A and Pass 5A (`sweetview-webview` and `sweetview-webview-bun`): caught and fixed process-wide monotonic `request_id` generation, fail-closed deferral completion and `m_controller->Close()` teardown ordering, `m_submitted_requests` protection so a throwing native handler cannot clobber a submitted response (Win32 and macOS), `com_ptr` COM release and init wait-loop failure signaling, Windows-only Service Worker test gating, and `Webview.completeRequest()` throwing `-3` after `destroy()`. Rebuilt Windows `libwebview.dll` with zero `/W4` warnings, 26/26 C++ tests passing, and 45/45 live WebView2 Bun assertions passing.

## Host OS constraint (Windows-only machine)

- macOS live runtime execution of AppKit / WKWebView / `UNUserNotificationCenter` / `NSAppleEventManager` / `CFMessagePort` / `NSPasteboard` / `mac-drive.ts` and native compilation of `libwebview.dylib` (macOS) / `libwebview-x64.so` (Linux) for `sweetview-webview-bun`: this machine runs Windows only; all macOS and Linux C++/TypeScript changes are implemented across all 3 repos on `v1-drafting`, Windows binaries and live GUI tests are built and verified here, and exact macOS/Linux rebuild and verification steps are documented in `docs/v1-macos-verification.md`.
