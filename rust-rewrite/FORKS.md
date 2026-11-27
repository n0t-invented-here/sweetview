# Forks: none

No crate is forked. `tao`, `wry`, `muda`, `tray-icon` and `rfd` are used as published on crates.io, at the versions `SWEETVIEW-RESTART-PROPOSAL.md` lists. The workspace has no git dependency and no path dependency outside this repository.

## `wry`: five behaviours it lacks, each built outside it

`wry` 0.58.2 does not have these five behaviours as API. It does hand out the native objects they are built on, so each is written in this project's platform crate. References are to the crate's source at 0.58.2.

| Behaviour | What `wry` has | How this project builds it |
|---|---|---|
| Streamed response bodies, Windows | A responder that takes the whole body: `RequestAsyncResponder::respond` (`src/lib.rs:451`), turned into one `SHCreateMemStream` (`src/webview2/mod.rs:1261`) | This project's own `WebResourceRequested` handler, registered on the `ICoreWebView2` from `WebViewExtWindows::webview()` with responses made by `environment()` (`src/lib.rs:2404-2407`), and its own `IStream` whose `Read` waits for the next chunk. No `wry` custom protocol is registered on Windows, so `wry` attaches no handler of its own (`src/webview2/mod.rs:536`). The same handler serves assets, the request handler and the frames origin, at exactly `http://webview.localhost` and `http://frames.webview.localhost`, the way the C++ library does today |
| Streamed response bodies, macOS | One `didReceiveData` per response (`src/wkwebview/class/url_scheme_handler.rs`) | `WebViewBuilderExtMacos::with_webview_configuration` (`src/lib.rs:1672`): this project creates the `WKWebViewConfiguration` and registers its own `WKURLSchemeHandler` for the `webview` and `webview-frames` schemes, which calls `didReceiveData` per chunk. No `wry` custom protocol is registered for those schemes |
| Page messages from the top-level document only, macOS | Its message handler does not check the frame | This project's own `WKScriptMessageHandler`, added through `WebViewExtMacOS::manager()` (`src/lib.rs:2555`), which returns early unless `frameInfo.isMainFrame`. `wry`'s own IPC handler is not used on macOS |
| Navigation-failed event, macOS | No `didFailNavigation` or `didFailProvisionalNavigation`; `wry` installs its own navigation delegate (`src/wkwebview/mod.rs:680`) | A delegate of this project's that forwards every call to `wry`'s delegate and adds the two failure methods, set on the `WKWebView` from `WebViewExtMacOS::webview()` (`src/lib.rs:2553`) |
| Drag routing, macOS: drags from other apps only, file drags to the handler, the rest to WebKit, one route per drag | A drag handler that is given `Enter`, `Over`, `Drop` and `Leave` with the dragged paths; returning `false` hands the drag to WebKit (`src/wkwebview/drag_drop.rs:79-81`). It is not given the drag's source | `with_drag_drop_handler`, with this project keeping the route chosen at `Enter` until `Drop` or `Leave`. Whether a drag began inside the page comes from the page itself: a main-frame script reports `dragstart` and `dragend` |

Already in `wry`, nothing to build: requests from service workers, shared workers and cross-origin iframes reaching a handler on Windows; requests held open until answered; page messages from the top-level document only on Windows.

Windows needs the first row only, and it is the C++ library's own design moved into Rust. The four macOS rows are designed from the source and have not been run: group M0 of `CHECKLIST-macos.md` builds and runs each one before anything depends on it.

## `tray-icon`

Used as published. The proposal once planned a balloon addition inside it; on this branch the notifier shows its fallback balloon on a hidden notification icon of its own (`packages/sweetview-native/src/win32/notifier.ts`), so that code is this project's, on `Shell_NotifyIconW`.

## If a behaviour cannot be built through these handles

Adjust the design first: another handle, another crate, or this project's own code for that one piece. A fork is the last choice. It needs a repository only the owner can create, so it is recorded in `rust-rewrite/DECISIONS.md` with the evidence and in `rust-rewrite/OWNER-ACTIONS.md`, and every item that does not depend on it is finished first.
