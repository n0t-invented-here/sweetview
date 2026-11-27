# Review of the Windows goal (checklist item W10.2)

## 1. What was reviewed

The tree at commit `26a5474` of branch `v1-rust-rewrite`; the change set is `pre-rust-rewrite..26a5474` (110 commits). At the start `git rev-parse --short HEAD` printed `26a5474` and `git status --short` showed no modified tracked file. The reviewer wrote none of the code and none of the evidence. This file is the only file the review wrote.

Criteria, by file:

- `rust-rewrite/UNSAFE-POLICY.md`, every rule: the order of preference, where `unsafe` may appear, the rules inside a platform crate, the tests section, the ledger.
- `rust-rewrite/CHECKLIST-windows.md`: for each item, the item's own text; its preamble for what counts as evidence.
- `rust-rewrite/REQUIREMENTS.md`, R1 to R9, where an item's evidence leans on them.
- The owner's purpose in `rust-rewrite/GOAL-windows.md` (PURPOSE, SCOPE and METHOD paragraphs), and `rust-rewrite/DECISIONS.md` D20 for the tests the work says it corrected.

How the reading was divided. A lead reviewer read the criteria, the checklist, the decisions, the ledger and `crates/sweetview-platform-loop/src/windows.rs` in full, and gave ten helper reviewers one bounded part each: four read every use of `unsafe` (the webview crate; the window crate; the loop, input and export-table crates; the shell and notify crates), five read the checklist items against their evidence (W0 and W1; W2 and W3; W4 and W5; W6, W7, W8 and WT; W9 and W10 with requirement R6), and one read the baseline test list, D20 and the tree for weakened tests and for stubbed or dropped functionality. No helper was told what to expect. The helpers returned 148 findings. Every finding published below as `must fix` was opened in the code or the evidence by the lead and confirmed. Six helper findings were rejected or lowered:

- "W4.3 `transparent` has no check" (reported as must fix): lowered to a remark. The test "W2.3 alpha 0 shows the window behind a transparent window on the screen" creates a `transparent: true` window and reads the pixels behind it; W4.3 does not cite it.
- "W1.5: the helpers `docs/` calls any-thread have no Worker test" (must fix): lowered to a remark. The functions named (menu templates, hit-region geometry, icon encoders, file helpers, the settings store) are pure TypeScript and make no call into the binding.
- "W2.8: the profile-folder cleanup of `packages/sweetview/src/request-handler.test.ts` was loosened" (must fix): rejected. D20 lists it with its reason and no assertion about a page changed.
- "W4.6: `Screen.cursor` is checked for type only" (must fix): lowered to should fix (F34). The hit-region poll test drives the same runtime function with the real cursor.
- "W1.3: the hook messages are not today's messages" (must fix): lowered to a remark (F40). The tag holds no hook code in this repository (0 hits for the message text), and the comparison is with another repository the lead did not read.
- "Ledger groups give no docs.rs page" (must fix by the letter): kept as a part of F7 at should-fix weight, because each underlying claim was checked true in the pinned crate sources.

Several helper findings on the same subject were merged (the handle-count tests were reported by five helpers and are one finding, F9; evidence from an earlier tree was reported by five helpers and is F15).

What was run at `26a5474`:

| Command | Result |
|---|---|
| `bun rust-rewrite/verify.ts windows --quick` | `PASS` blocked, ffi (28 files, 28 allowlisted, 0 setup), engine, unsafe (217 uses in 20 files), api-surface, upgrade-guide, dependents (no list on this machine), privacy; `FAIL checklist` (63 ticked, 2 open: W0.6 W10.2; ticked without evidence: W10.4); `FAIL git` (2 unpushed commits); cargo, tests, demos skipped by `--quick` |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `git diff --stat pre-rust-rewrite..26a5474 -- rust-rewrite/verify.ts rust-rewrite/REQUIREMENTS.md rust-rewrite/UNSAFE-POLICY.md` | empty |
| `git diff pre-rust-rewrite..26a5474 -- rust-rewrite/CHECKLIST-windows.md`, item lines compared | 65 items at the tag and now; the 63 ticked item texts are identical to their unticked texts; no item removed |
| `bun rust-rewrite/checks/cargo-sources.ts` | 311 packages, 299 from crates.io, 0 git dependencies, 0 path packages outside the repository |
| the count of `unsafe` uses at each non-merge commit against its parent | 17 commits raise the count; two do not explain the rise (F12) |
| `cargo test -p sweetview-http`, `-p sweetview-keycodes`, `-p sweetview-window-logic` | 15, 23 and 29 passed |
| `cargo test -p sweetview-platform-webview --test requests`; `-p sweetview-platform-input --test windows_hooks`; `-p sweetview-platform-window tab_frame` | 1, 13 and 8 passed |
| `bun test` (whole suite, once, on a fresh WebView2 profile) | 405 pass, 15 skip, 0 fail; 420 tests in 45 files |
| `bun test` of single files: `webview.test.ts`; `input-hooks.test.ts`; the seven files of W1.3; both `activation.test.ts`; the two transport packages; `packages/sweetview-build`; `rust-rewrite/compat` | 23 pass; 7 pass; 101 pass; 7 pass; 19 pass; 11 pass and 2 skip; 20 pass |

No tracked file changed as a result of any run.

## 2. Coverage

### Files with `unsafe` (217 uses in 20 files; every use read in its context)

| File | Uses | Read | Findings |
|---|---|---|---|
| `crates/sweetview-platform-input/src/windows.rs` | 8 | yes | F11 |
| `crates/sweetview-platform-input/tests/windows_hooks.rs` | 7 | yes | F9 |
| `crates/sweetview-platform-loop/src/com.rs` | 4 | yes | none |
| `crates/sweetview-platform-loop/src/windows.rs` | 18 | yes | F1, F2, F8, F9, F32 |
| `crates/sweetview-platform-notify/src/windows.rs` | 9 | yes | F3, F8, F9, F11, F32 |
| `crates/sweetview-platform-shell/src/clipboard.rs` | 12 | yes | F4, F9 |
| `crates/sweetview-platform-shell/src/icons.rs` | 1 | yes | none |
| `crates/sweetview-platform-shell/src/single_instance.rs` | 10 | yes | F9 |
| `crates/sweetview-platform-shell/src/win.rs` | 1 | yes | F32 |
| `crates/sweetview-platform-webview/src/windows/environment.rs` | 1 | yes | F8 |
| `crates/sweetview-platform-webview/src/windows/handlers.rs` | 12 | yes | F8, F31 |
| `crates/sweetview-platform-webview/src/windows/istream.rs` | 11 | yes | F8 |
| `crates/sweetview-platform-webview/src/windows/mod.rs` | 43 | yes | F6, F30 |
| `crates/sweetview-platform-window/src/metrics.rs` | 1 | yes | F6, F7 |
| `crates/sweetview-platform-window/src/popup.rs` | 4 | yes | F3 |
| `crates/sweetview-platform-window/src/size_hint.rs` | 1 | yes | none |
| `crates/sweetview-platform-window/src/tab_frame.rs` | 16 | yes | none |
| `crates/sweetview-platform-window/src/tab_frame_tests.rs` | 12 | yes | F9 |
| `crates/sweetview-platform-window/src/windows.rs` | 37 | yes | F3, F4, F7, F29 |
| `crates/sweetview-platform-window/src/windows_tests.rs` | 9 | yes | F9 |

Read and found nothing, across all six platform crates: no `unsafe fn`, no `unsafe impl`, no `unsafe extern`, no `transmute`, no `static mut`, no `mem::zeroed`, no hand-written struct layout or byte array standing for a struct; every block holds one operation and carries a `// SAFETY:` comment; all four lints are set at every platform crate root and no `#[allow]` of them exists; `#![forbid(unsafe_code)]` is at the root of `sweetview-http`, `sweetview-keycodes`, `sweetview-napi`, `sweetview-runtime` and `sweetview-window-logic`; no `unsafe fn`, raw pointer or raw handle type appears in a public signature of a platform crate (a window handle enters and leaves `sweetview-platform-window` as an `isize`, which R1 requires for `Window.handle` and `Window.fromHandle`); `sweetview-platform-node` holds no hand-written `unsafe`. The per-file counts of the ledger table equal the counts `verify.ts` prints, and the group counts under `## Reasons` add up to each file's count.

### Checklist items (65)

