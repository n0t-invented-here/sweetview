//! Reads back from WebView2 what a person would see, for the tests of this
//! crate and of the crates that build webviews with it (the runtime enables
//! the `test-support` feature as a dev-dependency only, so none of this is in
//! the binding an application loads). Each reader asks WebView2's own objects,
//! not this crate's code, so a test asserts what WebView2 has.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
use windows::Win32::UI::WindowsAndMessaging::{IsChild, IsWindow};
use wry::WebViewExtWindows;

use super::handlers::{DownloadStarting, Registration};

/// Every boolean setting of `ICoreWebView2Settings` to `ICoreWebView2Settings9`,
/// as WebView2 reports it. `None` where the runtime lacks the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageSettings {
    pub script: bool,
    pub web_messages: bool,
    pub script_dialogs: bool,
    pub status_bar: bool,
    pub devtools: bool,
    pub context_menus: bool,
    pub host_objects: bool,
    pub zoom_control: bool,
    pub built_in_error_page: bool,
    pub browser_accelerator_keys: Option<bool>,
    pub password_autosave: Option<bool>,
    pub general_autofill: Option<bool>,
    pub pinch_zoom: Option<bool>,
    pub swipe_navigation: Option<bool>,
    pub reputation_checking: Option<bool>,
    pub non_client_region: Option<bool>,
}

impl PageSettings {
    /// What an application on the C++ fork had: WebView2's documented defaults
    /// (the `ICoreWebView2Settings` to `ICoreWebView2Settings9` reference
    /// pages) with the two the fork set in `win32_edge.hh`, the developer tools
    /// from `debug` and the status bar off.
    pub fn cpp_fork(devtools: bool) -> Self {
        Self {
            script: true,
            web_messages: true,
            script_dialogs: true,
            status_bar: false,
            devtools,
            context_menus: true,
            host_objects: true,
            zoom_control: true,
            built_in_error_page: true,
            browser_accelerator_keys: Some(true),
            password_autosave: Some(false),
            general_autofill: Some(true),
            pinch_zoom: Some(true),
            swipe_navigation: Some(true),
            reputation_checking: Some(true),
            non_client_region: Some(false),
        }
    }
}

/// One getter: `get` is handed a BOOL to fill and returns the call's result.
fn flag(get: impl FnOnce(&mut BOOL) -> windows::core::Result<()>) -> bool {
    let mut value = BOOL::default();
    get(&mut value).expect("a settings getter failed");
    value.as_bool()
}

fn settings_of(webview: &wry::WebView) -> ICoreWebView2Settings {
    let core = webview.webview();
    // SAFETY: `core` is a COM reference this frame owns to the live ICoreWebView2 of
    // `webview`; `Settings` takes no arguments and returns an owned reference.
    unsafe { core.Settings() }.expect("Settings")
}

