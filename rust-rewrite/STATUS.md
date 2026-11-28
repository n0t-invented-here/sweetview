# Status of the Windows goal

The Windows goal is **not complete**. This file says what is on the main branch, what sits on unmerged branches, what has not been started, and what a completion claim still needs. It is updated whenever a branch lands or work stops. Requirements: `REQUIREMENTS.md`. Order of work: `CHECKLIST-windows.md`. Findings this status is measured against: `evidence/goal-audit-windows.md` (15 findings and 28 places that teach the old way).

## The owner's rulings that bind all remaining work

- **Internals are never exposed for an application to call.** No `/internal`, `/win32/*` or other internal entry point is importable by an application, no document tells an application to use one, and no internal is turned into public API to close a gap.
- **Agents make no tradeoff about the product.** Whether a capability gets a public call, its name and shape, and whether a capability reached through internals is kept, are the owner's decisions. Work that reaches such a choice leaves the item as it is and lists it for the owner with the facts.
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
| `rust-rewrite-api-gaps` | Public calls the real upgrades needed: `Window#isMinimized`, `Menu.popup` `above`, `contentSize`, `backgroundColor`, `onMaximizeChange`, `showSystemMenu`, `windowChromeEvents` (D43) | first part merged into the main branch after a full run of the checks on the merged tree (`cargo test` all passed; `bun test` 510 pass, 20 skip, 0 fail); not reviewed by anyone but its author | a review of the first part. Second part is one `wip` commit, half written, never built: a window with a page created under the blocking `run()`, hook latency under `runEventLoop`, `Menu` is-open and close, autoplay and browser arguments |
| `rust-rewrite-fix-callback-errors` | `onCallbackError`, one listener for every exception caught at a callback boundary (its own D43, to renumber) | reported, tests passed on its branch; not reviewed | conflicts with the main branch in four files (`darwin/input.ts`, `app.ts`, `DECISIONS.md`, `HANDOFF-macos.md`); its macOS changes must be put behind the D42 seam; then merge |
| `rust-rewrite-fix-webview-behaviour` | Audit findings 6 and 7: WebView2's own page behaviour restored (zoom, pinch, swipe, status bar, `app-region`); a streamed body's `Read` returns at once, with a backlog bound (its own D44) | no final report; not reviewed | its real-input test (zoom, an in-page drag, a drop from Explorer) is opt-in and was not run; merge the main branch in; review; merge |
| `rust-rewrite-fix-quit-flash` | The white window at Quit; a window leaves the screen before its webview goes; backdrop colour; demos reveal on the ready signal; a pumped loop ends when nothing is reachable (its own D42, to renumber) | no report at all after eleven commits; not reviewed | a report with its measurements and its audit of closes that hide; merge the main branch in; review; merge. Audit findings 3, 4 and 8 were queued behind it and are only partly in it |
| `rust-rewrite-api-audit` | The before and after of the public API by the TypeScript compiler: the script and the three dumps | the report is not written | `evidence/api-audit.md` with its seven tables and "What should change" |

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

- Finding 12: track the prebuilt binding in git, or keep building it on demand (D34).
- W0.6: the hosted run stands as a record, or the item is unticked (D33).
- `showOnReady` as the default for a window with a page, and whether a loading placeholder exists.
