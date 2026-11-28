//! The webview itself, made as the C++ fork's `win32_edge_engine` makes it
//! (`core/include/webview/detail/backends/win32_edge.hh`, branch
//! `v1-drafting`): a child window of class `webview_widget` in the window it
//! is given, the WebView2 controller created on that child, the two settings
//! the fork sets, and nothing else. `wry` is not involved: its creation path
//! registers handlers and writes settings the fork never did, with no way to
//! leave them out (DECISIONS D48).
//!
//! The steps, each with the fork's lines:
//!
//! * the widget: `CreateWindowExW(WS_EX_CONTROLPARENT, L"webview_widget",
//!   nullptr, WS_CHILD, 0, 0, 0, 0, parent, ...)` (1784), whose `WM_SIZE`
//!   sizes the controller to its client area (1771 to 1773) and whose class
//!   uses `DefWindowProcW` for everything else;
//! * the controller: `CreateCoreWebView2Controller` on the widget (241),
//!   pumping this thread's messages until it completes (`embed`, 1895 to
//!   1906); a `WM_QUIT` meanwhile cancels (1904); each attempt makes its
//!   environment and starts the controller on that one, under one budget of
//!   60 attempts (`try_create_environment`, 234 to 266 and 404 to 425, the
//!   rules in `attempts.rs`); `ERROR_INVALID_STATE` or `E_ABORT` in the
//!   controller's completion gives up (255 to 262);
//! * the settings: `AreDevToolsEnabled` from `debug` and `IsStatusBarEnabled`
//!   false (1909 to 1923), and no other;
//! * shown: the controller's bounds set to the widget's client area,
//!   `put_IsVisible(TRUE)`, `ShowWindow(widget, SW_SHOW)`, `UpdateWindow`
//!   (1933 to 1936);
//! * at the end: the controller closed (574) and the widget destroyed
//!   (`deinit`, 601 to 604).
//!
//! What the fork's engine does around this (the scripts, the event
//! registrations, focus for a window it owns) is `WebviewExtras` and the
//! runtime's.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::OnceLock;

use sweetview_http::ErrorCode;
use sweetview_platform_window::BorrowedWindow;
use webview2_com::CreateCoreWebView2ControllerCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Controller2, ICoreWebView2Environment, COREWEBVIEW2_COLOR,
    COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
};
use windows::core::{w, Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    ERROR_INVALID_STATE, E_ABORT, E_POINTER, E_UNEXPECTED, HINSTANCE, HWND, LPARAM, LRESULT, RECT,
    WPARAM,
};
use windows::Win32::Graphics::Gdi::UpdateWindow;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{GetParent, IsChild, CHILDID_SELF, EVENT_OBJECT_LOCATIONCHANGE, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, MoveWindow, RegisterClassExW, SetParent,
    ShowWindow, SW_HIDE, SW_SHOW, WM_NCDESTROY, WM_SIZE, WNDCLASSEXW, WS_CHILD, WS_EX_CONTROLPARENT,
};

use super::attempts::Failed;
use super::pump::{pump_while, PumpEnd};


/// The fork's widget class name.
const WIDGET_CLASS: PCWSTR = w!("webview_widget");

thread_local! {
    /// The widgets of this thread that exist, by handle value, each with the
    /// number of the `Widget` value that made it and the controller its
    /// `WM_SIZE` sizes (once there is one). An entry goes at `WM_NCDESTROY`,
    /// so a widget destroyed with its parent is never destroyed again under a
    /// handle value the system may have given to another window since.
    static WIDGETS: RefCell<HashMap<isize, (u64, Option<ICoreWebView2Controller>)>> = RefCell::new(HashMap::new());
    static NEXT_WIDGET: Cell<u64> = const { Cell::new(1) };
    /// How many webviews of this thread are alive: with the last, the thread's
    /// environment is let go of (`environment.rs`).
    static LIVE_WEBVIEWS: Cell<usize> = const { Cell::new(0) };
    /// The watch on this thread's windows' moves, from the thread's first widget
    /// on: unhooking it when the last widget went and hooking again with the
    /// next cost a kernel handle each time (measured: 9 over 8 lives, against
    /// WebView2's own 8 with the hook kept).
    static MOVE_WATCH: RefCell<Option<MoveWatch>> = const { RefCell::new(None) };
    /// The widgets that fill their parent's client area (`Layout::Fill`, or
    /// `fill_parent` since their last `set_bounds`), by handle value.
    static FILLING: RefCell<std::collections::HashSet<isize>> = RefCell::new(std::collections::HashSet::new());
    /// Tests only: each widget's controller's default background (alpha, red,
    /// green, blue) when the widget was first shown, read in its
    /// `WM_SHOWWINDOW`; `None` inside when it had no controller then.
    #[cfg(any(test, feature = "test-support"))]
    static FIRST_SHOWN: RefCell<HashMap<isize, Option<Argb>>> = RefCell::new(HashMap::new());
}

/// A colour as WebView2 gives it: alpha, red, green, blue.
#[cfg(any(test, feature = "test-support"))]
pub(crate) type Argb = (u8, u8, u8, u8);

