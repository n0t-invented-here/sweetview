# Status of the Windows goal

The Windows goal is **not complete**. This file says what is on the main branch, what sits on unmerged branches, what has not been started, and what a completion claim still needs. It is updated whenever a branch lands or work stops. Requirements: `REQUIREMENTS.md`. Order of work: `CHECKLIST-windows.md`. Findings this status is measured against: the goal audit of the Windows work (a report kept on the machine with the run output, outside git), with 15 findings and 28 places that teach the old way.

## The owner's rulings that bind all remaining work

- **Internals are never exposed for an application to call.** No `/internal`, `/win32/*` or other internal entry point is importable by an application, no document tells an application to use one, and no internal is turned into public API to close a gap.
- **Agents make no tradeoff about the product.** Whether a capability gets a public call, its name and shape, and whether a capability reached through internals is kept, are the owner's decisions. Work that reaches such a choice leaves the item as it is and lists it for the owner with the facts.
- **No workaround, and excellent code only.** A problem is fixed at its cause.
- **Everything slated for 1.0 is in scope and is delivered**: every feature `docs/` describes, every `v1-drafting` feature in `reference/`, and what an application needs to migrate without internals. Nothing is dropped because older releases lacked it. No time goes to a capability that none of those call for.
- **Nothing is announced as done without several rounds of adversarial review.** The required reviewers are Codex (GPT-6.2 Sol, high) and Antigravity (Gemini 4 Neon, high). A final completion needs a full review by Neon.
- **Reviews and audits judge the intent**, not literal readings that serve nobody.
- **An upgrade is a migration.** An upgraded application uses 1.0 as designed: a closed window is destroyed and its memory given back, windows are revealed by the ready signal, and no old behaviour, workaround or internal is carried over.
- **An application ends at its loop.** Nothing after `run()` is required of it.
- **The packages stay as organised.** No package is merged into another and no code moves between packages.
- **No copies of the owner's applications** are made anywhere; they are upgraded in place on branches. Their names, paths and behaviour never enter anything tracked here.
- **Hosted CI is not used.**
- **The orchestrating session writes no code**; it delegates, integrates and documents.
- **Tests of Rust behaviour are written in Rust.** A TypeScript test exists only for what is TypeScript (a wrapper reaching the binding, an exception at the boundary). More TypeScript test code than Rust product code is unacceptable. Measured against `v1-drafting` on 2026-11-28: 12,292 lines of Rust product code; 13,879 lines of TypeScript test code added (10,647 under `packages/`, 3,232 under `rust-rewrite/compat/`). Branch `rust-rewrite-tests-in-rust` moves the first slice (input hooks, notifier, modal loop); the rest (tabs, callbacks, tray and menus, windows, the webview) follows as each unmerged branch that touches those files lands.
- **`rust-rewrite/evidence/` is not in git.** Run output, dumps and reports stay on the machine in that folder, which git ignores. Nothing is committed there, by any branch.

## How code reaches this branch (changed on 2026-11-28)

Until 2026-11-28 no product code had landed on `v1-rust-rewrite` since the first part of the public API additions: five branches held all the work, each held back until both required reviewers passed it, and none had passed. That rule was the coordinator's, not the owner's, and it kept finished work off this branch. From now on: **a branch is merged here as soon as its author reports a full run with no failure on its head and the merged tree passes the same run**; the two required reviewers then review it here, and their findings are fixed here as further commits. Nothing is called done by being merged: the reviews, their rounds and the final full review by Neon are still required before any completion claim.

Since then authors run only the tests of what they changed, and the coordinator takes one full run (build, typecheck, clippy, `cargo test --workspace`, `bun test`) on each merged tree under the input lock.

### Landed on 2026-11-28, each after a full run of the merged tree

