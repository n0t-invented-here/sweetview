//! What the webview needs on top of `wry` that `wry` has no API for.
//!
//! The caller creates the `wry::WebView` (with `wry`'s own IPC handler and no
//! `wry` custom protocols) and hands it to [`WebviewExtras::attach`], which adds
//! the rest through the native objects `wry` hands out:
//!
//! * one `WebResourceRequested` handler serving assets first, then the request
//!   handler, on `http://webview.localhost` and `http://frames.webview.localhost`,
//!   with deferred requests answered later from any thread through
//!   [`Responder`], streamed bodies included;
//! * file drop paths, external drop control and the default background colour;
//! * accelerator keys, navigation failures, focus and popup position for tabs.
//!
//! Dropping the [`WebviewExtras`] tears all of it down in the order of the C++
//! fork's `deinit()`: answering calls are refused from then on, open streams are
//! aborted, the WebView2 controller is closed, and open requests are released
//! unanswered. It must be dropped as part of dropping the webview, right before
//! the `wry::WebView`.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]
// The stand-in for other platforms uses only the public types.
#![cfg_attr(not(windows), allow(dead_code))]

use std::rc::Rc;
use std::sync::Arc;

mod shared;
mod stream;

#[cfg(windows)]
#[path = "windows/mod.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "unported.rs"]
mod platform;

#[cfg(windows)]
pub use platform::{create_environment, default_user_data_folder};
pub use platform::{set_background_color, UserScript, WebviewExtras};
pub use shared::Responder;
pub use sweetview_http::ErrorCode;

/// The web message the file drop script posts, with the dropped files attached.
///
/// `wry`'s IPC handler receives it too, as a body of exactly this text: the
/// IPC handler the caller gives `wry` ignores it ([`is_file_drop_message`]).
/// It is a string because WebView2 raises no `WebMessageReceived` at all for
/// `postMessageWithAdditionalObjects` with any other message (an object posts
/// without an error in the page and never arrives).
pub const FILE_DROP_MESSAGE: &str = "__sweetview_file_drop__";

/// True for the drop script's message, which `wry`'s IPC handler must ignore.
pub fn is_file_drop_message(body: &str) -> bool {
    body == FILE_DROP_MESSAGE
}

/// A request handed to the request handler.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawRequest {
    /// Never 0; increases with each request across the process.
    pub id: u64,
    /// `GET` when WebView2 reports none.
    pub method: String,
    /// The full request URL, as WebView2 reports it.
    pub url: String,
    /// The request headers as a JSON array of `[name, value]` string pairs.
    pub headers_json: String,
    /// The request body; `None` when it is empty.
    pub body: Option<Vec<u8>>,
}

/// An accelerator key pressed while the page has focus: a key-down or
/// system-key-down, with the modifier state at the time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyData {
    /// The Windows virtual-key code.
    pub virtual_key: u32,
    /// Ctrl is down.
    pub control: bool,
    /// Shift is down.
    pub shift: bool,
    /// Alt is down.
    pub alt: bool,
}

/// A top-level navigation that failed without a response, under the rules of
/// the tabs library: navigations cancelled by a newer one, aborted ones (a
/// download included), HTTP error responses, `about:` and `data:` loads, and
/// navigations a newer one already superseded are never reported.
#[derive(Clone)]
pub struct NavigationFailure {
    /// The address the failed navigation was loading (its last redirect target).
    pub url: String,
    /// A sentence for the user, from the WebView2 error status.
    pub reason: String,
    is_current: Rc<dyn Fn() -> bool>,
}

impl NavigationFailure {
    pub(crate) fn new(url: String, reason: String, is_current: Rc<dyn Fn() -> bool>) -> Self {
        Self { url, reason, is_current }
    }

    /// False once a newer navigation has started, or the host has asked for one
    /// with [`WebviewExtras::note_host_navigation`]; a page shown for this
    /// failure must not replace that navigation.
    pub fn is_current(&self) -> bool {
        (self.is_current)()
    }
}

impl std::fmt::Debug for NavigationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NavigationFailure").field("url", &self.url).field("reason", &self.reason).finish()
    }
}

/// How [`WebviewExtras::attach`] reaches its owner.
#[derive(Clone)]
pub struct ExtrasOptions {
    /// Called from any thread when work is queued for the UI thread; the owner
    /// then calls [`WebviewExtras::drain`] on the UI thread.
    pub wake_ui: Arc<dyn Fn() + Send + Sync>,
}

