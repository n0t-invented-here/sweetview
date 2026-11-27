# Linux checklist

Runs after the macOS goal is complete, on a Linux machine with a desktop session. Same rule for ticking as the other checklists: an item is ticked when its acceptance has been run and the output is pasted under it or saved under `rust-rewrite/evidence/`.

Sweetview has no Linux support today: the README's platform table says a window "throws before creating anything" there, and the C++ fork's additions do nothing on Linux. So nothing is ported here. This goal adds the minimum that makes Sweetview usable on Linux, on the Rust the first two goals wrote.

Not in this goal, because no Linux desktop offers them in one form and nothing exists today to keep: transparent click-through overlays with hit regions, system-wide input hooks, native tabs. Each of those calls throws on Linux with a message that says so, as the native calls do today.

## L0. Ground

- [ ] L0.1 The workspace builds on Linux x64 with WebKitGTK: `cargo build`, `cargo test`, `cargo clippy` pass.
- [ ] L0.2 The GitHub Actions workflow also builds and tests on `ubuntu-latest` and produces a binding for Linux x64.
- [ ] L0.3 The three proofs of `rust-rewrite/spike/` pass on Linux.

## L1. Window and webview

- [ ] L1.1 `createApp` opens a `tao` window with a `wry` webview on WebKitGTK, serves the page's assets at the page's origin, and answers page calls with no TCP. `demos/web-app` runs.
- [ ] L1.2 Both loop modes work.
- [ ] L1.3 The request handler and streamed responses work, or the limit of WebKitGTK that prevents one is written in `docs/` with the test that shows it.
- [ ] L1.4 `Window`: show, hide, bounds, title, minimise, maximise, close with `onClose`.

## L2. Tray, menu, notification, dialog

- [ ] L2.1 `Tray` through `tray-icon`'s `ksni` feature: icon, tooltip, a menu, and a left click. `demos/menubar-only` runs.
- [ ] L2.2 `Notifier` through `notify-rust`: title, body, and a click where the notification server reports one.
- [ ] L2.3 `pickFolder` through `rfd`. `Clipboard` text.

## L3. Packaging and documents

- [ ] L3.1 The package holds the binding for Linux x64 and `bun build --compile` embeds it.
- [ ] L3.2 The README's platform table and `docs/` state what works on Linux and what throws.
- [ ] L3.3 Every Windows and macOS check still passes: both jobs of the workflow are green on the final commit.

## L4. Safety

- [ ] L4.1 `rust-rewrite/UNSAFE-LEDGER.md` is current for Linux.
- [ ] L4.2 A reviewer that did not write the code read every Linux `unsafe` block against `UNSAFE-POLICY.md` and every item here against its evidence. Findings are in `rust-rewrite/evidence/review-linux.md`, each fixed or answered.
