//! Windows: the webview made as the C++ fork's `win32_edge.hh` makes it
//! (`host.rs`), and everything added to it. Ported from the C++ fork's
//! `win32_edge.hh` and the tabs library's `win-webview2.ts`.

mod environment;
mod handlers;
mod host;
mod istream;
mod attempts;
mod gate;
mod pump;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use self::environment::{create_environment, default_user_data_folder, release_shared as release_thread_environment};
pub use self::host::{Layout, Webview};

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::{Rc, Weak};
use std::sync::Arc;

use sweetview_http::{
    header_lines, headers_to_json, reason_phrase, route_request, AssetTable, ErrorCode, Header, Route,
    WINDOWS_ASSET_ORIGIN, WINDOWS_FRAMES_ORIGIN,
};
use webview2_com::take_pwstr;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::{E_NOTIMPL, E_OUTOFMEMORY, STG_E_INVALIDFUNCTION};
use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_SHIFT};
use windows::Win32::UI::Shell::SHCreateMemStream;

use self::handlers::{
    AcceleratorKeyPressed, ContentLoading, MessageReceived, NavigationCompleted, NavigationStarting, NewWindowRequested,
    PermissionRequested, Registration, RequestFilter, ResourceRequested, ScriptAdded,
};
use self::istream::StreamingIStream;
use crate::shared::{next_request_id, Job, Responder, Shared};
use crate::stream::StreamState;
use crate::{
    failure_reason, file_drop_flag_script, is_file_drop_message, ExtrasOptions, KeyData, NavigationFailure, RawRequest,
    FILE_DROP_SCRIPT,
};

/// A request handed to the request handler and not yet answered.
struct Pending {
    deferral: ICoreWebView2Deferral,
    args: ICoreWebView2WebResourceRequestedEventArgs,
}

#[derive(Default)]
struct Navigations {
    /// Started navigations' addresses by navigation id; removed on completion.
    urls: HashMap<u64, String>,
    /// The host navigation epoch each started navigation belongs to.
    epochs: HashMap<u64, u64>,
    latest: Option<u64>,
}

type RequestHandler = Rc<dyn Fn(RawRequest)>;
type FileDropHandler = Rc<dyn Fn(Vec<String>)>;
type AcceleratorHandler = Rc<dyn Fn(KeyData) -> bool>;
type NavigationFailedHandler = Rc<dyn Fn(NavigationFailure)>;
/// What receives each message the page posts.
pub type PageMessageHandler = Rc<dyn Fn(&str)>;
type NewWindowHandler = Rc<dyn Fn(String)>;

struct Inner {
    shared: Arc<Shared>,
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    env: ICoreWebView2Environment,
    assets: RefCell<AssetTable>,
    request_handler: RefCell<Option<RequestHandler>>,
    pending: RefCell<HashMap<u64, Pending>>,
    file_drop_handler: RefCell<Option<FileDropHandler>>,
    file_drop_enabled: Cell<bool>,
    accelerator_handler: RefCell<Option<AcceleratorHandler>>,
    navigation_failed_handler: RefCell<Option<NavigationFailedHandler>>,
    page_message_handler: RefCell<Option<PageMessageHandler>>,
    /// The popup handler, and its `NewWindowRequested` registration, which
    /// exists only while there is a handler: with none, WebView2 opens the
    /// popup itself, as under the C++ fork.
    new_window_handler: RefCell<Option<NewWindowHandler>>,
    new_window_registration: RefCell<Option<Registration>>,
    navigations: RefCell<Navigations>,
    host_epoch: Cell<u64>,
    /// When a script asked for after a navigation may go (`gate.rs`).
    gate: RefCell<self::gate::Gate>,
    /// Called when that navigation's document exists or it has ended, inside
    /// WebView2's `ContentLoading` or `NavigationCompleted`.
    navigation_started: RefCell<Option<Rc<dyn Fn()>>>,
    registrations: RefCell<Vec<Registration>>,
    /// The two web-resource filters, removed when this value drops (on a failed
    /// `register` too) or in `WebviewExtras`'s teardown.
    filters: RefCell<Vec<RequestFilter>>,
    /// Scripts handed to `AddScriptToExecuteOnDocumentCreated` whose completion
    /// has not arrived.
    scripts_outstanding: Cell<usize>,
    scripts_registered: RefCell<Option<Rc<dyn Fn()>>>,
}

/// A script added with [`WebviewExtras::add_user_script`]. Dropping it does
/// not remove the script (it lives as long as the webview); pass it to
/// [`WebviewExtras::remove_user_script`] for that.
pub struct UserScript {
    state: Rc<ScriptState>,
}

impl std::fmt::Debug for UserScript {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserScript").field("id", &self.state.id.borrow()).finish()
    }
}

/// WebView2 reports a script's id asynchronously; a removal asked for before
/// the id arrives is carried out when it does.
#[derive(Default)]
struct ScriptState {
    id: RefCell<Option<String>>,
    removed: Cell<bool>,
}

/// Everything added to one webview. Not `Send`, not `Sync`.
///
/// Dropping it unregisters every handler it registered, aborts open streams,
/// closes the WebView2 controller, and releases open requests unanswered (the
/// teardown order of `requests.md`), so it is dropped as part of dropping the
/// webview, right before the [`Webview`].
pub struct WebviewExtras {
    inner: Rc<Inner>,
}

fn hstring(s: &str) -> HSTRING {
    HSTRING::from(s)
}

/// Whether `key` is down, from the thread's keyboard state.
fn key_down(key: VIRTUAL_KEY) -> bool {
    // SAFETY: `GetKeyState` takes a plain integer and reads the calling thread's
    // keyboard state; no pointer is involved.
    let state = unsafe { GetKeyState(i32::from(key.0)) };
    state < 0
}

