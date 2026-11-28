//! The page behaviour of a real WebView2, read back from WebView2's own
//! settings objects: what `wry` 0.58.2 sets on its own, and what a webview
//! built as the runtime builds it (`with_page_behaviour`, then
//! `WebviewExtras::attach`) has. The C++ fork set only the developer tools
//! (from `debug`) and the status bar (off) in `win32_edge.hh`, so the second
//! must be WebView2's defaults with those two as the fork set them.
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
fn the_page_behaves_as_it_did_under_the_cpp_fork() {
    let mut ctx = Ctx::new();

    // `wry` on its own: its builder defaults for zoom and swipe, no extras.
    let wry_alone = ctx.view_built(|b| b.with_hotkeys_zoom(false).with_back_forward_navigation_gestures(false).with_devtools(false), false);
    let seen = read(&wry_alone);
    eprintln!("-- wry 0.58.2 on its own: {seen:?}");
    let expected = Settings {
        zoom_control: false,
        pinch_zoom: Some(false),
        swipe_navigation: Some(false),
        non_client_region: Some(true),
        ..cpp_fork(false)
    };
    assert_eq!(seen, expected, "what wry changes (a wry upgrade that changes this list needs this file and D45 revisited)");
    drop(wry_alone);

    // Built as the runtime builds a webview, without and with `debug`.
    for debug in [false, true] {
        let view = ctx.view_built(|b| b.with_devtools(debug).with_clipboard(true), true);
        ctx.load_index(&view);
        let seen = read(&view);
        eprintln!("-- as the runtime builds it, debug {debug}: {seen:?}");
        assert_eq!(seen, cpp_fork(debug), "the C++ fork's settings");
        drop(view);
    }
    ctx.settle(None, std::time::Duration::from_millis(200));
}