| Item | State | Evidence checked | Verdict | Findings |
|---|---|---|---|---|
| W0.1 | ticked | yes | proven | |
| W0.2 | ticked | yes | not proven | F16 |
| W0.3 | ticked | yes | proven with a remark | F5, F37 |
| W0.4 | ticked | yes | proven with a remark | F15 |
| W0.5 | ticked | yes | proven with a remark | F40 |
| W0.6 | open | yes | open | F38 |
| W1.1 | ticked | yes | proven with a remark | F34 |
| W1.2 | ticked | yes | not proven | F17 |
| W1.3 | ticked | yes | not proven | F18, F15, F40 |
| W1.4 | ticked | yes | not proven | F18 |
| W1.5 | ticked | yes | proven with a remark | F40 |
| W1.6 | ticked | yes | proven with a remark | F40 |
| W1.7 | ticked | yes | proven | |
| W1.8 | ticked | yes | proven with a remark | F34 |
| W2.1 | ticked | yes | proven with a remark | F15, F40 |
| W2.2 | ticked | yes | proven with a remark | F15, F39 |
| W2.3 | ticked | yes | proven with a remark | F15 |
| W2.4 | ticked | yes | proven with a remark | F15, F39 |
| W2.5 | ticked | yes | proven with a remark | F15, F39 |
| W2.6 | ticked | yes | proven with a remark | F15, F40 |
| W2.7 | ticked | yes | proven with a remark | F15, F34 |
| W2.8 | ticked | yes | proven | |
| W2.9 | ticked | yes | proven with a remark | F15, F39 |
| W3.1 | ticked | yes | not proven | F19 |
| W3.2 | ticked | yes | not proven | F19 |
| W3.3 | ticked | yes | proven with a remark | F39 |
| W3.4 | ticked | yes | proven with a remark | F39 |
| W3.5 | ticked | yes | proven with a remark | F34 |
| W3.6 | ticked | yes | proven | |
| W4.1 | ticked | yes | proven | |
| W4.2 | ticked | yes | not proven | F20, F15 |
| W4.2a | ticked | yes | proven with a remark | F40 |
| W4.3 | ticked | yes | not proven | F21 |
| W4.4 | ticked | yes | proven with a remark | F33, F40 |
| W4.5 | ticked | yes | proven with a remark | F16, F33 |
| W4.6 | ticked | yes | proven with a remark | F34, F15 |
| W4.7 | ticked | yes | proven with a remark | F16 |
| W4.8 | ticked | yes | not proven | F22 |
| W5.1 | ticked | yes | not proven | F23 |
| W5.2 | ticked | yes | proven with a remark | F15, F14 |
| W5.3 | ticked | yes | not proven | F24 |
| W5.4 | ticked | yes | proven with a remark | F15 |
| W5.5 | ticked | yes | not proven | F25 |
| W6.1 | ticked | yes | proven with a remark | F15 |
| W6.2 | ticked | yes | not proven | F15, F34 |
| W6.3 | ticked | yes | proven | |
| W7.1 | ticked | yes | not proven | F26, F15, F33 |
| W7.2 | ticked | yes | not proven | F15 |
| W8.1 | ticked | yes | not proven | F15, F13 |
| W8.2 | ticked | yes | proven | |
| W8.3 | ticked | yes | proven with a remark | F34 |
| WT.1 | ticked | yes | proven with a remark | F40 |
| WT.2 | ticked | yes | proven | |
| WT.3 | ticked | yes | proven | |
| WT.4 | ticked | yes | proven | |
| WT.5 | ticked | yes | proven | |
| WT.6 | ticked | yes | proven | |
| W9.1 | ticked | yes | proven with a remark | F15, F16 |
| W9.2 | ticked | yes | proven | |
| W9.3 | ticked | yes | not proven | F27, F14 |
| W9.4 | ticked | yes | proven with a remark | F41 |
| W10.1 | ticked | yes | not proven | F7, F9, F10 |
| W10.2 | open | this file | open | |
| W10.3 | ticked | yes | proven with a remark | F40 |
| W10.4 | ticked | yes | not proven | F28 |

"Proven with a remark" where the only finding is F15 means: the pasted evidence was recorded on an earlier tree, and the same tests were re-run at `26a5474` by this review and pass.

## 3. Findings

Most severe first. F1 to F12 measure the code against `UNSAFE-POLICY.md`; F13 to F28 measure the checklist and the requirements; F29 to F36 are `should fix`; F37 to F41 are remarks.

### F1. `must fix`. A queued message can be dispatched twice from safe code

- Criterion: "The guarantee comes from types, not from callers being careful."
- Where: `crates/sweetview-platform-loop/src/windows.rs:241` and `256-260`; exported at `crates/sweetview-platform-loop/src/lib.rs:36`.
- Observed: `pub fn dispatch(&self)` runs `unsafe { DispatchMessageW(&self.0) }` under the comment "`self.0` was filled by the OS from this thread's queue (see the type), so its window, parameters and any timer procedure are the OS's own." `next_message()` and `wait_message()` are public and safe, and `dispatch` borrows the message, so `let m = next_message()?; m.dispatch(); m.dispatch();` compiles in any crate.
- Why it fails: a message can carry ownership. `tao` 0.38.0 posts its cross-thread call with a boxed closure in `wParam` and its window procedure takes the box back on dispatch (`src/platform_impl/windows/event_loop.rs:2366-2367`: `_ if msg == *EXEC_MSG_ID => { let mut function: ThreadExecFn = Box::from_raw(wparam.0 as *mut _);`). Dispatching that message twice frees the box twice, from safe code. The four callers in the tree each dispatch once; nothing in the type makes them.
- What would settle it: `dispatch` and `translate` on a value that `dispatch` consumes (`fn dispatch(self)`), so the type allows one dispatch per message.

### F2. `must fix`. A `MessageWindow` can be destroyed outside its `Drop`, which its SAFETY comments and the ledger say cannot happen

- Criterion: "Each block has a `// SAFETY:` comment that names the invariant and says what guarantees it here", and "Each OS resource has an owning type whose `Drop` releases it".
- Where: `crates/sweetview-platform-loop/src/windows.rs:91-103` (`Poster::post`), `192-195`, `218-232` (`message_window_proc`), `394-399`; `rust-rewrite/UNSAFE-LEDGER.md:38`.
- Observed: `Poster::post(&self, message: u32, wparam: usize, lparam: isize)` posts any message number from any thread. The window procedure hands every message its closure answers `None` to `DefWindowProcW`; the signal window's closure answers `None` for everything but the wake and `WM_TIMER`, and the clipboard owner's closure is `|_, _, _| None`. `DefWindowProcW` destroys the window on `WM_CLOSE`. So `poster.post(0x0010, 0, 0)`, or a post of `WM_CLOSE` from another process of the same session and integrity level, destroys the window while its `MessageWindow` lives. This is read from the code and from the documented behaviour of `DefWindowProcW`; it was not run. Nothing handles `WM_NCDESTROY`: the post target stays non-zero, the `PROCEDURES` entry stays, `HasWindowHandle` lends the dead handle under the comment "`self.hwnd` was made by `new` and is destroyed only in this value's `Drop`", and `Drop`, `SetTimer` and `KillTimer` later act on a handle value the OS may have given to another window.
- Why it fails: the stated guarantee is false, and the ledger's "Contained by `MessageWindow`: it owns the window ... destroys it in `Drop`" with it.
- What would settle it: the window procedure answers `WM_CLOSE` itself instead of forwarding it, and clears the post target and the table entry on `WM_NCDESTROY`.

### F3. `must fix`. Bare window handles stored in structs that do not own them, and two SAFETY comments that claim what the type does not guarantee

- Criterion: "No bare `HWND`, `HHOOK`, `HICON` or pointer is stored in a struct that does not own it, except as a borrowed type with a lifetime." and the SAFETY rule quoted in F2.
- Where and observed:
  - `crates/sweetview-platform-window/src/windows.rs:65-69`: `#[derive(Debug, Clone)] pub struct ForeignWindow { hwnd: HWND, _not_send: PhantomData<*const ()> }`, documented "It does not own the window: whoever made it destroys it." The runtime keeps one for the whole life of every window, owned or adopted (`crates/sweetview-runtime/src/window.rs:180-185`).
  - `windows.rs:103-107`, the `borrow_raw` comment: "`ForeignWindow` is not `Send`, so the borrower is on this thread, where the window can be destroyed only by code this thread runs." `ForeignWindow::from_handle_value` (`windows.rs:81-87`) accepts any value `IsWindow` accepts, a window of another thread or another process included, and `crates/sweetview-runtime/src/dialogs.rs:18` and `crates/sweetview-runtime/src/menu.rs:196` build one from an application's number with no thread check. Not being `Send` says where the value lives, not which thread owns the window.
  - `crates/sweetview-platform-window/src/popup.rs:51-54` repeats the claim: "`owner` was checked with IsWindow when it was made, and is not `Send`, so it is on this thread".
  - The same rule in its letter: `WindowSubclass { hwnd: HWND, .. }` (`windows.rs:604-607`) owns a subclass registration and not the window (see F29), and `BalloonIcon { handle: HICON, owned: bool }` (`crates/sweetview-platform-notify/src/windows.rs:132-135`) stores the stock icon with `owned: false`.
