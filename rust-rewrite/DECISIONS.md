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

More crates are added by the groups that need them; each gets a row here when it lands.

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
