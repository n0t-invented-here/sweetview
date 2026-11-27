//! `create_environment`: an environment made the C++ fork's way serves `wry`
//! webviews, one environment is shared by several webviews, and the C++
//! fork's default folder is `%APPDATA%\<exe file name>`.
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use common::{Ctx, View, INDEX_HTML};
use sweetview_platform_webview::{create_environment, default_user_data_folder, ErrorCode, ExtrasOptions, WebviewExtras};
use tao::window::WindowBuilder;
use wry::{WebViewBuilder, WebViewBuilderExtWindows};

fn view_in(ctx: &Ctx, environment: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment) -> View {
    let window = WindowBuilder::new().with_title("environment test").build(&ctx.el).expect("window");
    let messages = Rc::new(RefCell::new(Vec::new()));
    let sink = messages.clone();
    let webview = WebViewBuilder::new()
        .with_environment(environment.clone())
        .with_ipc_handler(move |request| sink.borrow_mut().push(request.into_body()))
        .build(&window)
        .expect("webview on the created environment");
    let extras = WebviewExtras::attach(&webview, ExtrasOptions { wake_ui: Arc::new(|| {}) }).expect("attach");
    assert_eq!(extras.set_asset("index.html", "text/html", INDEX_HTML.as_bytes().to_vec()), ErrorCode::Ok);
    View { extras: Some(extras), webview: Some(webview), window: Some(window), messages, wakes: Arc::default() }
}

#[test]
fn environment_created_the_cpp_way() {
    let folder = default_user_data_folder().expect("default folder");
    let exe = std::env::current_exe().unwrap();
    assert_eq!(folder.file_name(), exe.file_name(), "the folder is named after the executable, extension included");
    let appdata = std::env::var_os("APPDATA").expect("APPDATA");
    assert_eq!(folder.parent().unwrap(), std::path::Path::new(&appdata));

    let mut ctx = Ctx::new();
    let data = std::env::temp_dir().join(format!("sweetview-platform-webview-env-{}", std::process::id()));
    let environment = create_environment(Some(&data)).expect("create_environment");
    // A second environment on the same folder with the same (null) options
    // starts, as every C++ webview's own environment does.
    let second = create_environment(Some(&data)).expect("a second environment on the same folder");

    let a = view_in(&ctx, &environment);
    let b = view_in(&ctx, &environment);
    let c = view_in(&ctx, &second);
    for view in [&a, &b, &c] {
        let ready = ctx.load_index(view);
        assert_eq!(ready["origin"], "http://webview.localhost", "{ready}");
    }
    assert!(data.join("EBWebView").exists(), "the given user data folder is the one in use");
    drop((a, b, c));
}
