# Goal audit, Windows: what was built against what was wanted

Audited at `5b0388d` (the head of `v1-rust-rewrite`), clean tree. Read-only: nothing was run on screen, and no test, build or verifier was run.

How to read the marks. **[checked]** means the auditor opened the file and line. **[reviewer]** means it rests on one of seven read-only reviewers the auditor started, each on a bounded question, whose main claims were then spot-checked. **[inferred]** means it follows from the code and has not been seen happening.

## 1. The intent

1. Sweetview on Windows is the same product with its native layer really rebuilt in Rust: crates a maintainer can read, test and change, memory safe where that is reasonable, and not the old OS calls repeated as `unsafe`.
2. Nothing an application could do before is lost, and nothing a person using an application would notice has become worse.
3. An application on the old packages has a real way onto 1.0, and that way is a migration: afterwards it uses 1.0 as 1.0 is meant to be used. It does not rebuild the old library's behaviour or carry the old library's workarounds forward.
4. It works when a person uses it, and it looks and feels finished.
5. The owner's private applications stay private.

The question asked of the tree: where does it fall short of that in a way the owner would care about?

## 2. Where it falls short

### 1. The upgrade guide rebuilds the old library instead of migrating to 1.0, and the tests lock that in

`docs/upgrading.md` tells an application to add code whose only purpose is to get 0.x behaviour back: hide on close (lines 75-79, 183-187, 194, 416, 418, 429, 445, 551-554), the page's client size through the raw webview class (174-180, 530-531), the upward menu through an internal subpath (117-122, 1335). `rust-rewrite/compat/behaviour.test.ts` asserts those snippets by name: line 212 ("as createOverlayWindow's window did"), line 221 ("as 0.x did"), line 235. **[checked]**

The source is decision D35 (`rust-rewrite/DECISIONS.md`, line 315 onward). Real 0.x applications were upgraded, each difference they met was answered with a snippet that restores the old behaviour, and the entry ends "No public API was added". The differences were real signals about what 1.0 should offer. They were turned into guide text instead.

Why it matters: an application upgraded by this guide is a 0.x application running on 1.0 internals. The right thing is for each such place to name the 1.0 way (section 3 lists them) and, where 1.0 has no way, for the library to gain one.

### 2. The public API has holes, and the guide sends applications through them into internals and their own `bun:ffi`

`packages/sweetview-native/package.json` lines 26-36 export `./internal`, five `./win32/*` subpaths and four `./darwin/*` subpaths. **[checked]** The guide's own rule (lines 676-681) is that an internal export with no public equivalent "is unchanged while the subpath exports it", so about 148 rows point an application at internal or raw modules, and 13 rows give `import { dlopen } from "bun:ffi"` as what to write now. **[reviewer, sampled and checked at 1123-1138, 1160, 1295-1301, 1331-1335, 1347-1348]**

The holes a real application falls into:

- No window for the application's own messages. The guide says to call `CreateWindowExW` with `HWND_MESSAGE` and a `JSCallback` window procedure (1160, 1347, 1348).
- No alignment on `Menu.popup`. The binding already takes the flag (D35 says so); the public call does not.
- No client size in DIPs and no centred placement on `createApp` or `Window`. Demos centre by hand and pass unscaled physical pixels, so their windows shrink on a high-DPI screen (`demos/web-app/app.ts:48-56`, `demos/menubar-notify/app.ts:58-63`). **[reviewer]**
- No background colour on a window or webview (`WindowOptions` has none). **[checked]**
- No event for a maximise change. The documented pattern is a timer (`docs/window-chrome.md:93-103`, `demos/desktop-pet/settings/Chrome.tsx:28`). **[checked]**
- Custom tab layouts only through `createChildWebview` and `engineOf(webview).reparent` of `/internal` (1295-1301).

Why it matters: anything an application imports from `/internal` or `/win32/*` is API the owner now has to keep stable or break. The right thing is a public call for each real use, and the subpaths gone from `exports`.

### 3. Windows are shown before their page has painted

The library has the pieces: windows are created hidden, `showOnReady` shows on the page's `signalReady()`, and `readyTimeoutMs` is a watchdog (`packages/sweetview/src/app.ts:59-62, 700-702, 809`). `showOnReady` defaults to false. No demo and no snippet in the root `README.md` uses it; the only mention in either is the export table at `README.md:139`. **[checked by search]** Every demo calls `show()` straight after creating or attaching (`demos/web-app/app.ts:147`, `demos/desktop-pet/app.ts:181`, `demos/native-tabs/app.ts:116`), `demos/menubar-notify` writes its own `page.ready` method instead of using the built-in one, and step 4 of the guide (line 181) offers `show()` first.

