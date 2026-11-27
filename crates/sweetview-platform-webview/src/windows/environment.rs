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
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, GetAvailableCoreWebView2BrowserVersionString, ICoreWebView2Environment,
    ICoreWebView2EnvironmentOptions,
};
use webview2_com::{take_pwstr, CreateCoreWebView2EnvironmentCompletedHandler};
use windows::core::{HRESULT, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_INVALID_STATE, E_POINTER};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

use super::pump::{pump_while, OnQuit, PumpEnd};

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
pub fn default_user_data_folder() -> Option<PathBuf> {
    // SAFETY: a known-folder id from the `windows` crate, default flags and no
    // token; the returned string is freed by `take_pwstr`.
    let folder = unsafe { SHGetKnownFolderPath(&FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, None) }.ok()?;
    let folder = take_pwstr(folder);
    let exe = std::env::current_exe().ok()?;
    Some(Path::new(&folder).join(exe.file_name()?))
}

/// Whether a WebView2 Runtime is installed (the C++ `is_webview2_available`).
fn is_webview2_available() -> bool {
    let mut version = PWSTR::null();
    // SAFETY: a null browser folder asks for the installed runtime; `version` is a
    // local PWSTR for the call to fill, freed by `take_pwstr`.
    let found = unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }.is_ok();
    let version = take_pwstr(version);
    found && !version.is_empty()
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
    // S_FALSE when the thread already is an STA; RPC_E_CHANGED_MODE when it is
    // multithreaded, which WebView2 then refuses through the creation below.
    // SAFETY: no reserved pointer is passed; the apartment stays for the thread's
    // life, never uninitialised here, so no COM object outlives it.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
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
        let started = match &folder {
            // SAFETY: a null browser folder, the folder as an owned HSTRING for the
            // call, null options, and a live handler WebView2 keeps until it completes.
            Some(folder) => unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), folder, options, &handler) },
            // SAFETY: as above, with a null user data folder.
            None => unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), PCWSTR::null(), options, &handler) },
        };
        drop(handler);
        match started {
            Err(e) if e.code() == invalid_state() => return Err(ErrorCode::InvalidState),
            Err(_) => {
                std::thread::sleep(RETRY_WAIT);
                continue;
            }
            Ok(()) => {}
        }
        match pump_while(|| slot.borrow().is_none(), OnQuit::Consume) {
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