/// Tests only: what [`FIRST_SHOWN`] holds for `webview`'s widget.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn background_when_first_shown(webview: &Webview) -> Option<Option<Argb>> {
    FIRST_SHOWN.with(|shown| shown.borrow().get(&key(webview.widget.hwnd)).copied())
}

/// Tests only: records the controller's default background the first time
/// the widget is shown.
#[cfg(any(test, feature = "test-support"))]
fn note_first_shown(hwnd: HWND) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller2;
    if FIRST_SHOWN.with(|shown| shown.borrow().contains_key(&key(hwnd))) {
        return;
    }
    let controller = WIDGETS.try_with(|widgets| widgets.borrow().get(&key(hwnd)).and_then(|(_, c)| c.clone())).ok().flatten();
    let colour = controller.and_then(|c| c.cast::<ICoreWebView2Controller2>().ok()).and_then(|c| {
        let mut colour = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_COLOR::default();
        // SAFETY: `c` is a COM reference this frame holds (from `cast`); `colour` is a local for
        // the call to fill.
        unsafe { c.DefaultBackgroundColor(&mut colour) }.ok().map(|()| (colour.A, colour.R, colour.G, colour.B))
    });
    FIRST_SHOWN.with(|shown| shown.borrow_mut().insert(key(hwnd), colour));
}

fn key(hwnd: HWND) -> isize {
    hwnd.0 as isize
}

/// A WinEvent hook on this thread's windows' location changes
/// (`EVENT_OBJECT_LOCATIONCHANGE`, out of context, so delivered through this
/// thread's message loop, whichever loop that is). Each time a window moves,
/// the controller of every widget in it (or the widget itself) is told
/// (`NotifyParentWindowPositionChanged`), as WebView2 asks, so what WebView2
/// places on the screen itself (a `<select>`'s list, a tooltip, the input it
/// routes) follows the window. Nothing is attached to any window: a window
/// the application gave is not subclassed. The C++ fork told WebView2 of no
/// move; `wry`, which this crate replaced, did from its subclass of the
/// parent, and without it a click on a page moved into a window that was then
/// placed missed what it was aimed at. Unhooked in `Drop`.
struct MoveWatch(HWINEVENTHOOK);

impl MoveWatch {
    fn start() -> Option<Self> {
        // SAFETY: no arguments; reads no memory.
        let thread = unsafe { GetCurrentThreadId() };
        // SAFETY: the range is one event; no module, as the procedure is out of context; the
        // procedure is a `'static` fn of this crate; the events are this thread's windows'.
        let hook = unsafe { SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, None, Some(window_moved), 0, thread, WINEVENT_OUTOFCONTEXT) };
        (!hook.is_invalid()).then_some(Self(hook))
    }
}

impl Drop for MoveWatch {
    fn drop(&mut self) {
        // SAFETY: the hook this value set and has not unhooked.
        let _ = unsafe { UnhookWinEvent(self.0) };
    }
}

/// The hook's procedure: `hwnd` (a window, not one of its objects) moved or
/// was resized. A widget filling it is sized to its client area again,
/// whoever resized it (the application, a Sweetview call, the person
/// dragging its frame), so a page filling any window follows it; then the
/// controllers of the widgets it holds are told it moved. The widgets and
/// controllers are taken out of the tables before any is sized or called, so
/// a call that sends a widget a message finds the tables free.
extern "system" fn window_moved(_hook: HWINEVENTHOOK, _event: u32, hwnd: HWND, object: i32, child: i32, _thread: u32, _time: u32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if object != OBJID_WINDOW.0 || child != CHILDID_SELF as i32 || hwnd.is_invalid() {
            return;
        }
        let filling: Vec<HWND> = FILLING
            .try_with(|filling| filling.borrow().iter().map(|widget| HWND(*widget as *mut _)).collect())
            .unwrap_or_default();
        for widget in filling {
            // SAFETY: a handle value; the call reads no memory through it.
            if unsafe { GetParent(widget) }.ok() == Some(hwnd) {
                fill(widget, hwnd);
            }
        }
        let controllers: Vec<ICoreWebView2Controller> = WIDGETS
            .try_with(|widgets| {
                widgets
                    .borrow()
                    .iter()
                    .filter(|(widget, _)| {
                        let widget = HWND(**widget as *mut _);
                        // SAFETY: two handle values; the call reads no memory through them.
                        widget == hwnd || unsafe { IsChild(hwnd, widget) }.as_bool()
                    })
                    .filter_map(|(_, (_, controller))| controller.clone())
                    .collect()
            })
            .unwrap_or_default();
        for controller in controllers {
            // SAFETY: `controller` is a COM reference this frame owns; no arguments.
            let _ = unsafe { controller.NotifyParentWindowPositionChanged() };
        }
    }));
}