/// The reason sentence for a `COREWEBVIEW2_WEB_ERROR_STATUS`, as the tabs
/// library words it; `None` for the statuses that are never reported
/// (`OperationCanceled` 14, `ConnectionAborted` 9).
pub(crate) fn web_error_reason(status: i32) -> Option<&'static str> {
    Some(match status {
        9 | 14 => return None,
        1 => "The site's security certificate names a different host.",
        2 => "The site's security certificate has expired.",
        3 => "The client certificate contains errors.",
        4 => "The site's security certificate has been revoked.",
        5 => "The site's security certificate is not valid.",
        6 => "The server is unreachable.",
        7 => "The connection timed out.",
        8 => "The server sent an invalid response.",
        10 => "The connection was reset.",
        11 => "The network connection was lost.",
        12 => "Could not connect to the server.",
        13 => "The server's host name could not be found.",
        15 => "A redirect failed.",
        16 => "An unexpected error occurred.",
        17 => "The site requires authentication.",
        18 => "The proxy requires authentication.",
        _ => "The page could not be loaded.",
    })
}

/// Whether a failed navigation is reported, from what WebView2 says about it:
/// only a failure with no HTTP response, a status other than cancelled or
/// aborted, and an address that is not `about:` or `data:`.
pub(crate) fn failure_reason(error_status: i32, http_status: Option<i32>, url: &str) -> Option<&'static str> {
    let reason = web_error_reason(error_status)?;
    if http_status.unwrap_or(0) > 0 {
        return None;
    }
    let starts = |prefix: &str| url.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix));
    // WebView2 reports an `about:<name>` address it refuses as `edge://<name>/` (the browser's own
    // scheme for those pages; `chrome:` is the same family).
    if starts("about:") || starts("data:") || starts("edge:") || starts("chrome:") {
        return None;
    }
    Some(reason)
}

/// The script that captures file drops on the top-level document, ported from
/// the C++ fork's `create_file_drop_script`. It starts disabled in every
/// document; [`file_drop_flag_script`] switches it. The message it posts is
/// [`FILE_DROP_MESSAGE`].
pub(crate) const FILE_DROP_SCRIPT: &str = r#"(function() {
  'use strict';
  if (window !== window.top) {
    return;
  }
  if (typeof window.__webview_file_drop_enabled__ !== 'boolean') {
    window.__webview_file_drop_enabled__ = false;
  }
  function canDeliver() {
    return !!(window.chrome && window.chrome.webview &&
      typeof window.chrome.webview.postMessageWithAdditionalObjects ===
        'function');
  }
  function carriesFiles(e) {
    return !!(window.__webview_file_drop_enabled__ && canDeliver() &&
      e.dataTransfer && e.dataTransfer.types &&
      Array.from(e.dataTransfer.types).includes('Files'));
  }
  window.addEventListener('dragover', function(e) {
    if (carriesFiles(e)) {
      e.preventDefault();
    }
  }, true);
  window.addEventListener('drop', function(e) {
    if (!carriesFiles(e)) {
      return;
    }
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      window.chrome.webview.postMessageWithAdditionalObjects(
        '__sweetview_file_drop__', Array.from(e.dataTransfer.files));
    }
  }, true);
})()"#;

/// Sets the drop script's flag in the current top-level document.
pub(crate) fn file_drop_flag_script(enabled: bool) -> String {
    format!("if (window === window.top) {{ window.__webview_file_drop_enabled__ = {enabled}; }}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // win-webview2.ts onNavigationFailed: which failures count.
    #[test]
    fn navigation_failure_rules() {
        assert_eq!(failure_reason(13, Some(0), "http://nope.invalid/"), Some("The server's host name could not be found."));
        assert_eq!(failure_reason(12, None, "http://x/"), Some("Could not connect to the server."));
        assert_eq!(failure_reason(99, None, "http://x/"), Some("The page could not be loaded."));
        assert_eq!(failure_reason(14, None, "http://x/"), None, "cancelled by a newer navigation");
        assert_eq!(failure_reason(9, None, "http://x/"), None, "aborted, or became a download");
        assert_eq!(failure_reason(13, Some(404), "http://x/"), None, "the server's own error page is shown");
        assert_eq!(failure_reason(13, None, "about:blank"), None);
        assert_eq!(failure_reason(13, None, "ABOUT:blank"), None);
        assert_eq!(failure_reason(13, None, "data:text/html,x"), None);
        assert_eq!(failure_reason(13, None, "edge://sweetview-nowhere/"), None, "how WebView2 reports a refused about: address");
        assert_eq!(failure_reason(13, None, "Data:text/html,x"), None);
    }

    #[test]
    fn flag_script_targets_the_top_frame() {
        assert_eq!(
            file_drop_flag_script(true),
            "if (window === window.top) { window.__webview_file_drop_enabled__ = true; }"
        );
        assert!(file_drop_flag_script(false).ends_with("= false; }"));
        assert!(FILE_DROP_SCRIPT.contains("if (window !== window.top)"));
        assert!(FILE_DROP_SCRIPT.contains(&format!("'{FILE_DROP_MESSAGE}'")));
    }

    #[test]
    fn drop_message_filter() {
        assert!(is_file_drop_message("__sweetview_file_drop__"));
        assert!(!is_file_drop_message("\"__sweetview_file_drop__\""));
        assert!(!is_file_drop_message("{\"id\":1}"));
    }
}
