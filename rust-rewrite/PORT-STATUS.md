# What is and is not ported to Rust on Windows

Tree: `bf5881d` (the main branch with the first part of `rust-rewrite-api-gaps` merged). macOS and Linux are other goals and are not covered.

## How this was established

- Three read-only reviewers each read one slice of the code and its tests (webview and input hooks; loop, windows and shell; tabs, packaging and a sweep for what is not Rust). They ran nothing. They were told to take no status from the checklist, the decisions, the evidence files or the upgrade guide.
- One full run of the checks on this tree: `cargo test --workspace` every suite passed, 1 test ignored; `bun test` 510 pass, 20 skip, 0 fail; the tabs fixtures 100 of 100 and 10 of 10 checks passed. `bun test` prints no line per passing test, so "passed" below means: the reviewer read the test, and the run had no failure and did not report it skipped.
- Of the 20 skips, 15 are tests for other platforms. Five were skipped because the desktop did not give the test's window the foreground: the two keyboard-hook tests with the application's own window in front, the F12 developer-tools test, and the two accelerator-key tests.
- The old webview library and the old bindings package are not in this tree, and the reference inventories have no section on the webview, page calls, the input hooks, the tray, the folder dialog or the event loop. For those areas nobody compared the new behaviour with the old.

## 1. Not ported, or not there

| What | State | Where |
|---|---|---|
| A streamed response reaching the page as it is written | Not achieved. The bytes go through the Rust stream, and the page receives the body only when the response ends. A test asserts that. Whether the old library streamed to the page on Windows is unknown. | `packages/sweetview-native/src/webview.ts:177-181`; `crates/sweetview-platform-webview/src/stream.rs:144-180` |
| The page behaviour WebView2 has by default (zoom, pinch zoom, swipe navigation, status bar) and CSS `app-region` off | No project code sets any of them; whatever `wry` sets applies. No test. A fix sits on the unmerged branch `rust-rewrite-fix-webview-behaviour`. | `crates/sweetview-runtime/src/engine.rs:225-246` |
| A display-scale change on an ordinary window | No handling of its own; left to `tao`. No test. Only the tabbed frame applies the rectangle Windows suggests. | `crates/sweetview-platform-window/src/windows.rs:925-990` |
| Keyboard access to the tab strip's own buttons and tabs | Not implemented: every control is `tabindex="-1"` and the strip marks every key handled. | `packages/sweetview/src/tabs/win-strip-assets.ts:8-12` |
| A binding for Windows ARM64 or 32-bit | None: the loader throws for any target but `win32-x64`. | `packages/sweetview-native/src/binding.ts:68-71` |
| A public call for: the navigation-failed event, the new-window (popup) handler, a child webview at given bounds, native timeouts and deferred jobs, the DevTools protocol, removing an `init` script | Implemented in Rust, reachable only through `@n1h/sweetview-native/internal`, or not at all. | `packages/sweetview-native/src/internal.ts` |
| `buildMenu`, `destroyMenu`, `windowMenu` | Implemented, reachable only through the `/win32/menu` and `/win32/tab-window` subpaths, which the docs tell applications to import. | `docs/native/menus-and-tray.md:114-135` |
| `Window#close()` | Does not exist. | `packages/sweetview-native/src/window.ts` |
| `setAppMenu`, `setAppIcon`, `setActivationPolicy`, `permissions`, a native URL event | Do nothing or return constants on Windows, as before the rewrite: they are macOS features. | `crates/sweetview-runtime/src/app.rs:23-35` |

## 2. Ported, and behaves differently from before

Found by reading the new code against the reference inventory, or stated by the new code itself.

| What | Difference |
|---|---|
| `pumpEvents()` called from inside a running loop | Does nothing and returns true (`crates/sweetview-runtime/src/runtime.rs:214`). |
| `startDrag` on a window Sweetview made | Returns before the drag ends. |
| `singleInstance`, second instance | Sleeps the UI thread between its ten lookups, where the old code let Bun's loop run (`crates/sweetview-platform-shell/src/single_instance.rs:131-135`). |
| `tab.webview.window` | Names the frame the tab opened in. After a tear-off or merge it can name a destroyed window (`packages/sweetview/src/tabs/win-tabs.ts:704`). |
| The page context menu | On even with `debug: false`; the docs say `debug` enables it (`crates/sweetview-runtime/src/engine.rs:214-215`). |
| A popup from a plain (untabbed) window | Allowed, so WebView2 opens a window of its own. Inferred, not run. |
| `pickFolder` on a COM failure | Returns `null`, where the docs say it throws. Inferred. |
| `Screen.of` | Largest overlap of the outer rectangle, not `MonitorFromWindow`. What that answers for a minimised window was not checked. |
| `Screen` with no monitor | A 0 by 0 screen. |
| `buildMenu().bitmaps` | Always empty. Item numbers above 65,535 throw. |
| A UI-thread call from a `Worker` | Throws. |
| COM already initialised multi-threaded | Printed once, and making a webview then fails with a different error; the old code threw on every call. |
| A mouse or keyboard hook under `runEventLoop` | Answered only when the loop pumps (every 16 ms by default). Inferred from the code; never measured. |
| `refreshWindowsIcons` | Swallows every error, a missing binding included. |

