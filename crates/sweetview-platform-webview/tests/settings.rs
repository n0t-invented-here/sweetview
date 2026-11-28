//! The settings of a webview this crate makes, read back from WebView2's own
//! settings objects: the C++ fork's, which are WebView2's defaults with the
//! developer tools from `debug` and the status bar off (`win32_edge.hh`). The
//! runtime's webviews, made through `Engine::create` for each kind of host,
//! are read back by the runtime's engine tests.
#![cfg(windows)]

mod common;

use common::Ctx;
use sweetview_platform_webview::test_support::{page_settings, PageSettings};

#[test]
fn a_webview_has_the_cpp_fork_s_settings() {
    let mut ctx = Ctx::new();
    for devtools in [false, true] {
        let view = ctx.view_debug(devtools);
        ctx.load_index(&view);
        let seen = page_settings(view.webview());
        eprintln!("-- devtools {devtools}: {seen:?}");
        assert_eq!(seen, PageSettings::cpp_fork(devtools), "the C++ fork's settings");
        drop(view);
    }
    ctx.settle(None, std::time::Duration::from_millis(200));
}
