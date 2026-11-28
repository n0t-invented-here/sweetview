//! Reads back from WebView2 what a person would see, for the tests of this
//! crate and of the crates that build webviews with it (the runtime enables
//! the `test-support` feature as a dev-dependency only, so none of this is in
//! the binding an application loads). Each reader asks WebView2's own objects,
//! not this crate's code, so a test asserts what WebView2 has.

use std::cell::RefCell;
use std::rc::Rc;

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
use windows::Win32::UI::WindowsAndMessaging::{IsChild, IsWindow};

use super::handlers::{DownloadStarting, Registration};
use super::host::Webview;
use sweetview_platform_window::BorrowedWindow;

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

fn settings_of(webview: &Webview) -> ICoreWebView2Settings {
    let core = webview.core().clone();
    // SAFETY: `core` is a COM reference this frame owns to the live ICoreWebView2 of
    // `webview`; `Settings` takes no arguments and returns an owned reference.
    unsafe { core.Settings() }.expect("Settings")
}

/// The page settings of `webview`, read from WebView2.
pub fn page_settings(webview: &Webview) -> PageSettings {
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
pub fn set_general_autofill(webview: &Webview, enabled: bool) {
    let s4 = settings_of(webview).cast::<ICoreWebView2Settings4>().expect("ICoreWebView2Settings4");
    // SAFETY: `s4` is a COM reference this frame owns to the live settings object; the flag
    // is passed by value.
    unsafe { s4.SetIsGeneralAutofillEnabled(enabled) }.expect("SetIsGeneralAutofillEnabled");
}

/// The window WebView2 is parented to (the webview's widget); `None` once
/// the controller is closed and no longer answers.
fn container(webview: &Webview) -> Option<HWND> {
    let controller = webview.controller().clone();
    let mut parent = HWND::default();
    // SAFETY: `controller` is a COM reference this frame owns to the controller, and
    // `parent` a local HWND for the call to fill; a closed controller returns an error.
    unsafe { controller.ParentWindow(&mut parent) }.ok()?;
    Some(parent)
}

/// The handle value of the webview's widget window, while its controller answers.
pub fn container_value(webview: &Webview) -> Option<isize> {
    container(webview).map(|window| window.0 as isize)
}

/// Whether the webview is still in place: its controller answers and its
/// widget window exists.
pub fn container_alive(webview: &Webview) -> bool {
    let Some(window) = container(webview) else { return false };
    // SAFETY: `IsWindow` takes any handle value, a stale one included, and reads no memory of ours.
    unsafe { IsWindow(Some(window)) }.as_bool()
}

/// Whether this thread's keyboard focus is in `webview` (its container or a
/// window inside it).
pub fn focus_is_inside(webview: &Webview) -> bool {
    let Some(window) = container(webview) else { return false };
    // SAFETY: `GetFocus` takes no arguments and reads the calling thread's input state.
    let focus = unsafe { GetFocus() };
    // SAFETY: `IsChild` takes two handle values, stale or null ones included, and reads no memory of ours.
    focus == window || unsafe { IsChild(window, focus) }.as_bool()
}

/// What a `DownloadStarting` handler registered after every other one sees
/// of each download of a webview, and changes nothing of: whether it is marked
/// handled (WebView2 then shows no download interface) and the path WebView2
/// chose for it. A test that downloads points the profile's download folder
/// at a scratch folder first ([`set_download_folder`]), so nothing is written
/// in the user's own.
pub struct DownloadWatch {
    seen: Rc<RefCell<Vec<(bool, String)>>>,
    _registration: Registration,
}

impl DownloadWatch {
    pub fn attach(webview: &Webview) -> Self {
        let seen: Rc<RefCell<Vec<(bool, String)>>> = Rc::default();
        let record = seen.clone();
        let handler = DownloadStarting::create(move |args| {
            let mut handled = BOOL::default();
            // SAFETY: `args` is the live event args WebView2 passed to this handler, and
            // `handled` a local BOOL for the call to fill.
            let _ = unsafe { args.Handled(&mut handled) };
            let mut path = PWSTR::null();
            // SAFETY: `args` as above; `path` is a local PWSTR for the call to fill, freed by `take_pwstr`.
            let _ = unsafe { args.ResultFilePath(&mut path) };
            // `path` was filled by `ResultFilePath` just above (or left null).
            record.borrow_mut().push((handled.as_bool(), webview2_com::take_pwstr(path)));
        });
        let webview4 = webview.core().clone().cast::<ICoreWebView2_4>().expect("ICoreWebView2_4");
        let registration = Registration::add_download_starting(&webview4, &handler).expect("add_DownloadStarting");
        Self { seen, _registration: registration }
    }

    /// For each download so far, whether it was marked handled.
    pub fn handled(&self) -> Vec<bool> {
        self.seen.borrow().iter().map(|(handled, _)| *handled).collect()
    }

    /// For each download so far, the path WebView2 chose for it.
    pub fn paths(&self) -> Vec<String> {
        self.seen.borrow().iter().map(|(_, path)| path.clone()).collect()
    }
}

fn profile_of(webview: &Webview) -> ICoreWebView2Profile {
    let webview13 = webview.core().clone().cast::<ICoreWebView2_13>().expect("ICoreWebView2_13");
    // SAFETY: `webview13` is a COM reference this frame owns; no arguments.
    unsafe { webview13.Profile() }.expect("Profile")
}

/// The profile's download folder (`ICoreWebView2Profile::DefaultDownloadFolderPath`).
pub fn download_folder(webview: &Webview) -> String {
    let mut path = PWSTR::null();
    // SAFETY: `path` is a local PWSTR for the call to fill, freed by `take_pwstr` below.
    let _ = unsafe { profile_of(webview).DefaultDownloadFolderPath(&mut path) };
    // `path` was filled by the call just above (or left null).
    webview2_com::take_pwstr(path)
}

/// Points the profile's download folder at `folder`. A test puts the folder
/// it found back when it is done.
pub fn set_download_folder(webview: &Webview, folder: &str) {
    // SAFETY: the profile is a COM reference the call holds; the path is an owned HSTRING for the call.
    unsafe { profile_of(webview).SetDefaultDownloadFolderPath(&HSTRING::from(folder)) }.expect("SetDefaultDownloadFolderPath");
}

/// Sends `WM_ACTIVATE` (`WA_ACTIVE`) to `window`, as the system does when the
/// window becomes the active one.
pub fn send_activate(window: &BorrowedWindow<'_>) {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WA_ACTIVE, WM_ACTIVATE};
    let hwnd = HWND(sweetview_platform_window::handle_value(window) as *mut _);
    // SAFETY: `hwnd` is the borrowed window's handle, a window of this thread, and the message
    // carries plain values.
    let _ = unsafe { SendMessageW(hwnd, WM_ACTIVATE, Some(WPARAM(WA_ACTIVE as usize)), Some(LPARAM(0))) };
}

/// Whether WebView2's own download dialog is open on `webview`; `None` without
/// `ICoreWebView2_9` (before Runtime 1.0.1072).
pub fn download_dialog_open(webview: &Webview) -> Option<bool> {
    let webview9 = webview.core().clone().cast::<ICoreWebView2_9>().ok()?;
    let mut open = BOOL::default();
    // SAFETY: `webview9` is a COM reference this frame owns, and `open` a local BOOL to fill.
    unsafe { webview9.IsDefaultDownloadDialogOpen(&mut open) }.ok()?;
    Some(open.as_bool())
}

/// Closes WebView2's own download dialog on `webview`, if it is open.
pub fn close_download_dialog(webview: &Webview) {
    if let Ok(webview9) = webview.core().clone().cast::<ICoreWebView2_9>() {
        // SAFETY: `webview9` is a COM reference this frame owns; no arguments.
        let _ = unsafe { webview9.CloseDefaultDownloadDialog() };
    }
}

/// Gives this thread's keyboard focus to `window` (one of this thread's), as a
/// person clicking a native control would.
pub fn focus_window(window: &BorrowedWindow<'_>) {
    let hwnd = HWND(sweetview_platform_window::handle_value(window) as *mut _);
    // SAFETY: `hwnd` is the handle of the borrowed window, alive for the call; a window of
    // another thread makes the call fail, which the test then sees through `focused_window`.
    let _ = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(hwnd)) };
}

