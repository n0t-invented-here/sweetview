# Native-tabs demo: native code inventory (branch `main`)

Source: `demos/native-tabs/*` on `main`. Helpers resolved from `src/native/win32/api.ts` and `src/native/darwin/objc.ts`.

## What the demo does

Both platforms (app.ts, shared.ts, tab-page.ts):
- One webview per tab. A tab shows the demo's own page or a site. At launch three tabs open (demo page, demo page, `https://bun.sh`), then the first is selected (app.ts:28-31, 38-41).
- The OS loop is driven from Bun's event loop (`runEventLoop`), not the webview's blocking `run()`; `runEventLoop()` is started before the tabs open. The process exits when that loop resolves (last tab closed, or Quit) (app.ts:10-12, 23, 47-48).
- Only the demo's own page gets the UI methods `tab.info`, `tab.open`, `tab.rename`, `tab.close`; a site tab gets none (win-tabs-app.ts:542-558, mac-tabs-app.ts:153-166).
- `tab.info` marks the page as listening and triggers the tab being shown "already drawn"; if the page never asks, it is shown after 1000 ms (win-tabs-app.ts:547-550, 600; mac-tabs-app.ts:158-162, 188).
- `tab.rename` with an empty/whitespace title restores `Tab n` (win-tabs-app.ts:219, mac-tabs-app.ts:110).
- A site tab's title follows `document.title`: the app binds `__nativeTabsTitle`, injects `FOLLOW_TITLE` at document start (MutationObserver + DOMContentLoaded + load), then navigates (tab-page.ts:36-45; win-tabs-app.ts:592-598; mac-tabs-app.ts:178-186).
- Every open/close emits event `tabs { count }` to every listening page (win-tabs-app.ts:157-159; mac-tabs-app.ts:84-87).
- Tabs requested in a row keep request order; a tab opened by a page goes after the opener and after tabs that opener opened before (win-tabs-app.ts:518-524; mac-tabs-app.ts:117-121, 138).

Windows:
- The window is a custom top-level `WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN` frame whose caption is removed in `WM_NCCALCSIZE`; shadow, rounded corners, side/bottom resize borders, snap, maximise, taskbar stay the system's (win-tab-window.ts:1-15, 227-238).
- The top 40 DIP (`STRIP_HEIGHT`) is a child "strip pane" hosting a webview that draws tabs, `+`, minimise/maximise/close buttons and top resize edges (strip-shared.ts:69; win-tabs-app.ts:101-110).
- Each tab is a hidden child "pane" below the strip hosting its own WebView2; one pane is shown at a time (win-tab-window.ts:9-10).
- New tab: `+` in strip, Ctrl+T, page button, right-click menu, `tab.open`, or a page's new-window request (`target=_blank`, `window.open`) which becomes a tab instead of a popup (win-tabs-app.ts:380, 395, 552-555, 579-587).
- A new tab is selected in the strip immediately; its pane replaces the shown one only once it is "ready"; until then the previous pane stays shown (win-tabs-app.ts:167-183, 526).
- Close: strip close button on a tab, Ctrl+W, Ctrl+F4, menu, `tab.close`. Next tab to the right is selected, else the one to the left (win-tabs-app.ts:251-258).
- Close other tabs, Move tab to new window, Merge all windows via the tab's right-click menu (system popup menu) (win-tabs-app.ts:391-409).
- Right-click on the strip's empty part shows the window's system menu (Restore, Move, Size, Minimize, Maximize, Close) with items enabled per maximised state, Close as default (win-tab-window.ts:519-544).
- Reorder: dragging within the strip sends `strip.move {id,index}` (win-tabs-app.ts:477, 286-292).
- Tear off: dragging a tab out sends `strip.detach {id, held}`; a new window is created with the tab under the cursor, the tab's pane is reparented (`SetParent`, page not reloaded), and if the button is still down the drag is handed to the window manager. A window's only tab drags the whole window instead (win-tabs-app.ts:363-371).
- Drop: after a window-manager drag of a single-tab window ends, if the window moved and the cursor is over another visible window's strip, the tab joins that window at `dropIndex(...)` accounting for the strip's scroll offset (win-tabs-app.ts:339-361).
- Strip empty-part press moves the window; top edge/corners resize it; both via `WM_NCLBUTTONDOWN` after first repositioning the window under the cursor (win-tab-window.ts:448-473).
- Keyboard shortcuts (win-shortcuts.ts:28-38): Ctrl+T new; Ctrl+W / Ctrl+F4 close tab; Ctrl+Tab / Ctrl+PageDown next (wraps); Ctrl+Shift+Tab / Ctrl+PageUp previous; Ctrl+1..8 that tab; Ctrl+9 last tab; Alt+F4 close window. Delivered via WebView2 `AcceleratorKeyPressed` on every tab and on the strip. Tabs consume only recognised shortcuts; the strip consumes every accelerator key (win-tabs-app.ts:497-502, 574-578).
- Focus: after every strip call (menu closed, drag released) the keyboard is given back to the shown page via `MoveFocus`, only if the frame is foreground; also on activation (win-tabs-app.ts:162-165, 426, 449-459).
- Activation: the activated window moves to front of `windows` (most recently used first); strip state `active` dims a background strip (win-tabs-app.ts:422-431; strip-shared.ts:21).
- Resize: `WM_SIZE` lays out strip pane and the shown pane only; strip state pushed when maximised state flips (win-tab-window.ts:208-213, 239-244; win-tabs-app.ts:432-435).
- Move: `WM_MOVE` calls `NotifyParentWindowPositionChanged` on the strip's and every tab's controller (win-tabs-app.ts:436-441).
- DPI: process is per-monitor-aware V2; sizes in DIPs converted with `GetDpiForWindow`/96; `WM_DPICHANGED` applies the suggested rect (win-tab-window.ts:177, 254-259, 335).
- Min size via `WM_GETMINMAXINFO`: 560 x (420+40) DIP inside, plus border (win-tab-window.ts:245-253; win-tabs-app.ts:417-418). Default inside size 1040 x 760 DIP, centred on primary work area (win-tabs-app.ts:114-115; win-tab-window.ts:383-390).
- Title (taskbar/Alt+Tab): `"<selected tab title> - Native Tabs"` or `"Native Tabs"`; icon is a generated dot icon `#6d5df6` at 16/24/32/48 (win-tabs-app.ts:113, 160, 443).
- Dark mode: strip page reports `strip.dark`; all frames get `DWMWA_USE_IMMERSIVE_DARK_MODE` and repaint; backdrop colours for unpainted areas (light strip `#e9eaee`, page `#f9f9fb`; dark strip `#292a30`, page `#15161a`) (win-tab-window.ts:91-97, 348-358).
- Hidden tabs get `put_IsVisible(false)`; WebView2 starts every page visible, so a page drawn behind another is told once ready (win-tabs-app.ts:185-189).
- Window appears only when strip has called `strip.state` and the selected tab is shown, or after 1500 ms regardless (win-tabs-app.ts:191-198, 503).
- Close last tab of a window destroys the window (unless a webview is still being made in it, then hidden); closing the last window ends the app (`quitEventLoop`), and `openTab` thereafter rejects (win-tabs-app.ts:224-249, 510).
- Selected demo-page tab is tinted with `tabHue(n) = (n*67+200)%360`; site tabs neutral (shared.ts:14; win-tabs-app.ts:149).

