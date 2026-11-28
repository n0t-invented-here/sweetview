//! Webviews made the way an application's are, through `Engine::create`, for
//! each kind of host (a window of the engine's own, a given window it fills, a
//! child of a given window: the tabs library's pages are such children), and
//! what WebView2 then shows a person, read back from WebView2 itself
//! (`sweetview_platform_webview::test_support`). The measure is the C++
//! fork's webview (DECISIONS D45).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sweetview_platform_webview::test_support::{self, DownloadWatch};

use super::*;
use crate::runtime::testing::on_ui_thread;
use crate::window::{Window, WindowInit};

/// Pumps `runtime` until `done` or `timeout`; returns whether `done` held.
fn pump_until(runtime: &Runtime, timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
  let deadline = Instant::now() + timeout;
  loop {
    runtime.pump();
    if done() {
      return true;
    }
    if Instant::now() >= deadline {
      return false;
    }
    std::thread::sleep(Duration::from_millis(10));
  }
}

fn settle(runtime: &Runtime, duration: Duration) {
  pump_until(runtime, duration, || false);
}

/// What the end of an application does (`release_all`), then a pump, so every
/// webview has gone before the runtime does.
fn finish(runtime: &Runtime) {
  release_all();
  settle(runtime, Duration::from_millis(300));
  release_environment_for_tests();
}

/// The `wry` webview of `engine`, lent to `f`.
fn wry_of<R>(engine: &Engine, f: impl FnOnce(&WebView) -> R) -> R {
  engine.inner.with_live(|live| f(&live.webview)).expect("a live webview")
}

/// Loads `html` and waits until the page has called `report("ready")`; returns
/// what the page reports after that, in order.
fn load(runtime: &Runtime, engine: &Engine, html: &str) -> Rc<RefCell<Vec<String>>> {
  let reports: Rc<RefCell<Vec<String>>> = Rc::default();
  let sink = reports.clone();
  let _ = engine.unbind("report");
  assert_eq!(engine.bind("report", Rc::new(move |_seq, args| sink.borrow_mut().push(args.to_string()))), ErrorCode::Ok);
  engine.set_html(html);
  assert!(pump_until(runtime, Duration::from_secs(20), || reports.borrow().iter().any(|r| r.contains("ready"))), "the page loaded");
  reports.borrow_mut().clear();
  reports
}

const PAGE: &str = "<!doctype html><body>page<script>report('ready')</script></body>";

/// A visible top-level window for a webview to fill or sit in.
fn host_window(title: &str) -> Window {
  let window = Window::create(WindowInit {
    title: title.into(),
    frame: true,
    resizable: true,
    bounds: Some(crate::Rect::new(80, 80, 520, 420)),
    ..Default::default()
  })
  .expect("host window");
  window.show().expect("show");
  window
}

/// Each kind of host, with the window it needs kept alive beside it.
fn engines() -> Vec<(&'static str, Engine, Option<Window>)> {
  let own = Engine::create(false, Host::Own).expect("own");
  own.set_size(480, 360, SizeHint::None);
  let filled = host_window("engine test: filled");
  let fill = Engine::create(false, Host::Fill(filled.handle())).expect("fill");
  let parent = host_window("engine test: child");
  let child = Engine::create(false, Host::Child(parent.handle(), Bounds { x: 10, y: 10, width: 300, height: 200 })).expect("child");
  vec![("own window", own, None), ("given window", fill, Some(filled)), ("child", child, Some(parent))]
}

#[test]
fn a_download_shows_webview2_s_own_interface_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    let folder = std::env::temp_dir().join(format!("sweetview-engine-download-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    for (host, engine, _window) in engines() {
      load(&runtime, &engine, PAGE);
      let watch = wry_of(&engine, |webview| DownloadWatch::attach(webview, folder.clone()));
      engine.eval(
        "(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['a download'])); \
         a.download = 'sweetview-download.txt'; document.body.append(a); a.click(); })()",
      );
      assert!(pump_until(&runtime, Duration::from_secs(10), || !watch.handled().is_empty()), "{host}: the download started");
      let opened = pump_until(&runtime, Duration::from_secs(5), || wry_of(&engine, test_support::download_dialog_open) == Some(true));
      eprintln!("-- {host}: marked handled {:?}; WebView2's download dialog opened {opened}", watch.handled());
      wry_of(&engine, test_support::close_download_dialog);
      // `Handled` true is what keeps a download out of WebView2's own interface
      // (ICoreWebView2DownloadStartingEventArgs::put_Handled); whether the flyout also opens
      // by itself depends on the window being in the foreground, which a shared desktop does
      // not give a test, so the real-input test looks at that.
      assert_eq!(watch.handled(), vec![false], "{host}: the download is left to WebView2, which shows it in its own interface");
      drop(watch);
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    let _ = std::fs::remove_dir_all(&folder);
    finish(&runtime);
  });
}

