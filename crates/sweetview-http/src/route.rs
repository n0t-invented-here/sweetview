//! The asset table, the routing of one request, and the argument checks of
//! the answering calls. From `engine_base.hh` and the request path of
//! `win32_edge.hh`.

use std::collections::HashMap;

use crate::headers::{headers_from_json, is_valid_header_value, Header};
use crate::url::{classify_request_origin, split_request_url, RequestOrigin};
use crate::ErrorCode;

/// The largest body, chunk or asset: 4 GiB - 1. WebView2 and WebKit take body
/// sizes as 32-bit lengths on some paths.
pub const MAX_BODY_LEN: usize = u32::MAX as usize;

/// The key an asset path or a request path is stored and matched under: query
/// string and fragment removed, leading slashes ignored, the rest kept raw (not
/// percent-decoded, a trailing slash kept). `"/a/b.js?x"` and `"a/b.js"` are
/// the same key.
pub fn normalize_asset_path(path: &str) -> String {
    let end = path.find(['?', '#']).unwrap_or(path.len());
    let head = &path[..end];
    head.trim_start_matches('/').to_string()
}

/// Bytes served at a path of the page's own origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    /// The `Content-Type` header value.
    pub mime: String,
    /// The body.
    pub data: Vec<u8>,
}

/// The webview's asset table.
#[derive(Clone, Debug, Default)]
pub struct AssetTable {
    assets: HashMap<String, Asset>,
}

impl AssetTable {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores `data` at `path`, replacing what was there. Refused with
    /// [`ErrorCode::InvalidArgument`], the table left as it was, when `mime` is
    /// not a valid header value (it becomes `Content-Type`) or `data` is larger
    /// than [`MAX_BODY_LEN`].
    pub fn set(&mut self, path: &str, mime: &str, data: Vec<u8>) -> Result<(), ErrorCode> {
        if !is_valid_header_value(mime) {
            return Err(ErrorCode::InvalidArgument);
        }
        validate_body_len(data.len())?;
        self.assets.insert(normalize_asset_path(path), Asset { mime: mime.to_string(), data });
        Ok(())
    }

    /// The asset for a request path (`"/a/b.js?x"` matches `"a/b.js"`).
    pub fn find(&self, request_path: &str) -> Option<&Asset> {
        self.assets.get(&normalize_asset_path(request_path))
    }

    /// How many assets are stored.
    pub fn len(&self) -> usize {
        self.assets.len()
    }

    /// True when no asset is stored.
    pub fn is_empty(&self) -> bool {
        self.assets.is_empty()
    }
}

/// What one request to the webview's origins is answered with.
#[derive(Debug, PartialEq, Eq)]
pub enum Route<'a> {
    /// `404 Not Found` with no body: the URL is on neither origin, or no asset
    /// matched and no request handler is set.
    NotFound,
    /// `200 OK` with the asset's bytes and its MIME type as `Content-Type`.
    Asset(&'a Asset),
    /// Handed to the request handler, held open until answered. When the body
    /// cannot be read in full, or the request cannot be held open, the answer is
    /// a bare `500` instead, so nothing reaches the network.
    Handler,
}

/// Routes one request URL: on the main origin the asset table answers first;
/// what it misses, and every request to the frames origin, goes to the request
/// handler when one is set and is 404 otherwise. Any other URL is 404.
pub fn route_request<'a>(url: &str, assets: &'a AssetTable, has_handler: bool) -> Route<'a> {
    let origin = split_request_url(url).map(|parts| (classify_request_origin(&parts), parts));
    match origin {
        None | Some((RequestOrigin::Other, _)) => Route::NotFound,
        Some((RequestOrigin::Main, parts)) => match assets.find(&parts.path) {
            Some(asset) => Route::Asset(asset),
            None if has_handler => Route::Handler,
            None => Route::NotFound,
        },
        Some((RequestOrigin::Frames, _)) if has_handler => Route::Handler,
        Some((RequestOrigin::Frames, _)) => Route::NotFound,
    }
}

/// A request id handed to the request handler is never 0.
pub fn validate_request_id(id: u64) -> Result<(), ErrorCode> {
    if id == 0 {
        Err(ErrorCode::InvalidArgument)
    } else {
        Ok(())
    }
}

/// A response status is 100 to 599.
pub fn validate_status(status: i32) -> Result<(), ErrorCode> {
    if (100..=599).contains(&status) {
        Ok(())
    } else {
        Err(ErrorCode::InvalidArgument)
    }
}

/// A body or chunk is at most [`MAX_BODY_LEN`] bytes.
pub fn validate_body_len(len: usize) -> Result<(), ErrorCode> {
    if len > MAX_BODY_LEN {
        Err(ErrorCode::InvalidArgument)
    } else {
        Ok(())
    }
}

