//! The page behaviour and drops with real input: a mouse and keyboard
//! injected with `SendInput` by `rust-rewrite/checks/webview-real-input.ps1`,
//! through the OS as a person's input travels. Opens windows on the desktop,
//! moves the cursor and an Explorer window, so it runs only when asked:
//!
//!   cargo test -p sweetview-platform-webview --test real_input -- --ignored --nocapture
//!
//! For a webview built as the runtime builds it: Ctrl+wheel, Ctrl+plus and
//! Ctrl+0 zoom the page; a press on a `-webkit-app-region: drag` area reaches
//! the page and does not move the window; an HTML drag inside the page reaches
//! the page; a file dragged from Explorer reaches the file drop handler with
//! its real path. Then, for comparison, the same zoom and `app-region` steps
//! on a webview `wry` built on its own, printed and not asserted.
#![cfg(windows)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]

mod common;

use std::cell::RefCell;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::time::Duration;

use common::{Ctx, View};
use serde_json::Value;
use sweetview_platform_webview::ErrorCode;
use tao::dpi::PhysicalPosition;
use wry::WebViewExtWindows;

const INPUT_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>real input</title>
<style>
  body { margin: 0; font: 13px sans-serif; }
  #bar { -webkit-app-region: drag; app-region: drag; height: 60px; background: #cde; }
  #src { position: absolute; left: 20px; top: 90px; width: 100px; height: 50px; background: #fc9; }
  #dst { position: absolute; left: 260px; top: 90px; width: 160px; height: 110px; background: #9cf; }
  #files { position: absolute; left: 20px; top: 220px; width: 400px; height: 100px; background: #cfc; }
</style></head>
<body>
<div id="bar">app-region: drag</div>
<div id="src" draggable="true">drag me</div>
<div id="dst">drop here</div>
<div id="files">files land here</div>
<script>
  window.post = (o) => window.ipc.postMessage(JSON.stringify(o));
  bar.addEventListener('mousedown', () => post({ tag: 'bar-down' }));
  src.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'from-src'); post({ tag: 'dragstart' }); });
  dst.addEventListener('dragover', (e) => e.preventDefault());
  dst.addEventListener('drop', (e) => { e.preventDefault(); post({ tag: 'page-drop', data: e.dataTransfer.getData('text/plain'), files: e.dataTransfer.files.length }); });
  window.addEventListener('resize', () => post({ tag: 'resize', dpr: devicePixelRatio, width: innerWidth }));
  const centre = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
  post({ tag: 'input-ready', bar: centre('bar'), src: centre('src'), dst: centre('dst'), files: centre('files'), dpr: devicePixelRatio });
</script>
</body></html>"#;

fn script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../rust-rewrite/checks/webview-real-input.ps1")
}

/// Runs the injector with `args` while pumping, until it has exited and `done`
/// holds, or `timeout`. Prints its output. The injector is ended by its id if
/// it is still running then.
fn inject(ctx: &mut Ctx, view: &View, args: &[String], timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let mut child = Command::new("pwsh")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("pwsh");
    let mut exited = false;
    let reached = ctx.pump(Some(view), timeout, || {
        exited = exited || child.try_wait().ok().flatten().is_some();
        exited && done()
    });
    if !exited && child.try_wait().ok().flatten().is_none() {
        eprintln!("   the injector (pid {}) is still running: ended by its id", child.id());
        let _ = child.kill();
    }
    let output = child.wait_with_output().expect("the injector's output");
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        eprintln!("   injector: {line}");
    }
    for line in String::from_utf8_lossy(&output.stderr).lines() {
        eprintln!("   injector (stderr): {line}");
    }
    reached
}

/// A point of the page (CSS pixels) on the screen (physical pixels).
fn on_screen(view: &View, page: &Value, at: &str) -> (i32, i32) {
    let window = view.window.as_ref().unwrap();
    let origin = window.inner_position().expect("inner_position");
    let dpr = page["dpr"].as_f64().unwrap();
    let x = origin.x + (page[at]["x"].as_f64().unwrap() * dpr).round() as i32;
    let y = origin.y + (page[at]["y"].as_f64().unwrap() * dpr).round() as i32;
    (x, y)
}

fn zoom_factor(view: &View) -> f64 {
    let controller = view.webview().controller();
    let mut factor = 0.0;
    // SAFETY: `controller` is a COM reference this frame owns to the live controller of
    // `view`, and `factor` is a local f64 for the call to fill.
    unsafe { controller.ZoomFactor(&mut factor) }.expect("ZoomFactor");
    factor
}