/// Whether this thread's keyboard focus is on `window` itself.
pub fn has_focus(window: &BorrowedWindow<'_>) -> bool {
    focused_window() == sweetview_platform_window::handle_value(window)
}

/// The extended style of the webview's own widget window.
pub fn widget_ex_style(webview: &Webview) -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE};
    // SAFETY: `GetWindowLongPtrW` takes a handle value and an index and reads no memory of ours.
    unsafe { GetWindowLongPtrW(HWND(webview.widget_value() as *mut _), GWL_EXSTYLE) as u32 }
}

/// How many `webview_widget` windows `window` has as children now.
pub fn widget_children(window: &BorrowedWindow<'_>) -> usize {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetParent};
    let parent = HWND(sweetview_platform_window::handle_value(window) as *mut _);
    let mut count = 0;
    let mut after: Option<HWND> = None;
    loop {
        // SAFETY: `parent` is the borrowed window's handle and `after` a sibling the last call
        // returned (or none); the class name is a static wide string.
        let found = unsafe { FindWindowExW(Some(parent), after, windows::core::w!("webview_widget"), windows::core::PCWSTR::null()) };
        let Ok(child) = found else { break };
        // SAFETY: `GetParent` takes a handle value and reads no memory of ours.
        if unsafe { GetParent(child) }.is_ok_and(|p| p == parent) {
            count += 1;
        }
        after = Some(child);
    }
    count
}