impl WebviewExtras {
    /// Adds the request handler (with its filters on both origins), the file
    /// drop script and its message handler, the page's messages, the
    /// clipboard-read permission the C++ fork grants, and the accelerator key
    /// and navigation handlers to `webview`. Call it before the webview's first
    /// navigation, so the first document is served and gets the drop script.
    pub fn attach(webview: &Webview, options: ExtrasOptions) -> Result<Self, ErrorCode> {
        #[cfg(any(test, feature = "test-support"))]
        if test_support::FAIL_NEXT_ATTACH.with(|fail| fail.replace(false)) {
            return Err(ErrorCode::Unspecified);
        }
        let inner = Rc::new(Inner {
            shared: Shared::new(options.wake_ui),
            controller: webview.controller().clone(),
            webview: webview.core().clone(),
            env: webview.environment().clone(),
            assets: RefCell::new(AssetTable::new()),
            request_handler: RefCell::new(None),
            pending: RefCell::new(HashMap::new()),
            file_drop_handler: RefCell::new(None),
            file_drop_enabled: Cell::new(false),
            accelerator_handler: RefCell::new(None),
            navigation_failed_handler: RefCell::new(None),
            page_message_handler: RefCell::new(None),
            new_window_handler: RefCell::new(None),
            new_window_registration: RefCell::new(None),
            navigations: RefCell::new(Navigations::default()),
            host_epoch: Cell::new(0),
            gate: RefCell::new(self::gate::Gate::default()),
            navigation_started: RefCell::new(None),
            registrations: RefCell::new(Vec::new()),
            filters: RefCell::new(Vec::new()),
            scripts_outstanding: Cell::new(0),
            scripts_registered: RefCell::new(None),
        });
        // On failure `inner` drops here, and with it every registration and filter made so far.
        inner.register().map_err(|_| ErrorCode::Unspecified)?;
        Ok(Self { inner })
    }

    /// Runs the work queued from other threads (answers, stream heads, file
    /// drops). Call it on the UI thread after `wake_ui`.
    pub fn drain(&self) {
        let inner = self.inner.clone();
        while let Some(job) = inner.shared.next_job() {
            inner.run(job);
        }
    }

    /// Adds a script that runs at document creation in every later document
    /// (and in every frame: a top-frame guard is the caller's text).
    ///
    /// Returns at once. WebView2 registers the script asynchronously, and a
    /// navigation started before it reports completion can be created without
    /// the script; so until [`scripts_pending`](Self::scripts_pending) is false
    /// the caller holds its navigations back, and the handler given to
    /// [`set_scripts_registered_handler`](Self::set_scripts_registered_handler)
    /// says when to release them. WebView2 reports the completion only once a
    /// navigation already in flight has its response (or is stopped), which is
    /// why this does not wait: the response may have to come from this very
    /// thread. A script WebView2 refuses still comes back (with no id;
    /// removing it does nothing).
    pub fn add_user_script(&self, source: &str) -> Result<UserScript, ErrorCode> {
        let state = Rc::new(ScriptState::default());
        let weak = Rc::downgrade(&self.inner);
        let pending = state.clone();
        let handler = ScriptAdded::create(move |id| {
            let inner = weak.upgrade();
            match id {
                Some(id) if pending.removed.get() => {
                    if let Some(inner) = &inner {
                        inner.remove_script_id(&id);
                    }
                }
                Some(id) => *pending.id.borrow_mut() = Some(id),
                None => {}
            }
            if let Some(inner) = inner {
                inner.script_registered();
            }
        });
        let added = self.inner.add_script(source, Some(&handler));
        drop(handler);
        if added.is_ok() {
            self.inner.scripts_outstanding.set(self.inner.scripts_outstanding.get() + 1);
        }
        Ok(UserScript { state })
    }

    /// Whether a script added with [`add_user_script`](Self::add_user_script)
    /// (or a removal asked for before its id arrived) is still waiting for
    /// WebView2. A navigation started now could miss it.
    pub fn scripts_pending(&self) -> bool {
        self.inner.scripts_outstanding.get() > 0
    }

    /// Sets or clears the handler called when the last outstanding script
    /// registration completes, so [`scripts_pending`](Self::scripts_pending)
    /// has become false. It runs inside WebView2's completion callback: it
    /// should only schedule work.
    pub fn set_scripts_registered_handler(&self, handler: Option<Rc<dyn Fn()>>) {
        drop(self.inner.scripts_registered.replace(handler));
    }

    /// `ICoreWebView2::Stop`: cancels the navigation in flight, if any. A
    /// navigation started afterwards would cancel it in any case; stopping it
    /// first lets WebView2 report outstanding script registrations without
    /// waiting for that navigation's response.
    pub fn stop_navigation(&self) {
        // SAFETY: `Inner` holds a COM reference to this ICoreWebView2 (taken from the `Webview` in
        // `attach`), so it is alive for the call; once WebView2 has closed, the call returns
        // an error rather than touching freed state. No arguments.
        let _ = unsafe { self.inner.webview.Stop() };
    }

    /// Removes a script added with [`add_user_script`](Self::add_user_script)
    /// from documents created from now on.
    pub fn remove_user_script(&self, script: UserScript) {
        script.state.removed.set(true);
        let id = script.state.id.borrow_mut().take();
        if let Some(id) = id {
            self.inner.remove_script_id(&id);
        }
    }

    /// Serves `data` at `path` of `http://webview.localhost`, replacing what
    /// was there. [`ErrorCode::InvalidArgument`] when `mime` is not a valid
    /// header value or `data` is larger than 4 GiB - 1.
    pub fn set_asset(&self, path: &str, mime: &str, data: Vec<u8>) -> ErrorCode {
        self.inner.assets.borrow_mut().set(path, mime, data).into()
    }

    /// Sets or clears the request handler. Requests already handed to the old
    /// one stay open until answered or until teardown.
    pub fn set_request_handler(&self, handler: Option<Rc<dyn Fn(RawRequest)>>) -> ErrorCode {
        drop(self.inner.request_handler.replace(handler));
        ErrorCode::Ok
    }

    /// The answering half, for any thread.
    pub fn responder(&self) -> Responder {
        Responder::new(self.inner.shared.clone())
    }

