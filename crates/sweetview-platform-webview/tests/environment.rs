//! `create_environment`: an environment made the C++ fork's way serves `wry`
//! webviews, one environment is shared by several webviews, and the C++
//! fork's default folder is `%APPDATA%\<exe file name>`. Passes with
//! `WEBVIEW2_USER_DATA_FOLDER` set or unset: the variable is read, never set.
#![cfg(windows)]

mod common;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use common::{Ctx, View, INDEX_HTML};
use sweetview_platform_webview::{create_environment, default_user_data_folder, ErrorCode, ExtrasOptions, WebviewExtras};
use tao::window::WindowBuilder;
use wry::{WebViewBuilder, WebViewBuilderExtWindows};

/// The tests of this file one at a time: one counts the process's handles.
fn serial() -> MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

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
    let _serial = serial();
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
    // WebView2 gives `WEBVIEW2_USER_DATA_FOLDER` precedence over the folder an
    // environment is created with (documented for
    // `CreateCoreWebView2EnvironmentWithOptions`): with the variable set, its
    // folder is the one in use and the given folder is left untouched.
    match std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").filter(|value| !value.is_empty()) {
        None => assert!(data.join("EBWebView").exists(), "the given user data folder is the one in use"),
        Some(variable) => {
            let variable = std::path::PathBuf::from(variable);
            assert!(variable.join("EBWebView").exists(), "with WEBVIEW2_USER_DATA_FOLDER set, its folder is the one in use");
            assert!(!data.join("EBWebView").exists(), "with WEBVIEW2_USER_DATA_FOLDER set, the given folder is not used");
        }
    }
    drop((a, b, c));
}

/// `create_environment` in a counted loop: each environment created and
/// dropped gives back what it took, and the thread's COM apartment is entered
/// once, not once per call. Each count returns to its starting value, read
/// once it has stopped moving.
#[test]
fn creating_and_dropping_environments_returns_every_handle() {
    let _serial = serial();
    let data = std::env::temp_dir().join(format!("sweetview-platform-webview-env-loop-{}", std::process::id()));
    // One first, so one-time costs (WebView2's loader, the apartment) are paid.
    drop(create_environment(Some(&data)).expect("create_environment"));
    let before = sweetview_platform_loop::testing::settled_counts();
    for _ in 0..20 {
        drop(create_environment(Some(&data)).expect("create_environment"));
    }
    let after = sweetview_platform_loop::testing::settled_counts();
    eprintln!("(USER, GDI, kernel) before {before:?}, after 20 environments {after:?}");
    assert_eq!(after, before, "every count returned to its starting value");
}
