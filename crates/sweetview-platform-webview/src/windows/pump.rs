//! The nested message pump the C++ fork's `embed` runs while it waits for
//! WebView2 to create the environment. It dispatches with the wide-character
//! calls, as the C++ does.
//!
//! Adding a user script does not wait here (as the C++ fork's
//! `add_user_script_impl` did): WebView2 reports that completion only once a
//! navigation in flight has its response, and the response may have to come
//! from this thread's own JavaScript, which cannot run inside this pump.

use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, TranslateMessage, MSG, WM_QUIT};

/// How a pump ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PumpEnd {
    /// The condition was met.
    Done,
    /// A `WM_QUIT` arrived first; it is kept, and the wait ends cancelled.
    Quit,
    /// `GetMessageW` failed.
    Failed,
}

/// Dispatches this thread's messages while `more()` is true. Every callback
/// the thread serves can run inside it, WebView2's and the loop's alike.
pub(super) fn pump_while(mut more: impl FnMut() -> bool) -> PumpEnd {
    let mut msg = MSG::default();
    while more() {
        // SAFETY: `msg` is a local MSG for the call to fill; no window filter.
        let got = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if got.0 == -1 {
            return PumpEnd::Failed;
        }
        if got.0 == 0 || msg.message == WM_QUIT {
            return PumpEnd::Quit;
        }
        // SAFETY: `msg` was filled by the GetMessageW call just above.
        let _ = unsafe { TranslateMessage(&msg) };
        // SAFETY: `msg` was filled by the GetMessageW call just above.
        unsafe { DispatchMessageW(&msg) };
    }
    PumpEnd::Done
}
