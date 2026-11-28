# Public API audit: `pre-rust-rewrite` against the head of `v1-rust-rewrite`

The shapes in this report come from the TypeScript compiler, through `rust-rewrite/checks/api-diff.ts`. It loads every entry point of every package's `exports` map at each side and writes one line per fact: kind, every signature with parameter names, types, optionality, rest and defaults, return types, generics, every public class member and static, every interface and option field with optionality and readonly, enum values, union literals, and the `@deprecated`, `@default`, `@throws` tags and unit words of the doc comments. Options objects are expanded one level, field by field. The raw output is beside this file: `api-audit-before.txt`, `api-audit-after.txt`, `api-audit-diff.txt`. Guide line numbers refer to `docs/upgrading.md` at the head.

Run on the head after the merge of `d268609` (which carries the additions of `rust-rewrite-api-gaps`):

```
bun rust-rewrite/checks/api-diff.ts <checkout of tag pre-rust-rewrite> rust-rewrite/evidence
```

## What was compared

| Side | Entry points | Symbols | Facts |
|---|---|---|---|
| Before: the tag | 37 (25 application, 12 internal) | 610 (362 application, 248 internal) | 5622 |
| Before: `@n1h/sweetview-webview-bun` 2.7.0, the version the lockfile pins | 1 | 22 | 219 |
| Before: the 10 names `reference/bindings-exports.txt` lists for 2.8.0 that 2.7.0 does not have | 1 | 10, by name and guide row only | none |
| Before: published 0.1.x and 0.2.x | 12 sections of the guide's Part A | 240 guide rows, by name only | none |
| After: the head | 48 (38 application, 10 internal) | 710 (549 application, 161 internal) | 7290 |

Of the 610 tag symbols, 507 exist at the head under the same entry point and name, 90 are matched through a Part B row (73 of those map one kind to another, such as a constant to a method), and 13 have a row whose new form is the application's own code. 472 are identical fact for fact. Across the matched pairs, 38 facts are gone, 74 differ and 280 are new. All 22 bindings symbols match through Part C; 10 are identical. Every Part A row's import names an export the head has.

Headline counts:

- **Removed**: 0 exported symbols with no counterpart. 2 capabilities of the internal `/win32/tab-window` subpath have none (table 1, rows R1 and R2). 13 exports are replaced by the application's own `bun:ffi` table or type declaration (R3, R4).
- **Changed without an accurate guide entry**: 5 (table 2, rows C1 to C5).
- **Internals with no public replacement**: 7 capabilities that the guide or the docs send an application to an internal subpath, `bun:ffi` or a workaround for, with no public call at the head (table 4, rows I1 to I7). The merged additions close 6 rows (I-closed).
- **Capabilities with no public call**: 10 (table 5, rows K1 to K10), 6 of which existed before only as internal exports or not at all.

## 1. Removed

An export, member, option field, parameter, enum member or literal of a "before" surface with no counterpart at the head, after following the guide row and opening its target.

| # | Before | After | Guide | Note |
|---|---|---|---|---|
| R1 | `FrameWindowOptions.stripHeight: number` (required), `/win32/tab-window` at the tag | Nothing. The strip is `STRIP_HEIGHT === 40` of `/win32/strip-shared`, a constant. | No row names `stripHeight`. Line 1277 says the frame "takes every window option". | A tabbed window's strip height cannot be set. |
| R2 | `FrameWindow#createPane`, `#adoptPane`, `#placePane`, `#showPane`, `#hidePane`, `#destroyPane`, `#layout`, `#stripPane` | `FrameWindow#stripBounds`, `#pageRect`, `#pageSize` (geometry only) | Lines 1296 to 1303 | An application could host its own child window as a pane of the tab frame. Now it gets rectangles and must make the child webview itself, which only `createChildWebview` of `/internal` does (K3). |
| R3 | 11 `bun:ffi` library tables of `/win32/api` (`advapi32`, `comctl32`, `dwmapi`, `gdi32`, `kernel32`, `ole32`, `shcore`, `shell32`, `user32`), `hInstance`, `lastError` | The application's own `dlopen` | Lines 1226 to 1238 | By design (R3 of the requirements). Each row also names the public call for Sweetview's own use of that library. |
| R4 | `MessageHandler`, `MessageWindow` types of `/win32/message-window` | A type the application declares | Lines 1347, 1348 | The functions of that module map to `new Window()` (lines 1349, 1350). |
| R5 | `FrameWindowOptions.systemDark`, `.at`, `.width`, `.height` | `appearance: "system"`, `bounds`, `contentSize` | `systemDark` and `at` have no row; `width`/`height` of this type have none either (lines 532, 533 are `AppOptions`) | Counterparts exist; the guide does not say so for this type. |
| R6 | 10 bindings 2.8.0 names (`WebviewError`, `WebviewRequest`, `WebviewResponse`, `WebviewResponseHead`, `RequestHandler`, `FileDropHandler`, `completeWebviewRequest`, `beginWebviewResponse`, `writeWebviewResponseChunk`, `endWebviewResponse`) | Same names on `@n1h/sweetview-native` | Lines 1609 to 1639 | Present at the head by name and kind. Their 2.8.0 shapes are in neither checkout, so they were not compared fact by fact. |