No background colour is given to any non-transparent webview (`crates/sweetview-runtime/src/engine.rs:225-246`), and `wry` creates each webview visible, so a dark page will very likely flash white at start, and a new tab's webview exists visible before it is hidden (`packages/sweetview/src/app.ts:352`). **[checked for the code, inferred for the flash]**

Why it matters: this is the first thing a user sees of every application built on it. The right thing is show-when-ready as the default for a window with a page, with the watchdog on by default, a background colour option that follows the theme, and every demo and snippet using them.

### 4. Every tray application hand-writes its close behaviour, and a failed start hangs

Closing the main window quits unless `onClose` is set; once it is set nothing quits by itself (`packages/sweetview/src/app.ts:963-967`). **[checked]** So each tray demo carries `onClose: () => app.window.hide()` (`demos/web-app/app.ts:66`, `demos/menubar-notify/app.ts:70`, `demos/desktop-pet/app.ts:103, 112`). The library's own answer, `closeToTrayOnLastWindow`, is documented at `docs/native/windows.md:275-292` and used by no demo and by no step of the guide. **[checked by search]** `demos/native-tabs/app.ts:117-121` has to call `quit()` itself when start-up throws, with the comment "Without a window to close, the loop would never end". **[checked]**

The right thing: closing is declared once (a close policy on `createApp`, with close-to-tray as one value), and an application whose start-up fails ends by itself.

### 5. A packaged application fails silently

Library faults go to `console.error` only (`packages/sweetview/src/app.ts:708, 720` and the same pattern throughout). **[checked]** A compiled application built with `--windows-hide-console`, which every demo uses, has no console. A missing WebView2 runtime or an unloadable binding is a thrown `Error` with a good message that nobody sees: the process just ends. **[inferred]** Two demos build their own log file and `uncaughtException` handler to cope (`demos/desktop-pet/app.ts:36-52`, `demos/menubar-notify/app.ts:37-41`). The Quickstart's compile line (`README.md:315`) omits `--windows-hide-console`, so the first application a reader builds opens a console window beside itself. **[checked]**

The right thing: one error channel on the application (a handler, with a log file and a native message box as the default for a fatal start-up error).

### 6. The webview quietly behaves differently for the user, and nothing says so

`wry` 0.58.2 applies its own WebView2 settings at creation: zoom control off, pinch zoom off, swipe navigation off, status bar off, CSS `app-region` support on (`wry-0.58.2/src/webview2/mod.rs:682-713`). `engine.rs:225-246` overrides none of them. **[checked]** WebView2's own defaults are the opposite for all of them. So Ctrl+wheel, Ctrl+plus and pinch no longer zoom a page, the link-hover status text is gone, and a page with `app-region: drag` in its CSS now drags the window. The guide does not mention any of it and no test covers it.

What the C++ library set is not in this tree, so the old values are unconfirmed; the likely case is that it left WebView2's defaults. The right thing is to set each explicitly to what the old library did, offer the ones worth offering as options, and say so in the guide.

### 7. Streaming, the one reason for a hand-written request handler, is not shown to stream

The project's `IStream::Read` blocks until the caller's whole buffer is full or the stream ends (`crates/sweetview-platform-webview/src/stream.rs:140-182`, `windows/istream.rs:87-93`). **[checked]** If WebView2 reads in large blocks, small chunks (server-sent events, progress output) reach the page late or all at once at the end. The only streaming test writes every chunk and then ends the stream before the page reads (`tests/requests.rs:176-203`). **[reviewer]** A producer that outruns the page grows the buffer without limit (`stream.rs:82-96`), and a request the handler never answers stays open until teardown.

A reviewer checked `wry`'s custom protocols against the reasons recorded for not using them: `wry` can serve both origins, service-worker requests and answers from another thread. Streamed bodies are the only real gap. So this path has to be proven: a test in which the page sees the first chunk before the stream ends, and a bound on the buffer.

### 8. Notifications appear under the name "Sweetview"

A `Notifier` with no `appId` or `identity` registers and shows as `Sweetview.DesktopApp`, "Sweetview" (`docs/native/notifications.md:103-112`). **[checked]** It does not take the identity the application already gave `createApp`, so each demo passes it twice, and a `DisplayName` once written is never updated, so a renamed application keeps its old name. D35 lists the default as an open alternative and leaves it. An application upgraded from 0.x without reading that paragraph ships toasts titled with the library's name.

The right thing: the notifier inherits the application's identity, and with none it refuses or uses the executable's name, never the library's.

