# Second independent review of the Rust rewrite, Windows goal

## 1. What was reviewed

- The change set: the 39 commits `26a5474..533d64e` on branch `v1-rust-rewrite` (`git log --oneline 26a5474..533d64e`, `git diff 26a5474..533d64e`): the fixes for the 41 findings of `rust-rewrite/evidence/review-windows.md`, two product fixes found afterwards (`a61910c`, `ea51374`), test corrections, and the evidence produced again.
- The tree as found: `git rev-parse --short HEAD` prints `533d64e`. `git status --short` prints one line, `?? SWEETVIEW-CONSOLIDATION-CHECKLIST.md` (untracked, not part of this work, not read). No tracked file is modified. `rust-rewrite/local/` was not read.
- The reviewer wrote none of the code. This is a reading review. One file was written, this one.

The criteria, by file:

1. `rust-rewrite/UNSAFE-POLICY.md`, every rule, for every `unsafe` block added or changed in the range and every public item of a `sweetview-platform-*` crate added or changed in the range.
2. `rust-rewrite/REQUIREMENTS.md`: R1, R3, R4, R6.
3. The owner's rule on tests: "Never weaken a test, a checklist item, a requirement or a check in `rust-rewrite/verify.ts`; change one only to correct a false result", with `rust-rewrite/DECISIONS.md` D20 as the record of each correction.
4. `rust-rewrite/evidence/review-windows.md`, section "Answers": each of F1 to F41 against the tree at `533d64e`.
5. `rust-rewrite/CHECKLIST-windows.md`: each item whose evidence changed in the range, against its own text and against the evidence file it cites.
6. The two product changes in `crates/sweetview-runtime/src/runtime.rs` read as code (`build_event_loop`, `Runtime::pump`), against `tao` 0.38.0's Windows event loop as it is in the cargo registry (`src/platform_impl/windows/event_loop.rs`, `event_loop/runner.rs`), and the open defect recorded at the end of D20.

How it was read. The lead read `Runtime::pump`, the whole of `crates/sweetview-platform-loop/src/windows.rs` up to its tests, `loop_host.rs`, `popup.rs`, the runtime's `tray.rs`, the clipboard's lock, the window icons, the webview's `environment.rs`, the `tao` sources named above and `tray-icon` 0.27.0's window procedure. Seven bounded reading tasks went to helper sessions, each with a question and none with a conclusion. Every helper claim that a finding below rests on was read again in the source by the lead. A claim taken from a helper without that second reading is marked "(helper)".

What was run: `git` read commands, and `bun rust-rewrite/verify.ts windows --quick` (no `--ledger`). It prints `PASS checklist` (65 ticked, 0 open, 0 ticked without evidence), `PASS ffi` (31 files, 31 allowlisted, 0 as setup), `PASS unsafe` (229 uses in 21 files, each with a SAFETY comment, none outside a platform crate), `PASS api-surface`, `PASS upgrade-guide`, `PASS privacy` (0 path hits), `PASS git`, and skips `cargo`, `tests` and `demos`. No test, demo, build or hosted workflow run was started or read.

## 2. Coverage

### `unsafe` blocks added or changed in the range

The count went from 217 uses at `26a5474` to 229 at `533d64e` (179 in source, 50 in tests). Line numbers are at `533d64e`.

| File | Lines | Verdict |
|---|---|---|
| `crates/sweetview-platform-loop/src/windows.rs` | 69, 78, 199, 265, 282, 307, 359, 418, 577, 612 | meet the policy |
| the same | 149 (`PostMessageW` in `Poster::post`), 402 (`DispatchMessageW`) | one operation each; the SAFETY text of 402 claims more than holds, G3 |
| the same, tests | 808, 828, 853, 865 | meet the policy |
| `crates/sweetview-platform-notify/src/windows.rs` | 163, 174, 316; tests 1028, 1034 | meet the policy (helper) |
| `crates/sweetview-platform-shell/src/clipboard.rs` | 117, 124, 151 | one operation each; the guarantee of the clipboard's block rests on the module's callers, G4 |
| the same | 192; test 336 | meet the policy |
| `crates/sweetview-platform-shell/src/win.rs` | 35, 47 | meet the policy; `OwnedHandle` is made only by `named_mutex` |
| `crates/sweetview-platform-window/src/windows.rs` | 125, 380, 383, 447, 716, 758 | meet the policy (helper for 380, 383, 716, 758) |
| the same | 505 (`DestroyIcon`), 541 (`SendMessageW` for the icon messages) | memory safe; the send has no limit and reaches windows of other processes, G5 |
| `crates/sweetview-platform-window/src/popup.rs` | 67, 82, 91 | meet the policy |
| `crates/sweetview-platform-window/src/tab_frame.rs` | 47, 68, 90, 105, 108 | meet the policy (helper) |
| `crates/sweetview-platform-window/src/metrics.rs`, `test_support.rs`, `windows_tests.rs` | 69; 26, 33; 67 (tests) | meet the policy (helper) |
| `crates/sweetview-platform-webview/src/windows/handlers.rs` | 171, 183, 197, 205 | meet the policy (helper) |
| `crates/sweetview-platform-webview/src/windows/istream.rs` | 75, 138 | meet the policy (helper) |
| `crates/sweetview-platform-webview/src/windows/mod.rs` | 617, 865, 898 | meet the policy (helper) |
| `crates/sweetview-platform-input`, `crates/sweetview-platform-node` | none added or changed | `sweetview-platform-node` holds no `unsafe`; `crates/sweetview-napi` still has `#![forbid(unsafe_code)]` |

The four `deny` lints are at the root of each platform crate. No `transmute` and no `static mut` were added. The global state added is a `OnceLock` (`CLASSES`, the atomics of D31) or a `thread_local!` (`PROCEDURES`, `PARKED`, `HANDED_OUT`, `APARTMENT`). No public item added or changed in a platform crate is an `unsafe fn` or takes a raw pointer; `BorrowedWindow::with_handle_value` and `menu_handle_value` carry a handle as a number, which is the form the first review asked for (its F3) and D25 and D26 record. `UNSAFE-LEDGER.md` has one row per file with `unsafe`, and each count equals the count `verify.ts` prints.

### Test files changed (criterion 3)

