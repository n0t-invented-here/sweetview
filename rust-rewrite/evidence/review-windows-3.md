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

### H1

**Fixed.** Both candidates were built and measured (decision D38 has the full tables). In `crates/sweetview-platform-loop/src/windows.rs` a timer's tick now goes through three phases (`Waiting`, `Posted`, `Running`): the next period starts only when the job returns or unwinds (`finish_tick`, through `Finish`), so a job longer than its period leaves the rest of the queue a whole period; and a tick taken while key or mouse-button input waits (`GetInputState`) is handed back and posted again 1 ms later, for at most 100 ms after it came due, so input is taken first, as it was ahead of a `WM_TIMER`, and a loop that never takes some input still gets its timers. Paint is not waited for: under the pumped loop `tao` keeps a paint request pending nearly always (the G1 mechanism), and the candidate that deferred behind paint too cut a busy interval's ticks from 64 to 41 (29 to 13 in the runtime test).

Measured, a 10 ms interval whose job takes 15 ms, five real clicks (`SendInput`) and five repaints of an application's own window per run, the longest waits: on `5b0388d`, 62 ms for a click and 478 ms for a repaint in the blocking run, 1629 ms and 809 ms under the pump; with the design taken, every wait after the first click (which also waits for the window to come to the front: 54 and 32 ms) at most one job, 16 ms. Through the runtime, `tao`'s own paint (and `MainEventsCleared`, which ends a pump) waited up to 261 ms under the pump on `5b0388d`, with a pump taking up to 339 ms, and up to 141 ms in the blocking run; now up to 16 ms. Both properties hold: the menu probe shows 0 of 300 menus without a tick in each mode, and the busy interval holds back neither input nor paint.

Tests: `a_busy_interval_leaves_paint_its_turn_in_both_loop_modes` (`crates/sweetview-runtime/src/runtime.rs`; fails on `5b0388d` with the numbers above, passes now) and "a busy native interval does not hold back input or paint (D38)" (`packages/sweetview-native/src/modal-loop.test.ts`, both loop modes, fixture `test/fixtures/busy-interval-input.ts`, every click and repaint within 100 ms; on `5b0388d` the fixture measured the waits above), with the menu tests of G1 still passing. D38 now says what a busy interval does: its period counts from the end of its job, its tick waits behind key and mouse-button input for at most 100 ms, and an interval whose job opens a modal loop pauses until the job returns.

### H2

**Fixed.** `SignalWindow::drop` waits for nothing: `stop_ticker(Duration::ZERO)` sets the thread's own stop flag, wakes it under the lock when the lock is free (the thread looks at its flag again within 100 ms when not), and lets the `JoinHandle` go; the thread owns its `Arc` and its `Poster`, and the window's drop disarms the `Poster`. Only the release at the end of the application, where a live thread is expected to answer, waits for it, at most 20 ms. The exit test ("a process that exits with a native interval still set ends cleanly", `modal-loop.test.ts`) asserts the process ends within 300 ms of `process.exit`: 534 to 579 ms on `5b0388d`, 30 to 33 ms now. `a_drop_waits_for_nothing_and_a_thread_left_to_end_does_not_tick_beside_its_successor` asserts a drop with a timer set takes under 50 ms and the thread then returns by itself.

### H3

**Fixed.** An entry is added only after `CreateWindowExW` returns, so in `answer` one found at a creation message (`WM_GETMINMAXINFO`, which a message-only window gets even before `WM_NCCREATE`, as the test showed; `WM_NCCREATE`, `WM_NCCALCSIZE`, `WM_CREATE`) while this thread is inside `MessageWindow::new`'s `CreateWindowExW` (`MAKING`, `is_being_made`) is stale: `forget_stale` disarms its target and removes it before anything of the new window runs. Outside creation those numbers, which anyone can post, reach the owner as usual. The SAFETY comments of `CreateWindowExW`, `Poster::post`, `window_handle` and `Drop` now say so. Test: `a_stale_entry_under_a_new_windows_handle_value_is_forgotten_at_its_creation`: a `WH_CBT` hook plants, under the new window's handle value, the entry and armed target a destroyed window would have left; the planted closure never runs, the planted target is disarmed, the new window's own entry is in the table, and dropping the stale owner leaves the new window alive and working. With the rule at `WM_NCCREATE` alone, as first written, the planted closure ran at `WM_GETMINMAXINFO` and the test failed. Decision D39.

### H4

