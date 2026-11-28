//! A webview that fills a window that stays (`wry`'s `build`): `drop_filling` gives back the
//! container window `wry` made for it, which a plain drop leaves in the window until the window
//! itself is destroyed, one more empty child for every webview the window had (D43).
#![cfg(windows)]

mod common;

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use common::Ctx;

fn user_objects() -> i64 {
    i64::from(sweetview_platform_loop::resource_counts().user_objects)
}

/// A webview made in `window`, its page loaded, then dropped by `drop`.
fn life(ctx: &mut Ctx, window: &tao::window::Window, context: &mut wry::WebContext, drop: fn(wry::WebView)) {
    let loaded = Rc::new(Cell::new(false));
    let sink = loaded.clone();
    let webview = wry::WebViewBuilder::new_with_web_context(context)
        .with_ipc_handler(move |_| sink.set(true))
        .with_html("<script>window.ipc.postMessage('ready')</script>")
        .build(window)
        .expect("webview");
    assert!(ctx.pump(None, Duration::from_secs(20), || loaded.get()));
    drop(webview);
    ctx.settle(None, Duration::from_millis(300));
}

/// USER objects `lives` lives leave behind in a window that stays, once WebView2 has settled.
fn growth(ctx: &mut Ctx, window: &tao::window::Window, context: &mut wry::WebContext, lives: i64, drop: fn(wry::WebView)) -> i64 {
    ctx.settle(None, Duration::from_secs(1));
    let start = user_objects();
    for _ in 0..lives {
        life(ctx, window, context, drop);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut end = user_objects();
    while end > start && Instant::now() < deadline {
        ctx.settle(None, Duration::from_millis(250));
        end = user_objects();
    }
    end - start
}

#[test]
fn a_webview_that_fills_a_window_that_stays_gives_back_its_container() {
    let mut ctx = Ctx::new();
    let window = tao::window::WindowBuilder::new().with_visible(false).build(&ctx.el).expect("window");
    let mut context = wry::WebContext::new(Some(std::env::temp_dir().join(format!("sweetview-platform-webview-drop-filling-{}", std::process::id()))));
    // Warm-up: WebView2's DLLs, threads and one-time windows.
    life(&mut ctx, &window, &mut context, sweetview_platform_webview::drop_filling);
    life(&mut ctx, &window, &mut context, std::mem::drop);
    let lives = 5;
    let plain = growth(&mut ctx, &window, &mut context, lives, std::mem::drop);
    let filling = growth(&mut ctx, &window, &mut context, lives, sweetview_platform_webview::drop_filling);
    eprintln!("USER objects over {lives} lives in a window that stays: plain drop {plain}, drop_filling {filling}");
    // The defect this guards against: each plain drop leaves its container behind.
    assert!(plain >= lives, "a plain drop leaves wry's container in the window ({plain} over {lives} lives)");
    assert!(filling <= 0, "drop_filling gives every container back ({filling} over {lives} lives)");
}