Every other tag export has a counterpart. The 38 vanished facts are R1, R2, R5, `FrameCallbacks.onCloseRequest` (mapped to `Window#onClose`, line 1306), `FrameWindow#destroy` (mapped to `Window#dispose`, line 1304), and the literal values of `/win32/api` and `/win32/menu` constants mapped to methods.

## 2. Changed

| # | Symbol | Before | After | Guide accurate? | Existing call compiles and means the same? |
|---|---|---|---|---|---|
| C1 | `SessionKind`, `TransportKind` (`@n1h/sweetview/ipc`, `@n1h/sweetview-ipc`) | `"webview" \| "web"` | `"webview" \| "web" \| "electron" \| "tauri"` | No. Lines 363, 365, 810, 812, 981, 983 say "unchanged". | A `switch` that checks exhaustiveness with `never` stops compiling. |
| C2 | `WindowChromeMethods`, `WindowChromeMethodTable` (`@n1h/sweetview`, `/window-chrome`) | six keys | adds `"window.systemMenu"` | No. Lines 285, 286, 338, 339, 716, 717, 784, 785 say "unchanged"; the "Additions" bullet (line 129) does not name the key. | An object the application types as `WindowChromeMethodTable` stops compiling (missing key). Values from `windowChromeMethods()` are unaffected. |
| C3 | `WindowChromeControls` (`/window-chrome`) | `info`, `onTitlePointerDown`, `onHandlePointerDown`, `minimize`, `toggleMaximize`, `close` | adds `onMaximizeChange(fn): () => void`, `showSystemMenu()` | No. Lines 335, 781 say "unchanged"; line 129 names `windowChromeEvents` but not these members. | Consumers compile. An application that implements the type stops compiling. |
| C4 | Part A step 3 (lines 176 to 182) | 0.x `width`/`height`, the page's client size in DIPs | Step 3 says to set `app.webview.raw.size` after `createApp`; row 532 says `contentSize` | No. The step and the row disagree; the step is the workaround that `contentSize` replaced. | Both work; the step leaves a resize after the window exists. |
| C5 | `Webview#unsafeWindowHandle` (bindings and `RawWebview`) | `bigint \| Pointer \| null` | `number \| null` | Row 1648 says "as a number", which is right. It does not say that a `number` is not assignable to Bun's branded `Pointer`. | An application's own typed `dlopen` call that takes it as `FFIType.ptr` stops compiling until it is cast. Same value. |
| C6 | `Webview` constructor `(handle)` and `#unsafeHandle` | `Pointer` | `WebviewHandle` (an opaque `number`) | Yes, rows 1647 and 1649 and the "Handles" bullet. | A real pointer still type-checks (a `Pointer` is a `number`) and now throws `WebviewError` code -1. |
| C7 | `Webview` constructor `(debug, size, window)` | `window?: Pointer \| null` | `window?: WindowHandle` | Yes, row 1651. | Compiles; same meaning. |
| C8 | `Webview#bindRaw` | `arg?: Pointer \| null` | `<A = null>(…, arg?: A)` | Yes, row 1652. | Compiles; any value now. |
| C9 | `SizeHint`, `MouseEvent`, `KeyEvent`, `Modifier`, `Feature`, `Permission` | `const enum` | `enum` | Yes, "Enums" bullet and each row. | Compiles; members are values at run time too. |
| C10 | `FrameCallbacks` (`/win32/tab-window`) | optional properties `onCloseRequest`, `onActivate`, `onResized`, `onMoved` | optional methods `onActivate`, `onResized`, `onMoved` | Yes, row 1275. | Compiles except `onCloseRequest`. |
| C11 | `FrameWindowOptions` to `WindowOptions` | `title` required, `bounds` doc "pixels", `minWidth` "physical pixels" | `title` optional, `bounds` "physical pixels on Windows, points on macOS" | Yes, row 1277. | Compiles; same units. |
| C12 | `windowChromeMethods(window, …)` | `Pick<Window, six members>` | adds `& Partial<Pick<Window, "showSystemMenu">>` | Not needed: wider. | Compiles. |
| C13 | `Menu.popup`, `popupMenu` | `(owner, menu, at?)` | adds `options?: MenuPopupOptions` (`above`) | Yes, line 122 and 129. | Compiles. |
| C14 | `WindowOptions`, `AppOptions`, `createApp`, `new Window`, `createWindow` | 25 fields | adds `contentSize`, `backgroundColor`, `onMaximizeChange` | Yes, line 129. | Compiles. |
| C15 | `permissions.autoRequest` | accessor | property | Not needed. | Compiles; same use. |
| C16 | `getTabFrame`, `cursorPosition` (`/win32/tab-window`) | `const` / `function` | `function` / `const` alias of `Screen.cursor` | Not needed. | Compiles. |
| C17 | 0.x `createWebviewApp` window | shown at once, client size 1100 x 800 DIPs, close hides an overlay | `createApp` hidden until `show()`, `bounds` outer frame physical pixels, close disposes | Yes, "Showing and sizing" and "Closing" bullets and steps 3 to 5. | Compiles; differs in behaviour as documented. |