macOS:
- Each tab is an `NSWindow` (titled, closable, miniaturizable, resizable) hosting a `WKWebView`; AppKit window tabbing (shared tabbing identifier `dev.mrowr.native-tabs`, mode Preferred) draws the tab bar, reorders, tears off, merges (mac-window-tabs.ts:1-10, 183-199; mac-tabs-app.ts:89-94).
- First window 1040x720 pt content, min 560x420; later tabs take the joined window's size (mac-tabs-app.ts:91-94; mac-window-tabs.ts:58).
- `+` appears because a custom NSResponder implementing `newWindowForTab:` is each window's `nextResponder` (mac-window-tabs.ts:148-162).
- Tab bar is kept visible even with one tab (`toggleTabBar:` when `isTabBarVisible` is false), on show and on `NSWindowDidBecomeMainNotification` (mac-window-tabs.ts:139-146, 156-159).
- Window stays hidden until `tab.info` (or 1000 ms); site tabs show at once. New window inserted via `addTabbedWindow:ordered:` after the anchor tab, then `makeKeyAndOrderFront:` and app activation (mac-window-tabs.ts:200-214).
- Menus: File (New Tab Cmd+T `newWindowForTab:`, Close Tab Cmd+W `performClose:`) inserted at index 1; View (Show All Tabs Cmd+Shift+\ `toggleTabOverview:`); Window (Minimize Cmd+M, Zoom, separator, Show Previous Tab Ctrl+Shift+Tab, Show Next Tab Ctrl+Tab, Move Tab to New Window, Merge All Windows), set as the app's windows menu. Items have no target (responder chain) (mac-window-tabs.ts:350-383).
- Site load failure shows an HTML page with the address, the system's `localizedDescription`, and a Try Again link; cancelled loads (-999) ignored (mac-window-tabs.ts:252-277; mac-tabs-app.ts:50-71, 184).
- Closing the last open tab calls `quitEventLoop()`; a tab still loading keeps the app alive (mac-tabs-app.ts:103).
- Keyboard focus on show goes to the hosted `WKWebView` via `makeFirstResponder:` (mac-window-tabs.ts:205-208).
- Tear-off, reorder, merge, tab switching shortcuts: AppKit's own; no code beyond menu items. DPI/resizing: unclear from the code (no explicit handling; `resizable: true` passed to `createWebviewApp`).

## Per file

