# sweetview-platform-webview

Job: the webview on Windows, made and driven as the C++ fork's `win32_edge.hh` makes and drives it, and what Sweetview adds to it, through the typed WebView2 interfaces of `webview2-com`. `wry` is not used: its creation path sets and registers what the fork never did, with no way to leave it out (DECISIONS D46).

| Item | What it gives |
|---|---|
| `Webview::create(parent, layout, devtools)` and its methods | the `webview_widget` child window (`WS_EX_CONTROLPARENT`, `WS_CHILD`; its `WM_SIZE` sizes the controller) and the WebView2 controller on it, made with the fork's retry and its answer to a quit; the two settings the fork sets (devtools from `debug`, status bar off) and no other; navigate, HTML, evaluate, bounds, fill, visibility, focus, reparent, the background colour (alpha 0 or 255). Dropping it closes the controller and destroys the widget. `host.rs` names the fork's lines for each step |
| `create_environment`, `default_user_data_folder` | the WebView2 environment created as the fork creates it (null options, `%APPDATA%\<exe name>`), shared by a thread's webviews |
| `WebviewExtras::attach(&Webview, ...)`, `set_asset`, `set_request_handler`, `Responder` | one `WebResourceRequested` handler on `http://webview.localhost` and `http://frames.webview.localhost`: assets first, then the request handler; requests held open with a deferral and answered from any thread; 404 and 500 rules; filters with every request source kind where `ICoreWebView2_22` exists |
| `Responder::begin`, `write_chunk`, `end` | streamed bodies through an `IStream` whose `Read` fills WebView2's buffer or reports the end, as the fork's did; a chunk is copied and the call returns at once, on any thread |
| `set_page_message_handler` | the page's messages (`window.chrome.webview.postMessage`), from this crate's own `WebMessageReceived` |
| `set_file_drop_handler`, `set_allow_external_drop` | the fork's drop script and message, reading `ICoreWebView2File` paths, with WebView2's own drop target left in place; `ICoreWebView2Controller4::AllowExternalDrop` |
| the clipboard-read permission | the fork's `PermissionRequested` handler |
| `set_accelerator_key_handler`, `set_navigation_failed_handler`, `set_new_window_handler`, `note_host_navigation`, `notify_parent_window_position_changed`, `call_devtools_protocol_method` | what the tabs library does to a tab's WebView2; `NewWindowRequested` is registered only while a popup handler is set |
| `add_user_script`, `remove_user_script`, `scripts_pending`, `set_scripts_registered_handler`, `stop_navigation` | scripts at document creation that can be removed again; the call returns at once, and the caller holds its navigations until WebView2 reports every script registered |

The page message handler never receives the drop script's message, `FILE_DROP_MESSAGE` (`is_file_drop_message`).

Dropping `WebviewExtras` tears down in the order of `requests.md`: answering calls are refused from then on, open streams are aborted, the WebView2 controller is closed, open requests are released unanswered, and every handler is unregistered. It is dropped right before the `Webview`.

On other platforms the same public types exist; `Webview::create` and `attach` return `ErrorCode::Unspecified`.

The `test-support` feature (`test_support`, Windows only) reads back from WebView2 and the OS what a person would see (the page settings, the focus, the widget, downloads, the zoom factor) for the tests of this crate and of the crates that build webviews with it. Only dev-dependencies enable it, so it is never in the binding an application loads.

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
