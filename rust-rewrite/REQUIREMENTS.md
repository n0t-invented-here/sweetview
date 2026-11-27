# Requirements

These hold for the Windows goal and the macOS goal alike. When two documents disagree, the order of authority is: this file, then the checklist for the goal being run, then `GOAL-<platform>.md`, then `SWEETVIEW-RESTART-PROPOSAL.md`.

Each requirement has a check. A requirement counts as met only when its check has been run and its output is in the session.

## R1. Nothing is removed

Everything that works on branch `v1-rust-rewrite` at tag `pre-rust-rewrite` works afterwards. That covers three bodies of code:

- Sweetview itself: every export of the six packages under `packages/`, with the behaviour `docs/` describes, on the platform the goal covers.
- The Bun bindings, `n0t-invented-here/sweetview-webview-bun` branch `v1-drafting`: every export of `src/index.ts`, including `installMouseHook`, `installKeyboardHook`, `permissions`, the worker functions, and every `Webview` method.
- The C++ library, `n0t-invented-here/sweetview-webview` branch `v1-drafting`: every addition listed in its `sweetview/README.md`, with the per-platform behaviour its pages state.

Rules that follow from it:

- A behaviour with no ready-made crate API is written by this project in Rust. "No crate has it" is never a reason to leave it out.
- A value an app can observe stays the same: `assetOrigin` and `framesOrigin` on each platform, error codes of `WebviewError`, error message texts that `docs/` quotes, limits such as title and body lengths, wire formats such as the single-instance window class, mutex name, `WM_COPYDATA` magic and port name.
- Window handles the API exposes (`Window.handle`, `Webview.unsafeWindowHandle`) stay the real `HWND` on Windows and the real `NSWindow` pointer on macOS, because applications pass them to their own native calls.
- An application's own `bun:ffi` calls on the UI thread, including its own modal dialogs and popup menus, keep working inside Sweetview's event loop.
- Both ways of running the loop stay: the blocking loop, and the loop pumped from a Bun timer.
- An existing test is changed only where it reaches into `bun:ffi` plumbing that no longer exists, and then its assertions stay.

Check: `bun rust-rewrite/verify.ts <platform>` passes its `tests`, `demos` and `api-surface` checks, and every item of the platform checklist carries its evidence.

## R2. Every existing application has an upgrade path

Three kinds of application exist: those on the published `@n1h/sweetview` 0.1.x and 0.2.x with `@n1h/sweetview-webview-bun` 2.x, those on the `v1-drafting` API, and those that import the bindings package directly.

- `docs/upgrading.md` maps every export of each of those three API surfaces to what an application writes after the rewrite. One row per export. No row says "removed".
- The guide covers applications that imported Sweetview's internal modules by file path, and names the public call that replaces each such use.
- Each row is exercised by code under `rust-rewrite/compat/`: a test that imports the new form and runs it. The compat tests run in `bun test`.
- When `rust-rewrite/local/dependents.txt` exists, it lists local paths of real applications, one per line. For each: copy the application to the system temp directory, apply the guide to the copy, run that application's own typecheck, tests and build, and write the outcome to `rust-rewrite/local/dependents-result.md`. The original checkout is read, never changed.

Check: the `upgrade-guide` and `dependents` checks of `verify.ts`.

## R3. No `bun:ffi` in Sweetview

Sweetview's packages make no `bun:ffi` call on the platform the goal covers. `rust-rewrite/reference/ffi-files.md` is the list of files that do today.

- `rust-rewrite/ffi-allowlist.txt` holds any file that still imports `bun:ffi`, one per line as `path<TAB>reason`. The Windows goal ends with only macOS-only files in it. The macOS goal ends with it empty.
- Tests and probe scripts that drive real OS input may import `bun:ffi`; they are listed too, with that reason.

Check: the `ffi` check of `verify.ts`.

## R4. Memory safety is the point

