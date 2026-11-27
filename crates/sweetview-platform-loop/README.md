# sweetview-platform-loop

Job: the parts of the UI thread's event loop that `tao` has no API for.

| Type | What it gives | Why `tao` does not serve |
|---|---|---|
| `LoopHost` | the loop's window target to code that runs while the loop is running | `run_return` borrows the `EventLoop` mutably for the whole run, so a callback that arrives from the OS inside the run (a WebView2 handler, a timer, a tray click) has no reference to build a window with |
| `SignalWindow`, `Waker` | a wake from any thread, and native timers, both delivered by whichever message loop the UI thread is in | `EventLoopProxy` events and `ControlFlow::WaitUntil` are delivered by `tao`'s own handler, which `tao` holds back while that handler is already running, as it is when a handler has opened a modal dialog |
| `MessageWindow`, `Poster` (Windows) | the one owning type for a message-only window in the platform crates (the signal window, the notifier's, the clipboard's owner, the single-instance window), with its window procedure as a closure; the procedure answers `WM_CLOSE` itself, and a window destroyed by other code disarms its owner; `Poster` posts to it from any thread and fails once it is gone | `tao` makes top-level windows only, and its own message target is private |
| `next_message`, `wait_message`, `dispatch_waiting`, `QueuedMessage` (Windows) | the message pump's calls, for the nested pumps and the tests of every platform crate; a message is dispatched only as the OS queued it, and at most once (`dispatch` consumes it) | `tao` pumps only its own loop |
| `resource_counts`, `testing` | the process's USER, GDI and kernel handle counts, and how the platform crates' tests compare them (`assert_gives_back_every_handle`): read once settled, measured twice, each count back at its starting value | no crate reads them |

`LoopHost` holds a clone of `tao`'s window target (`EventLoopWindowTarget` is `Clone` in `tao` 0.38), so lending it needs no pointer.

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