### 9. `tao` makes the windows, and nearly everything a window does is hand-written Win32 beside it

This is the closest the Rust comes to the old code in a new file, though not through carelessness. `tao`'s `run_return` is the loop and `tao` builds each window. Events, showing, bounds, extended styles, icons, DPI for the tab frame, wakes, timers and deferred jobs are the project's own, through a subclass and a message-only window (decisions D3, D8, D9, D22, D29, D30, D38). A reviewer checked each stated reason against `tao`'s source and most hold. **[reviewer]** The cost is structural: the subclass overrides `tao`'s style writes, so `tao`'s own record of the window goes stale (D25 admits `is_maximized` cannot be trusted), and seven separate `tao` behaviours are worked around. A `tao` upgrade can break this without a compile error.

Three places where the session wrote a second mechanism it did not need:

- Two popup menus. The tab frame has its own `CreatePopupMenu` and `TrackPopupMenu` (`crates/sweetview-platform-window/src/tab_frame.rs:98-176`), justified in D22 by `muda` being asynchronous. D26 later built synchronous tracking of `muda` menus in `popup.rs`. The first was never folded into the second.
- Two resize gestures. `Window.startResize` follows the cursor from a timer and calls `SetWindowPos` (`crates/sweetview-runtime/src/window.rs:361-376, 808-827`) **[checked]**, while the tab frame hands the press to the OS size loop. The poll is there because the old TypeScript did it. A user gets no snap and a window that trails the cursor on a frameless window, and gets the real thing on a tabbed one.
- `set_command_id` (`popup.rs:115-118`) renumbers `muda`'s menu items behind its back **[checked]**, while `muda` addresses its own items by the ids it gave them. It is safe today only because a menu is built for one showing and never changed.

The right thing: decide on purpose. Either the window layer is the project's own crate over `windows` with `tao` used for the loop only, or `tao`'s model is adopted. Then one menu path and one resize path, on the OS loop.

### 10. The crates are disciplined inside and loosely organised between

- `sweetview-runtime` is about 5,700 lines holding the loop, windows, the tab frame, tray, menus, the webview engine, clipboard, notifications, dialogs, activation and lifetime. Its stated job, "everything that lives on the UI thread", is not one job.
- `crates/sweetview-platform-loop/src/windows.rs` (about 1,250 lines) mixes the message window, a destroy-confirmation state machine, the pump, handle counts, the signal window and the tick thread. It is correct and hard for a newcomer to follow. **[reviewer]**
- About 1,500 lines of pure safe logic sit in crates where `unsafe` is allowed (the responder and stream state, `.ico` parsing of untrusted bytes, toast XML, payload validation), where the policy says logic lives under `forbid`. **[reviewer]**
- The binding is two crates with about 1,100 lines of one-line forwarding (D2), because `forbid` rejects the macro's expansion.
- The clipboard is 13 hand-written `unsafe` uses (`crates/sweetview-platform-shell/src/clipboard.rs`) where a maintained crate exists. The recorded reason for refusing `clipboard-win` is true and does not matter for a desktop application's UI thread. **[reviewer]**
- "Shared Rust for every platform" is real only for the three logic crates and the webview's stream and queue. Off Windows the runtime cannot start: `SignalWindow::new` returns an error (`crates/sweetview-platform-loop/src/unported.rs:23-25`) **[checked]**, and the runtime's shape is Win32's (extended-style policy, adoption by `HWND` value, events from a subclass). The macOS goal inherits a redesign, not a port.

### 11. macOS was changed on a machine that cannot run it

The intent was that macOS keeps running on the existing code. Shared TypeScript changed in ways that execute there, none of it run on a Mac: **[reviewer, the import chain checked]**

- Importing `@n1h/sweetview-native` now loads `@n1h/sweetview-webview-bun` at the top level through `webview.ts:137`, `input-hooks.ts` and `permissions.ts`, and throws without it (`packages/sweetview-native/src/darwin/library.ts:16-22`). An application that used only windows, the tray or notifications did not need that package before.
- The release of everything at process exit (`packages/sweetview-native/src/lifetime.ts`) now runs AppKit and WebKit teardown from Bun's `exit` event, including when `process.exit()` is called inside a native callback. The tests of it are Windows-only.
- The demos dropped their `process.exit(0)` and every worker is `unref()`'d (`packages/sweetview/src/app.ts:509`). If anything on macOS holds the loop, a demo hangs after Quit.
- `createApp` now passes the window handle to the library's webview class as a bigint where it passed a number (`app.ts:350`).
- `just check`, `pack`, `link` and `publish` now need `cargo` on a Mac.

