//! Request-URL splitting and origin classification, from `http_request.hh`.

/// The page's own origin on Windows, answered from the asset table first.
pub const WINDOWS_ASSET_ORIGIN: &str = "http://webview.localhost";
/// The origin cross-origin from the page on Windows, answered by the request handler.
pub const WINDOWS_FRAMES_ORIGIN: &str = "http://frames.webview.localhost";
/// The page's own origin on macOS.
pub const MACOS_ASSET_ORIGIN: &str = "webview://localhost";
/// The origin cross-origin from the page on macOS.
pub const MACOS_FRAMES_ORIGIN: &str = "webview-frames://localhost";

/// The parts of a request URL (`scheme://authority/path?query#fragment`) the
/// request path routes on, taken from the URL string itself so every platform
/// matches the same way.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestUrl {
    /// Lowercased.
    pub scheme: String,
    /// Everything between `://` and the first `/`, `?` or `#`, lowercased. A
    /// port or userinfo stays in it, so `localhost:8080` is not `localhost`.
    pub authority: String,
    /// Raw (not percent-decoded), from the first `/` after the authority up to
    /// the first `?` or `#`; `/` when the URL has no path. A trailing slash is
    /// kept.
    pub path: String,
}

/// Splits `url`; `None` when it has no `://` or an empty scheme.
pub fn split_request_url(url: &str) -> Option<RequestUrl> {
    let scheme_end = url.find("://").filter(|&i| i > 0)?;
    let authority_start = scheme_end + 3;
    let rest = &url[authority_start..];
    let authority_len = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let after = &rest[authority_len..];
    let path = if after.starts_with('/') {
        let end = after.find(['?', '#']).unwrap_or(after.len());
        after[..end].to_string()
    } else {
        String::from("/")
    };
    Some(RequestUrl {
        scheme: url[..scheme_end].to_ascii_lowercase(),
        authority: rest[..authority_len].to_ascii_lowercase(),
        path,
    })
}

/// Which of the webview's own origins a request URL belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestOrigin {
    /// Neither origin: another scheme, host, port or userinfo.
    Other,
    /// The page's own origin: the asset table first, then the request handler.
    Main,
    /// The frames origin: the request handler only.
    Frames,
}

/// Windows: `http://webview.localhost` and `http://frames.webview.localhost`.
/// macOS: `webview://localhost` and `webview-frames://localhost`. Any other
/// scheme, or any other authority (another host, a port, userinfo), is
/// [`RequestOrigin::Other`].
pub fn classify_request_origin(url: &RequestUrl) -> RequestOrigin {
    match (url.scheme.as_str(), url.authority.as_str()) {
        ("http", "webview.localhost") => RequestOrigin::Main,
        ("http", "frames.webview.localhost") => RequestOrigin::Frames,
        ("webview", "localhost") => RequestOrigin::Main,
        ("webview-frames", "localhost") => RequestOrigin::Frames,
        _ => RequestOrigin::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(url: &str) -> RequestUrl {
        split_request_url(url).unwrap()
    }

    // C++: "http_split_request_url: scheme, authority and raw path"
    #[test]
    fn split_scheme_authority_and_raw_path() {
        let p = parts("webview://LocalHost/a/b.js?x=1#y");
        assert_eq!((p.scheme.as_str(), p.authority.as_str(), p.path.as_str()), ("webview", "localhost", "/a/b.js"));
        let p = parts("HTTP://Webview.Localhost/dir/");
        assert_eq!((p.scheme.as_str(), p.authority.as_str(), p.path.as_str()), ("http", "webview.localhost", "/dir/"));
        assert_eq!(parts("webview://localhost/a%20b.txt").path, "/a%20b.txt");
        for url in ["webview://localhost", "webview://localhost?q=/x", "webview://localhost#/x"] {
            let p = parts(url);
            assert_eq!(p.authority, "localhost", "{url}");
            assert_eq!(p.path, "/", "{url}");
        }
        assert_eq!(parts("webview://localhost:8080/i.html").authority, "localhost:8080");
        assert_eq!(parts("webview://u@localhost/i.html").authority, "u@localhost");
        assert!(split_request_url("localhost/index.html").is_none());
        assert!(split_request_url("://localhost/index.html").is_none());
        assert!(split_request_url("").is_none());
    }

    // C++: "http_classify_request_origin: localhost authority only"
    #[test]
    fn classify_localhost_authority_only() {
        let classify = |url: &str| classify_request_origin(&parts(url));
        assert_eq!(classify("webview://localhost/index.html"), RequestOrigin::Main);
        assert_eq!(classify("WEBVIEW://LOCALHOST/index.html"), RequestOrigin::Main);
        assert_eq!(classify("webview-frames://localhost/f.html"), RequestOrigin::Frames);
        assert_eq!(classify("webview://other-host/index.html"), RequestOrigin::Other);
        assert_eq!(classify("webview-frames://other-host/f.html"), RequestOrigin::Other);
        assert_eq!(classify("webview://localhost:8080/index.html"), RequestOrigin::Other);
        assert_eq!(classify("webview://u@localhost/index.html"), RequestOrigin::Other);
        assert_eq!(classify("webview:///index.html"), RequestOrigin::Other);

        assert_eq!(classify("http://webview.localhost/index.html"), RequestOrigin::Main);
        assert_eq!(classify("http://frames.webview.localhost/f.html"), RequestOrigin::Frames);
        assert_eq!(classify("http://localhost/index.html"), RequestOrigin::Other);
        assert_eq!(classify("https://webview.localhost/index.html"), RequestOrigin::Other);
        assert_eq!(classify("http://webview.localhost:81/index.html"), RequestOrigin::Other);

        assert_eq!(classify("webview://webview.localhost/index.html"), RequestOrigin::Other);
        assert_eq!(classify("http://localhost/f.html"), RequestOrigin::Other);
    }

    #[test]
    fn origin_constants_classify_as_themselves() {
        assert_eq!(classify_request_origin(&parts(WINDOWS_ASSET_ORIGIN)), RequestOrigin::Main);
        assert_eq!(classify_request_origin(&parts(WINDOWS_FRAMES_ORIGIN)), RequestOrigin::Frames);
        assert_eq!(classify_request_origin(&parts(MACOS_ASSET_ORIGIN)), RequestOrigin::Main);
        assert_eq!(classify_request_origin(&parts(MACOS_FRAMES_ORIGIN)), RequestOrigin::Frames);
    }
}
