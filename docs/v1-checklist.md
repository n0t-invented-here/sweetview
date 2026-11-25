# Sweetview v1.0 Implementation & Audit Fix Checklist

Source: `docs/audit-and-v1-plan.md`, `docs/v1-api.md`, and the user's v1.0 directive on branch `v1-drafting`.

## Acceptance criteria

- [x] **AC1: Worker IPC never hangs RPC callers and native webview library loading does not leak `dlopen` handles (Audit 2.4, 2.8)**
  - [x] Wrap `JSON.stringify` and `ring.write` in `src/worker.ts` so oversized (`> ringBytes - 4`) or unserializable (`BigInt`, circular) return values emit `{ kind: "reply", seq, ok: false, error }` instead of dropping replies
  - [x] Cache `dlopen` handles per `libPath` in `src/webview-lib.ts` and reuse from `src/app.ts`
  - [x] Add unit tests in `src/worker.test.ts` and `src/webview-lib.test.ts` covering oversized replies, unserializable replies, subsequent healthy calls, and `dlopen` caching
  - [x] verify: `bun test src/worker.test.ts src/ring.test.ts src/webview-lib.test.ts` passes with real oversized and circular return values rejecting cleanly

- [x] **AC2: Leaf subpaths match v1.0 API surface and naming (`dispose()`, `SettingsStore`, `HitRelay`, `dotIco`, `sweetview:` prefix)**
  - [x] Rename `.close()` to `.dispose()` on `memoryTransport` (`src/ipc/memory.ts`), `wsHost` (`src/ipc-ws/server.ts`), and `wsTransport` (`src/ipc-ws/client.ts`)
  - [x] Add `SettingsStore` class alongside `createSettingsStore` in `src/settings-store.ts`
  - [x] Rename `dotIcon` to `dotIco` in `src/native/icon.ts`
  - [x] Add `HitRelay` class with `isEnabled()` alongside `createHitRelay` in `src/native/hit-regions.ts`
  - [x] Replace `sweetnative:` error/runtime prefixes with `sweetview:` across `src/native/`
  - [x] Update unit tests for `ipc`, `ipc-ws`, `settings-store`, `icon`, `hit-regions`
  - [x] verify: `bun test src/ipc src/ipc-ws src/settings-store.test.ts src/native/icon.test.ts src/native/hit-regions.test.ts` passes and `rg "sweetnative:" src/` returns zero matches

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
  - [x] verify: `bun test src/native/` passes on Windows with live Win32 `Screen`, `Menu`, `Tray`, and `Notifier` FFI checks

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
  - [x] Update `src/window-chrome.ts`: `windowChromeMethods(win, { chrome, onClose })` and `win.isMaximized()`
  - [x] Add live Win32 `Window` FFI tests (`src/native/win32/window.test.ts`): multi-window close without killing loop, idempotent `dispose()`, `onClose`/`onResize`/`onMove`, `toggleMaximize()`/`isMaximized()`, `Window.fromHandle`
  - [x] verify: `bun test src/native/win32/` passes all new Window FFI assertions on Windows

- [x] **AC5: `WebView`, `createApp`, and `RawWebview` work for single-window, overlay, and menubar apps, and all 4 non-tab demos run and compile on v1**
  - [x] Implement `WebView` (`WebView.attach`, `emit`, `notify`, `onEvent`, `run`, `quit`, `dispose`) reading geometry, scale, title, resizable, and transparent from `Window`
  - [x] Implement `createApp` Layer 2 helper and re-export `RawWebview` from `src/index.ts`
  - [x] Migrate `demos/web-app`, `demos/desktop-pet`, `demos/menubar-only`, `demos/menubar-notify` to v1 API
  - [x] verify: `just check` passes, `just compile` builds all 4 demos (Windows `.exe` and macOS `.app`), and Windows probe scripts pass

- [x] **AC6: Native Tabs promoted cleanly out of `demos/native-tabs/` into `src/native/` (webview-free) and `src/` (webview-aware) (Audit 2.11)**
  - [x] Keep `@n1h/sweetview/native` webview-free: move Win32 tab frame/panes/system-menu, `win-shortcuts.ts`, and `strip-shared.ts` into `src/native/win32/` (using `Screen` and `Menu.popup`) and macOS `NSWindow` tabbing primitives into `src/native/darwin/` (fixing hardcoded ObjC class names)
  - [x] Move webview-dependent tab pieces (`win-webview2.ts`, embedded strip webview + self-contained asset bundling, macOS `WKWebView` hooks, and cross-platform `Tab` / `WebView.openTab` / `createApp({ tabs: true })` coordinator) into `src/tabs/`
  - [x] Support `Window({ tabs: true })`, `onNewTab`, `onTabSelect`, `onTabClose`, `WebView.openTab`, `Tab` (`select`, `close`, `setTitle`, `moveToNewWindow`, `dispose`), and `app.mergeAllWindows()`
  - [x] Rewrite `demos/native-tabs/app.ts` onto the built-in tabs API and keep unit tests + Windows drive/capture scripts working
  - [x] verify: `just check` passes, `@n1h/sweetview/native` imports zero webview modules, and `demos/native-tabs/scripts/win-drive.ts` passes against the migrated tabbed app on Windows

