# sweetview-http

Job: the rules of the webview's request handler that need no OS call.

| Item | What it decides |
|---|---|
| `ErrorCode` | `webview_error_t` with its numeric values (`code()`, `from_code()`) |
| `headers_from_json`, `headers_from_json_bytes` | response headers from JSON, as an object or as `[name, value]` pairs, under the strict rules of `request-handler.md`: RFC 8259 to the letter, valid UTF-8, no U+0000, RFC 9110 token names, values without CR, LF, NUL or other controls but tab; `null` drops a header |
| `headers_to_json` | the request headers handed to the request handler, a JSON array of `[name, value]` pairs |
| `header_lines`, `reason_phrase` | the response head as WebView2's `CreateWebResourceResponse` takes it |
| `split_request_url`, `classify_request_origin` | the raw path and exact authority of a request URL, and which origin it belongs to: `http://webview.localhost` and `http://frames.webview.localhost` (Windows), `webview://localhost` and `webview-frames://localhost` (macOS) |
| `AssetTable`, `normalize_asset_path` | assets keyed and matched as `assets.md` states: raw path, query and fragment removed, leading slashes ignored, trailing slash kept |
| `route_request` | asset, request handler, or 404 |
| `validate_response_head`, `validate_status`, `validate_body_len`, `validate_request_id` | the argument checks of the answering calls: status 100-599, sizes up to 4 GiB - 1, id not 0 |

Ported from the C++ fork's `http_request.hh` and `engine_base.hh`; every C++ unit test of these rules is ported, and each Rust test names the C++ test it came from.

The header reader is written out rather than built on `serde_json`, which is used for the output side: the rules are stricter than JSON's, and the result must keep repeated names, key order and the literal text of numbers.

`unsafe` is forbidden in this crate.
