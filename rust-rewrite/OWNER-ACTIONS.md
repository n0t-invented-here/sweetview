# Owner actions

What the Windows goal left for the owner, because requirement R7 reserves it or because only a person at the machine can do it. Nothing here blocks the checks of `bun rust-rewrite/verify.ts windows`.

## 1. Merge the branch

`v1-rust-rewrite` is pushed with every commit of the Windows goal. Tag `pre-rust-rewrite` marks the tree before the first of them and was not moved. Merging the branch, into `main` or anywhere else, is the owner's decision; this branch was merged nowhere and no pull request was opened.

macOS still runs today's code on this branch (R8), so the branch is usable on both platforms as it stands. The root `README.md` still tells a reader to clone `v1-drafting` for 1.0.0; which branch it should name is decided by where this one is merged. `HANDOFF-macos.md` is the starting point of the macOS goal.

## 2. Publish to npm

Nothing was published. Eight packages are at version 1.0.0 in their `package.json`:

| Package | What changed for a consumer |
|---|---|
| `@n1h/sweetview-native` | ships `prebuilt/sweetview.win32-x64-msvc.node` and `prebuilt/binding.d.ts`; `@n1h/sweetview-webview-bun` is now an optional peer dependency, needed on macOS only |
| `@n1h/sweetview` | the webview on Windows comes from the native package; `docs/upgrading.md` has the rows |
| `@n1h/sweetview-build` | `refreshWindowsIcons` goes through the binding |
| `@n1h/sweetview-ipc`, `@n1h/sweetview-ipc-ws`, `@n1h/sweetview-settings` | no change of behaviour |
| `@n1h/sweetview-ipc-electron`, `@n1h/sweetview-ipc-tauri` | new packages (checklist group WT) |

Before publishing:

- `just pack` builds the binding and lists what each tarball would hold. `bun rust-rewrite/checks/pack-install.ts` packs all eight, installs the tarballs into an empty project and runs a script there (checklist item W8.1).
- The binding is built on the machine that publishes (`just publish` runs `just native` first). The `.node` file is not tracked (decision D5). The published native package holds the Windows x64 binding only; macOS and Linux binaries are added by their goals.
- The names `@n1h/sweetview-ipc-electron` and `@n1h/sweetview-ipc-tauri` were chosen by this work, after the existing `@n1h/sweetview-ipc-ws`. They are public names of something the owner owns: to change one before its first publish, rename `packages/sweetview-ipc-<name>/package.json`, the imports in `demos/web-app*`, and the pages `docs/ipc-electron.md`, `docs/ipc-tauri.md`, `docs/ipc.md`, `docs/upgrading.md` and the root `README.md`.
- The Tauri event name `sweetview-ipc:event` and command name `sweetview_ipc`, and the Electron channel names in `packages/sweetview-ipc-electron/src/channel.ts`, are wire names an application's Rust backend or preload script depends on once published.

## 3. Run the upgrade against the real applications

Requirement R2 asks for each real application to be upgraded in a temp copy and its own checks run, when `rust-rewrite/local/dependents.txt` lists them. That file did not exist on this machine and this work did not make one (decision D19, requirement R6). To run it:

1. Write `rust-rewrite/local/dependents.txt`: one local path of an application per line. The folder is ignored by git.
2. For each: copy it to the system temp directory, apply `docs/upgrading.md` to the copy, run its typecheck, tests and build, and write a section ending in a line `RESULT: PASS` or `RESULT: FAIL` to `rust-rewrite/local/dependents-result.md`.
3. `bun rust-rewrite/verify.ts windows` then counts them in its `dependents` check.

What stands in for it until then: `rust-rewrite/compat/upgrade-guide.test.ts` reads every table of `docs/upgrading.md` and imports each row's new form. On Windows its test "every row's new form runs" calls each class, constant, function and method or member row once in its new form, with real arguments, through the runners in `rust-rewrite/compat/fixtures/row-runners.ts` (the ones that need a window, a webview, the tray, the clipboard, a hook, a dialog or the loop in `fixtures/rows-desktop.ts`, a process of its own), and checks what comes back; the rows of an application's own `bun:ffi` table are opened and called by `fixtures/own-ffi.ts`. A row whose target has no runner fails "every row's new form has a runner". Type rows are not run: tsc checks them through `rust-rewrite/compat/upgrade-types.ts`. Rows of a `/darwin/` module are macOS-only and are not run on Windows. `behaviour.test.ts` and `own-modal-loops.test.ts` run the rows whose behaviour changed.

## 4. Things only a person at the desk can do

- Click the tray icon of `demos/menubar-only` and `demos/menubar-notify` by hand, and a toast with it. What was done instead (checklist item W5.5, `rust-rewrite/evidence/w5-demos-real-clicks.txt`): real mouse input injected with `SendInput` onto the icon that Explorer shows, found through UI Automation, so the click travels through the shell as a hand's does; the same for the toast banner. The scripts are `rust-rewrite/checks/tray-real-click.ps1` and `toast-real-click.ps1`.
- Drag a file from Explorer onto a webview window. The drop path is tested with a real file driven through DevTools and through `WM_DROPFILES` (checklist items W2.6 and W4.5); a drag out of Explorer itself needs a hand.
- Look at tabbed windows and `demos/desktop-pet` on a second monitor with a different scale factor. This machine has one monitor at one scale: the tab frame's handling of a DPI change is tested by sending it the message, not by a real change of scale (checklist item W7.1).

## 5. Upstream

No pull request or issue was opened on a repository the owner does not own. What the work found that an upstream might want, each with the place in this repository that works around it:

| Project | Finding | Where it is handled here |
|---|---|---|
| `tauri-apps/tao` 0.38.0 | `run_return` buffers every event raised while its handler is running, and its handler is never called for a message that is not `tao`'s; a handler that opens a modal loop sees no wake or timer until it returns | `crates/sweetview-platform-loop` (decisions D3, D4) |
| `tauri-apps/tao` 0.38.0 | `Window::set_visible(true)` activates the window; a window made not to take focus needs `SW_SHOWNOACTIVATE` | `crates/sweetview-platform-window`, `show` (decision D9) |
| `tauri-apps/wry` 0.58.2 | a response body is one buffer; no streamed body | `crates/sweetview-platform-webview`, `istream.rs` |
| `tauri-apps/wry` 0.58.2 | the environment is always created with `wry`'s own options; a process sharing a user data folder with another WebView2 host that uses different options fails with `ERROR_BUSY` | `crates/sweetview-platform-webview`, `environment.rs` (decision D15) |
| `tauri-apps/wry` 0.58.2 | on Windows the drag-drop handler revokes WebView2's own drop target, so HTML drops inside the page stop working when it is used | not used; drops come through the page (decision D17) |
| `tauri-apps/muda` 0.22.0 | no menu item with both an icon and a check mark | `crates/sweetview-platform-window`, `popup.rs`, `check_item` (decision D14) |
| `tauri-apps/muda` 0.22.0 | `show_context_menu_for_hwnd` is an `unsafe fn`, passes `TPM_LEFTALIGN \| TPM_RETURNCMD` only (letting go of the right button over an item does not choose it, and a menu cannot open upward from the cursor), and reports the chosen item later, through the process-wide `MenuEvent` handler, not as its result; no API sets an item's command id | not used: `muda` builds the menu and `crates/sweetview-platform-window/src/popup.rs` tracks it with its own `TrackPopupMenu` and sets each command id (`show_popup`, `set_command_id`; decision D26); the tab frame's flat menu is this project's own popup (decision D22) |
| `tauri-apps/tao` 0.38.0 | every event loop leaves one wait thread behind when it is dropped (one USER object, two kernel handles) | harmless with one loop per process; the `LoopHost` handle test allows for it (decision D23) |
| `tauri-apps/tao` 0.38.0 | on `WM_DPICHANGED` it keeps its own size when the scale is unchanged and computes one from the old inner size otherwise, so the rectangle the system suggests is not applied | `crates/sweetview-platform-window`, `tab_frame.rs`, `FrameMessages` (decision D22) |
| `tauri-apps/tao` 0.38.0 | its windows are registered for raw keyboard input unless the device-event filter says otherwise, and Windows does not call a process's own low-level keyboard hook while a window of that process registered for raw input holds the foreground; an application with a `WH_KEYBOARD_LL` hook sees no key typed into its own window | `crates/sweetview-runtime/src/runtime.rs`, `build_event_loop`: `set_device_event_filter(DeviceEventFilter::Always)` (decision D29) |
| `tauri-apps/tao` 0.38.0 | poll mode is kept alive by a repaint request (`RDW_INTERNALPAINT`) on a hidden window; a `PeekMessageW` that removes nothing, which the message wait inside a COM call makes, drops that request, and `run_return` then waits in `GetMessageW` with `ControlFlow::Poll` set | `crates/sweetview-runtime/src/runtime.rs`, `Runtime::pump`: a user event before each pump and a guard timer (decision D30) |
| WebView2 (`AddScriptToExecuteOnDocumentCreated`) | the completion arrives only once a navigation in flight has its response, so a host that waits for it can hang when the response comes from its own thread | `crates/sweetview-runtime/src/engine.rs`, the ordered queue (decision D21) |

## 6. The forks

- `n0t-invented-here/sweetview-webview` (the C++ library) and `n0t-invented-here/sweetview-webview-bun` (its Bun bindings), both on branch `v1-drafting`, were read and not changed. macOS still loads them. They can be archived when the macOS goal completes; until then `@n1h/sweetview-webview-bun` stays an optional peer dependency of `@n1h/sweetview-native`.
- `docs/app.md` and `docs/webview-library.md` say that the request handler and streaming need `@n1h/sweetview-webview-bun` 2.8.0 on macOS. Whether 2.8.0 is published is the owner's to check; on Windows it no longer matters.

## 7. Housekeeping

- `SWEETVIEW-CONSOLIDATION-CHECKLIST.md`, untracked at the repository root, is not part of this work and was left as found.
- On a machine with nobody at it, Windows keeps a toast banner on screen until someone returns and queues later ones behind it. Test runs made before the tests were changed left a queue of banners titled "Sweetview test" and one entry per throwaway app id under `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings`. The tests' toasts now show no banner and expire, and the tests remove their own entries. `rust-rewrite/checks/clear-test-toasts.ps1` was run once on this machine and removed 185 such entries with their toast history; it touches only ids that start with the tests' prefixes, never `Sweetview.DesktopApp`. Run it on any other machine where the earlier tests ran.
- A run of the notifier's tests that is killed half way can leave a key named `Sweetview.NotifierTest.<uuid>`, `Sweetview.NotifierFallbackTest.<uuid>` or `Sweetview.NotifierHandles.<numbers>` under `HKCU\Software\Classes\AppUserModelId`; it is safe to delete.
- The hosted CI runner (`.github/workflows/windows.yml`) has a small screen, applies window moves late and dismisses toasts at once. `rust-rewrite/DECISIONS.md` D20 lists every test that was corrected because it measured that machine and not the code.
