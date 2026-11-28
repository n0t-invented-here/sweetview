# Third independent review of the Rust rewrite, Windows goal: the second review's fixes

## What was reviewed

The merge of branch `rust-rewrite-fix-timers` into `v1-rust-rewrite` (merge `5b0388d`): the fixes for the second review's G1 to G14 (`rust-rewrite/evidence/review-windows-2.md`) and decisions D38 to D41. File and line references below are at `5b0388d`. The reviewer could not compile the runtime and napi crates for macOS on its machine; the macOS check is reported with the answers.

Verdict: not yet. Findings H1 to H8, recorded here as the reviewer gave them.

## Findings

### H1. `must fix`. Posted ticks can starve input and paint

- Criterion: R1 (no capability is lost); decision D38's own statement "a busy thread gets one tick as it got one `WM_TIMER`".
- Where: `crates/sweetview-platform-loop/src/windows.rs:727-735` (`take_tick` clears `outstanding` before the handler runs) and `:740-764` (`post_ticks`, fixed rate).
- Observed: Windows serves posted messages before input, then `WM_PAINT`, then `WM_TIMER`. A tick is now a posted message, re-armed the moment it is taken, so a 10 ms interval whose handler takes 12 ms always has its next tick queued when the handler returns, and every loop takes that before any key, mouse or paint message: input and paint never come out. Under `SetTimer` such an application stayed responsive, because `WM_TIMER` is made only when nothing else is waiting. That is a capability lost (R1), and D38 says "a busy thread gets one tick as it got one `WM_TIMER`", which is not true of the consequence.
- What would settle it: a design in which timers cannot starve the rest of the queue. The reviewer's minimum is a gap after the handler returns (re-arm only after `handler(signal)` returns, `next = max(next, now + period)`), but the property an application had was "timers never run ahead of input and paint". Decide whether a tick should be delivered only when the thread's queue has no input or paint waiting (for example the window procedure, on taking a posted tick, checks `GetQueueStatus` or a peek for input and paint and, if any is waiting, defers itself behind them in a way that still cannot stall inside a modal loop, which was the original G1 defect); measure both candidates, and take the one that keeps both properties: ticks keep arriving inside a popup menu's loop (the probe: 0 stalls in 300, both modes), and a busy interval does not hold back input or paint. A test for each: the existing menu tests, plus a 10 ms interval whose handler sleeps 15 ms while a lower-priority message must still arrive within a bound (a paint request on a visible window of the test's own, and real input injected with `SendInput` to the test's own window when the desktop is free), under both loop modes. D38 rewritten to say what a busy interval does now.

### H2. `should fix`. Process exit spins 500 ms on the UI thread whenever a timer is still set

- Where: `windows.rs:892-915` (`stop_ticker`), `:924-931` (`Drop`).
- Observed: `JoinHandle::is_finished()` is never true for a thread the OS ended, and `returned` is false, so the second loop yields until the 500 ms deadline, inside `DLL_PROCESS_DETACH` under the loader lock, on every exit with a live timer (the 10 ms hit-region poll is one).
- What would settle it: `Drop` does not wait: try the lock once, set stop, notify, drop the `JoinHandle` (detach); the thread owns its `Arc` and its `Poster`, and the window's drop disarms the `Poster`. A bounded wait is kept only where a live thread is expected to answer (a few ms). The exit test asserts a bound on how long the exit takes.

### H3. `should fix`. A stale table entry can bind to a later window with the same handle value

- Where: `windows.rs:475-487` (`answer` no longer removes the `PROCEDURES` entry on `WM_NCDESTROY`), `:194-205` (`still_alive`), `:315-318` and `:439-444` (SAFETY comments now false), `:360-370`.
- Observed: after other code destroys the window, the entry and its target outlive it. If a later `MessageWindow::new` on that thread gets the same handle value, its creation messages find the stale entry, run the old closure, re-arm the old target, and the old owner's `Drop` destroys the new window.
- What would settle it: any entry found at `WM_NCCREATE` treated as stale (entries are inserted only after `CreateWindowExW` returns): its target disarmed and the entry removed first; the SAFETY comments made true; a test that plants a stale entry for a value and creates a window under it.

### H4. `should fix`. One lost tick silences its timer for good

- Where: `windows.rs:702-704`, `:747-749` (`outstanding` is cleared only by `take_tick`), `:200-204` (a held post whose re-post fails is dropped).
- Observed: a tick that is queued but never reaches the procedure (a failed re-post with a full queue; an application's own `bun:ffi` loop that removes messages and dispatches only its own windows') leaves that interval dead.
- What would settle it: `outstanding` expires (another tick is posted when one has been outstanding much longer than its period), and a failed re-post of a held tick stays held or is reported; a test that drops a tick and sees the interval resume.

### H5. `remark`. Timers due at the same wake are posted in `HashMap` order

- Where: `windows.rs:745`.
- Observed: two timeouts set in order for the same delay can run out of order.
- What would settle it: due timers posted in `(due time, id)` order; a test.

### H6. `remark`. A stop that times out can leave two tick threads

- Where: `windows.rs:826-842`, `:894-912`.
- Observed: one shared `stop` flag serves every thread.
- What would settle it: a generation per thread, or whatever the H2 redesign makes right.

### H7. `remark`. Comments the range made false

- Where: `crates/sweetview-runtime/src/runtime.rs:244-245` ("A pumped loop always has its own repaint request queued, which the OS serves before any timer") and `windows.rs:888-891` ("the lock is only tried, for a moment").
- What would settle it: both true of the final design; `Runtime::pump`'s `dispatch_due_timers` step checked now that ticks are posted, and what is dead removed.

### H8. `remark`. G5's 100 ms limit adds up across slow parked windows

- Where: `crates/sweetview-platform-window/src/windows.rs:617-624` (`shown_icon`).
- What would settle it: a total budget per sweep, or the bound recorded in D41.

## Answers