| Commit on this branch | What | Full run | Review after landing |
|---|---|---|---|
| `9335594` | Public API fixes (three failed review rounds answered under the tag-parity rule) and `onCallbackError` | `cargo test` all suites ok; `bun test` 577 pass, 0 fail | round 4, both required reviewers: FAIL on each; findings being fixed on `rust-rewrite-api-round4` and `rust-rewrite-callback-errors-followups` |
| `39e9020` | Callback follow-ups: macOS on the tag's path for three fixes in shared files; the guard made when the binding loads; the stderr lines with no listener as before | 583 pass, 2 fail: two `app-exit` tests that read the shell's balloon, failing on the main branch's own build too | |
| `0ad766a` | More callback fixes (the guard's state per call); internals not for applications: no document, demo or guide row sends an application to an internal entry, 46 guide rows say "no public call in 1.0", a guard test; the first part of the upgrade guide as a migration | 596 pass, 3 fail: the same two, and one webview test once (a race under load; passes 3 of 3 alone) | round 2 of the internals work, both: FAIL (two tray demos start differently on macOS; a ready-signal window with no timeout; two close-to-tray recipes; guard gaps); with its author |
| `c8a4a2b` | The two `app-exit` tests corrected (cause: an application running full screen puts the shell in its busy state, which ends balloons; the tests now ask the notifier itself); the first slice of tests moved from TypeScript into Rust (input hooks, notifier, modal loop: 1,265 lines of TypeScript to 336) | 561 pass, 4 fail: four tab-menu checks closed by other activity on the desktop; the same build then passed the tabs fixtures 3 runs of 3 | |
| `97dacaf` | Four more slices of tests moved from TypeScript into Rust (window, tray and menu, "removes itself from inside its own call", and the helper file they used), each moved test with a named Rust test | `cargo test` all suites ok; `bun test` 545 pass, 0 fail; tabs fixtures 100 of 100 and 10 of 10 | |

Still unmerged: the Windows webview rebuilt without `wry` (`rust-rewrite-fix-webview-behaviour`; one tab check fails 2 runs of 3 and round 3 review findings are open), the quit flash (`rust-rewrite-fix-quit-flash`; its own screen test still sees one white frame at a tabbed window's reveal), regressions against the tag (`rust-rewrite-fix-regressions`), round 4 fixes of the API (`rust-rewrite-api-round4`), the second slice of tests moved into Rust, and then the webview's move out of the native package.

## Why the checklist reads complete and the goal is not

Every box of `CHECKLIST-windows.md` is ticked and `bun rust-rewrite/verify.ts windows` printed `COMPLETE` at `c8dab02`. That claim was withdrawn. The verifier and the checklist were satisfied without any real application having been upgraded and run, and the goal audit then found the gaps listed below. The boxes stay ticked as records of what was run then; their evidence blocks are stale against the current tree and are produced again before any new claim.

## On the main branch (`v1-rust-rewrite`)

Merged since `c8dab02`, each with its decision in `DECISIONS.md`:

| What | Decision | Audit finding |
|---|---|---|
| Hosted CI not used; the workflow starts only by hand | D33 | |
| The binding is built on demand; `just native build`; fresh-clone errors say what to run | D34 | |
| The upgrade guide corrected from two real upgrades; demo identities | D35 | part of 8 |
| An application ends at its loop: everything is released at process exit | D36 | |
| `just link` and `just link-sweetview`: an application runs against a checkout with no path typed | D37 | part of 12 |
| Native timers are posted messages; the pump guard; message-window hardening (two review rounds) | D38 to D41 | |
| macOS held on the tag's path behind `macosKeepsTagPath()` | D42 | 11 |
| `VERIFY-macos.md`, the prompt for an agent on a Mac | | 11 |
| The goal audit itself | | |
| Public calls the real upgrades needed: `Window#isMinimized`, `Menu.popup` `above`, `contentSize`, `backgroundColor`, `onMaximizeChange`, `showSystemMenu`, `windowChromeEvents` | D43 | 2 |
| `onCallbackError`, one listener for the exceptions the native package catches at a callback boundary | D44 | |
| Internals are not for applications: no document, demo or guide row sends one to an internal entry; the upgrade guide as a migration | D45 | 1, 2, 14 |
| Tests of Rust behaviour moved from TypeScript into Rust, in slices | | |

## Branches: merged and unmerged

One line of state each. "Reported" means the agent that wrote it gave a final report with its test results; "reviewed" means someone other than its author read it.

| Branch | Holds | State | Left to do |
|---|---|---|---|
| `rust-rewrite-api-gaps` and its review fixes | Public calls the real upgrades needed (D43) | **merged** in `9335594` | the findings of review round 4 by both required reviewers, on `rust-rewrite-api-round4` (not merged). The branch's second part is one `wip` commit, half written, never built (`0c654ed`): a window with a page created under the blocking `run()`, hook latency under `runEventLoop`, `Menu` is-open and close, autoplay and browser arguments; an upgraded application has reported the second as a cost (it pumps every millisecond so that input hooks answer quickly) |
| `rust-rewrite-no-win32-subpaths` | Internals not for applications (D45), and the upgrade guide as a migration | **merged**: review round 1's fixes in `0ad766a`, round 2's in `bccde82`. The internal entries stay exported for Sweetview's own packages only (the packages stay as organised); no document, demo or guide row sends an application to one: 52 Windows and 79 macOS guide rows say `no public call in 1.0`, 12 macOS rows name their public call; a guard test (`rust-rewrite/compat/package-boundaries.test.ts`) fails on any new entry, cross-package import, re-export, page line or guide row that names an internal. After `bccde82`, on the branch and not merged: `PORT-STATUS.md`, `HANDOFF-macos.md` 3.1, `OWNER-ACTIONS.md` 3 and D19 made true of the tree; no prose document points into `rust-rewrite/evidence/` | review round 3 (`e35f80f..bccde82`): the first reviewer's findings T1 to T5 (the desktop pet's ready signal, "on Windows" in the short list, two guard cases, three rows, one sentence) are with the author; the second reviewer's are to come |
| `rust-rewrite-fix-callback-errors` | `onCallbackError` (D44) | **merged** in `9335594`; its follow-ups (`rust-rewrite-callback-errors-followups`) in `39e9020` | the findings of review round 4. Left as they are, for the owner: the three Windows tab callbacks that only print (`.catch(console.error)`), and that an application can fabricate a report through the cross-package entry; both need code to move between packages. The faults of `createApp`'s own callbacks are not reported to a listener. On macOS no listener is called until the macOS goal |
| `rust-rewrite-fix-webview-behaviour` | Audit findings 6 and 7: WebView2's own page behaviour restored (zoom, pinch, swipe, status bar, `app-region`); a streamed body's `Read` returns at once, with a backlog bound (D45) | reported, merged with the main branch, checks passed on it; its real-input run passed (Ctrl+wheel zoom, `app-region`, an in-page drag, a real drag out of Explorer delivering the file's path). Its author read the old C++ source: a streamed body reached the page only at its end before the rewrite too, and Microsoft's reference says WebView2 needs the whole body by the time the deferral completes, so streaming on Windows is as it was. **Review round 1: FAIL from both; round 2 (on `2155748`): FAIL from both.** What holds at the cause, by both: the stream writer, the `Read` contract, the uninitialised buffer. What does not: `wry` 0.58.2's Windows creation path registers handlers it gives no way to remove (it destroys the container on `window.close()`, marks every download handled and sets its path, writes the profile's autofill setting, subclasses a window it was given and moves focus into the page), and the round 1 fixes routed around them. **Design adjustment under R5, taken because the owner's ruling excludes workarounds: on Windows the container window and the WebView2 controller are created and owned by `sweetview-platform-webview` through `webview2-com`, following the old C++ library's creation path step by step, and the Windows webview is no longer built through `wry`.** Both reviewers named this as the fix at the cause. In progress. Its author removed a piece it had finished (pacing of a streamed body on the worker path, commit `3513b39`) because it needed two new internal exports; that commit stays in the branch's history | the redesign, its tests for every difference the reviewers listed, review round 3; then merge. For the owner: zoom, pinch and swipe on as the old library had them or off as `wry` sets them; the 1 MiB wait for a writer off the UI thread, where the old library never waited; whether the worker-path pacing comes back in a form that exposes nothing |
| `rust-rewrite-fix-quit-flash` | The white window at Quit; a window leaves the screen before its webview goes; backdrop colour; demos reveal on the ready signal; a pumped loop ends when nothing is reachable (its own D42, to renumber) | reported (head `6ec0f7b`, merged with the main branch). Cause found: at the end of `run()` the webview was destroyed while its window was still on screen, and the window's empty area showed white until the process ended. Fix: every path hides the window, then destroys its webviews, then the window; a window has one colour and its webview starts in it. Measured by a second process sampling the screen once per displayed frame: 0 white frames in every demo after, 1 or 2 before. Every path that closes a window was measured over 30 rounds: a close request with no listener, `dispose()`, `app.dispose()` and a closed tab all destroy the window and give back its objects; `closeToTrayOnLastWindow`'s last window and the page chrome's close button still hide. Its author took out two things it had added (`Window.close()`, a pumped loop ending by itself) as the owner's to decide. Reported again at `ed2c912`. The access violation is explained and fixed: the `windows` crate keeps WinRT factories for the whole process, COM unloads their library when the last apartment is left, and the next use runs code that is gone; the runtime now keeps COM loaded for the process. Only tests left their last apartment; an application's UI thread keeps its own. The flake is explained: another session's topmost window covered the test's window and its white was counted; the test now refuses to judge a covered or blended frame and names what covered it. Found and fixed on the way: the webview's container had no background and showed white until WebView2 drew. **Not solved: one white frame after a tabbed window is revealed, in about 1 run of 4.** Its full run: `cargo test` 262 passed; `bun test` 519 pass, 15 skip, **4 fail** (two tests that read the shell's balloon icon after the shell had ended the balloon, one timer test with no cause found, one test that refused to judge a covered window). **Review round 1 on `9d31972..ed2c912`: FAIL from both required reviewers.** They agree on: a raw webview's own window is still destroyed in view (also at process exit); forcing the last tab closed removes the page before the window; an application's own `hide()` between two runs is overridden; the demos' new start runs on macOS against D42; the screen test and the reclaim test can pass without judging. Sol adds a native callback that reverses the destruction order; Neon adds that the COM hold misses WinRT uses outside `ComApartment::enter()` and that the unsafe ledger's reasons were not written for four new uses. Held by both: no export or public API added, `Window.close()` and the self-ending loop fully gone, the page chrome and close-to-tray unchanged | with the author now: which window the remaining white frame belongs to, by measurement (the fix waits for the start-colour work of `rust-rewrite-api-review-fixes` and the webview rebuild, which replace the ground it stands on); the cause of the timer test's failure; the tests that misread a busy desktop corrected without loosening what they assert; the docs, guide bullets and tests for the two changes an existing application sees (the theme's backdrop where a window showed white; a window hidden after `run()` returns). Then the reviewers' findings, a full run with a cause for every failure, further rounds, merge after those two branches. Not done in it: audit finding 4's demos, finding 8 (notifier identity), a start that fails under the pumped loop. For the owner: the default backdrop colours; the chrome's close button hiding; `showOnReady` as the default |
| `rust-rewrite-api-audit` | The before and after of the public API by the TypeScript compiler | **merged**: `checks/api-diff.ts`; its report and dumps are kept on the machine with the run output, outside git | its findings are work: 5 changes the guide misstated (C1 to C5), 4 internals an application was sent to (I1 to I4: the guide now says `no public call in 1.0` for each), 10 capabilities with no public call (K1 to K10). Public calls for them are the owner's to name |

## The real applications (requirement R2)

Two real applications are being upgraded in place, each on a branch of its own repository. Their names, paths and results are in `rust-rewrite/local/` and nowhere tracked (R6). By the owner's word the upgrade is a migration: each uses 1.0 as designed, a closed window is destroyed and its memory given back, windows are revealed by the ready signal, and nothing of the old library's behaviour or internals is carried over.

- Both have the migration committed and pushed on their branches.
- Neither has been run through its features with real input and screenshots since the migration. The earlier runs were of the first, non-migrated upgrade and no longer count.
- Both are linked to this checkout. The public calls of `rust-rewrite-api-gaps` are on the main branch since `9335594`.
- The `dependents` check of `verify.ts` still passes with "nothing to verify", because `rust-rewrite/local/dependents.txt` was never written. `OWNER-ACTIONS.md` section 3 and decision D19 described upgrading a copy in the temp directory, which the owner has since ruled out; each now carries a dated note that the applications are upgraded in place on branches and no copy is made (on `rust-rewrite-no-win32-subpaths`, not merged).

## Found: the rewrite put the webview inside the native package

The packages are organised so that an application takes only what it uses: a tray application takes the native package and no webview. The rewrite broke that. At tag `pre-rust-rewrite` the native package's index exported no webview and the package depended on the settings package only; the webview was reached by the facade through the separate bindings package. Now the native package's index exports the webview class, the input hooks and `permissions`, and the one Rust binding it ships contains the webview engine. A tray-only application (`demos/menubar-only`), run on Windows, starts no WebView2 process and loads no WebView2 module, but its package, its bundle and its binary carry the webview code; on macOS, importing the native package evaluates the old bindings package when it is installed. The rewrite followed the proposal's "Packaging" section in this; the owner's organisation of the packages outranks it.

To do: the webview leaves the native package, so that an application importing only the native package installs, bundles, loads and ships no webview code, with the eight packages exactly as organised. No separate design step: the work is queued to the author of `rust-rewrite-fix-webview-behaviour`, to start when the Windows webview rebuild on that branch is reported (two bindings; the webview back behind the facade package as at the tag; the input hooks and `permissions` stay in the native package). Its proofs: the bundle of `demos/menubar-only` holds no webview module, and the binding the native package ships holds no WebView2 symbol.

## The audit's findings: done, and not started

| Audit finding | Done, and where | Not started |
|---|---|---|
| 1 and 14 | The upgrade guide as a migration to 1.0 (D45, `rust-rewrite-no-win32-subpaths`): close disposes and a tray application declares `closeToTrayOnLastWindow`; `showOnReady` with `signalReady()` and `readyTimeoutMs`; `contentSize`; the old teardown lines and `unload()` deleted on Windows; a message loop of the application's own is `app.run()` or `runEventLoop()`; the rows for calls that do nothing on Windows say so; a short list of what changes, in the order an application meets it, comes first. `rust-rewrite/compat/behaviour.test.ts` asserts the 1.0 forms. The tray demos and the desktop pet start on the ready signal and close to the tray, off macOS | the audit's section 3 items it marks as gaps (15, 16, 24, 26, 27); item 25 (an application whose start fails ends by itself) has no library way; item 28 stays (checklist item W3.5) |
| 2 | Internals (D45): no document, demo or guide row sends an application to an internal entry, on Windows or macOS; each such capability's row says `no public call in 1.0`; a guard test keeps it so | a public call for any of them (the owner's to name); a public way to receive what applications used their own message window for |
| 4, the rest | `closeToTrayOnLastWindow` is the one close-to-tray recipe in the guide, the pages and the demos | a close policy declared once on `createApp`; an application whose start fails ends by itself, outside the pumped-loop case |
| 5, the rest | | a fatal start-up error a person can see in a packaged application with no console |
| 8, the rest | | a `Notifier` that takes the application's identity and never shows as "Sweetview" |
| 9 and 10 | | the window layer's duplicated mechanisms (two popup menus, two resize gestures); `sweetview-runtime` as one 5,700-line crate; safe logic in crates where `unsafe` is allowed; the clipboard's 13 uses |
| 13 | | features never seen working: a real change of display scale or a second monitor, Explorer restarting under a tray icon, a toast clicked from the notification centre |
| 15 | The smaller regressions the audit lists (a nested `pumpEvents()`, calls that now throw from a `Worker`, `tab.webview.window` after tear-off, `Screen.of` on a minimised window, no ARM64 binding, the tab strip's keyboard access, four stale doc pages) are the work of `rust-rewrite-fix-regressions`, landing now; the guide's `pumpEvents` rows say the nested-pump rule is Windows' | |

## Stale or wrong in the documents, found on a full read

- `rust-rewrite-fix-quit-flash` writes its decision as D42, a number the main branch has used since; it renumbers when it merges (the main branch has D44, D45 and, landing now, D46).
- Checklist item W0.6 rests on a hosted CI run, which D33 no longer allows (`OWNER-ACTIONS.md` section 8).
- The run output the checklist items cite (kept on the machine, outside git) and the blocks under the items were produced before everything listed above.

## What a completion claim needs

1. Every branch above merged, each after a report and a review.
2. The audit's findings each fixed or answered under "Answers" in its report (kept on the machine with the run output, outside git).
3. Both real applications run through their features with real input and screenshots on the final tree, and the `dependents` check counting them.
4. The evidence files and checklist blocks produced again on the final tree.
5. The three printouts of `GOAL-windows.md` after the last commit, ending `SWEETVIEW-REWRITE WINDOWS: COMPLETE mode=full`.

## Defaults taken, by the owner's word that nothing is asked

Each is a choice made so the work goes on; the owner overturns any of them with a word.

- **The eight packages stay exactly as they are organised. This is the owner's ruling, not a default: no package is merged into another, and no code moves between packages.** (A default written here earlier, to make Sweetview one package, was wrong and is withdrawn; nothing was done under it.) So the entries the packages use to reach one another (`/internal`, `/win32/*`) stay, for Sweetview's own packages only: no document, guide row, demo or example sends an application to one, a guard test pins the list by name, and none is turned into public API. That is what branch `rust-rewrite-no-win32-subpaths` delivers.
- **`onCallbackError` reports the native package's callbacks and the raw webview's; the facade's own catches are not reported**, and the pages say so. Its name and shape stay as built.
- **A capability that was reachable only through internals gets no public call**, and the guide says so for each.
- **Where `wry` and the old library differ, the old library's behaviour wins** (zoom, pinch and swipe on; no bound on a streamed body's backlog; focus only for a window Sweetview owns).
- **A call that existed before the rewrite keeps its behaviour**: `showOnReady` stays opt-in, the page chrome's close button still hides, a pumped loop does not end by itself. The demos use `showOnReady`.
- **A window with no `backgroundColor` shows its `appearance` colour, not white**, where nothing has painted: the white window at start and at Quit is the defect being fixed.
- **The binding stays built on demand** (D34), and checklist item W0.6 stays as recorded (D33).

## Decisions the owner can still make

- **Capabilities that were reachable only through internals and have no public call** (rows I1 to I4 and K1 to K10 of the public API audit, a report kept on the machine with the run output, outside git): an `HMENU` for an application's own `TrackPopupMenu`; the strip and page rectangles of a tabbed frame; a timer or job that runs inside the native and modal loops; whether the system is in dark mode; a webview at given bounds inside an application's own window; an activation event and a foreground query; a close request as the title bar's button makes it; the navigation-failed event, the new-window handler and the DevTools protocol; the strip height. By the ruling that internals are never exposed, none gets a public call unless the owner names it.

- Finding 12: track the prebuilt binding in git, or keep building it on demand (D34).
- W0.6: the hosted run stands as a record, or the item is unticked (D33).
- `showOnReady` as the default for a window with a page, and whether a loading placeholder exists.
