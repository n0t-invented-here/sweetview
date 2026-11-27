# Decisions

Choices the Windows goal made, each with its reason and the alternative left open. `REQUIREMENTS.md` outranks this file; `SWEETVIEW-RESTART-PROPOSAL.md` is the design these adjust.

## D1. The crates and their boundaries

All under `crates/`, all from this repository; every dependency is from crates.io.

| Crate | Job | Why it is its own crate | `unsafe` |
|---|---|---|---|
| `sweetview-runtime` | everything that lives on the UI thread, with no JavaScript in sight: the loop in both modes and the objects on it | so the behaviour is testable with `cargo test`, with closures where JavaScript functions will be | forbidden |
| `sweetview-napi` | the binding: converts JavaScript values and functions and calls the runtime | the only crate that knows both N-API and the runtime; keeps N-API types out of everything else | forbidden |
| `sweetview-platform-node` | the export table: the items that carry `#[napi]`, each forwarding to `sweetview-napi` | see D2 | generated only; none hand-written |
| `sweetview-platform-loop` | the parts of the UI thread's loop `tao` has no API for: the window target while the loop runs, a wake and timers that arrive inside any modal loop | see D3 and D4 | yes |

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

## D4. `LoopHost` lends the loop's window target during a run, with one `unsafe` dereference

`tao`'s `run_return` borrows the `EventLoop` mutably for the whole run and gives the window target only to its event handler. A callback that the OS delivers inside the run but outside that handler (a WebView2 handler, a signal, a tray click) still has to be able to create a window, because JavaScript can do so from any callback.

Decision: `LoopHost::run` records the target `tao` passes to the handler and clears it through a drop guard when the run ends; `LoopHost::with_target` lends it. The pointer is valid exactly as long as the `run` frame is on the stack, which the type enforces without relying on callers. One `unsafe` block, in `crates/sweetview-platform-loop/src/loop_host.rs`.

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
