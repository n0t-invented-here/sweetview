# Status of the Windows goal

The Windows goal is **not complete**. This file says what is on the main branch, what sits on unmerged branches, what has not been started, and what a completion claim still needs. It is updated whenever a branch lands or work stops. Requirements: `REQUIREMENTS.md`. Order of work: `CHECKLIST-windows.md`. Findings this status is measured against: `evidence/goal-audit-windows.md` (15 findings and 28 places that teach the old way).

## The owner's rulings that bind all remaining work

- **Internals are never exposed for an application to call.** No `/internal`, `/win32/*` or other internal entry point is importable by an application, no document tells an application to use one, and no internal is turned into public API to close a gap.
- **Agents make no tradeoff about the product.** Whether a capability gets a public call, its name and shape, and whether a capability reached through internals is kept, are the owner's decisions. Work that reaches such a choice leaves the item as it is and lists it for the owner with the facts.
- **No workaround, and excellent code only.** A problem is fixed at its cause.
- **Everything slated for 1.0 is in scope and is delivered**: every feature `docs/` describes, every `v1-drafting` feature in `reference/`, and what an application needs to migrate without internals. Nothing is dropped because older releases lacked it. No time goes to a capability that none of those call for.
- **Nothing is announced as done without several rounds of adversarial review.** The required reviewers are Codex (GPT-6.2 Sol, high) and Antigravity (Gemini 4 Neon, high). A final completion needs a full review by Neon.
- **Reviews and audits judge the intent**, not literal readings that serve nobody.
- **An upgrade is a migration.** An upgraded application uses 1.0 as designed: a closed window is destroyed and its memory given back, windows are revealed by the ready signal, and no old behaviour, workaround or internal is carried over.
- **An application ends at its loop.** Nothing after `run()` is required of it.
- **No copies of the owner's applications** are made anywhere; they are upgraded in place on branches. Their names, paths and behaviour never enter anything tracked here.
- **Hosted CI is not used.**
- **The orchestrating session writes no code**; it delegates, integrates and documents.

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

## Unmerged branches

One line of state each. "Reported" means the agent that wrote it gave a final report with its test results; "reviewed" means someone other than its author read it.

