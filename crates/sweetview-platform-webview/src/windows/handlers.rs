//! The WebView2 event handler objects this crate registers, and the owning
//! type that unregisters each one.
//!
//! Each handler is a COM object made with `#[implement]` over the typed
//! interface `webview2-com` declares. They hold a `Fn` (not the `FnMut` behind
//! an `UnsafeCell` that `webview2-com`'s own generated handlers hold), so a
//! handler re-entered from a nested message loop inside an application's
//! callback is still sound. Every `Invoke` runs its body inside
//! `catch_unwind`: nothing unwinds into WebView2, and a body that panicked
//! returns `E_UNEXPECTED` to WebView2 instead of `S_OK`.
//!
//! The objects are declared `Agile = false`: they hold `Rc` and `Weak` values
//! of the UI thread, and WebView2 calls and releases them on the thread that
//! registered them. Answers from other threads reach the UI thread through the
//! `Responder`'s queue, never through these objects.

use std::panic::{catch_unwind, AssertUnwindSafe};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{implement, Interface, Ref, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::E_UNEXPECTED;

/// Runs `f`, turning a panic into `E_UNEXPECTED`: the callers are OS callbacks,
/// which must not unwind and must not report success for a body that did not finish.
pub(super) fn guarded(f: impl FnOnce()) -> windows::core::Result<()> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|_| E_UNEXPECTED.into())
}

/// Hands `args` to an event handler's closure. An `Invoke` with no arguments does
/// nothing and succeeds; a closure that panicked is `E_UNEXPECTED`. Every event
/// handler below is this call and nothing else.
fn invoke_with<T: windows::core::Type<T>>(args: Ref<T>, f: impl FnOnce(&T)) -> windows::core::Result<()> {
    match args.as_ref() {
        Some(args) => guarded(|| f(args)),
        None => Ok(()),
    }
}

#[implement(ICoreWebView2WebResourceRequestedEventHandler, Agile = false)]
pub(super) struct ResourceRequested(Box<dyn Fn(&ICoreWebView2WebResourceRequestedEventArgs)>);

