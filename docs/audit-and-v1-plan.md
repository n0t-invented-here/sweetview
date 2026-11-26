# Sweetview Audit & v1 Architecture Plan

Audit of `@n1h/sweetview` (`v0.2.2`, commit `1246944`) plus architectural findings for v1, package layout, zero-TCP app porting, URL scheme / single-instance activation, and lessons carried over from `delightful-qt-web-shell`.

For the final 1.0.0 API surface, see [`v1-api.md`](v1-api.md).

---

## 1. Package layout

Sweetview 1.0.0 publishes six packages under `packages/`. The facade preserves
the subpath entry points and owns the webview shell, page, and worker.
IPC has no platform dependencies. The WebSocket transport depends on IPC,
and native and build tools depend on settings. See the
[workspace package table](../README.md#documentation).

The C++ library lives in `n0t-invented-here/sweetview-webview` and the Bun
bindings and native binaries in `n0t-invented-here/sweetview-webview-bun`.
Both carry the release work on `v1-drafting`.
[Library additions and rebuild](webview-library.md).

---

## 2. Codebase Audit — Bugs, Leaks, and Broken Assumptions

These twelve findings describe the pre-v1 tree at commit `1246944`. File names and line numbers below refer to that revision.

### 2.1 Window Close Hides Instead of Closing; No `dispose()`; Destroying One Window Kills the Process
- **Win32** (`win32/overlay.ts:245-253`): `WM_CLOSE` unconditionally calls `ShowWindow(hwnd, SW_HIDE)` and returns `0` — closing a window never destroys it. Worse, `WM_DESTROY` unconditionally calls `PostQuitMessage(0)`, so actually destroying *any single* overlay window terminates the entire application event loop.
- **macOS** (`darwin/overlay.ts:194`): `setReleasedWhenClosed: false` keeps every closed `NSWindow` alive in memory forever.
- **No `dispose()` on `Overlay` / `NativeWindow`**: Because windows cannot be cleanly torn down, every window leaks its OS handle, attached webview, and module-level map entries (`followsSystem`, `resizers`, `hits`, `ignoring`), plus Win32 `HICON` handles stored in `windowIcons` (`win32/icon.ts:70-85`). Opening 20 windows and closing 19 leaves all 19 alive in memory.
- **Fix**: Give `Window` an explicit, idempotent `dispose()` that destroys the native handle and cleans every map/timer/observer/icon; default close action should actually close and dispose the window unless `onClose` intercepts it; only quit the event loop when the caller explicitly quits or (opt-in) when the last window closes; support close-to-tray only on the last visible window.

### 2.2 Win32 `toggleMaximize()` / `maximized()` Lies and Teleports Multi-Monitor Windows
- `win32/overlay.ts:471-483`: `maximized()` only checks a JS closure variable `restoreBounds !== undefined`, never calling `IsZoomed(hwnd)`. If the user clicks the native OS maximize button or drags to top edge, `maximized()` returns `false`.
- `toggleMaximize()` calls `self.setBounds(self.workArea())`, where `workArea()` (`win32/overlay.ts:503-505`) calls `SystemParametersInfoW(SPI_GETWORKAREA)` — which always returns the **primary** monitor's work area. Calling `toggleMaximize()` on Monitor 2 teleports the window onto Monitor 1.
- **Fix**: For framed windows, use native `ShowWindow(SW_MAXIMIZE / SW_RESTORE)` and `IsZoomed(hwnd)`. For frameless windows, compute work area from the window's *own* monitor (`MonitorFromWindow` + `GetMonitorInfoW().rcWork`).

### 2.3 macOS Framed Window Bugs (`bounds` Growth, Ignored Flags, No-Op `startResize`)
- **Outer vs. content rect mismatch** (`darwin/overlay.ts:183-192`): `createOverlayWindow({ frame: true, bounds })` passes `bounds` to `initWithContentRect:`, whereas `bounds()` and `setBounds()` operate on the outer `frame`. Saving and restoring bounds across restarts grows the window by one title-bar height every launch.
- **Silently ignored flags** (`darwin/overlay.ts:217-235`): `if (!framed)` skips `topmost`, `opacity`, `transparent`, and `hideFromTaskbar` without error or warning whenever `frame: true`.
- **Empty `startResize()`** (`darwin/overlay.ts:290-292`): `startResize()` is a complete no-op on macOS, breaking custom chrome resize handles on frameless macOS windows.
- **Fix**: Convert outer frame via `[NSWindow contentRectForFrameRect:styleMask:]` (or apply `setFrame:display:` while hidden); honor `topmost`/`opacity`/`hideFromTaskbar` regardless of `frame`; implement drag-resize loop on macOS matching Win32.

### 2.4 Repeated Uncached `dlopen()` Calls Never Closed
- `app.ts:234-237` and `webview-lib.ts:34-56` call `dlopen(libPath, ...)` 2–3 times on every `createWebviewApp()` call (`webview_terminate`/`webview_run`, `webview_set_background_color`, `webview_set_asset`) and never cache or `.close()` the resulting handles.
- **Fix**: Open the shared library once per `libPath` in a cached singleton wrapper in `webview-lib.ts`.

### 2.5 macOS Notifier Lazy Delegate & Unreleased ObjC Runtime Allocations
- `darwin/notifier.ts:86-93`: `UNUserNotificationCenter.setDelegate:` is only called inside `ensureCenter()`, which runs lazily on the first `notify()` call — never inside `createNotifier()`. Clicking a notification that launches the app before the app sends a new notification drops the click (contradicting `docs/native.md`).
- Repeated calls to `createNotifier()` or `installAppMenu()` do not collide on ObjC class names (because `makeTarget()` in `darwin/objc.ts` appends a monotonic counter), but every call permanently allocates and leaks a fresh ObjC class pair, an unreleased `+1` instance, `JSCallback`s, and global blocks. (Meanwhile, `demos/native-tabs/mac-window-tabs.ts` hardcodes `"SweetviewWindowTabs"` and `"SweetviewTabNavigation"`.)
- **Fix**: Register the delegate eagerly in `Notifier` construction; reuse or safely dispose ObjC targets/blocks instead of leaking per instance, and guard/uniquify ObjC classes in promoted macOS tabs.

### 2.6 Win32 Notifier Coupled to Tray, Legacy Balloons, and Wrong Click Payload
- `win32/notifier.ts:12-13`: Throws if no tray has been created yet because it piggybacks on `Shell_NotifyIconW(NIF_INFO)` balloons.
- `win32/tray.ts:149-151, 184-195`: Only one `lastBalloon` is tracked. Firing two notifications and clicking the first delivers the *second* notification's `id` and `data`.
- **Fix**: Either replace with proper Windows toast notifications (WinRT `ToastNotificationManager` with per-toast activation args) or clearly scope balloon notifications and guard multi-notification IDs.

### 2.7 macOS 10ms Hit-Region `NSTimer` Runs Forever
- `darwin/overlay.ts:162-168`: `ensureTimer()` schedules a repeating 10ms (`0.01s`) `NSTimer` on the main run loop that is never invalidated even after `setHitRegions(null)` clears every tracked window, waking the main thread 100 times/second for the lifetime of the process.
- **Fix**: Invalidate and release the timer when `hits.size === 0` (and on `win.dispose()`).

### 2.8 Worker `send()` Outside `try/catch` Permanently Hangs RPC Promises
- `worker.ts:24-47`: Inside `handle()`, `send()` calls `JSON.stringify(frame)` and `ring.write(...)` *both* inside the `try` and inside the `catch` reply path. If a return value exceeds the ring buffer size (`1 MB - 4` bytes by default) or contains unserializable values (`BigInt`, circular refs), `send()` throws uncaught and no `ReplyFrame` is ever written — hanging the page's `await bridge.call(...)` Promise forever.
- **Fix**: Wrap serialization and `ring.write` in error handling inside `send()` / `handle()` so oversized or unserializable replies always send a small `{ kind: "reply", seq, ok: false, error }` frame instead of dropping the request silently (and consider chunked framing for payloads larger than a single ring slot).

### 2.9 macOS `onCloseRequest` Misses `Cmd+W` and Throws on Frameless Windows
- `darwin/window.ts:49-60`: `onCloseRequest` works by retargeting the red traffic-light `NSWindowCloseButton`. It misses `Cmd+W` / programmatic `performClose:` and throws `"window has no close button"` on any frameless window.
- **Fix**: Intercept window closing via `NSWindowDelegate` (`windowShouldClose:`) or `NSWindowWillCloseNotification` / menu-action dispatch rather than only rewiring the traffic-light button.

### 2.10 `win.screen()` and `win.workArea()` Ignore `win`
- Both `win32/overlay.ts:488-505` and `darwin/overlay.ts:305-328` return the **primary** monitor's rect and work area regardless of which monitor `win` is actually on.
- **Fix**: Replace with `Screen.primary()`, `Screen.all()`, `Screen.at(pt)`, and `Screen.of(win)` (implemented via `MonitorFromWindow` on Windows and `[win screen]` on macOS).

### 2.11 Native Tabs (~1,500 LOC) Stranded in `demos/native-tabs/`
- Complete macOS AppKit tabbing and Win32 custom tab-strip + multi-WebView2 implementations were built inside `demos/native-tabs/` before workspace extraction (`demos/native-tabs/README.md:177-178` explicitly notes it isn't exported).
- **Fix**: Promote into the native/webview library behind `Window({ tabs: true })`, `WebView.openTab`, and `createApp({ tabs: true })` (see `docs/v1-api.md`).

### 2.12 Win32 Windows 11 Topmost Anchor & DPI Init Only Run in `createOverlayWindow`
- `win32/overlay.ts:270-281`: Works around a Windows 11 25H2 bug where the first top-level window in a process can never be made `HWND_TOPMOST` by creating a hidden message window first — and calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` — but only inside `createOverlayWindow`, not inside `createWebviewApp()`, `makeOverlay()`, or `createMessageWindow()` (`win32/message-window.ts:56-60`). Creating a tray before a window therefore locks the process into DPI-unaware mode.
- **Fix**: Run `ensureDpiAware()` and `ensureFirstWindowIsHidden()` from a single shared Win32 startup initializer called by `Screen`, `Window`, `createMessageWindow()`, and `WebView`.

---

## 3. Porting Real Apps to Zero-TCP Sweetview

Goal: run real Bun web apps as desktop Sweetview apps with **zero localhost TCP bindings** (no `Bun.serve` HTTP or WS ports in desktop mode) while still allowing them to run locally as regular web apps.

### 3.1 Analysis of the Three Target Apps

| App | Repo | Backend ↔ Frontend Transport Today | Special Requirements | Refactor Cost (JSON-RPC Only) |
|---|---|---|---|---|
| **TracLite** | `Apps/TracLite` | 35 JSON REST routes (`web/api.ts`) + 1 SSE stream (`web/hooks/useLive.ts`), zero binary HTTP. `Bun.serve` + SQLite + HTTP MCP. | Clean API client boundary; SSE live refresh. | **Low (~1–2 hours)** |
| **gitweb** | `Apps/gitweb` | 19 JSON routes and one SSE stream in its web API client. | Direct browser URL loads to `/api/repos/:id/raw` via image URLs (`BlobView.tsx`, `MarkdownView.tsx`) and `<a download>`. | **Medium-low (~½ day)** — JSON/SSE is easy, but `<img src>` and downloads need blob URLs or custom URL interception. |
| **UntidyDiary** | `Apps/UntidyDiary` | 10 HTTP endpoints (`diaryClient.ts`) + `/~/live` WebSocket (`live.ts`, already DI'd via `SocketLike`). | 25 MB image uploads, arbitrary dynamic on-disk media (`<img>`, `<video>`, `<audio>`, PDFs), dynamic `themes.css`, **second-origin `Bun.serve` (`framesOrigin`)** for cross-origin sandboxed `<iframe src>` day apps, and `POST /~/backend/...`. | **High** with JSON-RPC alone — rewriting every dynamic media URL, 25 MB upload, and cross-origin iframe protocol into JSON-RPC + blob URLs is heavy and fragile. |

### 3.2 Two Ways to Dramatically Reduce Migration Cost

#### Option A — Pure TypeScript Virtual HTTP/SSE Over IPC Ring (No C++ Changes)
Add a lightweight `hostHttp(fetchHandler)` helper on the worker side and `webviewFetch` / `webviewEventSource` on the page side, riding the existing IPC ring (plus chunked framing for bodies > 1 MB):
- Lets `TracLite` and all JSON/SSE routes in `gitweb` reuse their existing `(req: Request) => Promise<Response>` Bun handlers unchanged with zero TCP ports.
- **Limitation**: Cannot intercept browser-initiated subresource loads (`<img src>`, `<video src>`, `<link href>`, `<iframe src>`, or `history.pushState` reloads) because WebView2 / WKWebView do not route those through JS `fetch()`.

#### Option B — Native dynamic request handler (shipped in 1.0.0)
Extend `sweetview-webview` (and `@n1h/sweetview-webview-bun`) with `webview_set_request_handler` (plus an optional second virtual origin, e.g. `http://frames.webview.localhost` on Windows / `webview-frames://localhost` on macOS):
- Hooks `WebResourceRequested` (WebView2 on Windows) and `WKURLSchemeHandler` (WKWebView on macOS) into a Bun `(req: Request) => Promise<Response>` callback instead of only static pre-registered `webview_set_asset` entries.
- **What this unlocks with zero TCP ports**:
  1. Finite fetch responses and request bodies can reuse a Request-to-Response router. Worker responses are buffered. Keep long-lived streams such as SSE on their existing web transport or use Sweetview IPC events in desktop mode.
  2. `<img src>`, `<video src>`, `<audio src>`, `<a download>`, dynamic CSS (`themes.css`), and `history.pushState` hard reloads all work natively without blob-URL hacks.
  3. A second virtual origin (`frames.webview.localhost` / `webview-frames://localhost`) gives `UntidyDiary` real browser-enforced cross-origin isolation for sandboxed day-app `<iframe>`s with zero localhost ports.
- **Note on WebSockets**: `UntidyDiary`'s `/~/live` already injects `SocketLike`, so desktop mode swaps in Sweetview IPC events while web mode keeps `WebSocket` (or `@n1h/sweetview/ipc-ws`).

---

## 4. Custom URL Schemes (`my-app://...`) & Single-Instance Activation

To support `my-app://whatever/123` launching the app (or focusing and forwarding the URL to the already-running instance) on both target OSes:

### 4.1 Windows (`win32`)
1. **Protocol registration**: Write per-user registry keys (no admin/UAC needed) under `HKCU\Software\Classes\<scheme>`:
   - `(Default)` = `"URL:<App Name> Protocol"`, `"URL Protocol"` = `""`
   - `DefaultIcon\(Default)` = `"<exePath>,0"`
   - `shell\open\command\(Default)` = `"\"<exePath>\" \"%1\""`
2. **Single-instance lock**: On startup, call `CreateMutexW(null, false, "Local\\<appId>")`. If `GetLastError() === ERROR_ALREADY_EXISTS`, this process is a secondary instance.
3. **Handoff to primary**: Secondary instance locates the primary's hidden message-only window (`FindWindowExW` / named window class keyed by `<appId>`), sends the URL / CLI args via `SendMessageTimeoutW(..., WM_COPYDATA, ...)`, calls `AllowSetForegroundWindow(primaryPid)`, and exits immediately.
4. **Primary handling**: Primary receives `WM_COPYDATA` on its UI message loop, parses the payload, brings its window to foreground (or lets the app decide), and invokes `onOpenUrl` / `onSecondInstance`.

### 4.2 macOS (`darwin`)
1. **Protocol registration**: Declare `CFBundleURLTypes` (`CFBundleURLName`, `CFBundleURLSchemes: ["my-app"]`) inside `Info.plist` generated by `makeMacApp({ urlSchemes: ["my-app"] })`. Launch Services automatically registers the scheme when the signed `.app` bundle is opened/scanned.
2. **Receiving URLs**: Register an Apple Event handler via `NSAppleEventManager.sharedAppleEventManager` for class `kInternetEventClass` (`'GURL'`) and event ID `kAEGetURL` (`'GURL'`), reading `keyDirectObject` (`'----'`) as an `NSString`. Register **before** `NSApp.run` / `webview.run()` so cold-launch URLs are buffered and delivered to `onOpenUrl` instead of dropped.
3. **Single-instance lock & handoff**: macOS `.app` bundles launched via Launch Services / Finder are already single-instance by default, and `kAEGetURL` routes directly into the running process. For direct CLI / terminal launches of the binary, Sweetview uses `CFMessagePort` to forward arguments and URLs to the existing instance.

### 4.3 Unified Activation API
Unify cold-launch URLs, warm-launch URLs, CLI args, and OS file-open events behind one app-level pipeline:
- Buffer early activation events until the app/frontend calls `signalReady()`, then drain in order.
- Provide `singleInstance({ appId, onSecondInstance })`, `registerUrlScheme(scheme)` (Windows HKCU helper; build-time `makeMacApp({ urlSchemes })` on macOS), and `onOpenUrl(handler)` returning an unsubscribe thunk.

---

## 5. Lessons From `delightful-qt-web-shell`

Non-theming architectural practices from `mrowrpurr/delightful-qt-web-shell` (`app/docs/DelightfulQtWebShell/for-agents/01..08.md`) worth carrying into Sweetview:

1. **Ready handshake + startup watchdog**: Keep the window hidden until the page explicitly calls `signalReady()` (or an opt-in timeout fires), and display a fallback error surface if the frontend fails to boot instead of flashing white/blank windows or hanging invisibly.
2. **Close-to-tray only on the last visible window**: Multi-window apps should destroy closed secondary windows normally and only intercept close-to-tray when the last visible window is closed.
3. **Never run blocking modal OS dialogs synchronously inside a bridge/IPC callback**: Defer native dialogs (`pickFolder`, file pickers, alerts) onto the next UI tick so the IPC call/webview message pump doesn't re-enter or deadlock.
4. **Three-tier native file access + clipboard + OS drag-and-drop paths**:
   - Small UTF-8 text: `readTextFile`
   - Medium binary: `readFileBytes`
   - Large files / streaming: `openFileHandle` / `readFileChunk` / `closeFileHandle`
   - Native clipboard read/write and real OS file paths on drag-and-drop (browsers strip full filesystem paths).
5. **Single app identity config**: Centralize `appId`, `appName`, `urlSchemes`, icon, and data directory in one manifest/config object shared by runtime (`SettingsStore`, `Notifier`, single-instance mutex, window icons) and build tools (`makeMacApp`, Windows icon/manifest embedding).
6. **Testing pyramid**: Test pure IPC/protocol and WebSocket transport headlessly first, then browser-level UI via Playwright over WS, and reserve native desktop GUI tests for smoke coverage. Run Playwright CDP from **Node**, not Bun, to avoid Bun/Playwright CDP hangs.

---

## 6. Dual-Mode App Workflow (Regular Web App + Sweetview Desktop App)

Demonstrated in `demos/web-app/` (`app.ts`, `web.ts`, `app-worker.ts`, and `packages/web-app-{backend,frontend}`):

1. **Define the shared IPC contract & service once**: Declare `Methods` and `Events` in `protocol.ts` and implement the backend with `defineService` from `@n1h/sweetview/ipc` (zero transport or runtime coupling).
2. **Switch transport on the frontend**: Check `isWebview()` from `@n1h/sweetview/page`; use `webviewTransport()` inside Sweetview and `wsTransport(wsUrl("/ws"))` from `@n1h/sweetview/ipc-ws/client` in a regular browser, then pass the transport to `createBridge`.
3. **Run as a regular local web app**: Host the same `Service` in `web.ts` via `wsHost(service)` from `@n1h/sweetview/ipc-ws/server` wired into `Bun.serve` (serving static frontend assets + `/ws` upgrade).
4. **Wrap as a zero-TCP Sweetview desktop app**: Host the same `Service` inside a Worker (`app-worker.ts`) via `hostService(service)` from `@n1h/sweetview/worker`, and launch it from `app.ts` via `createWebviewApp` (v1: `createApp` / `WebView.attach`) with the HTML bundle and worker — no TCP ports bound.