| Branch | Holds | State | Left to do |
|---|---|---|---|
| `rust-rewrite-api-gaps` | Public calls the real upgrades needed: `Window#isMinimized`, `Menu.popup` `above`, `contentSize`, `backgroundColor`, `onMaximizeChange`, `showSystemMenu`, `windowChromeEvents` (D43) | first part merged into the main branch after a full run of the checks on the merged tree (`cargo test` all passed; `bun test` 510 pass, 20 skip, 0 fail); **review round 1: FAIL from both required reviewers** (Sol: 8 must-fix; Neon: 7 must-fix, 2 should-fix; they agree on the system menu on frameless windows, `contentSize` overflow and the changed tab default, the backdrop lost on tear-off, and macOS code changed against D42) | round 1's fixes are on `rust-rewrite-api-review-fixes` (`c9e91fd`; `bun test` 521 pass, 18 skip, 0 fail). **Review round 2 of them: FAIL from both** (Sol: 9 must-fix; Neon: 4 must-fix, 2 should-fix). Held at the cause, by both: the `contentSize` overflow and the tab default; a maximised frameless window dragged away; the probe and the guide rows. Still wrong: the system menu on a window Sweetview did not make and on a minimised frameless window, and what it does when the window's state changes while the menu is open; the webview's start-up colour passed through a new internal export and shared state; a first adoption while minimised; macOS differences in the pet demo's title bar. Round 3 of fixes is in progress, each defect fixed for its whole class; then review round 3. Second part is one `wip` commit, half written, never built: a window with a page created under the blocking `run()`, hook latency under `runEventLoop`, `Menu` is-open and close, autoplay and browser arguments |
| `rust-rewrite-no-win32-subpaths` | Internals stop being importable: `/internal` and `/win32/*` leave the package `exports`, Sweetview's own packages stop needing them across a package boundary, and no document sends an application to one. Adds no public call | reported (head `ba5e2bd`), checks passed on it (`bun test` 515 pass, 20 skip, 0 fail). **Nothing left the `exports` map.** Done: the repository's tests reach internals by relative path; three guide rows and the menus page name `Menu.popup` and `Window#showSystemMenu` in place of a subpath; a guard test pins every internal entry, cross-package import, guide row and page line that remains, by name. Stopped, by the owner's rulings: the facade package (`createApp`, `WebView`, tabs, the worker wake) needs about thirty internals of the native package across the package boundary, and every arrangement that removes that either adds exports or restructures the packages | the owner's decision on how the packages are arranged (below); review; merge |
| `rust-rewrite-fix-callback-errors` | `onCallbackError`, one listener for every exception caught at a callback boundary (D44) | merged with the main branch, all checks passed on it (`bun test` 519 pass, 20 skip, 0 fail). **Review round 1: FAIL from both required reviewers** (Sol: 6 must-fix, 2 should-fix; Neon: 6 must-fix, 3 should-fix). Both judged it a real 1.0 need. They agree on: a worker can take the UI thread by registering first; reporting can itself throw and cut a fallback short; the window chrome mutates the application's exception; one worker crash is reported twice; the raw webview's callbacks are not reported; eleven macOS files edited against R8 and D42 | round 1's fixes are pushed (`f29d786`), every finding reproduced by a failing test and fixed or made moot; **review round 2 by both required reviewers is running**. What the fixes cost: the reporter is no longer reachable through `./internal`, so the facade package cannot reach it, and **the faults of `createApp`'s own callbacks (page calls, requests, the ready hooks, the worker) are not reported to a listener**; only the native package's callbacks and the raw webview's are. Closing that depends on how the packages are arranged (the owner's decision below). On macOS no listener is called until the macOS goal. Its author's full run had 2 failures of 556 (two tray-menu timeouts that passed when run alone, while other sessions were using the desktop): a clean full run is required before merge. Defects of the main branch its author found and did not change: a `deferredUiMethods` handler that throws a value that cannot be converted to a string breaks its batch loop; a worker crash is printed by two paths; four tab callbacks end in `.catch(console.error)`. The public name and shape of `onCallbackError` are the owner's to confirm |
| `rust-rewrite-fix-webview-behaviour` | Audit findings 6 and 7: WebView2's own page behaviour restored (zoom, pinch, swipe, status bar, `app-region`); a streamed body's `Read` returns at once, with a backlog bound (D45) | reported, merged with the main branch, checks passed on it; its real-input run passed (Ctrl+wheel zoom, `app-region`, an in-page drag, a real drag out of Explorer delivering the file's path). Its author read the old C++ source: a streamed body reached the page only at its end before the rewrite too, and Microsoft's reference says WebView2 needs the whole body by the time the deferral completes, so streaming on Windows is as it was. **Review round 1: FAIL from both; round 2 (on `2155748`): FAIL from both.** What holds at the cause, by both: the stream writer, the `Read` contract, the uninitialised buffer. What does not: `wry` 0.58.2's Windows creation path registers handlers it gives no way to remove (it destroys the container on `window.close()`, marks every download handled and sets its path, writes the profile's autofill setting, subclasses a window it was given and moves focus into the page), and the round 1 fixes routed around them. **Design adjustment under R5, taken because the owner's ruling excludes workarounds: on Windows the container window and the WebView2 controller are created and owned by `sweetview-platform-webview` through `webview2-com`, following the old C++ library's creation path step by step, and the Windows webview is no longer built through `wry`.** Both reviewers named this as the fix at the cause. In progress. Its author removed a piece it had finished (pacing of a streamed body on the worker path, commit `3513b39`) because it needed two new internal exports; that commit stays in the branch's history | the redesign, its tests for every difference the reviewers listed, review round 3; then merge. For the owner: zoom, pinch and swipe on as the old library had them or off as `wry` sets them; the 1 MiB wait for a writer off the UI thread, where the old library never waited; whether the worker-path pacing comes back in a form that exposes nothing |
| `rust-rewrite-fix-quit-flash` | The white window at Quit; a window leaves the screen before its webview goes; backdrop colour; demos reveal on the ready signal; a pumped loop ends when nothing is reachable (its own D42, to renumber) | reported (head `6ec0f7b`, merged with the main branch). Cause found: at the end of `run()` the webview was destroyed while its window was still on screen, and the window's empty area showed white until the process ended. Fix: every path hides the window, then destroys its webviews, then the window; a window has one colour and its webview starts in it. Measured by a second process sampling the screen once per displayed frame: 0 white frames in every demo after, 1 or 2 before. Every path that closes a window was measured over 30 rounds: a close request with no listener, `dispose()`, `app.dispose()` and a closed tab all destroy the window and give back its objects; `closeToTrayOnLastWindow`'s last window and the page chrome's close button still hide. Its author took out two things it had added (`Window.close()`, a pumped loop ending by itself) as the owner's to decide. **Not ready for review**: an access violation when WinRT's `UISettings` is created in the runtime's release test, which the main branch's tabbed windows with `appearance: "system"` can also reach, is unexplained; one flake of its screen-sampling test is unexplained; the full suite was not run on its head | the cause of the access violation and of the flake; a full run with 0 failures; then review by both required reviewers. Not done in it: audit finding 4's demos, finding 8 (notifier identity), a start that fails under the pumped loop. For the owner: the default backdrop colours; the chrome's close button hiding; `showOnReady` as the default |
| `rust-rewrite-api-audit` | The before and after of the public API by the TypeScript compiler | **merged**: `evidence/api-audit.md`, its dumps and `checks/api-diff.ts`; a report, no product code | its findings are work: 5 changes the guide misstates (C1 to C5), 4 internals an application is sent to with no public call (I1 to I4), 10 capabilities with no public call (K1 to K10). Its "What should change" proposes public calls for internals; by the owner's ruling none is added without the owner's word, so those rows are decisions for the owner |

## The real applications (requirement R2)

Two real applications are being upgraded in place, each on a branch of its own repository. Their names, paths and results are in `rust-rewrite/local/` and nowhere tracked (R6). By the owner's word the upgrade is a migration: each uses 1.0 as designed, a closed window is destroyed and its memory given back, windows are revealed by the ready signal, and nothing of the old library's behaviour or internals is carried over.

- Both have the migration committed and pushed on their branches.
- Neither has been run through its features with real input and screenshots since the migration. The earlier runs were of the first, non-migrated upgrade and no longer count.
- Both are linked to this checkout and need the public calls of `rust-rewrite-api-gaps` on the main branch before they build against it.
- The `dependents` check of `verify.ts` still passes with "nothing to verify", because `rust-rewrite/local/dependents.txt` was never written. `OWNER-ACTIONS.md` section 3 and decision D19 still describe upgrading a copy in the temp directory, which the owner has since ruled out: the applications are upgraded in place on branches and no copy is made.

## Not started

| Audit finding | What |
|---|---|
| 1 and 14 | `docs/upgrading.md` and `rust-rewrite/compat/` rewritten as a migration to 1.0, not a rebuild of 0.x; the 28 places of the audit's section 3; rows that say "unchanged" for things that are gone |
| 2, the rest | The internal subpaths (`/internal`, `/win32/*`) still exported and still named by the guide; a public way to receive what applications used their own message window for |
| 4, the rest | A close policy declared once (close to tray); an application whose start fails ends by itself, outside the pumped-loop case |
| 5, the rest | A fatal start-up error a person can see in a packaged application with no console |
| 8, the rest | A `Notifier` that takes the application's identity and never shows as "Sweetview" |
| 9 and 10 | The window layer's duplicated mechanisms (two popup menus, two resize gestures); `sweetview-runtime` as one 5,700-line crate; safe logic sitting in crates where `unsafe` is allowed; the clipboard's 13 uses |
| 13 | Features never seen working: a real change of display scale or a second monitor, Explorer restarting under a tray icon, a toast clicked from the notification centre |
| 15 | The smaller regressions the audit lists (a nested `pumpEvents()`, calls that now throw from a `Worker`, `tab.webview.window` after tear-off, `Screen.of` on a minimised window, no ARM64 binding, the tab strip's keyboard access, four stale doc pages) |

## Stale or wrong in the documents, found on a full read

- `HANDOFF-macos.md` section 3.1 still lists `SetTimer`, `KillTimer` and `dispatch_due_timers`, which D38 removed, and omits `stop_ticker_if_idle`.
- Three branches each wrote a decision under a number another branch also took (D42, D43); each renumbers when it merges.
- Checklist item W0.6 rests on a hosted CI run, which D33 no longer allows (`OWNER-ACTIONS.md` section 8).
- The evidence files under `rust-rewrite/evidence/w*.txt` and the blocks under the checklist items were produced before everything listed above.

## What a completion claim needs

1. Every branch above merged, each after a report and a review.
2. The audit's findings each fixed or answered under "Answers" in `evidence/goal-audit-windows.md`.
3. Both real applications run through their features with real input and screenshots on the final tree, and the `dependents` check counting them.
4. The evidence files and checklist blocks produced again on the final tree.
5. The three printouts of `GOAL-windows.md` after the last commit, ending `SWEETVIEW-REWRITE WINDOWS: COMPLETE mode=full`.

## Owner's decisions outstanding

- **How internals are sealed.** `@n1h/sweetview` reaches about thirty internals of `@n1h/sweetview-native` through `/internal` and `/win32/*`, so those entries cannot leave the `exports` map while the two are separate packages. The ways out: one package with its internals sealed; or `createApp`, `WebView`, the tabs and the worker wake moved into the native package; or the entries kept, with the guard test and no document naming them.
- **Capabilities that were reachable only through internals and have no public call** (`evidence/api-audit.md`, rows I1 to I4 and K1 to K10): an `HMENU` for an application's own `TrackPopupMenu`; the strip and page rectangles of a tabbed frame; a timer or job that runs inside the native and modal loops; whether the system is in dark mode; a webview at given bounds inside an application's own window; an activation event and a foreground query; a close request as the title bar's button makes it; the navigation-failed event, the new-window handler and the DevTools protocol; the strip height. By the ruling that internals are never exposed, none gets a public call unless the owner names it.

- Finding 12: track the prebuilt binding in git, or keep building it on demand (D34).
- W0.6: the hosted run stands as a record, or the item is unticked (D33).
- `showOnReady` as the default for a window with a page, and whether a loading placeholder exists.