Thread rules: `Clipboard.*` and `singleInstance` throw off the UI thread at the head ("Errors and threads" bullet). The compiler cannot see thread rules; the doc words were compared and the bullet is the only statement of it.

## 3. Added

171 exports at the head match no before symbol. By entry point:

| # | What | For |
|---|---|---|
| A1 | `@n1h/sweetview-ipc-electron` (and `/client`, `/preload`, `/server`; also under `@n1h/sweetview/ipc-electron*`): `electronHost`, `electronTransport`, `exposeSweetviewIpc`, `createSweetviewIpcApi`, `isElectron`, the channel constants and the `*Like` structural types | Running the same typed IPC in an Electron application |
| A2 | `@n1h/sweetview-ipc-tauri` (and `/client`; also `@n1h/sweetview/ipc-tauri*`): `tauriTransport`, `tauriGlobalApi`, `isTauri`, `TAURI_COMMAND`, `TAURI_EVENT`, the `Tauri*` types | The same IPC in a Tauri application |
| A3 | `@n1h/sweetview/native` now also exports the bindings names (`Webview`, `RawWebview`, the input hooks, `permissions`, the streaming functions, the enums): 34 names | One import for an application that depends on `@n1h/sweetview` |
| A4 | `@n1h/sweetview-native`: `RawWebview`, `WebviewHandle`, `MenuPopupOptions` | The webview class under its facade name; the opaque handle type; the `above` option |
| A5 | `Window#isMinimized`, `#onMaximizeChange`, `#showSystemMenu`; `WindowOptions.contentSize`, `.backgroundColor`, `.onMaximizeChange` | Minimised state, maximise changes, the system menu, sizing a window from its page, a colour before the page paints |
| A6 | `windowChromeEvents`, `WindowChromeEvents` (`@n1h/sweetview`, `/window-chrome`); `WindowChromeControls#onMaximizeChange`, `#showSystemMenu` | Maximise changes and the system menu for a page-drawn title bar |
| A7 | `@n1h/sweetview-native/shell-icons`: `refreshShellIcons` | Asking Explorer to reload icons after a build; used by `@n1h/sweetview-build` |
| A8 | `/internal`: `createChildWebview`, `deferNative`, `engineOf`, `NativeEngine`, `macosKeepsTagPath`, `openNativeDrain`, `quitNativeLoop`, `releaseAll`, `releaseAtEnd`, `ReleaseKind`, `runNativeLoop`, `wakeNative` | Plumbing between `@n1h/sweetview` and the binding (see table 4b) |
| A9 | `/win32/menu`: `BuiltMenuData`, `handleValue`, `iconBytes`, `menuData` | Plumbing of `buildMenu` and the tray |
| A10 | `SessionKind`, `TransportKind` literals `"electron"`, `"tauri"` | The two new transports (C1) |

## 4. Internals an application was sent to

### 4a. Guide rows and doc pages whose "write now" is an internal subpath, `bun:ffi` or a workaround

