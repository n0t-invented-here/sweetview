#![cfg(windows)]
mod common;
use std::time::Duration;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
fn handles() -> u32 { let mut n = 0; unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut n) }.unwrap(); n }
#[test]
fn growth() {
    let mut ctx = common::Ctx::new();
    let mode = std::env::var("MODE").unwrap_or_default();
    let mut life = |ctx: &mut common::Ctx| {
        if mode == "bare" {
            let window = tao::window::WindowBuilder::new().build(&ctx.el).unwrap();
            let mut wc = wry::WebContext::new(Some(std::env::temp_dir().join(format!("svpw-h-{}", std::process::id()))));
            let got = std::rc::Rc::new(std::cell::Cell::new(false));
            let g = got.clone();
            let webview = wry::WebViewBuilder::new_with_web_context(&mut wc).with_ipc_handler(move |_| g.set(true)).with_html("<script>window.ipc.postMessage('x')</script>").build(&window).unwrap();
            ctx.pump(None, Duration::from_secs(20), || got.get());
            drop(webview); drop(window);
            ctx.settle(None, Duration::from_millis(300));
            return;
        }
        let view = ctx.view();
        ctx.load_index(&view);
        drop(view);
        ctx.settle(None, Duration::from_millis(300));
    };
    for _ in 0..2 { life(&mut ctx); }
    ctx.settle(None, Duration::from_secs(1));
    let start = handles();
    for i in 0..10 { life(&mut ctx); eprintln!("{i}: {}", handles() as i64 - start as i64); }
    ctx.settle(None, Duration::from_secs(5));
    eprintln!("MODE {mode} final delta {}", handles() as i64 - start as i64);
}