impl ResourceRequested {
    pub(super) fn create(f: impl Fn(&ICoreWebView2WebResourceRequestedEventArgs) + 'static) -> ICoreWebView2WebResourceRequestedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2WebResourceRequestedEventHandler_Impl for ResourceRequested_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2WebResourceRequestedEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

#[implement(ICoreWebView2WebMessageReceivedEventHandler, Agile = false)]
pub(super) struct MessageReceived(Box<dyn Fn(&ICoreWebView2WebMessageReceivedEventArgs)>);

impl MessageReceived {
    pub(super) fn create(f: impl Fn(&ICoreWebView2WebMessageReceivedEventArgs) + 'static) -> ICoreWebView2WebMessageReceivedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2WebMessageReceivedEventHandler_Impl for MessageReceived_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2WebMessageReceivedEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

#[implement(ICoreWebView2ContentLoadingEventHandler, Agile = false)]
pub(super) struct ContentLoading(Box<dyn Fn(&ICoreWebView2ContentLoadingEventArgs)>);

impl ContentLoading {
    pub(super) fn create(f: impl Fn(&ICoreWebView2ContentLoadingEventArgs) + 'static) -> ICoreWebView2ContentLoadingEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2ContentLoadingEventHandler_Impl for ContentLoading_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2ContentLoadingEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

#[implement(ICoreWebView2NavigationStartingEventHandler, Agile = false)]
pub(super) struct NavigationStarting(Box<dyn Fn(&ICoreWebView2NavigationStartingEventArgs)>);

impl NavigationStarting {
    pub(super) fn create(f: impl Fn(&ICoreWebView2NavigationStartingEventArgs) + 'static) -> ICoreWebView2NavigationStartingEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2NavigationStartingEventHandler_Impl for NavigationStarting_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2NavigationStartingEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

#[implement(ICoreWebView2NavigationCompletedEventHandler, Agile = false)]
pub(super) struct NavigationCompleted(Box<dyn Fn(&ICoreWebView2NavigationCompletedEventArgs)>);

impl NavigationCompleted {
    pub(super) fn create(f: impl Fn(&ICoreWebView2NavigationCompletedEventArgs) + 'static) -> ICoreWebView2NavigationCompletedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2NavigationCompletedEventHandler_Impl for NavigationCompleted_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2NavigationCompletedEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

#[implement(ICoreWebView2AcceleratorKeyPressedEventHandler, Agile = false)]
pub(super) struct AcceleratorKeyPressed(Box<dyn Fn(&ICoreWebView2AcceleratorKeyPressedEventArgs)>);

impl AcceleratorKeyPressed {
    pub(super) fn create(f: impl Fn(&ICoreWebView2AcceleratorKeyPressedEventArgs) + 'static) -> ICoreWebView2AcceleratorKeyPressedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2AcceleratorKeyPressedEventHandler_Impl for AcceleratorKeyPressed_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2Controller>, args: Ref<ICoreWebView2AcceleratorKeyPressedEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

#[implement(ICoreWebView2PermissionRequestedEventHandler, Agile = false)]
pub(super) struct PermissionRequested(Box<dyn Fn(&ICoreWebView2PermissionRequestedEventArgs)>);

impl PermissionRequested {
    pub(super) fn create(f: impl Fn(&ICoreWebView2PermissionRequestedEventArgs) + 'static) -> ICoreWebView2PermissionRequestedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2PermissionRequestedEventHandler_Impl for PermissionRequested_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2PermissionRequestedEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

#[implement(ICoreWebView2NewWindowRequestedEventHandler, Agile = false)]
pub(super) struct NewWindowRequested(Box<dyn Fn(&ICoreWebView2NewWindowRequestedEventArgs)>);

impl NewWindowRequested {
    pub(super) fn create(f: impl Fn(&ICoreWebView2NewWindowRequestedEventArgs) + 'static) -> ICoreWebView2NewWindowRequestedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2NewWindowRequestedEventHandler_Impl for NewWindowRequested_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2NewWindowRequestedEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

/// For the tests' read-back only (`test_support`): this crate registers no
/// download handler, as the C++ fork registered none.
#[cfg(any(test, feature = "test-support"))]
#[implement(ICoreWebView2DownloadStartingEventHandler, Agile = false)]
pub(super) struct DownloadStarting(Box<dyn Fn(&ICoreWebView2DownloadStartingEventArgs)>);

#[cfg(any(test, feature = "test-support"))]
impl DownloadStarting {
    pub(super) fn create(f: impl Fn(&ICoreWebView2DownloadStartingEventArgs) + 'static) -> ICoreWebView2DownloadStartingEventHandler {
        Self(Box::new(f)).into()
    }
}

#[cfg(any(test, feature = "test-support"))]
impl ICoreWebView2DownloadStartingEventHandler_Impl for DownloadStarting_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2DownloadStartingEventArgs>) -> windows::core::Result<()> {
        invoke_with(args, |args| (self.0)(args))
    }
}

/// The completion of `AddScriptToExecuteOnDocumentCreated`: the script's id,
/// or `None` when WebView2 refused the script.
#[implement(ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, Agile = false)]
pub(super) struct ScriptAdded(Box<dyn Fn(Option<String>)>);

impl ScriptAdded {
    pub(super) fn create(f: impl Fn(Option<String>) + 'static) -> ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler_Impl for ScriptAdded_Impl {
    fn Invoke(&self, errorcode: HRESULT, result: &PCWSTR) -> windows::core::Result<()> {
        guarded(|| {
            // `result` was filled by WebView2 for this completion: on success a
            // NUL-terminated id string it owns until `Invoke` returns, which
            // `string_from_pcwstr` reads up to its NUL (null reads as empty).
            let id = errorcode.is_ok().then(|| webview2_com::string_from_pcwstr(result));
            (self.0)(id.filter(|id| !id.is_empty()));
        })
    }
}

/// One web-resource filter added to a webview: requests to `uri` reach the
/// `WebResourceRequested` handlers. Holds a reference to the object it was
/// added to and removes the filter there when dropped, so a filter never
/// outlives the extras that answer it (and is gone if a later registration of
/// theirs fails). Where the runtime has `ICoreWebView2_22` the filter takes
/// every request source kind, so it also catches service workers, shared
/// workers and cross-origin iframes; an older runtime gets the legacy filter.
pub(super) enum RequestFilter {
    WithSourceKinds { webview: ICoreWebView2_22, uri: HSTRING },
    Legacy { webview: ICoreWebView2, uri: HSTRING },
}

impl RequestFilter {
    pub(super) fn add(webview: &ICoreWebView2, uri: &str) -> windows::core::Result<Self> {
        let uri = HSTRING::from(uri);
        match webview.cast::<ICoreWebView2_22>() {
            Ok(webview22) => {
                // SAFETY: `webview22` is a COM reference this frame holds (from `cast`); `uri`
                // is an owned HSTRING for the call; the kinds are plain enum values.
                unsafe {
                    webview22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                        &uri,
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                    )
                }?;
                Ok(Self::WithSourceKinds { webview: webview22, uri })
            }
            Err(_) => {
                // SAFETY: `webview` is a COM reference the extras hold (from `wry`); `uri` is
                // an owned HSTRING for the call.
                unsafe { webview.AddWebResourceRequestedFilter(&uri, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL) }?;
                Ok(Self::Legacy { webview: webview.clone(), uri })
            }
        }
    }
}

impl Drop for RequestFilter {
    fn drop(&mut self) {
        // Each call removes the filter its own `add` added, with the same arguments, on
        // the object this value holds a reference to. A failure (the webview already
        // closed) leaves nothing to undo: WebView2 drops its filters on close.
        let _ = match self {
            // SAFETY: `webview` and `uri` are the ones `add` used; `uri` is owned by this value.
            Self::WithSourceKinds { webview, uri } => unsafe {
                webview.RemoveWebResourceRequestedFilterWithRequestSourceKinds(
                    &*uri,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )
            },
            // SAFETY: `webview` and `uri` are the ones `add` used; `uri` is owned by this value.
            Self::Legacy { webview, uri } => unsafe {
                webview.RemoveWebResourceRequestedFilter(&*uri, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            },
        };
    }
}

/// Which event a [`Registration`] is for, with the object it was added to.
pub(super) enum Source {
    WebResourceRequested(ICoreWebView2),
    WebMessageReceived(ICoreWebView2),
    ContentLoading(ICoreWebView2),
    NavigationStarting(ICoreWebView2),
    NavigationCompleted(ICoreWebView2),
    AcceleratorKeyPressed(ICoreWebView2Controller),
    PermissionRequested(ICoreWebView2),
    NewWindowRequested(ICoreWebView2),
    #[cfg(any(test, feature = "test-support"))]
    DownloadStarting(ICoreWebView2_4),
}

/// One handler added with an `add_*` call. Holds a reference to the object it
/// was added to, and removes the handler with the matching `remove_*` call
/// when dropped, so removal never depends on another object staying alive.
pub(super) struct Registration {
    source: Source,
    token: i64,
}

impl Registration {
    /// Adds `handler` for the event of `source`.
    pub(super) fn add_web_resource_requested(
        webview: &ICoreWebView2,
        handler: &ICoreWebView2WebResourceRequestedEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: `handler` is a live COM object this crate made and `token` is a
        // local i64 for the call to fill; WebView2 takes its own reference to the
        // handler until `remove_WebResourceRequested` in this type's `Drop`.
        unsafe { webview.add_WebResourceRequested(handler, &mut token) }?;
        Ok(Self { source: Source::WebResourceRequested(webview.clone()), token })
    }

    pub(super) fn add_web_message_received(
        webview: &ICoreWebView2,
        handler: &ICoreWebView2WebMessageReceivedEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: as in `add_web_resource_requested`: a live handler and a local
        // token; removed in `Drop`.
        unsafe { webview.add_WebMessageReceived(handler, &mut token) }?;
        Ok(Self { source: Source::WebMessageReceived(webview.clone()), token })
    }

    pub(super) fn add_content_loading(
        webview: &ICoreWebView2,
        handler: &ICoreWebView2ContentLoadingEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: a live handler and a local token; removed in `Drop`.
        unsafe { webview.add_ContentLoading(handler, &mut token) }?;
        Ok(Self { source: Source::ContentLoading(webview.clone()), token })
    }

    pub(super) fn add_navigation_starting(
        webview: &ICoreWebView2,
        handler: &ICoreWebView2NavigationStartingEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: a live handler and a local token; removed in `Drop`.
        unsafe { webview.add_NavigationStarting(handler, &mut token) }?;
        Ok(Self { source: Source::NavigationStarting(webview.clone()), token })
    }

    pub(super) fn add_navigation_completed(
        webview: &ICoreWebView2,
        handler: &ICoreWebView2NavigationCompletedEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: a live handler and a local token; removed in `Drop`.
        unsafe { webview.add_NavigationCompleted(handler, &mut token) }?;
        Ok(Self { source: Source::NavigationCompleted(webview.clone()), token })
    }

    pub(super) fn add_accelerator_key_pressed(
        controller: &ICoreWebView2Controller,
        handler: &ICoreWebView2AcceleratorKeyPressedEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: a live handler and a local token; removed in `Drop`.
        unsafe { controller.add_AcceleratorKeyPressed(handler, &mut token) }?;
        Ok(Self { source: Source::AcceleratorKeyPressed(controller.clone()), token })
    }

    pub(super) fn add_permission_requested(
        webview: &ICoreWebView2,
        handler: &ICoreWebView2PermissionRequestedEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: a live handler and a local token; removed in `Drop`.
        unsafe { webview.add_PermissionRequested(handler, &mut token) }?;
        Ok(Self { source: Source::PermissionRequested(webview.clone()), token })
    }

    pub(super) fn add_new_window_requested(
        webview: &ICoreWebView2,
        handler: &ICoreWebView2NewWindowRequestedEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: a live handler and a local token; removed in `Drop`.
        unsafe { webview.add_NewWindowRequested(handler, &mut token) }?;
        Ok(Self { source: Source::NewWindowRequested(webview.clone()), token })
    }

    /// Adds `handler` for `DownloadStarting` (`ICoreWebView2_4`, WebView2 Runtime 92 or later).
    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn add_download_starting(
        webview: &ICoreWebView2_4,
        handler: &ICoreWebView2DownloadStartingEventHandler,
    ) -> windows::core::Result<Self> {
        let mut token = 0i64;
        // SAFETY: a live handler and a local token; removed in `Drop`.
        unsafe { webview.add_DownloadStarting(handler, &mut token) }?;
        Ok(Self { source: Source::DownloadStarting(webview.clone()), token })
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let token = self.token;
        // Each call passes the token its own `add_*` call returned, on the object
        // this registration holds a reference to. A failure (the webview already
        // closed) leaves nothing to undo: WebView2 drops its handlers on close.
        let _ = match &self.source {
            // SAFETY: `token` came from `add_WebResourceRequested` on this `webview`.
            Source::WebResourceRequested(webview) => unsafe { webview.remove_WebResourceRequested(token) },
            // SAFETY: `token` came from `add_WebMessageReceived` on this `webview`.
            Source::WebMessageReceived(webview) => unsafe { webview.remove_WebMessageReceived(token) },
            // SAFETY: `token` came from `add_ContentLoading` on this `webview`.
            Source::ContentLoading(webview) => unsafe { webview.remove_ContentLoading(token) },
            // SAFETY: `token` came from `add_NavigationStarting` on this `webview`.
            Source::NavigationStarting(webview) => unsafe { webview.remove_NavigationStarting(token) },
            // SAFETY: `token` came from `add_NavigationCompleted` on this `webview`.
            Source::NavigationCompleted(webview) => unsafe { webview.remove_NavigationCompleted(token) },
            // SAFETY: `token` came from `add_AcceleratorKeyPressed` on this `controller`.
            Source::AcceleratorKeyPressed(controller) => unsafe { controller.remove_AcceleratorKeyPressed(token) },
            // SAFETY: `token` came from `add_PermissionRequested` on this `webview`.
            Source::PermissionRequested(webview) => unsafe { webview.remove_PermissionRequested(token) },
            // SAFETY: `token` came from `add_NewWindowRequested` on this `webview`.
            Source::NewWindowRequested(webview) => unsafe { webview.remove_NewWindowRequested(token) },
            // SAFETY: `token` came from `add_DownloadStarting` on this `webview`.
            #[cfg(any(test, feature = "test-support"))]
            Source::DownloadStarting(webview) => unsafe { webview.remove_DownloadStarting(token) },
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::{ComObject, BOOL};
    use windows::Win32::Foundation::{E_FAIL, E_NOTIMPL};

    /// Event arguments that answer nothing: the handlers under test never read them.
    #[implement(ICoreWebView2ContentLoadingEventArgs)]
    struct NoArgs;

    impl ICoreWebView2ContentLoadingEventArgs_Impl for NoArgs_Impl {
        fn IsErrorPage(&self, _value: *mut BOOL) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn NavigationId(&self, _value: *mut u64) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }
    }

    // The six event handlers are each one `invoke_with` call; this drives one of them. A panic in the
    // application's closure is caught and reported to WebView2 as a failure.
    #[test]
    fn an_event_handler_that_panics_reports_failure_and_does_not_unwind() {
        let args: ICoreWebView2ContentLoadingEventArgs = NoArgs.into();
        let panicking = ComObject::new(ContentLoading(Box::new(|_| panic!("provoked by the test"))));
        let result = ICoreWebView2ContentLoadingEventHandler_Impl::Invoke(&*panicking, Ref::default(), Ref::from(&args));
        assert_eq!(result.map_err(|e| e.code()), Err(E_UNEXPECTED));

        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let counted = calls.clone();
        let calm = ComObject::new(ContentLoading(Box::new(move |_| counted.set(counted.get() + 1))));
        assert!(ICoreWebView2ContentLoadingEventHandler_Impl::Invoke(&*calm, Ref::default(), Ref::from(&args)).is_ok());
        assert_eq!(calls.get(), 1);
        // No arguments: nothing to hand on, and nothing failed.
        assert!(ICoreWebView2ContentLoadingEventHandler_Impl::Invoke(&*calm, Ref::default(), Ref::default()).is_ok());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn a_script_completion_that_panics_reports_failure_and_does_not_unwind() {
        let panicking = ComObject::new(ScriptAdded(Box::new(|_| panic!("provoked by the test"))));
        let result = ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler_Impl::Invoke(&*panicking, E_FAIL, &PCWSTR::null());
        assert_eq!(result.map_err(|e| e.code()), Err(E_UNEXPECTED));

        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let record = seen.clone();
        let calm = ComObject::new(ScriptAdded(Box::new(move |id| record.borrow_mut().push(id))));
        assert!(ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler_Impl::Invoke(&*calm, E_FAIL, &PCWSTR::null()).is_ok());
        assert_eq!(*seen.borrow(), vec![None]);
    }

    // F31: the handlers hold state of the UI thread, so they do not tell COM they may be
    // called from any thread (no IAgileObject, no free-threaded marshaler).
    #[test]
    fn the_handlers_are_not_agile() {
        let event: ICoreWebView2ContentLoadingEventHandler = ContentLoading::create(|_| {});
        assert!(event.cast::<windows_core::imp::IAgileObject>().is_err());
        assert!(event.cast::<windows_core::imp::IMarshal>().is_err());
        let accelerator: ICoreWebView2AcceleratorKeyPressedEventHandler = AcceleratorKeyPressed::create(|_| {});
        assert!(accelerator.cast::<windows_core::imp::IAgileObject>().is_err());
        let script = ScriptAdded::create(|_| {});
        assert!(script.cast::<windows_core::imp::IAgileObject>().is_err());
        // Every handler type this crate makes, by name (the second review's G11 found three
        // checked; the webview review found the later ones missing).
        let all: [(&str, windows_core::IUnknown); 10] = [
            ("ResourceRequested", ResourceRequested::create(|_| {}).cast().expect("IUnknown")),
            ("MessageReceived", MessageReceived::create(|_| {}).cast().expect("IUnknown")),
            ("ContentLoading", ContentLoading::create(|_| {}).cast().expect("IUnknown")),
            ("NavigationStarting", NavigationStarting::create(|_| {}).cast().expect("IUnknown")),
            ("NavigationCompleted", NavigationCompleted::create(|_| {}).cast().expect("IUnknown")),
            ("AcceleratorKeyPressed", AcceleratorKeyPressed::create(|_| {}).cast().expect("IUnknown")),
            ("ScriptAdded", ScriptAdded::create(|_| {}).cast().expect("IUnknown")),
            ("PermissionRequested", PermissionRequested::create(|_| {}).cast().expect("IUnknown")),
            ("NewWindowRequested", NewWindowRequested::create(|_| {}).cast().expect("IUnknown")),
            ("DownloadStarting", DownloadStarting::create(|_| {}).cast().expect("IUnknown")),
        ];
        for (name, handler) in &all {
            assert!(handler.cast::<windows_core::imp::IAgileObject>().is_err(), "{name} answers IAgileObject");
            assert!(handler.cast::<windows_core::imp::IMarshal>().is_err(), "{name} answers IMarshal");
        }
    }
}
