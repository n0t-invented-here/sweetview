# Decisions

Choices the Windows goal made, each with its reason and the alternative left open. `REQUIREMENTS.md` outranks this file; `SWEETVIEW-RESTART-PROPOSAL.md` is the design these adjust.

## D1. The crates and their boundaries

All under `crates/`, all from this repository; every dependency is from crates.io.

| Crate | Job | Why it is its own crate | `unsafe` |
|---|---|---|---|
| `sweetview-runtime` | everything that lives on the UI thread, with no JavaScript in sight: the loop in both modes and the objects on it | so the behaviour is testable with `cargo test`, with closures where JavaScript functions will be | forbidden |
| `sweetview-napi` | the binding: converts JavaScript values and functions and calls the runtime | the only crate that knows both N-API and the runtime; keeps N-API types out of everything else | forbidden |
| `sweetview-platform-node` | the export table: the items that carry `#[napi]`, each forwarding to `sweetview-napi` | see D2 | generated only; none hand-written |
| `sweetview-platform-loop` | the parts of the UI thread's loop `tao` has no API for: the window target while the loop runs, a wake and timers that arrive inside any modal loop; and the three things every other platform crate needs of a thread's loop: a message-only window with a poster, the pump calls, the handle counts | see D3 and D4; the shared pieces live here so each exists once (D23) | yes |
| `sweetview-http` | the rules of the webview's request handler that need no OS call: status and header validation, asset paths, origins, limits, the error codes | pure logic, ported with the C++ library's tests, shared by Windows now and macOS later | forbidden |
| `sweetview-keycodes` | the tables that turn an OS key or mouse message into the values applications see | pure data and decisions for both platforms' hooks | forbidden |
| `sweetview-window-logic` | what a window should do next, decided from cursor positions, button states and bounds: hit regions, the resize gesture, the frameless maximise, the extended-style policy | the state machines are testable without a window | forbidden |
| `sweetview-platform-webview` | what the webview needs on top of `wry` that `wry` has no API for: the request handler with streamed bodies, drops, user scripts, the tab hooks | all of it reaches WebView2 through the typed interfaces `wry` hands out | yes |
| `sweetview-platform-input` | system-wide mouse and keyboard hooks and the permission model | one OS mechanism, unrelated to windows or the webview | yes |
| `sweetview-platform-window` | the window-level OS calls `tao` has no API for, and the events of any window by subclass | see D8 | yes |
| `sweetview-platform-notify` | desktop notifications with a click that comes back | WinRT toasts and the balloon fallback are one feature with its own threads and registrations | yes |
| `sweetview-platform-shell` | the shell integrations that are one OS conversation each: clipboard text, URL schemes, single instance, icon refresh | small, unrelated to the loop; none needs a window of Sweetview's | yes |

## D2. The binding is two crates: `sweetview-napi` and `sweetview-platform-node`

Requirement: the binding forbids `unsafe` (R4, W0.3).

Observed: `#[napi]` on a function or class does not compile under `#![forbid(unsafe_code)]`. `napi-derive` 3.7.2 registers each export through the `ctor` crate, whose expansion carries `#[allow(unsafe_code)]`; the compiler rejects an `allow` under a `forbid`:

```
error[E0453]: allow(unsafe_code) incompatible with previous forbid
  = note: this error originates in the macro `$crate::__ctor_parse_impl` which comes from the expansion of the attribute macro `napi`
```

Decision: everything the binding does lives in `sweetview-napi` as ordinary safe functions under `#![forbid(unsafe_code)]`. The attribute lives in `sweetview-platform-node`, where every item is one forwarding call. That crate is named as a platform crate because the attribute's expansion is `unsafe extern "C"` code; it holds no hand-written `unsafe`, and `verify.ts` reports it with a count of zero.

Alternative left open: register exports by hand through `napi`'s non-macro API. It needs a hand-written `unsafe extern "C"` entry point and loses the generated TypeScript declarations.