| File | Lines | Role | Imports `bun:ffi` | `new JSCallback` |
|---|---|---|---|---|
| win-tab-window.ts | 544 | Win32 frame window, panes, window procs, drag/resize handoff, popup and system menu | yes | 1 (in `registerClass`, called twice: frame and pane class) |
| win-webview2.ts | 233 | WebView2 COM vtable calls and hand-built event handler COM objects | yes | 4 (in `handlerKind`, per handler kind; up to 2 kinds => 8 at run time) |
| win-tabs-app.ts | 607 | Windows tab/window state machine, strip webview, tab webviews | no | 0 |
| win-shortcuts.ts | 55 | Pure key -> shortcut mapping | no | 0 |
| mac-window-tabs.ts | 383 | AppKit window tabbing, responder target, notifications, menus, navigation delegate, main-queue drain | yes | 1 (`drainMainQueue` marker, one per call) |
| mac-tabs-app.ts | 195 | macOS tab lifecycle over mac-window-tabs | no | 0 |
| strip-shared.ts | 111 | Strip RPC types and geometry (`tabWidth`, `scrollToShow`, `dropIndex`) | no | 0 |
| shared.ts | 29 | Page RPC types, `tabHue` | no | 0 |
| tab-page.ts | 45 | Page HTML body and `FOLLOW_TITLE` script | no | 0 |
| app.ts | 48 | Entry: platform check, event loop, initial tabs | no | 0 |
| README.md | 178 | Documentation | n/a | 0 |

`makeTarget` (objc.ts:94-118) creates one more `JSCallback` per selector (5 total across two classes), retained in a module array in objc.ts.

## Windows: OS interfaces used

Win32 (user32 via `api.ts` `user32` unless "extra" = local `dlopen("user32.dll")` at win-tab-window.ts:52-70):

| Function | DLL | Use | File:line |
|---|---|---|---|
| `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)` | ole32 | STA for WebView2; throws on `RPC_E_CHANGED_MODE` | win-tab-window.ts:333-334 |
| `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2 = -4)` | user32 | DPI awareness before any window | :335 |
| `RegisterClassExW` (WNDCLASSEXW 80 bytes: cbSize@0, lpfnWndProc@8, hInstance@24, hCursor@40, lpszClassName@64; hbrBackground NULL) | user32 | classes `SweetviewTabFrame`, `SweetviewTabPane` | :298-326 |
| `GetModuleHandleW(NULL)` (`hInstance`), `GetLastError` (`lastError`) | kernel32 | class/window hInstance; error text | api.ts:157-159 |
| `LoadCursorW(0, IDC_ARROW)` | user32 (extra) | class cursor | :323 |
| `CreateWindowExW` | user32 | frame (`WS_OVERLAPPEDWINDOW|WS_CLIPCHILDREN`, `CW_USEDEFAULT`), panes (`WS_CHILD|WS_CLIPCHILDREN`) | :342, :375 |
| `DefWindowProcW` | user32 | default handling; also called inside `WM_NCCALCSIZE` then RECT top patched | :225, 235, 275, 279, 295 |
| `GetDpiForWindow` (fallback 96) | user32 | DIP scaling | :177 |
| `GetSystemMetricsForDpi(SM_CXSIZEFRAME=32 / SM_CYSIZEFRAME=33 / SM_CXPADDEDBORDER=92)` | user32 (extra) | resize border size | :179-182 |
| `GetDpiForSystem` | user32 (extra) | declared, not called | :62 |
| `GetClientRect`, `GetWindowRect` | user32 | sizes, strip screen rect | :185, 216, 400, 440, 452, 463 |
| `MoveWindow` | user32 | place pane and its first child | :203-205, 284 |
| `GetWindow(pane, GW_CHILD)` | user32 | the webview library's child in a pane | :204, 283 |
| `IsZoomed`, `IsIconic` | user32 | maximised / minimised checks | :236, 434, 445, 447, 450, 459, 528 |
| `SetWindowPos` | user32 | DPI rect, initial size with `SWP_FRAMECHANGED`, show pane top with `SWP_SHOWWINDOW (0x40)`, drag/resize catch-up | :257, 390, 416, 453, 469 |
| `SystemParametersInfoW(SPI_GETWORKAREA)` | user32 | centre on work area | :387 |
| `ShowWindow` (SW_SHOW/HIDE/RESTORE/MINIMIZE/MAXIMIZE=3) | user32 | panes and frame | :394, 409, 420, 434, 437, 446-447 |
| `SetParent(pane, frame)` | user32 (extra) | move tab pane to another frame | :411 |
| `DestroyWindow` | user32 | pane, frame | :425, 474 |
| `IsWindow` | user32 (extra) | `windowExists` | :364 |
| `GetForegroundWindow`, `SetForegroundWindow` | user32 (extra / user32) | `isForeground`; show; before menus | :435, 444, 503, 540 |
| `SetWindowTextW` | user32 (extra) | title | :438 |
| `FillRect` + `CreateSolidBrush` (cached per colour, never deleted) | user32 (extra), gdi32 | `WM_ERASEBKGND` backdrop | :71, 174-175, 215-219 |
| `InvalidateRect(hwnd, NULL, TRUE)` | user32 (extra) | repaint after dark change | :350 |
| `DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE=20, int, 4)` | dwmapi | system border dark/light | :349 |
| `GetCursorPos`, `GetAsyncKeyState(VK_LBUTTON)` | user32 | cursor, button held | :366-371 |
| `ReleaseCapture` + `SendMessageW(WM_NCLBUTTONDOWN, HTCAPTION=2 or HT* 10..17)` | user32 | hand drag/resize to window manager; blocks until release | :455-456, 471-472 |
| `CreatePopupMenu`, `AppendMenuW` (MF_STRING/MF_GRAYED/MF_SEPARATOR; ids 1-based; `&` escaped to `&&`), `TrackPopupMenu(TPM_RIGHTBUTTON|TPM_RETURNCMD)`, `PostMessageW(WM_NULL)`, `DestroyMenu` | user32 | tab context menu | :493-509 |
| `GetSystemMenu(hwnd, FALSE)`, `EnableMenuItem` (by command SC_RESTORE/MOVE/SIZE/MINIMIZE/MAXIMIZE), `SetMenuDefaultItem(SC_CLOSE)`, `TrackPopupMenu`, `PostMessageW(WM_SYSCOMMAND, chosen)` | user32 | window menu | :525-544 |
| `GetKeyState(VK_SHIFT/VK_CONTROL/VK_MENU)` | user32 (local dlopen) | modifiers for accelerator | win-webview2.ts:47, 160-163 |
| `CoTaskMemFree` | ole32 (local dlopen) | free URI string from `get_Uri` | win-webview2.ts:48, 205 |
| `webview_get_native_handle(webview, 2 = BROWSER_CONTROLLER)` | webview library (`webviewLibPath()`) | obtain `ICoreWebView2Controller*` | win-webview2.ts:65-73 |