The right thing: run `bun test` and each demo on a Mac before this branch is merged anywhere a Mac user will pull it.

### 12. Getting 1.0 is a toolchain and a pasted recipe

1.0 is not on npm, and publishing is the owner's. What the session could shape is everything else, and it is heavy. A Windows developer needs the Rust toolchain and the Visual Studio C++ build tools to run anything from a checkout, because the binding is not shipped (D34, `README.md:23-56`). **[checked]** An application in another repository links to a checkout by pasting two `[script("bun")]` recipes into its own justfile (`docs/local-checkout.md:121-177`). The guide tells applications to depend on `^1.0.0`, a version that does not exist, and to add `@n1h/sweetview-build` so they can run `make-app.ts` and `refresh-icons.ts` by file path.

The right thing: a prebuilt binding an application developer can get without Rust, one command to link and one to unlink, and build tools that are commands.

### 13. Features recorded as working that nobody has seen work

The records themselves say no person looked at this product on a screen. The ones where the feature itself is unproven: **[reviewer, from the evidence files and `OWNER-ACTIONS.md` section 4]**

- A file dragged from Explorer onto a window. Drops were driven through DevTools and through a sent `WM_DROPFILES`.
- A real change of display scale, or a second monitor. The tab frame was sent the message. Ordinary windows do not apply the rectangle Windows suggests at all; only the tab frame does (`tab_frame.rs:374-388`).
- Explorer restarting under a tray icon. The registered message was posted.
- A toast clicked from the notification centre, and a balloon click. One banner click was injected; the rest is simulated through test hooks.
- Everything visual: the tab strip's look, dark mode, flicker on resize or tear-off, the white flash of item 3. A screenshot was captured and its size checked.
- The real applications. D35 says two were upgraded and found six gaps; no result of those runs is in the repository, and the `dependents` check passed with "nothing to verify".

### 14. Signs of working to the checklist instead of the product

- The upgrade guide is 946 table rows, about 674 of them "unchanged" in some form, with whole tables repeated for a second import name and a row for every Win32 constant. The changes that break an application are in roughly 220 lines near the top. It was written to "one row per export", and a developer cannot read it in a sitting. **[reviewer, counts checked]**
- A test forbids the words "removed" and "no longer available" in any row (`rust-rewrite/compat/upgrade-guide.test.ts:272-275`). **[checked]** So things that are gone are worded as "unchanged (internal)", "nothing to call" or "does nothing". `setAppMenu`, `setAppIcon` and `setActivationPolicy` are rows marked "unchanged" whose runners assert that they do nothing on Windows (`fixtures/row-runners.ts:981-988`). **[checked]**
- "Each row is exercised" mostly means its shape was checked. `createApp`'s runner asserts `typeof fn === "function"` against an app made beforehand; `runEventLoop` and `quitEventLoop` return a string; all 29 `new Window(options)` rows share one runner that compares bounds, so no option's claim is tested (`row-runners.ts:979-980, 1011-1014`). **[checked]**
- Test hooks ship in the published binding: `debugForcePath`, eight more `debug*` notifier methods, `debugLiveToastHandlers`, `movesTold` (`packages/sweetview-native/prebuilt/binding.d.ts:142, 201-218, 391`). **[checked]** D28 chose this so the tested binary is the shipped one. A cargo feature would have kept them out of an application's process.
- Tests were loosened where a machine was slow or odd and the cause was not found: the notifier's real-toast routing became held toasts and its handle allowance went from 4 to 16; start-up time limits were raised several-fold with an unexplained multi-second WebView2 start and one unexplained ready-watchdog failure left as they were (D20, the entries on `app.test.ts` and the notify crate). **[reviewer]** A start that sometimes takes seconds is a product problem a user will meet.
- The verifier's `dependents` check passes with no list, its `demos` check means they compile, and its `engine` check always passes on Windows. **[reviewer]** "COMPLETE" says less than it reads.

### 15. Smaller things an application or a user will hit