- [x] **AC7: Documentation and macOS verification handoff are accurate and complete**
  - [x] Update `README.md` and `docs/*.md` (`app.md`, `native.md`, `ipc.md`, `ipc-ws.md`, `settings-store.md`, `window-chrome.md`, `README.md`, `v1-api.md`, `audit-and-v1-plan.md`) to match v1.0.0 and remove machine-local paths
  - [x] Write concrete macOS verification steps in `docs/v1-macos-verification.md` (and include in the final done-report) for Mac agents to execute
  - [x] verify: `just check`, `just compile`, and `just pack` succeed cleanly on Windows with zero stale `0.2.x` export errors

## Review passes

- [x] Adversarial review pass 1 against real built artifacts, test outputs, GUI probe outputs, and diff against `main` (pass 1)
  - Finding 1 (AC1): `writeWorkerFrame` clamped by UTF-16 length rather than JSON-escaped UTF-8 byte length (overflowing on quotes/NUL/multibyte) and `WebView.attach` allowed tiny `ringBytes` (e.g. `32`) too small for a JSON error reply. Fixed: exact byte-length binary search clamping in `src/worker.ts` + minimum `ringBytes >= 128` validation in `src/app.ts` + regression tests in `src/worker.test.ts` and `src/app.test.ts`.
  - Finding 2 (AC4, AC5): `WebView.attach` passed outer-frame bounds to `RawWebview` whose `webview_set_size` grew framed Windows windows by titlebar/borders (`640x480` -> `656x519`). Fixed: restore exact outer `winBounds` on owned windows right after `RawWebview` creation in `src/app.ts` + live test in `src/app.test.ts`.
  - Finding 3 (AC4): Disposing a borrowed `Window.fromHandle` wrapper wiped the owner's `onClose` listener and shared HWND state. Fixed: per-wrapper `localUnsubs` and `ownsHitState` tracking in `src/native/win32/window.ts` and `src/native/darwin/window.ts` + live Win32 test in `src/native/win32/window.test.ts`.
  - Finding 4 (AC4, AC6): Calling `win.dispose()` directly on a Layer 1 tabbed `Window({ tabs: true })` left child tab webviews undisposed and allowed stale `openTab` calls to fail with Win32 error 1400. Fixed: added webview-free `onWindowDispose` / `isWindowDisposed` internal hooks in `src/native/window.ts` wired into `src/tabs/win-tabs.ts` and `src/tabs/darwin-tabs.ts` + live test in `src/app.test.ts`.
  - Finding 5 (AC3): macOS `Notifier` used a single `activeHandler` slot, overwriting earlier notifiers and clearing the delegate while other notifiers were still alive. Fixed: per-notification-id ownership map and `liveNotifiers` set in `src/native/darwin/notifier.ts`.
  - Finding 6 (AC4, AC7): macOS `Window.fromHandle().onClose` on foreign `NSWindow`s only retargets the close button (not `Cmd+W` / borderless foreign windows) without clobbering `delegate`. Fixed: when wrapping an owned Sweetview window via `Window.fromHandle`, reuse subclass `performClose:`; documented the foreign-window caveat accurately in `docs/native.md` and `docs/v1-api.md`.
  - Finding 7 (AC4, AC6): macOS tabs called `makeKeyAndOrderFront:` during `openTab` before `window.show()` and never forwarded `NSWindowDidResizeNotification` / `NSWindowDidMoveNotification` to the virtual `Window` controller. Fixed: queue pending tabs until `window.show()` and wire resize/move notifications in `src/native/darwin/tabs.ts` and `src/tabs/darwin-tabs.ts`.
  - Finding 8 (AC2, AC7): `package.json` still emitted `0.2.2`, `docs/ipc.md` overstated `memoryTransport.dispose()` repeat calls, and `demos/native-tabs/scripts/mac-drive.ts` did not cover all checks claimed in `docs/v1-macos-verification.md`. Fixed: bumped `package.json` to `1.0.0`, updated `docs/ipc.md`, expanded `mac-drive.ts` with responder-chain `newWindowForTab:`, resize event, unreachable-site fallback, screenshot capture, and detach/merge assertions, and aligned `docs/v1-macos-verification.md`.
  - Finding 9 (Scope check): `apm.yml` change came from pre-existing branch commit `adf4c74` ("APM manager change") on `v1-drafting` prior to our v1 work; APM-managed files must not be edited or reverted per repo rules.