| # | Row or page | Capability | Public call at the head | State |
|---|---|---|---|---|
| I1 | 1333, 1334 `buildMenu`, `destroyMenu` (`/win32/menu`); `docs/native/menus-and-tray.md:114-131`; Part A step 1 (line 165) | An `HMENU` with Sweetview's items for the application's own `TrackPopupMenu` or `WM_COMMAND` | None | Remains |
| I2 | 1276, 1280, 1296, 1303, 1305 `FrameWindow`, `getTabFrame(BigInt(win.handle))` (`/win32/tab-window`) | The tab frame's strip and page rectangles, to place an own strip or page | None | Remains |
| I3 | 1139 `scheduleNativeTimeout`; used by `demos/native-tabs/scripts/mac-drive.ts:14` | A timer that fires inside the native loop | None (`setTimeout` while `runEventLoop` pumps is the nearest) | Remains |
| I4 | 1323 `systemIsDark` (`/win32/window`) | Whether the system is in dark mode | None (`appearance: "system"` follows it but does not report it) | Remains |
| I5 | 1283 `showTabPopupMenu`, 1336 `popupMenu` | A popup menu at the cursor | `Menu.popup(owner, menu, at?)` | Public call exists; the rows still name the internal one first |
| I6 | Part A step 3 (lines 176 to 182) | A page of `width` x `height` DIPs | `contentSize` | Public call exists; the step still gives the workaround (C4) |
| I7 | 1125 to 1138, 1140 (`/internal` emitters and window plumbing), 1245 to 1269 (`/win32/shortcuts`, `/win32/strip-shared`), 1318, 1319 (`_debugTrackedCount`, `asHwnd`) | Sweetview's own wiring | Not meant for applications | "unchanged (internal)" rows keep an application on them |
| I8 | 1226 to 1238 (`bun:ffi` tables) | The application's own Win32 calls | The application's own `dlopen` | By design |
| I9 | "Environment variables" bullet: `WEBVIEW_PATH` to `SWEETVIEW_NATIVE_PATH` | A custom native build | The variable | By design |

Rows the merged additions close (I-closed), now closed on the main branch itself:

| Row | Before | Closed by |
|---|---|---|
| 1285 `windowMenu` | `windowMenu(hwnd)` of `/win32/tab-window` | `Window#showSystemMenu()` |
| 1337 `popupMenuAtCursor` | `/win32/menu` | `Menu.popup(owner, menu, at, { above: true })` |
| 1238 `user32` (its `IsIconic` use) | the application's own `IsIconic` | `Window#isMinimized()` |
| 1214 `WM_SIZE` (its `SIZE_MAXIMIZED` use) | a timer polling `isMaximized()` | `Window#onMaximizeChange` |
| 532, 533 `width`, `height` | `app.webview.raw.size` | `contentSize` |
| `docs/native/menus-and-tray.md:135` system menu | `windowMenu` | `Window#showSystemMenu()` (the page still names `windowMenu`) |

`backgroundColor` and `windowChromeEvents` close no row: no row sent an application elsewhere for them.

### 4b. Every export of `/internal`, `/win32/*` and `/shell-icons` at the head, with who imports it

Importers are files that name the export and import the subpath (or its file). "guide" is a row of `docs/upgrading.md` for that name; "compat" is `rust-rewrite/compat/`; "pkg" a package's source; "test" a package's test; "demo" and "doc" as named.