- Why it fails: the rule has one exception, a borrowed type with a lifetime, and `ForeignWindow` has none. The window calls made through it are memory safe because user32 validates a handle; they are not identity safe: after the window dies, a call acts on whichever window now has the value. The two comments state a guarantee that does not hold for windows of other threads.
- What would settle it: the handle value kept as a number by the runtime and turned into a borrowed, lifetime-carrying window for each call, with the two comments stating what is true (the OS validates the handle on each call); or the owner's written acceptance of `ForeignWindow` as it is, since `UNSAFE-POLICY.md` cannot be changed by the work and R1 requires adopted windows.

### F4. `must fix`. Three guarantees rest on the caller, and one caller breaks one of them

- Criterion: "The guarantee comes from types, not from callers being careful."
- Where and observed:
  - `crates/sweetview-platform-window/src/windows.rs:510-523`, `WindowIcons::set`: "Keep the result until the next call: dropping it destroys the icons the window draws." The value holds no window and no lifetime. `crates/sweetview-runtime/src/window.rs:357-358` drops it in `Core::destroy` ("The icons outlive the window that drew them."), and `release_if_unused` (`window.rs:366-375`) runs `destroy` for an adopted window that nobody holds any more. An application's own window given an icon through `Window.fromHandle(h).setIcon(...)` and then released is still alive and still showing two icons that have been destroyed. Read from the code; not run.
  - `crates/sweetview-platform-shell/src/clipboard.rs:91-111`, `LockedGlobal<'a>`: `fn lock(memory: HGLOBAL)` takes the handle by value, so `'a` is tied to nothing; the comment says "`memory` is a movable global block that the caller's owner keeps allocated for `'a`". The slice at line 118 and the copy at line 130 are sound only because both callers declare the owner before the lock.
  - `crates/sweetview-platform-window/src/windows.rs:412-420`, `destroy_now`: a public safe function whose comment ends "the caller drops the `tao` window next, so nothing uses the handle afterwards."
- Why it fails: each comment names the caller as the guarantee, which is what the rule excludes; the first is broken by a path in the tree.
- What would settle it: `WindowIcons` kept by the code that knows the window is gone (not dropped for an adopted window that is merely released), `LockedGlobal::lock` taking `&'a OwnedGlobal` or `&'a OpenedClipboard`, and `destroy_now` taking the `tao` window by value.

### F5. `must fix`. Logic lives in a platform crate

- Criterion: "The N-API surface, the registries, the callback plumbing, the hit-region logic, the menu data, header validation and every other piece of logic live outside the platform crates and compile with `unsafe` forbidden."
- Where: `crates/sweetview-platform-node/src/menus.rs:48-69` and `crates/sweetview-platform-node/src/types.rs:109-130`.
- Observed: `fn menu_data` recurses over the menu, matches on the `kind` string, chooses defaults (`enabled.unwrap_or(true)`, `id.unwrap_or(0)`) and drops an item of unknown kind (`_ => None`). `impl From<WindowInit>` rounds and clamps sizes (`v.round().max(0.0) as i32`) and turns an unknown appearance into the default (`Appearance::parse(&o.appearance).unwrap_or_default()`). The crate's `README.md` says "Nothing is decided here", and `menus.rs:3-5` says the object shapes "live here because their derive expands to `unsafe` conversion code". D12 says the opposite ("`#[napi(object)]` structs compile under `#![forbid(unsafe_code)]`"), and `crates/sweetview-napi/src/engine.rs:28` and `:41` are two such structs under `forbid`.
- Why it fails: the menu data is named by the rule, and both functions decide things.
- What would settle it: the two conversions and their object shapes in `sweetview-napi`.

### F6. `must fix`. Two behaviours use `unsafe` where a preferred crate has a safe API

- Criterion: "For each behaviour, take the first that provides it: 1. A safe API of `tao`, `wry`, `muda`, `tray-icon` or `rfd`. 2. ... a safe wrapper type of the `windows` crate."
- Where and observed:
  - `crates/sweetview-platform-webview/src/windows/mod.rs:264-275` calls `ICoreWebView2Controller2::SetDefaultBackgroundColor` in an `unsafe` block. `wry` 0.58.2 has the safe `pub fn set_background_color(&self, background_color: RGBA) -> Result<()>` (`src/lib.rs:2247`), which makes the same call (`src/webview2/mod.rs:2030-2049`). The ledger's reason is "its `set_background_color` turns any non-zero alpha into 255 ... where this crate refuses it". For alpha 0 and 255 the two do the same thing; the refusal of any other alpha is a comparison that needs no `unsafe`, and the caller (`crates/sweetview-runtime/src/engine.rs:513-514`) is in the crate that owns the `wry::WebView`.
  - `crates/sweetview-platform-window/src/metrics.rs:15-23` calls `GetDoubleClickTime` in an `unsafe` block; the ledger says "no crate reads it." `windows` 0.62.2 has the safe WinRT method `UISettings::DoubleClickTime(&self) -> Result<u32>` (`src/Windows/UI/ViewManagement/mod.rs:1935`); the crate already enables `UI_ViewManagement` and already makes a `UISettings`. That the two return the same number was not measured.
- Why it fails: rule 1 serves the first and rule 2 the second.
- What would settle it: both calls made through the safe API (2 uses fewer), or a ledger entry that shows by a run why the safe API gives a different result.

### F7. `must fix`. Four ledger claims are wrong

- Criterion: "Record the choice ... in `rust-rewrite/UNSAFE-LEDGER.md`: the behaviour, the crate API that was looked for and its docs.rs page, and why it does not serve."
- Where and observed, each checked against the pinned crate source:
  - Line 138: "`tao` `Window::set_window_icon` takes one RGBA image for both sizes." `tao` 0.38.0 documents `set_window_icon` as "On Windows, this sets `ICON_SMALL`" (`src/window.rs:1137-1140`) and has a separate safe `WindowExtWindows::set_taskbar_icon` documented "This sets `ICON_BIG`" (`src/platform/windows.rs:158-159`).
  - Line 149: "no crate reads it" (the double-click time). See F6.
  - Line 40: "Looked for: `tao` `EventLoopExtRunReturn::run_return` and `pump_events`". `tao` 0.38.0 has no `pump_events` anywhere in its source.
  - Line 32: "`testing::smallest_growth` (how every handle test compares them)". Five tests use it; the handle tests of the shell, notify, input, webview and tab-frame code do not (see F9).
- Also observed, at lesser weight: the groups at lines 40, 41, 42, 56, 57, 84, 85, 94, 104 and 168 name no crate API or no page, relying on the general sentence at line 30; each of those claims was checked and holds.
- Why it fails: a reviewer and a maintainer read the ledger as the record of what was looked for. The icon entry's real reason is narrower (adopted windows, and `.ico` bytes), and it is not the one written.
- What would settle it: the four sentences corrected to what the sources show.

### F8. `must fix`. OS callbacks that are not wholly inside `catch_unwind`, or that turn a panic into success

- Criterion: "Callbacks from the OS ... never unwind: their bodies run inside `std::panic::catch_unwind` and convert a panic to the callback's failure value."
- Where and observed:
  - `crates/sweetview-platform-webview/src/windows/environment.rs:85-89`: the closure given to `CreateCoreWebView2EnvironmentCompletedHandler::create` is not inside `catch_unwind`, and `webview2-com`'s generated handler adds none.
  - `crates/sweetview-platform-webview/src/windows/istream.rs:129-138` (`Stat`, which writes through a raw pointer) and `78-83` (`Drop`, run from COM's `Release` on WebView2's thread) are not inside `catch_unwind`; `Read` in the same file is, and returns `E_UNEXPECTED`.
  - `crates/sweetview-platform-webview/src/windows/handlers.rs:17-19`: `guarded` is `let _ = catch_unwind(AssertUnwindSafe(f));` and each of the seven `Invoke` bodies then returns `Ok(())`. `crates/sweetview-platform-notify/src/windows.rs:120-124` does the same for the three toast handlers. A panic becomes `S_OK`.
  - `crates/sweetview-platform-loop/src/windows.rs:221`: the table lookup of `message_window_proc` runs before the `catch_unwind` at line 224.
