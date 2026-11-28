//! What `wry` 0.58.2 sets on a real WebView2 on its own, read back from
//! WebView2's own settings objects: the control for what this crate and the
//! runtime put back. The C++ fork's settings, the measure, are WebView2's
//! defaults with the developer tools from `debug` and the status bar off
//! (`win32_edge.hh`); `cpp_fork` below.
#![cfg(windows)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]

mod common;

use common::{Ctx, View};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Settings, ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5, ICoreWebView2Settings6,
    ICoreWebView2Settings8, ICoreWebView2Settings9,
};
use windows::core::{Interface, BOOL};
use wry::WebViewExtWindows;

/// Every boolean setting of `ICoreWebView2Settings` to `ICoreWebView2Settings9`,
/// as WebView2 reports it. `None` where the runtime lacks the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Settings {
    script: bool,
    web_messages: bool,
    script_dialogs: bool,
    status_bar: bool,
    devtools: bool,
    context_menus: bool,
    host_objects: bool,
    zoom_control: bool,
    built_in_error_page: bool,
    browser_accelerator_keys: Option<bool>,
    password_autosave: Option<bool>,
    general_autofill: Option<bool>,
    pinch_zoom: Option<bool>,
    swipe_navigation: Option<bool>,
    reputation_checking: Option<bool>,
    non_client_region: Option<bool>,
}

/// One getter: `get` is handed a BOOL to fill and returns the call's result.
fn flag(get: impl FnOnce(&mut BOOL) -> windows::core::Result<()>) -> bool {
    let mut value = BOOL::default();
    get(&mut value).expect("a settings getter failed");
    value.as_bool()
}

fn read(view: &View) -> Settings {
    let webview = view.webview().webview();
    // SAFETY: `webview` is a COM reference to the live ICoreWebView2 of `view`, which this
    // frame borrows for the whole function; `Settings` takes no arguments.
    let s: ICoreWebView2Settings = unsafe { webview.Settings() }.expect("Settings");
    Settings {
        // Each getter: `s`, or the interface `cast` from it, is a COM reference this frame
        // owns to the live settings object, and `v` is the BOOL `flag` owns for the call to fill.
        // SAFETY: a getter on `s`, filling `v` (see above).
        script: flag(|v| unsafe { s.IsScriptEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        web_messages: flag(|v| unsafe { s.IsWebMessageEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        script_dialogs: flag(|v| unsafe { s.AreDefaultScriptDialogsEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        status_bar: flag(|v| unsafe { s.IsStatusBarEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        devtools: flag(|v| unsafe { s.AreDevToolsEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        context_menus: flag(|v| unsafe { s.AreDefaultContextMenusEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        host_objects: flag(|v| unsafe { s.AreHostObjectsAllowed(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        zoom_control: flag(|v| unsafe { s.IsZoomControlEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        built_in_error_page: flag(|v| unsafe { s.IsBuiltInErrorPageEnabled(v) }),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        browser_accelerator_keys: s.cast::<ICoreWebView2Settings3>().ok().map(|s3| flag(|v| unsafe { s3.AreBrowserAcceleratorKeysEnabled(v) })),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        password_autosave: s.cast::<ICoreWebView2Settings4>().ok().map(|s4| flag(|v| unsafe { s4.IsPasswordAutosaveEnabled(v) })),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        general_autofill: s.cast::<ICoreWebView2Settings4>().ok().map(|s4| flag(|v| unsafe { s4.IsGeneralAutofillEnabled(v) })),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        pinch_zoom: s.cast::<ICoreWebView2Settings5>().ok().map(|s5| flag(|v| unsafe { s5.IsPinchZoomEnabled(v) })),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        swipe_navigation: s.cast::<ICoreWebView2Settings6>().ok().map(|s6| flag(|v| unsafe { s6.IsSwipeNavigationEnabled(v) })),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        reputation_checking: s.cast::<ICoreWebView2Settings8>().ok().map(|s8| flag(|v| unsafe { s8.IsReputationCheckingRequired(v) })),
        // SAFETY: a getter on `s` or its cast, filling `v` (see above).
        non_client_region: s.cast::<ICoreWebView2Settings9>().ok().map(|s9| flag(|v| unsafe { s9.IsNonClientRegionSupportEnabled(v) })),
    }
}

/// What an application on the C++ fork had: WebView2's documented defaults
/// (the `ICoreWebView2Settings` to `ICoreWebView2Settings9` reference pages)
/// with the two the fork set, the developer tools as given and the status bar
/// off.
fn cpp_fork(devtools: bool) -> Settings {
    Settings {
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

#[test]
fn what_wry_sets_on_its_own() {
    let mut ctx = Ctx::new();
    // A webview `wry` builds with nothing set, on its own environment: the control for
    // what this crate and the runtime put back (the runtime's own webviews are read back,
    // for each kind of host, by the runtime's engine tests). A `wry` upgrade that changes
    // any of this fails here, and D45 and `with_page_behaviour` are revisited.
    let wry_alone = ctx.plain_wry_view();
    let seen = read(&wry_alone);
    eprintln!("-- wry 0.58.2 on its own: {seen:?}");
    let expected = Settings {
        zoom_control: false,
        pinch_zoom: Some(false),
        swipe_navigation: Some(false),
        non_client_region: Some(true),
        // `wry`'s default: the developer tools in a debug build, as this test is.
        ..cpp_fork(cfg!(debug_assertions))
    };
    assert_eq!(seen, expected, "what wry 0.58.2 sets on its own");
    drop(wry_alone);
    ctx.settle(None, std::time::Duration::from_millis(200));
}
