//! Windows: everything added to `wry`'s WebView2 through
//! `WebViewExtWindows::controller()`, `webview()` and `environment()`.
//! Ported from the C++ fork's `win32_edge.hh` and the tabs library's
//! `win-webview2.ts`.

mod environment;
mod handlers;
mod istream;
mod pump;

pub use self::environment::{create_environment, default_user_data_folder};

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
use wry::WebViewExtWindows;

use self::handlers::{
    AcceleratorKeyPressed, ContentLoading, MessageReceived, NavigationCompleted, NavigationStarting, Registration,
    ResourceRequested, ScriptAdded,
};
use self::istream::StreamingIStream;
use self::pump::{pump_while, OnQuit};
use crate::shared::{next_request_id, Job, Responder, Shared};
use crate::stream::StreamState;
use crate::{
    failure_reason, file_drop_flag_script, ExtrasOptions, KeyData, NavigationFailure, RawRequest, FILE_DROP_MESSAGE_JSON,
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
    navigations: RefCell<Navigations>,
    host_epoch: Cell<u64>,
    registrations: RefCell<Vec<Registration>>,
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
    done: Cell<bool>,
}

/// Everything added to one webview. Not `Send`, not `Sync`.
///
/// Dropping it unregisters every handler it registered, aborts open streams,
/// closes the WebView2 controller, and releases open requests unanswered (the
/// teardown order of `requests.md`), so it is dropped as part of dropping the
/// webview, right before the `wry::WebView`.
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
    /// drop script and its message handler, and the accelerator key and
    /// navigation handlers to `webview`. Call it before the webview's first
    /// navigation, so the first document is served and gets the drop script.
    pub fn attach(webview: &wry::WebView, options: ExtrasOptions) -> Result<Self, ErrorCode> {
        let inner = Rc::new(Inner {
            shared: Shared::new(options.wake_ui),
            controller: webview.controller(),
            webview: webview.webview(),
            env: webview.environment(),
            assets: RefCell::new(AssetTable::new()),
            request_handler: RefCell::new(None),
            pending: RefCell::new(HashMap::new()),
            file_drop_handler: RefCell::new(None),
            file_drop_enabled: Cell::new(false),
            accelerator_handler: RefCell::new(None),
            navigation_failed_handler: RefCell::new(None),
            navigations: RefCell::new(Navigations::default()),
            host_epoch: Cell::new(0),
            registrations: RefCell::new(Vec::new()),
        });
        // On failure `inner` drops here, and with it every registration made so far.
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
    /// Returns once WebView2 has registered the script, pumping this thread's
    /// messages meanwhile as the C++ fork's `add_user_script_impl` does, so a
    /// navigation right after it gets the script. Every callback the thread
    /// serves can run inside that pump. As in the C++, a script WebView2
    /// refuses still comes back (with no id; removing it does nothing), and a
    /// `WM_QUIT` seen while waiting is posted again and ends the wait early; an
    /// id that arrives after that is still recorded.
    pub fn add_user_script(&self, source: &str) -> Result<UserScript, ErrorCode> {
        let state = Rc::new(ScriptState::default());
        let weak = Rc::downgrade(&self.inner);
        let pending = state.clone();
        let handler = ScriptAdded::create(move |id| {
            pending.done.set(true);
            let Some(id) = id else { return };
            if pending.removed.get() {
                if let Some(inner) = weak.upgrade() {
                    inner.remove_script_id(&id);
                }
            } else {
                *pending.id.borrow_mut() = Some(id);
            }
        });
        // SAFETY: the script text is an owned HSTRING for the call and `handler` is
        // a live COM object; WebView2 holds its own reference until it completes.
        let added = unsafe { self.inner.webview.AddScriptToExecuteOnDocumentCreated(&hstring(source), &handler) };
        drop(handler);
        if added.is_ok() {
            pump_while(|| !state.done.get(), OnQuit::Repost);
        }
        Ok(UserScript { state })
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

    /// `ICoreWebView2Controller2::DefaultBackgroundColor`. WebView2 takes only
    /// an alpha of 0 or 255; any other alpha, or a runtime without the
    /// interface, is [`ErrorCode::Unspecified`].
    pub fn set_background_color(&self, r: u8, g: u8, b: u8, a: u8) -> ErrorCode {
        let Ok(controller2) = self.inner.controller.cast::<ICoreWebView2Controller2>() else {
            return ErrorCode::Unspecified;
        };
        let color = COREWEBVIEW2_COLOR { R: r, G: g, B: b, A: a };
        // SAFETY: `controller2` is a live interface of this webview's controller,
        // and the colour is passed by value.
        match unsafe { controller2.SetDefaultBackgroundColor(color) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
    }

    /// `ICoreWebView2Controller4::AllowExternalDrop`: whether content dragged
    /// from outside the app can be dropped on the page. Drags inside the page
    /// work either way. [`ErrorCode::Unspecified`] without the interface.
    pub fn set_allow_external_drop(&self, allow: bool) -> ErrorCode {
        let Ok(controller4) = self.inner.controller.cast::<ICoreWebView2Controller4>() else {
            return ErrorCode::Unspecified;
        };
        // SAFETY: `controller4` is a live interface of this webview's controller.
        match unsafe { controller4.SetAllowExternalDrop(allow) } {
            Ok(()) => ErrorCode::Ok,
            Err(_) => ErrorCode::Unspecified,
        }
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

    /// Records that the host is about to navigate (`load_url`, `load_html`):
    /// a failure of a navigation started before this is no longer current.
    pub fn note_host_navigation(&self) {
        self.inner.host_epoch.set(self.inner.host_epoch.get() + 1);
    }

    /// Gives the page keyboard focus (`MoveFocus`, programmatic).
    pub fn move_focus(&self) {
        // SAFETY: `controller` is this webview's live controller; the reason is a
        // plain enum value.
        let _ = unsafe { self.inner.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
    }

    /// Tells WebView2 its window moved, so popups (select lists, tooltips)
    /// follow it.
    pub fn notify_parent_window_position_changed(&self) {
        // SAFETY: `controller` is this webview's live controller.
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
        // never send its request to the network. `wry`'s own drop closes it again,
        // which does nothing.
        // SAFETY: `controller` is this webview's live controller.
        let _ = unsafe { inner.controller.Close() };
        drop(inner.pending.take());
        drop(inner.registrations.take());
        // The application's handlers may hold anything, a Responder included.
        drop(inner.request_handler.take());
        drop(inner.file_drop_handler.take());
        drop(inner.accelerator_handler.take());
        drop(inner.navigation_failed_handler.take());
    }
}

impl Inner {
    fn register(self: &Rc<Self>) -> windows::core::Result<()> {
        // Every request to either origin reaches the handler. Where the runtime
        // has ICoreWebView2_22 the filters take every request source kind, so
        // they also catch service workers, shared workers and cross-origin
        // iframes; an older runtime falls back to the legacy filter.
        let webview22 = self.webview.cast::<ICoreWebView2_22>().ok();
        for origin in [WINDOWS_ASSET_ORIGIN, WINDOWS_FRAMES_ORIGIN] {
            let filter = hstring(&format!("{origin}/*"));
            match &webview22 {
                Some(webview22) => {
                    // SAFETY: `filter` is an owned HSTRING for the call; the kinds are
                    // plain enum values.
                    unsafe {
                        webview22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                            &filter,
                            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                        )
                    }?;
                }
                None => {
                    // SAFETY: `filter` is an owned HSTRING for the call.
                    unsafe { self.webview.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL) }?;
                }
            }
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
            &ContentLoading::create(move |_| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_content_loading();
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
        *self.registrations.borrow_mut() = registrations;

        // The drop script is the same in every document and starts disabled.
        let handler: Option<&ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler> = None;
        // SAFETY: the script is an owned HSTRING for the call; no completion handler.
        unsafe { self.webview.AddScriptToExecuteOnDocumentCreated(&hstring(FILE_DROP_SCRIPT), handler) }
    }

    fn execute_script(&self, script: &str) -> windows::core::Result<()> {
        let handler: Option<&ICoreWebView2ExecuteScriptCompletedHandler> = None;
        // SAFETY: the script is an owned HSTRING for the call; no completion handler.
        unsafe { self.webview.ExecuteScript(&hstring(script), handler) }
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
        let none: Option<&IStream> = None;
        // SAFETY: the strings are owned HSTRINGs for the call; no body stream.
        let response = unsafe {
            self.env.CreateWebResourceResponse(none, 500, &hstring("Internal Server Error"), &hstring("Content-Type: text/plain"))
        }
        // SAFETY: as above, with empty strings.
        .or_else(|_| unsafe { self.env.CreateWebResourceResponse(none, 500, &HSTRING::new(), &HSTRING::new()) });
        match response {
            // SAFETY: `args` is live event args held by this webview, and `response` a
            // live response made by its environment.
            Ok(response) => unsafe { args.SetResponse(&response) }.is_ok(),
            Err(_) => false,
        }
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
        // SAFETY: the strings are owned HSTRINGs for the call and `stream`, when
        // present, a live IStream this function owns.
        let response = unsafe {
            self.env.CreateWebResourceResponse(stream.as_ref(), status, &hstring(reason_phrase(status)), &hstring(headers))
        }?;
        // SAFETY: `args` is live event args held by this webview, and `response` a
        // live response made by its environment.
        unsafe { args.SetResponse(&response) }
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
            // SAFETY: `deferral` is the live deferral of this request, completed once.
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
        // SAFETY: the strings are owned HSTRINGs for the call and `body` a live
        // IStream this function holds a reference to.
        let response = unsafe {
            self.env.CreateWebResourceResponse(&body, status, &hstring(reason_phrase(status)), &hstring(&header_lines(headers)))
        };
        drop(body);
        let set = response.and_then(|response| {
            // SAFETY: `args` is live event args held by this webview, and `response`
            // a live response made by its environment.
            unsafe { args.SetResponse(&response) }
        });
        if set.is_err() {
            self.shared.drop_stream(id, stream);
            if !self.put_fail_closed_response(&args) {
                return; // left deferred; teardown releases it
            }
        }
        self.complete_and_erase(id);
    }

    // ---- file drops -----------------------------------------------------------

    fn on_web_message_received(self: &Rc<Self>, args: &ICoreWebView2WebMessageReceivedEventArgs) {
        let mut json = PWSTR::null();
        // SAFETY: `json` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        if unsafe { args.WebMessageAsJson(&mut json) }.is_err() {
            return;
        }
        let json = take_pwstr(json);
        eprintln!("DBG web message {json:?}");
        if json != FILE_DROP_MESSAGE_JSON || self.file_drop_handler.borrow().is_none() {
            return;
        }
        // The paths are read here, while the event args are valid; the handler
        // runs later from `drain`, after this event has returned.
        let paths = read_dropped_paths(args);
        eprintln!("DBG paths {paths:?}");
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
    fn on_content_loading(&self) {
        if self.file_drop_enabled.get() {
            let _ = self.execute_script(&file_drop_flag_script(true));
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
            Ok(()) => take_pwstr(uri),
            Err(_) => String::new(),
        };
        let mut navigations = self.navigations.borrow_mut();
        navigations.latest = Some(id);
        // A redirect starts again under the same id: keep its latest address.
        navigations.urls.insert(id, url);
        navigations.epochs.insert(id, self.host_epoch.get());
    }

    fn on_navigation_completed(self: &Rc<Self>, args: &ICoreWebView2NavigationCompletedEventArgs) {
        let mut id = 0u64;
        // SAFETY: `id` is a local u64 for the call to fill.
        if unsafe { args.NavigationId(&mut id) }.is_err() {
            return;
        }
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

/// The request headers as the request handler receives them.
fn read_request_headers_json(request: &ICoreWebView2WebResourceRequest) -> String {
    let mut headers = Vec::new();
    // SAFETY: `request` is a live request of the event being handled.
    let iterator = unsafe { request.Headers() }.and_then(|collection| {
        // SAFETY: `collection` is the live header collection just returned.
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
    // SAFETY: `request` is a live request of the event being handled.
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
        // SAFETY: `buf` is an owned buffer of `buf.len()` bytes for the whole call,
        // and `read` a local u32 for the call to fill.
        let hr = unsafe { content.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read)) };
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
    // SAFETY: `args2` is a live interface of the event args being handled.
    let Ok(objects) = (unsafe { args2.AdditionalObjects() }) else { return paths };
    let mut count = 0u32;
    // SAFETY: `count` is a local u32 for the call to fill.
    if unsafe { objects.Count(&mut count) }.is_err() {
        return paths;
    }
    for index in 0..count {
        // SAFETY: `index` is below the count the collection just reported.
        let Ok(item) = (unsafe { objects.GetValueAtIndex(index) }) else { continue };
        // Anything but a file from the operating system is skipped.
        let Ok(file) = item.cast::<ICoreWebView2File>() else { continue };
        let mut path = PWSTR::null();
        // SAFETY: `path` is a local PWSTR for the call to fill; freed by `take_pwstr`.
        if unsafe { file.Path(&mut path) }.is_err() {
            continue;
        }
        let path = take_pwstr(path);
        if !path.is_empty() {
            paths.push(path);
        }
    }
    paths
}