fn open_input_page(ctx: &mut Ctx, view: &View) -> Value {
    if let Some(extras) = view.extras.as_ref() {
        assert_eq!(extras.set_asset("input.html", "text/html; charset=utf-8", INPUT_HTML.as_bytes().to_vec()), ErrorCode::Ok);
        view.webview().load_url("http://webview.localhost/input.html").expect("load_url");
    } else {
        view.webview().load_html(INPUT_HTML).expect("load_html");
    }
    let page = ctx.wait(view, "input-ready");
    // Let the first paint settle before the pointer arrives.
    ctx.settle(Some(view), Duration::from_millis(500));
    page
}

/// Ctrl+wheel at the files area; returns (zoom factor before, after, the page's resize message).
fn ctrl_wheel(ctx: &mut Ctx, view: &View, page: &Value) -> (f64, f64, Option<Value>) {
    let before = zoom_factor(view);
    let (x, y) = on_screen(view, page, "files");
    let mut resized = None;
    inject(ctx, view, &["-Action".into(), "ctrlwheel".into(), "-X".into(), x.to_string(), "-Y".into(), y.to_string()], Duration::from_secs(8), || {
        resized = resized.take().or_else(|| view.take("resize"));
        resized.is_some()
    });
    (before, zoom_factor(view), resized)
}

/// A press on the `app-region: drag` bar, moved 80 px right; returns whether
/// the page saw the press and how far the window moved.
fn press_on_bar(ctx: &mut Ctx, view: &View, page: &Value) -> (bool, (i32, i32)) {
    let window = view.window.as_ref().unwrap();
    let before = window.outer_position().unwrap();
    let (x, y) = on_screen(view, page, "bar");
    let mut down = false;
    let args = ["-Action", "drag", "-X", &x.to_string(), "-Y", &y.to_string(), "-ToX", &(x + 80).to_string(), "-ToY", &y.to_string()];
    inject(ctx, view, &args.map(String::from), Duration::from_secs(8), || {
        down = down || view.take("bar-down").is_some();
        down
    });
    ctx.settle(Some(view), Duration::from_millis(300));
    down = down || view.take("bar-down").is_some();
    let after = window.outer_position().unwrap();
    // Put it back where it was for the next step.
    window.set_outer_position(before);
    ctx.settle(Some(view), Duration::from_millis(200));
    (down, (after.x - before.x, after.y - before.y))
}