- `pumpEvents()` called from inside a running loop now does nothing (`crates/sweetview-runtime/src/runtime.rs:211-216`, D40). **[checked]** An application that pumps from a long handler to keep its windows alive now freezes them. The guide says "unchanged" and `docs/native/event-loop-and-icons.md:68` has no caveat.
- `Screen`, `Notifier`, `Tray`, `Menu.popup`, `pickFolder` and the input hooks now throw from a `Worker`. The guide names only the clipboard and single instance. **[reviewer]**
- `tab.webview.window` wraps the frame the tab opened in and is not updated on tear-off or merge, so it can name a destroyed window (`packages/sweetview/src/tabs/win-tabs.ts:704`). **[checked]** The guide records it; nothing tests it.
- `Screen.of(win)` on a minimised window picks a monitor from the minimised rectangle, where `MonitorFromWindow` answered the restored position (`crates/sweetview-runtime/src/screen.rs:70-77`). `docs/native/windows.md` recommends it for restore logic. **[checked for the code, inferred for the result]**
- Showing a minimised `noActivate` window activates it; the old tab frame took care not to. **[reviewer]**
- Native timers are now posted messages (D38). An interval whose handler takes longer than its period always has a tick waiting ahead of input and paint (`crates/sweetview-platform-loop/src/windows.rs:727-764`). **[checked for the code, inferred for the effect]**
- The binding exists for Windows x64 only (`packages/sweetview-native/src/binding.ts:60-71`); Bun on Windows ARM64 loses every native call, where the old code lost only toasts. **[checked]**
- The tab strip has no keyboard access (every control is `tabindex=-1`), no high-contrast handling and no right-to-left layout (`win-strip-assets.ts`). **[reviewer]**
- Docs that describe the old code: `docs/native/dialogs-clipboard-files.md:83` (says `pickFolder` throws), `docs/native/overlays-and-hit-regions.md:78-80` (says `SetTimer`), `docs/app.md:234` (says DIPs where `docs/native/windows.md:65` says physical pixels), and the guide's lines 1552-1559 and 1581 (a balloon with the tray's icon) against its own lines 128-133 (a toast, no tray needed).

## 3. The upgrade path as migration

Every place the guide, the docs or the demos teach an application to preserve an old behaviour, work around the library, or reach inside it, with the 1.0 form. "Gap" means 1.0 has no form yet and needs one.

