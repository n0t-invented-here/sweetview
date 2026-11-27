//! The WebView2 event handler objects this crate registers, and the owning
//! type that unregisters each one.
//!
//! Each handler is a COM object made with `#[implement]` over the typed
//! interface `webview2-com` declares. They hold a `Fn` (not the `FnMut` behind
//! an `UnsafeCell` that `webview2-com`'s own generated handlers hold), so a
//! handler re-entered from a nested message loop inside an application's
//! callback is still sound. Every `Invoke` runs its body inside
//! `catch_unwind`: nothing unwinds into WebView2.

use std::panic::{catch_unwind, AssertUnwindSafe};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{implement, Ref, HRESULT, PCWSTR};

/// Runs `f`, turning a panic into nothing: the callers are OS callbacks.
pub(super) fn guarded(f: impl FnOnce()) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

#[implement(ICoreWebView2WebResourceRequestedEventHandler)]
pub(super) struct ResourceRequested(Box<dyn Fn(&ICoreWebView2WebResourceRequestedEventArgs)>);

impl ResourceRequested {
    pub(super) fn create(f: impl Fn(&ICoreWebView2WebResourceRequestedEventArgs) + 'static) -> ICoreWebView2WebResourceRequestedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2WebResourceRequestedEventHandler_Impl for ResourceRequested_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2WebResourceRequestedEventArgs>) -> windows::core::Result<()> {
        if let Some(args) = args.as_ref() {
            guarded(|| (self.0)(args));
        }
        Ok(())
    }
}

#[implement(ICoreWebView2WebMessageReceivedEventHandler)]
pub(super) struct MessageReceived(Box<dyn Fn(&ICoreWebView2WebMessageReceivedEventArgs)>);

impl MessageReceived {
    pub(super) fn create(f: impl Fn(&ICoreWebView2WebMessageReceivedEventArgs) + 'static) -> ICoreWebView2WebMessageReceivedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2WebMessageReceivedEventHandler_Impl for MessageReceived_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2WebMessageReceivedEventArgs>) -> windows::core::Result<()> {
        if let Some(args) = args.as_ref() {
            guarded(|| (self.0)(args));
        }
        Ok(())
    }
}

#[implement(ICoreWebView2ContentLoadingEventHandler)]
pub(super) struct ContentLoading(Box<dyn Fn(&ICoreWebView2ContentLoadingEventArgs)>);

impl ContentLoading {
    pub(super) fn create(f: impl Fn(&ICoreWebView2ContentLoadingEventArgs) + 'static) -> ICoreWebView2ContentLoadingEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2ContentLoadingEventHandler_Impl for ContentLoading_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2ContentLoadingEventArgs>) -> windows::core::Result<()> {
        if let Some(args) = args.as_ref() {
            guarded(|| (self.0)(args));
        }
        Ok(())
    }
}

#[implement(ICoreWebView2NavigationStartingEventHandler)]
pub(super) struct NavigationStarting(Box<dyn Fn(&ICoreWebView2NavigationStartingEventArgs)>);

impl NavigationStarting {
    pub(super) fn create(f: impl Fn(&ICoreWebView2NavigationStartingEventArgs) + 'static) -> ICoreWebView2NavigationStartingEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2NavigationStartingEventHandler_Impl for NavigationStarting_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2NavigationStartingEventArgs>) -> windows::core::Result<()> {
        if let Some(args) = args.as_ref() {
            guarded(|| (self.0)(args));
        }
        Ok(())
    }
}

#[implement(ICoreWebView2NavigationCompletedEventHandler)]
pub(super) struct NavigationCompleted(Box<dyn Fn(&ICoreWebView2NavigationCompletedEventArgs)>);

impl NavigationCompleted {
    pub(super) fn create(f: impl Fn(&ICoreWebView2NavigationCompletedEventArgs) + 'static) -> ICoreWebView2NavigationCompletedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2NavigationCompletedEventHandler_Impl for NavigationCompleted_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2>, args: Ref<ICoreWebView2NavigationCompletedEventArgs>) -> windows::core::Result<()> {
        if let Some(args) = args.as_ref() {
            guarded(|| (self.0)(args));
        }
        Ok(())
    }
}

#[implement(ICoreWebView2AcceleratorKeyPressedEventHandler)]
pub(super) struct AcceleratorKeyPressed(Box<dyn Fn(&ICoreWebView2AcceleratorKeyPressedEventArgs)>);

impl AcceleratorKeyPressed {
    pub(super) fn create(f: impl Fn(&ICoreWebView2AcceleratorKeyPressedEventArgs) + 'static) -> ICoreWebView2AcceleratorKeyPressedEventHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2AcceleratorKeyPressedEventHandler_Impl for AcceleratorKeyPressed_Impl {
    fn Invoke(&self, _sender: Ref<ICoreWebView2Controller>, args: Ref<ICoreWebView2AcceleratorKeyPressedEventArgs>) -> windows::core::Result<()> {
        if let Some(args) = args.as_ref() {
            guarded(|| (self.0)(args));
        }
        Ok(())
    }
}

/// The completion of `AddScriptToExecuteOnDocumentCreated`: the script's id,
/// or `None` when WebView2 refused the script.
#[implement(ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler)]
pub(super) struct ScriptAdded(Box<dyn Fn(Option<String>)>);

impl ScriptAdded {
    pub(super) fn create(f: impl Fn(Option<String>) + 'static) -> ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler {
        Self(Box::new(f)).into()
    }
}

impl ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler_Impl for ScriptAdded_Impl {
    fn Invoke(&self, errorcode: HRESULT, result: &PCWSTR) -> windows::core::Result<()> {
        guarded(|| {
            let id = errorcode.is_ok().then(|| webview2_com::string_from_pcwstr(result));
            (self.0)(id.filter(|id| !id.is_empty()));
        });
        Ok(())
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
        };
    }
}
