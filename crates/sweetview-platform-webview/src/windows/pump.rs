//! The nested message pump the C++ fork's `embed` runs while it waits for
//! WebView2 to create the environment. It dispatches with the wide-character
//! calls, as the C++ does.
//!
//! Adding a user script does not wait here (as the C++ fork's
//! `add_user_script_impl` did): WebView2 reports that completion only once a
//! navigation in flight has its response, and the response may have to come
//! from this thread's own JavaScript, which cannot run inside this pump. The
//! one script a new webview adds for itself, before any navigation, is waited
//! for, as the fork's `embed` waits.

use sweetview_platform_loop::{wait_message, Waited};

/// How a pump ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PumpEnd {
    /// The condition was met.
    Done,
    /// A `WM_QUIT` arrived first; `GetMessageW` took it off the queue (it is
    /// consumed, as in the C++), and the wait ends cancelled.
    Quit,
    /// `GetMessageW` failed.
    Failed,
}

/// Dispatches this thread's messages while `more()` is true. Every callback
/// the thread serves can run inside it, WebView2's and the loop's alike.
pub(super) fn pump_while(mut more: impl FnMut() -> bool) -> PumpEnd {
    while more() {
        match wait_message() {
            Waited::Failed => return PumpEnd::Failed,
            Waited::Quit => return PumpEnd::Quit,
            Waited::Message(message) => {
                message.translate();
                message.dispatch();
            }
        }
    }
    PumpEnd::Done
}