| # | Where | What it teaches | The 1.0 form |
|---|---|---|---|
| 1 | `docs/upgrading.md` 75-79, 183-187, 194, 416, 418, 429, 445, 551-554 | pass `onClose: () => win.hide()` "to keep the old behaviour" | A close disposes. A tray application declares close-to-tray (`closeToTrayOnLastWindow(win, onHide)` today; a close policy on `createApp` is the gap). An overlay that must never close says that as its own intent. |
| 2 | `docs/upgrading.md` 174-180, 530-531 | set `app.webview.raw.size` so the page keeps its 0.x client size in DIPs | `bounds`. Gap: a size in DIPs and a centred placement on `createApp` and `Window`. |
| 3 | `docs/upgrading.md` 117-122, 1335 | keep `popupMenuAtCursor` from `@n1h/sweetview-native/win32/menu` for a menu that opens upward | `Menu.popup(owner, menu, at)`. Gap: an alignment option. |
| 4 | `docs/upgrading.md` 192-194, 417, 429, 588-590 | name `topmost`, `hideFromTaskbar`, `noActivate` as "their old defaults" | These options are the 1.0 form. Say what an overlay is in 1.0, not what 0.x defaulted to. |
| 5 | `docs/upgrading.md` 42-54 | the old teardown lines "are harmless if left" | Delete them. The application's last line is `app.run()`. |
| 6 | `docs/upgrading.md` 260, 504, 1636 | keep calling `unload()` | Delete it. |
| 7 | `docs/upgrading.md` 181-182 | "Call `app.window.show()` once it is wired, or pass `showOnReady`" | `showOnReady: true` and `signalReady()` in the page, stated first. |
| 8 | `docs/upgrading.md` 1160, 1347, 1348 | rebuild a message window with your own `CreateWindowExW` and a `JSCallback` procedure | An owner for a menu or dialog is a hidden `Window`. Gap: a public way to receive what applications used that window for. |
| 9 | `docs/upgrading.md` 1224-1237 | twelve rows whose "write now" is your own `dlopen` table (dwmapi, shell32, advapi32, shcore, a UTF-16 helper) | The public call each row already mentions in passing: `transparent: true`, `Window#onFileDrop`, `registerUrlScheme`, `Screen`. |
| 10 | `docs/upgrading.md` 1331-1332; `docs/native/menus-and-tray.md` 96-106 | `buildMenu` for "your own `TrackPopupMenu`" | `Menu.popup`. |
| 11 | `docs/upgrading.md` 1123-1138 | sixteen `/internal` exports "unchanged (internal)", among them `holdWindowNativeDispose`, `preserveWindowGeometry`, `scheduleNativeTimeout` | Nothing: 1.0 does these itself. Where an application has a real need, a public call. |
| 12 | `docs/upgrading.md` 1295-1301 | build tab panes with `createChildWebview` and `engineOf(webview).reparent` from `/internal`, and lay them out on every resize | `createApp({ tabs: true })`, `WebView.openTab`, `Tab`. |
| 13 | `docs/upgrading.md` 1243-1283, 1316-1321 | thirty-six rows on `win32/shortcuts`, `win32/strip-shared`, `win32/tab-window`, `win32/window` "unchanged" | The public tabs and window API. |
| 14 | `docs/upgrading.md` 1172, 1207 | replace a `PeekMessage` loop with repeated `pumpEvents()` | `app.run()` or `runEventLoop()`. |
| 15 | `docs/upgrading.md` 162-166, 646-650 | add `@n1h/sweetview-native` as a dependency so subpaths can be imported, and `@n1h/sweetview-build` so its scripts can be run by path | Import only `@n1h/sweetview`. Gap: build tools as commands. |
| 16 | `docs/upgrading.md` 168, 224, 250; `docs/local-checkout.md` 116-195 | install from a checkout by pasting justfile recipes into the application | Gap: one command to link, one to unlink. |
| 17 | `docs/upgrading.md` 621, 1500 | a macOS file of the library named by path | A public export. |
| 18 | `rust-rewrite/compat/behaviour.test.ts` 212, 221, 235 | tests that assert rows 1 to 3 work "as 0.x did" | Tests of the 1.0 forms. |
| 19 | `demos/web-app/app.ts:66`, `demos/menubar-notify/app.ts:70`, `demos/desktop-pet/app.ts:103, 112` | hand-written hide on close in every tray demo | As row 1. |
| 20 | `README.md` 298-305; `demos/web-app/app.ts:147`; `demos/desktop-pet/app.ts:181`; `demos/native-tabs/app.ts:116` | `show()` straight after creating the window | As row 7. |
| 21 | `demos/menubar-notify/app.ts:85` with its `service.ts:16` | the demo's own `page.ready` method | The built-in `signalReady()`. |
| 22 | `docs/window-chrome.md` 93-103; `demos/desktop-pet/settings/Chrome.tsx:28` | poll the maximise state from a timer after `toggleMaximize` | Gap: an event for a maximise change. |
| 23 | `demos/web-app/app.ts:48-56`, `demos/menubar-notify/app.ts:58-63`, `demos/desktop-pet/app.ts:89-93` | centre a window by arithmetic on the work area | As row 2. |
| 24 | `demos/desktop-pet/app.ts:36-52`, `demos/menubar-notify/app.ts:37-41` | the application's own log file and `uncaughtException` handler that exits | Gap: an error channel on the application (section 2, item 5). |
| 25 | `demos/native-tabs/app.ts:117-121` | quit by hand when start-up fails, or the loop never ends | The library ends the loop. |
| 26 | every demo `justfile`; `docs/build.md` 183-203 | run `refresh-icons.ts` and `make-app.ts` by file path | As row 15. |
| 27 | `demos/web-app/app.ts:67-70, 114` | route `pickFolder` through `deferredUiMethods` and show the window first so the dialog has an owner | A dialog call that is safe from any UI method and needs no visible owner. |
| 28 | `packages/sweetview-native/examples/input-hooks.ts:19` | the one shipped example imports `../src/index` and drives the raw webview class | The package name and `createApp`. |

Twenty-eight places.

## 4. What is solid

- The `unsafe` itself. One operation per block, comments that state a real guarantee, an owning type with `Drop` for every resource, `catch_unwind` on every OS and COM callback, no `static mut`, no `transmute`, no `unsafe impl Send`. Two reviewers went through all seven platform crates and found no transliteration of the old code at that level. Toasts and the registry use safe APIs.
- The hard bugs were found and understood, not papered over: the keyboard hook going blind in the application's own window (D29), the pump that never returned (D30), timers stalling inside a menu (D38, with a plain Win32 reproduction).
- Every workaround for a real OS quirk listed in the reference inventories was looked for and is still handled, with one exception (item 15, the minimised `noActivate` window).
- The end of an application (D36): no dispose chain and no `process.exit`, tested for each way a process ends on Windows.
- The tray on `tray-icon`, the request handler's fail-closed behaviour, the depth of the native tabs work, the IPC that runs one page in four hosts, and error messages that say what to do.
- No Windows product source imports `bun:ffi`. **[checked by search]**
- Privacy. No machine-local path, no user name beyond the published copyright line and the existing APM source, no bundle identifier beyond the demos' prefix already published at the tag (one new demo follows it), and nothing in the 202 commit messages. `rust-rewrite/local/` is ignored. D35 and D37 speak of real applications only in general terms. No leak was found. **[checked]**

## 5. Not looked at