/// The widget class's procedure: `WM_SIZE` sizes the widget's controller to
/// the client area (the fork's `resize_webview`), `WM_NCDESTROY` forgets the
/// widget, everything else is `DefWindowProcW`. Nothing unwinds out of it.
extern "system" fn widget_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    catch_unwind(AssertUnwindSafe(|| {
        if msg == WM_SIZE {
            size_controller(hwnd);
            return LRESULT(0);
        }
        #[cfg(any(test, feature = "test-support"))]
        if msg == windows::Win32::UI::WindowsAndMessaging::WM_SHOWWINDOW && wparam.0 != 0 {
            note_first_shown(hwnd);
        }
        if msg == WM_NCDESTROY {
            // The entry (with its controller reference) is taken out, then released once the
            // borrow has ended.
            let gone = WIDGETS.try_with(|widgets| widgets.borrow_mut().remove(&key(hwnd))).ok().flatten();
            drop(gone);
            let _ = FILLING.try_with(|filling| filling.borrow_mut().remove(&key(hwnd)));
            #[cfg(any(test, feature = "test-support"))]
            let _ = FIRST_SHOWN.try_with(|shown| shown.borrow_mut().remove(&key(hwnd)));
        }
        // SAFETY: the arguments are the ones the system called this procedure with, for this window.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }))
    .unwrap_or(LRESULT(0))
}

fn client_rect(hwnd: HWND) -> Option<RECT> {
    let mut client = RECT::default();
    // SAFETY: `client` is a RECT owned by this frame for the call to fill; the system validates the handle.
    unsafe { GetClientRect(hwnd, &mut client) }.ok()?;
    Some(client)
}

/// Sizes `widget` to `parent`'s client area (the fork's `resize_widget`), when
/// it is not that size already.
fn fill(widget: HWND, parent: HWND) {
    let (Some(client), Some(now)) = (client_rect(parent), client_rect(widget)) else { return };
    if (now.right - now.left, now.bottom - now.top) == (client.right - client.left, client.bottom - client.top) {
        return;
    }
    // SAFETY: `widget` is a widget of this thread's table (its entry goes at `WM_NCDESTROY`);
    // the numbers are passed by value.
    let _ = unsafe { MoveWindow(widget, client.left, client.top, client.right - client.left, client.bottom - client.top, true) };
}

fn size_controller(hwnd: HWND) {
    let controller = WIDGETS.try_with(|widgets| widgets.borrow().get(&key(hwnd)).and_then(|(_, c)| c.clone())).ok().flatten();
    let (Some(controller), Some(client)) = (controller, client_rect(hwnd)) else { return };
    // SAFETY: `controller` is a COM reference this frame owns; the rectangle is passed by value.
    let _ = unsafe { controller.SetBounds(client) };
}

fn module() -> Option<HINSTANCE> {
    // SAFETY: a null module name asks for the handle of the process's own executable; no pointer is passed.
    unsafe { GetModuleHandleW(None) }.ok().map(HINSTANCE::from)
}

/// Registers the widget class once per process (the fork registers it for
/// each engine and never unregisters it). A class of that name registered by
/// other code first is refused: its procedure would not size the controller.
fn register_class() -> bool {
    static REGISTERED: OnceLock<bool> = OnceLock::new();
    *REGISTERED.get_or_init(|| {
        let Some(module) = module() else { return false };
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(widget_proc),
            hInstance: module,
            lpszClassName: WIDGET_CLASS,
            ..Default::default()
        };
        // SAFETY: `class` is a fully initialised WNDCLASSEXW owned by this frame; its name is a
        // static wide string and its procedure a `'static` fn.
        unsafe { RegisterClassExW(&class) != 0 }
    })
}

/// The `webview_widget` child window. Destroyed in `Drop`, unless something
/// destroyed it first (its parent did).
struct Widget {
    hwnd: HWND,
    number: u64,
}

impl Widget {
    fn create(parent: HWND) -> Result<Self, ErrorCode> {
        if !register_class() {
            return Err(ErrorCode::InvalidState);
        }
        let module = module().ok_or(ErrorCode::InvalidState)?;
        // SAFETY: the class name is a static wide string, there is no window name, `parent`
        // is a window of this thread (the caller's `BorrowedWindow`), and no creation
        // parameter is passed: the procedure reads nothing through `lparam` at creation.
        let created = unsafe {
            CreateWindowExW(WS_EX_CONTROLPARENT, WIDGET_CLASS, PCWSTR::null(), WS_CHILD, 0, 0, 0, 0, Some(parent), None, Some(module), None)
        };
        let hwnd = created.map_err(|_| ErrorCode::InvalidState)?;
        let number = NEXT_WIDGET.with(|n| n.replace(n.get() + 1));
        WIDGETS.with(|widgets| widgets.borrow_mut().insert(key(hwnd), (number, None)));
        MOVE_WATCH.with(|watch| {
            let mut watch = watch.borrow_mut();
            if watch.is_none() {
                *watch = MoveWatch::start();
            }
        });
        Ok(Self { hwnd, number })
    }

    /// True while the window this value made exists.
    fn alive(&self) -> bool {
        WIDGETS.try_with(|widgets| widgets.borrow().get(&key(self.hwnd)).is_some_and(|(n, _)| *n == self.number)).unwrap_or(false)
    }

    fn set_controller(&self, controller: &ICoreWebView2Controller) {
        WIDGETS.with(|widgets| {
            if let Some(entry) = widgets.borrow_mut().get_mut(&key(self.hwnd)).filter(|(n, _)| *n == self.number) {
                entry.1 = Some(controller.clone());
            }
        });
    }

    fn move_to(&self, x: i32, y: i32, width: i32, height: i32) {
        if self.alive() {
            // SAFETY: the widget is this value's own live window; the numbers are passed by value.
            let _ = unsafe { MoveWindow(self.hwnd, x, y, width, height, true) };
        }
    }

    fn show(&self, visible: bool) {
        if self.alive() {
            // SAFETY: the widget is this value's own live window.
            let _ = unsafe { ShowWindow(self.hwnd, if visible { SW_SHOW } else { SW_HIDE }) };
        }
    }
}

impl Drop for Widget {
    fn drop(&mut self) {
        if !self.alive() {
            return;
        }
        // Its controller is not sized again from here on. The reference is taken out of the
        // table and released after the borrow ends: a release that sends the widget a message
        // finds the table free.
        let held = WIDGETS.try_with(|widgets| widgets.borrow_mut().get_mut(&key(self.hwnd)).and_then(|entry| entry.1.take())).ok().flatten();
        drop(held);
        // SAFETY: `alive` says the window this value made still exists under this handle; it is
        // a window of this thread, and its `WM_NCDESTROY` removes the entry.
        let _ = unsafe { DestroyWindow(self.hwnd) };
    }
}

/// Where the webview sits in the window it is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// The whole client area of the window, sized now; afterwards by
    /// [`Webview::fill_parent`] or by the window laying out its first child.
    Fill,
    /// This rectangle of the window's client area, in physical pixels.
    Bounds { x: i32, y: i32, width: u32, height: u32 },
}

