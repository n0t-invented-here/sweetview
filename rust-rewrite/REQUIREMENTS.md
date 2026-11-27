# Requirements

These hold for every goal alike. When two documents disagree, the order of authority is: this file, then the checklist for the goal being run, then `GOAL-<platform>.md`, then `SWEETVIEW-RESTART-PROPOSAL.md`.

The work is three goals, run one after another, each on its own machine:

1. Windows: `CHECKLIST-windows.md`. Also holds the work that is the same on every OS: the binding's boundary, the logic crates, the IPC transports for Tauri 2 and Electron.
2. macOS: `CHECKLIST-macos.md`.
3. Linux: `CHECKLIST-linux.md`. Sweetview has no Linux support today, so this goal adds a minimum and ports nothing.

Nothing in the proposal's order of work is outside these three checklists.

Each requirement has a check. A requirement counts as met only when its check has been run and its output is in the session.

## What the rewrite is for

Take Sweetview as it stands on branch `v1-rust-rewrite` and end with the same product, where the native layer is no longer TypeScript calling the OS through `bun:ffi`:

- Native code is written in Rust, in a well-organised set of crates that a maintainer can read, test and change.
- Everything that can reasonably be memory safe is memory safe. What cannot is small, contained and justified.
- A small amount of FFI that is needed to set things up is acceptable. A layer of it is not.
- No functionality is lost, and every existing application has a clear way to upgrade.

Rust that repeats the old code as `unsafe` blocks misses the purpose as much as leaving it in TypeScript does.

## R1. No functionality is removed

Every capability that works on branch `v1-rust-rewrite` at tag `pre-rust-rewrite` works afterwards. That covers three bodies of code:

- Sweetview itself: every export of the six packages under `packages/`, with the behaviour `docs/` describes, on the platform the goal covers.
- The Bun bindings, `n0t-invented-here/sweetview-webview-bun` branch `v1-drafting`: every export of `src/index.ts`, including `installMouseHook`, `installKeyboardHook`, `permissions`, the worker functions, and every `Webview` method. `rust-rewrite/reference/bindings-exports.txt` lists them. Sweetview re-exports three of them today; applications import the rest, the input hooks among them, from the bindings package itself, so each needs a home in a Sweetview package.
- The C++ library, `n0t-invented-here/sweetview-webview` branch `v1-drafting`: every addition listed in its `sweetview/README.md`, with the per-platform behaviour its pages state.

Rules that follow from it:

The requirement is on what an application can do, not on how the API spells it:

- The API may change. A name, a signature, a module boundary, a constant an application can observe (an origin, an error code, a message text, a limit, a wire format) may change where the new design is better for it. Each change costs existing applications an upgrade step, so each has a reason and a row in `docs/upgrading.md` (R2).
- No capability goes with the change. Whatever an application could do before, it can do after: the same behaviour reached through the new form.
- A behaviour with no ready-made crate API is written by this project in Rust. "No crate has it" is never a reason to leave it out.
- An application can still get the real OS window handle (`HWND` on Windows, the `NSWindow` pointer on macOS), because applications pass it to their own native calls.
- An application's own `bun:ffi` calls on the UI thread, including its own modal dialogs and popup menus, keep working inside Sweetview's event loop.
- Both ways of running the loop stay available: the blocking loop, and the loop pumped from a Bun timer.
- An existing test keeps what it proves. Where the API it calls changed, the test is rewritten for the new form and still asserts the same behaviour. A test is deleted only when the thing it tested is `bun:ffi` plumbing that no longer exists.

Check: `bun rust-rewrite/verify.ts <platform>` passes its `tests`, `demos` and `api-surface` checks, and every item of the platform checklist carries its evidence. The `api-surface` check accepts an export that is gone when `docs/upgrading.md` has a row for it.

## R2. Every existing application has an upgrade path

Three kinds of application exist: those on the published `@n1h/sweetview` 0.1.x and 0.2.x with `@n1h/sweetview-webview-bun` 2.x, those on the `v1-drafting` API, and those that import the bindings package directly.