/// Lets go of this thread's shared WebView2 environment, once every webview
/// on it is gone, while the thread still runs.
pub fn release_environment() {
    super::environment::release_shared();
}

/// The handle value of the window with this thread's keyboard focus, 0 for none.
pub fn focused_window() -> isize {
    // SAFETY: `GetFocus` takes no arguments and reads the calling thread's input state.
    unsafe { GetFocus() }.0 as isize
}

/// `ICoreWebView2Controller::ZoomFactor` of `webview`.
pub fn zoom_factor(webview: &Webview) -> f64 {
    let controller = webview.controller().clone();
    let mut factor = 0.0;
    // SAFETY: `controller` is a COM reference this frame owns to the live controller of
    // `webview`, and `factor` a local f64 for the call to fill.
    unsafe { controller.ZoomFactor(&mut factor) }.expect("ZoomFactor");
    factor
}

/// Where the top-left corner of `webview`'s area is on the screen, in physical pixels.
pub fn screen_origin(webview: &Webview) -> (i32, i32) {
    let window = container(webview).expect("a live webview");
    let mut point = windows::Win32::Foundation::POINT::default();
    // SAFETY: `window` is the webview's container, a window of this thread, and `point` a
    // local POINT the call converts in place.
    let _ = unsafe { windows::Win32::Graphics::Gdi::ClientToScreen(window, &mut point) };
    (point.x, point.y)
}

/// The outer rectangle (left, top, right, bottom) of the top-level window
/// `webview` is in, in physical pixels.
pub fn top_level_rect(webview: &Webview) -> (i32, i32, i32, i32) {
    let window = container(webview).expect("a live webview");
    // SAFETY: `GetAncestor` takes a handle value and a flag, and reads no memory of ours.
    let root = unsafe { windows::Win32::UI::WindowsAndMessaging::GetAncestor(window, windows::Win32::UI::WindowsAndMessaging::GA_ROOT) };
    let mut rect = windows::Win32::Foundation::RECT::default();
    // SAFETY: `root` is a handle value (a stale one fails the call) and `rect` a local RECT
    // for the call to fill.
    let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowRect(root, &mut rect) };
    (rect.left, rect.top, rect.right, rect.bottom)
}

/// The primary screen's width in physical pixels.
pub fn screen_width() -> i32 {
    // SAFETY: `GetSystemMetrics` takes a plain index and reads no memory of ours.
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_CXSCREEN) }
}

fn root_of(webview: &Webview) -> HWND {
    let window = container(webview).expect("a live webview");
    // SAFETY: `GetAncestor` takes a handle value and a flag, and reads no memory of ours.
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetAncestor(window, windows::Win32::UI::WindowsAndMessaging::GA_ROOT) }
}

/// Keeps the top-level window `webview` is in above every window that is not
/// topmost itself, so other programs' windows on a shared desktop do not cover
/// it during a test with real input.
pub fn keep_on_top(webview: &Webview) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
    let root = root_of(webview);
    // SAFETY: `root` is a top-level window of this thread; the flags keep its position and size.
    let _ = unsafe { SetWindowPos(root, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
}

/// `None` when the screen point `(x, y)` is on the top-level window `webview`
/// is in; otherwise the title of the top-level window that is there.
pub fn covered_at(webview: &Webview, x: i32, y: i32) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetWindowTextW, WindowFromPoint, GA_ROOT};
    let ours = root_of(webview);
    // SAFETY: `WindowFromPoint` takes a point by value and reads no memory of ours.
    let there = unsafe { WindowFromPoint(windows::Win32::Foundation::POINT { x, y }) };
    // SAFETY: `GetAncestor` takes a handle value and a flag, and reads no memory of ours.
    let root = unsafe { GetAncestor(there, GA_ROOT) };
    if root == ours {
        return None;
    }
    let mut title = [0u16; 128];
    // SAFETY: `title` is a local buffer the call fills, its length taken from the slice.
    let n = unsafe { GetWindowTextW(root, &mut title) };
    Some(String::from_utf16_lossy(&title[..n.max(0) as usize]))
}