    /// `ICoreWebView2Controller4::AllowExternalDrop`: whether content dragged
    /// from outside the app can be dropped on the page. Drags inside the page
    /// work either way. [`ErrorCode::Unspecified`] without the interface.
    pub fn set_allow_external_drop(&self, allow: bool) -> ErrorCode {
        let Ok(controller4) = self.inner.controller.cast::<ICoreWebView2Controller4>() else {
            return ErrorCode::Unspecified;
        };
        // SAFETY: `controller4` is a COM reference this frame holds (from `cast`) to the
        // controller `Inner` keeps alive; the flag is passed by value.
        match unsafe { controller4.SetAllowExternalDrop(allow) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
    }

    /// Whether WebView2 currently accepts drags that start outside the app:
    /// what [`set_allow_external_drop`](Self::set_allow_external_drop) last set,
    /// read back from the controller. `None` without the interface.
    pub fn allows_external_drop(&self) -> Option<bool> {
        let controller4 = self.inner.controller.cast::<ICoreWebView2Controller4>().ok()?;
        let mut allowed = windows::core::BOOL::default();
        // SAFETY: `controller4` is a COM reference this frame holds (from `cast`) to the
        // controller `Inner` keeps alive, and `allowed` is a BOOL owned by this frame for
        // the call to fill.
        unsafe { controller4.AllowExternalDrop(&mut allowed) }.ok()?;
        Some(allowed.as_bool())
    }

    /// Sets or clears the handler that receives the real paths of files dropped
    /// on the top-level document from the OS, instead of the page. It runs from
    /// [`drain`](Self::drain), after the drop event has returned, and is never
    /// called with an empty list. Transactional: when the page's drop capture
    /// cannot be switched, the previous handler stays and
    /// [`ErrorCode::Unspecified`] is returned.
    pub fn set_file_drop_handler(&self, handler: Option<Rc<dyn Fn(Vec<String>)>>) -> ErrorCode {
        let enabled = handler.is_some();
        if enabled != self.inner.file_drop_enabled.get() {
            if self.inner.execute_script(&file_drop_flag_script(enabled)).is_err() {
                return ErrorCode::Unspecified;
            }
            self.inner.file_drop_enabled.set(enabled);
        }
        drop(self.inner.file_drop_handler.replace(handler));
        ErrorCode::Ok
    }

    /// Sets or clears the handler for accelerator keys pressed while the page
    /// has focus (key-down and system-key-down only). Returning true marks the
    /// key handled, so the page does not see it.
    pub fn set_accelerator_key_handler(&self, handler: Option<Rc<dyn Fn(KeyData) -> bool>>) -> ErrorCode {
        drop(self.inner.accelerator_handler.replace(handler));
        ErrorCode::Ok
    }

    /// Sets or clears the handler for top-level navigations that fail without a
    /// response, under the rules of [`NavigationFailure`].
    pub fn set_navigation_failed_handler(&self, handler: Option<Rc<dyn Fn(NavigationFailure)>>) -> ErrorCode {
        drop(self.inner.navigation_failed_handler.replace(handler));
        ErrorCode::Ok
    }

    /// Sets or clears the handler that receives each message the page posts
    /// with `window.chrome.webview.postMessage` (a string), inside WebView2's
    /// event. The drop script's own message never reaches it.
    pub fn set_page_message_handler(&self, handler: Option<PageMessageHandler>) {
        drop(self.inner.page_message_handler.replace(handler));
    }

    /// Sets or clears the popup handler. With one, a popup the page asks for
    /// (`window.open`, `target="_blank"`) is not opened: the handler gets its
    /// address, inside WebView2's event. With none, nothing is registered and
    /// WebView2 opens the popup itself, as under the C++ fork.
    pub fn set_new_window_handler(&self, handler: Option<Rc<dyn Fn(String)>>) -> ErrorCode {
        let registered = self.inner.new_window_registration.borrow().is_some();
        match (&handler, registered) {
            (Some(_), false) => {
                let weak = Rc::downgrade(&self.inner);
                let added = Registration::add_new_window_requested(
                    &self.inner.webview,
                    &NewWindowRequested::create(move |args| {
                        if let Some(inner) = weak.upgrade() {
                            inner.on_new_window_requested(args);
                        }
                    }),
                );
                match added {
                    Ok(registration) => *self.inner.new_window_registration.borrow_mut() = Some(registration),
                    Err(_) => return ErrorCode::Unspecified,
                }
            }
            (None, true) => drop(self.inner.new_window_registration.take()),
            _ => {}
        }
        drop(self.inner.new_window_handler.replace(handler));
        ErrorCode::Ok
    }

    /// Records that the host is about to navigate (`load_url`, `load_html`):
    /// a failure of a navigation started before this is no longer current.
    pub fn note_host_navigation(&self) {
        self.inner.host_epoch.set(self.inner.host_epoch.get() + 1);
    }

    /// Records that a navigation the host asked for is being sent to WebView2
    /// now; `within` when it stays in the document (see
    /// [`stays_in_document`](Self::stays_in_document)). Until the last one
    /// sent has its document, or ends without one,
    /// [`navigation_starting`](Self::navigation_starting) is true: a script
    /// asked for before then can run in the document being replaced (measured
    /// on a new webview's first navigation, even after its
    /// `NavigationStarting`). Called before `Navigate` and never again after a
    /// successful one, so a `NavigationStarting` raised inside the call counts.
    pub fn note_host_navigation_sent(&self, within: bool) {
        self.inner.gate.borrow_mut().sent(within);
    }

    /// The navigation just noted as sent was refused by WebView2.
    pub fn note_host_navigation_refused(&self) {
        let opened = self.inner.gate.borrow_mut().refused();
        if opened {
            let handler = self.inner.navigation_started.borrow().clone();
            if let Some(handler) = handler {
                handler();
            }
        }
    }

    /// Whether navigating to `url` stays in the document shown now: the same
    /// address with only its fragment new or changed. WebView2 raises no
    /// navigation events for such a navigation (no new document is made), so
    /// nothing may wait for them.
    pub fn stays_in_document(&self, url: &str) -> bool {
        let Some((target, _)) = url.split_once('#') else { return false };
        let mut source = PWSTR::null();
        // SAFETY: `source` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        if unsafe { self.inner.webview.Source(&mut source) }.is_err() {
            return false;
        }
        // Filled by `Source` on success with a NUL-terminated string allocated for us.
        let current = take_pwstr(source);
        let current = current.split_once('#').map_or(current.as_str(), |(base, _)| base);
        !current.is_empty() && current == target
    }