**Fixed.** A posted tick not taken within four periods (and at least 250 ms) counts as lost: the tick thread posts it again under a new number, and the lost one is dropped if it arrives later, so it neither silences the timer nor runs twice. A held post the queue refuses (`Target::flush`) stays held, in order, and goes out first with the next post or the next message the window gets. Tests: `a_lost_tick_is_posted_again_and_the_timer_goes_on` (the first tick taken off the queue without being dispatched; the timer ticks again after the lost interval) and `a_held_post_the_queue_refuses_stays_held_and_goes_out_in_order` (the thread's queue filled to its limit while two posts are held; the one refused stays held and arrives second). Decisions D38 and D39.

### H5

**Fixed.** The tick thread collects the timers due at a wake and posts them sorted by when they came due, then by id, which is the order they were set. Test: `timers_due_at_the_same_wake_tick_in_the_order_they_were_set` (six 30 ms timers set in order, twenty rounds).

### H6

**Fixed.** Each tick thread has its own stop flag (`Ticker::stop`), so a thread told to stop and left to end returns at its next look and never ticks beside the one that replaced it; the timers' state is shared under one lock, so two threads could not post the same due tick twice either. Test: the second half of `a_drop_waits_for_nothing_and_a_thread_left_to_end_does_not_tick_beside_its_successor` (the first thread returns, and the 50 ms timer's ticks stay at least 40 ms apart).

### H7

**Fixed.** `SignalWindow::dispatch_due_timers` and its call in `Runtime::pump` are gone: ticks are posted messages, which `messages_waiting` sees and `tao`'s loop dispatches, so nothing is left to take after a pump; the comment there says so. Its test, `due_timers_are_delivered_on_request_while_other_messages_are_queued`, went with it (D20). The comment of `stop_ticker` describes the final design (the lock is tried once, nothing is joined at exit).

### H8

**Fixed.** One sweep of the parked icons spends at most 200 ms asking in all (`SWEEP_BUDGET` in `crates/sweetview-platform-window/src/windows.rs`); a window not asked in time keeps its icons parked until a later sweep, and dropping a `WindowIcons` asks its one window for at most 100 ms. Test: `a_sweep_of_many_parked_windows_that_do_not_answer_stays_within_its_budget` (six windows of a stopped thread: 653 ms without the budget, within 400 ms with it). The bound is recorded in D41.

### The macOS check

`bun rust-rewrite/checks/mac-check.ts` on the final tree, with its stand-in C compiler, type-checks every crate of the workspace for `aarch64-apple-darwin`, the runtime and napi crates the reviewer could not check among them (the other crates were up to date from the run before):

```
$ cargo check --target aarch64-apple-darwin --workspace   (C compiler and archiver: a stand-in that creates empty outputs)
    Checking sweetview-runtime v1.0.0 (<REPO>\crates\sweetview-runtime)
    Checking sweetview-napi v1.0.0 (<REPO>\crates\sweetview-napi)
    Checking sweetview-platform-node v1.0.0 (<REPO>\crates\sweetview-platform-node)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 10.54s
exit: 0; warnings and errors: 0
```

### The checks on the final tree

- `cargo clippy --workspace --all-targets -- -D warnings`: clean. `bun run typecheck`: clean. `bun rust-rewrite/checks/mac-check.ts`: exit 0, no warning or error (above).
- `cargo test --workspace --no-fail-fast`, without `WEBVIEW2_USER_DATA_FOLDER`: 252 passed, 0 failed, 1 ignored (`hands_off_to_and_from_the_typescript_implementation`, which drives the TypeScript single-instance through `bun` and runs with `--ignored`).
- The menu probe (`rust-rewrite/local/timer-menu-probe.ts`), 300 menus per mode: 0 without a timer tick, with a fresh interval and with one that had ticked for a while.
- The whole `bun test`, on a fresh `WEBVIEW2_USER_DATA_FOLDER`: 493 pass, 20 skip, 0 fail across 47 files. Fifteen of the skips are the macOS-only tests and the unsupported-OS test. Five skipped because the shared desktop did not give the test's window the foreground at that moment: the two own-foreground tests of `input-hooks.test.ts` and the three accelerator and F12 tests of `webview.test.ts`; those two files run again alone straight after passed all 38 of their tests, none skipped.
- `bun rust-rewrite/verify.ts windows --quick`: every check passes but `git`, which asks for the branch `v1-rust-rewrite`; this work is on `rust-rewrite-fix-timers-2` until it is merged.
- Two SAFETY comments of `crates/sweetview-platform-loop/src/windows.rs` were reworded after the test runs, to fit the six lines `verify.ts` looks at; no code changed, and the binding was built again and the checks that need no desktop run again after it.