Window messages handled (win-tab-window.ts:223-296): frame: `WM_NCCALCSIZE` (0x83), `WM_SIZE`, `WM_GETMINMAXINFO` (writes `ptMinTrackSize` = ints 6,7), `WM_DPICHANGED` (0x2E0), `WM_ERASEBKGND`, `WM_ACTIVATE` (low word != 0 = active), `WM_MOVE`, `WM_CLOSE` (returns 0, no destroy), `WM_NCDESTROY` (removes from map). Pane: `WM_SIZE` (child resized to LOWORD/HIWORD lParam), `WM_ERASEBKGND` (strip colour if strip pane else page colour), `WM_NCDESTROY`.

COM calls through vtable slots (`call(object, slot, ...)`: reads `*(*object + slot*8)`, builds a cached `CFunction` with `this` first, returns i32) (win-webview2.ts:50-61). Slots per comment from WebView2.h SDK 1.0.1150.38:

| Method | Interface | Slot | Use | Line |
|---|---|---|---|---|
| `put_IsVisible(BOOL)` | ICoreWebView2Controller | 4 | hide/show a tab's page | 19, 76-78 |
| `MoveFocus(PROGRAMMATIC=0)` | ICoreWebView2Controller | 12 | keyboard to page | 20, 81-83 |
| `add_AcceleratorKeyPressed(handler, EventRegistrationToken*)` | ICoreWebView2Controller | 19 | hear accelerator keys; token buffer discarded | 21, 181 |
| `NotifyParentWindowPositionChanged()` | ICoreWebView2Controller | 23 | popups follow window | 22, 86-88 |
| `get_CoreWebView2(ICoreWebView2**)` | ICoreWebView2Controller | 25 | get core webview | 23, 209, 227 |
| `CallDevToolsProtocolMethod(method, paramsJson, NULL handler)` | ICoreWebView2 | 36 | fire-and-forget CDP (used by scripts/win-drive.ts) | 25, 225-233 |
| `add_NewWindowRequested(handler, token*)` | ICoreWebView2 | 44 | intercept new windows | 26, 212 |
| `Release()` | IUnknown (on ICoreWebView2) | 2 | release core after use | 35, 213, 231 |
| `get_KeyEventKind(int*)` | ICoreWebView2AcceleratorKeyPressedEventArgs | 3 | filter KEY_DOWN (0) / SYSTEM_KEY_DOWN (2) | 28, 176-177 |
| `get_VirtualKey(UINT*)` | same | 4 | key code | 29, 178 |
| `put_Handled(BOOL)` | same | 8 | consume key | 30, 179 |
| `get_Uri(LPWSTR*)` | ICoreWebView2NewWindowRequestedEventArgs | 3 | requested URL (CoTaskMem string) | 32, 202-205 |
| `put_Handled(TRUE)` | same | 6 | suppress popup | 33, 206 |

Hand-built COM event handler objects (win-webview2.ts:90-155):
- Implements `ICoreWebView2AcceleratorKeyPressedEventHandler` (IID `b29c7e28-fa79-41a8-8e44-65811c76dcb2`) and `ICoreWebView2NewWindowRequestedEventHandler` (IID `d4c185fe-c81c-4989-97af-2d3fa7ab5651`).
- Layout: object = one 8-byte slot holding a vtable pointer; vtable = 4 slots `[QueryInterface, AddRef, Release, Invoke]`, one vtable per kind shared by all handlers of that kind; both allocated over an explicit `ArrayBuffer` so the address is stable (`stable`, :101-107).
- `QueryInterface(this, riid, out)`: compares 16 GUID bytes (Data1-3 little-endian) against IUnknown and the kind's IID; writes `this` or 0; returns `S_OK` or `E_NOINTERFACE` (:109-128).
- `AddRef` returns 2, `Release` returns 1 (no counting; never freed) (:129-130).
- `Invoke(this, sender, args)`: looks up `this` address in `byAddress` and calls the JS handler; exceptions are caught and logged; always returns `S_OK` (:131-141).

## macOS: OS interfaces used

Via `objc_msgSend` with per-signature `CFunction`s (objc.ts:30-48). Libraries: AppKit, libobjc, libSystem, libdispatch.