/// Why `webview` is not in front of the person now, or `None` when it is: its
/// top-level window is the foreground window and no other window covers the
/// middle of the webview. WebView2's own download dialog opens for, and stays
/// open in, a webview in front only (it closes when the webview loses the
/// focus).
pub fn not_in_front(webview: &Webview) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    let ours = root_of(webview);
    // SAFETY: no arguments; reads no memory of ours.
    let front = unsafe { GetForegroundWindow() };
    if front != ours {
        let mut title = [0u16; 128];
        // SAFETY: `title` is a local buffer the call fills, its length taken from the slice.
        let n = unsafe { GetWindowTextW(front, &mut title) };
        return Some(format!("another window is the foreground window: {:?}", String::from_utf16_lossy(&title[..n.max(0) as usize])));
    }
    let (x, y) = screen_origin(webview);
    let sizes = fill_sizes(webview);
    covered_at(webview, x + sizes.container.0 / 2, y + sizes.container.1 / 2).map(|by| format!("the webview is covered by {by:?}"))
}

/// A webview made on `environment` instead of the thread's shared one.
pub fn webview_on(environment: &ICoreWebView2Environment, parent: &BorrowedWindow<'_>, layout: super::host::Layout) -> Result<Webview, sweetview_http::ErrorCode> {
    Webview::create_on(environment, parent, layout, false, None)
}

/// The title of the document in `webview` (`ICoreWebView2::DocumentTitle`).
pub fn document_title(webview: &Webview) -> String {
    let mut title = PWSTR::null();
    // SAFETY: `title` is a local PWSTR for the call to fill, freed by `take_pwstr` below.
    let _ = unsafe { webview.core().DocumentTitle(&mut title) };
    // `title` was filled by the call just above (or left null, which reads as empty).
    webview2_com::take_pwstr(title)
}

/// The version of the installed WebView2 Runtime, empty when there is none.
pub fn runtime_version() -> String {
    let mut version = PWSTR::null();
    // SAFETY: a null browser folder asks for the installed runtime; `version` is a local PWSTR
    // for the call to fill, freed by `take_pwstr` below.
    let _ = unsafe { GetAvailableCoreWebView2BrowserVersionString(windows::core::PCWSTR::null(), &mut version) };
    // `version` was filled by the call just above (or left null, which reads as empty).
    webview2_com::take_pwstr(version)
}

/// The colour (alpha, red, green, blue) WebView2's controller had as its
/// default background when `webview`'s container window was first shown:
/// `None` when it has not been shown, `Some(None)` when it had no controller
/// then. Read by the container's own `WM_SHOWWINDOW`.
pub fn background_when_first_shown(webview: &Webview) -> Option<Option<(u8, u8, u8, u8)>> {
    super::host::background_when_first_shown(webview)
}

/// True while `extras` has a `NewWindowRequested` registration on its
/// webview (only while a popup handler is set).
pub fn new_window_registered(extras: &super::WebviewExtras) -> bool {
    extras.inner.new_window_registration.borrow().is_some()
}

/// How many visible top-level windows this process has now.
pub fn top_level_windows_of_process() -> usize {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetWindowThreadProcessId, IsWindowVisible};
    let pid = std::process::id();
    let mut count = 0;
    let mut after: Option<HWND> = None;
    loop {
        // SAFETY: no parent (top-level windows), the previous window found or none, and no
        // class or name; the system validates `after`.
        let Ok(found) = (unsafe { FindWindowExW(None, after, windows::core::PCWSTR::null(), windows::core::PCWSTR::null()) }) else { break };
        if found.is_invalid() {
            break;
        }
        let mut owner = 0u32;
        // SAFETY: `owner` is a local for the call to fill; the system validates the handle.
        unsafe { GetWindowThreadProcessId(found, Some(&mut owner)) };
        // SAFETY: the system validates the handle; no memory is read through it.
        if owner == pid && unsafe { IsWindowVisible(found) }.as_bool() {
            count += 1;
        }
        after = Some(found);
    }
    count
}