## 3. Ported, and not proven

The Rust exists. The proof is a simulated message, a test hook, a test that did not run, or nothing.

| What | What the proof is |
|---|---|
| Keyboard hook while the application's own window is in front | Its two tests were skipped in the run: no foreground. |
| Developer tools on F12; accelerator keys | Skipped in the run: no foreground. |
| A click on a real notification | Test hook only. One real toast is shown; no click on one has ever been run. |
| The tray icon coming back when Explorer restarts | The message is posted to the tray's own window; Explorer was never restarted. |
| A file dragged from Explorer onto a window or a page | Simulated through DevTools, or a sent `WM_DROPFILES`. |
| A real change of display scale; a second monitor | The tab frame is sent the message with the scale unchanged. Nothing else. |
| Tab keyboard shortcuts | Only Ctrl+T and Ctrl+W are typed for real; the other eleven go through a test hook. |
| Snap and shadow of the tabbed frame | No test. |
| Per-pixel transparency of a `transparent` window | No pixel is read. |
| "No click-through flip while a mouse button is down" | Pure logic only; never with a held button. |
| A person closing a window (the X, Alt+F4) | `WM_CLOSE` is posted. |
| Requests from a shared worker; an external drop being refused | No test. |
| UI-thread calls throwing from a `Worker` for windows, screens, tray and menus | Tested for the loop functions only. |
| The name a toast shows with no identity | Pure logic; the toast is not read. |
| A whole application compiled to one executable | Tested on a copied loader; the demos' compile recipes are not in the test run. |
| `writeIconFiles` | No test. |

## 4. Ported, with a test that reads the real OS or drives real input, and the run passed

| Area | Capabilities |
|---|---|
| Webview | Its own window, a given window, wrapping a handle; `title`; `size` with each hint; `navigate`, `setHTML`, `init`, `eval`; `bind`, `bindRaw`, `unbind`, `return`; `run`; `destroy`, also from inside a handler; `unload`; assets and `assetOrigin`; background colour, read as screen pixels; the request handler with the 404 and 500 rules, POST and binary bodies; answers from a `Worker`; the frames origin; requests from a service worker and a cross-origin iframe; bindings in the top-level document only; teardown with requests open; the WebView2 environment and profile folder; the ready handshake with its watchdog; the worker's ring and wake in both loop modes |
| Input hooks | Mouse hook: every event kind, coordinates, wheel, modifiers, swallow. Keyboard hook: down, repeat, up, DOM codes, swallow. One of each per process. All with injected input. |
| Event loop | The blocking `run()`; `runEventLoop`, `quitEventLoop`, `pumpEvents`; native timeouts and intervals; deferred jobs; page calls, wakes and timers served inside a modal dialog and a popup menu, both loop modes |
| Windows | Options: `title`, `bounds`, `contentSize`, minimum size, `frame`, `resizable`, `appearance`, `icon`, `colorKey`, `opacity`, `backgroundColor`, `topmost`, `hideFromTaskbar`, `noActivate`. Methods: show, hide, bounds, move, resize, `setTitle`, `setIcon`, minimise, maximise and restore (framed and frameless), `isMinimized`, `onMaximizeChange`, the system menu, `setTopmost`, `startDrag` and `startResize` with a held button, click-through, hit regions with the refiner, `onResize`, `onMove`, `onClose`, `onFileDrop` (sent message), dispose with every handle given back. `handle` is the real `HWND`; `Window.fromHandle`; `WebView.attach` keeping styles and bounds; `closeToTrayOnLastWindow`; an overlay above the taskbar |
| Screens | `Screen.at`, `Screen.of`, `Screen.cursor` |
| Tray | Icon and tooltip read back from the shell; `setIcon`, `setTooltip`, `setMenu`; click, double click and the menu (posted messages) |
| Menus | Check marks, icons, submenus, separators and disabled items read from the real menu; the right button choosing an item; at the cursor; opening upward; `buildMenu` |
| Notifications | A real toast under a registered identity; an explicit `appId`; the balloon fallback on the notifier's own hidden icon |
| Dialog, clipboard | `pickFolder` cancelled in both loop modes and choosing a folder with an owner; clipboard text round trip |
| Activation | `registerUrlScheme` and `unregisterUrlScheme` in the registry; `singleInstance` with a real second process |
| End of the application | Everything released at process exit, in spawned processes |
| Native tabs | Frame styles and metrics; the strip; one webview per tab; open, select, rename, reorder, close; the last-tab rule; tear-off and merge keeping the page; popups as tabs; the failed-load page; the tab menu and system menu; strip drag and resize with real input; minimum size; dark mode |
| Packaging | The binding loading; the missing-file and wrong-platform errors; `refreshWindowsIcons` reaching the shell |

## The Rust itself

- No Windows product source imports `bun:ffi`; every such import is in a macOS module behind a platform check.
- No `todo!` or `unimplemented!` on a Windows path.
- `unsafe` appears only in the six `sweetview-platform-*` crates that call the OS (220 occurrences in source by word count).
- `sweetview-runtime` is 5,582 lines in one crate.
- Nineteen binding exports have no caller outside tests, most of them `debug*` test hooks that ship in the binding.
