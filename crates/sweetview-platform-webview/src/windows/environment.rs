//! The WebView2 environment created as the C++ fork's `embed()` creates it,
//! for `wry::WebViewBuilderExtWindows::with_environment`.
//!
//! `wry` creates its own environment with extra browser arguments, an explicit
//! language and the extensions flag; the C++ passes no options at all. Two
//! environments on one user data folder with different options cannot run at
//! once (`HRESULT_FROM_WIN32(ERROR_BUSY)`), so a process sharing a folder with
//! today's product must create it the C++'s way.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use sweetview_http::ErrorCode;
use sweetview_platform_loop::ComApartment;
use webview2_com::CreateCoreWebView2EnvironmentCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
};
use windows::core::{HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_INVALID_STATE, E_POINTER};

use super::pump::{pump_while, PumpEnd};

/// The C++ fork's attempts and the wait between them (`m_max_attempts`, `m_sleep_ms`).
const MAX_ATTEMPTS: u32 = 60;
const RETRY_WAIT: Duration = Duration::from_millis(200);

fn invalid_state() -> HRESULT {
    HRESULT::from_win32(ERROR_INVALID_STATE.0)
}

/// The user data folder the C++ fork uses: the roaming application data folder
/// (`CSIDL_APPDATA`) joined with the executable's file name, extension included
/// (`%APPDATA%\bun.exe` for an application run by `bun.exe`). `None` when
/// either cannot be read.
///
/// `dirs::config_dir` is `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` with
/// default flags and no token, the call the C++ makes.
pub fn default_user_data_folder() -> Option<PathBuf> {
    let folder = dirs::config_dir()?;
    let exe = std::env::current_exe().ok()?;
    Some(Path::new(&folder).join(exe.file_name()?))
}

/// Whether a WebView2 Runtime is installed (the C++ `is_webview2_available`):
/// `wry::webview_version` is `GetAvailableCoreWebView2BrowserVersionString`
/// with a null browser folder, as the C++ calls it.
fn is_webview2_available() -> bool {
    wry::webview_version().is_ok_and(|version| !version.is_empty())
}

/// Creates a WebView2 environment exactly as the C++ fork's `embed()` does:
/// `CreateCoreWebView2EnvironmentWithOptions` with a null browser folder,
/// `user_data_folder` (`None` passes null, which lets WebView2 pick its own
/// default; the C++ always passes [`default_user_data_folder`]) and null
/// options, pumping this thread's messages until it completes. A failed
/// attempt is retried up to 60 times, 200 ms apart, except
/// `ERROR_INVALID_STATE` (a running instance on the same folder with other
/// options), which gives up at once.
///
/// The calling thread is made a COM single-threaded apartment first, for the
/// rest of its life, as `wry` does before it creates each webview (the C++
/// does the same for a window it owns). Errors: [`ErrorCode::MissingDependency`] without a
/// WebView2 Runtime, [`ErrorCode::Canceled`] when a `WM_QUIT` arrives while
/// waiting (it is consumed, as in the C++), [`ErrorCode::InvalidState`] when
/// creation fails for good.
pub fn create_environment(user_data_folder: Option<&Path>) -> Result<ICoreWebView2Environment, ErrorCode> {
    // Entered (or counted again when the thread already is an STA) and kept for
    // the thread's life: never left here, so no COM object outlives it. A thread
    // that is multithreaded is refused, which WebView2 then refuses through the
    // creation below.
    if let Ok(apartment) = ComApartment::enter() {
        std::mem::forget(apartment);
    }
    if !is_webview2_available() {
        return Err(ErrorCode::MissingDependency);
    }
    let folder = user_data_folder.map(HSTRING::from);
    for _ in 0..MAX_ATTEMPTS {
        let slot: Rc<RefCell<Option<windows::core::Result<ICoreWebView2Environment>>>> = Rc::default();
        let handler = {
            let slot = slot.clone();
            CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
                let outcome = result.and_then(|()| environment.ok_or_else(|| E_POINTER.into()));
                *slot.borrow_mut() = Some(outcome);
                Ok(())
            }))
        };
        let options: Option<&ICoreWebView2EnvironmentOptions> = None;
        // The folder, or null for WebView2's own default.
        let folder_ptr = folder.as_ref().map_or(PCWSTR::null(), |folder| PCWSTR(folder.as_ptr()));
        // SAFETY: a null browser folder; `folder_ptr` is null or points into the HSTRING
        // above, which outlives the call; null options; and a live handler WebView2
        // keeps its own reference to until it completes.
        let started = unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), folder_ptr, options, &handler) };
        drop(handler);
        match started {
            Err(e) if e.code() == invalid_state() => return Err(ErrorCode::InvalidState),
            Err(_) => {
                std::thread::sleep(RETRY_WAIT);
                continue;
            }
            Ok(()) => {}
        }
        match pump_while(|| slot.borrow().is_none()) {
            PumpEnd::Done => {}
            PumpEnd::Quit => return Err(ErrorCode::Canceled),
            PumpEnd::Failed => return Err(ErrorCode::InvalidState),
        }
        let outcome = slot.borrow_mut().take();
        if let Some(Ok(environment)) = outcome {
            return Ok(environment);
        }
        // The C++ retries a failed completion at once, through the same attempt
        // counter.
    }
    Err(ErrorCode::InvalidState)
}