| Entry point | Export | Imported by |
|---|---|---|
| `/internal` | `createChildWebview`, `engineOf`, `NativeEngine` | pkg `sweetview`, compat |
| | `deferNative`, `openNativeDrain`, `quitNativeLoop`, `runNativeLoop`, `wakeNative` | pkg `sweetview` |
| | `discardQuit`, `emitWindowFileDrop`, `emitWindowNewTab`, `emitWindowTabClose`, `emitWindowTabSelect`, `forwardWindowTabEvents`, `getWindowBackend`, `getWindowMeta`, `holdWindowNativeDispose`, `isWindowDisposed`, `onWindowDispose`, `onWindowFileDropListenersChange`, `preserveWindowGeometry`, `windowFileDropCount` | pkg `sweetview`, compat, guide |
| | `emitActivationUrl` | test `sweetview`, compat, guide |
| | `scheduleNativeTimeout` | pkg `sweetview`, demo `native-tabs`, compat, guide |
| | `macosKeepsTagPath`, `releaseAtEnd` | pkg `sweetview`, pkg `sweetview-native` |
| | `releaseAll` | pkg `sweetview-native` |
| | `ReleaseKind` | nobody outside its file |
| `/win32/shortcuts` | `Key`, `LAST_TAB`, `shortcutFor` | pkg `sweetview`, test `sweetview-native`, compat, guide |
| | `Shortcut` | pkg `sweetview`, compat, guide |
| `/win32/strip-shared` | `CAPTION_WIDTH`, `NEW_TAB_WIDTH`, `TABS_LEFT`, `dropIndex`, `tabWidth`, `tabsViewport` | pkg `sweetview`, test `sweetview-native`, guide |
| | `STRIP_HEIGHT` | pkg `sweetview`, pkg `sweetview-native`, test `sweetview`, guide |
| | `DRAG_ROOM`, `TAB_MAX_WIDTH`, `TAB_MIN_WIDTH`, `scrollToShow` | test `sweetview-native`, guide |
| | `StripEvents`, `StripMethods`, `StripPoint`, `StripState` | pkg `sweetview`, compat, guide |
| | `StripTab` | compat, guide |
| `/win32/tab-window` | `getTabFrame` | pkg `sweetview`, pkg `sweetview-native`, test `sweetview-native`, compat, guide (an application, I2) |
| | `windowMenu` | pkg `sweetview`, pkg `sweetview-native`, test `sweetview-native`, doc `native/menus-and-tray.md`, compat, guide |
| | `FrameWindow` | pkg `sweetview`, compat, guide (an application, I2) |
| | `FrameCallbacks` | compat, guide |
| | `showTabPopupMenu` | pkg `sweetview`, compat, guide |
| | `cursorPosition`, `leftButtonDown`, `windowExists` | pkg `sweetview`, guide (rows point at public calls) |
| | `setDarkWindows` | guide only |
| `/win32/window` | `asHwnd`, `fromHandle` | pkg `sweetview`, pkg `sweetview-native`, tests of both, guide |
| | `createWindow` | pkg `sweetview-native`, test `sweetview-native`, guide |
| | `_debugTrackedCount` | test `sweetview-native`, guide |
| | `systemIsDark` | guide only (an application, I4) |
| `/win32/menu` | `buildMenu` | pkg `sweetview-native`, test `sweetview-native`, doc `native/menus-and-tray.md`, compat, guide (an application, I1) |
| | `destroyMenu` | test `sweetview-native`, doc, compat, guide (an application, I1) |
| | `popupMenu` | pkg `sweetview-native`, compat, guide |
| | `popupMenuAtCursor` | test `sweetview-native`, compat, guide |
| | `iconBytes`, `menuData` | pkg `sweetview-native`, test `sweetview-native` |
| | `BuiltMenuData`, `handleValue` | nobody outside its file |
| `/shell-icons` | `refreshShellIcons` | pkg `sweetview-build`, test `sweetview-build` |

An application is sent to `getTabFrame`, `FrameWindow`, `buildMenu`, `destroyMenu`, `systemIsDark` and `scheduleNativeTimeout` (I1 to I4) with no public alternative. Everything else above is used only by Sweetview's own packages, tests, the compat suite, or a guide row that already names a public call.

## 5. Capabilities, not names

What an application could do before, and the call that does it at the head. "Public" means an application entry point.