    /// True from a navigation the host sent until its document exists or it
    /// has ended.
    pub fn navigation_starting(&self) -> bool {
        self.inner.gate.borrow().waiting()
    }

    /// Sets or clears the handler called when the navigation the host sent
    /// has its document or has ended. It runs inside WebView2's
    /// `ContentLoading` or `NavigationCompleted`: it should only schedule work.
    pub fn set_navigation_started_handler(&self, handler: Option<Rc<dyn Fn()>>) {
        drop(self.inner.navigation_started.replace(handler));
    }

    /// Tells WebView2 its window moved, so popups (select lists, tooltips)
    /// follow it.
    pub fn notify_parent_window_position_changed(&self) {
        // SAFETY: `Inner` holds a COM reference to the controller (taken from the `Webview` in
        // `attach`), so it is alive for the call; a closed one returns an error. No arguments.
        let _ = unsafe { self.inner.controller.NotifyParentWindowPositionChanged() };
    }

    /// Calls a Chrome DevTools Protocol method without waiting for its result,
    /// as the tabs library's `devTools` does.
    pub fn call_devtools_protocol_method(&self, method: &str, params_json: &str) -> ErrorCode {
        let handler: Option<&ICoreWebView2CallDevToolsProtocolMethodCompletedHandler> = None;
        // SAFETY: both strings are owned HSTRINGs for the call, and no completion
        // handler is passed.
        match unsafe { self.inner.webview.CallDevToolsProtocolMethod(&hstring(method), &hstring(params_json), handler) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
    }
}

impl Drop for WebviewExtras {
    fn drop(&mut self) {
        let inner = &self.inner;
        // Answers and stream steps are refused from here on and queued ones never
        // run; every streamed body still open is aborted, so a Read() blocked on
        // WebView2's thread returns before WebView2 shuts down.
        drop(inner.shared.close());
        // Close the controller before any deferral is released, so WebView2 has
        // torn down its network stack: a deferral released unanswered can then
        // never send its request to the network. The `Webview`'s own drop closes it again,
        // which does nothing.
        // SAFETY: `Inner` holds a COM reference to the controller until it drops, after this
        // call; closing an already closed controller (as the `Webview` does again later) is a no-op.
        let _ = unsafe { inner.controller.Close() };
        drop(inner.pending.take());
        drop(inner.registrations.take());
        drop(inner.filters.take());
        // The application's handlers may hold anything, a Responder included.
        drop(inner.request_handler.take());
        drop(inner.file_drop_handler.take());
        drop(inner.accelerator_handler.take());
        drop(inner.navigation_failed_handler.take());
        drop(inner.new_window_registration.take());
        drop(inner.new_window_handler.take());
        drop(inner.page_message_handler.take());
        drop(inner.scripts_registered.take());
    }
}

impl Inner {
    fn register(self: &Rc<Self>) -> windows::core::Result<()> {
        // Every request to either origin reaches the handler. Each filter is
        // owned: if anything below fails, the filters added so far are removed
        // as this frame unwinds its locals, with the handlers.
        let mut filters = Vec::new();
        for origin in [WINDOWS_ASSET_ORIGIN, WINDOWS_FRAMES_ORIGIN] {
            filters.push(RequestFilter::add(&self.webview, &format!("{origin}/*"))?);
        }

        // Each handler holds the extras weakly and a strong reference for the
        // duration of one call, so a handler may replace itself or drop the
        // extras from inside its own call.
        let mut registrations = Vec::new();
        let weak: Weak<Inner> = Rc::downgrade(self);
        registrations.push(Registration::add_web_resource_requested(
            &self.webview,
            &ResourceRequested::create(move |args| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_web_resource_requested(args);
                }
            }),
        )?);
        let weak = Rc::downgrade(self);
        registrations.push(Registration::add_web_message_received(
            &self.webview,
            &MessageReceived::create(move |args| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_web_message_received(args);
                }
            }),
        )?);
        let weak = Rc::downgrade(self);
        registrations.push(Registration::add_content_loading(
            &self.webview,
            &ContentLoading::create(move |args| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_content_loading(args);
                }
            }),
        )?);
        let weak = Rc::downgrade(self);
        registrations.push(Registration::add_navigation_starting(
            &self.webview,
            &NavigationStarting::create(move |args| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_navigation_starting(args);
                }
            }),
        )?);
        let weak = Rc::downgrade(self);
        registrations.push(Registration::add_navigation_completed(
            &self.webview,
            &NavigationCompleted::create(move |args| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_navigation_completed(args);
                }
            }),
        )?);
        let weak = Rc::downgrade(self);
        registrations.push(Registration::add_accelerator_key_pressed(
            &self.controller,
            &AcceleratorKeyPressed::create(move |args| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_accelerator_key_pressed(args);
                }
            }),
        )?);
        // The clipboard-read permission is granted, as the C++ fork's handler grants it; any
        // other request is left to WebView2.
        registrations.push(Registration::add_permission_requested(
            &self.webview,
            &PermissionRequested::create(|args| {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                // SAFETY: `kind` is a local for the call to fill; `args` are the live event args.
                if unsafe { args.PermissionKind(&mut kind) }.is_ok() && kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
                    // SAFETY: `args` are the live event args WebView2 passed; the state is a plain value.
                    let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) };
                }
            }),
        )?);
        *self.registrations.borrow_mut() = registrations;
        *self.filters.borrow_mut() = filters;

        // The drop script is the same in every document and starts disabled. Waited for, pumping
        // this thread's messages, as the fork's `embed` waits for its scripts (`add_init_script`,
        // `add_user_script`, `win32_edge.hh` 1585 to 1592): a new webview has no navigation in
        // flight, so nothing of this thread's has to run for WebView2 to answer. Not waiting let
        // what an application does right after making a webview run ahead of WebView2 having its
        // first document (measured: a strip's page answered 40 ms later than under `wry`, whose
        // build waited for its scripts too, and the tabs fixture's theme check lost the race).
        let done = Rc::new(Cell::new(false));
        let seen = done.clone();
        let handler = ScriptAdded::create(move |_| seen.set(true));
        self.add_script(FILE_DROP_SCRIPT, Some(&handler))?;
        drop(handler);
        match self::pump::pump_while(|| !done.get()) {
            self::pump::PumpEnd::Done => Ok(()),
            // A `WM_QUIT` meanwhile ends the wait, consumed, as the controller's creation does.
            self::pump::PumpEnd::Quit | self::pump::PumpEnd::Failed => Err(windows::core::Error::from(windows::Win32::Foundation::E_ABORT)),
        }
    }

    /// `AddScriptToExecuteOnDocumentCreated`, with the handler that receives the
    /// script's id, or none.
    fn add_script(
        &self,
        source: &str,
        handler: Option<&ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>,
    ) -> windows::core::Result<()> {
        // SAFETY: `self.webview` is this webview's live ICoreWebView2; the script is an
        // owned HSTRING for the call, and `handler`, when present, a live COM object
        // WebView2 holds its own reference to until it completes.
        unsafe { self.webview.AddScriptToExecuteOnDocumentCreated(&hstring(source), handler) }
    }

    fn execute_script(&self, script: &str) -> windows::core::Result<()> {
        let handler: Option<&ICoreWebView2ExecuteScriptCompletedHandler> = None;
        // SAFETY: the script is an owned HSTRING for the call; no completion handler.
        unsafe { self.webview.ExecuteScript(&hstring(script), handler) }
    }

    /// One outstanding script registration completed; tells the handler when
    /// it was the last.
    fn script_registered(&self) {
        let left = self.scripts_outstanding.get().saturating_sub(1);
        self.scripts_outstanding.set(left);
        if left == 0 {
            let handler = self.scripts_registered.borrow().clone();
            if let Some(handler) = handler {
                handler();
            }
        }
    }

    fn remove_script_id(&self, id: &str) {
        // SAFETY: the id is an owned HSTRING for the call.
        let _ = unsafe { self.webview.RemoveScriptToExecuteOnDocumentCreated(&hstring(id)) };
    }

    fn run(&self, job: Job) {
        match job {
            Job::Complete { id, status, headers, body } => self.complete_request(id, status, &headers, &body),
            Job::BeginStream { id, status, headers, stream } => self.start_streamed_response(id, status, &headers, &stream),
            Job::ForgetAbandoned { id, key } => self.shared.forget_abandoned_stream(id, key),
            Job::FileDrop(paths) => self.deliver_file_drop(paths),
        }
    }

    // ---- requests -----------------------------------------------------------

    fn on_web_resource_requested(self: &Rc<Self>, args: &ICoreWebView2WebResourceRequestedEventArgs) {
        if catch_unwind(AssertUnwindSafe(|| self.handle_web_resource_request(args))).is_err() {
            // Anything that went wrong before the request was handed off is
            // answered here rather than left to reach the network.
            self.put_fail_closed_response(args);
        }
    }

    fn handle_web_resource_request(&self, args: &ICoreWebView2WebResourceRequestedEventArgs) {
        // SAFETY: `args` is the live event args WebView2 passed to this handler.
        let Ok(request) = (unsafe { args.Request() }) else {
            self.put_fail_closed_response(args);
            return;
        };
        let mut uri = PWSTR::null();
        // SAFETY: `uri` is a local PWSTR for the call to fill; it is freed by `take_pwstr`.
        if unsafe { request.Uri(&mut uri) }.is_err() {
            self.put_fail_closed_response(args);
            return;
        }
        // `uri` was filled by `Request::Uri` just above with a NUL-terminated string WebView2
        // allocated for us; `take_pwstr` reads it up to its NUL and frees it.
        let url = take_pwstr(uri);

        let has_handler = self.request_handler.borrow().is_some();
        {
            let assets = self.assets.borrow();
            match route_request(&url, &assets, has_handler) {
                Route::NotFound => {
                    drop(assets);
                    self.put_response(args, 404, "", &[]);
                    return;
                }
                Route::Asset(asset) => {
                    self.put_response(args, 200, &format!("Content-Type: {}", asset.mime), &asset.data);
                    return;
                }
                Route::Handler => {}
            }
        }
        let Some(handler) = self.request_handler.borrow().clone() else {
            self.put_response(args, 404, "", &[]);
            return;
        };

        let mut method = PWSTR::null();
        // SAFETY: `method` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        let method = match unsafe { request.Method(&mut method) } {
            // Filled by `Method` on success with a NUL-terminated string allocated for us;
            // read up to its NUL and freed.
            Ok(()) => take_pwstr(method),
            Err(_) => String::new(),
        };
        let method = if method.is_empty() { String::from("GET") } else { method };
        let headers_json = read_request_headers_json(&request);
        let Some(body) = read_request_body(&request) else {
            // A partial body never reaches the handler as if it were whole.
            self.put_response(args, 500, "Content-Type: text/plain", &[]);
            return;
        };
        drop(request);

        // Held open until a Responder answers it.
        // SAFETY: `args` is the live event args WebView2 passed to this handler.
        let Ok(deferral) = (unsafe { args.GetDeferral() }) else {
            self.put_response(args, 500, "", &[]);
            return;
        };
        let id = next_request_id();
        self.pending.borrow_mut().insert(id, Pending { deferral, args: args.clone() });

        let request = RawRequest { id, method, url, headers_json, body: (!body.is_empty()).then_some(body) };
        if catch_unwind(AssertUnwindSafe(|| handler(request))).is_err() {
            // A handler that panics must not strand the request.
            self.fail_pending_request(id);
        }
    }

    /// A bare `500 Internal Server Error` with no body: the answer of last
    /// resort, so a request never goes on to the network. Returns whether a
    /// response was set.
    fn put_fail_closed_response(&self, args: &ICoreWebView2WebResourceRequestedEventArgs) -> bool {
        let response = self
            .create_response(None, 500, "Internal Server Error", "Content-Type: text/plain")
            .or_else(|_| self.create_response(None, 500, "", ""));
        response.and_then(|response| set_response(args, &response)).is_ok()
    }

    /// `CreateWebResourceResponse` on this webview's environment: every response
    /// this crate sets is made here.
    fn create_response(
        &self,
        body: Option<&IStream>,
        status: i32,
        reason: &str,
        headers: &str,
    ) -> windows::core::Result<ICoreWebView2WebResourceResponse> {
        // SAFETY: `self.env` is this webview's live environment; the strings are owned
        // HSTRINGs for the call, and `body` is an `Option<&IStream>`, a borrowed COM
        // reference that is alive for the whole call by its lifetime, so the call can
        // take its own reference.
        unsafe { self.env.CreateWebResourceResponse(body, status, &hstring(reason), &hstring(headers)) }
    }

    fn try_put_response(
        &self,
        args: &ICoreWebView2WebResourceRequestedEventArgs,
        status: i32,
        headers: &str,
        body: &[u8],
    ) -> windows::core::Result<()> {
        let stream = if body.is_empty() {
            None
        } else {
            // SAFETY: `body` is a borrowed buffer for the whole call, which copies it;
            // its length is at most 4 GiB - 1 (checked when it was accepted).
            let stream = unsafe { SHCreateMemStream(Some(body)) };
            Some(stream.ok_or(windows::core::Error::from(E_OUTOFMEMORY))?)
        };
        let response = self.create_response(stream.as_ref(), status, reason_phrase(status), headers)?;
        set_response(args, &response)
    }

    /// Sets the response; when it cannot be built (headers WebView2 refuses, no
    /// memory for the body) a bare 500 is set instead. Returns whether any
    /// response was set.
    fn put_response(&self, args: &ICoreWebView2WebResourceRequestedEventArgs, status: i32, headers: &str, body: &[u8]) -> bool {
        self.try_put_response(args, status, headers, body).is_ok() || self.put_fail_closed_response(args)
    }

    /// Completes the deferral of a request whose response has been set, and
    /// forgets the request (erased first, so nothing reached from `Complete`
    /// sees it still pending).
    fn complete_and_erase(&self, id: u64) {
        let pending = self.pending.borrow_mut().remove(&id);
        if let Some(pending) = pending {
            // SAFETY: `pending` holds a COM reference to this request's deferral, and it was
            // just removed from the table, so `Complete` runs once per deferral.
            let _ = unsafe { pending.deferral.Complete() };
        }
    }

    fn pending_args(&self, id: u64) -> Option<ICoreWebView2WebResourceRequestedEventArgs> {
        self.pending.borrow().get(&id).map(|p| p.args.clone())
    }

    /// Answers a still-open request with the fallback 500, unless an answer or
    /// a stream head for it is already queued. When not even the fallback can
    /// be set the request stays pending, so teardown still releases it.
    fn fail_pending_request(&self, id: u64) {
        if self.shared.is_submitted(id) {
            return;
        }
        let Some(args) = self.pending_args(id) else { return };
        if self.put_fail_closed_response(&args) {
            self.complete_and_erase(id);
        }
    }

    /// UI thread: a queued answer. When no response at all can be set the
    /// request stays pending (completing it would pass it to the network).
    fn complete_request(&self, id: u64, status: i32, headers: &[Header], body: &[u8]) {
        self.shared.forget_submitted(id);
        let Some(args) = self.pending_args(id) else {
            return; // already answered, or the browser let go of it
        };
        if self.put_response(&args, status, &header_lines(headers), body) {
            self.complete_and_erase(id);
        }
    }

    /// UI thread: sets the streamed response on the deferred request and
    /// completes it; WebView2 then reads the body on its own thread.
    fn start_streamed_response(&self, id: u64, status: i32, headers: &[Header], stream: &Arc<StreamState>) {
        self.shared.forget_submitted(id);
        let Some(args) = self.pending_args(id) else {
            self.shared.drop_stream(id, stream);
            return;
        };
        // Ours only until CreateWebResourceResponse takes its own reference.
        let body = StreamingIStream::create(stream.clone());
        let response = self.create_response(Some(&body), status, reason_phrase(status), &header_lines(headers));
        drop(body);
        let set = response.and_then(|response| set_response(&args, &response));
        if set.is_err() {
            self.shared.drop_stream(id, stream);
            if !self.put_fail_closed_response(&args) {
                return; // left deferred; teardown releases it
            }
        }
        self.complete_and_erase(id);
    }

    // ---- file drops -----------------------------------------------------------

    fn on_new_window_requested(&self, args: &ICoreWebView2NewWindowRequestedEventArgs) {
        let handler = self.new_window_handler.borrow().clone();
        let Some(handler) = handler else { return };
        // SAFETY: `args` are the live event args WebView2 passed; the flag is passed by value.
        let _ = unsafe { args.SetHandled(true) };
        let mut uri = PWSTR::null();
        // SAFETY: `uri` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        if unsafe { args.Uri(&mut uri) }.is_ok() {
            // `uri` was filled by `Uri` just above.
            handler(take_pwstr(uri));
        }
    }

    fn on_web_message_received(self: &Rc<Self>, args: &ICoreWebView2WebMessageReceivedEventArgs) {
        let mut message = PWSTR::null();
        // SAFETY: `message` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        // A message that is not a string fails here and is not the drop script's.
        if unsafe { args.TryGetWebMessageAsString(&mut message) }.is_err() {
            return;
        }
        // `message` was filled by `TryGetWebMessageAsString`, which succeeded, with a
        // NUL-terminated string allocated for us; read up to its NUL and freed.
        let message = take_pwstr(message);
        if !is_file_drop_message(&message) {
            // The page's own message (the bridge's), handed over inside this event, as the
            // C++ fork's `on_message` receives it.
            let handler = self.page_message_handler.borrow().clone();
            if let Some(handler) = handler {
                handler(&message);
            }
            return;
        }
        if self.file_drop_handler.borrow().is_none() {
            return;
        }
        // The paths are read here, while the event args are valid; the handler
        // runs later from `drain`, after this event has returned.
        let paths = read_dropped_paths(args);
        if !paths.is_empty() {
            let _ = self.shared.dispatch(Job::FileDrop(paths));
        }
    }

    fn deliver_file_drop(&self, paths: Vec<String>) {
        // Read again now, so a handler cleared in between is never called.
        let handler = self.file_drop_handler.borrow().clone();
        if let Some(handler) = handler {
            if !paths.is_empty() {
                let _ = catch_unwind(AssertUnwindSafe(|| handler(paths)));
            }
        }
    }

    /// A new top-level document is loading: its drop script starts disabled.
    fn on_content_loading(&self, args: &ICoreWebView2ContentLoadingEventArgs) {
        if self.file_drop_enabled.get() {
            let _ = self.execute_script(&file_drop_flag_script(true));
        }
        let mut id = 0u64;
        // SAFETY: `args` is the event's arguments, held by WebView2 for this call; `id` is a
        // local u64 for the call to fill.
        if unsafe { args.NavigationId(&mut id) }.is_ok() {
            self.navigation_arrived(id, false);
        }
    }

    // ---- keys and navigation ------------------------------------------------

    fn on_accelerator_key_pressed(&self, args: &ICoreWebView2AcceleratorKeyPressedEventArgs) {
        let Some(handler) = self.accelerator_handler.borrow().clone() else { return };
        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
        // SAFETY: `kind` is a local for the call to fill.
        if unsafe { args.KeyEventKind(&mut kind) }.is_err() {
            return;
        }
        if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
            return;
        }
        let mut virtual_key = 0u32;
        // SAFETY: `virtual_key` is a local u32 for the call to fill.
        if unsafe { args.VirtualKey(&mut virtual_key) }.is_err() {
            return;
        }
        let key = KeyData { virtual_key, control: key_down(VK_CONTROL), shift: key_down(VK_SHIFT), alt: key_down(VK_MENU) };
        if catch_unwind(AssertUnwindSafe(|| handler(key))).unwrap_or(false) {
            // SAFETY: `args` is the live event args WebView2 passed to this handler.
            let _ = unsafe { args.SetHandled(true) };
        }
    }

    fn on_navigation_starting(&self, args: &ICoreWebView2NavigationStartingEventArgs) {
        let mut id = 0u64;
        // SAFETY: `id` is a local u64 for the call to fill.
        if unsafe { args.NavigationId(&mut id) }.is_err() {
            return;
        }
        let mut uri = PWSTR::null();
        // SAFETY: `uri` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        let url = match unsafe { args.Uri(&mut uri) } {
            // Filled by `NavigationStartingEventArgs::Uri` on success with a NUL-terminated
            // string allocated for us; read up to its NUL and freed.
            Ok(()) => take_pwstr(uri),
            Err(_) => String::new(),
        };
        let mut navigations = self.navigations.borrow_mut();
        navigations.latest = Some(id);
        // A redirect starts again under the same id: keep its latest address.
        navigations.urls.insert(id, url);
        navigations.epochs.insert(id, self.host_epoch.get());
        drop(navigations);
        self.gate.borrow_mut().started(id);
    }

    /// Navigation `id` has its document (`ContentLoading`) or has ended
    /// (`NavigationCompleted`, `cancelled` when another navigation cut it off).
    fn navigation_arrived(&self, id: u64, cancelled: bool) {
        let opened = self.gate.borrow_mut().arrived(id, cancelled);
        if opened {
            let handler = self.navigation_started.borrow().clone();
            if let Some(handler) = handler {
                handler();
            }
        }
    }

    fn on_navigation_completed(self: &Rc<Self>, args: &ICoreWebView2NavigationCompletedEventArgs) {
        let mut id = 0u64;
        // SAFETY: `id` is a local u64 for the call to fill.
        if unsafe { args.NavigationId(&mut id) }.is_err() {
            return;
        }
        let mut succeeded = BOOL(0);
        let mut why = COREWEBVIEW2_WEB_ERROR_STATUS::default();
        // SAFETY: `succeeded` and `why` are locals for the calls to fill.
        let cancelled = unsafe { args.IsSuccess(&mut succeeded) }.is_ok()
            && !succeeded.as_bool()
            // SAFETY: as above.
            && unsafe { args.WebErrorStatus(&mut why) }.is_ok()
            && why == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED;
        self.navigation_arrived(id, cancelled);
        let (started, epoch) = {
            let mut navigations = self.navigations.borrow_mut();
            (navigations.urls.remove(&id), navigations.epochs.remove(&id).unwrap_or(0))
        };
        let weak = Rc::downgrade(self);
        // Current until a newer navigation starts, and only while the host has
        // not asked for another navigation since this one started.
        let is_current: Rc<dyn Fn() -> bool> = Rc::new(move || {
            weak.upgrade().is_some_and(|inner| {
                inner.navigations.borrow().latest.unwrap_or(id) == id && inner.host_epoch.get() == epoch
            })
        });
        if !is_current() {
            return;
        }
        let Some(handler) = self.navigation_failed_handler.borrow().clone() else { return };
        let mut success = BOOL(0);
        // SAFETY: `success` is a local BOOL for the call to fill.
        if unsafe { args.IsSuccess(&mut success) }.is_err() || success.as_bool() {
            return;
        }
        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
        // SAFETY: `status` is a local for the call to fill.
        if unsafe { args.WebErrorStatus(&mut status) }.is_err() {
            return;
        }
        let http_status = args.cast::<ICoreWebView2NavigationCompletedEventArgs2>().ok().and_then(|args2| {
            let mut code = 0i32;
            // SAFETY: `code` is a local i32 for the call to fill.
            unsafe { args2.HttpStatusCode(&mut code) }.ok().map(|()| code)
        });
        let url = match started.filter(|u| !u.is_empty()) {
            Some(url) => url,
            None => {
                let mut source = PWSTR::null();
                // SAFETY: `source` is a local PWSTR for the call to fill; freed by `take_pwstr`.
                match unsafe { self.webview.Source(&mut source) } {
                    // Filled by `Source` on success with a NUL-terminated string allocated
                    // for us; read up to its NUL and freed.
                    Ok(()) => take_pwstr(source),
                    Err(_) => String::new(),
                }
            }
        };
        if let Some(reason) = failure_reason(status.0, http_status, &url) {
            let failure = NavigationFailure::new(url, reason.to_string(), is_current);
            let _ = catch_unwind(AssertUnwindSafe(|| handler(failure)));
        }
    }
}