| Class / receiver | Selector or function | Purpose | File:line |
|---|---|---|---|
| `NSAutoreleasePool` | `alloc`/`init`, `drain` | `pooled` wrapper around every native call | mac-window-tabs.ts:104-111 |
| `NSApplication` | `sharedApplication`, `keyWindow`, `activateIgnoringOtherApps:`, `mainMenu`, `setWindowsMenu:` | app, current tab, activation, menus | :117, 176, 212, 361, 382 |
| `NSString` | `stringWithUTF8String:` (`nsString`), `retain` | identifier (retained for the group), titles, notification names | :118 |
| `NSWindow` | `alloc`, `initWithContentRect:styleMask:backing:defer:` (rect 0,0,w,h; style 1\|2\|4\|8; buffered=2; NO) | tab window | :186-188 |
| `NSWindow` | `setReleasedWhenClosed:NO`, `setTitle:`, `setContentMinSize:` (default 480x320), `setTabbingIdentifier:`, `setTabbingMode:` (Preferred=1), `setNextResponder:` | setup | :190-195, 223 |
| `NSWindow` | `tabGroup` -> `NSWindowTabGroup` `isTabBarVisible`; `toggleTabBar:` | keep tab bar visible | :144-145 |
| `NSWindow` | `makeFirstResponder:`, `center`, `addTabbedWindow:ordered:` (NSWindowAbove=1), `makeKeyAndOrderFront:`, `performClose:`, `contentView`, `release` | show, select, close | :208-211, 227, 231, 242 |
| `NSView` | `subviews`, `className` | find `WKWebView` among content view subviews | :241-250 |
| `NSArray` | `count`, `objectAtIndex:` | iterate subviews | :245-246 |
| `NSNotificationCenter` | `defaultCenter`, `addObserver:selector:name:object:`, `removeObserver:name:object:` | observe `NSWindowWillCloseNotification`, `NSWindowDidBecomeMainNotification` per window | :164-173, 238 |
| `NSNotification` | `object` | the window | :155, 157 |
| `WKWebView` | `setNavigationDelegate:` (set / NIL), `configuration` -> `userContentController` -> `removeAllScriptMessageHandlers`, `stopLoading:` | load-failure delegate, detach page | :275, 313-315 |
| `NSError` | `code`, `localizedDescription` | failure reason; ignore -999 | :267-268 |
| `NSMenu` | `alloc`, `initWithTitle:`, `addItem:`, `insertItem:atIndex:` | menus | :329-344 |
| `NSMenuItem` | `separatorItem`, `initWithTitle:action:keyEquivalent:`, `setKeyEquivalentModifierMask:`, `setSubmenu:`, `release` | menu items; modifiers Shift 1<<17, Control 1<<18, Command 1<<20 | :321-346 |
| `dispatch_async_f(queue, ctx, fn)` | libSystem.B.dylib | enqueue marker on main queue | :279-281, 289 |
| `_dispatch_main_q` (data symbol via `dlopen`/`dlsym`) | libdispatch.dylib | main queue address | :282, 286 |
| `pumpEvents()` | `@n1h/sweetview/native` | run OS loop up to 1000 times while draining | :290 |
| `objc_allocateClassPair`, `class_addMethod` (type `v@:` + `@` per arg), `objc_registerClassPair` | libobjc | `makeTarget` | objc.ts:94-118 |

Classes defined at run time (via `makeTarget`, name suffixed `_<n>` to be unique; one instance each, `alloc`/`init`):
- `SweetviewWindowTabs_<n>`, superclass `NSResponder` (one per `createWindowTabs` call), methods: `newWindowForTab:` -> `onNewTabRequest()`; `tabWindowWillClose:` -> `closed(notification.object)`; `tabWindowDidBecomeMain:` -> `keepTabBar` on a later timer tick (mac-window-tabs.ts:151-162).
- `SweetviewTabNavigation_<n>`, superclass `NSObject` (created once, lazily), methods (3 object args each): `webView:didFailProvisionalNavigation:withError:` and `webView:didFailNavigation:withError:` -> `failed` (mac-window-tabs.ts:270-273).

## Callbacks from the OS into JavaScript

| Callback | Called by | Thread (per comments) | Args -> return | Lifetime |
|---|---|---|---|---|
| Window procedure (x2: frame, pane), win-tab-window.ts:304-314 | user32 message dispatch for `SweetviewTabFrame` / `SweetviewTabPane` | unclear from the code; the class is registered on the thread that called `CoInitializeEx` STA | `(u64 hwnd, u32 msg, u64 wParam, i64 lParam) -> i64`; exceptions caught, fall back to `DefWindowProcW` | pushed to `kept`; "the classes call them until the process ends" (:301); never closed |
| `QueryInterface` (per handler kind), win-webview2.ts:121-128 | WebView2 | unclear from the code | `(ptr this, ptr riid, ptr out) -> i32` | stored in the kind's vtable; kind kept in module variable; never closed |
| `AddRef`, `Release` (per kind), :129-130 | WebView2 | unclear | `(ptr) -> u32` constant 2 / 1 | same |
| `Invoke` (per kind), :131-141 | WebView2 when the event fires | "runs inside WebView2: answer, and do the work on a later turn of the loop" (:168-169) | `(ptr this, ptr sender, ptr args) -> i32 S_OK`; exceptions caught | same; `forget()` removes the JS handler from `byAddress` so the object becomes inert; the 8-byte object stays in `kind.kept` |
| `drainMainQueue` marker, mac-window-tabs.ts:288 | libdispatch main queue (`dispatch_async_f`) | main queue, run while `pumpEvents` | `(ptr ctx) -> void`; sets `reached` | `marker.close()` if reached; otherwise left allocated "the queue may still call it" (:291-292) |
| `makeTarget` method callbacks (5), objc.ts:101-111 | ObjC runtime message send (AppKit responder chain, NSNotificationCenter, WKWebView navigation delegate) | unclear from the code | `(id self, SEL _cmd, id...) -> void`; exceptions caught | pushed to `retained` in objc.ts; never closed |