| # | Capability | Before | After | Public? |
|---|---|---|---|---|
| K1 | Get an `HMENU` of Sweetview's items for an own `TrackPopupMenu` | `buildMenu` (`/win32/menu`, internal) | `buildMenu` (`/win32/menu`) | No (I1) |
| K2 | Read the tab frame's strip and page rectangles | `FrameWindow` (`/win32/tab-window`) | `getTabFrame(…).stripBounds()`, `.pageRect()` | No (I2) |
| K3 | A webview at given bounds inside an own window | `createFrameWindow` + `createPane`/`adoptPane`, or `RawWebview(debug, size, window)` | `createChildWebview(debug, window, bounds)` of `/internal`; `RawWebview(debug, size, window)` fills the window | No for bounds (R2) |
| K4 | A timer or deferred job on the UI thread inside the native loop | `scheduleNativeTimeout` (`/internal`) | `scheduleNativeTimeout`, `deferNative` (`/internal`) | No (I3) |
| K5 | Whether the system is dark | `systemIsDark` (`/win32/window`) | the same | No (I4) |
| K6 | A window activation or focus event, and whether a window is in front | `FrameWindowOptions.onActivate`, `FrameWindow#isForeground` (internal) | `FrameCallbacks#onActivate`, `FrameWindow#isForeground` (internal) | No |
| K7 | Ask a window to close as its X does (runs `onClose` listeners) | none public | `FrameWindow#requestClose` (internal); `Window` has `onClose` and `dispose` only | No |
| K8 | Navigation failed, new-window (popup) requests, the DevTools protocol | Built-in behaviour only: a failed URL tab shows "This site did not open" (tag `docs/app.md:249`) | `NativeEngine#onNavigationFailed`, `#onNewWindowRequested`, `#callDevToolsProtocolMethod` (`/internal`) | No (new in Rust, never public) |
| K9 | Remove an `init` script | not possible (`Webview#init` only) | not possible | No (gap, not a loss) |
| K10 | Set the tab strip's height | `stripHeight` (internal) | none | No (R1) |
| K11 | Windows of every style: framed, frameless, transparent, colour key, opacity, topmost, no-activate, hidden from the taskbar, tabbed | `createWindow`, `createFrameWindow`, 0.x `makeOverlay` | `new Window(options)` | Yes |
| K12 | A page in a window, in tabs, in a new window | `createApp`, `WebView.attach`, `openTab`, 0.x `createWebviewApp` | the same | Yes |
| K13 | Window events: resize, move, close, file drop, new tab, tab select and close, maximise change | `Window#on*` | `Window#on*`, `onMaximizeChange` new | Yes |
| K14 | Window state: visible, maximised, minimised, scale, bounds, handle | `Window`, own `IsIconic` | `Window`, `isMinimized` new | Yes |
| K15 | Screens, work area, cursor | `Screen`, 0.x overlay `screen()`, `workArea()`, `cursor()` | `Screen`, `ScreenInfo` | Yes |
| K16 | Tray, notifications, popup menus (down and up), system menu | `Tray`, `Notifier`, `Menu.popup`, `popupMenuAtCursor`, `windowMenu` | `Tray`, `Notifier`, `Menu.popup` with `above`, `Window#showSystemMenu` | Yes |
| K17 | Clipboard, folder picker, single instance, URL schemes | public | public; clipboard and `singleInstance` now UI thread only | Yes |
| K18 | Input hooks and permissions | bindings package | `@n1h/sweetview-native` | Yes |
| K19 | Webview calls: navigate, HTML, assets, `init`, `eval`, `bind`, request handler, streamed responses from any thread, file drops, background colour, external drop | bindings `Webview` | `Webview` / `RawWebview` | Yes |
| K20 | Both loop modes, pumping, quitting, own `bun:ffi` in the loop | `run()`, `runEventLoop`, `pumpEvents`, `quitEventLoop` | the same | Yes |
| K21 | The real window handle for own native calls | `Window.handle`, `Webview.unsafeWindowHandle` | the same (a `number`, C5) | Yes |