#[test]
#[ignore = "real input on the desktop; run with --ignored when the desktop is free"]
fn real_input_reaches_the_page_as_webview2_would_have_it() {
    let mut ctx = Ctx::new();
    let view = ctx.view_built(|b| b.with_devtools(false).with_clipboard(true), true);
    let window = view.window.as_ref().unwrap();
    // On the right of the primary monitor, clear of the Explorer window the drop step opens on the left.
    if let Some(monitor) = window.primary_monitor() {
        let size = window.outer_size();
        let x = monitor.position().x + monitor.size().width as i32 - size.width as i32 - 60;
        window.set_outer_position(PhysicalPosition::new(x, monitor.position().y + 120));
    }
    window.set_focus();
    let page = open_input_page(&mut ctx, &view);
    eprintln!("-- built as the runtime builds it; the page: {page}");

    eprintln!("-- a press on a -webkit-app-region: drag area, moved 80 px");
    let (bar_down, moved) = press_on_bar(&mut ctx, &view, &page);
    eprintln!("   the page saw the press: {bar_down}; the window moved by {moved:?}");

    eprintln!("-- an HTML drag inside the page, with the file drop handler set");
    let dropped: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    {
        let dropped = dropped.clone();
        assert_eq!(view.extras().set_file_drop_handler(Some(Rc::new(move |paths| dropped.borrow_mut().push(paths)))), ErrorCode::Ok);
    }
    let (sx, sy) = on_screen(&view, &page, "src");
    let (dx, dy) = on_screen(&view, &page, "dst");
    let mut page_drop = None;
    let args = ["-Action", "drag", "-X", &sx.to_string(), "-Y", &sy.to_string(), "-ToX", &dx.to_string(), "-ToY", &dy.to_string()];
    inject(&mut ctx, &view, &args.map(String::from), Duration::from_secs(10), || {
        page_drop = page_drop.take().or_else(|| view.take("page-drop"));
        page_drop.is_some()
    });
    eprintln!("   dragstart seen: {}; the page's drop: {page_drop:?}", view.take("dragstart").is_some());

    eprintln!("-- a file dragged from Explorer onto the page");
    let folder = std::env::temp_dir().join(format!("sweetview-real-drop-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join("sweetview real drop.txt");
    std::fs::write(&file, "a file dragged from Explorer").unwrap();
    let (fx, fy) = on_screen(&view, &page, "files");
    let at = window.primary_monitor().map_or_else(|| "40,120".to_string(), |m| format!("{},{}", m.position().x + 40, m.position().y + 120));
    let args = [
        "-Action".to_string(),
        "explorer".into(),
        "-Folder".into(),
        folder.to_string_lossy().into_owned(),
        "-File".into(),
        "sweetview real drop.txt".into(),
        "-ToX".into(),
        fx.to_string(),
        "-ToY".into(),
        fy.to_string(),
        "-ExplorerAt".into(),
        at,
    ];
    inject(&mut ctx, &view, &args, Duration::from_secs(40), || !dropped.borrow().is_empty());
    ctx.settle(Some(&view), Duration::from_millis(300));
    let file_drop = dropped.borrow().clone();
    eprintln!("   the file drop handler received: {file_drop:?}");
    let _ = std::fs::remove_dir_all(&folder);

    eprintln!("-- Ctrl+wheel, Ctrl+0, Ctrl+plus, Ctrl+0 over the page");
    let (z0, z1, wheel) = ctrl_wheel(&mut ctx, &view, &page);
    eprintln!("   Ctrl+wheel: ZoomFactor {z0} -> {z1}; the page: {wheel:?}");
    let key = |ctx: &mut Ctx, name: &str| {
        let (x, y) = on_screen(&view, &page, "files");
        let mut resized = None;
        let args = ["-Action", "ctrlkey", "-Key", name, "-X", &x.to_string(), "-Y", &y.to_string()];
        inject(ctx, &view, &args.map(String::from), Duration::from_secs(8), || {
            resized = resized.take().or_else(|| view.take("resize"));
            resized.is_some()
        });
        resized
    };
    let reset = key(&mut ctx, "zero");
    let z2 = zoom_factor(&view);
    eprintln!("   Ctrl+0: ZoomFactor {z2}; the page: {reset:?}");
    let plus = key(&mut ctx, "plus");
    let z3 = zoom_factor(&view);
    eprintln!("   Ctrl+plus: ZoomFactor {z3}; the page: {plus:?}");
    let reset_again = key(&mut ctx, "zero");
    let z4 = zoom_factor(&view);
    eprintln!("   Ctrl+0: ZoomFactor {z4}; the page: {reset_again:?}");
    drop(view);
    ctx.settle(None, Duration::from_millis(300));

    eprintln!("-- for comparison, wry on its own (zoom and swipe off, app-region on)");
    let alone = ctx.view_built(|b| b.with_hotkeys_zoom(false).with_back_forward_navigation_gestures(false).with_devtools(false), false);
    let window = alone.window.as_ref().unwrap();
    if let Some(monitor) = window.primary_monitor() {
        let size = window.outer_size();
        let x = monitor.position().x + monitor.size().width as i32 - size.width as i32 - 60;
        window.set_outer_position(PhysicalPosition::new(x, monitor.position().y + 120));
    }
    window.set_focus();
    let alone_page = open_input_page(&mut ctx, &alone);
    let (alone_down, alone_moved) = press_on_bar(&mut ctx, &alone, &alone_page);
    eprintln!("   app-region press: the page saw it: {alone_down}; the window moved by {alone_moved:?}");
    let (a0, a1, alone_wheel) = ctrl_wheel(&mut ctx, &alone, &alone_page);
    eprintln!("   Ctrl+wheel: ZoomFactor {a0} -> {a1}; the page: {alone_wheel:?}");
    drop(alone);
    ctx.settle(None, Duration::from_millis(300));

    // The assertions, after every step has run and printed.
    assert!(bar_down, "a press on an app-region: drag area reaches the page");
    assert_eq!(moved, (0, 0), "and does not drag the window");
    let page_drop = page_drop.expect("the in-page HTML drag reached the page's drop handler");
    assert_eq!(page_drop["data"], "from-src", "{page_drop}");
    assert_eq!(file_drop, vec![vec![file.to_string_lossy().into_owned()]], "the Explorer drop reached the handler with the file's real path");
    assert!(wheel.is_some() && z1 > z0, "Ctrl+wheel zoomed the page in: {z0} -> {z1}");
    assert!(reset.is_some() && (z2 - 1.0).abs() < 1e-6, "Ctrl+0 reset the zoom: {z2}");
    assert!(plus.is_some() && z3 > 1.0, "Ctrl+plus zoomed in: {z3}");
    assert!(reset_again.is_some() && (z4 - 1.0).abs() < 1e-6, "Ctrl+0 reset the zoom again: {z4}");
}