Non-FFI callbacks from pages: `uiMethods` and `webview.bind("__nativeTabsTitle")` are answered on the UI thread (shared.ts:1-2).

## State and lifetimes

Windows, win-tab-window.ts:
- Module state: `frames: Map<hwnd, Frame{options, stripPane, shown, live}>`, `panes: Set<hwnd>`, `dark`, scratch `rect`/`point`, `brushes` cache (never freed), `kept` callbacks, `ready` flag (:166-175, 301, 328).
- `prepare()` once: COM STA init, DPI awareness, two class registrations (:329-339).
- Frame: created by `createFrameWindow`; entry added to `frames` before sizing; `live` set true only at return so no callbacks fire during construction (:166, 373-478). Removed on `WM_NCDESTROY` (:271-273). Destroyed by `destroy()`.
- Panes: created as children (hidden unless strip pane, which is shown); tracked in `panes`; removed on `WM_NCDESTROY`. `adoptPane` hides the pane, clears `shown` in any frame that had it, then `SetParent` (:408-412). `showPane` places then `SetWindowPos` top + show; previously shown pane is left shown for the caller to hide afterwards (:134, 414-418).

Windows, win-webview2.ts:
- `compiled` cache of `CFunction` by method address, never cleared (:51).
- `getNativeHandle` lazily dlopened once (:65-69).
- Handler kinds created lazily, one per IID, live for the process; handler objects pushed to `kind.kept` and never freed ("WebView2 may hold one for as long as its webview exists, and a tab's worth is 8 bytes", :95-96).
- `ICoreWebView2*` from `get_CoreWebView2` is `Release`d right after each use (:213, 231). Controller pointer itself is not AddRef'd or released by this code.

Windows, win-tabs-app.ts:
- `TabWindow{frame, tabs, selected, strip, visible, closed}`; `Tab{number, title, address, app, listening, window, pane, opener, ready, closed}` (:33-63).
- Side maps: `controllers` (Tab|TabWindow -> controller), `cleanups` (Tab -> stop functions from `onAcceleratorKey`/`onNewWindowRequested`), `shown`, `stripUp`, `active`, `scrolledBy`, `making` (count of webviews in creation per window), `revealed` (promise per window), `settled` (resolves `openTab`) (:138-146).
- Tab teardown (`destroyTab`): run cleanups, drop controller, `app.dispose()`, `destroyPane` (:260-266). Ordering in `close`: unlist, present next tab first, hide pane, destroy if webview exists else deferred to `openTab`'s `finally` (:268-280).
- Window teardown (`destroyWindow`): remove from list, drop controller, `strip.dispose()`, `frame.destroy()`, `quitEventLoop()` if none left (:224-235). A window with zero tabs but `making > 0` is hidden; `openTab`'s `finally` destroys it later (:244-248, 560-566).
- After `createWebviewApp` returns: `frame.layout()` / `placePane()` must run because the library sized the pane its own way and its child not at all (:494, 569).
- Controller obtained after creation; `hideUnlessShown` then registration of handlers (:570-588).

macOS, mac-window-tabs.ts / mac-tabs-app.ts:
- Group state: retained identifier NSString (never released), `shown` and `hidden` sets of windows, the responder target (:118-120, 151).
- Window: `alloc/init`, `setReleasedWhenClosed:NO`; owned by this code. Released in `closed()` after `onClosed` returns on a later tick, or in `discard()` for never-shown windows; observers removed first (:122-137, 215-220).
- Close order in `onClosed`: drop records, `detachPage(window)` first, then `app.dispose()`, then announce; quit if no tabs (mac-tabs-app.ts:96-104).
- `detachPage`: remove from `loadFailureHandlers`, nil navigation delegate, `removeAllScriptMessageHandlers`, `stopLoading:`, `drainMainQueue()` twice (:308-319).
- `loadFailureHandlers` keyed by WKWebView id; one shared navigation delegate instance (:253-254).
- Menu objects: items released after adding (menu retains), holder and menu released after insertion (menubar/holder retain) (:339-346).
- `mac-tabs-app` maps: `open` (window -> Tab), `loading` (window -> promise until in tab bar), `newest` (base -> newest window asked to follow it) (:77-82).

## Workarounds and constraints stated in comments

