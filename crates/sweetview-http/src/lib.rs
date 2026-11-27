//! The rules of the webview's request handler that need no OS call.
//!
//! Ported from the C++ fork's `http_request.hh` and the request-path parts of
//! `engine_base.hh`: header JSON in and out, RFC 9110 name and value rules,
//! status and size limits, request-URL splitting and origin classification,
//! asset-path matching, and the routing that decides between an asset, the
//! request handler, and the 404 answer.
#![forbid(unsafe_code)]

mod error;
mod headers;
mod route;
mod url;

pub use error::ErrorCode;
pub use headers::{
    header_lines, headers_from_json, headers_from_json_bytes, headers_to_json, is_tchar, is_valid_header_name,
    is_valid_header_value, reason_phrase, Header,
};
pub use route::{
    normalize_asset_path, route_request, validate_body_len, validate_request_id, validate_response_head,
    validate_status, Asset, AssetTable, Route, MAX_BODY_LEN,
};
pub use url::{
    classify_request_origin, split_request_url, RequestOrigin, RequestUrl, MACOS_ASSET_ORIGIN, MACOS_FRAMES_ORIGIN,
    WINDOWS_ASSET_ORIGIN, WINDOWS_FRAMES_ORIGIN,
};
