# Verify that the Windows rewrite left macOS working

This file is a prompt for an AI coding agent running on a Mac, in a checkout of `n0t-invented-here/sweetview`. Everything you need is in this file and the repository; nothing else about the work that produced it is available to you or needed.

## The situation

Sweetview is a set of Bun packages for desktop applications (windows, webviews, tray, notifications, native tabs). On branch `v1-rust-rewrite`, its Windows native layer was rebuilt in Rust. macOS was meant to stay exactly as it was at tag `pre-rust-rewrite`: the same TypeScript calling AppKit through `bun:ffi`, and the same C++ webview library from the optional peer package `@n1h/sweetview-webview-bun`. All of that work was done on Windows. **Nothing on this branch has ever been run on a Mac.**

Shared TypeScript did change, in ways that run on macOS: the public API was reshaped (one `Window` class, `WebView.attach`, `createApp`), a seam was put between the Windows and macOS paths in shared files, the demos were rewritten, and new behaviour (for example the release of everything at process exit) was added and then held back from macOS behind a predicate.

Your job answers one question, and a second for information:

1. **On macOS, at the head of `v1-rust-rewrite`, does everything that worked at `pre-rust-rewrite` still work, through the new API, running the old macOS code?**
2. For each behaviour held back from macOS: does it work on macOS when turned on? You report this; you do not turn it on in any commit.

You are verifying, not porting. You write no Rust, replace no `bun:ffi` call, and start no part of the macOS goal (`rust-rewrite/CHECKLIST-macos.md`); you neither tick nor edit its items.

## Read first, at the head of `v1-rust-rewrite`

Read these in full before running anything. They are the current truth; where this prompt and they disagree, they win, and you say so in the report.

- `rust-rewrite/REQUIREMENTS.md`, R1 and R8 above all ("During the Windows goal, macOS keeps running on the existing code").
- `rust-rewrite/HANDOFF-macos.md`: in full, the sections on where things stand, the TypeScript seams, the shared files and what must keep passing on Windows, and new behaviour held back from macOS (sections 1, 4, 6 and 8 at the time of writing; find them by title if renumbered). The other sections describe the Rust stand-ins for the later macOS port; consult them only when a finding touches them. The held-back section lists every held-back behaviour, its seam, what macOS does today, and what to run on a Mac before turning it on.
- `rust-rewrite/DECISIONS.md`: D18, D36, D42, and every later entry that mentions macOS or darwin (`grep -n -i -E 'macos|darwin' rust-rewrite/DECISIONS.md`).
- Finding 11 of the goal audit of the Windows work (macOS was changed on a machine that cannot run it) and its answer: the audit is a report kept outside git, so read them as `rust-rewrite/DECISIONS.md` D42 and section 8 of `rust-rewrite/HANDOFF-macos.md` record them.
- The root `README.md`, `docs/upgrading.md`, `docs/webview-library.md`, `docs/local-checkout.md`, and the pages under `docs/` and `docs/native/` for each capability you exercise.
- The macOS code: `packages/sweetview-native/src/darwin/`, `packages/sweetview/src/darwin-*.ts`, `packages/sweetview/src/tabs/darwin-*.ts`, and `packages/sweetview-native/src/platform.ts`.

The predicate that holds new behaviour back is `macosKeepsTagPath()` at the time of writing. If it has been renamed, the handoff names its successor; `git grep -n macosKeepsTagPath` (or the new name) finds every library seam, and the demos hold theirs in one `process.platform === "darwin"` block each.

## What you deliver

1. A report, in the shape given under "The report" below, saved as `rust-rewrite/evidence/verify-macos.md` on the Mac (that folder holds run output and is not in git) and given in full in your reply.
2. A fix for each regression you can prove and fix inside the authority below, one commit per fix.
3. All of it on branch `rust-rewrite-macos-verify`, cut from the head of `v1-rust-rewrite`, committed and pushed with `git push -u origin rust-rewrite-macos-verify`. Do not merge it and do not open a pull request; the owner of the repository does that.

Before you push, run `git diff --name-only origin/v1-rust-rewrite...HEAD`: it must list only the report and files inside the fix authority of step 10. Undo anything else before you push.

## Priorities

When they conflict, in this order:

1. Leave Windows and the repository's protected files exactly as they are (see "What you do not do").
2. Report what you observed, accurately: a capability you did not see working is "not exercised", never "works".
3. Find every regression of the macOS path, by comparison with the tag.
4. Fix the regressions you are allowed to fix.
5. Trial the held-back behaviours.

## Method

This is a behavioural contract, not a script. When a command or a file named here is gone or behaves differently, find the current way from the repository (the justfiles, `package.json` scripts, the docs at that commit), use it, and record what you did.

### 1. The Mac and its tools