`rust-rewrite/PORT-STATUS.md` table 1 is confirmed by the compiler on each lead it names: the navigation-failed event, the popup handler and the DevTools protocol (K8), the child webview (K3), native timeouts and deferred jobs (K4), removing an `init` script (K9), `buildMenu`/`destroyMenu`/`windowMenu` only through `/win32/*` (K1; `windowMenu`'s use now has `Window#showSystemMenu`), and no `Window#close()` (K7). The audit adds K2, K5, K6 and K10.

## 6. Consistency of the after-API as a design

| # | Finding | Where |
|---|---|---|
| D1 | One class under three exported names and a fourth that differs by case: `Webview` and `RawWebview` from `@n1h/sweetview-native`, `RawWebview` from `@n1h/sweetview`, and the unrelated `WebView` class. | `packages/sweetview-native/src/index.ts:65`, `packages/sweetview/src/index.ts:49`, `packages/sweetview/src/app.ts:240` |
| D2 | Two listener forms. `Window#onResize`, `#onMove`, `#onClose`, `#onFileDrop`, `#onMaximizeChange` take a handler and return an unsubscribe; `Webview#setFileDropHandler` and `#setRequestHandler` take a handler or `null` and return nothing; the same events also exist as `on*` option fields. File drops have both forms on two objects. | `packages/sweetview-native/src/window.ts:579`, `packages/sweetview-native/src/webview.ts:476`, `:581` |
| D3 | A factory beside each class: `createWindow`/`Window`, `createTray`/`Tray`, `createNotifier`/`Notifier`, `createHitRelay`/`HitRelay`. `createApp` has no class; `WebView` is made by the static `WebView.attach`, not `new`. | `window.ts:650`, `tray.ts:75`, `notifications.ts:85`, `hit-regions.ts:94` |
| D4 | Teardown is `dispose()` on `Window`, `Tray`, `Notifier`, `App`, the instance lock and the IPC hosts, `destroy()` on `Webview`, and `TabHandle` and `Tab` have both `close()` and `dispose()`. | `webview.ts:380`, `window.ts:44-45`, `app.ts:142-144` |
| D5 | A close request with no listener disposes a `Window`, while `windowChromeMethods`'s `onClose` defaults to `window.hide()`. | `packages/sweetview/src/window-chrome.ts:67` |
| D6 | Units differ between sibling sizes: `bounds` is the outer frame in physical pixels (points on macOS), `contentSize` the page in DIPs, `minWidth`/`minHeight` the outer frame in physical pixels, `Webview#size` DIPs. | `window.ts:53-68`, `app.ts:348` |
| D7 | `identity` exists on `WindowOptions` and `NotifierOptions` but not on `TrayOptions`; `NotifierOptions` has both `identity` and `appId` for one thing. `createNotifier(options?)` is optional, `createTray(options)` required. | `api-audit-after.txt`, `TrayOptions`, `NotifierOptions` |
| D8 | `createApp` and `singleInstance` return a `Promise`; `new Window`, `createTray` and `createNotifier` are synchronous. | `app.ts:935`, `activation.ts:196` |
| D9 | Public types carry internals: `WindowHandle` is `Pointer \| bigint \| number \| null` with Bun's `bun:ffi` `Pointer`; `Window.handle` is a `WindowHandle` while `Webview.unsafeWindowHandle` is `number \| null` and `FrameWindow.hwnd` a `bigint`, so the guide writes `getTabFrame(BigInt(win.handle))`. | `packages/sweetview-native/src/types.ts:8`, guide line 1280 |
| D10 | 193 names are exported by more than one application entry point (`@n1h/sweetview/native` re-exports `@n1h/sweetview-native`; `@n1h/sweetview/ipc*` re-export `@n1h/sweetview-ipc*`; `@n1h/sweetview` repeats `defineAppIdentity`, `runEventLoop`, `singleInstance`, `RawWebview`, `SizeHint`). | `api-audit-after.txt` |
| D11 | Internal subpaths are in the `exports` map beside application ones, and the guide gives "unchanged (internal)" rows for 40 of their exports, which presents them as an upgrade target. | `packages/sweetview-native/package.json` `exports`; guide lines 1125 to 1269 |

## 7. What `verify.ts`'s `api-surface` check establishes

It reads the source text of the tag files named `index`, `page`, `worker`, `window-chrome`, `client`, `server` or `hit-regions` directly under a package's `src/` (12 of the tag's 37 entry points; no `/win32/*`, `/darwin/*`, `/internal`, `ipc/*`, `native/*`, `build`, `settings-store` or `app-identity`), collects names by regular expression (not following `export *`), and counts a name as "kept" when the same file at the head declares the same name and as accounted for when any table row of the guide mentions the name in backticks. So "194 kept" means that 194 names still appear in the same 12 files; it says nothing about types, parameters, members, options, units or behaviour, and nothing about the 25 entry points it does not read.

## What should change