| File | Verdict |
|---|---|
| Handle tests of the loop, shell, window crates and the runtime's windows (`windows.rs`, `com.rs`, `clipboard.rs`, `single_instance.rs`, `url_scheme.rs`, `windows_tests.rs`, `tab_frame_tests.rs`, `window_tests.rs`) | changed to `testing::assert_gives_back_every_handle`: USER and GDI went from equal over one loop to "no growth over the smaller of two loops", kernel and unread counts became stricter. D20 records it (the third `tab_frame_tests.rs` entry) and the reason holds |
| `crates/sweetview-platform-notify/src/windows.rs`, `creating_and_dropping_returns_every_handle` | the kernel allowance of the showing rounds went from 4 to "below 16"; USER, GDI and the idle kernel count became equalities. D20 records it with a measured reason. Not run here |
| `crates/sweetview-platform-webview/tests/teardown.rs` | USER and GDI are compared with the control run and a floor of 0 (lines 150 to 157). D20's last teardown entry records it. The first review's answer to F9 says something else, G6 |
| `crates/sweetview-platform-input/tests/windows_hooks.rs`, `crates/sweetview-platform-webview/tests/environment.rs`, `tests/requests.rs` | stricter or unchanged |
| `crates/sweetview-runtime/src/menu.rs` | the test of the swapped `muda` handler went with that code; D20 records it |
| `packages/sweetview-native/src/binding.test.ts` | one existing test can now be skipped, and D20 does not record it, G8 |
| `packages/sweetview-native/src/webview.test.ts` and `test/fixtures/webview-callbacks.ts` | the accelerator fixture counts only F12, and a foreground lost during the run is a skip; D20 records both (its entry for F33) and the reason holds |
| `packages/sweetview-native/src/callbacks.test.ts`, `index.test.ts`, `input-hooks.test.ts`, `input-hooks-example.test.ts`, `modal-loop.test.ts`, `win32/notifier.test.ts`, `win32/overlay.test.ts`, `win32/strip-shared.test.ts`, `win32/tray-menu.test.ts`, `win32/win32.test.ts`, `win32/window-native.test.ts` | nothing asserts less; several assert more (helper) |
| `packages/sweetview/src/app.test.ts` | limits raised for the three start-up tests, recorded in D20; the raised default of `pumpUntil` also reaches two tests D20 does not name; what is asserted is unchanged, G13 |
| `packages/sweetview/src/tabs/win-tabs.test.ts`, `test/fixtures/win-tabs.ts`, `win-tabs-input.ts`, `win-menu-probe.ts` | one check follows the product's rule for a frame taller than the work area, recorded in D20, reason holds; no check name was removed |
| `packages/sweetview-build/src/build.test.ts`, `rust-rewrite/compat/own-modal-loops.test.ts`, `upgrade-guide.test.ts` | additions only |
| `rust-rewrite/compat/behaviour.test.ts`, `fixtures/tabs.ts` | expectations turned to the restored behaviour of F14; recorded in D20 |
| `rust-rewrite/compat/fixtures/row-runners.ts` (new) | three runners report a pass without judging, G9 |
| `rust-rewrite/verify.ts` | one check made stricter (D24); nothing weakened |

No requirement text of a checklist item changed in the range: the only changed item lines are the boxes of W0.6 and W10.2.

### F1 to F41: is the answer true of `533d64e`

| Finding | Answer | Note |
|---|---|---|
| F1 | holds | `dispatch(self)`, no `Clone`, the `compile_fail` doctest is there |
| F2 | partly | `WM_CLOSE` is answered and `WM_NCDESTROY` disarms, as asked; a posted `WM_NCDESTROY` now disarms a window that is alive, G3 |
| F3 | holds | `ForeignWindow` is gone; `BorrowedWindow<'a>` is lent per call |
| F4 | partly | the lock borrows its owner, but the clipboard arm is a shared borrow, G4; the parked icons add a blocking send, G5 |
| F5 | holds | no decision is left in `sweetview-platform-node` (helper) |
| F6 | holds | both calls go through the safe API; the error codes are unchanged (helper) |
| F7 | partly | the four sentences are corrected; the group "The suggested rectangle of a DPI change" (`UNSAFE-LEDGER.md:180`) still names no API looked for and no page, G12 |
| F8 | partly | every body is wrapped and returns `E_UNEXPECTED`; one of the five tests named cannot fail on the old code, G11 |
| F9 | does not hold in one sentence | the teardown test does not assert "exactly 0", G6 |
| F10 | partly | the runs are in `w10-miri.txt`; the answer's counts are not the file's, G12 |
| F11 | holds | each atomic is in a `OnceLock` |
| F12 | holds | the ledger sections the answer names exist and account for the uses as they are now |
| F13 | holds | no machine-local path was found in the files changed in the range or in the commit messages |
| F14 | holds | flags, `windowMenu`, `buildMenu` and `destroyMenu` are as the answer says; the four tests assert OS readings (helper) |
| F15 | partly | every evidence file was produced again in `c744c56`; W0.6 is the exception, G7; three smaller mismatches, G14 |
| F16 | holds | the three balloon tests and the icon test assert what the answer says (helper) |
| F17 | holds by reading | no run without the scope is recorded, G11 |
| F18, F19, F20, F21, F22, F23 | hold | each named test exists and can only pass by asserting, skip with a reason, or throw `not run` (helper) |
| F24 | partly | which icon carries the balloon while a tray exists is not read from the OS, G11 |
| F25 | answered | not met as the item is written; the click by hand is in `OWNER-ACTIONS.md` section 4 |
| F26 | partly | each of the 27 bullets has a row in `w7-native-tabs.txt`; one row still says "FAILS", and the count in the answer is off, G12, G14 |
| F27 | partly | every row has a runner and the exemption list is empty; three runners pass without judging, G9 |
| F28 | holds | the fenced block is under W10.4 and matches the file |
| F29 | holds in code | the second half of the named test asserts on a state the test built, G11 |
| F30 | partly | the failure path removes the filters; at teardown they are dropped after `Close()`, where the removal does nothing, G12 |
| F31 | holds | all seven are `Agile = false`; the test checks three of them, G11 |
| F32 | partly | the three changes are in the code; the `Toasts` test would pass without the `Drop`, G11 |
| F33 | partly | true of the tests it names; the same pattern is in the new row runners, G9 |
| F34, F35 | hold | (helper) |
| F36 | partly | every exported function, method, getter, factory and constructor carries `catch_unwind`; `on_load` and the classes' finalisers do not, G12 |
| F37, F39 | answered | no change, as said |
| F38 | does not hold now | it says W0.6 stays open; W0.6 is ticked, G7 |
| F40 | holds | (helper) |
| F41 | partly | entered once per thread; "left after the thread's later-made values" is true only of values first used after it, G12 |
| "Found after the review" | partly | the keyboard-hook fix holds; the pump fix does what it says and adds two defects, G2; "every watcher is now disarmed" leaves one timer, G10; the unexplained menu state is G1 |

