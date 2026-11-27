# macOS checklist

Runs after the Windows goal is complete, on a Mac. Same rule for ticking as the Windows checklist: an item is ticked when its acceptance has been run and the output is pasted under it or saved under `rust-rewrite/evidence/`.

Items name today's API members to say which behaviour is meant. The API may change (R1): the item is met by the same behaviour through the new form, with its row in `docs/upgrading.md`.

Read `rust-rewrite/HANDOFF-macos.md` first. It was written by the Windows goal and lists what already compiles for macOS and what is stubbed.

## M0. Ground

- [ ] M0.1 Baseline recorded on tag `pre-rust-rewrite` on this Mac: `bun run typecheck` and `bun test`, saved to `rust-rewrite/evidence/baseline-macos.txt`.
- [ ] M0.2 The three proofs of `rust-rewrite/spike/` pass on this Mac: a JavaScript function called from inside the blocking loop, tray events under a timer-pumped loop with no window, and `bun build --compile` embedding the binding. The tray icon is also clicked by hand.
- [ ] M0.3 If the timer-pumped loop fails on macOS under `tao`'s `run_return`, the pump dequeues events itself with `NSApplication::nextEventMatchingMask_untilDate_inMode_dequeue` and `sendEvent`. The choice and the evidence are in `rust-rewrite/DECISIONS.md`.
- [ ] M0.4 The GitHub Actions workflow also builds and tests on `macos-latest`, and produces a binding for arm64 and x64.
- [ ] M0.5 Each of the four macOS rows of `FORKS.md` is built as a small running proof before anything depends on it: a streamed response through this project's own `WKURLSchemeHandler` on a configuration passed to `with_webview_configuration`; a script message handler added through `manager()` that refuses a message from an iframe; a navigation delegate that forwards to `wry`'s and reports a failed load; a drag handler that sends a file drag from Finder to the handler and leaves an in-page drag to WebKit. The output of each is pasted here.

## M1. The webview

- [ ] M1.1 Every member of `RawWebview`, as in W2.1.
- [ ] M1.2 `setAsset` and `assetOrigin` equal to `webview://localhost`, the exact-authority rule, the HTTP-style response.
- [ ] M1.3 `setBackgroundColor` with any alpha, painted behind the page, for owned and adopted windows as `background-color.md` states.
- [ ] M1.4 The request handler with `framesOrigin` equal to `webview-frames://localhost`, the body rules for `Blob` and `FormData`, the one-`Set-Cookie` rule, stopped tasks.
- [ ] M1.5 Streaming: each chunk reaches the page as it is written. The Server-Sent Events timing test passes.
- [ ] M1.6 `setAllowExternalDrop` and `setFileDropHandler` with the drag routing of `external-drop.md`: one route per drag session, drags from other apps only, in-app drags left to WebKit.
- [ ] M1.7 Page messages from frames other than the top-level document are refused. The live iframe test passes.
- [ ] M1.8 The bindings' tests and Sweetview's webview tests pass on macOS, including the live ones.

## M2. Input hooks

- [ ] M2.1 `installMouseHook` and `installKeyboardHook` on one shared event tap, re-enabled when the system disables it.
- [ ] M2.2 `permissions`: Device Control and Data Access and Input Monitoring, status, request, auto-request.
- [ ] M2.3 `examples/input-hooks.ts` runs from a signed `.app`, edited only for API changes that `docs/upgrading.md` records.

## M3. Loop, windows, overlays

- [ ] M3.1 Both loop modes.
- [ ] M3.2 `Window`: every option and method. `handle` is the real `NSWindow` pointer; a tabbed window's is `null`, as today.
- [ ] M3.3 Overlays: non-opaque with a clear background, above the Dock, on every Space, out of window cycling, over full-screen apps, accessory activation policy.
- [ ] M3.4 `setClickThrough` and `setHitRegions` with the refiner.
- [ ] M3.5 `startDrag` (primary button down only), `startResize`, `minimize`, `toggleMaximize`, `isMaximized`, the close-button rule, `onFileDrop`.
- [ ] M3.6 `Screen`, with points and the flipped y axis.
- [ ] M3.7 The live macOS tests pass. `demos/desktop-pet` and `demos/web-app` run and build as `.app`.

## M4. Tray, menus, notifications, dialogs, clipboard

- [ ] M4.1 `Tray`: any click opens the menu when one is set; click and double click when none is; SF Symbol and PNG icons; template images.
- [ ] M4.2 Menus, including item images on macOS 27, and `Menu.popup`.
- [ ] M4.3 `Notifier`: one shared delegate, clicks routed by id, cold-launch clicks, the per-process tag, banners while frontmost.
- [ ] M4.4 `pickFolder`, `Clipboard`, `setAppMenu` with About, Quit and the Edit menu, `setAppIcon`, `setActivationPolicy`.
- [ ] M4.5 `demos/menubar-only` and `demos/menubar-notify` run from a signed `.app`; the menu-bar item is clicked by hand.

## M5. Activation

- [ ] M5.1 `onOpenUrl` from the system's open-URL event, buffered until `signalReady`.
- [ ] M5.2 `singleInstance` over the message port, with an instance from tag `pre-rust-rewrite` and one from the rewrite handing off in both directions.

## M6. Tabs

- [ ] M6.1 Every behaviour under "Behaviour: tabs on macOS" in `rust-rewrite/reference/v1-drafting-tabs-and-window.md`, including the menus, the kept tab bar, popups as tabs and the failed-load page.
- [ ] M6.2 `demos/native-tabs` runs; `scripts/mac-drive.ts` passes.

## M7. Packaging

- [ ] M7.1 The package holds bindings for macOS arm64 and x64. `makeMacApp` builds and signs a bundle that runs on another Mac after the quarantine steps in the README.
- [ ] M7.2 Every demo's `compile` recipe works on macOS and from Windows for the macOS target.

## M8. Removal and documents

- [ ] M8.1 `rust-rewrite/ffi-allowlist.txt` holds probes only. No file under `packages/` imports `bun:ffi`.
- [ ] M8.2 `@n1h/sweetview-webview-bun` is no dependency of any package or demo, and `webview/` with its recipes is removed or rewritten for the forks.
- [ ] M8.3 `docs/` describes the result on both platforms, and `docs/upgrading.md` covers macOS.
- [ ] M8.4 Every Windows check still passes: the Windows job of the workflow is green on the final commit.

## M9. Safety

- [ ] M9.1 `rust-rewrite/UNSAFE-LEDGER.md` is current for macOS.
- [ ] M9.2 A reviewer that did not write the code read every macOS `unsafe` block against `UNSAFE-POLICY.md` and every item here against its evidence. Findings are in `rust-rewrite/evidence/review-macos.md`, each fixed or answered.
- [ ] M9.3 `rust-rewrite/OWNER-ACTIONS.md` is current.
- [ ] M9.4 `rust-rewrite/HANDOFF-linux.md` exists for the Linux goal: what the shared Rust already does behind `cfg(target_os = "linux")` and what `CHECKLIST-linux.md` should change given what the first two goals learned.