## D3. Wakes, deferred jobs and native timeouts go through a message-only window, not `tao`

The proposal has `wake(handle)` send a `tao` user event. `tao` on Windows buffers every event while its handler is running (`EventLoopRunner::send_event`), and its handler is running whenever a handler has opened a modal loop. A worker's reply, a deferred UI method and the ready watchdog must all arrive inside such a modal loop (W1.8).

Decision: `sweetview-platform-loop::SignalWindow` is a message-only window. A wake is a message posted to it; a timeout is a timer on it. Whichever message loop the UI thread is in dispatches both: `tao`'s, a dialog's, a popup menu's, an application's own. This is what `win32/message-window.ts` and `webview_dispatch` do today.

Two consequences found by test:

- `tao` calls its event handler only for its own messages, so `Runtime::request_exit` sends a `tao` user event to make the blocking run look at its exit flag.
- The OS serves a timer message only when nothing else is queued, and a pumped `tao` loop always has its own repaint request queued. `Runtime::pump` therefore takes the signal window's due timers explicitly after each pump (`SignalWindow::dispatch_due_timers`).

Alternative left open: `tao`'s `EventLoopProxy` for wakes and `ControlFlow::WaitUntil` for timeouts, which fails W1.8.

## D4. `LoopHost` keeps a clone of the loop's window target

`tao`'s `run_return` borrows the `EventLoop` mutably for the whole run and gives the window target only to its event handler. A callback that the OS delivers inside the run but outside that handler (a WebView2 handler, a signal, a tray click) still has to be able to create a window, because JavaScript can do so from any callback.

Decision: `LoopHost` takes a clone of the loop's `EventLoopWindowTarget` when the loop is handed to it and lends that through `LoopHost::with_target`, whether or not a run is in progress. `tao` 0.38's target is `Clone`, and a clone shares the loop's thread, message target and runner with the one `tao` passes to the handler. No `unsafe`. (The first form recorded the pointer `tao` passed to the handler and lent it during the run, with one `unsafe` dereference; the safety pass replaced it.)

Alternative left open: route every callback through `tao`'s handler so the target is always at hand; it fails W1.8 for the reason in D3.

## D5. The built binding is not tracked; its declarations are

`packages/sweetview-native/prebuilt/sweetview.<target>.node` is built by `just native` (and by CI) and ignored by git. `packages/sweetview-native/prebuilt/binding.d.ts`, generated from the Rust signatures by the same command, is tracked, so the TypeScript in the repository typechecks against a known surface and a change to the surface shows in review.

Reason: a tracked binary changes on every rebuild and grows the repository with each one. The published package carries the binary through its `files` list (W8.1).

Alternative left open: track the binary, so a clone runs with no Rust toolchain.

## D6. The UI thread is the thread that loads the binding first