- Why it fails: the first two are bodies outside `catch_unwind`; the third converts a panic to the success value. No panic path was found in the unguarded bodies by reading, and under the workspace's `rust-version` a panic leaving an `extern "system"` function aborts the process instead of unwinding into the caller.
- What would settle it: the three unguarded bodies wrapped, and the handlers returning a failure `HRESULT` when the guarded call panicked.

### F9. `must fix`. Most handle-count tests do not assert what the policy asks

- Criterion: "Each owning type has a test that creates and drops it in a loop and asserts that the process's handle count (Windows: `GetGuiResources` and `GetProcessHandleCount`) returns to its starting value."
- Observed, from the 15 Rust tests that read the counts:

| Test (file) | Owning types | Assertion |
|---|---|---|
| `loop/src/com.rs` | `ComApartment` | smaller of two measured loops, all three counts `<= 0` |
| `loop/src/loop_host.rs` | `LoopHost` | no more than a bare `tao` loop (D23 gives the reason) |
| `loop/src/windows.rs:572-591` | `SignalWindow`, timers | USER `==`; kernel `<= +2`; GDI not read |
| `loop/src/windows.rs:593-619` | `MessageWindow`, `Poster` | smaller of two loops, all three `<= 0` |
| `notify/src/windows.rs` | `Notifier` and its parts | USER and GDI `<=`; kernel `<= +4`; smaller of two loops (D20) |
| `shell/src/clipboard.rs:300-307` | clipboard types | USER and GDI `<=`; kernel `<= +2` |
| `shell/src/single_instance.rs` | lock, `OwnedHandle` | USER and GDI `<=`; kernel `<= +2` |
| `shell/src/url_scheme.rs` | registry key | kernel only, `<= +2` |
| `input/tests/windows_hooks.rs:574-588` | both hooks | USER `<=`; kernel `<= +2`; GDI not read |
| `webview/tests/teardown.rs` | `WebviewExtras` and its parts | no more than a control run without the extras, smaller of two runs (D20) |
| `window/src/tab_frame_tests.rs:66-75` | `OwnedMenu` | USER and GDI `<=`; kernel not read (D20) |
| `window/src/tab_frame_tests.rs:166-173` | `FrameMessages`, brushes | USER and GDI `<=`; kernel not read |
| `window/src/windows_tests.rs` | `WindowSubclass`, icons | USER and GDI `==`; kernel `<= +2` |
| `window/src/windows_tests.rs` | shell drop | smaller of two loops, all three `<= 0` |
| `runtime/src/window_tests.rs` | runtime window | USER and GDI `==`; kernel `<= +4` |

- Why it fails: an allowance, a "did not rise", a count that is not read, and a comparison with a control run are each something other than "returns to its starting value" of both counts. D20 explains four of them and D23 one; those are explained departures and are the owner's to accept. The kernel allowances of 2 and 4 and the counts that are not read carry no written reason. `create_environment` leaves one COM apartment count behind on every call (`crates/sweetview-platform-webview/src/windows/environment.rs:74-76`) and has no counted loop. The clipboard test cannot see the block `GlobalAlloc` makes, because neither count includes global memory.
- What would settle it: each allowance and each unread count either removed or given its reason in `DECISIONS.md`, as D20 does for the others.

### F10. `must fix`. Code that can run under Miri was not run, and the evidence says it cannot

- Criterion: "Code that can run under Miri does: `cargo miri test` for the crates with `unsafe` forbidden".
- Where: `rust-rewrite/evidence/w10-miri.txt`; W10.1's evidence in `rust-rewrite/CHECKLIST-windows.md:579`.
- Observed: the evidence says of `sweetview-runtime` "every test starts the UI thread's COM apartment, windows or the WebView2 runtime through the platform crates". The crate has tests that make no OS call: six in `crates/sweetview-runtime/src/bridge.rs:185-226` (string building and parsing), six in `src/icon.rs`, two in `src/menu.rs`, and six in `src/tray.rs:428-468` (the click rule replayed from a list, and the mapping of tray events to inputs). The recorded run stopped at the first test that called the OS.
- Why it fails: those tests make no OS call by reading, so they can run under Miri, and they were not run.
- What would settle it: `cargo +nightly miri test -p sweetview-runtime` with a filter for those modules, its output added to the evidence, and the sentence corrected.

### F11. `must fix`. Global state in a form the policy does not list

- Criterion: "Global state is `OnceLock`, `thread_local!`, or a field of an owning type."
- Where: `crates/sweetview-platform-input/src/windows.rs:43` and `:45` (`static MOUSE_INSTALLED: AtomicBool`, `static KEYBOARD_INSTALLED: AtomicBool`), `crates/sweetview-platform-input/src/permissions.rs:105` (`static AUTO_REQUEST: AtomicBool`), `crates/sweetview-platform-notify/src/windows.rs:51-55` (three atomics), `crates/sweetview-platform-webview/src/shared.rs:56`.
- Why it fails: an atomic `static` is none of the three forms. This is the letter of the rule; the statics are safe code and no consequence was found.
- What would settle it: the statics in one of the three forms, or the owner's written acceptance of atomics.

### F12. `must fix`. Two commits raise the `unsafe` count without explaining it

- Criterion: "A count that rises in a commit is explained in that commit's message."
- Observed: `368f339` ("wip: W2, the webview on the Rust engine") raises the count by 89 and explains 3: "Unsafe ledger: `crates/sweetview-platform-window/src/foreign.rs` adds 3 blocks ...; `sweetview-platform-webview` is counted when it is complete." No later commit message gives the webview crate's count. `d92c94f` ("wip: webview tests and engine fixes in progress") adds `size_hint.rs` with 4 uses and says nothing; the next commit's message explains 3 of them. The other 15 commits that raise the count explain it.
- Why it fails: the rule is per commit. Pushed history is not rewritten, so this is settled by an answer, not a change.
- What would settle it: an answer in this file that names the two commits and points to the ledger sections that now account for those uses.

### F13. `must fix`. A tracked file holds a machine-local absolute path

- Criterion: R6, "Tracked files hold no machine-local absolute path."
- Where: `rust-rewrite/evidence/w8-packaging.txt:14`.
- Observed: a warning line of the build tool pasted with the full path of this repository's checkout on the machine that ran it (a drive letter, the repositories folder, the provider folder, the owner folder, then `sweetview\packages\sweetview-native\prebuilt\...`). `verify.ts` prints `PASS privacy ... 0 path hits` because its pattern matches only paths under a `Users` or `home` folder (F35). No other machine-local path, user name, host name, private application name, or description of a particular application was found in the tracked files of the change set or in the 110 commit messages; branch and tag names hold nothing private; `rust-rewrite/local/` is ignored and untracked.
- What would settle it: the path in that line replaced by `<REPO>`, as the other evidence files do.

### F14. `must fix`. Three capabilities were dropped or narrowed, recorded only as upgrade notes

- Criterion: the owner's "No functionality is declared out of scope, deferred, stubbed or dropped."; R1, "No capability goes with the change. Whatever an application could do before, it can do after" and "A behaviour with no ready-made crate API is written by this project in Rust. "No crate has it" is never a reason to leave it out."
- Where and observed:
  - Popup and tray menus. `docs/upgrading.md:80-83`: "A popup menu chooses an item on a left click or from the keyboard; letting go of the right button over an item does not choose it. The tray menu opens at the cursor, and the OS flips it upward near the taskbar." At the tag `packages/sweetview-native/src/win32/menu.ts` (a file that still exists; read as a diff) called `TrackPopupMenu` with `TPM_RIGHTBUTTON | TPM_RETURNCMD` for a menu at a point, and with `TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_RETURNCMD` for a menu at the cursor. The menus now go through `muda` 0.22.0, which passes `TPM_LEFTALIGN | TPM_RETURNCMD` (`src/platform_impl/windows/mod.rs:951`). The project's own popup for the tab menu still passes `TPM_RIGHTBUTTON` (`crates/sweetview-platform-window/src/tab_frame.rs:88`). No decision in `DECISIONS.md` records the change or its reason.
  - `windowMenu(hwnd)`, an export of the published subpath `@n1h/sweetview-native/win32/tab-window`. At the tag it showed the system menu of any window (`GetSystemMenu(hwnd, 0)` and `TrackPopupMenu`). Now `packages/sweetview-native/src/win32/tab-window.ts:174-177` serves a tab frame only, and `docs/upgrading.md:1169` says "for tab frames only (any other window shows nothing)".
  - `buildMenu` and `destroyMenu`, exports of the published subpath `@n1h/sweetview-native/win32/menu`. `docs/upgrading.md:1217-1218`: "no raw `HMENU` is handed out ... for an `HMENU` for your own `TrackPopupMenu`, build it with your own `bun:ffi` table".
