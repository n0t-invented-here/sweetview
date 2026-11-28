//! The WebView2 environment created as the C++ fork's `embed()` creates it,
//! for [`super::Webview::create`].
//!
//! The C++ passes no options at all (`wry`, not used on Windows, would add
//! browser arguments, a language and the extensions flag). Two
//! environments on one user data folder with different options cannot run at
//! once (`HRESULT_FROM_WIN32(ERROR_BUSY)`), so a process sharing a folder with
//! today's product must create it the C++'s way.

use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use sweetview_http::ErrorCode;
use sweetview_platform_loop::ComApartment;
use webview2_com::CreateCoreWebView2EnvironmentCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
};
use windows::core::{HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_INVALID_STATE, E_POINTER, E_UNEXPECTED};

use super::attempts::{Failed, RETRY_WAIT};
use super::pump::{pump_while, PumpEnd};

thread_local! {
    /// This thread's WebView2 environment, made once on the first webview and
    /// shared by every later one, as the C++ library's webviews shared one
    /// browser process. A failure is not kept: the next webview tries again.
    static SHARED: RefCell<Option<ICoreWebView2Environment>> = const { RefCell::new(None) };
    /// This thread's single-threaded apartment, entered by the first
    /// `create_environment` on the thread that succeeds in entering it and left
    /// when the thread ends, after the thread's later-made values (the runtime's
    /// environment and webviews) have been dropped.
    static APARTMENT: RefCell<Option<ComApartment>> = const { RefCell::new(None) };
}

/// Makes this thread a COM single-threaded apartment for the rest of its life,
/// once. A thread that is multithreaded is refused (and asked again on the next
/// call), which WebView2 then refuses through the creation.
fn enter_apartment_once() {
    APARTMENT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = ComApartment::enter().ok();
        }
    });
}

/// The closure `webview2-com`'s completion handler calls: hands the outcome to
/// `on_done` inside `catch_unwind`, and reports a panic to WebView2 as
/// `E_UNEXPECTED` instead of unwinding into it.
type Completed = Box<dyn FnOnce(windows::core::Result<()>, Option<ICoreWebView2Environment>) -> windows::core::Result<()>>;

fn guarded_completion(on_done: impl FnOnce(windows::core::Result<ICoreWebView2Environment>) + 'static) -> Completed {
    Box::new(move |result, environment| {
        catch_unwind(AssertUnwindSafe(move || {
            on_done(result.and_then(|()| environment.ok_or_else(|| E_POINTER.into())));
        }))
        .map_err(|_| E_UNEXPECTED.into())
    })
}

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
/// `GetAvailableCoreWebView2BrowserVersionString` with a null browser folder,
/// as the C++ calls it, and a version string that is not empty.
fn is_webview2_available() -> bool {
    let mut version = windows::core::PWSTR::null();
    // SAFETY: a null browser folder asks for the installed runtime; `version` is a local PWSTR
    // for the call to fill, freed by `take_pwstr` below.
    let found = unsafe { webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) };
    // `version` was filled by the call just above (or left null, which reads as empty).
    let version = webview2_com::take_pwstr(version);
    found.is_ok() && !version.is_empty()
}

/// Ready to make an environment on this thread: its COM apartment entered,
/// and a WebView2 Runtime installed ([`ErrorCode::MissingDependency`] when
/// none is).
pub(super) fn prepare() -> Result<(), ErrorCode> {
    // Entered once per thread (or counted once more when the thread already is
    // an STA) and kept until the thread's storage is torn down. On the UI thread
    // the runtime's own apartment, entered before any window and left last, is
    // what outlives every COM object of the thread; this one keeps a thread
    // without a runtime from entering on every call.
    enter_apartment_once();
    if is_webview2_available() { Ok(()) } else { Err(ErrorCode::MissingDependency) }
}

/// The environment of attempt `number` at making a webview: on the first,
/// this thread's shared one when there is one (D15); otherwise a new one on
/// [`default_user_data_folder`] (`WEBVIEW2_USER_DATA_FOLDER` overrides the
/// folder), which becomes the thread's shared environment, as the fork makes a
/// new environment for each attempt.
pub(super) fn for_attempt(number: u32) -> Result<ICoreWebView2Environment, Failed> {
    if number == 0 {
        if let Some(environment) = SHARED.with(|cell| cell.borrow().clone()) {
            return Ok(environment);
        }
    }
    let folder = default_user_data_folder().map(|folder| HSTRING::from(folder.as_path()));
    let environment = create_once(folder.as_ref())?;
    SHARED.with(|cell| *cell.borrow_mut() = Some(environment.clone()));
    Ok(environment)
}