1. Add a public tab-frame geometry call (for example `Window#tabStripBounds()` and `#tabPageRect()` on a `tabs: true` window) and a public child webview at bounds; settles I2, K2, K3, R2.
2. Add a public `HMENU` call (`Menu.build(menu)` returning `{ handle, commands, dispose }`) and move `docs/native/menus-and-tray.md` and Part A step 1 to it; settles I1, K1.
3. Add `Window#requestClose()` (runs `onClose` listeners, disposes without one) and a public activation event and foreground query (`onActivate`, `isForeground`); settles K6, K7.
4. Make the webview's navigation-failed event, new-window handler and DevTools protocol call public on `Webview` or `WebView`, and add removal for an `init` script; settles K8, K9.
5. Add a public UI-thread timer and deferred job (`Loop.setTimeout`, `Loop.defer`) and move the `native-tabs` demo off `/internal`; settles I3, K4.
6. Add a public system appearance query (`systemAppearance(): "light" | "dark"`, with a change event); settles I4, K5.
7. Correct the guide rows that say "unchanged" for `SessionKind`, `TransportKind`, `WindowChromeMethods`, `WindowChromeMethodTable` and `WindowChromeControls`, naming the new literals, the `window.systemMenu` key and the two members; settles C1, C2, C3.
8. Replace Part A step 3's `app.webview.raw.size` workaround with `contentSize`; point rows 1283 and 1336 at `Menu.popup` first; settles C4, I5, I6.
9. Say in row 1648 and the "Handles" bullet that `unsafeWindowHandle` is a plain `number` that an own typed `dlopen` call casts to `Pointer`, and give `Window.handle` and `unsafeWindowHandle` one type without `bun:ffi`'s `Pointer`; settles C5, D9.
10. Restore a strip height option on tabbed windows, or state in row 1277 that the strip is fixed at 40 DIPs; add rows for `FrameWindowOptions` `systemDark`, `at`, `width`, `height`; settles R1, R5, K10.
11. Remove the internal subpaths from the application-facing guide (or mark the "unchanged (internal)" rows as not an upgrade path) once 1 to 6 give public calls; settles I7, D11.
12. Pick one teardown verb (`dispose`) and one listener form (handler in, unsubscribe out), keeping the others as deprecated aliases; settles D2, D4.
13. Make `windowChromeMethods`'s default `onClose` match a `Window`'s (dispose), or document why it hides; settles D5.
14. Pick one name for the webview class (`RawWebview` or `Webview`, not both), and one way to make each object (`new` or `create*`); settles D1, D3.
15. Add `identity` to `TrayOptions` and fold `NotifierOptions.appId` into `identity`; settles D7.
16. Replace `api-surface` with this tool's diff (or extend it to every `exports` entry and to shapes); settles table 7.
17. Pin the bindings package at 2.8.0 for macOS, or change `reference/bindings-exports.txt` to 2.7.0, so the third "before" surface can be compared by shape; settles R6.

## How the tool was checked

Ten symbols of different kinds were read from the dump and compared with their source, at each side.

- After: `Window` (class: constructor, 31 instance members, statics `fromHandle` and `visibleWindows`, `window.ts:386-616`), `createApp` (generic async function, options expanded through `AppOptions = WindowOptions & WebViewOptions`, including `ringBytes` at `app.ts:68`), `MouseEvent` (enum values, `input-hooks.ts:60-69`), `Appearance` (string-literal union, `window.ts:27`), `Clipboard` (const of a local object type, `clipboard.ts:3-17`), `MenuItem` (union of object types, `menu.ts:7-19`), `ScreenInfo` (readonly fields), `WindowOptions.bounds` (doc default and units, `window.ts:52-57`), `TabHandle` (`close` and `dispose`, `window.ts:41-45`), `Webview` (two constructor overloads and accessors).
- Before: the tag's `Window` (member list and statics), `FrameWindowOptions` (required `title` and `stripHeight`, method-style callbacks, tag `tab-window.ts:100-134`), `FrameCallbacks` (`Partial<Pick<…>>` resolved to four optional properties, `:136`), `FrameWindow` (members, `:138-160`), `WindowOptions.bounds` (tag doc "Outer frame bounds"), `createApp` (already `Promise<App>` at the tag), the bindings `Webview` (constructors `(handle: Pointer)` and `(debug?, size?, window?: Pointer | null)`, `webview.ts:126,159`), `permissions.autoRequest` (accessor), `MouseEvent` and `SizeHint` (`const enum`, `mouse-hook.ts:32`, `webview.ts:38`).

All twenty matched. The first run compared exports of different kinds fact by fact (a constant against a class) and printed whole classes as additions; the tool now compares those only through the members and option fields the guide row names.

## What this audit could not establish

- The published 0.x API is not installed in either checkout. Its side is the guide's own Part A account: 240 rows, checked only in that each row's import names an export of the head. No 0.x signature, option field or default was compared by the compiler, and table 2 rows about 0.x (C4, C17) rest on the guide's words.
- The installed bindings package is 2.7.0 (the lockfile pin); the reference list names 2.8.0. The 10 names 2.8.0 adds were checked by name and guide row only (R6).
- Thread rules, thrown errors and behaviour are outside what types show. The tool records the unit and thread words of doc comments, and the report compares those and the guide's bullets; nothing here ran a call.
- The importer column of table 4b is from text search (a file that names the export and imports the subpath), not from the compiler's reference graph.