/// Sets the response of a request: every response this crate sets goes through here.
fn set_response(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    response: &ICoreWebView2WebResourceResponse,
) -> windows::core::Result<()> {
    // SAFETY: `args` is the live event args of a request this webview holds (in the
    // handler, or kept with its deferral), and `response` a live response its environment made.
    unsafe { args.SetResponse(response) }
}

/// The request headers as the request handler receives them.
fn read_request_headers_json(request: &ICoreWebView2WebResourceRequest) -> String {
    let mut headers = Vec::new();
    // SAFETY: `request` is a `&ICoreWebView2WebResourceRequest`, a borrowed COM reference
    // alive for this whole function by its lifetime; no pointer is passed.
    let iterator = unsafe { request.Headers() }.and_then(|collection| {
        // SAFETY: `collection` is the COM reference `Headers` just returned, owned by this closure.
        unsafe { collection.GetIterator() }
    });
    if let Ok(iterator) = iterator {
        let mut has = BOOL(0);
        // SAFETY: `has` is a local BOOL for the call to fill.
        if unsafe { iterator.HasCurrentHeader(&mut has) }.is_err() {
            has = BOOL(0);
        }
        while has.as_bool() {
            let (mut name, mut value) = (PWSTR::null(), PWSTR::null());
            // SAFETY: `name` and `value` are local PWSTRs for the call to fill;
            // both are freed by `take_pwstr`.
            if unsafe { iterator.GetCurrentHeader(&mut name, &mut value) }.is_ok() {
                // Both filled by `GetCurrentHeader`, which succeeded, with NUL-terminated
                // strings allocated for us; each is read up to its NUL and freed.
                headers.push((take_pwstr(name), take_pwstr(value)));
            }
            // SAFETY: `has` is a local BOOL for the call to fill.
            if unsafe { iterator.MoveNext(&mut has) }.is_err() {
                break;
            }
        }
    }
    headers_to_json(&headers)
}