- Nothing was run: no window, test, build, `cargo` command or verifier. Every "flash", "freeze" and "hang" above is read from code.
- macOS. Item 11 is from diffs; a Mac settles it.
- The old code. The C++ library and the bindings repository are not in this tree and deleted files were not read from history, so the old WebView2 settings, whether bound functions ran synchronously, and what a nested pump did are unconfirmed.
- The Tauri and Electron transports, `sweetview-build`, `sweetview-settings`, and `HANDOFF-macos.md` beyond its open points.
- The evidence files line by line, the commit history as a process, and the verifier's bookkeeping. They were set aside as paperwork.
- The repository's appearance-and-feel rule: its file is generated and is not present in this checkout.
- The results of the real applications' upgrades, which are outside the repository.

## Answers

### 6

Done, on branch `rust-rewrite-fix-webview-behaviour` (DECISIONS D45). The table, read back from WebView2 by `crates/sweetview-platform-webview/tests/settings.rs` on WebView2 Runtime 158.0.4370.45. "Old" is what the C++ library had: it set only the developer tools, so the rest is WebView2's default (the tree records no other setting; the reference's tab strip had to swallow the browser's zoom keys itself).

| Setting | Old (C++ library) | Before this change (`wry` 0.58.2) | Now |
|---|---|---|---|
| Zoom: Ctrl+wheel, Ctrl+plus/minus/0 (`IsZoomControlEnabled`) | on | **off** | on |
| Pinch zoom (`IsPinchZoomEnabled`) | on | **off** | on |
| Swipe back and forward (`IsSwipeNavigationEnabled`) | on | **off** | on |
| Status bar on link hover (`IsStatusBarEnabled`) | on | **off** | on |
| CSS `app-region` (`IsNonClientRegionSupportEnabled`) | off | **on** | off |
| Default context menus | on | on | on |
| Developer tools | `debug` | `debug` | `debug` |
| Browser accelerator keys (Ctrl+F, Ctrl+P, F5) | on | on | on |
| Built-in error page, script dialogs, script, web messages, host objects | on | on | on |
| General autofill / password autosave | on / off | on / off | on / off |
| SmartScreen (`IsReputationCheckingRequired`) | on | on | on |
| User agent | WebView2's | WebView2's | WebView2's |
| Environment options | none | none (the project creates the environment, D15) | none |

Zoom, pinch and swipe go back through `wry`'s own builder options (`with_page_behaviour`); the status bar and `app-region` through `ICoreWebView2Settings` and `Settings9` in `WebviewExtras::attach` (3 new `unsafe` blocks, in the ledger). `app-region` on can bite: a page with `-webkit-app-region: drag` in a stylesheet shared with another shell (Electron reads the same property) would drag the window and lose that area's mouse events, and a page that never uses it gains nothing; so it is off, as it was.

What an application cannot choose today (no public option): zoom on or off (an application-like page usually wants it off), pinch zoom, swipe navigation, the status bar, the browser's context menu, the browser's keys, `app-region` on, autofill and password saving, the user agent. The developer tools follow `debug`.

`docs/upgrading.md` ("The page behaves as it did") and `docs/webview-library.md` ("Page behaviour") say this.

