# sweetview-platform-loop

Job: the parts of the UI thread's event loop that `tao` has no API for.

| Type | What it gives | Why `tao` does not serve |
|---|---|---|
| `LoopHost` | the loop's window target to code that runs while the loop is running | `run_return` borrows the `EventLoop` mutably for the whole run, so a callback that arrives from the OS inside the run (a WebView2 handler, a timer, a tray click) has no reference to build a window with |
| `SignalWindow`, `Waker` | a wake from any thread, and native timers, both delivered by whichever message loop the UI thread is in | `EventLoopProxy` events and `ControlFlow::WaitUntil` are delivered by `tao`'s own handler, which `tao` holds back while that handler is already running, as it is when a handler has opened a modal dialog |

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
