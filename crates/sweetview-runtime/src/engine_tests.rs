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

/// The kinds of host, in the order the tests go through them.
const HOSTS: [&str; 3] = ["own window", "given window", "child"];

/// A webview in a host of kind `host`, with the window it needs kept alive
/// beside it. `before` runs once that window exists and before the webview is
/// made.
fn make(host: &str, before: impl FnOnce(Option<&Window>)) -> (Engine, Option<Window>) {
  match host {
    "own window" => {
      before(None);
      let engine = Engine::create(false, Host::Own).expect("own");
      engine.set_size(480, 360, SizeHint::None);
      (engine, None)
    }
    "given window" => {
      let window = host_window("engine test: filled");
      before(Some(&window));
      (Engine::create(false, Host::Fill(window.handle())).expect("fill"), Some(window))
    }
    _ => {
      let window = host_window("engine test: child");
      before(Some(&window));
      let bounds = Bounds { x: 10, y: 10, width: 300, height: 200 };
      (Engine::create(false, Host::Child(window.handle(), bounds)).expect("child"), Some(window))
    }
  }
}

#[test]
fn a_download_shows_webview2_s_own_interface_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    let folder = std::env::temp_dir().join(format!("sweetview-engine-download-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    for host in HOSTS {
      let (engine, _window) = make(host, |_| ());
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


#[test]
fn a_webview_takes_the_focus_only_in_a_window_of_its_own_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    // The C++ fork focused the page only when it made the window itself (`owns_window()`,
    // win32_edge.hh): a webview put in a given window, or beside a native control that
    // has the focus, leaves the focus where it is.
    for host in HOSTS {
      let (engine, window) = make(host, |window| {
        if let Some(window) = window {
          test_support::focus_window(window.handle());
        }
      });
      let holder = window.as_ref().map(|w| w.handle());
      load(&runtime, &engine, PAGE);
      settle(&runtime, Duration::from_millis(300));
      let inside = wry_of(&engine, test_support::focus_is_inside);
      let focused = test_support::focused_window();
      eprintln!("-- {host}: focus in the webview {inside}; focused window {focused:#x}, the given window {holder:?}");
      // A window of the engine's own is hidden until it is first sized or run, so where its
      // focus goes is printed, not asserted.
      if let Some(holder) = holder {
        assert!(!inside, "{host}: the webview did not take the focus");
        assert_eq!(focused, holder, "{host}: the given window keeps the focus");
      }
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    finish(&runtime);
  });
}

#[test]
fn a_page_that_calls_window_close_stays_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    // The C++ fork did not handle WindowCloseRequested, so a page's `window.close()` left
    // the webview where it was.
    for host in HOSTS {
      let (engine, _window) = make(host, |_| ());
      let reports = load(&runtime, &engine, PAGE);
      engine.eval("window.close()");
      settle(&runtime, Duration::from_millis(800));
      let alive = wry_of(&engine, test_support::container_alive);
      engine.eval("report('still here')");
      let answered = pump_until(&runtime, Duration::from_secs(3), || reports.borrow().iter().any(|r| r.contains("still here")));
      eprintln!("-- {host}: after window.close(), the webview's window exists {alive}; the page answers {answered}");
      assert!(alive, "{host}: the webview's window is still there");
      assert!(answered, "{host}: the page still runs");
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    finish(&runtime);
  });
}

#[test]
fn a_new_webview_leaves_the_profile_s_autofill_preference_as_it_is_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    // The C++ fork never set general autofill, so the preference stayed as the profile had
    // it. Turned off in one webview (as an application reaching WebView2 itself, or another
    // program on the profile, can), it stays off when another webview is made.
    let (first, _first_window) = make("own window", |_| ());
    load(&runtime, &first, PAGE);
    wry_of(&first, |webview| test_support::set_general_autofill(webview, false));
    for host in HOSTS {
      let (second, _window) = make(host, |_| ());
      load(&runtime, &second, PAGE);
      let seen = (wry_of(&first, |w| test_support::page_settings(w).general_autofill), wry_of(&second, |w| test_support::page_settings(w).general_autofill));
      eprintln!("-- after a second webview in a {host}: general autofill (first, second) {seen:?}");
      assert_eq!(seen, (Some(false), Some(false)), "{host}: the profile's preference is left as it was");
      second.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    // With every webview gone, the next is made with the preference as last read.
    first.destroy();
    settle(&runtime, Duration::from_millis(200));
    let (later, _later_window) = make("child", |_| ());
    load(&runtime, &later, PAGE);
    let seen = wry_of(&later, |w| test_support::page_settings(w).general_autofill);
    eprintln!("-- a webview made after every other had gone: general autofill {seen:?}");
    assert_eq!(seen, Some(false), "the preference as the profile last had it");
    later.destroy();
    finish(&runtime);
  });
}
