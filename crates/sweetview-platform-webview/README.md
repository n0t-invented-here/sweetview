# sweetview-platform-webview

Job: what the webview needs on top of `wry` that `wry` has no API for, and the C++ fork's page behaviour where `wry` changes it.

The caller builds the `wry::WebView` (with `wry`'s own IPC handler and no `wry` custom protocols) and hands it to `WebviewExtras::attach`, which adds the rest through `WebViewExtWindows::controller()`, `webview()` and `environment()` and the typed interfaces of `webview2-com`.

| Item | What it gives | Why `wry` does not serve |
|---|---|---|
| `WebviewExtras::set_asset`, `set_request_handler`, `Responder` | one `WebResourceRequested` handler on `http://webview.localhost` and `http://frames.webview.localhost`: assets first, then the request handler; requests held open with a deferral and answered from any thread; 404 and 500 rules; filters with every request source kind where `ICoreWebView2_22` exists | `wry`'s custom protocols take whole bodies and register their own origins |
| `Responder::begin`, `write_chunk`, `end` | streamed bodies through an `IStream` whose `Read` fills WebView2's buffer or reports the end, as the C++ fork's did; a chunk is copied and the call returns at once, on any thread | `RequestAsyncResponder::respond` takes the whole body |
| `with_page_behaviour` (for the caller's builder) and `attach` | the C++ fork's page behaviour: zoom, pinch zoom and swipe navigation on (`wry`'s own builder options), CSS `app-region` off, a download left to WebView2's own interface, a page's `window.close()` doing nothing | `wry` turns zoom, pinch and swipe off, turns `app-region` on, marks every download handled and destroys its container on `window.close()`, the last three with no option |
| `general_autofill` | the profile's general autofill preference, for the caller to hand to `with_general_autofill_enabled` so that what `wry` writes is what the profile had | `wry` writes the preference on every build and has no getter |
| `set_file_drop_handler`, `set_allow_external_drop` | the C++ fork's drop script and `WebMessageReceived` handler reading `ICoreWebView2File` paths, with WebView2's own drop target left in place; `ICoreWebView2Controller4::AllowExternalDrop` | `with_drag_drop_handler` revokes WebView2's drop targets and refuses non-file drags |
| `set_background_color` | `ICoreWebView2Controller2::DefaultBackgroundColor`, alpha 0 or 255, any other alpha refused | `wry`'s setter turns any non-zero alpha into 255 instead of refusing it |
| `set_accelerator_key_handler`, `set_navigation_failed_handler`, `note_host_navigation`, `notify_parent_window_position_changed`, `call_devtools_protocol_method` | what the tabs library does to a tab's WebView2, with its navigation-failure rules | no API |
| `add_user_script`, `remove_user_script`, `scripts_pending`, `set_scripts_registered_handler`, `stop_navigation` | scripts at document creation that can be removed again; the call returns at once, and the caller holds its navigations until WebView2 reports every script registered (it reports that only once a navigation in flight has its response or is stopped) | `with_initialization_script` cannot remove a script |
| `create_environment`, `default_user_data_folder` | a WebView2 environment created as the C++ fork creates it (null options, `%APPDATA%\<exe name>`) for `with_environment` | `wry` creates its environment with its own browser arguments, which cannot share a data folder with today's product |

`wry`'s IPC handler also receives the drop script's message, a body of exactly `FILE_DROP_MESSAGE`; the IPC handler given to `wry` ignores it (`is_file_drop_message`).

Dropping `WebviewExtras` tears down in the order of `requests.md`: answering calls are refused from then on, open streams are aborted, the WebView2 controller is closed, open requests are released unanswered, and every handler is unregistered. It is dropped as part of dropping the webview, right before the `wry::WebView`.

On other platforms the same public types exist and `attach` returns `ErrorCode::Unspecified`.

The `test-support` feature (`test_support`, Windows only) reads back from WebView2 what a person would see (the page settings, the focus, the container window, downloads, the zoom factor) for the tests of the crates that build webviews with this one. Only dev-dependencies enable it, so it is never in the binding an application loads.

This is a platform crate: it may hold `unsafe`, under `rust-rewrite/UNSAFE-POLICY.md`.