/// One `CreateCoreWebView2EnvironmentWithOptions`, as the fork's attempt
/// handler makes it, pumping this thread's messages until it completes.
fn create_once(folder: Option<&HSTRING>) -> Result<ICoreWebView2Environment, Failed> {
    let slot: Rc<RefCell<Option<windows::core::Result<ICoreWebView2Environment>>>> = Rc::default();
    let handler = {
        let slot = slot.clone();
        CreateCoreWebView2EnvironmentCompletedHandler::create(guarded_completion(move |outcome| {
            *slot.borrow_mut() = Some(outcome);
        }))
    };
    let options: Option<&ICoreWebView2EnvironmentOptions> = None;
    // The folder, or null for WebView2's own default.
    let folder_ptr = folder.map_or(PCWSTR::null(), |folder| PCWSTR(folder.as_ptr()));
    // SAFETY: a null browser folder; `folder_ptr` is null or points into the HSTRING the
    // caller holds for the whole call; null options; and a live handler WebView2 keeps its
    // own reference to until it completes.
    let started = unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), folder_ptr, options, &handler) };
    drop(handler);
    started.map_err(|error| Failed::AtOnce(error.code()))?;
    match pump_while(|| slot.borrow().is_none()) {
        PumpEnd::Done => {}
        PumpEnd::Quit => return Err(Failed::Quit),
        PumpEnd::Failed => return Err(Failed::Completed(invalid_state())),
    }
    let outcome = slot.borrow_mut().take();
    match outcome {
        Some(Ok(environment)) => Ok(environment),
        Some(Err(error)) => Err(Failed::Completed(error.code())),
        None => Err(Failed::Completed(invalid_state())),
    }
}

/// Lets go of this thread's shared environment once its webviews are gone,
/// so it is released while the thread (and its COM apartment) still runs: a
/// test's thread ends right after its body, and WebView2 faults with
/// `0xc000041d` when an environment is released by the thread's own teardown.
pub fn release_shared() {
    drop(SHARED.with(|cell| cell.borrow_mut().take()));
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
/// The calling thread is made a COM single-threaded apartment first, once, for
/// the rest of its life, before it creates any webview (the C++
/// does the same for a window it owns). Errors: [`ErrorCode::MissingDependency`] without a
/// WebView2 Runtime, [`ErrorCode::Canceled`] when a `WM_QUIT` arrives while
/// waiting (it is consumed, as in the C++), [`ErrorCode::InvalidState`] when
/// creation fails for good.
pub fn create_environment(user_data_folder: Option<&Path>) -> Result<ICoreWebView2Environment, ErrorCode> {
    prepare()?;
    let folder = user_data_folder.map(HSTRING::from);
    super::attempts::attempt(|_| create_once(folder.as_ref()), |_| Ok(()), || std::thread::sleep(RETRY_WAIT)).map(|(environment, ())| environment)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::E_FAIL;

    #[test]
    fn a_completion_that_panics_reports_failure_and_does_not_unwind() {
        let panicking = guarded_completion(|_| panic!("provoked by the test"));
        assert_eq!(panicking(Err(E_FAIL.into()), None).map_err(|e| e.code()), Err(E_UNEXPECTED));

        let seen = Rc::new(RefCell::new(None));
        let record = seen.clone();
        let calm = guarded_completion(move |outcome| *record.borrow_mut() = Some(outcome.map_err(|e| e.code())));
        assert!(calm(Ok(()), None).is_ok());
        // Success without an environment is WebView2 breaking its contract: E_POINTER.
        assert_eq!(seen.borrow_mut().take().map(|outcome| outcome.err()), Some(Some(E_POINTER)));
    }

    #[test]
    fn the_apartment_is_entered_once_per_thread() {
        std::thread::spawn(|| {
            for _ in 0..3 {
                enter_apartment_once();
            }
            assert!(APARTMENT.with(|slot| slot.borrow().is_some()));
        })
        .join()
        .unwrap();
    }
}