/// Moves the top-level window `webview` is in by (`dx`, `dy`) physical
/// pixels, as dragging its frame would (`SetWindowPos`), keeping its size.
pub fn move_top_level_by(webview: &Webview, dx: i32, dy: i32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetWindowRect, SetWindowPos, GA_ROOT, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};
    let window = container(webview).expect("a live webview");
    // SAFETY: `GetAncestor` takes a handle value and a flag, and reads no memory of ours.
    let root = unsafe { GetAncestor(window, GA_ROOT) };
    let mut rect = windows::Win32::Foundation::RECT::default();
    // SAFETY: `root` is a handle value (a stale one fails the call) and `rect` a local RECT
    // for the call to fill.
    unsafe { GetWindowRect(root, &mut rect) }.expect("GetWindowRect");
    // SAFETY: `root` is a top-level window of this thread (the test's); the numbers are
    // passed by value.
    unsafe { SetWindowPos(root, None, rect.left + dx, rect.top + dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) }.expect("SetWindowPos");
}

/// A plain top-level window of this thread, made as an application makes
/// its own (class `STATIC`, `WS_OVERLAPPEDWINDOW`, shown), with no subclass
/// and nothing of Sweetview's. Destroyed when dropped.
pub struct BareWindow(HWND);

impl BareWindow {
    pub fn new(title: &str) -> Self {
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE};
        // SAFETY: a system class name and a title as wide strings that outlive the call, no
        // parent, menu, module or creation data.
        let hwnd = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), windows::core::w!("STATIC"), &HSTRING::from(title), WS_OVERLAPPEDWINDOW | WS_VISIBLE, 120, 120, 500, 380, None, None, None, None)
        }
        .expect("a bare window");
        Self(hwnd)
    }

    /// Its handle value, as an application hands it to Sweetview.
    pub fn handle_value(&self) -> isize {
        self.0 .0 as isize
    }

    /// Resizes it by its frame, as dragging an edge would.
    pub fn resize(&self, width: i32, height: i32) {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER};
        // SAFETY: this value's own live window; the numbers are passed by value.
        unsafe { SetWindowPos(self.0, None, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) }.expect("SetWindowPos");
    }
}

impl Drop for BareWindow {
    fn drop(&mut self) {
        // SAFETY: the window this value made, on this thread; a window already gone fails the call.
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::DestroyWindow(self.0) };
    }
}

/// The sizes (width, height) of `webview`'s container's client area, of the
/// client area of the window it is in, and of the controller's bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FillSizes {
    pub container: (i32, i32),
    pub parent: (i32, i32),
    pub controller: (i32, i32),
}

pub fn fill_sizes(webview: &Webview) -> FillSizes {
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetParent};
    let widget = container(webview).expect("a live webview");
    let size = |rect: windows::Win32::Foundation::RECT| (rect.right - rect.left, rect.bottom - rect.top);
    let mut inner = windows::Win32::Foundation::RECT::default();
    // SAFETY: `widget` is the webview's container, and `inner` a local RECT for the call to fill.
    let _ = unsafe { GetClientRect(widget, &mut inner) };
    // SAFETY: a handle value; the call reads no memory through it.
    let parent = unsafe { GetParent(widget) }.unwrap_or_default();
    let mut outer = windows::Win32::Foundation::RECT::default();
    // SAFETY: `parent` is a handle value (a stale one fails the call) and `outer` a local RECT.
    let _ = unsafe { GetClientRect(parent, &mut outer) };
    let mut bounds = windows::Win32::Foundation::RECT::default();
    // SAFETY: the controller is a COM reference this frame holds; `bounds` a local RECT.
    let _ = unsafe { webview.controller().Bounds(&mut bounds) };
    FillSizes { container: size(inner), parent: size(outer), controller: size(bounds) }
}

thread_local! {
    pub(super) static FAIL_NEXT_ATTACH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Makes this thread's next `WebviewExtras::attach` fail, as a webview whose
/// request handling WebView2 refuses to set up.
pub fn fail_next_attach() {
    FAIL_NEXT_ATTACH.with(|fail| fail.set(true));
}

/// Whether this thread holds a WebView2 environment now.
pub fn environment_cached() -> bool {
    super::environment::cached()
}

thread_local! {
    pub(super) static REFUSE_NEXT_DROP_SCRIPT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Makes WebView2's answer to this thread's next drop-script registration a
/// refusal, as WebView2 reports one (no script id).
pub fn refuse_next_drop_script() {
    REFUSE_NEXT_DROP_SCRIPT.with(|refuse| refuse.set(true));
}

/// Brings the top-level window `webview` is in to the front and gives it the
/// keyboard focus, as a click in it would (`SetForegroundWindow`; the system
/// may refuse it on a desktop where another program has the input, which
/// [`not_in_front`] then reports).
pub fn bring_to_front(webview: &Webview) {
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let root = root_of(webview);
    // SAFETY: `root` is a top-level window of this thread; the call reads no memory of ours.
    let _ = unsafe { SetForegroundWindow(root) };
}