type Completed = Box<dyn FnOnce(windows::core::Result<()>, Option<ICoreWebView2Controller>) -> windows::core::Result<()>>;

/// The closure the completion handler calls: hands the outcome to `on_done`
/// inside `catch_unwind`, and reports a panic to WebView2 as `E_UNEXPECTED`.
fn guarded_completion(on_done: impl FnOnce(windows::core::Result<ICoreWebView2Controller>) + 'static) -> Completed {
    Box::new(move |result, controller| {
        catch_unwind(AssertUnwindSafe(move || {
            on_done(result.and_then(|()| controller.ok_or_else(|| E_POINTER.into())));
        }))
        .map_err(|_| E_UNEXPECTED.into())
    })
}


/// One webview: its widget and its WebView2 controller. Not `Send`, not `Sync`.
/// Dropping it closes the controller and destroys the widget.
/// A WebView2 controller this crate made, closed when dropped (the fork's
/// `deinit`, 574): owned from the moment WebView2 hands it over, so a failure
/// before the `Webview` exists still closes it before its widget goes.
struct Controller(ICoreWebView2Controller);

impl std::ops::Deref for Controller {
    type Target = ICoreWebView2Controller;
    fn deref(&self) -> &ICoreWebView2Controller {
        &self.0
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        // SAFETY: `self.0` is this value's COM reference until it drops, after this call;
        // closing a controller already closed (as `WebviewExtras` does first) is a no-op.
        let _ = unsafe { self.0.Close() };
        #[cfg(test)]
        CLOSED.with(|closed| closed.set(closed.get() + 1));
    }
}

#[cfg(test)]
thread_local! {
    /// Tests only: fail the creation right after the controller exists, and keep
    /// a reference to that controller for the test to look at.
    static FAIL_AFTER_CONTROLLER: RefCell<Option<Option<ICoreWebView2Controller>>> = const { RefCell::new(None) };
    /// Tests only: how many controllers this thread has closed.
    static CLOSED: Cell<u32> = const { Cell::new(0) };
    /// Tests only: how many times this thread has called `CreateCoreWebView2Controller`.
    static CONTROLLER_CALLS: Cell<u32> = const { Cell::new(0) };
}

pub struct Webview {
    /// First, so it is closed before the widget, the last field, is destroyed.
    controller: Controller,
    webview: ICoreWebView2,
    environment: ICoreWebView2Environment,
    /// Last, so it goes after the controller is closed.
    widget: Widget,
}

impl Webview {
    /// Makes a webview in `parent` (a window of this thread), as the fork's
    /// `embed` does, on this thread's shared WebView2 environment (made on the
    /// first webview, D15), laid out as `layout` and shown. Pumps this
    /// thread's messages until WebView2 has made it. Errors:
    /// [`ErrorCode::MissingDependency`] without a WebView2 Runtime,
    /// [`ErrorCode::Canceled`] when a `WM_QUIT` arrives meanwhile (it is
    /// consumed, as in the fork), [`ErrorCode::InvalidState`] when WebView2
    /// cannot make it. `background` (red, green, blue), when given, is
    /// WebView2's default background from before the webview is first shown,
    /// so it never shows WebView2's own white while the page starts.
    pub fn create(parent: &BorrowedWindow<'_>, layout: Layout, devtools: bool, background: Option<(u8, u8, u8)>) -> Result<Self, ErrorCode> {
        super::environment::prepare()?;
        let made = Self::create_with(super::environment::for_attempt, parent, layout, devtools, background);
        if made.is_err() && LIVE_WEBVIEWS.with(Cell::get) == 0 {
            // No webview of the thread holds the environment the attempts made.
            super::environment::release_shared();
        }
        made
    }