/// The whole request body, or `None` when the stream fails, so the handler
/// never sees a body cut short.
fn read_request_body(request: &ICoreWebView2WebResourceRequest) -> Option<Vec<u8>> {
    // SAFETY: `request` is a `&ICoreWebView2WebResourceRequest`, a borrowed COM reference
    // alive for this whole function by its lifetime; no pointer is passed.
    let content = match unsafe { request.Content() } {
        Ok(content) => content,
        Err(e) if e.code().is_ok() => return Some(Vec::new()), // no body
        Err(_) => return None,
    };
    // A stream that cannot seek is read from where it stands.
    // SAFETY: `content` is the live body stream just returned; no position is asked for.
    if let Err(e) = unsafe { content.Seek(0, STREAM_SEEK_SET, None) } {
        if e.code() != E_NOTIMPL && e.code() != STG_E_INVALIDFUNCTION {
            return None;
        }
    }
    let mut body = Vec::new();
    let mut buf = vec![0u8; 16384];
    loop {
        let mut read = 0u32;
        let hr = istream::read_into(&content, &mut buf, &mut read);
        if hr.is_err() {
            return None;
        }
        body.extend_from_slice(&buf[..(read as usize).min(buf.len())]);
        if hr != windows::Win32::Foundation::S_OK || read == 0 {
            return Some(body);
        }
    }
}