- Why it fails: each is something an application or its user could do at the tag and cannot do now through any Sweetview call. The `api-surface` check does not see the last two, because it reads only the entry points its pattern names.
- What would settle it: the right-button choice and the tray alignment restored (the project's own `track` already does both), `windowMenu` serving any window of the thread, and a call that hands an application a built menu; or, for each, the owner's written acceptance of the loss.

### F15. `must fix`. Evidence recorded on an earlier tree

- Criterion: the preamble, "An item is ticked when its acceptance has been run and the output is pasted under it"; the pasted output is the proof for the tree being signed off.
- Observed:

| Item | Evidence | What changed afterwards | Re-run at `26a5474` by this review |
|---|---|---|---|
| W0.4 | "310 ... from crates.io: 298" | `windows-registry` was added (D23); the script now prints 311 and 299 | yes, passes |
| W1.3 | `w1-callbacks.txt`: "Ran 97 tests across 7 files" | the seven files now hold 101 tests | yes, 101 pass |
| W2.1 to W2.9 | `w2-webview.txt`: "Ran 30 tests across 2 files", last changed in `1aa28bd` | `4f41c62` and `07d7567` changed the engine (D21) and added four tests; the two files now hold 34, and the four new tests appear in no evidence file | `webview.test.ts` yes, 23 pass; the whole suite passes |
| W4.2, W4.6, W5.2, W5.4 | `w4-windows.txt` and `w5-tray-menus.txt` | both list four tests that no longer exist by those names ("the message window's JSCallback window procedure ...", "CreateIconFromResourceEx accepts ...", "MonitorFromRect ...", "Screen.of(hwnd) resolves the monitor hosting a message window", the last cited by name under W4.6) | yes, pass |
| W6.1, W6.2 | `w6-activation.txt`, `w6-single-instance-interop.txt`, last changed in `eb79e31` | `921ba3b` rewrote the single-instance window onto `MessageWindow` | W6.1 yes; W6.2 (an old build and a new build handing off) no |
| W7.1, W7.2 | `w7-native-tabs.txt`, last changed in `607bcce` | `32420e7`, `3516059`, `857e348` and `189faef` changed the tab frame's Rust code | the tab tests in the whole suite yes; `scripts/win-drive.ts` no |
| W8.1 | `w8-packaging.txt`, last changed in `86a27a8` | `9a6d78c` changed the native package's `package.json` and sources (the packed list went from 65 files to 60) | no |
| W9.1 | "27 files import bun:ffi, 27 allowlisted", "17 probes" | `win-tabs-input.ts` was added; `verify.ts` now prints 28 and 28, and the list holds 18 probes | yes, the check passes |

- Why it fails: for each row the pasted output describes a tree that is not `26a5474`. Where the re-run passes, the behaviour holds and only the evidence is old. W6.2, W7.2 and W8.1 were not run again by anyone after the code they prove changed.
- What would settle it: each of the three run again at the final tree and all eight evidence blocks replaced by the current output.

### F16. `must fix`. Tests weakened or removed beyond what D20 and the checklist record

- Criterion: the owner's "Never weaken a test ...; change one only to correct a false result, and print that diff with its reason"; R1, "An existing test keeps what it proves ... A test is deleted only when the thing it tested is `bun:ffi` plumbing that no longer exists."; W0.2, "Every test that passes here passes at the end."
- Observed, against the 174 tests that pass in `rust-rewrite/evidence/baseline-windows.txt`: 157 are present under the same name and pass; 11 are renamed or moved (ten with the same or stronger assertions, one loosened, below); 1 (`dlopen` symbol caching) now runs on macOS only, which W2.8 records; 5 are gone.
  - Gone and recorded: "the message window's JSCallback window procedure runs" (W9.1).
  - Gone and not recorded: "notifyIconData lays out the balloon fields where Windows expects them", "the 32px balloon icon loads from the generated .ico", "hiddenBalloonData sets NIS_HIDDEN and NIF_INFO for standalone notifications", "bitmapItemInfo lays out MENUITEMINFOW for hbmpItem". W9.1's evidence says "One test went with the deleted files". What the first three guarded (the balloon's flags, its icon from an `.ico`, the hidden state) is still product behaviour (`crates/sweetview-platform-notify/src/windows.rs:138-164` and `234-249`) and no test now asserts it; `NIS_HIDDEN` appears in no test.
  - Loosened: at the tag "CreateIconFromResourceEx accepts a generated .ico image" asserted `expect(icon.owned).toBe(true); // false would mean it fell back to the stock icon`. Its counterpart `packages/sweetview-native/src/win32/win32.test.ts:46-53` asserts `expect(icons.small).not.toBe(0n)` and `expect(icons.big).not.toBe(0n)`, which the stock-icon fallback (`crates/sweetview-platform-window/src/windows.rs:493-498`) also passes. D20 does not list it.
  - Made conditional: `packages/sweetview-native/src/win32/window-native.test.ts:378` is `test.skipIf(moveLoop?.ok === false)(...)`, added in `09f76ba`. D20's entries for this test describe the move-loop control and say "What is asserted is unchanged"; none says the test can now be skipped.
  - Understated in D20: the notifier entry does not say that the baseline's check that a real toast raised no `Failed` event has no counterpart, and `758c2fc` and `a5d4260` (test toasts without a banner and with an expiry) are not in D20.
- Why it fails: W0.2's last sentence does not hold for four baseline tests, three of which guarded behaviour that is now untested; one assertion was loosened and one test made skippable without a D20 entry.
- What would settle it: a Rust or TypeScript test for the balloon's flags, hidden state and icon; the icon test asserting that the icon is not the stock one; D20 entries for the skip and the two notifier commits; and W9.1's sentence corrected.

### F17. `must fix`. W1.2: the handle-scope test proves nothing about scopes

- Criterion: W1.2, "Each call opens its own handle scope. Proven by a `bun test` test".
- Where: `packages/sweetview-native/src/binding.test.ts:68-80`.
- Observed: the test named "each call opens its own handle scope: ten thousand callbacks inside one blocking run" has one assertion, `expect(calls).toBeGreaterThanOrEqual(10_000)`. Ten thousand callbacks complete with or without a scope per call. The scope is opened in `crates/sweetview-napi/src/callback.rs:38` (`Env::run_in_scope`), which is reading, not a test.
- What would settle it: a test that fails without the scope (for example one that observes that objects made in one callback are collectable before the blocking run returns).

### F18. `must fix`. W1.3 and W1.4: one callback kind has no test, and one has no owner-destroy test

- Criterion: W1.3, "A test throws from each callback kind."; W1.4, "A callback that removes itself or destroys its owner from inside its own call works. A test does both."
- Where: `packages/sweetview-native/prebuilt/binding.d.ts:162`; `rust-rewrite/evidence/w1-callbacks.txt:25`.
- Observed: the binding declares `onActivate(listener?: ((arg: boolean) => void) | undefined | null): void` on `TabFrame`. The evidence's table of kinds has no row for it and no test file names it. For `Engine.onAcceleratorKey` the table's third column reads "destroying its webview from inside: covered by the tabs work", which names no test, and no test destroys a webview from inside an accelerator-key handler. In the recorded run the accelerator-key test itself is `(skip)` (line 144).
- What would settle it: a throw test, a self-removal test and an owner-destroy test for `onActivate`, an owner-destroy test for `onAcceleratorKey`, and the table rows naming them.

### F19. `must fix`. W3.1 and W3.2: the tests through the TypeScript API do not assert repeat or swallow

