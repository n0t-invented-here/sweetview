# Windows checklist

An item is ticked when its acceptance has been run and the output is pasted under it, as an indented fenced block or as the path of a log under `rust-rewrite/evidence/`. An item ticked without evidence is unticked by `verify.ts`.

Do the groups in order. Inside a group the order is free. After each group the tree works: commit and push it.

Reference for every item: `SWEETVIEW-RESTART-PROPOSAL.md` (design), `rust-rewrite/reference/` (what today's code does, file by file), `docs/` (the behaviour that must not change).

## W0. Ground

- [ ] W0.1 Tag `pre-rust-rewrite` exists on the commit before the first change and is pushed.
- [ ] W0.2 Baseline recorded: `bun run typecheck` and `bun test` on that tag, output saved to `rust-rewrite/evidence/baseline-windows.txt`. Every test that passes here passes at the end.
- [ ] W0.3 A Cargo workspace exists at the repository root with `crates/sweetview-napi` (the binding), `crates/sweetview-core` (logic, `unsafe` forbidden) and `crates/sweetview-platform` (the only crate where `unsafe` is allowed). More crates are fine where a boundary earns one.
- [ ] W0.4 The forks in `FORKS.md` are wired as git dependencies pinned to a commit.
- [ ] W0.5 `just native` builds the binding for the host and places it where the loader finds it. `just check` builds it first.
- [ ] W0.6 A GitHub Actions workflow builds the binding and runs `cargo test`, `cargo clippy`, `bun run typecheck` and `bun test` on `windows-latest`.

## W1. The boundary

- [ ] W1.1 The binding loads with a literal `require` from `packages/sweetview-native`. A missing or wrong-platform binary fails with a message that names the file looked for.
- [ ] W1.2 A JavaScript function passed to the binding is called from inside the blocking loop and its return value comes back. Each call opens its own handle scope. Proven by a `bun test` test; `rust-rewrite/spike/` shows the mechanism.
- [ ] W1.3 A JavaScript exception thrown from such a callback is caught at the boundary, logged with the message today's code logs, and does not unwind into the OS. A test throws from each callback kind.
- [ ] W1.4 A callback that removes itself or destroys its owner from inside its own call works. A test does both.
- [ ] W1.5 Calling a UI-thread function from a `Worker` throws `sweetview: this call must be made on the UI thread`. The functions `docs/` documents as callable from any thread work from a `Worker`.
- [ ] W1.6 `bun build --compile` embeds the binding: a demo's compiled executable, copied alone into an empty folder, runs.

## W2. The webview

Source of truth for behaviour: the bindings repository's `docs/` and `test/`, and the C++ fork's `sweetview/` pages.

- [ ] W2.1 `RawWebview` (the bindings' `Webview` class) keeps every member: constructor forms, `title`, `size`, `navigate`, `setHTML`, `init`, `eval`, `bind`, `bindRaw`, `unbind`, `return`, `run`, `destroy`, `unsafeHandle`, `unsafeWindowHandle`, and `unload`.
- [ ] W2.2 `setAsset` and `assetOrigin`: `http://webview.localhost`, path matching and validation exactly as `assets.md` states.
- [ ] W2.3 `setBackgroundColor`: alpha 0 and 255, the error for any other alpha, transparency through to the desktop.
- [ ] W2.4 `setRequestHandler`, `completeRequest`, `completeWebviewRequest` from a worker, `framesOrigin` equal to `http://frames.webview.localhost`, header validation, the 404 and 500 rules, requests from service workers.
- [ ] W2.5 Streaming: `beginResponse`, `writeResponseChunk`, `endResponse` and the worker forms, with the duplicate-begin error and the chunk rules of `request-handler.md`.
- [ ] W2.6 `setAllowExternalDrop` and `setFileDropHandler`, with HTML drops inside the page still reaching the page.
- [ ] W2.7 The bindings' `test/request-handler.test.ts` and its fixtures are brought into this repository and pass unchanged in what they assert.
- [ ] W2.8 Sweetview's own webview tests pass: `request-handler.test.ts`, `app.test.ts`, `worker.test.ts`, `webview-lib.test.ts`.
- [ ] W2.9 Teardown: destroying a webview with requests open, from inside a handler, and from a worker racing the destroy, each behave as `requests.md` states. A test covers each.

## W3. Input hooks

- [ ] W3.1 `installMouseHook`: every event kind, coordinates, wheel notches, modifiers, swallow per event, one hook per process, dispose from inside the handler.
- [ ] W3.2 `installKeyboardHook`: down, up, repeat, DOM codes, raw code, modifiers after the event, swallow per event.
- [ ] W3.3 `permissions`: `needed`, `status`, `request`, `ready`, `autoRequest`, with the Windows answers.
- [ ] W3.4 The key-code tables of `key_codes.hh` are ported with every test of the C++ fork that covers them.
- [ ] W3.5 The bindings' `examples/input-hooks.ts` runs unchanged against the new package.

## W4. Loop, windows, overlays

- [ ] W4.1 `runEventLoop`, `quitEventLoop`, `pumpEvents`, and `run()` on an app: both loop modes, with Bun timers and promises running between pumps.
- [ ] W4.2 `Window`: every option of `WindowOptions` and every method, per `docs/native/windows.md`. `handle` is the real `HWND`.
- [ ] W4.3 Overlays: transparent, colour key, opacity, topmost above the taskbar, hidden from the taskbar, no-activate, the hidden first window.
- [ ] W4.4 `setClickThrough` and `setHitRegions` with the refiner, the 10 ms poll and the "no flip while a button is down" rule, per `docs/native/overlays-and-hit-regions.md`.
- [ ] W4.5 `startDrag`, `startResize`, `minimize`, `toggleMaximize`, `isMaximized`, `closeToTrayOnLastWindow`, `onClose`, `onResize`, `onMove`, `onFileDrop`.
- [ ] W4.6 `Screen`: `primary`, `all`, `at`, `of`, `bounds`, `cursor`.
- [ ] W4.7 `packages/sweetview-native/src/win32/window.test.ts` and `win32.test.ts` pass. `demos/desktop-pet` and `demos/web-app` run and compile.
- [ ] W4.8 An application's own `bun:ffi` modal dialog and popup menu, opened from a `uiMethods` call, work under both loop modes. A fixture under `rust-rewrite/compat/` does this.

## W5. Tray, menus, notifications, dialogs, clipboard

- [ ] W5.1 `Tray`: icon, tooltip, click, double click, menu on right click, `setIcon`, `setMenu`, re-added when Explorer restarts.
- [ ] W5.2 Menus: check marks, icons, submenus, separators, disabled items, the function form rebuilt on each open, `Menu.popup` at a point and at the cursor.
- [ ] W5.3 `Notifier`: WinRT toasts with click, the balloon fallback, `appId` and identity registration, per `docs/native/notifications.md`.
- [ ] W5.4 `pickFolder`, `Clipboard`, `setAppMenu`, `setAppIcon`, `setActivationPolicy`.
- [ ] W5.5 `notifier.test.ts` passes. `demos/menubar-only` and `demos/menubar-notify` run and compile; the tray icon is clicked by hand and the result written down.

## W6. Activation

- [ ] W6.1 `registerUrlScheme`, `unregisterUrlScheme`, `onOpenUrl`, `signalReady`, `extractUrlFromArgs`.
- [ ] W6.2 `singleInstance`: an instance built from tag `pre-rust-rewrite` and one built from the rewrite hand off to each other in both directions.
- [ ] W6.3 `activation.test.ts` passes.

## W7. Tabs

- [ ] W7.1 `new Window({ tabs: true })`, `WebView.openTab`, `Tab`, `createApp({ tabs: true })`: every behaviour in `rust-rewrite/reference/v1-drafting-tabs-and-window.md` under "Behaviour: tabs on Windows".
- [ ] W7.2 `demos/native-tabs` runs; its `scripts/win-drive.ts` passes.

## W8. Packaging

- [ ] W8.1 The package holds the prebuilt binding for Windows x64 and the loader finds it after `bun add` from a packed tarball in an empty project.
- [ ] W8.2 `just compile` builds every demo. `just pack` lists what would publish.
- [ ] W8.3 `refreshWindowsIcons` and the rest of `packages/sweetview-build` work with no `bun:ffi`.

## W9. Removal and documents

- [ ] W9.1 Every Windows file in `rust-rewrite/reference/ffi-files.md` is deleted or free of `bun:ffi`. `ffi-allowlist.txt` holds macOS-only files and probes, each with its reason.
- [ ] W9.2 `docs/` describes the result: no page tells a Windows reader that Sweetview calls the OS through `bun:ffi`.
- [ ] W9.3 `docs/upgrading.md` exists with one row per export of the three old API surfaces, and `rust-rewrite/compat/` exercises each row.
- [ ] W9.4 When `rust-rewrite/local/dependents.txt` exists, each listed application was upgraded in a temp copy and its own checks run; the result is in `rust-rewrite/local/dependents-result.md`.

## W10. Safety and handoff

- [ ] W10.1 `rust-rewrite/UNSAFE-LEDGER.md` is current and every entry has its reason.
- [ ] W10.2 A reviewer that did not write the code read every `unsafe` block against `UNSAFE-POLICY.md` and every checklist item against its evidence. Its findings are in `rust-rewrite/evidence/review-windows.md` and each is fixed or answered.
- [ ] W10.3 `rust-rewrite/HANDOFF-macos.md` exists: what compiles for macOS, what is stubbed behind `cfg(target_os = "macos")`, the result of `cargo check --target aarch64-apple-darwin`, and anything the Windows work learned that changes `CHECKLIST-macos.md`.
- [ ] W10.4 `rust-rewrite/OWNER-ACTIONS.md` lists everything left for the owner: publishing, upstream pull requests, the forks' state.