    /// [`create`](Self::create) on `environment` at every attempt.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn create_on(
        environment: &ICoreWebView2Environment,
        parent: &BorrowedWindow<'_>,
        layout: Layout,
        devtools: bool,
        background: Option<(u8, u8, u8)>,
    ) -> Result<Self, ErrorCode> {
        Self::create_with(|_| Ok(environment.clone()), parent, layout, devtools, background)
    }

    /// The fork's attempts (`attempts.rs`): each makes its environment with
    /// `environment` and the controller on it, in the widget.
    fn create_with(
        environment: impl FnMut(u32) -> Result<ICoreWebView2Environment, Failed>,
        parent: &BorrowedWindow<'_>,
        layout: Layout,
        devtools: bool,
        background: Option<(u8, u8, u8)>,
    ) -> Result<Self, ErrorCode> {
        let parent = HWND(sweetview_platform_window::handle_value(parent) as *mut _);
        let widget = Widget::create(parent)?;
        // Owned from its completion on (`create_controller_once`): from here on any failure
        // closes it, and then the widget goes.
        let (environment, controller) =
            super::attempts::attempt(environment, |environment| create_controller_once(environment, &widget), || std::thread::sleep(super::attempts::RETRY_WAIT))?;
        // The host may have destroyed its window while the last wait pumped.
        if !widget.alive() {
            return Err(ErrorCode::InvalidState);
        }
        let environment = &environment;
        #[cfg(test)]
        if FAIL_AFTER_CONTROLLER.with(|fail| fail.borrow().is_some()) {
            FAIL_AFTER_CONTROLLER.with(|fail| *fail.borrow_mut() = Some(Some(controller.0.clone())));
            return Err(ErrorCode::Unspecified);
        }
        // SAFETY: `controller` is the COM reference WebView2 just handed over; no arguments.
        let webview = unsafe { controller.CoreWebView2() }.map_err(|_| ErrorCode::InvalidState)?;
        // SAFETY: `webview` is the COM reference just returned; no arguments.
        let settings = unsafe { webview.Settings() }.map_err(|_| ErrorCode::Unspecified)?;
        // SAFETY: `settings` is the COM reference just returned; the flag is passed by value.
        unsafe { settings.SetAreDevToolsEnabled(devtools) }.map_err(|_| ErrorCode::Unspecified)?;
        // SAFETY: as above.
        unsafe { settings.SetIsStatusBarEnabled(false) }.map_err(|_| ErrorCode::Unspecified)?;
        let made = Self { controller, webview, environment: environment.clone(), widget };
        LIVE_WEBVIEWS.with(|live| live.set(live.get() + 1));
        made.widget.set_controller(&made.controller.0);
        // Before the widget is first shown (it is made without `WS_VISIBLE`), so nothing is
        // painted in WebView2's own white first.
        if let Some((r, g, b)) = background {
            if made.set_background_color(r, g, b, 255) != ErrorCode::Ok {
                return Err(ErrorCode::Unspecified);
            }
        }
        match layout {
            Layout::Fill => made.fill_parent(),
            Layout::Bounds { x, y, width, height } => made.set_bounds(x, y, width, height),
        }
        size_controller(made.widget.hwnd);
        made.set_visible(true);
        if made.widget.alive() {
            // SAFETY: the widget is this value's own live window.
            let _ = unsafe { UpdateWindow(made.widget.hwnd) };
        }
        Ok(made)
    }

    #[cfg(test)]
    pub(crate) fn live_count() -> usize {
        LIVE_WEBVIEWS.with(Cell::get)
    }

    pub(crate) fn controller(&self) -> &ICoreWebView2Controller {
        &self.controller.0
    }

    pub(crate) fn core(&self) -> &ICoreWebView2 {
        &self.webview
    }

    pub(crate) fn environment(&self) -> &ICoreWebView2Environment {
        &self.environment
    }

    /// The widget's handle value: for the tests' read-back, and for the backdrop the runtime
    /// installs on it, which paints the widget until WebView2 has drawn (DECISIONS D49).
    pub fn widget_value(&self) -> isize {
        key(self.widget.hwnd)
    }

    /// `ICoreWebView2::Navigate`.
    pub fn navigate(&self, url: &str) -> ErrorCode {
        // SAFETY: `self.webview` is this value's live COM reference; the URL is an owned HSTRING for the call.
        match unsafe { self.webview.Navigate(&HSTRING::from(url)) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
    }

    /// `ICoreWebView2::NavigateToString`.
    pub fn navigate_to_string(&self, html: &str) -> ErrorCode {
        // SAFETY: `self.webview` is this value's live COM reference; the HTML is an owned HSTRING for the call.
        match unsafe { self.webview.NavigateToString(&HSTRING::from(html)) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
    }

    /// `ICoreWebView2::ExecuteScript` with no completion handler, as the fork's `eval`.
    pub fn evaluate(&self, script: &str) -> ErrorCode {
        let handler: Option<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ExecuteScriptCompletedHandler> = None;
        // SAFETY: `self.webview` is this value's live COM reference; the script is an owned HSTRING
        // for the call, and no completion handler is passed.
        match unsafe { self.webview.ExecuteScript(&HSTRING::from(script), handler) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
    }

    /// Moves the widget to this rectangle of its parent's client area; its
    /// `WM_SIZE` sizes the controller.
    pub fn set_bounds(&self, x: i32, y: i32, width: u32, height: u32) {
        let _ = FILLING.try_with(|filling| filling.borrow_mut().remove(&key(self.widget.hwnd)));
        self.widget.move_to(x, y, i32::try_from(width).unwrap_or(i32::MAX), i32::try_from(height).unwrap_or(i32::MAX));
    }

    /// Sizes the widget to its parent's whole client area (the fork's
    /// `resize_widget`), and keeps it so after each resize of the parent,
    /// until [`set_bounds`](Self::set_bounds).
    pub fn fill_parent(&self) {
        if self.widget.alive() {
            let _ = FILLING.try_with(|filling| filling.borrow_mut().insert(key(self.widget.hwnd)));
        }
        // SAFETY: `GetParent` takes a handle value and reads no memory of ours.
        let parent = unsafe { windows::Win32::UI::WindowsAndMessaging::GetParent(self.widget.hwnd) };
        if let Some(client) = parent.ok().and_then(client_rect) {
            self.widget.move_to(client.left, client.top, client.right - client.left, client.bottom - client.top);
        }
    }

    /// `put_IsVisible` and the widget shown or hidden.
    pub fn set_visible(&self, visible: bool) {
        // SAFETY: `self.controller` is this value's live COM reference; the flag is passed by value.
        let _ = unsafe { self.controller.SetIsVisible(visible) };
        self.widget.show(visible);
    }

    /// Gives the page the keyboard focus (`MoveFocus`, programmatic, the fork's `focus_webview`).
    pub fn move_focus(&self) {
        // SAFETY: `self.controller` is this value's live COM reference; the reason is a plain enum value.
        let _ = unsafe { self.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
    }

    /// Moves the webview, without reloading it, into `parent` (a window of
    /// this thread). Its layout there is the caller's: [`set_bounds`](Self::set_bounds)
    /// or [`fill_parent`](Self::fill_parent).
    pub fn reparent(&self, parent: &BorrowedWindow<'_>) -> ErrorCode {
        if !self.widget.alive() {
            return ErrorCode::InvalidState;
        }
        let parent = HWND(sweetview_platform_window::handle_value(parent) as *mut _);
        // SAFETY: the widget is this value's own live window and `parent` a window of this thread.
        if unsafe { SetParent(self.widget.hwnd, Some(parent)) }.is_err() {
            return ErrorCode::Unspecified;
        }
        // SAFETY: `self.controller` is this value's live COM reference; no arguments.
        let _ = unsafe { self.controller.NotifyParentWindowPositionChanged() };
        ErrorCode::Ok
    }

    /// The colour WebView2 paints behind the page
    /// (`ICoreWebView2Controller2::DefaultBackgroundColor`). WebView2 takes only
    /// an alpha of 0 or 255; any other is refused with
    /// [`ErrorCode::Unspecified`], as the fork refuses it, and so is a runtime
    /// without the interface.
    pub fn set_background_color(&self, r: u8, g: u8, b: u8, a: u8) -> ErrorCode {
        if a != 0 && a != 255 {
            return ErrorCode::Unspecified;
        }
        let Ok(controller2) = self.controller.cast::<ICoreWebView2Controller2>() else {
            return ErrorCode::Unspecified;
        };
        // SAFETY: `controller2` is a COM reference this frame holds (from `cast`); the colour is passed by value.
        match unsafe { controller2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: a, R: r, G: g, B: b }) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
    }
}


impl Drop for Webview {
    /// With the thread's last webview, the thread's cache lets go of the
    /// environment; this webview's own reference, a field, goes right after,
    /// so the environment is released here, while the thread runs.
    fn drop(&mut self) {
        let left = LIVE_WEBVIEWS.with(|live| {
            live.set(live.get().saturating_sub(1));
            live.get()
        });
        if left == 0 {
            super::environment::release_shared();
        }
    }
}

/// One `CreateCoreWebView2Controller` on `widget`, pumping this thread's
/// messages until it completes (the fork's `embed` wait loop).
///
/// The widget must still be the live one this creation made (`widget.alive()`):
/// a host that destroyed its window while an earlier wait pumped took the
/// widget with it, and the attempt fails as WebView2 fails it for a parent
/// window that is gone (`E_ABORT`, which gives up). The completion wraps the
/// controller in its owner at once: a completion that arrives after the wait
/// was given up (a `WM_QUIT`) is closed when its slot goes.
fn create_controller_once(environment: &ICoreWebView2Environment, widget: &Widget) -> Result<Controller, Failed> {
    if !widget.alive() {
        return Err(Failed::Completed(E_ABORT));
    }
    let slot: Rc<RefCell<Option<windows::core::Result<Controller>>>> = Rc::default();
    let handler = {
        let slot = slot.clone();
        CreateCoreWebView2ControllerCompletedHandler::create(guarded_completion(move |outcome| {
            *slot.borrow_mut() = Some(outcome.map(Controller));
        }))
    };
    #[cfg(test)]
    CONTROLLER_CALLS.with(|calls| calls.set(calls.get() + 1));
    // SAFETY: `environment` is a live COM reference the caller holds, `widget.hwnd` the live
    // widget of this thread (checked just above, and kept by the caller for the attempt), and
    // `handler` a live COM object WebView2 keeps its own reference to until it completes.
    let started = unsafe { environment.CreateCoreWebView2Controller(widget.hwnd, &handler) };
    drop(handler);
    started.map_err(|error| Failed::AtOnce(error.code()))?;
    match pump_while(|| slot.borrow().is_none()) {
        PumpEnd::Done => {}
        PumpEnd::Quit => return Err(Failed::Quit),
        PumpEnd::Failed => return Err(Failed::Completed(windows::core::HRESULT::from_win32(ERROR_INVALID_STATE.0))),
    }
    let outcome = slot.borrow_mut().take();
    match outcome {
        Some(Ok(controller)) => Ok(controller),
        Some(Err(error)) => Err(Failed::Completed(error.code())),
        None => Err(Failed::Completed(windows::core::HRESULT::from_win32(ERROR_INVALID_STATE.0))),
    }
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
        assert_eq!(seen.borrow_mut().take().map(|outcome| outcome.err()), Some(Some(E_POINTER)));
    }

    // The widget is an owning type: made and dropped in a loop, every USER, GDI and kernel
    // count comes back to its start, and a widget its parent destroyed first is not destroyed
    // again.
    #[test]
    fn a_widget_gives_back_every_handle() {
        use tao::event_loop::EventLoopBuilder;
        use tao::platform::windows::EventLoopBuilderExtWindows;
        let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
        let parent = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("parent");
        let parent_hwnd = HWND(sweetview_platform_window::handle_value(&BorrowedWindow::of(&parent)) as *mut _);
        sweetview_platform_loop::testing::assert_gives_back_every_handle(50, || {
            let widget = Widget::create(parent_hwnd).expect("widget");
            assert!(widget.alive());
            widget.move_to(0, 0, 100, 50);
            drop(widget);
        });
        // Destroyed with its own parent first: the value knows, and its drop does nothing.
        let other = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("other parent");
        let other_hwnd = HWND(sweetview_platform_window::handle_value(&BorrowedWindow::of(&other)) as *mut _);
        let orphan = Widget::create(other_hwnd).expect("widget");
        assert!(orphan.alive());
        sweetview_platform_window::destroy_now(other);
        assert!(!orphan.alive(), "its WM_NCDESTROY came with its parent's destruction");
        // Does nothing: the handle value may name another window by now.
        drop(orphan);
    }

    // Y3: a thread that makes and drops webviews keeps no environment once the last is gone
    // (released while the thread runs), and ends without faulting.
    #[test]
    fn a_thread_that_made_webviews_keeps_no_environment_and_ends_cleanly() {
        let ended = std::thread::spawn(move || {
            use tao::event_loop::EventLoopBuilder;
            use tao::platform::windows::EventLoopBuilderExtWindows;
            let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
            let parent = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("parent");
            let mut kept = Vec::new();
            for round in 0..3 {
                let first = Webview::create(&BorrowedWindow::of(&parent), Layout::Fill, false, None).expect("webview");
                let second = Webview::create(&BorrowedWindow::of(&parent), Layout::Fill, false, None).expect("webview");
                assert!(super::super::environment::cached(), "round {round}: shared while webviews live");
                drop(first);
                assert!(super::super::environment::cached(), "round {round}: kept while one lives");
                drop(second);
                kept.push(super::super::environment::cached());
            }
            drop(parent);
            drop(event_loop);
            kept
        })
        .join();
        assert_eq!(ended.ok(), Some(vec![false, false, false]), "the thread ended, holding no environment after each round");
    }

    // Y3: a thread that ends with a webview still alive (its environment held at the
    // thread's storage teardown) ends without faulting: that environment is not released
    // there.
    #[test]
    fn a_thread_that_ends_with_a_live_webview_does_not_fault() {
        let ended = std::thread::spawn(move || {
            use tao::event_loop::EventLoopBuilder;
            use tao::platform::windows::EventLoopBuilderExtWindows;
            let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
            let parent = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("parent");
            let webview = Webview::create(&BorrowedWindow::of(&parent), Layout::Fill, false, None).expect("webview");
            let held = super::super::environment::cached();
            std::mem::forget(webview);
            drop(parent);
            drop(event_loop);
            held
        })
        .join();
        assert_eq!(ended.ok(), Some(true), "the thread ended holding its environment, without faulting");
    }

    /// Run by `a_process_that_exits_with_a_live_webview_does_not_fault` in a process of its own:
    /// makes a webview and exits the process with it alive.
    #[test]
    #[ignore = "a step of a_process_that_exits_with_a_live_webview_does_not_fault"]
    fn exit_with_a_live_webview_step() {
        if std::env::var_os("SWEETVIEW_EXIT_STEP").is_none() {
            return;
        }
        use tao::event_loop::EventLoopBuilder;
        use tao::platform::windows::EventLoopBuilderExtWindows;
        let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
        let parent = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("parent");
        let webview = Webview::create(&BorrowedWindow::of(&parent), Layout::Fill, false, None).expect("webview");
        println!("EXIT STEP made {}", Webview::live_count());
        std::mem::forget((webview, parent, event_loop));
        std::process::exit(0);
    }

    #[test]
    fn a_process_that_exits_with_a_live_webview_does_not_fault() {
        let exe = std::env::current_exe().expect("test binary");
        for round in 0..2 {
            let out = std::process::Command::new(&exe)
                .args(["--ignored", "--exact", "platform::host::tests::exit_with_a_live_webview_step", "--nocapture"])
                .env("SWEETVIEW_EXIT_STEP", "1")
                .output()
                .expect("the step ran");
            let said = String::from_utf8_lossy(&out.stdout);
            assert!(said.contains("EXIT STEP made 1"), "round {round}: the step made its webview: {said}");
            assert_eq!(out.status.code(), Some(0), "round {round}: exited without a fault: {:?}", out.status);
        }
    }

    // Y2: a host that destroys its window while creation pumps for the environment: no
    // controller call is made into the dead widget, and the creation fails (E_ABORT, given up).
    #[test]
    fn a_window_destroyed_while_the_environment_is_made_gets_no_controller_call() {
        use tao::event_loop::EventLoopBuilder;
        use tao::platform::windows::EventLoopBuilderExtWindows;
        let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
        let parent = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("parent");
        super::super::environment::prepare().expect("WebView2");
        let calls_before = CONTROLLER_CALLS.with(Cell::get);
        let value = sweetview_platform_window::handle_value(&BorrowedWindow::of(&parent));
        let parent_cell = RefCell::new(Some(parent));
        let made = BorrowedWindow::with_handle_value(value, |window| {
            Webview::create_with(
                |number| {
                    let environment = super::super::environment::for_attempt(number);
                    // The host destroys its window during the wait.
                    if let Some(parent) = parent_cell.borrow_mut().take() {
                        sweetview_platform_window::destroy_now(parent);
                    }
                    environment
                },
                window,
                Layout::Fill,
                false,
                None,
            )
        })
        .expect("the window exists when the creation starts");
        assert_eq!(made.err(), Some(ErrorCode::InvalidState), "the creation gave up");
        assert_eq!(CONTROLLER_CALLS.with(Cell::get), calls_before, "no controller call into a dead widget");
        super::super::environment::release_shared();
    }

    // Y2: a completion that arrives after its wait was given up (a WM_QUIT) is closed.
    #[test]
    fn a_controller_that_completes_after_its_wait_was_given_up_is_closed() {
        use tao::event_loop::EventLoopBuilder;
        use tao::platform::windows::EventLoopBuilderExtWindows;
        use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, PostQuitMessage, TranslateMessage, MSG, PM_REMOVE};
        let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
        let parent = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("parent");
        super::super::environment::prepare().expect("WebView2");
        let environment = super::super::environment::for_attempt(0).expect("environment");
        let closed_before = CLOSED.with(Cell::get);
        let widget = Widget::create(HWND(sweetview_platform_window::handle_value(&BorrowedWindow::of(&parent)) as *mut _)).expect("widget");
        // SAFETY: no arguments beyond the exit code; posts WM_QUIT to this thread's queue.
        unsafe { PostQuitMessage(0) };
        assert_eq!(create_controller_once(&environment, &widget).err(), Some(Failed::Quit), "the wait was given up");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while CLOSED.with(Cell::get) == closed_before && std::time::Instant::now() < deadline {
            let mut message = MSG::default();
            // SAFETY: `message` is a local MSG the call fills; any window of this thread.
            while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                // SAFETY: `message` was just filled by PeekMessageW.
                let _ = unsafe { TranslateMessage(&message) };
                // SAFETY: as above.
                unsafe { DispatchMessageW(&message) };
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(CLOSED.with(Cell::get), closed_before + 1, "the late controller was closed");
        drop(widget);
        drop(environment);
        super::super::environment::release_shared();
    }

    // W3: a failure after WebView2 has handed the controller over and before the `Webview`
    // exists (here forced right after it) closes that controller, and its widget goes after it.
    #[test]
    fn a_creation_that_fails_after_the_controller_exists_closes_it() {
        use tao::event_loop::EventLoopBuilder;
        use tao::platform::windows::EventLoopBuilderExtWindows;
        use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;
        let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
        let parent = tao::window::WindowBuilder::new().with_visible(false).build(&event_loop).expect("parent");
        let parent_hwnd = HWND(sweetview_platform_window::handle_value(&BorrowedWindow::of(&parent)) as *mut _);
        FAIL_AFTER_CONTROLLER.with(|fail| *fail.borrow_mut() = Some(None));
        let closed_before = CLOSED.with(Cell::get);
        let failed = Webview::create(&BorrowedWindow::of(&parent), Layout::Fill, false, None);
        let kept = FAIL_AFTER_CONTROLLER.with(|fail| fail.borrow_mut().take()).flatten();
        assert_eq!(failed.err(), Some(ErrorCode::Unspecified), "the forced failure");
        let controller = kept.expect("the controller existed when the creation failed");
        // WebView2 answers a closed controller's calls as an open one's here, so what is counted
        // is the close this crate's owning type made.
        assert_eq!(CLOSED.with(Cell::get), closed_before + 1, "the controller was closed");
        // SAFETY: `parent_hwnd` is the test's window; no class or name filters beyond the widget's.
        let widget = unsafe { FindWindowExW(Some(parent_hwnd), None, WIDGET_CLASS, PCWSTR::null()) };
        assert!(widget.map(|w| w.is_invalid()).unwrap_or(true), "the widget went with it");
        drop(controller);
        super::super::environment::release_shared();
    }

}