/// The real paths of the `File` objects the drop script attached.
fn read_dropped_paths(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Vec<String> {
    let mut paths = Vec::new();
    // A runtime too old to attach objects has no ICoreWebView2WebMessageReceivedEventArgs2.
    let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else { return paths };
    // SAFETY: `args2` is a COM reference this frame holds (from `cast`) to the event args,
    // which WebView2 keeps valid while the handler runs.
    let Ok(objects) = (unsafe { args2.AdditionalObjects() }) else { return paths };
    let mut count = 0u32;
    // SAFETY: `count` is a local u32 for the call to fill.
    if unsafe { objects.Count(&mut count) }.is_err() {
        return paths;
    }
    for index in 0..count {
        // SAFETY: `objects` is the COM reference `AdditionalObjects` returned, and `index` is
        // below the count it just reported; a bad index would be an error result.
        let Ok(item) = (unsafe { objects.GetValueAtIndex(index) }) else { continue };
        // Anything but a file from the operating system is skipped.
        let Ok(file) = item.cast::<ICoreWebView2File>() else { continue };
        let mut path = PWSTR::null();
        // SAFETY: `path` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        if unsafe { file.Path(&mut path) }.is_err() {
            continue;
        }
        // `path` was filled by `ICoreWebView2File::Path`, which succeeded, with a
        // NUL-terminated string allocated for us; read up to its NUL and freed.
        let path = take_pwstr(path);
        if !path.is_empty() {
            paths.push(path);
        }
    }
    paths
}
