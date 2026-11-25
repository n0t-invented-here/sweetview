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

- [ ] **AC4: Unified `Window` and `createWindow` replace `NativeWindow` + `Overlay` with clean disposal, events, and multi-monitor/macOS fixes (Audit 2.1, 2.2, 2.3, 2.7, 2.9)**
  - [ ] Replace `NativeWindow`, `Overlay`, `createOverlayWindow`, `makeOverlay`, `nativeWindow` with `Window`, `createWindow`, `Window.fromHandle`; remove deprecated `dark` flag
  - [ ] Win32 `Window`:
    - [ ] Idempotent `dispose()` destroying HWND and clearing `resizers`, `hits`, `followsSystem`, `windowIcons`, subclass handlers, and hit timer
    - [ ] Default `WM_CLOSE` closes and disposes the window unless `onClose` intercepts; `WM_DESTROY` no longer unconditionally calls `PostQuitMessage(0)`
    - [ ] Wire multi-listener `onResize`, `onMove`, `onClose` with FFI-safe exception handling and unsubscribe thunks
    - [ ] Fix `isMaximized()` (`IsZoomed` for framed, restore state for frameless) and `toggleMaximize()` (`SW_MAXIMIZE`/`SW_RESTORE` for framed, `Screen.of(win).workArea` for frameless); cache `bounds()` in drag-resize tick
    - [ ] Kill hit-region timer on `hide()` and `dispose()`
  - [ ] macOS `Window`:
    - [ ] Consistent outer-frame `bounds` on creation (`contentRectForFrameRect:styleMask:` / hidden `setFrame:display:`), `bounds()`, and `setBounds()`
    - [ ] Honor `topmost`, `opacity`, `transparent`, `hideFromTaskbar`, and `noActivate` regardless of `frame`
    - [ ] Implement drag-resize loop in `startResize(edge)`
    - [ ] Intercept `onClose` cleanly for Cmd+W, programmatic `performClose:`, and frameless windows without replacing `webview/webview`'s delegate on `Window.fromHandle`
    - [ ] Wire `onResize` and `onMove` via `NSNotificationCenter` and remove observers in `dispose()`
    - [ ] Invalidate and release the 10ms hit-region `NSTimer` when `hits.size === 0` or on `dispose()`
    - [ ] Idempotent `dispose()` closing/releasing `NSWindow` and cleaning `hits`, `ignoring`, observers, and timers
  - [ ] Update `src/window-chrome.ts`: `windowChromeMethods(win, { chrome, onClose })` and `win.isMaximized()`
  - [ ] Add live Win32 `Window` FFI tests (`src/native/win32/window.test.ts`): multi-window close without killing loop, idempotent `dispose()`, `onClose`/`onResize`/`onMove`, `toggleMaximize()`/`isMaximized()`, `Window.fromHandle`
  - [ ] verify: `bun test src/native/win32/` passes all new Window FFI assertions on Windows

- [ ] **AC5: `WebView`, `createApp`, and `RawWebview` work for single-window, overlay, and menubar apps, and all 4 non-tab demos run and compile on v1**
  - [ ] Implement `WebView` (`WebView.attach`, `emit`, `notify`, `onEvent`, `run`, `quit`, `dispose`) reading geometry, scale, title, resizable, and transparent from `Window`
  - [ ] Implement `createApp` Layer 2 helper and re-export `RawWebview` from `src/index.ts`
  - [ ] Migrate `demos/web-app`, `demos/desktop-pet`, `demos/menubar-only`, `demos/menubar-notify` to v1 API
  - [ ] verify: `just check` passes, `just compile` builds all 4 demos (Windows `.exe` and macOS `.app`), and Windows probe scripts pass

- [ ] **AC6: Native Tabs promoted cleanly out of `demos/native-tabs/` into `src/native/` (webview-free) and `src/` (webview-aware) (Audit 2.11)**
  - [ ] Keep `@n1h/sweetview/native` webview-free: move Win32 tab frame/panes/system-menu, `win-shortcuts.ts`, and `strip-shared.ts` into `src/native/win32/` (using `Screen` and `Menu.popup`) and macOS `NSWindow` tabbing primitives into `src/native/darwin/` (fixing hardcoded ObjC class names)
  - [ ] Move webview-dependent tab pieces (`win-webview2.ts`, embedded strip webview + self-contained asset bundling, macOS `WKWebView` hooks, and cross-platform `Tab` / `WebView.openTab` / `createApp({ tabs: true })` coordinator) into `src/tabs/`
  - [ ] Support `Window({ tabs: true })`, `onNewTab`, `onTabSelect`, `onTabClose`, `WebView.openTab`, `Tab` (`select`, `close`, `setTitle`, `moveToNewWindow`, `dispose`), and `app.mergeAllWindows()`
  - [ ] Rewrite `demos/native-tabs/app.ts` onto the built-in tabs API and keep unit tests + Windows drive/capture scripts working
  - [ ] verify: `just check` passes, `@n1h/sweetview/native` imports zero webview modules, and `demos/native-tabs/scripts/win-drive.ts` passes against the migrated tabbed app on Windows

- [ ] **AC7: Documentation and macOS verification handoff are accurate and complete**
  - [ ] Update `README.md` and `docs/*.md` (`app.md`, `native.md`, `ipc.md`, `ipc-ws.md`, `settings-store.md`, `window-chrome.md`, `README.md`, `v1-api.md`, `audit-and-v1-plan.md`) to match v1.0.0 and remove machine-local paths
  - [ ] Write concrete macOS verification steps in `docs/v1-macos-verification.md` (and include in the final done-report) for Mac agents to execute
  - [ ] verify: `just check`, `just compile`, and `just pack` succeed cleanly on Windows with zero stale `0.2.x` export errors

## Review passes

- [ ] Adversarial review pass 1 against real built artifacts, test outputs, GUI probe outputs, and diff against `main` (pass 1)
- [ ] Adversarial review pass 2 (only if pass 1 had findings) (pass 2)

## Deferred by the user or the request

- macOS live runtime execution of AppKit / WKWebView / `UNUserNotificationCenter` / `mac-drive.ts`: Windows-only host in this session; exact test steps delivered in `docs/v1-macos-verification.md` and final done-report.
- Splitting `src/` into separate workspace packages under `packages/`: deferred follow-on tracked in `docs/audit-and-v1-plan.md` Section 1.
- Zero-TCP virtual HTTP/SSE (`hostHttp` / C++ `webview_set_request_handler` + second origin): deferred follow-on tracked in `docs/audit-and-v1-plan.md` Section 3.
- Custom URL schemes, single-instance handoff, and `delightful-qt-web-shell` shell extras (ready watchdog, deferred modal dialogs, 3-tier native file/clipboard/drag-drop APIs, unified app identity config): deferred follow-on tracked in `docs/audit-and-v1-plan.md` Sections 4 and 5.