The result is safe Rust wherever a safe API exists, and disciplined Rust where none does. Moving the same unchecked calls from TypeScript into `unsafe` blocks does not meet this requirement.

`UNSAFE-POLICY.md` is the rule. In short: a safe crate API is used when one exists; `unsafe` lives only in the platform crate; every `unsafe` block does one thing, sits inside a safe function whose types carry the invariant, and has a `SAFETY:` comment; every OS resource has an owning type that frees it on drop.

Check: the `cargo`, `unsafe` and `clippy` checks of `verify.ts`, plus the review item at the end of the checklist.

## R5. The crates

- `tao` for windows and the event loop, `wry` for the webview, `muda` for menus, `tray-icon` for the tray, `rfd` for dialogs, `napi` with `napi-derive` for the Bun boundary.
- `windows`, `webview2-com`, `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-user-notifications`, `objc2-core-graphics`, `block2` for what this project writes itself.
- Forks of `wry` and `tray-icon`, as `FORKS.md` records them. A change that fits upstream's design is written so it can be offered upstream.
- A different crate is allowed where it serves R1 and R4 better. The reason is recorded in `rust-rewrite/DECISIONS.md` in one paragraph.
- The C++ library and the `@n1h/sweetview-webview-bun` dependency are gone from a platform when that platform's goal completes.

Check: `cargo metadata` output in the session for the first; the `engine` check of `verify.ts` for the last.

## R6. Private applications stay private

Applications that depend on Sweetview live in private repositories. Nothing about them is written into this repository, a fork, a commit message, a branch name, a tag, an issue or a pull request: not their names, not their paths, not their code, not a description of what a particular one does.

- Requirements learned from them are written as general requirements with no source, as R1 does.
- `rust-rewrite/local/` is ignored by git. Paths and results concerning those applications go there and nowhere else.
- Tracked files hold no machine-local absolute path. Other repositories are named as `owner/repo`.

Check: the `privacy` check of `verify.ts`, and `git log` of the session's commits shown before the final verification.

## R7. Process

- Work happens on branch `v1-rust-rewrite` of `n0t-invented-here/sweetview`, committed and pushed at each completed checklist item.
- Tag `pre-rust-rewrite` marks the tree before the first change. It is created once and never moved.
- Fork changes go on the branch `FORKS.md` names in each fork, pushed to that fork.
- Files generated by APM are left alone: `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `.agents/`, `.mcp.json`, `apm.yml`, `apmm.yml`, `apm.lock.yaml`, `apm_modules/`.
- These need the owner and are recorded in `rust-rewrite/OWNER-ACTIONS.md` instead of being done: publishing to npm, opening a pull request or issue on a repository the owner does not own, rewriting pushed history, deleting a branch that is not fully merged, changing a private application's repository.

Check: `git status -sb` and `git log --oneline pre-rust-rewrite..HEAD` in the session.

## R8. One platform does not break the other

- During the Windows goal, macOS keeps working on the existing code: its files are untouched except where a shared file must change, and a shared file changes only in a way that leaves the macOS path as it was.
- Shared Rust is written for both platforms from the start, with platform code behind `cfg(target_os)`. `cargo check --target aarch64-apple-darwin` is run during the Windows goal and its result recorded in `HANDOFF-macos.md`.
- The macOS goal leaves every Windows check passing.

Check: `bun test` on the other platform's non-live tests where a machine for it is available; otherwise the `cargo check` result above and a diff summary of shared files.

## R9. When to stop

The goal stops early in one case: a requirement above cannot be met under any design that keeps the others. Then:

1. Write `rust-rewrite/BLOCKED.md`: the requirement, what was built and observed, each design tried and why it fails, and what change to the requirements would unblock it.
2. Print that file in the session, then the single line `SWEETVIEW-REWRITE <PLATFORM>: BLOCKED`.

A hard problem, a failing test, a missing crate feature, or a slow build is not that case. Those are solved inside the requirements.