- Criterion: W3.2, "`installKeyboardHook`: down, up, repeat, ... swallow per event."; W3.1, "`installMouseHook`: ... swallow per event".
- Where: `packages/sweetview-native/src/input-hooks.test.ts:124-136`.
- Observed: the test named "down, repeat and up arrive with the DOM code and the raw code, and a swallowed key is swallowed per event" asserts `expect(seen.map((m) => m.event)).toEqual([KeyEvent.Down, KeyEvent.Up])`. It asserts no repeat and does not check that the swallowed key failed to reach the system. Every mouse handler in the file returns `false`. Repeat and swallow are asserted against the platform crate by `crates/sweetview-platform-input/tests/windows_hooks.rs` (13 passed in this review); nothing asserts that a JavaScript handler returning `true` swallows an event.
- What would settle it: the two assertions added to the TypeScript tests (a repeat seen for a held key that is not swallowed; the key state or pointer position read back from the OS after a handler returns `true`).

### F20. `must fix`. W4.2: no webview is mounted in a window that Sweetview did not make

- Criterion: W4.2, "`Window.fromHandle` wraps a window this process did not create through Sweetview (an application's own `HWND`), ... and `WebView.attach` mounts a webview inside it."
- Where: `packages/sweetview/src/app.test.ts:272-285`.
- Observed: `const host = new Window({ frame: false, ... }); const borrowed = Window.fromHandle(host.handle); const borrowedView = await WebView.attach(borrowed, ...)`. The host is a Sweetview window. The "given window" of W2.1's fixture (`packages/sweetview-native/test/fixtures/webview-api.ts:93-98`) and the "own window" of `rust-rewrite/compat/fixtures/own-window.ts` are also made with `new Window`. No test, fixture or compat file attaches a webview to a window made with the application's own `CreateWindowExW`.
- What would settle it: the attach case of that test run on the `STATIC` window the `fromHandle` event test already makes through `bun:ffi`.

### F21. `must fix`. W4.3: the hidden first window rests on reading a dependency, and "above the taskbar" on a style bit

- Criterion: W4.3, "Overlays: ... topmost above the taskbar, ... the hidden first window."
- Where: `rust-rewrite/CHECKLIST-windows.md:255`.
- Observed: "The hidden first window: `tao` creates a hidden top-level tool window with its event loop, before any window of Sweetview's (`tao` 0.38.0, `src/platform_impl/windows/event_loop.rs`), so Sweetview's own first window is never the process's first." That is an argument from source; no run shows a fresh process whose first Sweetview window is topmost. "Topmost above the taskbar" is evidenced by `WS_EX_TOPMOST` read back; no test reads the z-order against the taskbar.
- What would settle it: a fixture in a process of its own whose first window is a `topmost` overlay over the taskbar's rectangle, with `WindowFromPoint` at a point inside the taskbar returning that window.

### F22. `must fix`. W4.8: the modals are not opened from a `uiMethods` call

- Criterion: W4.8, "An application's own `bun:ffi` modal dialog and popup menu, opened from a `uiMethods` call, work under both loop modes."
- Where: `rust-rewrite/compat/own-modal-loops.test.ts:1-5`, `93`, `111`.
- Observed: the file says "The handler stands in for a `uiMethods` call: both are JavaScript run by the binding from inside the loop." Both modals are opened inside `scheduleNativeTimeout(10, ...)`. No test opens `MessageBoxW` or `TrackPopupMenu` from a `uiMethods` handler of an app.
- What would settle it: the same two modals opened from a `uiMethods` method of the compat app fixture, called from its page, in both loop modes.

### F23. `must fix`. W5.1: the icon, the tooltip and `setIcon` are not read back in the tests cited

- Criterion: W5.1, "`Tray`: icon, tooltip, ... `setIcon`, `setMenu`, ...".
- Where: `packages/sweetview-native/src/win32/tray-menu.test.ts:267-272` and `369-372`.
- Observed: the test "a tray with no icon shows the stock icon, and the public Tray works the same" asserts only `expect(currentTray()?.windowHandle()).not.toBe(0n)`. `setIcon` is checked through the project's own getter (`currentTray()?.iconBytes()`), and `setTooltip` is called and nothing reads the tooltip. The evidence for W5.5 (`rust-rewrite/evidence/w5-demos-real-clicks.txt`) does read a tooltip from Explorer through UI Automation; W5.1 does not cite it, and nothing reads a changed icon from the OS.
- What would settle it: the tooltip and the icon read from the shell in these tests, as the W5.5 script reads the tooltip.

### F24. `must fix`. W5.3: the fallback balloon's hidden icon and the "with a `Tray`" case have no assertion

- Criterion: W5.3, "The fallback when WinRT is unavailable or a toast fails is a balloon on a hidden notification icon of the notifier's own, with or without a `Tray`".
- Where: `packages/sweetview-native/src/win32/notifier.test.ts:168-213`; `crates/sweetview-platform-notify/src/windows.rs:246`.
- Observed: no test asserts that the fallback icon is hidden (`NIS_HIDDEN` is set in source and read by no test; the baseline test that asserted it is gone, F16). The test for the tray case constructs no `Tray`; it calls `setNotifierTrayIcon` directly. "WinRT unavailable" is forced with `ForcedPath::BalloonOnly`, which bypasses the real failure path. Clicks in these tests are `debugSimulateToastEvent` and `debugSimulateBalloonEvent`; a real toast shown and a real click coming back are evidenced only under W5.5, by injected input.
- What would settle it: a test that reads the fallback icon's hidden state and balloon flags, and one that shows the fallback while a real `Tray` exists.

### F25. `must fix`. W5.5: the tray icon was not clicked by hand

- Criterion: W5.5, "the tray icon is clicked by hand and the result written down."
- Where: `rust-rewrite/CHECKLIST-windows.md:337`.
- Observed: "The tray icon was not clicked by a hand: nobody is at this machine. It was clicked with real mouse input instead". The item's clause is not met as written; `rust-rewrite/OWNER-ACTIONS.md` section 4 lists the click for the owner.
- What would settle it: the owner's click and its result written under the item.

### F26. `must fix`. W7.1: one evidence statement is false and several listed behaviours have no check

- Criterion: W7.1, "every behaviour in `rust-rewrite/reference/v1-drafting-tabs-and-window.md` under "Behaviour: tabs on Windows"."
- Observed:
  - `rust-rewrite/CHECKLIST-windows.md:383` says of `strip.scrolled` "its use in the drop index is unit-tested in `strip-shared.test.ts`". `packages/sweetview-native/src/win32/strip-shared.test.ts:47-52` calls `dropIndex(STRIP, 3, x)` six times and never passes the fourth argument `scrolled`. No fixture posts `strip.scrolled`.
  - Behaviours of the 27 bullets with no check in the test or its two fixtures (the fixtures hold no occurrence of `WM_SYSCOMMAND`, `OperationCanceled` or `AppsUseLightTheme`): choosing an item of the system menu; the exclusions of the failed-load page (cancelled, aborted, HTTP status, `about:` and `data:`, superseded); the initial dark state read from the system; which tab is selected after a close; the options a torn-off window copies from its source; centring on the work area when no bounds are given. A real change of scale was not run, as the evidence says.
  - The check "a popup opens as a tab after its opener" does not assert the new tab's position.
  - `packages/sweetview/src/tabs/win-tabs.test.ts:134-141` reports a fixture check that was skipped as a pass (F33), and the pasted output cannot show that "Nothing was skipped in that run".
- What would settle it: a `dropIndex` test with a non-zero `scrolled` and a fixture check for `strip.scrolled`; a check for each behaviour listed; the false sentence removed.

### F27. `must fix`. W9.3 and R2: most rows of the upgrade guide are imported, not run