- [x] Adversarial review pass 2 (only if pass 1 had findings) (pass 2)
  - Finding 1 (AC1, AC5): Failed `WebView.attach` called `raw.destroy()` without `discardQuit()`, leaving a queued `WM_QUIT` that caused subsequent attaches to fail. Fixed: call `discardQuit()` in `WebView.attach` error catch block (`src/app.ts`) + live test in `src/app.test.ts`.
  - Finding 2 (AC4, AC6): Closing a Windows tabbed `Window` via `WM_CLOSE` with no `onClose` listener invoked backend `dispose()` directly, bypassing outer `Window.dispose()` hooks so child tab webviews leaked. Fixed: wired `WindowBackend.setOwnerDispose` from `Window` constructor into `win32/window.ts` and `darwin/window.ts` so default close runs outer `Window.dispose()` + live test in `src/app.test.ts`.
  - Finding 3 (AC1): `WebView.attach` `ringBytes` guard only checked `>= 128`, letting non-power-of-two / `> 2^30` values fail late after creating the webview. Fixed: full power-of-two `128..2^30` validation upfront before `new RawWebview` + test in `src/app.test.ts`.
  - Finding 4 & Finding 5 (AC4, AC5): On Windows, `WebView.attach` onto a `Window.fromHandle` wrapper or a `frame: false, resizable: true` window let upstream `webview_set_size` mutate `GWL_STYLE` (`WS_THICKFRAME | WS_MAXIMIZEBOX`) and expand bounds. Fixed: pass `SizeHint.FIXED` for frameless windows and snapshot/restore exact `GWL_STYLE`, `GWL_EXSTYLE`, outer bounds, and child layout via `preserveWindowGeometry` in `src/native/win32/window.ts` + live tests in `src/app.test.ts`.
  - Finding 6 (AC4, AC5, AC7): Disproved against our fork (`n0t-invented-here/sweetview-webview` branch `sweetview` patches `webview_set_size` on macOS to be a no-op for caller-provided windows, documented in `docs/webview-library.md:37-39`). Added an explicit frameless `styleMask === 0` check to `docs/v1-macos-verification.md` so macOS agents confirm it live.
  - Finding 7 (AC3): macOS `Notifier.dispose()` deleted owner IDs so later clicks on disposed or handler-less notifiers could fall through to another live notifier, and the ID map was unbounded. Fixed: bounded `sentByThisProcess` map (max 256 entries) with `null` tombstones on `dispose()` in `src/native/darwin/notifier.ts`.
  - Finding 8 (AC4, AC6): On macOS tabs, closing the last tab with no `onClose` listener did not dispose the host, and `createApp({ tabs: true })` did not auto-quit when `onClose` was omitted. Fixed: default dispose on last-tab close in `src/tabs/darwin-tabs.ts` and default `onClose` auto-quit in `src/app.ts` `createApp({ tabs: true })`.
  - Finding 9 (AC6): macOS `tab.moveToNewWindow()` before `show()` flushed unrelated hidden tabs and returned a non-tabbed `Window.fromHandle`. Fixed: detach only the target tab and return a real tabbed `Window({ tabs: true })` bound to a detached `MacTabHost` sharing the tabbing group in `src/tabs/darwin-tabs.ts`, updated `demos/native-tabs/scripts/mac-drive.ts`.

## Deferred by the user or the request

- macOS live runtime execution of AppKit / WKWebView / `UNUserNotificationCenter` / `mac-drive.ts`: Windows-only host in this session; exact test steps delivered in `docs/v1-macos-verification.md` and final done-report.
- Splitting `src/` into separate workspace packages under `packages/`: deferred follow-on tracked in `docs/audit-and-v1-plan.md` Section 1.
- Zero-TCP virtual HTTP/SSE (`hostHttp` / C++ `webview_set_request_handler` + second origin): deferred follow-on tracked in `docs/audit-and-v1-plan.md` Section 3.
- Custom URL schemes, single-instance handoff, and `delightful-qt-web-shell` shell extras (ready watchdog, deferred modal dialogs, 3-tier native file/clipboard/drag-drop APIs, unified app identity config): deferred follow-on tracked in `docs/audit-and-v1-plan.md` Sections 4 and 5.