### Checklist items whose evidence changed

| Items | Verdict |
|---|---|
| W0.4, W0.5 | hold |
| W0.6 | the evidence is a digest of a hosted run on an earlier commit, G7 |
| W1.1 to W1.8 | hold; W1.3's pasted block has a `0 skip` line the file does not, G14; W1.8's "a native timeout fires" is true of the run recorded and is not always true, G1 |
| W2.1 to W2.9, W3.1 to W3.5 | hold; W3.5 quotes page-log text that is asserted by the test and is not in the evidence file, G14 |
| W4.1 to W4.8 | hold; W4.7's block joins lines that are not adjacent in the file, G14 |
| W5.1, W5.3, W5.4 | hold |
| W5.2 | partly: it cites a group "win32 icons" in `w5-tray-menus.txt`; that group is in `w4-windows.txt`, G14 |
| W5.5 | not met as written (the click by hand, F25, the owner's) |
| W6.1, W6.2, W6.3, W7.2, W8.1, W8.3, W9.1, W9.2, W10.1, W10.4 | hold |
| W7.1 | partly: the file's own table says one check fails while its run shows it passing; a real change of display scale was not run, as the file says, G14 |
| W8.2 | partly: "with the binding embedded" and "native-tabs has no compile recipe" are not in the cited file, G14 |
| W9.3 | cites no file; the `upgrade-guide` check of `verify.ts --quick` passes; see G9 |
| W10.2 | holds as worded: it records the first review of `26a5474`. The uses of `unsafe` added afterwards were first read independently in this review |
| W10.3 | partly: `HANDOFF-macos.md` stops at D32 and still names CI as a source of binaries and of evidence, G12 |

### The two product changes (criterion 6)

- `build_event_loop`, `set_device_event_filter(DeviceEventFilter::Always)`: correct as code. In `tao` 0.38.0 it calls `register_all_mice_and_keyboards_for_raw_input` with `RIDEV_REMOVE` and a null target (`raw_input.rs:128-159`), which removes the registration `EventLoop::new` made (`event_loop.rs:200`). `tao` uses raw input only for `DeviceEvent`s, which Sweetview does not report. One inaccuracy in the comment, G12.
- `Runtime::pump`: the user event before the run and the guard do what D30 says inside `tao`'s own `GetMessageW` loop. The guard is owned by a cell that a nested pump overwrites and an unwind skips, G2. Inside a modal loop the guard relies on `WM_TIMER`, which is what stops in the open defect, G1.

## 3. Findings

Most severe first. G1 and G2 are `must fix`; G3 to G10 are `should fix`; G11 to G14 are remarks.

### G1. `must fix`. Under the pumped loop a tray menu can stop every native timer of the thread, and the defect is recorded only as an aside about a test

- Criterion: 6, "A known open defect"; R1, "An application's own `bun:ffi` calls on the UI thread, including its own modal dialogs and popup menus, keep working inside Sweetview's event loop" and "Both ways of running the loop stay available".
- Where: `crates/sweetview-runtime/src/runtime.rs:211-248` and `374-377`; `crates/sweetview-runtime/src/tray.rs:153-164`, `348-391`; `crates/sweetview-platform-window/src/popup.rs:61-69`; `crates/sweetview-platform-loop/src/windows.rs:483-485`, `571-583`, `599-605`. `tao` 0.38.0, `src/platform_impl/windows/event_loop.rs:250-252`, `744-775`, `777-797`, `919-924`, `2294-2313`, `2359-2365`, `2386-2391`, and `event_loop/runner.rs:375-401`. Recorded at `rust-rewrite/DECISIONS.md:173` and `rust-rewrite/evidence/review-windows.md:715`.
- Observed (from the record, not run here): a tray menu opened by a deferred job inside a pump is open and answers sent messages, a posted Escape closes it, the process uses no CPU, and no `WM_TIMER` of the signal window arrives inside its loop: neither an application interval nor the pump's guard. This is a product defect: `set_timeout`, `set_interval` and the guard of D30 all stop. It is written down only inside a D20 entry about tests and in the first review's closing part. No checklist item, decision or `OWNER-ACTIONS.md` entry names it, and W1.8's evidence says "a native timeout fires" inside `TrackPopupMenu` without the condition under which it does.
- What the code rules out, by reading:
  - The signal window was alive: the deferred job that opened the menu arrived through it, and `set_timer` fails when it is gone.
  - A nested pump (G2): its orphaned timer would still produce timer signals in the trace.
  - `messages_waiting` and `dispatch_due_timers` by themselves: each look at the queue the product makes is followed by another look before the product waits, so they cannot make a wait blind without the menu's own loop.
- The mechanism proposed. It is a hypothesis: steps 1 and 2 are read in source, step 3 rests on how the OS's menu loop looks at the queue, which cannot be read here.
  1. Inside a pump `tao` keeps a paint request with no update region on its hidden target window: `RedrawWindow(.., RDW_INTERNALPAINT)` after `NewEvents` (`runner.rs:401`), after each user event (`event_loop.rs:2363`), and at the top of the procedure of every `tao` window for every message (`event_loop.rs:919-924`). The pump sends a user event first (`runtime.rs:225`), so the request is pending when the deferred job runs. The tray menu's owner is a `tao` window (`tray.rs:385`), so `SetForegroundWindow` (`popup.rs:61`) and each message the menu sends its owner renew the request. The plain Win32 program that never shows the defect has no such window. On the path from the pump to `TrackPopupMenu` this is the one difference between the two that the code shows.
  2. The OS serves a paint request before a timer. `tao`'s source records that a look with `PM_NOREMOVE` which gets such a request removes the window from the repaint queue (`event_loop.rs:2386-2391`).
  3. A menu's loop looks at the queue without removing and goes idle when nothing waits (the documented condition for `WM_ENTERIDLE`). The documented rule for a wait after a look is that `WaitMessage` "does not return if there is unread input in the message queue after the thread has called a function to check the queue". A timer that was already due at that look is not new input, and a timer that is due and not yet delivered does not come due again. So when every timer of the signal window is already due at the moment the menu's loop looks, the look returns `tao`'s paint request ahead of them and drops it, and the loop then waits for new input. Sent messages are answered inside the wait, a posted key is new input and closes the menu, no CPU is used, and no timer arrives. That is each observation in D20.
  4. Why only some menus: the timers are due at that look only when the time from `SetTimer` (the guard at `runtime.rs:226`, the test's interval) to the look is at least their periods (`PUMP_GUARD_MS` is 15, the watcher's interval is 10). Between the two lie the JavaScript `open_menu` callback, the menu's build, `SetForegroundWindow` and the menu's own start. When the look comes sooner, the timers come due afterwards, count as new input, and the menu works.
- A second thing the plain program lacks, to keep apart from the first when experimenting: `tray-icon` 0.27.0 sets its own 15 ms timer with a timer procedure on the icon's window while the pointer is over the icon, and that procedure calls `Shell_NotifyIconGetRect` on every tick (`src/platform_impl/windows/mod.rs:514`, `536-563`, `578-580`).
- The experiments that would confirm or refute it:
  1. Without any product code: the existing plain Win32 control, with two additions. A hidden top-level window owns the menu, and its procedure calls `RedrawWindow(hwnd, NULL, NULL, RDW_INTERNALPAINT)` on a second hidden window for every message it gets, as `tao` does. Between `SetTimer` and `TrackPopupMenu` the program pauses for longer than the timer's period without taking a message. Predicted: no `WM_TIMER` inside the menu. Remove either addition and the timers arrive.
  2. In the product, in the stuck state: post one `WM_NULL` to the signal window (class `SweetviewSignalWindow`) from another process. Predicted: the menu's loop wakes, looks again with no paint request pending, and the due timers arrive at once. If the timers still do not arrive, this mechanism is wrong.
  3. In the product: log, per menu, the time from the guard's `set_timer` to the `TrackPopupMenu` call in `show_popup`, and whether the menu stalled. Predicted: a stall only when that time is at least both periods. A deliberate pause before `TrackPopupMenu` longer than both periods should make every menu stall; reproducing with the pointer away from the icon rules the `tray-icon` timer out.
- What would settle it: the experiments run and their output recorded. If confirmed, nothing that must arrive inside a modal loop should ride on `WM_TIMER`: a timer thread (or a thread-pool timer) that posts through the existing `Waker` delivers timeouts, intervals and the guard as posted messages, which are always new input and are served before paint. Then a test that opens a tray menu from a deferred job after a pause longer than an interval's period and asserts that the interval fires inside the menu. Whatever the cause turns out to be, the defect belongs in a decision of its own and in `OWNER-ACTIONS.md` while it is open.

### G2. `must fix`. A nested pump leaks the outer pump's guard timer and leaves the outer pump unguarded; an unwind leaves the guard set

- Criterion: 6, "can this guard itself cause harm, in particular ... when pumps nest?"; the function's own contract at `crates/sweetview-runtime/src/runtime.rs:204-205`, "Called while the loop is already running (from a callback) it does nothing", repeated for the binding at `crates/sweetview-napi/src/event_loop.rs:22`.
- Where: `crates/sweetview-runtime/src/runtime.rs:225-240`, `334-336`, `374-378`; `crates/sweetview-platform-loop/src/windows.rs:571-590`; `crates/sweetview-platform-loop/src/loop_host.rs:63`.
- Observed, by reading; not run:
  1. Pump A sets `pump_guard` to `Some(G1)` (line 226) and runs `tao`.
  2. A callback inside it calls `pump()` again (`pumpEvents()` from JavaScript). Line 225 posts a user event. Line 226 sets a second timer G2 and overwrites the cell. `host.run` returns `AlreadyRunning`. Lines 237 to 239 take the cell and cancel G2. Line 240 returns `true`.
  3. G1 is still set in the OS and still in `SignalWindow.timers`, and nothing holds its id. It fires at every `PUMP_GUARD_MS` until the signal window is dropped. `on_signal` no longer recognises it (the cell is `None`), so it goes to `on_timer`, which finds no entry and returns. Pump A has no guard for the rest of its run, which is the state D30 exists to prevent. Each nested call adds one such timer: one USER object and one wake at every period for the life of the process, and `messages_waiting()` reports a waiting message whenever one is due.
  4. The unwind path: `tao` re-raises a handler's panic out of `run_return` (`event_loop.rs:266-268`). The binding now turns a panic into a JavaScript exception and the process goes on (D28), with lines 237 to 239 skipped. The guard stays set and keeps sending `tao` a user event at every period between pumps, and the next pump overwrites the cell as in step 2.
  5. Under `run_blocking` a nested `pump()` now posts a user event and sets and cancels a timer where it did nothing before.
- Why it fails: the documented no-op is no longer one, each nested call costs an OS timer that is never released, and the guard is lost exactly where it is needed.
- What would settle it: `pump` returns before line 225 when `self.host.is_running()`; the guard is held by a local value whose `Drop` cancels it, so every exit releases it, an unwind included. A test: a drain that calls `runtime.pump()` from inside a pump many times, then asserts that the signal window holds no timer the runtime does not know (or the handle counts through `assert_gives_back_every_handle`) and that the outer pump's guard still sends its event.

### G3. `should fix`. A posted `WM_NCDESTROY` disarms a live `MessageWindow`, and the SAFETY comment of `dispatch` says the message's parameters are the OS's own

- Criterion: "Each block has a `// SAFETY:` comment that names the invariant and says what guarantees it here"; the first review's F2, "A `MessageWindow` can be destroyed outside its `Drop`".
- Where: `crates/sweetview-platform-loop/src/windows.rs:139-151` (`Poster::post`), `337-343` (`answer`), `399-402` (`QueuedMessage::dispatch`).
- Observed: `answer` treats every `WM_NCDESTROY` as the window's destruction: it zeroes the post target, removes the table entry and hands the message to `DefWindowProcW`. `Poster::post(&self, message: u32, wparam: usize, lparam: isize)` is public and safe and posts any message number, so `poster.post(0x0082, 0, 0)` does it from safe code, and so does a post from another process of the session, the reach F2 named for `WM_CLOSE`. The window is still alive; its owner now refuses everything. For the runtime's signal window that means every wake fails, `set_timer` fails, `defer` queues jobs that never run (the result of the wake is not read, `runtime.rs:291`), and `Drop` skips `DestroyWindow`. No memory is at risk: zero is the safe direction. Read from the code; not run.
- The comment at 399 to 401 says of a dispatched message that "its window, parameters and any timer procedure are the OS's own". A message that `Poster::post` queued has parameters its caller chose, a `WM_TIMER` with a non-zero `lParam` included; that this is harmless rests on the OS validating a timer procedure, which the comment does not say.
- What would settle it: `Poster::post` refuses message numbers outside the application range (every caller in the tree posts `WM_APP` plus a constant: `windows.rs:533`, the notify crate's `WM_TOAST_EVENT` and `WM_NOTIFIER`), `answer` does not take a posted `WM_NCDESTROY` for the destruction (for example by confirming with `IsWindow` once the message has been handled), a test that posts `WM_NCDESTROY` and shows the owner still works, and the comment stating what is true.

### G4. `should fix`. The clipboard's lock borrows the open clipboard as shared, so two SAFETY comments rest on the callers

- Criterion: "The guarantee comes from types, not from callers being careful"; the first review's F4.
- Where: `crates/sweetview-platform-shell/src/clipboard.rs:74-78`, `90-97`, `111-132`, `143-153`.
- Observed: `Block::ClipboardText(&'a OpenedClipboard<'a>)` is a shared borrow, and `OpenedClipboard::empty(&self)` takes one too. Inside the module this compiles: lock the clipboard's text, call `open.empty()` (which frees the clipboard's block), then read `lock.bytes()`. Two locks of the same clipboard block can also exist at once, and `write` on one says "the exclusive borrow of `self` keeps any other view of the block from existing" (148 to 150). No code in the tree does either: `read_text` locks and reads, `write_text` writes only through `Block::Owned`. Nothing outside the module can reach it. The fix asked for by F4 was made as F4 worded it; this is what remains.
- What would settle it: `empty(&mut self)`, or the clipboard arm holding `&'a mut OpenedClipboard<'a>`; either makes the compiler refuse both sequences.

### G5. `should fix`. The parked icons add a send with no limit to windows of other processes on every `setIcon`

- Criterion: R4, "disciplined Rust where none does"; R1 (an adopted window is an application's own, and may belong to another thread or process).
- Where: `crates/sweetview-platform-window/src/windows.rs:534-542` (`icon_message`), `581-582`, `592-600` (`still_shown`), `604-615` (`sweep_parked_icons`), `617-634`.
- Observed: the fix for F4 parks icons a live window still shows and, at the start of every later `WindowIcons::set` of the thread, sends `WM_GETICON` to each parked window with `SendMessageW`. `BorrowedWindow::with_handle_value` lends any window `IsWindow` accepts, so a parked window can belong to another process. If that process stops answering, every later `setIcon` on any window blocks the UI thread until it answers. Before the range a send went only to the window whose icon was being set. Read from the code; not run. A smaller gap: a window whose own procedure answers `WM_GETICON` with something else reads as not showing the icons, and they are destroyed while it may still draw them.
- What would settle it: `SendMessageTimeoutW` with `SMTO_ABORTIFHUNG` for the query (an unanswered query keeps the icons parked), or the query made only for windows of this thread.

### G6. `should fix`. The answer to F9 says the teardown test asserts "USER and GDI growth of exactly 0"; it does not

- Criterion: 4, "An answer that claims more than the code does is a finding".
- Where: `rust-rewrite/evidence/review-windows.md:567`; `rust-rewrite/DECISIONS.md:162`; `crates/sweetview-platform-webview/tests/teardown.rs:150-157`.
- Observed: the test asserts `with_extras.user <= bare.user.max(0)` and the same for GDI: no more than the control run grew, with a floor of 0. Commit `b05229c` made it so, and D20's later entry (`DECISIONS.md:168`) says so. The answer to F9 and the earlier D20 entry at line 162 still say "exactly 0". The answer's "each back at their starting value" for `assert_gives_back_every_handle` is also wider in code: the helper takes the smaller growth of two loops and accepts a count below the start (`crates/sweetview-platform-loop/src/testing.rs:64-77`), as D20 explains.
- What would settle it: the two sentences corrected to what the tests assert.

### G7. `should fix`. W0.6 is ticked on a digest of a hosted run of an earlier commit, the answer to F38 says the item stays open, and D33 forbids making the proof again

- Criterion: 5; the checklist's preamble, "An item is ticked when its acceptance has been run and the output is pasted under it".
- Where: `rust-rewrite/CHECKLIST-windows.md:102-122`; `rust-rewrite/evidence/review-windows.md:694`; `rust-rewrite/DECISIONS.md:291-295`; `.github/workflows/windows.yml`.
- Observed: the block under W0.6 is a hand-made summary of run 46088815542 on `c744c56`, not output pasted from a command, and no file in the tree records the run. Since that run, `533d64e` changed the workflow file itself (its triggers), so the workflow as it is at HEAD has never run. The answer to F38 still reads "the item stays open until a hosted run of a pushed commit of the final tree is pasted under it". D33 then says no run is started, re-run or read. This review did not look at the run. A smaller point in the same paragraph: "a later step still runs when an earlier one failed" is true of the three steps after `cargo test`; `cargo test` itself has no `if: ${{ !cancelled() }}` and does not run after a failed build.
- What would settle it: the owner's written word under W0.6 that the run on `c744c56` stands as the item's proof, or the item unticked with D33 as the reason; and the answer to F38 changed to say which.

### G8. `should fix`. An existing test can now be skipped, and D20 does not record it

- Criterion: 3, "A weakening that D20 does not record ... is a finding"; R1, "An existing test keeps what it proves".
- Where: `packages/sweetview-native/src/binding.test.ts:16-19`, `76-84`.
- Observed: at `26a5474` "a binary for another platform fails with a message that names the file looked for" was a plain `test` on Windows that wrote a 16-byte stub. It is now `test.skipIf(!haveX86Pe)`, where `haveX86Pe` is true when `SysWOW64\kernel32.dll` exists under `SystemRoot`. What it asserts when it runs is stronger (a real i386 PE). On a Windows machine without that file the test no longer runs and shows as a skip. It ran in the recorded evidence (`w1-boundary.txt`).
- What would settle it: a D20 entry, or the stub kept as the fallback so the test always runs.

### G9. `should fix`. Three row runners of the upgrade guide report a pass without judging

- Criterion: 4 (the answers to F27 and F33); R2, "a test that imports the new form and runs it"; D20, "Tests that need the shared desktop in a given state no longer pass after returning early".
- Where: `rust-rewrite/compat/fixtures/row-runners.ts:643`, `666`, `672`; `rust-rewrite/compat/fixtures/rows-desktop.ts:286`; `rust-rewrite/compat/upgrade-guide.test.ts:333`.
- Observed: the runners of `Window#setHitRegions`, `Window#startDrag` and `Window#startResize` return the string "not judged: a mouse button was down on the shared desktop" when a button is down, and a returned string is recorded as `ok: <note>`. The row counts as run. This is the pattern D20 says was removed, in code written after that entry. In the recorded runs no button was down (helper).
- What would settle it: the three runners retry and then throw `not run: ...`, as `untilDesktopIsOurs` does for the tests.

### G10. `should fix`. A menu watcher's three-second `EndMenu` timeout outlives its test

- Criterion: 4, the closing part of the answers, "every watcher is now disarmed when its test ends"; D20's entry for `whenMenuOpens`.
- Where: `packages/sweetview-native/src/win32/tray-menu.test.ts:89-107` (line 100); `packages/sweetview-native/src/callbacks.test.ts:168`.
- Observed: when a watcher sees a menu it cancels its interval and calls `native.scheduleTimeout(3000, () => void (openPopupMenu() !== 0n && endMenu()))`. That timeout is not in `menuWatchers` and `afterEach` does not cancel it. A test that ends sooner than that after its menu opened leaves a timer that ends whichever menu is open when it fires, the next test's included. That is the same kind of leak commit `0118832` removed, and it can only fail a test, never pass one.
- What would settle it: the timeout's id kept with the watcher and cancelled in the same `cancel`.

### G11. `remark`. Tests named in the answers that prove less than the answer says

- F8, `a_panic_during_the_last_release_does_not_unwind` (`crates/sweetview-platform-webview/src/windows/istream.rs:214-221`): the panic it provokes is in the abandon callback, which `on_consumer_released` already caught before the range (`crates/sweetview-platform-webview/src/stream.rs:195`). The test passes with or without the new `catch_unwind` in `Drop`.
- F29, `a_subclass_whose_window_is_gone_leaves_a_later_window_alone` (`crates/sweetview-platform-window/src/windows_tests.rs:114-155`): the second half builds a `WindowSubclass` with `gone: true` by hand, so it asserts on a state the test set, and the `Rc::ptr_eq` branch of the drop is never run.
- F32, `toasts_end_their_subscriptions_when_dropped` (`crates/sweetview-platform-notify/src/windows.rs:1065-1077`): with a held toast, dropping `Toasts` releases the only toast object and with it the handlers, with or without `impl Drop for Toasts` (helper, inferred).
- F41, `the_apartment_is_entered_once_per_thread`: it asserts that the slot is filled after three calls, which entering on every call would also satisfy; `creating_and_dropping_environments_returns_every_handle` cannot see a COM count (helper).
- F31, `the_handlers_are_not_agile` checks three of the seven types; the other four are by reading (helper).
- F24: the test with a real `Tray` routes the click with `debugSimulateBalloonEvent`, so which icon carried the balloon is not read from the OS (helper).
- F17: the test's design tells the two cases apart; no run with the scope removed is recorded.

### G12. `remark`. Sentences that say more than the code or the file

- F30: "the extras' teardown ... remove the filters". `Drop for WebviewExtras` calls `controller.Close()` (`crates/sweetview-platform-webview/src/windows/mod.rs:380`) before it drops the filters (383), so each removal runs on a closed controller and does nothing. The failure path of `register` does remove them.
- F36 and D28: `on_load` (`crates/sweetview-platform-node/src/lib.rs:30-34`, `#[napi(module_exports)]`) carries no `catch_unwind`, and `napi` runs a class's finaliser without one (helper, read in `napi` 3.16.3).
- F41 and D27: "left when the thread ends after the thread's later-made values". Thread-local destructors run in reverse order of first use, so a value first used before the first `create_environment` is dropped after the apartment is left. In the product the runtime's own apartment (`Runtime::_com`) is entered earlier and left last, which is what keeps COM objects inside an apartment; the comment at `environment.rs:105-107` credits the wrong one (ordering inferred, not run).
- F10: the answer says two tests of `objects.rs` and "22 other runtime tests"; `rust-rewrite/evidence/w10-miri.txt:49` and `:57` show 3 passed and 24 filtered out. The checklist has the file's numbers.
- F7: the ledger group "The suggested rectangle of a DPI change" (`rust-rewrite/UNSAFE-LEDGER.md:180`) names no API looked for and no page.
- F26: the answer says 33 checks were added to `win-tabs.ts`; the count is 35 (helper).
- D29 and the comment at `runtime.rs:390`: "`tao` registers each of its windows for raw keyboard and mouse input". `tao` 0.38.0 registers once, with the event loop's own hidden window as the target (`event_loop.rs:200`); raw-input registration is per process. The effect described is the same.
- `rust-rewrite/HANDOFF-macos.md:318`, `390`, `433` name CI as where macOS binaries and the evidence for M8.4 come from; D33 came afterwards and the handoff was not brought in line.

### G13. `remark`. Small changes that no finding or decision explains

- `failure_reason` (`crates/sweetview-platform-webview/src/lib.rs:157-168`) now also excludes every `chrome:` address. The answer to F26 explains `edge:` only. No test covers `chrome:`, and the doc comment above the function (154 to 156) still says "not `about:` or `data:`".
- `packages/sweetview/src/app.test.ts`: the default of `pumpUntil` went from 2000 to 10000 for every caller, two tests besides the three D20 names; the watchdogs of the tabs fixtures were lengthened. None changes an assertion.
- `packages/sweetview-native/test/fixtures/win32-probe.ts:136-148`: `takeForeground` attaches this process's input to the foreground thread of another process (`AttachThreadInput`) while it takes the foreground. D20 mentions retries, not this (helper).
- The three merge commits `03eb06c`, `718f1a3` and `854a017` carry rises of the `unsafe` count without a count in their own message; each rise is explained in the branch commit that made it.

### G14. `remark`. Checklist blocks and evidence files that do not match line for line

- W1.3 and W7.1: the pasted blocks have a `0 skip` line; `w1-callbacks.txt:199-202` and `w7-native-tabs.txt:341-343` print no skip line. The statement is true.
- W7.1: `rust-rewrite/evidence/w7-native-tabs.txt:156` still reads "FAILS (a product defect, below)" for the `about:` check; line 291 of the same file shows it passing.
- W5.2 cites "win32 icons" in `w5-tray-menus.txt`; the group is in `w4-windows.txt:39-41`.
- W3.5, W4.7, W8.2: the text under the item quotes or states things that the cited file does not hold in that form (the page's log lines; two lines joined across a section; "with the binding embedded").
- No evidence file names the commit it was produced on. All were last changed in `c744c56`, which also changed `packages/sweetview/src/app.test.ts`; only the checklist, `DECISIONS.md` and the workflow's triggers changed afterwards.

## 4. Verdict

Does the tree at `533d64e` meet the criteria: **no**.

- Criterion 1 (`UNSAFE-POLICY.md`): every block added or changed holds one operation, has its SAFETY comment and sits in a platform crate. Two guarantees are stated more strongly than the types make them (G3, G4). Nothing was found that a caller outside its module can reach unsoundly.
- Criterion 2 (R1, R3, R4, R6): no capability was found removed, the three of F14 are back, the `ffi` and `privacy` checks pass and the reading agrees with them. R1 is not met while G1 is open.
- Criterion 3 (tests): one weakening is not recorded (G8) and one new fixture passes without judging (G9). Every other change to a test is recorded in D20 with a reason that holds, or asserts more.
- Criterion 4 (the answers): 22 answers hold, 3 are answered without a change as they say (F25, F37, F39), 14 hold in part, and 2 do not hold in a sentence (F9, F38).
- Criterion 5 (the checklist): no item's text changed. W0.6 rests on a run that is not of this tree and cannot be made again (G7); W5.5 waits for the owner as before; the rest hold, some with a mismatch between the block and its file (G14).
- Criterion 6: the device-event filter is correct. The pump's guard has two defects of its own (G2), and the open defect it does not cover has a hypothesis and three experiments (G1).

What stands between this tree and yes: G1 and G2. G3 to G10 are each a small change or a corrected sentence.

## 5. Not checked

- Nothing was run except `git` read commands and `bun rust-rewrite/verify.ts windows --quick`. No test, demo, `cargo` command, Miri run or script that opens a window or sends input was started: other sessions share this machine's desktop. Every statement about behaviour is from reading.
- The hosted run cited under W0.6 was not read, and no workflow was started.
- G1's mechanism was not run; its third step rests on the menu loop of the OS, which is not readable here. G2, G3, G4 and G5 are read from the code and not run.
- Read by helpers and not again by the lead: the notify crate's `unsafe` blocks and tests, the tab frame's blocks, the webview crate's blocks, the bodies of the TypeScript tests named under F14 to F24, the 27-bullet table of `w7-native-tabs.txt`, and the evidence files of W1 to W9 line by line. Their verdicts are marked "(helper)" where a finding or a table row depends on them.
- Not read by anyone: the unchanged parts of `crates/sweetview-runtime/src/window.rs`, `window/tab_frame.rs` and the notify crate's `Notifier`; `rows-page.ts`, `rows-worker.ts`, `rows-second-instance.ts`, `own-ffi.ts` and most of `rows-desktop.ts` under `rust-rewrite/compat/fixtures/`; `tray-real-click.ps1` and `toast-real-click.ps1`; the WT items, whose text and evidence did not change in the range.
- Files that no longer exist in the tree (two evidence files removed in the range among them) were not read from history.
- The intermediate states of the range: the two ends were compared, and single commits only where a finding needed one.
- Anything on macOS, the bindings repository and the C++ fork.

## Answers

### G2

**Fixed.** `Runtime::pump` (`crates/sweetview-runtime/src/runtime.rs`) returns `true` at once when either loop mode is running, before it posts anything or sets a timer, which is what its doc comment and `pumpEvents`'s say; so a nested call costs nothing, under `run_blocking` too. The guard is a `PumpGuard`, a value set when the pump starts whose `Drop` cancels the timer and empties `pump_guard`, so every way out of the pump releases it, the unwind `tao` raises again for a handler's panic included. The test `a_nested_pump_does_nothing_and_every_way_out_of_a_pump_cancels_its_guard` calls `pump()` 100 times from a drain inside a pump and asserts that the outer pump's guard is the same timer afterwards, that only that one timer is set inside (`SignalWindow::timers_set_for_tests`), that the guard still gives `tao` its event while the outer pump runs, and that no timer is left set afterwards; then a listener panics inside a pump, the panic comes out of `pump`, no timer is left set, and the loop pumps again. Decision D39.

### G3

**Fixed.** In `crates/sweetview-platform-loop/src/windows.rs`: `Poster::post` posts only `WM_APP` to `0xBFFE` and returns false for any other number; a `WM_NCDESTROY` sent from another thread (`InSendMessageEx` reports `ISMEX_SEND`) is answered and changes nothing; a `WM_NCDESTROY` of the window's own thread marks the post target `ending`, holds posts instead of sending them, and posts the window its own confirmation (`WM_STILL_ALIVE`). The window's next message arms it again and sends what was held; a window that `DestroyWindow` destroyed took the confirmation with it, and a poster that finds `IsWindow` false while `ending` disarms the target. `IsWindow` inside the procedure cannot tell the two apart, which was measured: it reads true during a real `WM_NCDESTROY`, before and after `DefWindowProcW`, as during a posted one. The SAFETY comment of `QueuedMessage::dispatch` now says the parameters are the poster's and that the OS calls a `WM_TIMER`'s procedure only when this thread registered it, measured (a posted `WM_TIMER` naming an unregistered function: 0 calls; registered with `SetTimer`: called; after `KillTimer`: 0). Tests: `a_posted_ncdestroy_leaves_the_window_and_its_owner_working`, `an_unconfirmed_ncdestroy_still_lets_drop_destroy_and_a_sent_one_is_refused`, and `a_window_destroyed_by_other_code_disarms_its_owner` with an assertion that no confirmation is left queued after a real destruction. `a_posted_close_leaves_the_window_and_its_owner_coherent` now posts its `WM_CLOSE` with `PostMessageW` from the other thread, since the `Poster` refuses it (D20). Decision D38.

### G4

**Fixed.** `crates/sweetview-platform-shell/src/clipboard.rs`: `Block::ClipboardText` holds `&'a mut OpenedClipboard<'o>` and `OpenedClipboard::empty` takes `&mut self`, so the compiler refuses `empty` while the clipboard's block is locked, and a second lock of that block; `Block` and `LockedGlobal` carry a second lifetime for the clipboard's owner window. The SAFETY comments of the clipboard arm and of `write` now rest on that exclusive borrow. No test can show a refused compilation inside a private module; `read_text` and `write_text` do what they did, and the clipboard tests cover them.

### G5

**Fixed.** `WindowIcons::still_shown` (`crates/sweetview-platform-window/src/windows.rs`) asks a parked window with `SendMessageTimeoutW` (`SMTO_ABORTIFHUNG | SMTO_BLOCK`, 100 ms); a window that does not answer keeps its icons parked. Test: `a_parked_window_that_does_not_answer_keeps_its_icons_and_holds_up_nothing` (`windows_tests.rs`) parks icons on a window of another thread, stops that thread for 1.5 s, and asserts that the next `WindowIcons::set` returns within 1 s with the icons still parked, and that they go once the window is gone. The smaller gap (a window whose procedure answers `WM_GETICON` with another icon) is left as it is, with its reason, in decision D40.

### G6

**Fixed.** The answer to F9 (`rust-rewrite/evidence/review-windows.md`) and D20's teardown entry now say what the tests assert: `teardown.rs` requires USER and GDI growth no larger than the same loop without the extras grew, with a floor of 0, and compares kernel handles with that loop too; `assert_gives_back_every_handle` requires no growth over the smaller of two measured loops, a count below its start passing. No test changed.

### G7

**Answered, with the text corrected.** The block under W0.6 (`rust-rewrite/CHECKLIST-windows.md`) now says that it is a summary written by hand from run 46088815542 on `c744c56`, not pasted output; that only the three steps after `cargo test` run after a failure; and that the workflow file changed afterwards in its triggers and comments only (`533d64e`). The answer to F38 says what happened after it. No run was started, re-run or read (D33). What stays for the owner, recorded in `rust-rewrite/OWNER-ACTIONS.md` section 8: whether the run on `c744c56` stands as the item's proof, or the item is unticked with D33 as its reason. The item's text and its box are unchanged. The same question for the macOS goal's M8.4 is noted in `rust-rewrite/HANDOFF-macos.md`.

### G8

**Fixed.** Both tests of a binary for another platform in `packages/sweetview-native/src/binding.test.ts` are plain tests again: they use WOW64's i386 `kernel32.dll` where it exists and the 16-byte ELF stub of `26a5474` otherwise (`otherPlatformBinary`), so they always run. Recorded in D20.

### G9

**Fixed.** The runners of `Window#setHitRegions`, `Window#startDrag` and `Window#startResize` (`rust-rewrite/compat/fixtures/row-runners.ts`) wait for every mouse button to be up with `untilDesktopIsOurs` and otherwise throw `not run: ...`, which records the row as an error. Recorded in D20.

### G10

**Fixed.** `whenMenuOpens` in `packages/sweetview-native/src/win32/tray-menu.test.ts` and `packages/sweetview-native/src/callbacks.test.ts` keeps its 3 s closer with the watcher: the watcher's cancel (run by `afterEach`, and returned to `chooseFirstTrayItem` in `callbacks.test.ts`) cancels the closer too. Recorded in D20.

### G11

**Answered, one test extended.** `the_handlers_are_not_agile` (`crates/sweetview-platform-webview/src/windows/handlers.rs`) now checks all seven handler types by name (F31). For the others, the answers in `rust-rewrite/evidence/review-windows.md` now say what the named test does not tell apart, as this review found: F8 (the release test passes without the `Drop`'s `catch_unwind`), F17 (no run with the scope removed), F24 (the icon that carries the balloon is not read from the OS), F29 (the second half asserts a state the test set), F32 (the `Toasts` test passes without its `Drop`, by reading) and F41 ("once" rests on reading). A test that tells each of these apart needs product surface or a second build of the binding; none was added.

### G12

**Fixed where code could carry it, the rest corrected.** `on_load` (`crates/sweetview-platform-node/src/lib.rs`) runs its body inside `std::panic::catch_unwind` and fails the load with an error; a class's finaliser, which `napi` runs without one, is recorded in D28 and in the answer to F36. Corrected sentences: F30 (at teardown the controller is closed before the filters are dropped, so their removal does nothing there), F41 and D27 (thread-local values go in reverse order of first use; the runtime's own apartment is what outlives the UI thread's COM objects, and the comment in `environment.rs` now says so), F10 (3 passed in the `sweetview-napi` run, 24 runtime tests left out), F7 (the ledger group "The suggested rectangle of a DPI change" names `WindowEvent::ScaleFactorChanged` and `WM_DPICHANGED` with their docs.rs pages), F26 (35 checks), D29 and the comment in `build_event_loop` (`tao` registers the process once, with its hidden window as the target), and `rust-rewrite/HANDOFF-macos.md` (no hosted CI as a source of binaries; M8.4's evidence is the owner's question since D33).

### G13

**Fixed and recorded.** `failure_reason` (`crates/sweetview-platform-webview/src/lib.rs`): the doc comment names the `edge:` and `chrome:` exclusions, and `navigation_failure_rules` asserts that `chrome:` (in either case) is not reported while an address that only begins with those letters is. D20 now records the raised default of `pumpUntil` for every caller with the tabs fixtures' longer watchdogs, and `takeForeground`'s `AttachThreadInput`. The three merge commits' rises of the `unsafe` count are history: pushed commits are not rewritten, and each rise is explained in the branch commit that made it, as the review found.

### G14

**Fixed.** The blocks under W1.3, W4.7 and W7.1 (`rust-rewrite/CHECKLIST-windows.md`) now hold their files' lines as printed, with no `0 skip` line and no lines joined across a section; W5.2 cites `rust-rewrite/evidence/w4-windows.txt` for "win32 icons"; W3.5 says the page's log lines are asserted by the test and are not in the evidence file; W8.2 names where the embedded binding (`w1-compiled-alone.txt`) and the demo without a compile recipe (the root `README.md`) are shown. `rust-rewrite/evidence/w7-native-tabs.txt` no longer calls the passing `about:` check FAILS. The evidence files were not produced again, so none names its commit in its text; `git log -1 -- <file>` gives it (`c744c56` for each before this work).
