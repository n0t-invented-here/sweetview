# Windows checklist

An item is ticked when its acceptance has been run and the output is pasted under it, as an indented fenced block or as the path of a log under `rust-rewrite/evidence/`. An item ticked without evidence is unticked by `verify.ts`.

Do the groups in order. Inside a group the order is free. After each group the tree works: commit and push it.

Reference for every item: `SWEETVIEW-RESTART-PROPOSAL.md` (design), `rust-rewrite/reference/` (what today's code does, file by file), `docs/` (the behaviour applications rely on).

Items name today's API members to say which behaviour is meant. The API may change (R1): where the rewrite renames or reshapes a member, or changes a constant an application can observe, the item is met by the same behaviour through the new form, with its row in `docs/upgrading.md`.

## W0. Ground

- [x] W0.1 Tag `pre-rust-rewrite` exists on the commit before the first change and is pushed.

    ```
    $ git rev-parse pre-rust-rewrite
    0cb0f2e6c71f7c104537b2f82d50abd9b7546522
    $ git push origin pre-rust-rewrite
     * [new tag]         pre-rust-rewrite -> pre-rust-rewrite
    $ git ls-remote --tags origin pre-rust-rewrite
    0cb0f2e6c71f7c104537b2f82d50abd9b7546522	refs/tags/pre-rust-rewrite
    ```

- [x] W0.2 Baseline recorded: `bun run typecheck` and `bun test` on that tag, output saved to `rust-rewrite/evidence/baseline-windows.txt`. Every test that passes here passes at the end.

    `rust-rewrite/evidence/baseline-windows.txt`: typecheck exit 0; `bun test` 174 pass, 17 skip, 0 fail, 766 expect() calls, 191 tests across 30 files. Each test is listed by name.

- [x] W0.3 A Cargo workspace exists at the repository root, under `crates/`. Each crate has one job that its `README.md` states in a sentence. The binding (the `napi` crate) and the logic crates forbid `unsafe`; only crates named `sweetview-platform` or `sweetview-platform-<name>` may hold it. The crate layout and the reason for each boundary are in `rust-rewrite/DECISIONS.md`.

    The workspace is the root `Cargo.toml` (`members = ["crates/*"]`); twelve crates, each with a `README.md` whose first line after the title states its job. The layout and the reason for each boundary: `rust-rewrite/DECISIONS.md`, D1 and D2.

    ```
    $ for c in crates/*/; do echo "$c: $(grep -m1 '^Job' $c/README.md)"; done
    crates/sweetview-http/: Job: the rules of the webview's request handler that need no OS call.
    crates/sweetview-keycodes/: Job: the tables that turn an OS key or mouse message into the values applications see.
    crates/sweetview-napi/: Job: the binding, where JavaScript values and functions are converted and handed to the runtime.
    crates/sweetview-platform-input/: Job: system-wide mouse and keyboard hooks and the permission model for them.
    crates/sweetview-platform-loop/: Job: the parts of the UI thread's event loop that `tao` has no API for.
    crates/sweetview-platform-node/: Job: the export table of the binding, the items that carry the `#[napi]` attribute.
    crates/sweetview-platform-notify/: Job: desktop notifications with a click that comes back.
    crates/sweetview-platform-shell/: Job: the shell integrations that are one OS conversation each: clipboard text, URL schemes, single instance, icon refresh.
    crates/sweetview-platform-webview/: Job: what the webview needs on top of `wry` that `wry` has no API for.
    crates/sweetview-platform-window/: Job: the window-level OS calls `tao` has no API for, and the events of any window by subclass.
    crates/sweetview-runtime/: Job: everything that lives on Sweetview's UI thread, with no JavaScript in sight.
    crates/sweetview-window-logic/: Job: what a window should do next, decided from cursor positions, button states and bounds.
    $ grep -n "^#!\[forbid(unsafe_code)\]" crates/*/src/lib.rs
    crates/sweetview-http/src/lib.rs:8:#![forbid(unsafe_code)]
    crates/sweetview-keycodes/src/lib.rs:16:#![forbid(unsafe_code)]
    crates/sweetview-napi/src/lib.rs:7:#![forbid(unsafe_code)]
    crates/sweetview-runtime/src/lib.rs:5:#![forbid(unsafe_code)]
    crates/sweetview-window-logic/src/lib.rs:6:#![forbid(unsafe_code)]
    ```

    The binding's logic (`sweetview-napi`) and every logic crate forbid `unsafe`; the seven crates that do not are all named `sweetview-platform-<name>`. `sweetview-platform-node` holds no hand-written `unsafe`: it is the export table, split off because the `#[napi]` attribute's own expansion cannot compile under `forbid` (D2). The `unsafe` check of `bun rust-rewrite/verify.ts windows` enforces all of this on every run.

- [x] W0.4 Every crate comes from crates.io at a version pinned in `Cargo.lock`. `cargo metadata` shows no git dependency and no path dependency outside this repository: no crate is forked.

    ```
    $ bun rust-rewrite/checks/cargo-sources.ts
    packages in the dependency graph: 310 (cargo metadata --locked: Cargo.lock is current)
    from crates.io: 298
    git dependencies: 0
    other registries: 0
    path packages: 12: sweetview-http, sweetview-keycodes, sweetview-napi, sweetview-platform-input, sweetview-platform-loop, sweetview-platform-node, sweetview-platform-notify, sweetview-platform-shell, sweetview-platform-webview, sweetview-platform-window, sweetview-runtime, sweetview-window-logic
    path packages outside this repository: 0
    versions of the crates the design names:
      tao: 0.38.0
      wry: 0.58.2
      muda: 0.22.0
      tray-icon: 0.27.0
      rfd: 0.18.0
      napi: 3.16.3
      napi-derive: 3.7.2
      napi-build: 2.7.0
      windows: 0.62.2
      webview2-com: 0.39.1
    OK: no crate is forked
    ```

- [ ] W0.5 `just native` builds the binding for the host and places it where the loader finds it. `just check` builds it first.
- [ ] W0.6 A GitHub Actions workflow builds the binding and runs `cargo test`, `cargo clippy`, `bun run typecheck` and `bun test` on `windows-latest`.

## W1. The boundary

- [x] W1.1 The binding loads with a literal `require` from `packages/sweetview-native`. A missing or wrong-platform binary fails with a message that names the file looked for.

    `rust-rewrite/evidence/w1-boundary.txt`, "native binding: loading (W1.1)": the binding loads through the literal `require` in `packages/sweetview-native/src/binding.ts`; a missing file and a file for another platform each throw `sweetview: the native binding could not be loaded from <file>: ...`. 3 pass.

- [x] W1.2 A JavaScript function passed to the binding is called from inside the blocking loop and its return value comes back. Each call opens its own handle scope. Proven by a `bun test` test; `rust-rewrite/spike/` shows the mechanism.

    `rust-rewrite/evidence/w1-boundary.txt`: "a JavaScript function is called from inside the blocking loop and its return value comes back" and "each call opens its own handle scope: ten thousand callbacks inside one blocking run". `JsCallback::call` in `crates/sweetview-napi/src/callback.rs` runs every call inside `Env::run_in_scope`.

- [x] W1.3 A JavaScript exception thrown from such a callback is caught at the boundary, logged with the message today's code logs, and does not unwind into the OS. A test throws from each callback kind.

    `rust-rewrite/evidence/w1-callbacks.txt`: a table of every function-typed parameter of the generated `packages/sweetview-native/prebuilt/binding.d.ts` (26 kinds, and `onOpenUrl`, which on Windows is called from the single-instance handoff), each with the test that throws from it, followed by the per-test output: 96 pass, 1 skip, 0 fail across the seven files it cites (the skip is the accelerator-key test, which needs the foreground and passed in the run before). Each test asserts the message today's TypeScript logs for that kind (`UI dispatch failed:`, `onResize handler threw:`, `hit region poll threw:`, `keyboard hook handler threw:`, `onSecondInstance handler threw:` and the rest), that the loop goes on delivering, and the fallback where there is one: a hook does not swallow (read back from the OS: the key state and the cursor position), a request handler answers 500, a throwing menu function opens no menu. One test, "W1.3 an exception from every non-webview kind, with no TypeScript wrapper in between, is logged by the binding with its kind; each fallback applies and the loop goes on", throws straight through the raw binding in a process of its own and reads the binding's own `sweetview: <kind> threw:` line, so the backstop of D7 is proven apart from the wrappers.

    ```
    $ bun test packages/sweetview-native/src/callbacks.test.ts
     27 pass
     0 fail
    ```

- [x] W1.4 A callback that removes itself or destroys its owner from inside its own call works. A test does both.

    `rust-rewrite/evidence/w1-callbacks.txt`, third column of the same table: for each kind, the test in which the callback removes or replaces itself, and the test in which it disposes of or destroys its owner (the webview, the window, the tray, the notifier, the hook, the single-instance lock, the timeout) from inside its own call; each asserts no crash and that the callback is not called again (or that the replacement is). `popupMenu` takes no callback: it returns the chosen number.

- [x] W1.5 Calling a UI-thread function from a `Worker` throws `sweetview: this call must be made on the UI thread`. The functions `docs/` documents as callable from any thread work from a `Worker`.

    `rust-rewrite/evidence/w1-boundary.txt`, "a UI-thread function called from a Worker throws, and the worker is not the UI thread": each of nine UI-thread functions throws `sweetview: this call must be made on the UI thread` in a `Worker`; `wake` works there. The functions documented as callable from any thread (`completeWebviewRequest` and the streaming ones) answer real requests from a `Worker` in `rust-rewrite/evidence/w2-webview.txt`.

- [ ] W1.6 `bun build --compile` embeds the binding: a demo's compiled executable, copied alone into an empty folder, runs.
- [x] W1.7 The binding loads a second time inside a Bun `Worker` while the UI thread holds it. From the worker, a frame written to the ring followed by the wake call runs the drain function on the UI thread, while the UI thread is inside the blocking loop and under the timer-pumped loop. This replaces today's second `dlopen` of the C library in `packages/sweetview/src/worker.ts` and its `webview_dispatch` call. The spike did not prove this; prove it here before W2.

    `rust-rewrite/evidence/w1-boundary.txt`: "from a Worker, a frame written to the ring then wake() runs the drain on the UI thread inside the blocking loop" and "... under the timer-pumped loop". The worker loads the binding through the same `require`; no `bun:ffi` and no second `dlopen` is involved.

- [x] W1.8 A handler run on the UI thread opens a modal loop of its own (a message box, a popup menu) and, while it is open, the page's calls are still answered and worker replies still drain, as `scheduleDeferred` in `packages/sweetview/src/app.ts` relies on today. Proven under both loop modes.

    `rust-rewrite/evidence/w1-boundary.txt`, "a modal loop opened by a handler (W1.8)", both loop modes. From the fixture's own report in the blocking run: `{"modalOpened":true,"modalReturned":true,"pageCallsInsideModal":6,"drainsInsideModal":1,"timeoutsInsideModal":1,"framesFromWorker":["written while the box was open"]}`; the pumped run reports the same counts.


## W2. The webview

Source of truth for behaviour: the bindings repository's `docs/` and `test/`, and the C++ fork's `sweetview/` pages.

`wry` creates the webview, runs scripts and carries page messages. Assets, the request handler, the frames origin and streamed responses are served by this project's own `WebResourceRequested` handler on the `ICoreWebView2` that `wry` hands out, as the proposal's section "What `wry` lacks, and where each is built" describes; `wry`'s custom protocols are not used.

- [x] W2.1 Every capability of `RawWebview` (the bindings' `Webview` class) is available: constructor forms, `title`, `size`, `navigate`, `setHTML`, `init`, `eval`, `bind`, `bindRaw`, `unbind`, `return`, `run`, `destroy`, `unsafeHandle`, `unsafeWindowHandle`, and `unload`.

    `rust-rewrite/evidence/w2-webview.txt`, "W2.1 the Webview class", 5 tests on real webviews: `new Webview(debug, size)` with its own window (the real `HWND`, checked with `IsWindow` and `GetWindowTextW`), `title`, `size` with each `SizeHint`; `new Webview(debug, size, hwnd)` mounted in a given window; `new Webview(handle)`; `navigate`, `setHTML`, `init`, `eval`, `bind`, `bindRaw`, `return`, `unbind`, `run`, `destroy` (also from inside a binding), `unsafeHandle`, `unsafeWindowHandle`, `unload`.

- [x] W2.2 `setAsset` and `assetOrigin`: `http://webview.localhost`, path matching and validation exactly as `assets.md` states.

    `rust-rewrite/evidence/w2-webview.txt`, "W2.2 setAsset and assetOrigin: raw path, trailing slash, query and fragment, leading slashes, replacement, validation", against `http://webview.localhost`. The same rules as pure logic, with the C++ library's tests: `cargo test -p sweetview-http`, 15 passed.

- [x] W2.3 `setBackgroundColor`: alpha 0 and 255, the error for any other alpha, transparency through to the desktop.

    `rust-rewrite/evidence/w2-webview.txt`: "W2.3 setBackgroundColor: alpha 0 and 255 accepted, any other alpha -1, a bad channel -2, a destroyed webview -3" and "W2.3 alpha 0 shows the window behind a transparent window on the screen; alpha 255 hides it" (pixels read from the screen: the green window behind shows through the transparent one, and the page's own red square is drawn over it).

- [x] W2.4 `setRequestHandler`, `completeRequest`, `completeWebviewRequest` from a worker, `framesOrigin` equal to `http://frames.webview.localhost`, header validation, the 404 and 500 rules, requests from service workers.

    `rust-rewrite/evidence/w2-webview.txt`: "W2.4 the 404 and 500 rules ..." and the live test "W2.7 dynamic HTML, POST echo, binary image, cross-origin iframe, static assets, streaming, service worker, teardown" (answers from a `Worker` through `completeWebviewRequest`, the frames origin `http://frames.webview.localhost` cross-origin from the page, a service worker's request reaching the handler). Header validation: "W2.7 argument checks in the bindings" and `cargo test -p sweetview-http`.

- [x] W2.5 Streaming: `beginResponse`, `writeResponseChunk`, `endResponse` and the worker forms, with the duplicate-begin error and the chunk rules of `request-handler.md`.

    `rust-rewrite/evidence/w2-webview.txt`: "W2.5 beginResponse, writeResponseChunk, endResponse on the UI thread: chunks in order, duplicate begin 1, the chunk rules, -3 after destroy"; the worker forms in the W2.7 live test and in "W2.9 a worker answering and streaming while the UI thread destroys the webview".

- [x] W2.6 `setAllowExternalDrop` and `setFileDropHandler`, with HTML drops inside the page still reaching the page.

    `rust-rewrite/evidence/w2-webview.txt`: "W2.6 a file dropped from the OS reaches setFileDropHandler with its real path; an in-page drag and drop still reaches the page" (the drop is driven through DevTools with a real file) and "W2.7 the file drop handler replaces itself, clears itself, and destroys the webview from inside its call". `setAllowExternalDrop` is read back from WebView2's controller in `crates/sweetview-platform-webview/tests/requests.rs` (`allows_external_drop()` is `Some(true)` by default, `Some(false)` after `set_allow_external_drop(false)`, `Some(true)` again after `true`):

    ```
    $ cargo test -p sweetview-platform-webview --test requests
    test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
    ```

    A drag from Explorer itself was not run: no unattended session can perform one.

- [x] W2.7 The bindings' `test/request-handler.test.ts` and its fixtures are brought into this repository and pass, rewritten for the new API where it changed and asserting the same behaviour.

    `rust-rewrite/evidence/w2-webview.txt`, 11 tests named "W2.7 ...": `packages/sweetview-native/src/request-handler.test.ts` with the fixtures `live-request-handler.ts`, `complete-worker.ts`, `live-callback-teardown.ts`, `live-bind.ts` under `packages/sweetview-native/test/fixtures/`. Assertions about the old package's `JSCallback` bookkeeping (`pendingCallbackCloses`, `fileDropCallbackPtr`) have no counterpart; what they guarded (replace, clear and destroy from inside a call) is asserted on real requests and drops.

- [x] W2.8 Sweetview's own webview tests pass: `request-handler.test.ts`, `app.test.ts`, `worker.test.ts`, `webview-lib.test.ts`.

    `rust-rewrite/evidence/w2-sweetview-tests.txt`: `request-handler.test.ts`, `app.test.ts`, `worker.test.ts`, `webview-lib.test.ts`: 28 pass, 0 fail, 9 skip (the macOS-only tests). The three live tests that were skipped at the baseline for want of a library with the request handler now run and pass: "serves worker routes and isolates the frames origin in a real desktop webview", "registers and clears file drops on a live WebView2 as Window listeners change", "returns clean errors for synchronous Promises and absent worker handlers". `webview-lib.test.ts` asserts the origins on every platform; its `dlopen` caching test, which tested `bun:ffi` plumbing that no longer exists on Windows, runs on macOS only.

- [x] W2.9 Teardown: destroying a webview with requests open, from inside a handler, and from a worker racing the destroy, each behave as `requests.md` states. A test covers each.

    `rust-rewrite/evidence/w2-webview.txt`, "W2.9 teardown", one test each: "destroying a webview with requests open (one pending, one streaming) releases them; run() returns; late answers are -3", "destroying a webview from inside its request handler", "a worker answering and streaming while the UI thread destroys the webview: accepted before, -3 after, no crash".


## W3. Input hooks

- [x] W3.1 `installMouseHook`: every event kind, coordinates, wheel notches, modifiers, swallow per event, one hook per process, dispose from inside the handler.

    `rust-rewrite/evidence/w3-input.txt`: the 13 integration tests of `crates/sweetview-platform-input/tests/windows_hooks.rs` drive a real `WH_MOUSE_LL` hook with `SendInput`: every event kind at the cursor position, wheel notches 1, -2 and 0.5, modifiers, a swallowed move that does not move the pointer, one hook per process (from another thread too), a hook dropped from inside its handler. Through the TypeScript API: "a move arrives with coordinates and modifiers, a second hook is refused, dispose is idempotent" and "a hook may dispose itself from inside its handler, and a handler that throws does not swallow".

- [x] W3.2 `installKeyboardHook`: down, up, repeat, DOM codes, raw code, modifiers after the event, swallow per event.

    `rust-rewrite/evidence/w3-input.txt`: down, repeat and up with `"F24"` and raw `0x87`, a swallowed key that never reaches the system (the next press is a down, not a repeat), modifiers after the event, scan-code injection, in the same integration tests; through the TypeScript API, "down, repeat and up arrive with the DOM code and the raw code, and a swallowed key is swallowed per event".

- [x] W3.3 `permissions`: `needed`, `status`, `request`, `ready`, `autoRequest`, with the Windows answers.

    `rust-rewrite/evidence/w3-input.txt`, "permissions (W3.3)": on Windows `needed` is empty for both features, `status` and `request` are `"not-applicable"` (what the C++ library and `permissions.md` answer there), `ready` is true, `autoRequest` defaults to true and can be set, and a number that names no permission throws `webview permission call failed: error -2`.

- [x] W3.4 The key-code tables of `key_codes.hh` are ported with every test of the C++ fork that covers them.

    `rust-rewrite/evidence/w3-input.txt`: `cargo test -p sweetview-keycodes`, 23 passed. Both tables of `key_codes.hh` are ported (Windows 149 entries, macOS 121, each count asserted), with the C++ fork's table tests and its "scan code from a bare virtual key" test.

- [x] W3.5 The bindings' `examples/input-hooks.ts` runs against the new package, edited only for API changes that `docs/upgrading.md` records.

    `rust-rewrite/evidence/w3-input-hooks-example.txt`: the bindings' `examples/input-hooks.ts` is at `packages/sweetview-native/examples/input-hooks.ts` with no edit at all (its import, `../src/index`, names this package's index); it starts, shows its window, and exits with code 0 when the window is closed.

- [x] W3.6 The hooks, `permissions` and every other name in `rust-rewrite/reference/bindings-exports.txt` are exported by a Sweetview package. Today an application imports them from `@n1h/sweetview-webview-bun`, which Sweetview does not re-export; `docs/upgrading.md` gives the new import for each.

    ```
    $ bun rust-rewrite/verify.ts windows --quick
    PASS  api-surface
          194 exports of 12 package entry points at pre-rust-rewrite: 194 kept, 0 changed with an upgrade row
          32 exports of the bindings package: 32 exported by Sweetview, 0 with an upgrade row
          0 unaccounted for
    ```

    Every name of `rust-rewrite/reference/bindings-exports.txt` is exported by `@n1h/sweetview-native` (`packages/sweetview-native/src/index.ts`: `webview.ts`, `input-hooks.ts`, `permissions.ts`), and so by `@n1h/sweetview/native`.


## W4. Loop, windows, overlays

- [x] W4.1 `runEventLoop`, `quitEventLoop`, `pumpEvents`, and `run()` on an app: both loop modes, with Bun timers and promises running between pumps.

    `rust-rewrite/evidence/w4-windows.txt`: `event-loop.test.ts` (`pumpEvents`, `runEventLoop`/`quitEventLoop`, a second loop refused), "both loop modes serve a window" (a close request and the hit-region poll under the blocking loop and under the Bun-timer loop), and `discardQuit`. Bun timers and promises between pumps: `rust-rewrite/evidence/w1-boundary.txt`, "the pumped loop delivers native timeouts while Bun timers and promises keep running". `run()` on an app: `packages/sweetview/src/app.test.ts` passes on the Rust loop in the full run of `bun test`.

- [x] W4.2 `Window`: every option of `WindowOptions` and every method, per `docs/native/windows.md`. `handle` is the real `HWND`. `Window.fromHandle` wraps a window this process did not create through Sweetview (an application's own `HWND`), with `onResize`, `onMove`, `onClose` and `onFileDrop` working on it, and `WebView.attach` mounts a webview inside it.

    `rust-rewrite/evidence/w4-windows.txt`, "Window on the binding: options read back from the OS" (bounds, title, frame, resizable, minimum size, appearance, topmost, `hideFromTaskbar`, `noActivate`, layering, show, minimise, maximise), "win32 Window" (15 tests), and "Window.fromHandle on an application's own window (made here through bun:ffi) > onResize, onMove, onClose and onFileDrop arrive; dispose leaves the window alive". `handle` is the real `HWND`: the tests pass it to `user32` calls of their own. A webview mounted in a wrapped window: `rust-rewrite/evidence/w2-sweetview-tests.txt`, "WebView.attach preserves exact outer bounds and GWL_STYLE for framed, frameless-resizable, and Window.fromHandle windows".

- [x] W4.2a A webview is mounted inside a window that already exists (`WebView.attach(window, options)`), and the window keeps its styles and outer bounds across the mount, as `preserveGeometry` ensures today.

    `rust-rewrite/evidence/w2-sweetview-tests.txt`: "WebView.attach preserves exact outer bounds and GWL_STYLE for framed, frameless-resizable, and Window.fromHandle windows" passes on the Rust engine.

- [x] W4.3 Overlays: transparent, colour key, opacity, topmost above the taskbar, hidden from the taskbar, no-activate, the hidden first window.

    `rust-rewrite/evidence/w4-windows.txt`: "topmost, hideFromTaskbar, noActivate and layering, kept through a style rewrite", "show() leaves a noActivate window inactive and activates any other", the `colorKey` and opacity tests of `overlay.test.ts`. The hidden first window: `tao` creates a hidden top-level tool window with its event loop, before any window of Sweetview's (`tao` 0.38.0, `src/platform_impl/windows/event_loop.rs`), so Sweetview's own first window is never the process's first.

- [x] W4.4 `setClickThrough` and `setHitRegions` with the refiner, the 10 ms poll and the "no flip while a button is down" rule, per `docs/native/overlays-and-hit-regions.md`.

    `rust-rewrite/evidence/w4-windows.txt`: "setClickThrough sets and clears the click-through bits" and "the 10 ms poll follows the cursor into and out of a polygon, with and without the refiner" on a real window with the real cursor. The rule that click-through never flips while a mouse button is down is tested in the logic crate:

    ```
    $ cargo test -p sweetview-window-logic
    test result: ok. 29 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
    ```

- [x] W4.5 `startDrag`, `startResize`, `minimize`, `toggleMaximize`, `isMaximized`, `closeToTrayOnLastWindow`, `onClose`, `onResize`, `onMove`, `onFileDrop`.

    `rust-rewrite/evidence/w4-windows.txt`: "startDrag hands the window to the OS, which moves it with the cursor until the button is released" and "startResize follows the cursor from an edge while the left button is down" (both with a real left-button press over the test's own window), "minimize, show restoring it, and toggleMaximize on a framed window", "frameless toggleMaximize uses the window's own monitor workArea and restores bounds", "close-to-tray destroys the secondary window and hides the last visible owned window", "onClose intercepts WM_CLOSE and unsubscribing restores default close-and-dispose", "onResize and onMove fire with outer bounds and stop after unsubscribe", "delivers Unicode file drops and cleans up owned, tabbed and borrowed listeners".

- [x] W4.6 `Screen`: `primary`, `all`, `at`, `of`, `bounds`, `cursor`.

    `rust-rewrite/evidence/w4-windows.txt`: "Screen exposes primary, all, at, bounds, and cursor without a window", "Screen.of a window is the screen its frame is on; Screen.bounds holds every screen", "Screen.of(hwnd) resolves the monitor hosting a message window".

- [ ] W4.7 `packages/sweetview-native/src/win32/window.test.ts` and `win32.test.ts` pass. `demos/desktop-pet` and `demos/web-app` run and compile.
- [x] W4.8 An application's own `bun:ffi` modal dialog and popup menu, opened from a `uiMethods` call, work under both loop modes. A fixture under `rust-rewrite/compat/` does this.

    `rust-rewrite/evidence/w4-windows.txt`, `rust-rewrite/compat/own-modal-loops.test.ts`: an application's own `MessageBoxW` and `TrackPopupMenu`, called through `bun:ffi` from a handler, under the blocking loop and under `runEventLoop`; inside each modal loop a native timeout fires and a wake drains. 2 pass, 0 fail.


## W5. Tray, menus, notifications, dialogs, clipboard

- [x] W5.1 `Tray`: icon, tooltip, click, double click, menu on right click, `setIcon`, `setMenu`, re-added when Explorer restarts.

    `rust-rewrite/evidence/w5-tray-menus.txt`, "Tray (binding: tray-icon)", 8 tests on a real notification icon driven with the messages the shell posts: made and disposed; the stock icon when none is given; a left click is a click only once the double-click time has passed, and a double click is a double click and no click; the right-click menu built from the function form on each open; `setIcon`, `setTooltip`, `setMenu`; a throwing handler logged with today's message. Re-adding after an Explorer restart is `tray-icon`'s own (`tray-icon` 0.27.0, `src/platform_impl/windows/mod.rs`, the `S_U_TASKBAR_RESTART` arm); the test posts the registered `TaskbarCreated` message and a click still arrives.

- [x] W5.2 Menus: check marks, icons, submenus, separators, disabled items, the function form rebuilt on each open, `Menu.popup` at a point and at the cursor.

    `rust-rewrite/evidence/w5-tray-menus.txt`, "Menu.popup (binding: muda)" and "win32 icons": check marks, icons, submenus, separators and disabled items read back from the real OS menu; an item chosen inside a submenu; a dismissed menu chooses nothing; the function form called on each open; at a point (the menu's corner reads back at the point given) and at the cursor; `&` doubled; every showing frees what it made (GDI and USER counts).

- [x] W5.3 `Notifier`: WinRT toasts with click, `appId` and identity registration, per `docs/native/notifications.md`. The fallback when WinRT is unavailable or a toast fails is a balloon on a hidden notification icon of the notifier's own, with or without a `Tray`, as `win32/notifier.ts` does today. The C shim that `winrt-toast.ts` compiles at run time with Bun's `cc` is gone.

    `rust-rewrite/evidence/w5-notifier.txt`: 9 pass, 0 fail. Real WinRT toasts with an AUMID registered and clicks routed per toast; an explicit `appId`; the fallback to a balloon on the notifier's own hidden icon when `Show` fails and when WinRT is off, with and without a `Tray`; a throwing `onClick` logged with today's message. `win32/winrt-toast.ts` and its C shim are deleted:

    ```
    $ git ls-files packages/sweetview-native/src/win32/winrt-toast.ts | wc -l
    0
    ```

- [x] W5.4 `pickFolder`, `Clipboard`, `setAppMenu`, `setAppIcon`, `setActivationPolicy`.

    `rust-rewrite/evidence/w5-tray-menus.txt`: "pickFolder (binding: rfd)" (cancelled under the pumped mode and inside the blocking loop; a folder chosen, with the dialog owned by the given window) and "app-wide settings (binding)" (`setAppMenu`, `setAppIcon`, `setActivationPolicy`, which change nothing on Windows, as before). `Clipboard`: `rust-rewrite/evidence/w5-clipboard.txt`, "clipboard round-trips Unicode and empty text, and clears".

- [ ] W5.5 `notifier.test.ts` passes. `demos/menubar-only` and `demos/menubar-notify` run and compile; the tray icon is clicked by hand and the result written down.

## W6. Activation

- [x] W6.1 `registerUrlScheme`, `unregisterUrlScheme`, `onOpenUrl`, `signalReady`, `extractUrlFromArgs`.

    `rust-rewrite/evidence/w6-activation.txt`: `registerUrlScheme` writes the HKCU keys and `unregisterUrlScheme` removes them; `extractUrlFromArgs` matches declared and custom schemes; early URLs are buffered until `signalReady()` and drained in order.

- [x] W6.2 `singleInstance`: an instance built from tag `pre-rust-rewrite` and one built from the rewrite hand off to each other in both directions.

    `rust-rewrite/evidence/w6-single-instance-interop.txt`: the tree of tag `pre-rust-rewrite` (from `git archive`) and the rewrite, each as primary and as secondary. Old to new and new to old both report `handedOff: true`, and the `{args, cwd, url}` payload arrives unchanged.

- [x] W6.3 `activation.test.ts` passes.

    ```
    $ bun test packages/sweetview-native/src/activation.test.ts packages/sweetview-native/src/win32/activation.test.ts
     7 pass
     0 fail
    ```

    Per-test output: `rust-rewrite/evidence/w6-activation.txt`.


## W7. Tabs

- [x] W7.1 `new Window({ tabs: true })`, `WebView.openTab`, `Tab`, `createApp({ tabs: true })`: every behaviour in `rust-rewrite/reference/v1-drafting-tabs-and-window.md` under "Behaviour: tabs on Windows".

    `rust-rewrite/evidence/w7-native-tabs.txt`: a table with one row for each of the 27 bullets of "Behaviour: tabs on Windows" in `rust-rewrite/reference/v1-drafting-tabs-and-window.md`, in the reference's order, and the check or checks that prove it; then the runs. The checks are in `packages/sweetview/src/tabs/win-tabs.test.ts`, which runs two fixtures in processes of their own, each on its own WebView2 profile: `packages/sweetview/test/fixtures/win-tabs.ts` (frame styles and metrics read back from the OS, tabs opened, selected, renamed, reordered, closed, the last-tab rule, tear-off and merge keeping the page, shortcuts, popups, the failed-load page, the tab menu and the system menu read and chosen from a second process, the two-colour backdrop read as pixels, a DPI change, window moves, file drops on the frame and on a moved tab) and `win-tabs-input.ts` (real input: the strip dragged and resized with a held mouse button, a tab dragged out, the only tab dragging its window, a tab dropped on another window's strip, Ctrl+T and Ctrl+W typed).

    ```
    $ bun test packages/sweetview/src/tabs
     76 pass
     0 fail
    ```

    Nothing was skipped in that run: the control that tells whether this session's OS runs a move loop for an injected press (`moveLoopControl()` in `packages/sweetview-native/test/win32-os.ts`) succeeded, so every gesture check was mandatory. Not run, as the evidence file's last section says: a real change of scale (one monitor at one scale; the suggested rectangle of `WM_DPICHANGED` is applied and tested), and a check of its own for `strip.scrolled` (its use in the drop index is unit-tested in `strip-shared.test.ts`).

- [x] W7.2 `demos/native-tabs` runs; its `scripts/win-drive.ts` passes.

    `rust-rewrite/evidence/w7-native-tabs.txt`, section "Runs": `just demos native-tabs app` started, showed its window titled "Tab 1 - Native Tabs" and exited 0 through its own close path; `just demos native-tabs drive <TEMP>/...` runs `scripts/win-drive.ts`:

    ```
    ok   three tabs opened: 3
    ok   window is visible
    ok   tab 1 renamed: Alpha Tab
    ok   captured tabbed window screenshot: 1040x760
    ok   tabbed window maximizes
    ok   tabbed window restores
    ok   moveToNewWindow returns a new visible Window
    ok   mergeAllWindows moves tab back into primary window
    ok   a refused initial navigation shows the failed-load page: This site did not open
    ok   closing the last tab exits the event loop
    PASS
    ```

    (15 lines of `ok` in the file; the ten above are quoted.)


## W8. Packaging

- [x] W8.1 The package holds the prebuilt binding for Windows x64 and the loader finds it after `bun add` from a packed tarball in an empty project.

    `rust-rewrite/evidence/w8-packaging.txt`, `bun rust-rewrite/checks/pack-install.ts`: all eight packages packed; the native tarball holds `package/prebuilt/sweetview.win32-x64-msvc.node` and `binding.d.ts`; `bun install` of the tarballs in an empty project in the temp directory exits 0; a script there imports `@n1h/sweetview/native` and `@n1h/sweetview`, creates a window and reports:

    ```
    PROBE {"platform":"win32-x64","bindingInstalled":true,"primaryScreenHasSize":true,"windowHandleIsBigint":true,"windowBounds":{"x":80,"y":80,"width":320,"height":200},"clipboardIsCallable":true,"rawWebviewIsAClass":true,"assetOrigin":"http://webview.localhost"}
    OK: the packed native package carries the binding and the loader finds it after install
    ```

- [ ] W8.2 `just compile` builds every demo that has the recipe. `just pack` lists what would publish.
- [x] W8.3 `refreshWindowsIcons` and the rest of `packages/sweetview-build` work with no `bun:ffi`.

    `rust-rewrite/evidence/w8-build.txt`: 11 pass, 0 fail, 2 skip (macOS-only signing). `refreshWindowsIcons` goes through the binding (`refreshShellIcons`), does nothing on another OS, and a test asserts no source of `packages/sweetview-build` imports `bun:ffi`.

    ```
    $ git grep -l "bun:ffi" -- packages/sweetview-build/src ':!*.test.ts' | wc -l
    0
    ```


## WT. IPC transports for Tauri 2 and Electron

Pure TypeScript and the same on every OS, so it is done once, here. The contract is `packages/sweetview-ipc`: a page talks through a `Transport` (`call`, `notify`, `onEvent`), and a host carries `CallFrame`, `ReplyFrame` and `EventFrame`. Two transports exist today: `webviewTransport()` and `wsTransport()`.

- [x] WT.1 A page-side `Transport` for Tauri 2 and one for Electron, each importable without pulling Bun code into a page bundle. A page built on `createBridge` runs unchanged on all four transports: only the line that picks the transport differs.

    ```
    $ grep -n "^import" packages/sweetview-ipc-electron/src/client.ts packages/sweetview-ipc-tauri/src/client.ts
    packages/sweetview-ipc-electron/src/client.ts:5:import type { Frame, Transport } from "@n1h/sweetview-ipc";
    packages/sweetview-ipc-electron/src/client.ts:6:import { ELECTRON_API_KEY, type SweetviewIpcApi } from "./channel";
    packages/sweetview-ipc-tauri/src/client.ts:10:import type { CallFrame, EventFrame, ReplyFrame, Transport } from "@n1h/sweetview-ipc";
    $ grep -n "Transport()" demos/web-app/packages/web-app-frontend/src/bridge.ts
    13:const transport = isWebview() ? webviewTransport() : isElectron() ? electronTransport() : isTauri() ? tauriTransport() : wsTransport();
    ```

    The page of `demos/web-app` is the same source on all four; it ran on the Electron and Tauri transports in real shells (WT.5), and on the webview and WebSocket transports as before.

- [x] WT.2 The host side for Electron: the application's `Service` hosted in Electron's main process, carrying the same frames.

    `electronHost(service, ipcMain)` in `packages/sweetview-ipc-electron/src/server.ts`, `exposeSweetviewIpc` in `src/preload.ts` (context isolation on, node integration off). The web-app's real `Service` ran in Electron's main process: `rust-rewrite/evidence/wt5-electron.txt`.

- [x] WT.3 The host side for Tauri 2: what a Tauri application adds so the page's calls reach a backend and events reach the page, with the frame format documented for a backend written in Rust.

    `docs/ipc-tauri.md`, section "Rust backend": the command `sweetview_ipc` and its `frame` argument, the event `sweetview-ipc:event`, the JSON shape of each frame, `Ok`/`Err` replies, sessions and ordering. Reference implementation: `demos/web-app-tauri/src-tauri/src/sweetview_ipc.rs`, run for real in `rust-rewrite/evidence/wt5-tauri.txt`.

- [x] WT.4 `bun test` covers each transport against a stand-in for its host API: a call and its reply, an error reply, `notify`, an event, and a large payload.

    ```
    $ bun test packages/sweetview-ipc-electron packages/sweetview-ipc-tauri
     19 pass
     0 fail
     60 expect() calls
    Ran 19 tests across 2 files.
    ```

    Each file covers a call and its reply, an error reply, `notify`, an event (broadcast and targeted) and a payload over 1 MB each way, against a stand-in for the host API.

- [x] WT.5 The page of `demos/web-app` runs in a real Electron shell and a real Tauri 2 shell, each a small demo under `demos/`, calling a method and receiving an event. The run is written down with what was seen.

    `rust-rewrite/evidence/wt5-electron.txt` (Electron 45.5.0) and `rust-rewrite/evidence/wt5-tauri.txt` (Tauri 2.12.7): in each, the unchanged page called `info.get` and showed its reply, then showed a note that arrived by the `notes.changed` event.

    ```
    PROBE {"location":"http://tauri.localhost/","transportBadge":"Tauri 2 · IPC","infoGet":{"host":"Tauri 2, Rust backend, 1 session","runtime":"Rust backend, Tauri 2.12.7","platform":"Windows / x64"},"notesBefore":"2","notesChangedEvent":{"notesAfter":"3","msFromClick":56}}
    ```

- [x] WT.6 `docs/` has a page for each transport, and `docs/ipc.md` lists all four.

    ```
    $ ls docs/ipc-*.md
    docs/ipc-electron.md
    docs/ipc-tauri.md
    docs/ipc-ws.md
    $ grep -n "^### Transports" docs/ipc.md
    248:### Transports
    $ grep -c "webviewTransport()\|wsTransport()\|electronTransport()\|tauriTransport()" docs/ipc.md
    10
    ```

    `docs/ipc.md` has a "Transports" section listing `webviewTransport`, `wsTransport`, `electronTransport` and `tauriTransport`; `docs/README.md` and the root `README.md` list both new pages.


## W9. Removal and documents

- [x] W9.1 Every Windows file in `rust-rewrite/reference/ffi-files.md` is deleted or free of `bun:ffi`. The three shared files that hold FFI for both platforms today (`packages/sweetview/src/app.ts`, `webview-lib.ts`, `worker.ts`) no longer import it; what macOS still needs of that code sits in macOS-only files. `ffi-allowlist.txt` holds macOS-only files and probes, each with its reason, and at most three `setup:` entries.

    `packages/sweetview-native/src/win32/api.ts`, `message-window.ts`, `init.ts`, `icon.ts`, `tabbed-window.ts`, `winrt-toast.ts` are deleted; every other Windows source file imports no `bun:ffi`. The only files under `win32/` that still import it are two tests, listed as probes:

    ```
    $ git grep -l -E "(from|import\()[[:space:]]*[\"']bun:ffi[\"']|require\([\"']bun:ffi[\"']\)" -- packages/sweetview/src/app.ts packages/sweetview/src/worker.ts packages/sweetview/src/webview-lib.ts packages/sweetview-native/src/win32
    packages/sweetview-native/src/win32/activation.test.ts
    packages/sweetview-native/src/win32/window-native.test.ts
    $ bun rust-rewrite/verify.ts windows --quick
    PASS  ffi
          27 files import bun:ffi, 27 allowlisted, 0 of them as setup
    ```

    `packages/sweetview/src/app.ts`, `webview-lib.ts` and `worker.ts` import none; what macOS still needs of that code is in `darwin-webview-host.ts`, `darwin-webview-lib.ts` and `darwin-worker-wake.ts` (decision D18). `rust-rewrite/ffi-allowlist.txt` holds 10 macOS-only sources, each with what macOS uses it for until the macOS goal, and 17 probes (tests, fixtures and demo scripts that read real OS state or drive real OS input); no `setup:` entry. One test went with the deleted files: "the message window's JSCallback window procedure runs (WM_CREATE arrives synchronously)", which tested `message-window.ts`'s own window procedure; the icon and monitor tests that called `api.ts` are rewritten on `Window#setIcon` and `Screen.at` and assert the same OS state.

- [x] W9.2 `docs/` describes the result: no page tells a Windows reader that Sweetview calls the OS through `bun:ffi`.

    `rust-rewrite/evidence/w9-docs.txt`: every line of `docs/` and the root `README.md` that names `bun:ffi`, `dlopen`, `JSCallback`, the bindings package, `WEBVIEW_PATH` or the C++ library, with the kinds they fall into. Each is a statement about macOS until its goal, about an application's own `bun:ffi`, about a module that loads none, or the history of a name; the pages that explain mechanism (`README.md`, `docs/native.md`, `docs/app.md`, `docs/webview-library.md`, `docs/worker.md`, `docs/native/event-loop-and-icons.md`) say Rust through N-API on Windows.

- [x] W9.3 `docs/upgrading.md` exists with one row per export of the three old API surfaces, and `rust-rewrite/compat/` exercises each row.

    `docs/upgrading.md`: Part A (the published 0.1.x and 0.2.x API), Part B (the `v1-drafting` API, with the internal modules applications imported by file path) and Part C (the bindings package), one row per export, each naming what an application writes now.

    ```
    $ grep -c "^|" docs/upgrading.md
    1081
    $ bun rust-rewrite/verify.ts windows --quick
    PASS  api-surface
          194 exports of 12 package entry points at pre-rust-rewrite: 194 kept, 0 changed with an upgrade row
          32 exports of the bindings package: 32 exported by Sweetview, 0 with an upgrade row
          0 unaccounted for
    PASS  upgrade-guide
          docs/upgrading.md: present
          rust-rewrite/compat: 3 test files
    $ bun test rust-rewrite/compat
     20 pass
     0 fail
     52 expect() calls
    Ran 20 tests across 3 files.
    ```

    `rust-rewrite/compat/upgrade-guide.test.ts` reads the guide's own tables and imports the new form of every row (and type-checks the type rows through `upgrade-types.ts`); `behaviour.test.ts` runs the rows whose behaviour changed (the webview class, tabs on the Rust frame, an application's own window, the removed start-up helpers) in fixtures of their own.

- [x] W9.4 When `rust-rewrite/local/dependents.txt` exists, each listed application was upgraded in a temp copy and its own checks run; the result is in `rust-rewrite/local/dependents-result.md`.

    `rust-rewrite/local/dependents.txt` does not exist on this machine, so there was no application to upgrade:

    ```
    $ bun rust-rewrite/verify.ts windows --quick
    PASS  dependents
          no rust-rewrite/local/dependents.txt on this machine: nothing to verify
    ```

    This work did not make the file, because that means searching the owner's private repositories (decision D19, requirement R6); `rust-rewrite/OWNER-ACTIONS.md`, section 3, says how the owner runs it.


## W10. Safety and handoff

- [ ] W10.1 `rust-rewrite/UNSAFE-LEDGER.md` is current and every entry has its reason.
- [ ] W10.2 A reviewer that did not write the code read every `unsafe` block against `UNSAFE-POLICY.md` and every checklist item against its evidence. Its findings are in `rust-rewrite/evidence/review-windows.md` and each is fixed or answered.
- [ ] W10.3 `rust-rewrite/HANDOFF-macos.md` exists: what compiles for macOS, what is stubbed behind `cfg(target_os = "macos")`, the result of `cargo check --target aarch64-apple-darwin`, and anything the Windows work learned that changes `CHECKLIST-macos.md`.
- [ ] W10.4 `rust-rewrite/OWNER-ACTIONS.md` lists everything left for the owner: publishing, upstream pull requests, the forks' state.