- win-tab-window.ts:12-15: "The webview library puts its own child in it and never sizes that child again, so a pane's procedure does (WM_SIZE). Moving a tab to another window is SetParent on its pane: the webview goes with it, page and all."
- win-tab-window.ts:197-200: "The child is sized here and not only on WM_SIZE: the library makes it 0 by 0 in a pane that already has its size, and a pane that does not change size is sent no WM_SIZE."
- win-tab-window.ts:211: "Only the pane on show; one that is hidden is sized when it is shown, so dragging an edge costs one page's layout, not every tab's."
- win-tab-window.ts:229-232: "The first RECT of NCCALCSIZE_PARAMS comes in as the window and goes out as its client area. The default takes a caption and a border off the top; put the top back, so the client area reaches the window's top edge and the strip is the title bar. A maximised window hangs over the monitor's edges by its border, top included: that much stays off."
- win-tab-window.ts:309: "never let an exception unwind into user32"
- win-tab-window.ts:324: "hbrBackground stays NULL, WM_ERASEBKGND paints"
- win-tab-window.ts:331-332: "The webview library does these two only for windows it creates itself. WebView2 needs a single-threaded apartment on this thread, and DPI awareness can only be set before any window exists."
- win-tab-window.ts:381-382: "SWP_FRAMECHANGED sends the WM_NCCALCSIZE that takes the caption off (the one sent during creation came before `frames` knew the window)."
- win-tab-window.ts:449: "let go already: there is no gesture to hand over, and the move loop would wait for a click"
- win-tab-window.ts:454: "a maximised window is restored under the cursor by the window manager itself"
- win-tab-window.ts:154-159: the window "is first put back under it, so it does not trail the hand by the time it took to get here." (README:100-103: "without that the window trails the hand by a third of a quick drag")
- win-tab-window.ts:501-502: "The owner has to be the foreground window or the menu does not go away on a click elsewhere; the WM_NULL afterwards is the documented nudge that lets the next one close too (KB 135788)."
- win-tab-window.ts:498: "ids are 1-based: 0 is \"nothing chosen\""
- win-webview2.ts:7-8: "Slot numbers and interface ids are from WebView2.h (SDK 1.0.1150.38, the one the library is built with; a COM interface never changes once published)."
- win-webview2.ts:102-106: "A small typed array made the short way lives inside the garbage collector's heap until its `buffer` is first asked for, and is copied out then; one made over an ArrayBuffer is outside from the start and stays where it is."
- win-webview2.ts:129: "never freed, so never counted"; :136: "never let an exception unwind into WebView2"
- win-webview2.ts:193-195: "Left alone, WebView2 opens a bare popup window; here `opened` gets the address instead, on a later turn of the loop" (implemented with `setTimeout(..., 0)`, :207).
- win-tabs-app.ts:11-14: "a webview cannot be destroyed from inside its own callback, and the menu and the window drag run a loop of their own."
- win-tabs-app.ts:185: "WebView2 starts every page off as visible."
- win-tabs-app.ts:247: "a webview is still being made in one of its panes; openTab destroys the window when that is over"
- win-tabs-app.ts:273: "the next tab's page first, so the page area is never empty in between"
- win-tabs-app.ts:360: "a press that moved nothing is a click, not a drop"
- win-tabs-app.ts:449-451: "The press that led to it gave the strip the keyboard; when the work is over (a menu closed, a drag let go) the page has it back, as a click on a title bar never takes the keyboard from the document."
- win-tabs-app.ts:497: "the strip has no use for the browser's own (find, zoom, reload, print), and the tabs' keys work from here too."
- win-tabs-app.ts:503: "a strip that never asks still gets its window shown" (1500 ms)
- win-tabs-app.ts:589: "The page can ask who it is before `tab.app` is set, and events cannot reach it until then: tell it now what it missed." (same at mac-tabs-app.ts:174-176)
- README.md:135-137: "Destroying a webview asks the OS loop to end (the webview library posts `WM_QUIT`), which is right for an app's only window and wrong for one tab of several. `app.dispose()` takes the request back."
- README.md:170-173: Snap Layouts flyout not shown: "The system shows it only where the window itself answers `HTMAXBUTTON` to a hit test, and here that button is drawn by the strip's webview, which is another process's window."
- mac-window-tabs.ts:98-102: "only the pump has a pool: a native call made from any other turn of Bun's loop ... autoreleases into nothing, and what it autoreleased is never freed. That kept every closed tab's NSWindow alive."
- mac-window-tabs.ts:125: "AppKit is still inside the close; let it finish before the owner tears the page down."
- mac-window-tabs.ts:139-141: "AppKit hides the tab bar of a window with one tab, and the + with it."
- mac-window-tabs.ts:148-150: nextResponder "is the slot a window controller normally fills, and it is where AppKit looks for `newWindowForTab:`; finding it there is what makes the \"+\" appear."
- mac-window-tabs.ts:158: "once AppKit has finished moving the tab"
- mac-window-tabs.ts:205-206: "Left to pick for itself, AppKit reaches the web view through the key-view loop, which WebKit takes as arriving by Tab and answers by focusing the page's first field."
- mac-window-tabs.ts:260: "The webview library sets no navigation delegate, so the slot is free."
- mac-window-tabs.ts:282: "dispatch_get_main_queue() is a macro for the address of this object"
- mac-window-tabs.ts:289: "the queue is first in, first out: when this runs, all that was ahead of it has"
- mac-window-tabs.ts:299-306: "The webview library hands two things to the main dispatch queue with a plain pointer to its engine inside ... for a hosted window it does not [flush], so a reply still queued ... would run on freed memory and take the process down. So: no new calls ..., one drain for the calls already queued, one more for the replies those calls queue."
- mac-window-tabs.ts:284: drainMainQueue is "Not for use inside an AppKit callback."
- mac-tabs-app.ts:100: "first: a call or reply still on its way must not reach a disposed webview"

