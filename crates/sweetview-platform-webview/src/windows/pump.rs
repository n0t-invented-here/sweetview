//! The nested message pumps the C++ fork runs while it waits for WebView2:
//! `run_event_loop_while` (around `AddScriptToExecuteOnDocumentCreated`) and
//! the wait loop of `embed` (around environment creation). Both dispatch with
//! the wide-character calls, as the C++ does.

use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, PostQuitMessage, TranslateMessage, MSG, WM_QUIT};

/// How a pump ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PumpEnd {
    /// The condition was met.
    Done,
    /// A `WM_QUIT` arrived first.
    Quit,
    /// `GetMessageW` failed.
    Failed,
}

/// What happens to a `WM_QUIT` the pump takes from the queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OnQuit {
    /// Posted again, so the outer loop still receives it (`run_event_loop_while`).
    Repost,
    /// Kept: the wait ends cancelled (`embed`).
    Consume,
}

/// Dispatches this thread's messages while `more()` is true. Every callback
/// the thread serves can run inside it, WebView2's and the loop's alike.
pub(super) fn pump_while(mut more: impl FnMut() -> bool, on_quit: OnQuit) -> PumpEnd {
    let mut msg = MSG::default();
    while more() {
        // SAFETY: `msg` is a local MSG for the call to fill; no window filter.
        let got = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if got.0 == -1 {
            return PumpEnd::Failed;
        }
        if got.0 == 0 || msg.message == WM_QUIT {
            if on_quit == OnQuit::Repost {
                // SAFETY: posts WM_QUIT with the exit code it carried; no pointer.
                unsafe { PostQuitMessage(msg.wParam.0 as i32) };
            }
            return PumpEnd::Quit;
        }
        // SAFETY: `msg` was filled by the GetMessageW call just above.
        let _ = unsafe { TranslateMessage(&msg) };
        // SAFETY: `msg` was filled by the GetMessageW call just above.
        unsafe { DispatchMessageW(&msg) };
    }
    PumpEnd::Done
}