Real input (`crates/sweetview-platform-webview/tests/real_input.rs`, run with `--ignored`; the mouse and keyboard injected with `SendInput` by `rust-rewrite/checks/webview-real-input.ps1`, so they travel through the OS input queue; under the shared desktop's input lock), on a webview built as the runtime builds it:

| Step | Seen |
|---|---|
| Ctrl+wheel one notch up over the page | `ZoomFactor` 1 to 1.1; the page's `devicePixelRatio` 1 to 1.1, `innerWidth` 480 to 436 |
| Ctrl+0, Ctrl+plus, Ctrl+0 | `ZoomFactor` 1, 1.1, 1; the page resized each time |
| A press on a `-webkit-app-region: drag` area, moved 80 px, released | the page got the `mousedown`; the window did not move (0, 0) |
| An HTML drag of a `draggable` element onto a drop zone in the page, with the file drop handler set | the page got `dragstart` and `drop` with its `text/plain` data; no file was involved |

The same steps on a webview `wry` built on its own: the press on the `app-region` area moved the window by (82, 2) and the page got no `mousedown`; Ctrl+wheel left `ZoomFactor` at 1 and the page unchanged. That is the behaviour change the fix removes.

### 7

Measured, then changed, on WebView2 Runtime 158.0.4370.45 (`crates/sweetview-platform-webview/tests/streaming.rs`, `packages/sweetview/src/request-handler.test.ts` "pace"):

- Before: WebView2 calls `Read` for 32 KiB; `Read` waited for 32 KiB or the end, so a 10-byte chunk stayed in the binding; the page's reader got nothing while the response was open (UI thread and another thread alike) and everything at the end.
- Now: `Read` returns what is there at once (`S_OK` short read, `S_FALSE` only at the end), and WebView2 takes a 10-byte chunk within 35 µs. The page still gets nothing before the end: `fetch()` itself does not resolve until `Read` returns `S_FALSE`, with `text/event-stream`, `Transfer-Encoding: chunked` or a `Content-Length` alike, and the first byte of a 24 MiB body arrives after the end. WebView2 keeps an intercepted response until EOF (WebView2Feedback #3519, which the docs already named), so real streaming is disproved for this path; no `Read` can fix it. The live tests assert this as measured, and fail if a runtime starts streaming.
- Same as before the rewrite: the C++ library's `Read` blocked until full, its docs say the page receives the body at `webview_end_response`, and its bindings' live test asserts on win32 that the page cannot acknowledge an event before the next is written. Microsoft's `ICoreWebView2WebResourceResponse` reference requires all content to be available when the request's deferral completes and offers no incremental delivery. The rewrite lost nothing; `docs/` now says exactly what an application gets.
- The bound: 1 MiB unread makes a response backlogged until it is down to 512 KiB. A writer on any thread but the UI thread waits for room (condition variable, no spinning; released by reading, the end, the page letting go, teardown). The UI thread never waits, and Sweetview's worker path writes there. Measured: at most 1,048,695 bytes held by the binding for a 24 MiB fast writer, every byte in order. What is not bounded is WebView2's own copy: the whole body waits in WebView2 until the end, so an endless or huge streamed body on Windows grows WebView2's memory.
- The old contract kept: `writeResponseChunk` still copies and returns `0` for a live chunk, never drops or reorders one; it now may wait off the UI thread.

What streaming guarantees is in D45 and `docs/webview-library.md` "Streaming responses". Real-time push on Windows stays IPC events. A writer on the UI thread, Sweetview's own worker path included, has no way to pace itself: listed for the owner.

### 13, the Explorer drop (this branch's part)

Driven for real: an Explorer window opened on a scratch folder with one file, its item found through UI Automation, the left button pressed on the icon, the cursor moved in 40 steps onto the Sweetview webview in another process, the button released, all with `SendInput`. OLE drag and drop ran between the two processes: the file drop handler received exactly the file's real path (`...\sweetview-real-drop-<pid>\sweetview real drop.txt`), once. The Explorer window was closed afterwards. Not driven: a drop onto a part of a native window that the webview does not cover (`Window.onFileDrop` through `WM_DROPFILES`): in this test the webview fills the window.

### 11

Agreed, and macOS is put back on the tag's path where the Windows goal changed what runs there (decision D42; `rust-rewrite/HANDOFF-macos.md` section 8 lists every seam for the macOS goal).

- The bindings package: `import "@n1h/sweetview-native"` (and `@n1h/sweetview/native`) no longer needs `@n1h/sweetview-webview-bun` on macOS. `darwin/library.ts` keeps a failed load and throws it at the first use of `RawWebview`, an input hook or `permissions`, so it is the optional peer it was at the tag. With it installed, importing the native package alone now evaluates it (a `dlopen` of its library, no webview made); its top-level await allows no lazy synchronous load, so that one difference stays and is recorded.
- The release at exit: `releaseAtEnd` registers nothing on macOS and adds no `exit` listener, so no AppKit or WebKit teardown runs from Bun's `exit` event there, inside a native callback or not.
- The demos and the worker: a webview's worker is not `unref`'d on macOS (`unrefWorker` in `packages/sweetview/src/app.ts`), and each demo ends on macOS with the tag's disposes and `process.exit()`, in one block at its end.
- The handle: the library's `webview_create` gets the window handle as a number again, as at the tag (`createWebview` in `darwin/webview.ts`).
- Also found: a request the library hands over that cannot be read is answered with the tag's 500 again; `just check`, `pack`, `link` and `publish` need `cargo` on a Mac (left as D34 made them, and handed over).

One predicate, `macosKeepsTagPath()` in `packages/sweetview-native/src/platform.ts`, marks each library seam. Windows runs the same code as before. `packages/sweetview-native/src/macos-seam.test.ts` and `packages/sweetview/src/macos-seam.test.ts` decide the seams on Windows with `process.platform` set to `darwin` and a stand-in for the bindings package; they show the old code's import error, release and bigint handle, and the new code's absence of them. None of it runs AppKit, and the right thing the finding names stands: `bun test` and each demo on a Mac before this reaches a Mac user.