Record: macOS version (`sw_vers`), chip (`uname -m`, `sysctl -n machdep.cpu.brand_string`), Bun (`bun --version`), Xcode command line tools (`xcode-select -p`, `clang --version`), `just --version`, `pwsh --version`, and, if you build the webview library, `cmake` and `ninja` versions. Use the same Bun for both commits.

The recipes in the `justfile`s run under PowerShell 7 (`set shell := ["pwsh", ...]`), at the tag and at the head. When `pwsh` or `just` is missing, install it with Homebrew if Homebrew is present and needs no password; when an install needs `sudo` or a password, put it on the list for the owner (see "When you are blocked") and run the recipe's commands directly meanwhile, saying so in the report. Rust is not needed for this work.

### 2. Two checkouts

In this checkout, `git fetch origin --tags`, then `git switch -c rust-rewrite-macos-verify origin/v1-rust-rewrite`; if that branch already exists on `origin` from an earlier run, switch to it instead, merge `origin/v1-rust-rewrite` into it, and build on its report. This checkout is "the head". Record `git rev-parse origin/v1-rust-rewrite pre-rust-rewrite`: the report names both commits, because the branch may have moved on since this prompt was written. Make a second, detached checkout of the tag beside it, outside this checkout's folder, with `git worktree add --detach <path-of-your-choice> pre-rust-rewrite`; remove it with `git worktree remove` when you are done. Run `bun install` in each. Refer to the two as "the head checkout" and "the tag checkout" in the report, never by absolute path.

### 3. The webview library, the same for both

On macOS the webview is `libwebview.dylib`, loaded from `@n1h/sweetview-webview-bun` or from the file `WEBVIEW_PATH` names. Read how each commit gets it: the root `README.md` (its section on the webview library version on macOS), `docs/webview-library.md` (where it comes from, library selection and symbol probing, the macOS library under "Rebuilding") and `webview/README.md`, at the tag and at the head, since they differ.

- Record which version of `@n1h/sweetview-webview-bun` each checkout installed, and which of the additions its library exports (the symbol table in `docs/webview-library.md`; `nm -gU <file> | grep webview_` lists them).
- When the installed library lacks the later additions (request handler, streaming, external drop, file drops), build the library from the `v1-drafting` branches as `docs/webview-library.md` and `webview/README.md` describe (the `just webview ...` recipes, as the `webview/justfile` has them now). If the clone fails for lack of access to `n0t-invented-here/sweetview-webview-bun`, put it on the owner's list and continue with the installed library, recording which features that leaves untested.
- Run the tag and the head against **the same library file**, through `WEBVIEW_PATH`, so a difference you find is Sweetview's and not the library's. Record the file's origin and commit.

### 4. Baseline at the tag

In the tag checkout, run that commit's own `bun run typecheck` and `bun test` (and `just check` if its justfile has it), saving the full output. Run every demo under `demos/` that the tag has, through its `justfile` recipes as that commit has them (`app`, the macOS compile and bundle recipes, `drive` where it exists), and every macOS probe script (step 6). Exercise every capability of step 7 that the tag supports, and capture the evidence of step 8.

A test that fails at the tag is part of the baseline. Run each failing test a second time to tell a flaky one from a steady one, and record both results.

### 5. The head

Do the same in the head checkout: `bun run typecheck`, `bun test`, `just test`, every demo, every probe, every capability. Read what each recipe depends on before you run it: some recipes at the head depend on the Rust binding, which is built only on Windows (`packages/sweetview-native/justfile`, decision D34), and a Windows cross-compile recipe may need a file only a Windows build makes. Run the macOS recipes on their own when a combined recipe stops on a Windows step, and record the combined recipe's failure as a difference.

The demos `web-app-electron` and `web-app-tauri` are new at the head. Run them when Electron and the Tauri toolchain are available; report them as new, not as a comparison.

### 6. The macOS-only tests and probes

Many tests are skipped on Windows and run only on a Mac. Find all of them, at both commits, rather than trusting a list:

- `git grep -n -E '(describe|test|it)\.(if|skipIf)\(' -- packages demos rust-rewrite/compat`, then read each condition: anything true on `darwin` (`process.platform === "darwin"`, and variables such as `liveDesktop` or `supported` that include it) runs on this Mac. Files named `*.darwin.ts` and test files under `darwin/` folders are macOS fixtures and tests.
- The probe scripts that drive the real macOS application: `git ls-files | grep -i -E 'mac-|darwin'` and the `scripts/` folder of each demo (at the time of writing `demos/native-tabs/scripts/mac-drive.ts`, run by `just demos native-tabs drive`, and `demos/native-tabs/scripts/mac-capture.ts`, which it uses to capture the process's own windows).
- The seam tests the Windows work wrote for macOS (`packages/sweetview-native/src/macos-seam.test.ts`, `packages/sweetview/src/macos-seam.test.ts`): they simulate macOS; on the Mac they run for real. Report their result.

For each such test or probe, the report says whether it ran at each commit, and its result. A test that was skipped, on a Mac, at either commit is listed with the condition that skipped it.

### 7. Every user-visible capability, exercised for real

Derive the full list of what an application could do on macOS at the tag from `docs/` (at the tag and at the head), the root `README.md`, and the inventories under `rust-rewrite/reference/` (`v1-drafting-features.md`, `v1-drafting-tabs-and-window.md`, `native-tabs-on-main.md`, `bindings-exports.txt`). Do not treat the list below as complete; it is the least the report must cover:

- Windows: framed, frameless, transparent, an overlay above the Dock, on every Space, one that never takes focus; moving, resizing, showing, hiding, the real `NSWindow` handle an application passes to its own native calls.
- Click-through and hit regions (`demos/desktop-pet`).
- The menu-bar status item and its menu; the app menu; popup menus.
- Notifications, and a click on one coming back to the application.
- The folder dialog; the clipboard; URL schemes (from the bundle's `Info.plist`) and single instance, with a second launch handed to the first.
- Native tabs: open, select, title, close, move to a new window, merge, the tab bar AppKit draws.
- The webview: bundled assets, the request handler, streamed responses, the frames origin, file drops onto the page, external drops, background colour and transparency.
- The worker and its wake of the UI thread; both loop modes (the blocking `run()` and the loop pumped from a Bun timer, `runEventLoop`).
- Input hooks and the permission flow (`permissions`), which need the Accessibility and Input Monitoring grants.
- An application that uses no webview, importing `@n1h/sweetview-native`, running without `@n1h/sweetview-webview-bun` installed (HANDOFF section 8 says this was restored to the tag's behaviour; try it in a scratch copy outside the repository).
- `bun build --compile` to a single executable, and the `.app` bundle with its ad-hoc signature (`docs/build.md`, the demos' macOS compile and bundle recipes), launched from the Finder or with `open`, not only from a terminal.
- Each demo started, used, and quit through its own menu, and the time from Quit to the process ending, at both commits. At the head each demo still ends on macOS with the tag's disposes and `process.exit()`; a demo that ends at the tag but is still running 10 seconds after Quit at the head is a regression.

At the head the same capability is reached through the new API: `docs/upgrading.md` maps each old export to what an application writes now. Where the tag's demo or test and the head's differ in form, compare the behaviour, not the code.

A passing typecheck or a passing test that never opened a window is not evidence that a visible behaviour works. Each capability counts as working only when you have seen it (step 8) or a test drove the real OS and asserted it.

### 8. Evidence

- A screenshot for each visible behaviour, at each commit, saved under `~/sweetview-verify-macos/tag/` and `~/sweetview-verify-macos/head/` (outside the repository), unless the agent instructions of this repository (`CLAUDE.md`, `AGENTS.md`) name another place. Name each file for the capability it shows. **Open and look at each screenshot before you count it**: say in the report what it shows. A blank, black or wrong-window capture is a failed capture, not evidence.
- `screencapture` of the whole screen, the menu bar or a notification needs the Screen Recording grant for the program you run in; `demos/native-tabs/scripts/mac-capture.ts` captures a process's own windows without it.
- Save command output you cite (test runs, typecheck, demo stderr) as text beside the screenshots, and quote the lines that matter in the report.
- In tracked files and commit messages: no absolute path of this machine (write `~/sweetview-verify-macos/...`, "the head checkout", "the tag checkout"), and nothing about any application other than this repository's own demos. If `rust-rewrite/local/` exists, it is private and ignored by git: do not copy anything from it into the report. Before you commit, run `bun rust-rewrite/verify.ts macos --quick` and confirm its `privacy` check passes; the other checks of that run measure the macOS goal, which has not started, and their failures are not findings.

### 9. Compare

Put the tag's and the head's results side by side, test by test, demo by demo, capability by capability. Tests were rewritten for the new API where it changed (R1): match each tag test to its counterpart at the head by file and name, and where a tag test has no counterpart, find whether its behaviour is still asserted elsewhere and say where, or that it is not.

Every difference goes in the report. Classify each as one of:

- **regression**: worked at the tag, does not work (or works differently in a way a user sees) at the head;
- **intended**: a documented change (a row in `docs/upgrading.md`, a decision in `DECISIONS.md`) that keeps the capability;
- **environment**: the same at both commits once the cause outside Sweetview is removed (flaky, a missing grant, a missing tool);
- **improvement**: failed at the tag, works at the head.

### 10. Fixing a regression

You may fix a regression when all of these hold:

- You have its before and after: the observation at the tag, the failing observation at the head, and the same check passing at the head with your fix.
- You know its cause, and the report states it with the file and line.
- The fix is inside the TypeScript macOS path or the macOS arm of a seam: `packages/sweetview-native/src/darwin/`, `packages/sweetview/src/darwin-*.ts`, `packages/sweetview/src/tabs/darwin-*.ts`, a branch of shared code that runs only when `process.platform === "darwin"` (or the predicate is true), or a demo's macOS-only block. A line that runs on Windows is outside it, and so is any change that turns a held-back behaviour on (step 11).

After each fix, run `bun run typecheck`, `bun test` and the check that showed the regression, at the head, and commit the fix alone, its message naming the regression, its cause and the evidence. Windows cannot be run here: the report lists each fix with the commands for the owner to run on Windows afterwards (HANDOFF section 6 names them).

When a regression's fix would need anything else (shared code that runs on Windows, Rust, a justfile, a test's expectations, the docs), do not make it: record it as open, with its cause and the fix you would propose.

### 11. The held-back behaviours

For each row of the handoff's held-back section, and then for all of them together:

1. Turn it on locally and uncommitted: change the seam's condition at that call site, or delete the demo's macOS block, as the row describes. Do not commit it, push it, or leave it in the working tree.
2. Run what the row's "before turning it on" column names, plus `bun test` and every demo to Quit.
3. Record: works as on Windows, fails (with what was seen: hang, crash, stderr, an icon left behind, the exit code), or needs macOS work (and what).
4. Put the files back (`git restore <files>`) and confirm `git status` shows no change before the next trial.

The seam tests are written to assert the held-back state, so they fail while a behaviour is turned on; record that, it is not a finding. Tests that are Windows-only and that a row asks for on a Mac (for example `packages/sweetview/src/app-exit.test.ts`, which reads Windows state) may need a macOS version to mean anything; write it in a scratch file outside the repository if you need it, and say what it checked.

## What you do not do

- Change any Windows code path, any Rust under `crates/`, or anything under a `win32/` folder.
- Edit `rust-rewrite/verify.ts`, `rust-rewrite/REQUIREMENTS.md`, `rust-rewrite/UNSAFE-POLICY.md`, the text of any checklist item, or the files APM generates: `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `.agents/`, `.mcp.json`, `apm.yml`, `apmm.yml`, `apm.lock.yaml`, `apm_modules/`.
- Weaken, skip or delete a test, or change its expected values, to get a pass. A test that fails stays failing and goes in the report.
- Commit a held-back behaviour turned on.
- Start, re-run or read hosted CI runs; hosted CI is not approved in this project (D33).
- Publish anything, open a pull request or issue, merge, force-push, rewrite history, move a tag, or delete a branch.

## When you are blocked

Some steps need a person: a macOS permission prompt (Accessibility, Input Monitoring, Screen Recording, Notifications), a physical action (clicking a notification, dragging a file from the Finder, a second display), a signing identity, a password, or access to a repository.

Never work around a permission: do not edit TCC databases, disable SIP, or script the System Settings panes. When you reach such a step, write down exactly what is needed (which permission, for which program, or which action, and what you will check afterwards), then continue with everything that does not depend on it. When nothing else is left, ask the owner once, with the whole list, and wait for the answer. Whatever stays unanswered goes in the report as "not exercised", with what it needs.

## The report

The file named above (run output, kept outside git; give it in full in your reply too), with these sections in this order:

1. **Verdict**: one paragraph: does macOS at the head do everything it did at the tag? Name the number of regressions found, fixed, and open, and the number of capabilities not exercised.
2. **Environment**: macOS version, chip, Bun, Xcode tools, `just`, `pwsh`, and the webview library file used (origin, version or commit, which additions it exports). The commits of `pre-rust-rewrite` and of the `v1-rust-rewrite` head you verified.
3. **Baseline at the tag**: typecheck, tests (counts, and every failure or skip with its reason), each demo and probe, each capability.
4. **The head**: the same, in the same order.
5. **Differences**: one table, one row per difference: what, at the tag, at the head, class (regression, intended, environment, improvement), evidence file names.
6. **Regressions**: for each, its cause (file and line), and either the fix (commit, before and after evidence, the Windows commands for the owner) or "open" with the proposed fix and why it was outside your authority.
7. **Not exercised**: each capability or test you could not run or see, and exactly what it needs.
8. **Held-back behaviours, trialled**: one entry per handoff row and one for all together: what was turned on, what was run, the result.
9. **Notes for the macOS goal**: anything you learned that the handoff does not already say, as suggestions.

## When you are done

You are done when the report exists in that shape, every regression is fixed or recorded as open, every capability is either seen working, seen failing, or listed as not exercised with what it needs, the tag worktree is removed, `git status` is clean, and the branch is pushed. Then reply with the report's verdict paragraph, the list of open regressions, the list of what was not exercised, and the branch name and head commit. Do not describe a capability as working in that reply unless the report shows the evidence for it.
