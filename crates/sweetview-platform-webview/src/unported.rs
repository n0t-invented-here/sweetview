//! The stand-in for platforms this crate does not serve yet (macOS until its
//! goal, Linux). The public types are the same; `attach` reports
//! [`ErrorCode::Unspecified`], so no other method can be reached.
//!
//! `create_environment` and `default_user_data_folder` exist on Windows only:
//! they hand out a WebView2 type. The macOS goal has no counterpart to add,
//! because WKWebView has no environment object.

use std::marker::PhantomData;
use std::rc::Rc;

use crate::{ErrorCode, ExtrasOptions, KeyData, NavigationFailure, RawRequest, Responder};

/// A script added with [`WebviewExtras::add_user_script`].
#[derive(Debug)]
pub struct UserScript {
    _not_send: PhantomData<Rc<()>>,
}

/// Everything added to one webview. Not `Send`, not `Sync`.
pub struct WebviewExtras {
    _not_send: PhantomData<Rc<()>>,
}

#[allow(clippy::unused_self, unused_variables)]
impl WebviewExtras {
    /// Not served on this platform yet.
    pub fn attach(webview: &wry::WebView, options: ExtrasOptions) -> Result<Self, ErrorCode> {
        Err(ErrorCode::Unspecified)
    }

    /// Runs queued cross-thread work; UI thread.
    pub fn drain(&self) {}

    /// Adds a script that runs at document creation in later documents.
    pub fn add_user_script(&self, source: &str) -> Result<UserScript, ErrorCode> {
        Err(ErrorCode::Unspecified)
    }

    /// Removes a script added with [`add_user_script`](Self::add_user_script).
    pub fn remove_user_script(&self, script: UserScript) {}

    /// Whether a script registration is still waiting.
    pub fn scripts_pending(&self) -> bool {
        false
    }

    /// Sets or clears the handler for the last script registration completing.
    pub fn set_scripts_registered_handler(&self, handler: Option<Rc<dyn Fn()>>) {}

    /// Cancels the navigation in flight.
    pub fn stop_navigation(&self) {}

    /// Serves `data` at `path` of the page's own origin.
    pub fn set_asset(&self, path: &str, mime: &str, data: Vec<u8>) -> ErrorCode {
        ErrorCode::Unspecified
    }

    /// Sets or clears the request handler.
    pub fn set_request_handler(&self, handler: Option<Rc<dyn Fn(RawRequest)>>) -> ErrorCode {
        ErrorCode::Unspecified
    }

    /// The answering half, for any thread.
    pub fn responder(&self) -> Responder {
        unreachable!("no WebviewExtras exists on this platform")
    }

    /// Sets the colour painted behind the page.
    pub fn set_background_color(&self, r: u8, g: u8, b: u8, a: u8) -> ErrorCode {
        ErrorCode::Unspecified
    }

    /// Allows or refuses drops from outside the app.
    pub fn allows_external_drop(&self) -> Option<bool> {
        None
    }

    pub fn set_allow_external_drop(&self, allow: bool) -> ErrorCode {
        ErrorCode::Unspecified
    }

    /// Sets or clears the file drop handler.
    pub fn set_file_drop_handler(&self, handler: Option<Rc<dyn Fn(Vec<String>)>>) -> ErrorCode {
        ErrorCode::Unspecified
    }

    /// Sets or clears the accelerator key handler.
    pub fn set_accelerator_key_handler(&self, handler: Option<Rc<dyn Fn(KeyData) -> bool>>) -> ErrorCode {
        ErrorCode::Unspecified
    }

    /// Sets or clears the navigation-failed handler.
    pub fn set_navigation_failed_handler(&self, handler: Option<Rc<dyn Fn(NavigationFailure)>>) -> ErrorCode {
        ErrorCode::Unspecified
    }

    /// Records that the host is about to navigate.
    pub fn note_host_navigation(&self) {}

    /// Tells the webview its window moved.
    pub fn notify_parent_window_position_changed(&self) {}

    /// Calls a DevTools protocol method.
    pub fn call_devtools_protocol_method(&self, method: &str, params_json: &str) -> ErrorCode {
        ErrorCode::Unspecified
    }
}