/// The checks `complete` and `begin` share: the id, the status, and the headers
/// under the strict rules of [`headers_from_json`] (`None` or `""` is none).
/// Every failure is [`ErrorCode::InvalidArgument`].
pub fn validate_response_head(id: u64, status: i32, headers_json: Option<&str>) -> Result<Vec<Header>, ErrorCode> {
    validate_request_id(id)?;
    validate_status(status)?;
    match headers_json {
        None => Ok(Vec::new()),
        Some(json) => headers_from_json(json).ok_or(ErrorCode::InvalidArgument),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_with(path: &str) -> AssetTable {
        let mut t = AssetTable::new();
        t.set(path, "text/javascript", b"x".to_vec()).unwrap();
        t
    }

    // C++: "find_asset: split request paths match on both platforms"
    #[test]
    fn split_request_paths_match_on_both_platforms() {
        let t = table_with("a/b.js");
        for url in [
            "webview://localhost/a/b.js?v=2#top",
            "http://webview.localhost/a/b.js?v=2#top",
            "webview://localhost//a/b.js",
        ] {
            let parts = split_request_url(url).unwrap();
            assert!(t.find(&parts.path).is_some(), "{url}");
        }
    }

    // C++: "webview_set_asset: MIME and size validation" (the engine half; the
    // size cases cannot allocate 4 GiB here, so the limit is checked directly).
    #[test]
    fn set_asset_mime_and_size_validation() {
        let mut t = AssetTable::new();
        for bad in ["text/plain\r\nX: y", "text/plain\nX: y", "text/plain\rX", "text/\x01plain", "text/plain\n"] {
            assert_eq!(t.set("a.txt", bad, b"x".to_vec()), Err(ErrorCode::InvalidArgument), "{bad:?}");
        }
        assert!(t.find("a.txt").is_none());
        assert_eq!(validate_body_len(MAX_BODY_LEN + 1), Err(ErrorCode::InvalidArgument));
        assert_eq!(validate_body_len(MAX_BODY_LEN), Ok(()));
        assert_eq!(t.set("a.txt", "text/plain;\tcharset=utf-8", b"x".to_vec()), Ok(()));
        assert!(t.find("a.txt").is_some());
    }

    // assets.md: raw path, not percent-decoded, trailing slash kept, query and
    // fragment removed, leading slashes ignored; a second set replaces.
    #[test]
    fn asset_path_matching_rules() {
        let mut t = AssetTable::new();
        t.set("/dir/", "text/plain", b"dir".to_vec()).unwrap();
        t.set("a b.txt", "text/plain", b"space".to_vec()).unwrap();
        t.set("a%20b.txt", "text/plain", b"encoded".to_vec()).unwrap();
        t.set("index.html", "text/html", b"one".to_vec()).unwrap();
        t.set("index.html", "text/html", b"two".to_vec()).unwrap();
        assert_eq!(t.find("/dir/").unwrap().data, b"dir");
        assert!(t.find("/dir").is_none());
        assert_eq!(t.find("/a%20b.txt").unwrap().data, b"encoded");
        assert_eq!(t.find("/index.html?x=1#y").unwrap().data, b"two");
        assert_eq!(t.find("///index.html").unwrap().data, b"two");
        assert!(t.find("/INDEX.html").is_none());
        assert_eq!(normalize_asset_path("/?q"), "");
        assert_eq!(normalize_asset_path("#/x"), "");
        assert_eq!(normalize_asset_path("///"), "");
        assert_eq!(t.len(), 4);
    }

    // request-handler.md "Origins": assets first on the main origin, the
    // handler for the rest and for the frames origin, 404 without a handler or
    // off both origins.
    #[test]
    fn routing_and_the_404_rule() {
        let t = table_with("index.html");
        let asset = t.find("index.html").unwrap();
        assert_eq!(route_request("http://webview.localhost/index.html", &t, false), Route::Asset(asset));
        assert_eq!(route_request("http://webview.localhost/index.html", &t, true), Route::Asset(asset));
        assert_eq!(route_request("http://webview.localhost/other", &t, false), Route::NotFound);
        assert_eq!(route_request("http://webview.localhost/other", &t, true), Route::Handler);
        // The frames origin never reads the asset table.
        assert_eq!(route_request("http://frames.webview.localhost/index.html", &t, false), Route::NotFound);
        assert_eq!(route_request("http://frames.webview.localhost/index.html", &t, true), Route::Handler);
        assert_eq!(route_request("http://webview.localhost:81/index.html", &t, true), Route::NotFound);
        assert_eq!(route_request("not a url", &t, true), Route::NotFound);
        assert_eq!(route_request("webview://localhost/index.html", &t, false), Route::Asset(asset));
    }

    // engine_base.hh complete_request / begin_response argument checks.
    #[test]
    fn response_head_checks() {
        assert_eq!(validate_response_head(0, 200, None), Err(ErrorCode::InvalidArgument));
        assert_eq!(validate_response_head(1, 99, None), Err(ErrorCode::InvalidArgument));
        assert_eq!(validate_response_head(1, 600, None), Err(ErrorCode::InvalidArgument));
        assert_eq!(validate_response_head(1, 100, None), Ok(vec![]));
        assert_eq!(validate_response_head(1, 599, Some("")), Ok(vec![]));
        assert_eq!(validate_response_head(1, 200, Some("{\"Bad Name\":\"x\"}")), Err(ErrorCode::InvalidArgument));
        assert_eq!(
            validate_response_head(1, 200, Some("[[\"A\",\"1\"],[\"A\",\"2\"]]")),
            Ok(vec![("A".into(), "1".into()), ("A".into(), "2".into())])
        );
    }
}