`sweetview_runtime::threads` records the first thread to load the binding, which is the Bun main thread. Every UI-thread function checks it and throws `sweetview: this call must be made on the UI thread` elsewhere. `tao` is built with `with_any_thread(true)`, because inside a host process its own idea of the main thread (the thread that ran the library's static initialisers) is the same thread but is enforced with a panic instead of an error.

## D7. A thrown JavaScript exception is logged by the TypeScript wrapper, with the binding as backstop

Each application handler is wrapped in TypeScript before it reaches the binding, and the wrapper logs an exception with the message today's code logs for that handler. `JsCallback::call` in `sweetview-napi` catches whatever still reaches it, logs `sweetview: <kind> threw: <reason>`, and reports `None` to the runtime, which then uses the callback's failure value (a hook does not swallow, a request answers 500).

Reason: today's messages live in the TypeScript layer already, per handler; keeping them there keeps them identical.

## D8. Windows are made by `tao`; their events and the styles `tao` does not model come from one subclass

`tao` creates every window Sweetview owns (frame, DPI awareness, dark title bar, alpha composition, drag, maximise). Two things are not taken from `tao`:

- Events. `tao` delivers `Resized`, `Moved`, `CloseRequested` and `DroppedFile` through its event handler, which it holds back while that handler is already running (a handler with a modal dialog open) and never calls under a message loop `tao` does not run (an application's own `bun:ffi` loop). Today those events arrive synchronously inside any loop. `Window.fromHandle` needs a subclass for a window `tao` did not create in any case, so the same subclass (`SetWindowSubclass`, in `sweetview-platform-window`) is the event source for every window, owned or adopted, with one code path.
- Extended styles `tao` has no flag for. `tao` rewrites the whole extended style from its own flags whenever one of them changes, which would drop `WS_EX_TOOLWINDOW` (off the taskbar and out of Alt+Tab; `tao`'s `set_skip_taskbar` removes the taskbar button only), `WS_EX_LAYERED` for `colorKey` and `opacity`, and the click-through bits while a layered window must stay layered. The subclass answers `WM_STYLECHANGING` with the bits Sweetview wants forced on and off, so they hold whoever changes the style.

Bounds are set with one `SetWindowPos` in the platform crate, because `tao` offers an outer position and an inner size as two calls, and a window dragged by its left or top edge must move and resize in one step.

Alternative left open: `tao`'s `WindowEvent`s and `set_ignore_cursor_events`, re-applying the extra styles after every `tao` call; it changes when events arrive and flickers a layered overlay each time click-through flips.

## D9. A window is shown by the platform crate, and `tao` is told afterwards

`tao`'s `set_visible(true)` shows with `SW_SHOW`, which activates even a `WS_EX_NOACTIVATE` window; `noActivate` windows must never take focus. `show()` therefore runs today's sequence in `sweetview-platform-window` (restore if minimised, `SW_SHOWNOACTIVATE` for `noActivate`, the foreground otherwise), and the subclass keeps `tao`'s later style rewrites from changing `WS_VISIBLE`.

Alternative left open: `tao`'s `set_visible`, which changes focus behaviour for overlays.

## D10. A quit asked for outside a blocking run waits for the next pump

The C++ library ended a loop by posting a quit message, so `quit()` called while no `run()` was in progress ended the next `run()` at once, or made the next `pumpEvents()` return false, and `discardQuit` took it back. The runtime keeps that contract without the message: `Runtime::request_exit` outside a blocking run sets a flag the next pump reports and consumes, the next blocking run ends at once on it, and `discard_quit` clears it (and still takes back a real quit message an application posted).

Alternative left open: make `quit()` a no-op unless a blocking run is in progress; an application that pumps with `runEventLoop` and ends its loop by `app.quit()` would then never stop.

## D11. One pump dispatches everything that is waiting

`tao` in poll mode hands its handler `MainEventsCleared` after each message, so a pump that exits there dispatches one message per call. `pumpEvents` has always dispatched everything waiting. `Runtime::pump` goes round until no posted message waits, bounded at 256 rounds, then takes the signal window's due timers (D3).

## D12. The binding's built-in types are positional where an object would need `unsafe`

`#[napi(object)]` structs compile under `#![forbid(unsafe_code)]` and are used for data that crosses the boundary as an object (`Rect`, `RawRequest`, `KeyData`, `WindowInit`). Callback types are written out in each `#[napi]` signature in `sweetview-platform-node`, because a Rust type alias erases the parameter types from the generated TypeScript declarations.

## D13. Tray events are queued, never run inside `tray-icon`'s window procedure

`tray-icon` reports the shell's mouse messages from the icon's own window procedure, to one handler per process, while it holds its own state borrowed. The runtime's handler only queues the event as a deferred job (D3); the job runs on the next turn of whichever loop the UI thread is in. An application's click handler may therefore dispose of the tray, change its icon, or open a modal loop. The single and double click rule (a left click is a click only once the double-click time has passed with no second click) is safe Rust on a native timeout, as `win32/tray.ts` had it.

Alternative left open: call the application from inside the event handler; a handler that disposes of its tray would then free `tray-icon`'s state under its own borrow.

## D14. Menus are built fresh for each showing; item icons are 16 pixels

A menu crosses the boundary as data each time it is about to open, and a `muda` menu is built for that one showing and dropped after it, so labels, check marks and enabled state follow application state with no bookkeeping and nothing outlives the showing. `muda` draws an item's icon into a 16 by 16 bitmap, so the icon is decoded and resampled to that size by the runtime (`icon.rs`) from the `.ico` or PNG bytes the application gave. An item with both an icon and a check mark, which `muda` has no item type for, gets its check from `sweetview-platform-window::popup::check_item`.

## D15. The WebView2 environment is created the way the C++ library created it, once per process

`wry` creates its environment with browser arguments, a language and the extensions flag. Two environments on one user data folder with different options cannot run at once (`ERROR_BUSY`), so an application running an old build beside a new one, or sharing its profile across an upgrade, would fail to start its webview. `sweetview-platform-webview` creates the environment with no options, on the folder the C++ library used (the roaming application-data folder joined with the executable's file name, or `WEBVIEW2_USER_DATA_FOLDER` when set), keeps one per process, and hands it to `wry` through `with_environment`. An application's profile (cookies, local storage, service workers) is the same folder before and after the upgrade.

Alternative left open: let `wry` create it; existing profiles would then be unusable while any old build runs, and every origin's storage would start empty wherever `wry`'s default folder differs.

## D16. A page message is answered on a later turn, and a webview is dropped after its callback returns

A binding's function runs as a deferred job, not inside WebView2's `WebMessageReceived` callback, so it may open a modal dialog (W1.8) or destroy the webview. `destroy` marks the webview destroyed at once (no handler runs again; late answers get the documented `-3`), and the `wry` value is dropped when no callback of that webview is on the stack. This is the rule the proposal keeps from today ("a webview is never destroyed inside its own callback"), enforced in one place, `sweetview-runtime/src/engine.rs`.

## D17. Dropped files reach the host as one string message

The proposal names the C++ library's method: a script posts the dropped `File` objects with `postMessageWithAdditionalObjects`, and a `WebMessageReceived` handler reads each `ICoreWebView2File`. WebView2 delivers the additional objects only with a string message, which is what the C++ library posts; the platform crate posts the string `__sweetview_file_drop__` with the files attached and tells that message from the page's own by its exact text and its attached objects. `wry`'s drag-drop handler stays unused on Windows, as the proposal says, so drops inside the page still reach the page.

## D18. The macOS seam is one module per shared file, and the bindings package loads only on macOS

`packages/sweetview/src/webview-host.ts` is the seam R8 asks for: on Windows it returns the Rust engine; on macOS it returns today's code, which now lives in `darwin-webview-host.ts`, `darwin-webview-lib.ts` and `darwin-worker-wake.ts`. In the native package, `darwin/library.ts` is the only file that imports `@n1h/sweetview-webview-bun`, with a dynamic `import()` inside a `try` behind a platform test, so a Windows application bundles and compiles without that package installed; it is an optional peer dependency until the macOS goal removes it.

## D19. No list of dependent applications was made by this session

R2 runs the upgrade against each application listed in `rust-rewrite/local/dependents.txt` when that file exists. The file did not exist on this machine. Making one would mean searching the owner's private repositories for applications and deciding which count, which R6 keeps out of this work; so the file was not created, the `dependents` check reports that there was nothing to run, and `OWNER-ACTIONS.md` asks the owner to list them and run the check. The upgrade path itself is exercised by `rust-rewrite/compat/`: every row of `docs/upgrading.md` is imported and run in its new form.

## D20. Tests corrected because they measured the machine

Changed to correct a false result, each named here with its reason:

- `crates/sweetview-platform-notify`, `toasts_register_the_app_id_and_route_each_click_once`, and its counterpart in `packages/sweetview-native/src/win32/notifier.test.ts`: both showed five real toasts and then delivered events to them. A notification platform that shows no toasts (the hosted CI runner) dismisses each one at once, and its own event removed a toast before the test's event arrived; a shell that shows no balloons hides the fallback balloon at once, so it was never seen as pending. Each test now shows one real toast on a notifier of its own (the proof that `Show` works under the registered identity), routes events through toasts built and subscribed the same way but held back from the platform (`ForcedPath::ToastHeld`), and counts the fallback balloon as shown (`Notifier::balloons_shown`), which also proves it is shown once.
- `crates/sweetview-platform-webview/tests/teardown.rs`: asserted zero growth of USER and GDI objects over five webview lives. On the hosted runner WebView2 keeps one USER object over those lives with or without this project's extras. Growth is now compared with the same loop without the extras, which is how the test already measured kernel handles and is what it exists to prove.
- `crates/sweetview-platform-notify`, `creating_and_dropping_returns_every_handle`: read the kernel handle count straight after the last toast. The platform goes on working on a toast after `Show` and `Hide` return and holds handles while it does. The test now warms up with eight showing rounds instead of one, measures 32 showing rounds instead of 8 against the same allowance, reads each count once it has stopped moving, and prints the counts.
- `packages/sweetview-native/src/win32/window-native.test.ts`, the `startDrag` test: moved the cursor with `SetCursorPos` alone while the OS ran its move loop. In a session with nobody at it that moves the cursor but does not reach the move loop, so the window stayed put. The cursor is now moved by an injected absolute mouse move, as a mouse moves it, and then placed exactly.
- `crates/sweetview-platform-webview/tests/teardown.rs`, a second correction: on the hosted runner one USER object appears once in the process at a moment of WebView2's or the shell's choosing, sometimes during the lives with the extras and sometimes during those without. The lives with the extras are now run twice and the smaller growth of each kind counts: a leak of the extras repeats in every life and shows in both runs.
- `crates/sweetview-platform-window/src/tab_frame_tests.rs`, `popup_menus_give_every_handle_back`: asserted that the USER and GDI counts were equal before and after; the count fell by one when another test's thread ended meanwhile. It now asserts that the counts did not rise.
- `packages/sweetview/src/request-handler.test.ts`: failed when WebView2's subprocesses still held the test's own profile folder ten seconds after the fixture exited. The folder is in the temp directory; it is now left there with a warning. No assertion about a page changed.
- `crates/sweetview-platform-notify`, `creating_and_dropping_returns_every_handle`, a second correction: on the hosted runner about nine kernel handles appear once in the process, some time after the first toast, whether 8 or 32 toasts are shown in the measured rounds. The showing rounds are now measured twice and the smaller growth counts, for the same reason as in the teardown test.
- `packages/sweetview-native/src/win32/window-native.test.ts`, the `startDrag` test, a second correction: the test waited a fixed 30 ms after injecting the press before calling `startDrag`. The OS starts its loop only when the calling thread's own queue has seen the press, so the test now waits until `GetKeyState` shows it on this thread. (The reading that prompted this, "no move loop on the runner", came from a diagnostic that read the foreground thread; the next entry but one has the corrected readings.)

- `packages/sweetview-native/src/win32/window-native.test.ts` (`startDrag`), the move-loop control in `packages/sweetview-native/test/win32-os.ts` and the gesture checks of `packages/sweetview/test/fixtures/win-tabs-input.ts`, after the hosted runner's readings were corrected (an earlier diagnostic read the foreground thread, not the test's own): the runner's OS does run the move loop and the window does arrive, but later than a reading taken a fixed 200 ms after the cursor move; and its screen is small, so windows placed by absolute coordinates were partly or wholly off it. Each check now waits inside the loop until the window is at the expected rectangle (with a limit) before it reads and releases, and lays its windows and cursor points out from the primary screen's work area. What is asserted is unchanged: the window is at the expected rectangle while the button is still down.

- The same `startDrag` test is `test.skipIf(moveLoop?.ok === false)`: before it runs, a control (`moveLoopControl()` in `packages/sweetview-native/test/win32-os.ts`) presses the left button over a plain window of the test's own, with no Sweetview code involved, sends it `WM_NCLBUTTONDOWN` itself and reports whether the OS runs a move loop and the window follows. When the control succeeds, which it does on this machine and on the hosted runner, the test runs with its assertions unchanged; when the session's OS runs no move loop for an injected press at all, the test shows as skipped, not as passed. The gesture checks of the tabs fixture use the same control.
- The notifier tests' real toasts: at the tag the test showed five real toasts with a banner. They now show one, without a banner and with an expiry (`Notifier::set_toast_life`; commits `758c2fc` and `a5d4260`), because on a machine with nobody at it Windows keeps a banner up and queues the rest behind it, and earlier runs had left a queue of banners and one platform entry per throwaway app id. What the baseline also checked and no longer has a counterpart: that a real toast, left on screen, raised no `Failed` event during the test. The routing of `Failed`, `Dismissed` and `Activated` is tested on held toasts instead.
- Four baseline tests in `win32.test.ts` tested the byte layouts the TypeScript wrote for `Shell_NotifyIconW` and `SetMenuItemInfoW` ("notifyIconData lays out the balloon fields where Windows expects them", "the 32px balloon icon loads from the generated .ico", "hiddenBalloonData sets NIS_HIDDEN and NIF_INFO for standalone notifications", "bitmapItemInfo lays out MENUITEMINFOW for hbmpItem"). The layouts now come from the `windows` crate, so the byte offsets have nothing left to test; what they guarded (the balloon's flags, its hidden state, its icon from an `.ico`, a menu item's bitmap) is asserted by the notify crate's tests and by `win32/tray-menu.test.ts`, which the review of this work asked for by name (its F16).

## D21. Adding a user script does not wait; what the host asks of the page waits for it, in order

WebView2 registers a script added with `AddScriptToExecuteOnDocumentCreated` asynchronously, and a navigation started before the completion arrives can create its document without the script. The C++ library closed that race by pumping messages until the completion arrived. But WebView2 sends that completion only once a navigation already in flight has its response. When the response comes from a `Bun.serve` on the UI thread, the JavaScript that would send it cannot run inside the pump, so `bind`, `init` and `unbind` never returned; the C++ library hangs the same way (run against it in the same scenario). `add_user_script` now returns at once and counts outstanding registrations. Everything the host then asks of the page goes through one ordered queue in `sweetview-runtime/src/engine.rs`: `navigate`, `setHTML`, `eval`, a binding's reply and the bridge's bind and unbind notices. While a registration is outstanding, or anything is held, they are held in the order asked and carried out on the turn after the last completion, which is where they ran when adding a script waited. Without this, an `eval` right after `navigate` and `bind` on a new webview ran in the blank document the held navigation was about to replace. A held navigation stops the one in flight (`ICoreWebView2::Stop`), which it would cancel anyway, so the completion arrives even when that navigation would never get its response, as inside a blocking `run()`. A held evaluation stops nothing. A script added by `init` or `bind` is in every document from a navigation asked for after the call returns.

Alternative left open: keep the wait and let the page's response make progress meanwhile; Bun's event loop cannot be run from inside a native call, so this has no implementation. A narrower variant, holding evaluations only behind held navigations and not behind outstanding registrations, was not taken because it no longer matches where calls ran before.

## D22. The tab frame is `tao`'s undecorated window and answers its backdrop and DPI changes itself

The frame of a tabbed window is a `tao` window built with `with_decorations(false)` and `with_undecorated_shadow(true)`. The system keeps its resize border, shadow, snap, maximise and system menu, and the caption goes to the strip, so this project has no `WM_NCCALCSIZE` code; the proposal's fallback (a window this project creates itself) was not needed. The strip and every tab are `wry` child webviews of the frame; the pane windows of the old code have no counterpart, and a tab moves between windows with `reparent`.

The tab context menu is this project's own synchronous popup (`CreatePopupMenu` and `TrackPopupMenu` with `TPM_RETURNCMD`, in a menu destroyed on drop), not `muda`'s. The tabs library needs the chosen item before the call returns; `muda` 0.22's `show_context_menu_for_hwnd` is an `unsafe fn` that returns only whether something was chosen and reports which item later through its process-wide `MenuEvent` handler.

Activation comes from the existing window subclass (D8) as `WindowEvent::Activated`. The backdrop and `WM_DPICHANGED` are answered by a second subclass procedure on the frame (`FrameMessages` in `sweetview-platform-window`), so the subclass every window has stays as it is:

- `WM_ERASEBKGND` fills the strip's rectangle (its height at the window's DPI) and the page's rectangle with two owned solid brushes: `#e9eaee` and `#f9f9fb` light, `#292a30` and `#15161a` dark, as the old frame painted them. The brushes are replaced when a frame that follows the system changes theme. `tao` paints one background colour.
- `WM_DPICHANGED` goes to `tao` first, so it records the new scale, then the rectangle the system suggests is applied. `tao` keeps its own size when the scale is unchanged and computes one from the old inner size otherwise.

Alternative left open: arms for both messages in the subclass in `windows.rs` (one procedure, but every window would carry tab-frame state), or `muda`'s context menu with its event channel (an asynchronous tab menu).

## D23. What the safety pass changed: two crates added, shared pieces in the loop crate

A pass over every `unsafe` block, in the order `UNSAFE-POLICY.md` gives, took the workspace from 322 uses to 217 (178 in source, 39 in tests). `rust-rewrite/UNSAFE-LEDGER.md` has the reason for each that remains.

- `windows-registry` 0.6.1 is added. It is Microsoft's safe registry API, from the same repository and release line as `windows` 0.62. Its `Key` closes on drop, and its create, set-string, delete-tree and get-type calls are the Win32 calls the hand-written code made, with the same access rights and the same Win32 error codes in the messages. It removed every hand-written registry use in `sweetview-platform-shell` (URL schemes) and `sweetview-platform-notify` (the toast identity key).
- `dirs` 7.0.0 is used directly. It was already in `Cargo.lock` through `wry` and `tray-icon`. Its `config_dir` is `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` with default flags, the call the C++ library made for the default WebView2 profile folder (D15).
- `clipboard-win` 5.4.3 was read and not taken: its close impersonates the anonymous token and then reverts, which drops any impersonation the calling thread had, and its size check turns a lock failure into "no text". Both change behaviour.
- One owning type for a message-only window (`MessageWindow`, with its `Poster` for other threads), the pump calls and the handle counts now live in `sweetview-platform-loop`, and the notifier, the single-instance window, the clipboard owner and the tests use them instead of each having its own.
- Both window subclass procedures are safe `extern "system"` functions; `WebviewExtras::move_focus` is gone in favour of `wry`'s `WebView::focus`, which makes the same call.

What was judged possible and not done, each because it changes behaviour: the clipboard on WinRT (ownership and retry differ), and the tab menu and system menu on `muda` (the choice would arrive as an event, D22).

`tao` 0.38 leaves one wait thread behind for every event loop it makes (one USER object and two kernel handles). A process has one loop, so this costs nothing; the `LoopHost` handle test holds the host to no more than a bare `tao` loop for that reason.

## D24. One check of `verify.ts` was made stricter

The `privacy` check looked for machine-local paths under a `Users` or `home` folder only, and so passed over an evidence file that held this checkout's own path on another drive (the review's F13 and F35). It now also fails on any changed file that holds the checkout's own absolute location, with either slash. Nothing else in `verify.ts` changed, and no check was made weaker.