- `docs/upgrading.md` maps every export of each of those three API surfaces to what an application writes after the rewrite. One row per export. No row says "removed".
- The guide covers applications that imported Sweetview's internal modules by file path, and names the public call that replaces each such use.
- Each row is exercised by code under `rust-rewrite/compat/`: a test that imports the new form and runs it. The compat tests run in `bun test`.
- When `rust-rewrite/local/dependents.txt` exists, it lists local paths of real applications, one per line. For each: copy the application to the system temp directory, apply the guide to the copy, run that application's own typecheck, tests and build, and write the outcome to `rust-rewrite/local/dependents-result.md`. The original checkout is read, never changed.

Check: the `upgrade-guide` and `dependents` checks of `verify.ts`.

## R3. No `bun:ffi` in Sweetview

Sweetview's packages make no `bun:ffi` call on the platform the goal covers. `rust-rewrite/reference/ffi-files.md` is the list of files that do today.

- An import counts: `import`, `import type`, a dynamic `import()` or a `require` of `bun:ffi`. A comment that mentions it does not.
- `rust-rewrite/ffi-allowlist.txt` holds any file that still imports `bun:ffi`, one per line as `path<TAB>reason`. The Windows goal ends with only macOS-only files, probes and setup entries in it. The macOS goal ends with probes and setup entries only.
- Tests and probe scripts that drive real OS input may import `bun:ffi`; they are listed with a reason that starts `probe:`.
- A small amount of FFI that is needed to set things up is acceptable. Such a file is listed with a reason that starts `setup:` and says what it sets up and why N-API cannot. At most three files; more than that is a layer.
- An application's own `bun:ffi` use is its own and is not counted.

Check: the `ffi` check of `verify.ts`.

## R4. Well-organised Rust, memory safe wherever it reasonably can be

Native code lives in a set of Rust crates with clear boundaries, each with one job, that a maintainer can read, test and change. It is safe Rust wherever a safe API exists, and disciplined Rust where none does. Moving the same unchecked calls from TypeScript into `unsafe` blocks does not meet this requirement.

How many crates there are and where their boundaries fall is decided by the work and recorded in `rust-rewrite/DECISIONS.md`. A crate has one job that a maintainer can state in a sentence.

`UNSAFE-POLICY.md` is the rule. In short: a safe crate API is used when one exists; `unsafe` lives only in the platform crates; every `unsafe` block does one thing, sits inside a safe function whose types carry the invariant, and has a `SAFETY:` comment; every OS resource has an owning type that frees it on drop.

Check: the `cargo`, `unsafe` and `clippy` checks of `verify.ts`, plus the review item at the end of the checklist.

## R5. The crates

- `tao` for windows and the event loop, `wry` for the webview, `muda` for menus, `tray-icon` for the tray, `rfd` for dialogs, `napi` with `napi-derive` for the Bun boundary.
- `windows`, `webview2-com`, `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-user-notifications`, `objc2-core-graphics`, `block2` for what this project writes itself.
- A fork of `wry`, as `FORKS.md` records it. A change that fits upstream's design is written so it can be offered upstream.
- These crates are the design the proposal settled on, not a requirement in themselves: where building shows that one of them cannot carry a behaviour R1 requires, the design is adjusted.
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

- The Windows goal does its best to leave things ready for the other platforms: shared Rust is written for all three from the start, with platform code behind `cfg(target_os)`, and `cargo check --target aarch64-apple-darwin` is run and its result recorded in `HANDOFF-macos.md`.
- During the Windows goal, macOS keeps running on the existing code. The native package already picks an implementation per OS in `packages/sweetview-native/src/platform.ts`, so its `darwin/` folder stays as it is. The three shared files in `packages/sweetview/src/` that hold FFI for both platforms get one seam between the Windows path and the macOS path, and the macOS path keeps today's code behind it.
- The macOS goal leaves every Windows check passing.

Check: `bun test` on the other platform's non-live tests where a machine for it is available; otherwise the `cargo check` result above and a diff summary of shared files.

## R9. When to stop

The goal stops early in one case: something turns out to have been completely wrong, and no sensible adjustment of the design stays inside the requirements above. Adjusting the design is the first answer; stopping is what is left when no adjustment works. Then:

1. Write `rust-rewrite/BLOCKED.md`: the requirement, what was built and observed, each design tried and why it fails, and what change to the requirements would unblock it.
2. Print that file in the session, then the single line `SWEETVIEW-REWRITE <PLATFORM>: BLOCKED`.

A hard problem, a failing test, a missing crate feature, or a slow build is not that case. Those are solved inside the requirements.