- Criterion: R2, "Each row is exercised by code under `rust-rewrite/compat/`: a test that imports the new form and runs it."; W9.3, "`rust-rewrite/compat/` exercises each row."
- Where: `rust-rewrite/compat/upgrade-guide.test.ts:177-203`.
- Observed: for a row the test imports the module and checks the shape of the export (`typeof value !== "function"`, a property present, a literal equal); it calls nothing. `behaviour.test.ts` and `own-modal-loops.test.ts` run the rows whose behaviour changed. Of 218 distinct value names in the guide, 177 are never called anywhere under `rust-rewrite/compat/` (a helper's count; among them `pickFolder`, `installKeyboardHook`, `beginWebviewResponse`, `unregisterUrlScheme`). `rust-rewrite/OWNER-ACTIONS.md:38` says "every row of `docs/upgrading.md` is imported and run in its new form by the tests under `rust-rewrite/compat/`", and D19 says the same.
- What would settle it: each function row called once in its new form, or the owner's written acceptance of import-only for rows whose behaviour did not change, with the sentence in `OWNER-ACTIONS.md` corrected.

### F28. `must fix`. W10.4 is ticked without evidence in the form the checklist asks

- Criterion: the preamble, "... the output is pasted under it, as an indented fenced block or as the path of a log under `rust-rewrite/evidence/`. An item ticked without evidence is unticked by `verify.ts`."
- Where: `rust-rewrite/CHECKLIST-windows.md:594-596`.
- Observed: the text under W10.4 is one paragraph of prose with neither. `bun rust-rewrite/verify.ts windows --quick` prints `FAIL checklist ... no evidence: W10.4`.
- What would settle it: a fenced block under the item (for example the section headings of `OWNER-ACTIONS.md` as a command prints them).

### F29. `should fix`. `WindowSubclass` acts on its handle after the window is gone

- Where: `crates/sweetview-platform-window/src/windows.rs:648-653`, `667-676`, `687-693`.
- Observed: after `WM_NCDESTROY` removes the state, the value still holds `hwnd`. `Drop` runs `take_state(self.hwnd)`, which removes whatever state is now under that handle value, and then removes that window's subclass; `set_policy` and `force_style` write styles to whichever window has the value. `FrameMessages` in the same crate guards exactly this (`tab_frame.rs:261-272`, "not a later frame that was given the same handle value").
- What would settle it: the same identity check (`Rc::ptr_eq` against the state the value installed) in `WindowSubclass`.

### F30. `should fix`. The webview's request filters have no owner

- Where: `crates/sweetview-platform-webview/src/windows/mod.rs:396-416` and `:152`.
- Observed: `register` adds two web-resource filters and nothing removes them; they go only when the controller is closed. If a later registration in `register` fails, the comment at line 152 says "On failure `inner` drops here, and with it every registration made so far", and the filters stay on a live webview with no handler to answer them.
- What would settle it: the filters removed on the failure path, or owned by a type that removes them.

### F31. `should fix`. The WebView2 handler objects are agile while holding single-thread state

- Where: `crates/sweetview-platform-webview/src/windows/handlers.rs:21-132`.
- Observed: each handler is `#[implement(...)]` with default options, and `windows-implement` 0.60.2 defaults to `agile: true` (`src/lib.rs:165`), so each object answers COM that it may be called and released on any thread, while holding a `Box<dyn Fn>` that captures `Weak` and `Rc` values. Nothing in the tree calls them from another thread; the declaration says it would be allowed.
- What would settle it: `Agile = false` on the seven handler types.

### F32. `should fix`. Three registrations or owners are looser than the policy's wording

- `crates/sweetview-platform-notify/src/windows.rs:380-386`: `Toasts` registers the toast handlers and has no `Drop`; the tokens are removed by `Notifier`'s dispose. The policy says a callback is "unregistered in that object's `Drop`".
- `crates/sweetview-platform-shell/src/win.rs:22`: `pub(crate) struct OwnedHandle(pub(crate) HANDLE);` can be built around any handle by any code of the crate, and its `Drop` closes it.
- `crates/sweetview-platform-loop/src/windows.rs:129-148`: the window class is never unregistered, and "class already exists" is accepted without checking whose procedure the class has.

### F33. `should fix`. Tests that report a pass without asserting

- `packages/sweetview/src/tabs/win-tabs.test.ts:134-141`: `if (result && "skipped" in result) { console.log(...); return; }`.
- `packages/sweetview-native/src/win32/window-native.test.ts`: the hit-region poll test returns when a mouse button is held (`if (await buttonsDown()) return;`), and the `startResize` and `startDrag` tests return after a `console.warn` when the window is not under the cursor.
- `packages/sweetview-native/src/callbacks.test.ts`: the same early returns in the mouse-hook and refiner tests.
- In the runs of this review none of these conditions was true.

### F34. `should fix`. Evidence that proves less than its sentence says

- W1.1: both failure tests (`packages/sweetview-native/src/binding.test.ts:28-39`) go through `loadBindingFrom(path)`; the failure branch of the loader's literal `require` (`packages/sweetview-native/src/binding.ts:35-39`) is not exercised, and the "other platform" file is a 16-byte stub.
- W1.8: `pageCallsInsideModal` counts calls of the bound handler inside the modal loop; the page discards the reply, so a reply reaching the page while the box is open is not checked. The popup-menu case is in W4.8's test, without page calls.
- W3.5: the run shows the example starting, showing its window and exiting with code 0; no input is injected and no hook event is shown reaching the page.
- W6.2: the driver that ran the two builds lived in the temp directory and was deleted; the run cannot be repeated from the tree.
- W2.7: nothing in `rust-rewrite/reference/` lists the original tests, so "asserting the same behaviour" cannot be compared here; the evidence names `fileDropCallbackPtr`, which appears nowhere else in the tree.
- W4.6: `packages/sweetview-native/src/index.test.ts:78-80` checks `Screen.cursor()` for type only.
- W8.3: the test asserts that `refreshShellIcons` is a function and that `refreshWindowsIcons()` returns undefined.

### F35. `should fix`. The privacy check of `verify.ts` does not see a path outside a user folder

- Where: `rust-rewrite/verify.ts:285` and `:293`.
- Observed: the pattern matches a drive letter followed by `Users`, `/Users/<name>/` and `/home/<name>/`, and exempts `README.md`, `docs/` and `.apmm/`. It printed `0 path hits` over the file of F13. The file's own rule allows a check to be added.

### F36. `should fix`. Test hooks ship in the binding, and its entry points do not catch panics

- `ForcedPath`, `balloons_shown` and the `debug*` methods of the notifier (`crates/sweetview-platform-node/src/notify.rs:53-108`) are compiled into the published binding.
- No `#[napi]` item uses `#[napi(catch_unwind)]` and neither binding crate catches panics; a panic in the runtime reached from JavaScript ends the process instead of becoming an exception.

### F37. `remark`. The export table is a platform crate (decision D2)

The policy says the N-API surface lives outside the platform crates, and W0.3 says "The binding (the `napi` crate) and the logic crates forbid `unsafe`". The items that carry `#[napi]` are in `sweetview-platform-node`, which does not forbid it. D2 names this departure and its reason; the reason was checked in the macro sources (`napi-derive-backend` 8.0.0 emits a `ctor!` registration for each function and class, and `ctor` 1.0.14's expansion carries `#[allow(unsafe_code)]`, which `forbid` rejects). It is an explained departure for the owner to accept. F5 is the part of it that is not explained.

### F38. `remark`. W0.6 is open; what the tree shows

`.github/workflows/windows.yml` exists, runs on `windows-latest`, and has a step for each thing the item names: `just native`, `cargo test --workspace --no-fail-fast`, `cargo clippy --workspace --all-targets -- -D warnings`, `bun run typecheck`, `bun test`. No run is pasted under the item. At `26a5474` the local branch is two commits ahead of its remote-tracking ref, so no hosted run recorded so far can be of this commit. `OWNER-ACTIONS.md` does not mention the open item.

### F39. `remark`. Documents and tests the items name are in other repositories

`assets.md`, `request-handler.md`, `requests.md` and `permissions.md` (W2.2, W2.5, W2.9, W3.3) are not in this repository; the tests agree with `docs/webview-library.md`, which is the nearest text here. The C++ fork's tests (W3.4) and the bindings' original test file (W2.7) and example (W3.5) could not be compared for the same reason.

### F40. `remark`. Smaller inaccuracies

- W1.3's evidence says each test asserts "the message today's TypeScript logs for that kind", naming the two hook messages; the tag holds no such message in this repository.
- W1.5: the any-thread functions that cross the binding are proven from a `Worker`; the other functions `docs/` calls any-thread are pure TypeScript and have no Worker test.
- W1.6: the block pasted under the item is an edited form of `w1-compiled-alone.txt`, and no tracked script makes the empty folder. W0.5: the load check is recorded as `bun -e "..."`.
- W2.1: no test constructs `new Webview(true, ...)`. W2.6: the drop is driven through DevTools, as the evidence says. W4.2a: the framed case asserts bounds and not `GWL_STYLE`, as at the tag. W4.4: the 10 ms interval is a constant read in source, and the button-down rule is tested in the logic crate and wired by reading.
- WT.1: the page of `demos/web-app` branches on the bridge's kind for labels in a few places besides the line that picks the transport.
- W10.3: the stand-ins are behind `cfg(not(windows))`, as the handoff states, where the item says `cfg(target_os = "macos")`; `HANDOFF-macos.md:431` says W10.4 is unticked.
- `rust-rewrite/DECISIONS.md:15` is a blank line inside the D1 table. `crates/sweetview-platform-webview/src/windows/pump.rs:17` says a `WM_QUIT` "is kept" where the code consumes it.
- SAFETY comments whose wording leans on "the caller" where a parameter's type is the real guarantee: `crates/sweetview-platform-webview/src/windows/mod.rs:623-625`, `:866`, `:896`; `istream.rs:73-74`; `crates/sweetview-platform-loop/src/windows.rs:267-268`; `crates/sweetview-platform-window/src/tab_frame.rs:86-87`.
- `webview2_com::take_pwstr` and `string_from_pcwstr` are safe functions of `webview2-com` that read through a raw pointer; the webview crate calls them at eight places after a COM call filled the pointer. Those reads are outside any `unsafe` block and outside the count of 217.

### F41. `remark`. Recorded decisions and conditions worth the owner's eye

- The clipboard's 12 uses repeat the calls a safe crate (`clipboard-win` 5.4.3) wraps; D23 records why it was not taken, and both reasons were checked true in that crate's source. No code in this repository impersonates, and the text read would not go through the function the second reason names.
- W9.4 is met by its condition: `rust-rewrite/local/dependents.txt` does not exist on this machine, so no application was upgraded (D19). The privacy check loaded 0 private terms for the same reason.
- `create_environment` enters a COM apartment and forgets it on purpose on every call (`crates/sweetview-platform-webview/src/windows/environment.rs:74-76`), and the notifier keeps one MTA usage reference for the process.

## 4. The purpose question

Numbers at `26a5474`: 217 uses of `unsafe`, 178 in source and 39 in tests, all in six crates; five crates forbid it. The crates that forbid `unsafe` hold about 9,300 lines; the platform crates about 12,500 with their tests.

| Crate | Source uses | Test uses | What the uses are | Judgement |
|---|---|---|---|---|
| `sweetview-platform-loop` | 20 | 2 | a message-only window, the pump, timers, handle counts, COM apartment; one call each inside five owning types | Small and justified (D3; no safe API was found for any use). Not yet contained: F1 and F2 are holes a safe caller can reach. |
| `sweetview-platform-input` | 8 | 7 | hook install and removal, two reads of the OS's `lParam`, key state | Small, contained and justified. Every decision is in `sweetview-keycodes` and tested there. |
| `sweetview-platform-notify` | 9 | 0 | the balloon's icon and notification-area entry, WinRT initialisation | Small, contained and justified. Toasts are safe WinRT methods; the registry is `windows-registry`. |
| `sweetview-platform-shell` | 21 | 3 | clipboard 12, single instance 7, handle close 1, shell notify 1 | Small. The single-instance, handle and icon uses are contained and justified. The clipboard module is the place nearest to the old calls repeated: twelve Win32 calls in three small types, one of which leans on its callers (F4). |
| `sweetview-platform-webview` | 61 | 6 | 54 typed-interface COM calls on objects `wry` hands out, 3 Win32 calls, 4 pointer operations in the stream | Justified and contained, not small. This is the policy's level 3, and each call is `unsafe` only because the `windows` crate marks every COM method so; 25 of the 54 read one value out of an event's arguments. One use can go today (F6). Callbacks hold the state weakly and registrations are removed on drop. |
| `sweetview-platform-window` | 59 | 21 | 15 calls on things the crate owns (icons, both subclasses, a drop, a menu, brushes); 41 calls on windows it does not own; 3 pointer conversions | Mixed. The owning types and the two subclass procedures are small, contained and justified. The thirty or so one-call window functions (`is_visible`, `show`, `set_bounds`, `set_title` and the rest) are a layer: one Win32 call each on a handle that only the OS validates. D8, D9 and R1's adopted windows justify their existence; their containment is the OS's handle check and not a type (F3), and one of them is not needed (F6). |
| `sweetview-platform-node` | 0 | 0 | macro-generated only | No hand-written `unsafe`. It holds logic it should not (F5). |

Taken together: this is not the old calls repeated as `unsafe` blocks. Every block is one operation with a stated reason, the callbacks are guarded, the state machines and tables were taken out into crates that forbid `unsafe` and are tested there, and no raw pointer or handle type crosses a crate boundary. It is also not yet what the purpose sentence says in full. "Small" holds for four of the six crates; the webview and window crates hold 120 of the 178 source uses, and the window functions read as a layer of FFI over adopted windows. "Contained" fails in the places F1 to F4 name. "Justified" fails for two uses (F6) and four ledger sentences (F7).

Whether a maintainer can read, test and change it: largely yes. Twelve crates each state one job in a `README.md`, the rules that need no OS are in three small crates with their own tests, the runtime is testable with closures in place of JavaScript, and `cargo clippy --workspace --all-targets -- -D warnings` passes with the four safety lints denied. What works against it: five files of 800 to 1,100 lines that each hold several jobs (`sweetview-platform-notify/src/windows.rs`, `sweetview-runtime/src/window.rs`, `sweetview-platform-webview/src/windows/mod.rs`, `sweetview-platform-window/src/windows.rs`, `sweetview-runtime/src/engine.rs`); a shell crate whose job is a list of four unrelated integrations, which D1 says in its own words; documents that describe the code as stricter than it is (the export table's `README.md`, F5; the ledger sentences of F7; the Miri sentence of F10); and test hooks in the product API (F36).

## 5. Verdict

Measured against `rust-rewrite/UNSAFE-POLICY.md`, `rust-rewrite/CHECKLIST-windows.md`, `rust-rewrite/REQUIREMENTS.md` and the owner's purpose, at commit `26a5474`:

- The `unsafe` reading (every use of `unsafe` against `UNSAFE-POLICY.md`): **findings to fix: F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12.** F1 and F2 are defects a safe caller can reach; F3 to F10 are rules broken with a consequence or a wrong record; F11 and F12 are rules broken in their letter. Should fix: F29, F30, F31, F32, F36.
- The checklist reading (every item against its evidence): **findings to fix: F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24, F25, F26, F27, F28.** Of the 63 ticked items, 13 are proven, 31 are proven with a remark, and 19 are not proven by the evidence under them: W0.2, W1.2, W1.3, W1.4, W3.1, W3.2, W4.2, W4.3, W4.8, W5.1, W5.3, W5.5, W6.2, W7.1, W7.2, W8.1, W9.3, W10.1, W10.4. W0.6 and W10.2 are open. Should fix: F33, F34, F35.

On the three whole-work questions. Functionality: three capabilities are dropped or narrowed (F14); nothing else was found stubbed or deferred on Windows, and the code behind `cfg(not(windows))` is the stand-in the macOS goal is to replace. Weakened tests and checks: `verify.ts`, `REQUIREMENTS.md` and `UNSAFE-POLICY.md` are unchanged since the tag and no checklist item's text changed; the ten D20 entries match their commits and each reason reads as a false result corrected; F16 lists what D20 and the checklist do not record. Privacy: one machine-local path (F13); nothing about a private application.

## 6. Not checked

- Whether the workflow of W0.6 ran or passed on the host, and the state of the remote: the host's command-line tool is not on this machine and nothing was fetched; "two commits ahead" is the local tracking ref.
- The full `bun rust-rewrite/verify.ts windows` (without `--quick`), `cargo test --workspace` as one run, `just native`, `just check`, `just compile`, `just pack`: not run. The crates' tests were run singly as listed in section 1.
- The demo runs, the tray and toast click scripts, `scripts/win-drive.ts`, the single-instance interop between an old and a new build, `rust-rewrite/checks/pack-install.ts`, the Electron and Tauri shells, `rust-rewrite/checks/mac-check.ts`: read, not run.
- `cargo miri test`: not run.
- Anything on macOS.
- The bindings repository and the C++ fork: not read by the lead; comparisons that need them are in F39.
- Files deleted since the tag were not read from history. What the tag did is taken from the baseline test list, from diffs of files that still exist, and from `docs/upgrading.md`.
- Behaviour of the WebView2 runtime that SAFETY comments rely on (a call on a closed object returns an error; a second `Close` does nothing; WebView2 holds its own reference to a handler during a call and calls handlers on the UI thread): not verifiable by reading.
- That `UISettings::DoubleClickTime` and `GetDoubleClickTime` return the same value (F6), and the icon path of F4 for an adopted window: read, not run.
- R2's run against real applications: there is no list on this machine (D19), and the private-terms list is absent, so the term half of the privacy check had nothing to match.
- The counts in F27 (177 of 218) and the bullet-by-bullet reading behind F26 are a helper's; the lead confirmed the mechanism and a sample, not every row.

## Answers

Each finding above is fixed or answered here by the session that owns the work.