## Public shape

win-tab-window.ts:
- `type Rect = { x; y; width; height }`, `type Point = { x; y }` (numbers)
- `type FrameWindowOptions = { title; width; height; minWidth; minHeight; stripHeight; at?: Point; onCloseRequest(): void; onActivate(active: boolean): void; onResized(): void; onMoved(): void }`
- `type FrameWindow = { hwnd: bigint; stripPane: bigint; createPane(): bigint; adoptPane(pane): void; placePane(pane): void; showPane(pane): void; hidePane(pane): void; destroyPane(pane): void; layout(): void; pageSize(): {width,height}; show(); hide(); setTitle(title: string); stripRect(): Rect; scale(): number; isForeground(): boolean; maximized(): boolean; minimize(); toggleMaximize(); startDrag(held?: Point); startResize(edge: ResizeEdge, held?: Point); destroy() }`
- `setDarkWindows(on: boolean): void`; `asWindowHandle(pane: bigint): WindowHandle`; `windowExists(hwnd: bigint): boolean`; `cursorPosition(): Point`; `leftButtonDown(): boolean`; `createFrameWindow(options): FrameWindow`
- `type MenuEntry = { label: string; enabled?: boolean; click(): void } | "separator"`; `popupMenu(owner: bigint, entries: MenuEntry[]): void`; `windowMenu(hwnd: bigint): void`

win-webview2.ts:
- `type Controller = Pointer`; `controllerOf(webview: Webview, libPath: string): Controller`; `setVisible(c, visible: boolean)`; `moveFocus(c)`; `notifyMoved(c)`; `onAcceleratorKey(c, taken: (key: Key) => boolean): () => void`; `onNewWindowRequested(c, opened: (address: string) => void): () => void`; `devTools(c, method: string, params: object): void`

win-shortcuts.ts: `type Key = { virtualKey; control; shift; alt }`; `type Shortcut = "new" | "close" | "next" | "previous" | "closeWindow" | { select: number }`; `LAST_TAB = 8`; `shortcutFor(key: Key): Shortcut | undefined`

win-tabs-app.ts: `APP_NAME = "Native Tabs"`; `type Tab`, `type TabWindow`, `type TabsApp = { windows; open; openTab(address?, from?: {opener?, window?}): Promise<Tab>; select(tab); close(tab); move(tab, index); moveToNewWindow(tab): Promise<TabWindow>; mergeAll(); closeWindow(win); shortcut(win, s: Shortcut); stripState(win): StripState }`; `startTabsApp(): Promise<TabsApp>`

mac-window-tabs.ts: `type WindowTabsOptions = { identifier; width; height; minWidth?; minHeight?; onNewTabRequest(): void; onClosed(window: Id): void }`; `type WindowTabs = { createWindow(title): Id; show(window, after?): void; discard(window); setTitle(window, title); select(window); close(window); current(): Id | undefined; count(): number }`; `pooled<T>(body: () => T): T`; `asWindowHandle(window: Id): WindowHandle`; `createWindowTabs(options): WindowTabs`; `onLoadFailed(window: Id, handler: (reason: string) => void): void`; `detachPage(window: Id): void`; `installTabMenus(): void`

mac-tabs-app.ts: `APP_NAME`; `type Tab = { number; title; address?; app?; listening }`; `type TabsApp = { tabs: WindowTabs; open: ReadonlyMap<bigint, Tab>; openTab(address?, base?: bigint): Promise<bigint> }`; `startTabsApp(): TabsApp`

strip-shared.ts: types `StripTab`, `StripState {tabs, selected, maximized, active}`, `StripPoint`, `StripMethods` (strip.state/select/close/new/move/detach/drag/resize/minimize/maximize/closeWindow/menu/focus/scrolled/dark), `StripEvents {strip}`; constants `STRIP_HEIGHT=40`, `CAPTION_WIDTH=138`, `TABS_LEFT=8`, `TAB_MAX_WIDTH=240`, `TAB_MIN_WIDTH=72`, `NEW_TAB_WIDTH=40`, `DRAG_ROOM=56`; `tabWidth(stripWidth, count)`, `tabsViewport(stripWidth)`, `scrollToShow(stripWidth, count, index, scrolled=0)`, `dropIndex(stripWidth, count, x, scrolled=0)`

shared.ts: `type TabInfo {number, title, tabs}`; `tabHue(n)`; `type Methods` (tab.info/open/rename/close); `type Events {tabs: {count}}`

tab-page.ts: `type TabPageWords {lede, hint}`; `tabPageBody(words): string`; `FOLLOW_TITLE: string`

app.ts: no exports (entry script).