/// The page settings of `webview`, read from WebView2.
pub fn page_settings(webview: &wry::WebView) -> PageSettings {
    let s = settings_of(webview);
    // Each getter: `s`, or the interface `cast` from it, is a COM reference this frame owns
    // to the live settings object, and `v` is the BOOL `flag` owns for the call to fill.
    PageSettings {
        // SAFETY: a getter on `s`, filling `v` (see above).
        script: flag(|v| unsafe { s.IsScriptEnabled(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        web_messages: flag(|v| unsafe { s.IsWebMessageEnabled(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        script_dialogs: flag(|v| unsafe { s.AreDefaultScriptDialogsEnabled(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        status_bar: flag(|v| unsafe { s.IsStatusBarEnabled(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        devtools: flag(|v| unsafe { s.AreDevToolsEnabled(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        context_menus: flag(|v| unsafe { s.AreDefaultContextMenusEnabled(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        host_objects: flag(|v| unsafe { s.AreHostObjectsAllowed(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        zoom_control: flag(|v| unsafe { s.IsZoomControlEnabled(v) }),
        // SAFETY: a getter on `s`, filling `v` (see above).
        built_in_error_page: flag(|v| unsafe { s.IsBuiltInErrorPageEnabled(v) }),
        // SAFETY: a getter on a cast of `s`, filling `v` (see above).
        browser_accelerator_keys: s.cast::<ICoreWebView2Settings3>().ok().map(|s3| flag(|v| unsafe { s3.AreBrowserAcceleratorKeysEnabled(v) })),
        // SAFETY: a getter on a cast of `s`, filling `v` (see above).
        password_autosave: s.cast::<ICoreWebView2Settings4>().ok().map(|s4| flag(|v| unsafe { s4.IsPasswordAutosaveEnabled(v) })),
        // SAFETY: a getter on a cast of `s`, filling `v` (see above).
        general_autofill: s.cast::<ICoreWebView2Settings4>().ok().map(|s4| flag(|v| unsafe { s4.IsGeneralAutofillEnabled(v) })),
        // SAFETY: a getter on a cast of `s`, filling `v` (see above).
        pinch_zoom: s.cast::<ICoreWebView2Settings5>().ok().map(|s5| flag(|v| unsafe { s5.IsPinchZoomEnabled(v) })),
        // SAFETY: a getter on a cast of `s`, filling `v` (see above).
        swipe_navigation: s.cast::<ICoreWebView2Settings6>().ok().map(|s6| flag(|v| unsafe { s6.IsSwipeNavigationEnabled(v) })),
        // SAFETY: a getter on a cast of `s`, filling `v` (see above).
        reputation_checking: s.cast::<ICoreWebView2Settings8>().ok().map(|s8| flag(|v| unsafe { s8.IsReputationCheckingRequired(v) })),
        // SAFETY: a getter on a cast of `s`, filling `v` (see above).
        non_client_region: s.cast::<ICoreWebView2Settings9>().ok().map(|s9| flag(|v| unsafe { s9.IsNonClientRegionSupportEnabled(v) })),
    }
}

/// Sets general autofill on `webview`'s settings, as an application reaching
/// WebView2 itself (or another program on the same profile) could.
pub fn set_general_autofill(webview: &wry::WebView, enabled: bool) {
    let s4 = settings_of(webview).cast::<ICoreWebView2Settings4>().expect("ICoreWebView2Settings4");
    // SAFETY: `s4` is a COM reference this frame owns to the live settings object; the flag
    // is passed by value.
    unsafe { s4.SetIsGeneralAutofillEnabled(enabled) }.expect("SetIsGeneralAutofillEnabled");
}

/// The window WebView2 is parented to: `wry`'s container window.
fn container(webview: &wry::WebView) -> HWND {
    let controller = webview.controller();
    let mut parent = HWND::default();
    // SAFETY: `controller` is a COM reference this frame owns to the live controller, and
    // `parent` a local HWND for the call to fill.
    unsafe { controller.ParentWindow(&mut parent) }.expect("ParentWindow");
    parent
}

/// Whether `wry`'s container window of `webview` still exists.
pub fn container_alive(webview: &wry::WebView) -> bool {
    let window = container(webview);
    // SAFETY: `IsWindow` takes any handle value, a stale one included, and reads no memory of ours.
    unsafe { IsWindow(Some(window)) }.as_bool()
}

/// Whether this thread's keyboard focus is in `webview` (its container or a
/// window inside it).
pub fn focus_is_inside(webview: &wry::WebView) -> bool {
    let window = container(webview);
    // SAFETY: `GetFocus` takes no arguments and reads the calling thread's input state.
    let focus = unsafe { GetFocus() };
    // SAFETY: `IsChild` takes two handle values, stale or null ones included, and reads no memory of ours.
    focus == window || unsafe { IsChild(window, focus) }.as_bool()
}

/// What a `DownloadStarting` handler registered after every other one sees
/// of each download of a webview: whether it is marked handled (WebView2 then
/// shows no download interface). It saves each download into `folder`, so a
/// test writes nothing in the user's own downloads folder.
pub struct DownloadWatch {
    seen: Rc<RefCell<Vec<bool>>>,
    _registration: Registration,
}

impl DownloadWatch {
    pub fn attach(webview: &wry::WebView, folder: PathBuf) -> Self {
        let seen: Rc<RefCell<Vec<bool>>> = Rc::default();
        let record = seen.clone();
        let handler = DownloadStarting::create(move |args| {
            let mut handled = BOOL::default();
            // SAFETY: `args` is the live event args WebView2 passed to this handler, and
            // `handled` a local BOOL for the call to fill.
            let _ = unsafe { args.Handled(&mut handled) };
            record.borrow_mut().push(handled.as_bool());
            let mut suggested = PWSTR::null();
            // SAFETY: `args` as above; `suggested` is a local PWSTR for the call to fill,
            // freed by `take_pwstr`.
            let _ = unsafe { args.ResultFilePath(&mut suggested) };
            // `suggested` was filled by `ResultFilePath` just above (or left null).
            let suggested = PathBuf::from(webview2_com::take_pwstr(suggested));
            let name = suggested.file_name().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("download"));
            let path = HSTRING::from(folder.join(name).as_path());
            // SAFETY: `args` as above; `path` is an owned HSTRING for the call.
            let _ = unsafe { args.SetResultFilePath(&path) };
        });
        let webview4 = webview.webview().cast::<ICoreWebView2_4>().expect("ICoreWebView2_4");
        let registration = Registration::add_download_starting(&webview4, &handler).expect("add_DownloadStarting");
        Self { seen, _registration: registration }
    }

    /// For each download so far, whether it was marked handled.
    pub fn handled(&self) -> Vec<bool> {
        self.seen.borrow().clone()
    }
}

/// Whether WebView2's own download dialog is open on `webview`; `None` without
/// `ICoreWebView2_9` (before Runtime 1.0.1072).
pub fn download_dialog_open(webview: &wry::WebView) -> Option<bool> {
    let webview9 = webview.webview().cast::<ICoreWebView2_9>().ok()?;
    let mut open = BOOL::default();
    // SAFETY: `webview9` is a COM reference this frame owns, and `open` a local BOOL to fill.
    unsafe { webview9.IsDefaultDownloadDialogOpen(&mut open) }.ok()?;
    Some(open.as_bool())
}

/// Closes WebView2's own download dialog on `webview`, if it is open.
pub fn close_download_dialog(webview: &wry::WebView) {
    if let Ok(webview9) = webview.webview().cast::<ICoreWebView2_9>() {
        // SAFETY: `webview9` is a COM reference this frame owns; no arguments.
        let _ = unsafe { webview9.CloseDefaultDownloadDialog() };
    }
}
