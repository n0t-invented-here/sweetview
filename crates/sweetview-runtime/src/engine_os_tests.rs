//! Webviews made as an application makes them (`Engine::create`, through the crate's public
//! API), and what the OS and WebView2 then show: the window read back from the OS, the screen's
//! pixels, real keys, pages loading from a server on another thread, and handlers that replace,
//! clear or destroy from inside their own calls. Moved here from the native package's
//! `webview.test.ts` and `request-handler.test.ts`; each test names what it proves.
//!
//! The tests that read the screen or press keys share the desktop with other programs: they
//! refuse to judge (panic with "refused to judge: ...; run again") when the desktop is not
//! theirs, and are run again, never loosened.

use std::cell::{Cell, RefCell};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sweetview_platform_webview::{test_support::release_environment, ErrorCode};
use sweetview_platform_window::test_support as support;
use sweetview_platform_window::test_support_desktop as desktop;
use sweetview_platform_window::BorrowedWindow;

use crate::engine::{self, Engine, Host, KeyData, NavigationFailure, RawRequest, SizeHint};
use crate::runtime::testing::on_ui_thread;
use crate::runtime::Runtime;
use crate::window::{Window, WindowInit};
use crate::Rect;

const ORIGIN: &str = "http://webview.localhost";
const FRAMES: &str = "http://frames.webview.localhost";
const WS_THICKFRAME: u32 = 0x0004_0000;
const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
const WM_CLOSE: u32 = 0x0010;
const VK_F12: u16 = 0x7b;
/// A port nothing listens on: a navigation to it fails without a response.
const REFUSED: &str = "http://127.0.0.1:9/";

/// Every webview of these tests on a WebView2 profile of the tests' own, not the user's.
fn use_test_webview_profile() {
  static SET: OnceLock<()> = OnceLock::new();
  SET.get_or_init(|| std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", std::env::temp_dir().join("sweetview-runtime-tests-webview2")));
}

/// [`on_ui_thread`], with the test profile and, at the end (on success or while a failed
/// assertion unwinds), what the end of an application does: every webview released, a pump so
/// each has gone, then the thread's WebView2 environment.
fn with_webviews(body: impl FnOnce(&Rc<Runtime>)) {
  use_test_webview_profile();
  on_ui_thread(|runtime| {
    struct Finish<'a>(&'a Runtime);
    impl Drop for Finish<'_> {
      fn drop(&mut self) {
        engine::release_all();
        settle(self.0, Duration::from_millis(300));
        release_environment();
      }
    }
    let _finish = Finish(&runtime);
    body(&runtime);
  });
}

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
    thread::sleep(Duration::from_millis(10));
  }
}

fn settle(runtime: &Runtime, duration: Duration) {
  pump_until(runtime, duration, || false);
}

/// Ends the process with a sentence when what it guards has not finished within `limit`: a
/// blocking run that never returns would otherwise hang the test run. Dropped when it finishes.
struct Watchdog(#[allow(dead_code, reason = "held so the watchdog's channel stays open")] mpsc::Sender<()>);

fn watchdog(limit: Duration, what: &'static str) -> Watchdog {
  let (done, wait) = mpsc::channel::<()>();
  thread::spawn(move || {
    if let Err(mpsc::RecvTimeoutError::Timeout) = wait.recv_timeout(limit) {
      eprintln!("{what}: still running after {limit:?}");
      std::process::abort();
    }
  });
  Watchdog(done)
}

fn refuse_to_judge(reason: &str) -> ! {
  panic!("refused to judge: {reason}; run again");
}

/// A webview in a window of its own, shown at `width` x `height` (no hint).
fn own(width: u32, height: u32) -> Engine {
  let engine = Engine::create(false, Host::Own, None).expect("a webview in its own window");
  engine.set_size(width, height, SizeHint::None);
  engine
}

/// Binds `name` so that each call's arguments (the JSON array) are kept, and the page's promise
/// resolves with `undefined`.
fn record(engine: &Engine, name: &str) -> Rc<RefCell<Vec<Value>>> {
  let calls: Rc<RefCell<Vec<Value>>> = Rc::default();
  let sink = calls.clone();
  let replier = engine.clone();
  let callback = Rc::new(move |seq: &str, params: &str| {
    sink.borrow_mut().push(serde_json::from_str(params).unwrap_or(Value::Null));
    replier.return_value(seq, 0, "");
  });
  assert_eq!(engine.bind(name, callback), ErrorCode::Ok, "bind {name}");
  calls
}

/// Serves `html` as `index.html` and navigates to it.
fn open_page(engine: &Engine, html: &str) {
  assert_eq!(engine.set_asset("index.html", "text/html; charset=utf-8", html.as_bytes().to_vec()), ErrorCode::Ok);
  engine.navigate(&format!("{ORIGIN}/index.html"));
}

/// The path of a request URL, without its query or fragment.
fn path_of(url: &str) -> String {
  let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
  let path = rest.find('/').map_or("/", |at| &rest[at..]);
  path.split(['?', '#']).next().unwrap_or(path).to_owned()
}

/// Answers request `id` of `engine` with `status` and `body`, as the binding's `completeRequest`.
fn complete(engine: &Engine, id: u64, status: i32, content_type: Option<&str>, body: &[u8]) -> ErrorCode {
  let headers = content_type.map(|kind| json!({ "Content-Type": kind }).to_string());
  engine::responder(engine.id()).map_or(ErrorCode::InvalidState, |responder| responder.complete(id, status, headers.as_deref(), Some(body)))
}

/// What a destroyed webview answers to the calls a handler might still make.
fn calls_after_destroy(engine: &Engine) -> Codes {
  (engine.set_request_handler(None), engine.set_file_drop_handler(None), engine.bind("late", Rc::new(|_, _| {})))
}

/// `set_request_handler`, `set_file_drop_handler` and `bind`, in that order.
type Codes = (ErrorCode, ErrorCode, ErrorCode);

const DESTROYED: Codes = (ErrorCode::InvalidState, ErrorCode::InvalidState, ErrorCode::InvalidState);

/// What a handler saw of its webview from inside its call, once it had destroyed it.
type Inside<T> = Rc<Cell<Option<T>>>;

// ---- the window, read back from the OS -------------------------------------------------

fn exists(window: isize) -> bool {
  BorrowedWindow::with_handle_value(window, |_| ()).is_some()
}

fn visible(window: isize) -> bool {
  BorrowedWindow::with_handle_value(window, |w| sweetview_platform_window::is_visible(w)) == Some(true)
}

fn style(window: isize) -> u32 {
  BorrowedWindow::with_handle_value(window, |w| sweetview_platform_window::style(w)).unwrap_or(0)
}

/// `dips` device-independent pixels in physical pixels at the window's DPI.
fn physical(window: isize, dips: u32) -> i32 {
  let scale = BorrowedWindow::with_handle_value(window, |w| sweetview_platform_window::dpi_scale(w)).unwrap_or(1.0);
  (f64::from(dips) * scale).round() as i32
}

fn client_is(window: isize, width: u32, height: u32) -> bool {
  support::client_size(window) == (physical(window, width), physical(window, height))
}

/// The outer frame around the client area: outer size minus client size.
fn frame_of(window: isize) -> (i32, i32) {
  let (left, top, right, bottom) = desktop::window_rect(window);
  let (width, height) = support::client_size(window);
  (right - left - width, bottom - top - height)
}

fn shown_window(init: WindowInit) -> Window {
  let window = Window::create(init).expect("window");
  window.show().expect("show");
  window
}

#[test]
fn an_own_window_is_a_real_window_each_size_hint_sizes_styles_or_bounds_and_closing_it_ends_run() {
  with_webviews(|runtime| {
    let tag = format!("sweetview engine os own window {}", std::process::id());
    let engine = Engine::create(false, Host::Own, None).expect("own");
    engine.set_size(500, 400, SizeHint::None);
    engine.set_title(&tag);
    let hwnd = engine.window_handle();
    assert!(exists(hwnd), "the window handle names a window");
    assert_eq!(support::title_of(hwnd), tag, "the title, read back");
    assert!(visible(hwnd), "the first size shows the window");
    assert!(client_is(hwnd, 500, 400), "NONE sizes the client area: {:?}", support::client_size(hwnd));
    assert_ne!(style(hwnd) & WS_THICKFRAME, 0, "NONE leaves it resizable");
    assert_eq!(support::uses_dark_title_bar(hwnd), Some(desktop::system_uses_dark_apps()), "the title bar follows the system's dark mode");

    engine.set_size(450, 350, SizeHint::Fixed);
    assert!(client_is(hwnd, 450, 350), "FIXED sizes the client area: {:?}", support::client_size(hwnd));
    assert_eq!(style(hwnd) & WS_THICKFRAME, 0, "FIXED takes the resize frame away");

    engine.set_size(300, 200, SizeHint::Min);
    assert_ne!(style(hwnd) & WS_THICKFRAME, 0, "MIN gives the resize frame back");
    let frame = frame_of(hwnd);
    let min = support::min_track_size(hwnd);
    assert_eq!(min, (physical(hwnd, 300) + frame.0, physical(hwnd, 200) + frame.1), "MIN is the smallest the user can drag it to");
    engine.set_size(700, 600, SizeHint::Max);
    let max = desktop::max_track_size(hwnd);
    assert_eq!(max, (physical(hwnd, 700) + frame.0, physical(hwnd, 600) + frame.1), "MAX is the largest the user can drag it to");

    let _watch = watchdog(Duration::from_secs(30), "run() after the own window's WM_CLOSE");
    runtime
      .set_timeout(300, move || {
        assert!(support::post(hwnd, WM_CLOSE, 0, 0));
      })
      .expect("timeout");
    engine.run().expect("run");
    assert!(engine.is_destroyed() && Engine::from_id(engine.id()).is_none(), "closing the window destroyed the webview");
    assert!(!exists(hwnd), "the window is gone");
  });
}

#[test]
fn destroy_closes_the_engine_s_own_window_at_once() {
  with_webviews(|_runtime| {
    let engine = own(1024, 768);
    let hwnd = engine.window_handle();
    assert!(visible(hwnd));
    engine.destroy();
    assert!(!exists(hwnd), "gone without a turn of the loop");
  });
}

#[test]
fn a_given_window_is_sized_and_restyled_by_each_hint_never_shown_followed_by_the_page_and_kept_after_destroy() {
  with_webviews(|runtime| {
    let tag = format!("sweetview engine os given window {}", std::process::id());
    let window = Window::create(WindowInit { title: "before".into(), frame: true, resizable: true, bounds: Some(Rect::new(80, 80, 300, 200)), ..Default::default() }).expect("window");
    let hwnd = window.handle();
    let engine = Engine::create(false, Host::Fill(hwnd), None).expect("fill");
    engine.set_size(420, 260, SizeHint::None);
    assert_eq!(engine.window_handle(), hwnd, "the webview names the window it was given");
    assert!(!visible(hwnd), "a size never shows a given window");
    assert!(client_is(hwnd, 420, 260), "NONE sizes the client area: {:?}", support::client_size(hwnd));
    assert_eq!(style(hwnd) & (WS_THICKFRAME | WS_MAXIMIZEBOX), WS_THICKFRAME | WS_MAXIMIZEBOX, "NONE: resizable and maximisable");
    engine.set_title(&tag);
    assert_eq!(support::title_of(hwnd), tag);

    engine.set_size(400, 250, SizeHint::Fixed);
    assert!(client_is(hwnd, 400, 250), "FIXED sizes the client area");
    assert_eq!(style(hwnd) & (WS_THICKFRAME | WS_MAXIMIZEBOX), 0, "FIXED: no resize frame, no maximise box");
    // MIN and MAX change the style only: the C++ library kept the bound for its own window.
    engine.set_size(100, 100, SizeHint::Min);
    assert!(client_is(hwnd, 400, 250) && style(hwnd) & WS_THICKFRAME != 0, "MIN restyles and leaves the size");
    engine.set_size(900, 900, SizeHint::Max);
    assert!(client_is(hwnd, 400, 250), "MAX leaves the size");
    engine.set_size(400, 250, SizeHint::Fixed);

    // The page fills the window and follows a later size.
    let widths = record(&engine, "width");
    engine.set_html(
      "<!doctype html><body><script>window.width(Math.round(innerWidth)); let last = innerWidth; \
       addEventListener('resize', () => { if (innerWidth !== last) { last = innerWidth; window.width(Math.round(innerWidth)); } });</script></body>",
    );
    window.show().expect("show");
    let saw = |width: i64| widths.borrow().iter().any(|w| w[0].as_i64().is_some_and(|w| (w - width).abs() <= 1));
    assert!(pump_until(runtime, Duration::from_secs(20), || saw(400)), "the page is 400 wide: {:?}", widths.borrow());
    engine.set_size(500, 300, SizeHint::None);
    assert!(pump_until(runtime, Duration::from_secs(10), || saw(500)), "the page followed to 500: {:?}", widths.borrow());

    engine.destroy();
    settle(runtime, Duration::from_millis(100));
    assert!(engine.is_destroyed());
    assert!(exists(hwnd), "the application's window stays");
  });
}

// ---- content and bindings ----------------------------------------------------------------

#[test]
fn init_runs_before_the_page_s_scripts_in_every_later_document_and_a_binding_may_unbind_itself() {
  with_webviews(|runtime| {
    let engine = own(480, 320);
    engine.init("window.__init = { seenAt: document.readyState, scripts: document.scripts.length, href: location.href };");
    let page_script = "<script>window.page({ init: window.__init || null, href: location.href });</script>";
    for (file, title) in [("a.html", "A"), ("b.html", "B")] {
      let html = format!("<!doctype html><title>{title}</title>{page_script}");
      assert_eq!(engine.set_asset(file, "text/html; charset=utf-8", html.into_bytes()), ErrorCode::Ok);
    }
    let calls_page = format!(
      "<!doctype html><title>C</title>{page_script}<script>(async () => {{ const r = {{}}; r.gone = await window.gone(); \
       await new Promise((res) => setTimeout(res, 100)); r.goneAfterUnbind = typeof window.gone; window.callsDone(r); }})();</script>"
    );
    let pages: Rc<RefCell<Vec<Value>>> = Rc::default();
    {
      let (sink, navigator) = (pages.clone(), engine.clone());
      let callback = Rc::new(move |seq: &str, params: &str| {
        sink.borrow_mut().push(serde_json::from_str::<Value>(params).map(|args| args[0].clone()).unwrap_or(Value::Null));
        navigator.return_value(seq, 0, "");
        match sink.borrow().len() {
          1 => navigator.navigate(&format!("{ORIGIN}/b.html")),
          2 => navigator.set_html(&calls_page),
          _ => {}
        }
      });
      assert_eq!(engine.bind("page", callback), ErrorCode::Ok);
    }
    let gone_calls = Rc::new(Cell::new(0u32));
    let unbound_inside = Rc::new(Cell::new(None));
    {
      let (count, unbound, binding) = (gone_calls.clone(), unbound_inside.clone(), engine.clone());
      let callback = Rc::new(move |seq: &str, _params: &str| {
        count.set(count.get() + 1);
        unbound.set(Some(binding.unbind("gone")));
        binding.return_value(seq, 0, "\"bye\"");
      });
      assert_eq!(engine.bind("gone", callback), ErrorCode::Ok);
    }
    assert_eq!(engine.bind("page", Rc::new(|_, _| {})), ErrorCode::Duplicate, "a duplicate name");
    assert_eq!(engine.unbind("never"), ErrorCode::NotFound, "an unknown name");
    let done = record(&engine, "callsDone");
    let evaluated = record(&engine, "evaluated");
    engine.navigate(&format!("{ORIGIN}/a.html"));

    assert!(pump_until(runtime, Duration::from_secs(30), || !done.borrow().is_empty()), "the third page ran its calls: {:?}", pages.borrow());
    let hrefs = [format!("{ORIGIN}/a.html"), format!("{ORIGIN}/b.html"), "about:blank".to_owned()];
    let pages = pages.borrow().clone();
    assert_eq!(pages.len(), 3, "{pages:?}");
    for (page, href) in pages.iter().zip(&hrefs) {
      assert_eq!(page["href"], href.as_str());
      assert_eq!(page["init"], json!({ "seenAt": "loading", "scripts": 0, "href": href }), "init ran before the page's own scripts");
    }
    assert_eq!(done.borrow()[0][0], json!({ "gone": "bye", "goneAfterUnbind": "undefined" }), "unbound from inside its own call: the page's function is gone");
    assert_eq!((gone_calls.get(), unbound_inside.get()), (1, Some(ErrorCode::Ok)));
    assert_eq!(engine.unbind("gone"), ErrorCode::NotFound, "already unbound");

    engine.eval("window.evaluated(document.title, 6 * 7)");
    assert!(pump_until(runtime, Duration::from_secs(10), || !evaluated.borrow().is_empty()), "eval reached the page");
    assert_eq!(evaluated.borrow()[0], json!(["C", 42]), "eval runs in the current document");
    engine.destroy();
  });
}

#[test]
fn background_alpha_other_than_0_or_255_is_refused_and_a_destroyed_webview_refuses_every_setting() {
  with_webviews(|_runtime| {
    let engine = own(300, 200);
    assert_eq!(engine.set_background_color(0, 0, 0, 0), ErrorCode::Ok, "transparent");
    assert_eq!(engine.set_background_color(255, 255, 255, 255), ErrorCode::Ok, "opaque");
    for alpha in [1, 128, 254] {
      assert_eq!(engine.set_background_color(0, 0, 0, alpha), ErrorCode::Unspecified, "alpha {alpha}");
    }
    engine.destroy();
    assert_eq!(engine.set_background_color(0, 0, 0, 0), ErrorCode::InvalidState, "background after destroy");
    assert_eq!(engine.set_asset("late.txt", "text/plain", b"late".to_vec()), ErrorCode::InvalidState, "asset after destroy");
  });
}

// ---- a page loading from a server on another thread -----------------------------------------

/// What each address of a [`PageServer`] answers: the page `name` (its path without the slash)
/// reports what it sees to `ready`.
fn in_flight_page(name: &str) -> String {
  format!(
    "<!doctype html><title>{name}</title><script>(async () => {{ \
     const r = {{ page: {name:?}, during: typeof window.during, early: typeof window.early, init: window.__initDuring === true }}; \
     if (r.during === 'function') r.duringResult = await window.during('x'); window.ready(r); }})();</script>"
  )
}

/// An HTTP server on another thread, so the engine waits on WebView2 while a page loads from it.
/// Each address answers [`in_flight_page`] after `delay`; the address `hold` waits until
/// [`PageServer::release`] (or the server's drop).
struct PageServer {
  origin: String,
  requested: mpsc::Receiver<String>,
  gate: Arc<(Mutex<bool>, Condvar)>,
  stop: Arc<AtomicBool>,
  listener: Option<JoinHandle<()>>,
}

impl PageServer {
  fn start(delay: Duration, hold: &'static str) -> Self {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    listener.set_nonblocking(true).expect("nonblocking");
    let (seen, requested) = mpsc::channel();
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let (gate_for, stop_for) = (gate.clone(), stop.clone());
    let accepting = thread::spawn(move || {
      while !stop_for.load(Ordering::SeqCst) {
        match listener.accept() {
          Ok((stream, _)) => {
            let (seen, gate) = (seen.clone(), gate_for.clone());
            thread::spawn(move || serve(stream, &seen, &gate, delay, hold));
          }
          Err(_) => thread::sleep(Duration::from_millis(5)),
        }
      }
    });
    Self { origin, requested, gate, stop, listener: Some(accepting) }
  }

  /// Pumps `runtime` until the server has been asked for `path`.
  fn wait_for_request(&self, runtime: &Runtime, path: &str) -> bool {
    pump_until(runtime, Duration::from_secs(20), || self.requested.try_iter().any(|seen| seen == path))
  }

  fn release(&self) {
    let (open, wake) = &*self.gate;
    *open.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
    wake.notify_all();
  }
}

impl Drop for PageServer {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::SeqCst);
    self.release();
    if let Some(listener) = self.listener.take() {
      let _ = listener.join();
    }
  }
}

fn serve(mut stream: TcpStream, seen: &mpsc::Sender<String>, gate: &(Mutex<bool>, Condvar), delay: Duration, hold: &str) {
  let _ = stream.set_nonblocking(false);
  let mut head = Vec::new();
  let mut buffer = [0u8; 2048];
  while !head.windows(4).any(|w| w == b"\r\n\r\n") {
    match stream.read(&mut buffer) {
      Ok(0) | Err(_) => return,
      Ok(read) => head.extend_from_slice(&buffer[..read]),
    }
  }
  let head = String::from_utf8_lossy(&head);
  let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
  let _ = seen.send(path.clone());
  let (status, body) = if path == "/favicon.ico" {
    ("404 Not Found", String::new())
  } else {
    thread::sleep(delay);
    if path == hold {
      let (open, wake) = gate;
      let mut open = open.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
      while !*open {
        open = wake.wait(open).unwrap_or_else(std::sync::PoisonError::into_inner);
      }
    }
    ("200 OK", in_flight_page(path.trim_start_matches('/')))
  };
  let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

/// What runs after each page of the in-flight tests reports.
type OnPage = Rc<RefCell<Option<Rc<dyn Fn(&Value)>>>>;

/// The bindings of the in-flight tests: `ready` keeps each page's report and then runs the
/// [`OnPage`] hook, and `early` is there to be removed.
fn in_flight_engine() -> (Engine, Rc<RefCell<Vec<Value>>>, OnPage) {
  let engine = own(400, 300);
  let pages: Rc<RefCell<Vec<Value>>> = Rc::default();
  let on_page: OnPage = Rc::default();
  let (sink, hook, replier) = (pages.clone(), on_page.clone(), engine.clone());
  let ready = Rc::new(move |seq: &str, params: &str| {
    let report = serde_json::from_str::<Value>(params).map(|args| args[0].clone()).unwrap_or(Value::Null);
    sink.borrow_mut().push(report.clone());
    replier.return_value(seq, 0, "");
    let hook = hook.borrow().clone();
    if let Some(hook) = hook {
      hook(&report);
    }
  });
  assert_eq!(engine.bind("ready", ready), ErrorCode::Ok);
  assert_eq!(engine.bind("early", Rc::new(|_, _| {})), ErrorCode::Ok);
  (engine, pages, on_page)
}

/// The three calls made while a navigation waits for its response.
fn calls_during_load(engine: &Engine) {
  let replier = engine.clone();
  let during = Rc::new(move |seq: &str, params: &str| {
    let x: Value = serde_json::from_str(params).unwrap_or(Value::Null);
    replier.return_value(seq, 0, &json!(format!("during:{}", x[0].as_str().unwrap_or("?"))).to_string());
  });
  assert_eq!(engine.bind("during", during), ErrorCode::Ok);
  engine.init("window.__initDuring = true");
  assert_eq!(engine.unbind("early"), ErrorCode::Ok);
}

/// The next document has the binding made during the load (and it answers), the init script,
/// and not the binding removed during it.
fn assert_next_document(next: &Value) {
  assert_eq!(*next, json!({ "page": "second", "during": "function", "early": "undefined", "init": true, "duringResult": "during:x" }));
}

#[test]
fn bind_init_and_unbind_while_a_page_waits_for_its_server_reach_the_next_document_under_a_pumped_loop() {
  with_webviews(|runtime| {
    let server = PageServer::start(Duration::ZERO, "/first");
    let (engine, pages, _on_page) = in_flight_engine();
    engine.navigate(&format!("{}/first", server.origin));
    assert!(server.wait_for_request(runtime, "/first"), "WebView2 asked the server for /first");
    calls_during_load(&engine);
    server.release();
    assert!(pump_until(runtime, Duration::from_secs(20), || pages.borrow().iter().any(|p| p["page"] == "first")), "the first page loaded: {:?}", pages.borrow());
    let before = pages.borrow().len();
    engine.navigate(&format!("{}/second", server.origin));
    assert!(pump_until(runtime, Duration::from_secs(20), || pages.borrow().len() > before), "the second page loaded");
    assert_next_document(&pages.borrow()[before]);
    engine.destroy();
  });
}

#[test]
fn bind_init_and_unbind_while_a_page_waits_for_its_server_reach_the_next_document_under_the_blocking_run() {
  with_webviews(|runtime| {
    // The server never answers /first while run() runs: the calls are made from a timeout
    // inside run(), and the next document is set as HTML.
    let server = PageServer::start(Duration::ZERO, "/first");
    let (engine, pages, on_page) = in_flight_engine();
    engine.navigate(&format!("{}/first", server.origin));
    let asked = Rc::new(Cell::new(false));
    {
      let (engine_in, runtime_in, asked) = (engine.clone(), runtime.clone(), asked.clone());
      runtime
        .set_timeout(1_000, move || {
          asked.set(true);
          calls_during_load(&engine_in);
          let (ender, runtime_in) = (engine_in.clone(), runtime_in.clone());
          *on_page.borrow_mut() = Some(Rc::new(move |report: &Value| {
            if report["page"] == "second" {
              ender.destroy();
              runtime_in.request_exit();
            }
          }));
          engine_in.set_html(&in_flight_page("second"));
        })
        .expect("timeout");
    }
    let _watch = watchdog(Duration::from_secs(40), "the blocking run with a navigation in flight");
    engine.run().expect("run");
    assert!(asked.get(), "the calls were made inside run()");
    assert!(server.requested.try_iter().any(|path| path == "/first"), "WebView2 had asked the server for /first");
    let next = pages.borrow().iter().find(|p| p["page"] == "second").cloned().expect("the second document reported");
    assert_next_document(&next);
  });
}

#[test]
fn a_script_asked_for_right_after_navigating_to_a_slow_server_and_binding_runs_in_the_new_document() {
  with_webviews(|runtime| {
    let server = PageServer::start(Duration::from_millis(500), "");
    let engine = own(400, 300);
    engine.navigate(&format!("{}/first", server.origin));
    let answers = record(&engine, "answer");
    engine.eval("answer(document.title)");
    assert!(pump_until(runtime, Duration::from_secs(15), || !answers.borrow().is_empty()), "the script answered");
    assert_eq!(answers.borrow()[0], json!(["first"]), "from the document the navigation made");
    engine.destroy();
  });
}

#[test]
fn a_script_asked_for_right_after_set_html_and_binding_runs_in_the_new_document_under_the_blocking_run() {
  with_webviews(|runtime| {
    let engine = own(400, 300);
    engine.set_html(&in_flight_page("first"));
    let answers: Rc<RefCell<Vec<Value>>> = Rc::default();
    {
      let (sink, engine_in, runtime_in) = (answers.clone(), engine.clone(), runtime.clone());
      let answer = Rc::new(move |_seq: &str, params: &str| {
        sink.borrow_mut().push(serde_json::from_str(params).unwrap_or(Value::Null));
        engine_in.destroy();
        runtime_in.request_exit();
      });
      assert_eq!(engine.bind("answer", answer), ErrorCode::Ok);
    }
    engine.eval("answer(document.title)");
    let limit = runtime.clone();
    runtime.set_timeout(10_000, move || limit.request_exit()).expect("timeout");
    let _watch = watchdog(Duration::from_secs(30), "the blocking run of the eval test");
    engine.run().expect("run");
    assert_eq!(answers.borrow().first(), Some(&json!(["first"])), "answered from the new document: {:?}", answers.borrow());
  });
}

// ---- the screen ------------------------------------------------------------------------------

#[test]
fn a_transparent_page_shows_the_window_behind_it_on_the_screen_and_an_opaque_background_hides_it() {
  with_webviews(|runtime| {
    let tag = format!("sweetview engine os transparency {}", std::process::id());
    let (x, y, width, height) = (120, 120, 320, 240);
    let back = shown_window(WindowInit {
      title: format!("{tag} back"),
      bounds: Some(Rect::new(x - 40, y - 40, width + 80, height + 80)),
      topmost: true,
      no_activate: true,
      ..Default::default()
    });
    let back_view = Engine::create(false, Host::Fill(back.handle()), None).expect("back");
    let back_painted = record(&back_view, "painted");
    back_view.set_html("<!doctype html><body style='margin:0;background:#00ff00'><script>requestAnimationFrame(() => requestAnimationFrame(() => window.painted()));</script></body>");
    let front = shown_window(WindowInit { title: format!("{tag} front"), bounds: Some(Rect::new(x, y, width, height)), transparent: true, topmost: true, no_activate: true, ..Default::default() });
    let front_view = Engine::create(false, Host::Fill(front.handle()), None).expect("front");
    assert_eq!(front_view.set_background_color(0, 0, 0, 0), ErrorCode::Ok);
    let front_painted = record(&front_view, "painted");
    front_view.set_html(
      "<!doctype html><html style='background:transparent'><body style='margin:0;background:transparent'>\
       <div style='position:absolute;left:0;top:0;width:40px;height:40px;background:#ff0000'></div>\
       <script>requestAnimationFrame(() => requestAnimationFrame(() => window.painted()));</script></body></html>",
    );
    assert!(pump_until(runtime, Duration::from_secs(20), || !back_painted.borrow().is_empty() && !front_painted.borrow().is_empty()), "both pages painted");
    // Give the compositor a few frames.
    settle(runtime, Duration::from_millis(600));
    let ours = [front.handle(), back.handle()];
    let sample = |what: &str| {
      let (left, top, right, bottom) = desktop::window_rect(front.handle());
      let centre = (left + (right - left) / 2, top + (bottom - top) / 2);
      let square = (left + 10, top + 10);
      for (name, (px, py)) in [("centre", centre), ("square", square)] {
        let there = desktop::top_level_at(px, py);
        if !ours.contains(&there) {
          refuse_to_judge(&format!("{what}: the {name} ({px}, {py}) is covered by {:?}", support::title_of(there)));
        }
      }
      (support::screen_pixel(centre.0, centre.1), support::screen_pixel(square.0, square.1))
    };
    let (centre, square) = sample("transparent");
    assert_eq!(centre, Some(0x00ff00), "the green window behind shows through the transparent page: {centre:x?}");
    assert_eq!(square, Some(0xff0000), "the page's own red square is drawn: {square:x?}");

    assert_eq!(front_view.set_background_color(0, 0, 255, 255), ErrorCode::Ok);
    front_view.eval("document.body.style.outline = '1px solid transparent'");
    settle(runtime, Duration::from_millis(600));
    let (centre, square) = sample("opaque blue");
    assert_ne!(centre, Some(0x00ff00), "an opaque background colour hides the window behind: {centre:x?}");
    assert_eq!(square, Some(0xff0000), "the square is still drawn: {square:x?}");
    front_view.destroy();
    back_view.destroy();
  });
}

// ---- requests ---------------------------------------------------------------------------------

/// A page that fetches each path in turn and reports `[{path, status, body}]` to `done`.
fn page_fetching(paths: &[&str]) -> String {
  format!(
    "<!doctype html><body><script>(async () => {{ const r = []; for (const p of {}) {{ \
     try {{ const resp = await fetch(p); r.push({{ path: p, status: resp.status, body: await resp.text() }}); }} \
     catch (e) {{ r.push({{ path: p, error: String(e) }}); }} }} window.done(r); }})();</script></body>",
    json!(paths)
  )
}

#[test]
fn destroy_from_inside_run_with_a_request_pending_and_a_stream_open_releases_both_and_run_returns() {
  with_webviews(|runtime| {
    let engine = own(300, 200);
    let open: Rc<RefCell<Vec<u64>>> = Rc::default();
    let held = Rc::new(RefCell::new(None));
    {
      let (open, held, engine_in, runtime_in) = (open.clone(), held.clone(), engine.clone(), runtime.clone());
      let handler = Rc::new(move |request: RawRequest| {
        match path_of(&request.url).as_str() {
          "/pending" => open.borrow_mut().push(request.id),
          "/streaming" => {
            let responder = engine::responder(engine_in.id()).expect("a live responder");
            assert_eq!(responder.begin(request.id, 200, Some(r#"{"Content-Type":"text/plain"}"#)), ErrorCode::Ok);
            assert_eq!(responder.write_chunk(request.id, b"partial"), ErrorCode::Ok);
            *held.borrow_mut() = Some(responder);
            open.borrow_mut().push(request.id);
          }
          _ => {}
        }
        if open.borrow().len() == 2 {
          let (engine_in, runtime_in) = (engine_in.clone(), runtime_in.clone());
          runtime_in
            .clone()
            .set_timeout(200, move || {
              engine_in.destroy();
              runtime_in.request_exit();
            })
            .expect("timeout");
        }
      });
      assert_eq!(engine.set_request_handler(Some(handler)), ErrorCode::Ok);
    }
    engine.set_html(&format!("<!doctype html><script>fetch('{ORIGIN}/pending').catch(() => {{}}); fetch('{ORIGIN}/streaming').catch(() => {{}});</script>"));
    let _watch = watchdog(Duration::from_secs(30), "run() with requests open at destroy");
    engine.run().expect("run");
    assert_eq!(open.borrow().len(), 2, "one pending and one streaming at destroy");
    assert!(engine::responder(engine.id()).is_none(), "the destroyed webview's handle answers nothing");
    let held = held.borrow_mut().take().expect("the streaming request's responder");
    for &id in open.borrow().iter() {
      assert_eq!(held.complete(id, 200, None, Some(b"late")), ErrorCode::InvalidState, "a late answer to {id}");
      assert_eq!(held.write_chunk(id, b"late"), ErrorCode::InvalidState, "a late chunk to {id}");
    }
  });
}

#[test]
fn a_thread_answering_while_the_webview_is_destroyed_is_accepted_until_its_first_refusal_and_refused_ever_after() {
  with_webviews(|runtime| {
    let engine = own(300, 200);
    let id = engine.id();
    let stop = Arc::new(AtomicBool::new(false));
    type Racers = Rc<RefCell<Vec<(&'static str, JoinHandle<Vec<ErrorCode>>)>>>;
    let racers: Racers = Rc::default();
    {
      let (stop, racers, engine_in, runtime_in) = (stop.clone(), racers.clone(), engine.clone(), runtime.clone());
      let handler = Rc::new(move |request: RawRequest| {
        let stream = path_of(&request.url) == "/stream";
        let (stop, rid) = (stop.clone(), request.id);
        // Each call looks the webview up by its handle, as the binding's functions do.
        let call = move |f: &dyn Fn(&sweetview_platform_webview::Responder) -> ErrorCode| engine::responder(id).map_or(ErrorCode::InvalidState, |r| f(&r));
        let racer = thread::spawn(move || {
          let mut codes = Vec::new();
          if stream {
            codes.push(call(&|r| r.begin(rid, 200, Some(r#"{"Content-Type":"text/plain"}"#))));
          }
          while !stop.load(Ordering::SeqCst) && codes.len() < 100_000 {
            codes.push(if stream { call(&|r| r.write_chunk(rid, b"chunk ")) } else { call(&|r| r.complete(rid, 200, None, Some(b"x"))) });
            if codes.len() % 50 == 0 {
              thread::sleep(Duration::from_millis(1));
            }
          }
          codes
        });
        racers.borrow_mut().push((if stream { "stream" } else { "complete" }, racer));
        if racers.borrow().len() == 2 {
          let (engine_in, runtime_in) = (engine_in.clone(), runtime_in.clone());
          runtime_in
            .clone()
            .set_timeout(300, move || {
              engine_in.destroy();
              runtime_in.request_exit();
            })
            .expect("timeout");
        }
      });
      assert_eq!(engine.set_request_handler(Some(handler)), ErrorCode::Ok);
    }
    engine.set_html(&format!("<!doctype html><script>fetch('{ORIGIN}/stream').catch(() => {{}}); fetch('{ORIGIN}/complete').catch(() => {{}});</script>"));
    let _watch = watchdog(Duration::from_secs(30), "run() with racing threads");
    engine.run().expect("run");
    stop.store(true, Ordering::SeqCst);
    let racers: Vec<_> = racers.borrow_mut().drain(..).collect();
    assert_eq!(racers.len(), 2);
    for (what, racer) in racers {
      let codes = racer.join().expect("a racing thread");
      let first_refused = codes.iter().position(|c| *c == ErrorCode::InvalidState);
      assert!(codes.len() > 1, "{what}: {} calls", codes.len());
      let first_refused = first_refused.unwrap_or_else(|| panic!("{what}: no call was refused in {} calls", codes.len()));
      assert!(first_refused > 0, "{what}: accepted before the destroy");
      assert!(codes[..first_refused].iter().all(|c| *c == ErrorCode::Ok), "{what}: every call before the first refusal went through");
      assert!(codes[first_refused..].iter().all(|c| *c == ErrorCode::InvalidState), "{what}: once refused, always refused");
    }
  });
}

#[test]
fn a_frame_from_the_frames_origin_is_isolated_from_the_page_and_its_posts_run_no_binding_but_its_own_subresources_load() {
  with_webviews(|runtime| {
    let engine = own(800, 600);
    let escaped = Rc::new(Cell::new(false));
    {
      let escaped = escaped.clone();
      assert_eq!(engine.bind("iframeProbe", Rc::new(move |_, _| escaped.set(true))), ErrorCode::Ok);
    }
    let reports = record(&engine, "report");
    let urls: Rc<RefCell<Vec<String>>> = Rc::default();
    let page = format!(
      "<!doctype html><body><script>window.addEventListener('message', (e) => {{ \
       let access; try {{ access = typeof document.getElementById('frame').contentWindow.document; }} catch (err) {{ access = 'blocked:' + err.name; }} \
       window.report({{ eventOrigin: e.origin, probe: e.data, access }}); }});</script>\
       <iframe id='frame' src='{FRAMES}/sandbox.html'></iframe></body>"
    );
    let sandbox = format!(
      "<!doctype html><body>sandbox<script>(async () => {{ const r = {{ origin: window.origin, href: location.href }}; \
       r.hasBridge = typeof window.__webview__ !== 'undefined' || typeof window.iframeProbe !== 'undefined' || typeof window.report !== 'undefined'; \
       try {{ void parent.document; r.parentDocBlocked = 'allowed'; }} catch (e) {{ r.parentDocBlocked = e.name; }} \
       try {{ await fetch('{ORIGIN}/asset.txt'); r.crossOriginFetchBlocked = 'allowed'; }} catch {{ r.crossOriginFetchBlocked = 'blocked'; }} \
       const probe = JSON.stringify({{ id: '999', method: 'iframeProbe', params: [] }}); r.rawPostAttempted = []; \
       try {{ if (window.chrome?.webview?.postMessage) {{ window.chrome.webview.postMessage(probe); r.rawPostAttempted.push('chrome.webview'); }} }} \
       catch (e) {{ r.rawPostAttempted.push('chrome.webview:' + e.name); }} \
       const resp = await fetch('/frame-data.json'); r.subresourceStatus = resp.status; r.subresourceLoaded = await resp.json(); \
       parent.postMessage(r, '*'); }})();</script></body>"
    );
    {
      let (urls, engine_in) = (urls.clone(), engine.clone());
      let handler = Rc::new(move |request: RawRequest| {
        urls.borrow_mut().push(request.url.clone());
        let frames = request.url.starts_with(&format!("{FRAMES}/"));
        let (status, kind, body) = match (frames, path_of(&request.url).as_str()) {
          (false, "/index.html") => (200, Some("text/html; charset=utf-8"), page.clone()),
          (false, "/asset.txt") => (200, Some("text/plain"), "asset-text".to_owned()),
          (true, "/sandbox.html") => (200, Some("text/html; charset=utf-8"), sandbox.clone()),
          (true, "/frame-data.json") => (200, Some("application/json"), json!({ "frameData": "frame-ok" }).to_string()),
          _ => (404, None, String::new()),
        };
        complete(&engine_in, request.id, status, kind, body.as_bytes());
      });
      assert_eq!(engine.set_request_handler(Some(handler)), ErrorCode::Ok);
    }
    engine.navigate(&format!("{ORIGIN}/index.html"));
    assert!(pump_until(runtime, Duration::from_secs(30), || !reports.borrow().is_empty()), "the frame reported");
    settle(runtime, Duration::from_millis(300));
    let report = reports.borrow()[0][0].clone();
    let probe = &report["probe"];
    assert_eq!(report["eventOrigin"], FRAMES, "{report}");
    assert_eq!(probe["origin"], FRAMES, "the frame is on the frames origin: {report}");
    assert_eq!(probe["href"], format!("{FRAMES}/sandbox.html"));
    assert!(report["access"].as_str().is_some_and(|a| a.starts_with("blocked:")), "the page cannot reach the frame's document: {report}");
    assert_eq!(probe["hasBridge"], false, "no bridge and no bound functions in the frame: {report}");
    assert_eq!(probe["parentDocBlocked"], "SecurityError", "no access to the parent document");
    assert_eq!(probe["crossOriginFetchBlocked"], "blocked", "no CORS read of the main origin");
    assert!(probe["rawPostAttempted"].is_array(), "{report}");
    assert!(!escaped.get(), "a raw RPC post from the frame ran no binding");
    assert_eq!((probe["subresourceStatus"].clone(), probe["subresourceLoaded"].clone()), (json!(200), json!({ "frameData": "frame-ok" })), "its own subresources load");
    assert!(urls.borrow().iter().any(|u| *u == format!("{FRAMES}/frame-data.json")), "{:?}", urls.borrow());
    engine.destroy();
  });
}

// ---- handlers changing from inside their own calls ----------------------------------------------

#[test]
fn the_request_handler_replaces_itself_then_the_replacement_clears_itself() {
  with_webviews(|runtime| {
    let engine = own(400, 300);
    let calls: Rc<RefCell<Vec<String>>> = Rc::default();
    let html = page_fetching(&["/a", "/b", "/c"]);
    let handler_b: Rc<dyn Fn(RawRequest)> = {
      let (calls, engine_in) = (calls.clone(), engine.clone());
      Rc::new(move |request: RawRequest| {
        let path = path_of(&request.url);
        calls.borrow_mut().push(format!("B{path}"));
        if path == "/b" {
          assert_eq!(engine_in.set_request_handler(None), ErrorCode::Ok);
          complete(&engine_in, request.id, 200, None, b"from-B");
        } else {
          complete(&engine_in, request.id, 500, None, b"");
        }
      })
    };
    {
      let (calls, engine_in) = (calls.clone(), engine.clone());
      let handler_a = Rc::new(move |request: RawRequest| {
        let path = path_of(&request.url);
        calls.borrow_mut().push(format!("A{path}"));
        match path.as_str() {
          "/index.html" => complete(&engine_in, request.id, 200, Some("text/html; charset=utf-8"), html.as_bytes()),
          "/a" => {
            assert_eq!(engine_in.set_request_handler(Some(handler_b.clone())), ErrorCode::Ok);
            complete(&engine_in, request.id, 200, None, b"from-A")
          }
          _ => complete(&engine_in, request.id, 500, None, b""),
        };
      });
      assert_eq!(engine.set_request_handler(Some(handler_a)), ErrorCode::Ok);
    }
    let done = record(&engine, "done");
    engine.navigate(&format!("{ORIGIN}/index.html"));
    assert!(pump_until(runtime, Duration::from_secs(20), || !done.borrow().is_empty()), "the page finished");
    let results = done.borrow()[0][0].clone();
    assert_eq!(results[0], json!({ "path": "/a", "status": 200, "body": "from-A" }));
    assert_eq!(results[1], json!({ "path": "/b", "status": 200, "body": "from-B" }));
    assert_eq!((results[2]["path"].clone(), results[2]["status"].clone()), (json!("/c"), json!(404)), "no handler: 404: {results}");
    let calls = calls.borrow();
    assert!(calls.contains(&"A/a".to_owned()) && calls.contains(&"B/b".to_owned()), "{calls:?}");
    assert!(!calls.contains(&"A/b".to_owned()), "/b went to the replacement: {calls:?}");
    assert!(!calls.iter().any(|c| c.ends_with("/c")), "/c went to neither: {calls:?}");
    engine.destroy();
  });
}

#[test]
fn the_request_handler_destroys_the_webview_from_inside_web_resource_requested_without_hanging() {
  with_webviews(|runtime| {
    let engine = own(400, 300);
    let html = page_fetching(&["/destroy", "/after"]);
    let destroyed = Rc::new(Cell::new(false));
    let calls_after = Rc::new(Cell::new(0u32));
    let inside: Inside<(ErrorCode, Codes)> = Rc::default();
    {
      let (destroyed, calls_after, inside, engine_in, runtime_in) = (destroyed.clone(), calls_after.clone(), inside.clone(), engine.clone(), runtime.clone());
      let handler = Rc::new(move |request: RawRequest| {
        if destroyed.get() {
          calls_after.set(calls_after.get() + 1);
          return;
        }
        match path_of(&request.url).as_str() {
          "/index.html" => {
            complete(&engine_in, request.id, 200, Some("text/html; charset=utf-8"), html.as_bytes());
          }
          "/destroy" => {
            destroyed.set(true);
            engine_in.destroy();
            inside.set(Some((complete(&engine_in, request.id, 200, None, b"too late"), calls_after_destroy(&engine_in))));
            runtime_in.request_exit();
          }
          _ => {
            complete(&engine_in, request.id, 404, None, b"");
          }
        }
      });
      assert_eq!(engine.set_request_handler(Some(handler)), ErrorCode::Ok);
    }
    let finished = record(&engine, "done");
    engine.navigate(&format!("{ORIGIN}/index.html"));
    let _watch = watchdog(Duration::from_secs(30), "run() after a destroy inside WebResourceRequested");
    engine.run().expect("run");
    assert!(destroyed.get(), "the handler destroyed the webview");
    assert_eq!(inside.get(), Some((ErrorCode::InvalidState, DESTROYED)), "destroyed at once, inside the call");
    assert_eq!(calls_after_destroy(&engine), DESTROYED, "and after run()");
    settle(runtime, Duration::from_millis(300));
    assert_eq!(calls_after.get(), 0, "nothing reached the handler once it had destroyed the webview");
    assert!(finished.borrow().is_empty(), "the page never finished");
  });
}

/// Files for real drops, in a folder of this process's own.
fn drop_files(names: &[&str]) -> Vec<String> {
  let folder = std::env::temp_dir().join(format!("sweetview-runtime-drops-{}", std::process::id()));
  std::fs::create_dir_all(&folder).expect("folder");
  names
    .iter()
    .map(|name| {
      let path = folder.join(format!("{name}.txt"));
      std::fs::write(&path, name).expect("file");
      path.to_string_lossy().into_owned()
    })
    .collect()
}

/// A real file drop of `path` on `engine`, driven through WebView2's DevTools protocol.
fn real_drop(engine: &Engine, path: &str) -> ErrorCode {
  let data = json!({ "items": [], "files": [path], "dragOperationsMask": 1 });
  for kind in ["dragEnter", "dragOver", "drop"] {
    let code = engine.call_devtools_protocol_method("Input.dispatchDragEvent", &json!({ "type": kind, "x": 40, "y": 40, "data": data }).to_string());
    if code != ErrorCode::Ok {
      return code;
    }
  }
  ErrorCode::Ok
}

fn base_names(paths: &[String]) -> String {
  paths.iter().map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p).trim_end_matches(".txt").to_owned()).collect::<Vec<_>>().join(",")
}

#[test]
fn the_file_drop_handler_replaces_itself_clears_itself_and_destroys_the_webview_from_inside_its_call() {
  with_webviews(|runtime| {
    let engine = own(400, 300);
    let files = drop_files(&["one", "two", "three", "four"]);
    let drops: Rc<RefCell<Vec<String>>> = Rc::default();
    let inside: Inside<(Codes, ErrorCode)> = Rc::default();
    let first_drop = Rc::new(Cell::new(None));
    // Each next drop on a later turn, as a person's would be.
    let later = |runtime: &Rc<Runtime>, engine: &Engine, path: &str| {
      let (engine, path) = (engine.clone(), path.to_owned());
      runtime
        .set_timeout(150, move || {
          real_drop(&engine, &path);
        })
        .expect("timeout");
    };
    let handler_c: Rc<dyn Fn(Vec<String>)> = {
      let (drops, inside, engine_in, runtime_in) = (drops.clone(), inside.clone(), engine.clone(), runtime.clone());
      Rc::new(move |paths| {
        drops.borrow_mut().push(format!("C:{}", base_names(&paths)));
        engine_in.destroy();
        inside.set(Some((calls_after_destroy(&engine_in), engine_in.call_devtools_protocol_method("Input.dispatchDragEvent", "{}"))));
        runtime_in.request_exit();
      })
    };
    let handler_b: Rc<dyn Fn(Vec<String>)> = {
      let (drops, engine_in, runtime_in, three) = (drops.clone(), engine.clone(), runtime.clone(), files[2].clone());
      Rc::new(move |paths| {
        drops.borrow_mut().push(format!("B:{}", base_names(&paths)));
        assert_eq!(engine_in.set_file_drop_handler(None), ErrorCode::Ok);
        later(&runtime_in, &engine_in, &three);
      })
    };
    {
      let (drops, engine_in, runtime_in, two) = (drops.clone(), engine.clone(), runtime.clone(), files[1].clone());
      let handler_a = Rc::new(move |paths: Vec<String>| {
        drops.borrow_mut().push(format!("A:{}", base_names(&paths)));
        assert_eq!(engine_in.set_file_drop_handler(Some(handler_b.clone())), ErrorCode::Ok);
        later(&runtime_in, &engine_in, &two);
      });
      assert_eq!(engine.set_file_drop_handler(Some(handler_a)), ErrorCode::Ok);
    }
    {
      // With no handler the page gets the drop.
      let (drops, engine_in, runtime_in, four) = (drops.clone(), engine.clone(), runtime.clone(), files[3].clone());
      let page_drop = Rc::new(move |seq: &str, params: &str| {
        let names: Value = serde_json::from_str(params).unwrap_or(Value::Null);
        let names: Vec<String> = names[0].as_array().map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        drops.borrow_mut().push(format!("page:{}", names.join(",")));
        engine_in.return_value(seq, 0, "");
        assert_eq!(engine_in.set_file_drop_handler(Some(handler_c.clone())), ErrorCode::Ok);
        later(&runtime_in, &engine_in, &four);
      });
      assert_eq!(engine.bind("pageDrop", page_drop), ErrorCode::Ok);
    }
    {
      let (engine_in, first, one) = (engine.clone(), first_drop.clone(), files[0].clone());
      let ready = Rc::new(move |seq: &str, _params: &str| {
        engine_in.return_value(seq, 0, "");
        first.set(Some(real_drop(&engine_in, &one)));
      });
      assert_eq!(engine.bind("ready", ready), ErrorCode::Ok);
    }
    engine.set_html(
      "<!doctype html><html><body style='margin:0;height:100vh'>drop here<script>\
       addEventListener('dragover', (e) => e.preventDefault());\
       addEventListener('drop', (e) => { if (window.__webview_file_drop_enabled__) return; e.preventDefault(); \
       window.pageDrop([...e.dataTransfer.files].map((f) => f.name.replace('.txt', ''))); });\
       window.ready();</script></body></html>",
    );
    let limit = runtime.clone();
    runtime.set_timeout(20_000, move || limit.request_exit()).expect("timeout");
    let _watch = watchdog(Duration::from_secs(40), "run() with drop handlers changing themselves");
    engine.run().expect("run");
    assert_eq!(first_drop.get(), Some(ErrorCode::Ok));
    assert_eq!(*drops.borrow(), ["A:one", "B:two", "page:three", "C:four"], "A handed over to B, B cleared itself, the page got the drop, C destroyed the webview");
    assert_eq!(inside.get(), Some((DESTROYED, ErrorCode::InvalidState)), "destroyed at once, inside the call");
    assert_eq!(calls_after_destroy(&engine), DESTROYED, "and after run()");
  });
}

#[test]
fn a_new_window_handler_replaces_itself_and_the_replacement_clears_itself_and_a_navigation_failed_handler_clears_itself() {
  with_webviews(|runtime| {
    let engine = own(360, 240);
    let calls: Rc<RefCell<Vec<String>>> = Rc::default();
    let replacement: Rc<dyn Fn(String)> = {
      let (calls, engine_in) = (calls.clone(), engine.clone());
      Rc::new(move |_url| {
        calls.borrow_mut().push("B popup".into());
        engine_in.set_new_window_handler(None);
      })
    };
    {
      let (calls, engine_in) = (calls.clone(), engine.clone());
      engine.set_new_window_handler(Some(Rc::new(move |_url| {
        calls.borrow_mut().push("A popup".into());
        engine_in.set_new_window_handler(Some(replacement.clone()));
      })));
    }
    {
      let (calls, engine_in, runtime_in) = (calls.clone(), engine.clone(), runtime.clone());
      let handler = Rc::new(move |_failure: NavigationFailure| {
        calls.borrow_mut().push("navigation failed".into());
        assert_eq!(engine_in.set_navigation_failed_handler(None), ErrorCode::Ok);
        let engine_in = engine_in.clone();
        runtime_in.set_timeout(100, move || engine_in.navigate(&format!("{REFUSED}again"))).expect("timeout");
      });
      assert_eq!(engine.set_navigation_failed_handler(Some(handler)), ErrorCode::Ok);
    }
    {
      let (engine_in, runtime_in) = (engine.clone(), runtime.clone());
      let opened = Rc::new(move |seq: &str, _params: &str| {
        engine_in.return_value(seq, 0, "");
        let engine_in = engine_in.clone();
        runtime_in.set_timeout(300, move || engine_in.navigate(REFUSED)).expect("timeout");
      });
      assert_eq!(engine.bind("opened", opened), ErrorCode::Ok);
    }
    open_page(
      &engine,
      &format!(
        "<!doctype html><body><script>(async () => {{ window.open('{ORIGIN}/one'); await new Promise((r) => setTimeout(r, 200)); \
         window.open('{ORIGIN}/two'); await new Promise((r) => setTimeout(r, 200)); window.opened(); }})();</script></body>"
      ),
    );
    assert!(pump_until(runtime, Duration::from_secs(20), || calls.borrow().iter().any(|c| c == "navigation failed")), "the navigation failed: {:?}", calls.borrow());
    // The second failed navigation, which nothing hears of.
    settle(runtime, Duration::from_millis(1500));
    assert_eq!(*calls.borrow(), ["A popup", "B popup", "navigation failed"]);
    engine.destroy();
  });
}

#[test]
fn a_new_window_or_navigation_failed_handler_destroys_its_webview_from_inside_its_own_call() {
  with_webviews(|runtime| {
    for kind in ["new-window", "navigation-failed"] {
      let engine = own(360, 240);
      let hwnd = engine.window_handle();
      let inside: Inside<Codes> = Rc::default();
      let destroy_inside = {
        let (inside, engine_in, runtime_in) = (inside.clone(), engine.clone(), runtime.clone());
        move || {
          engine_in.destroy();
          inside.set(Some(calls_after_destroy(&engine_in)));
          runtime_in.request_exit();
        }
      };
      let script = if kind == "new-window" {
        engine.set_new_window_handler(Some(Rc::new(move |_url| destroy_inside())));
        format!("window.open('{ORIGIN}/popup');")
      } else {
        assert_eq!(engine.set_navigation_failed_handler(Some(Rc::new(move |_failure| destroy_inside()))), ErrorCode::Ok);
        format!("location.href = '{REFUSED}';")
      };
      open_page(&engine, &format!("<!doctype html><body><script>{script}</script></body>"));
      let limit = runtime.clone();
      runtime.set_timeout(20_000, move || limit.request_exit()).expect("timeout");
      let _watch = watchdog(Duration::from_secs(40), "run() after a handler destroyed its webview");
      engine.run().expect("run");
      assert_eq!(inside.get(), Some(DESTROYED), "{kind}: destroyed at once, inside the call");
      assert!(engine.is_destroyed() && Engine::from_id(engine.id()).is_none(), "{kind}: released");
      settle(runtime, Duration::from_millis(200));
      assert!(!exists(hwnd), "{kind}: its window is gone");
    }
  });
}

#[test]
fn destroy_of_a_webview_that_never_ran_leaves_no_quit_behind_for_the_next_run() {
  with_webviews(|runtime| {
    let first = own(200, 200);
    first.destroy();
    assert!(first.is_destroyed() && Engine::from_id(first.id()).is_none());
    let second = own(400, 300);
    let ran = Rc::new(Cell::new(false));
    {
      let (ran, engine_in, runtime_in) = (ran.clone(), second.clone(), runtime.clone());
      let done = Rc::new(move |_seq: &str, _params: &str| {
        ran.set(true);
        engine_in.destroy();
        runtime_in.request_exit();
      });
      assert_eq!(second.bind("done", done), ErrorCode::Ok);
    }
    second.set_html("<!doctype html><html><body><script>window.done();</script></body></html>");
    let limit = runtime.clone();
    runtime.set_timeout(20_000, move || limit.request_exit()).expect("timeout");
    let _watch = watchdog(Duration::from_secs(40), "the second webview's run()");
    second.run().expect("run");
    assert!(ran.get(), "run() went on until the second page ran");
  });
}

#[test]
fn a_handle_that_names_no_webview_has_no_responder_and_no_engine() {
  with_webviews(|_runtime| {
    for stale in [0, 0x1000] {
      assert!(engine::responder(stale).is_none(), "responder of {stale}");
      assert!(Engine::from_id(stale).is_none(), "engine of {stale}");
    }
    let engine = own(200, 200);
    let id = engine.id();
    assert!(engine::responder(id).is_some() && Engine::from_id(id).is_some());
    engine.destroy();
    assert!(engine::responder(id).is_none() && Engine::from_id(id).is_none(), "a destroyed webview's handle names nothing");
  });
}

// ---- real keys ---------------------------------------------------------------------------------

/// Presses and releases a key as real input; the release is sent whatever the press did, so no
/// key is left down on the shared desktop. True when the system took both.
fn tap_key(virtual_key: u16) -> bool {
  let down = support::send_key(virtual_key, false);
  let up = support::send_key(virtual_key, true);
  down && up
}

/// Holds the foreground for `window`: asked up to eight times, a short pump apart (other
/// programs take it); refuses to judge when it is never given.
fn hold_foreground(runtime: &Runtime, window: isize) {
  for _attempt in 0..8 {
    if support::take_foreground(window) {
      return;
    }
    settle(runtime, Duration::from_millis(250));
  }
  refuse_to_judge("the desktop did not give this test's window the foreground in 8 attempts");
}

/// Taps F12 into `engine`'s page: its window must hold the foreground (taken back once if
/// another program took it), and the page the keyboard focus.
fn tap_f12(runtime: &Runtime, engine: &Engine) {
  let window = engine.window_handle();
  if support::foreground() != window {
    hold_foreground(runtime, window);
  }
  engine.move_focus();
  assert!(tap_key(VK_F12), "the system took the key");
}

#[test]
fn f12_opens_the_developer_tools_with_debug_on_and_none_with_debug_off() {
  with_webviews(|runtime| {
    for debug in [true, false] {
      let engine = Engine::create(debug, Host::Own, None).expect("own");
      engine.set_size(420, 300, SizeHint::None);
      let hwnd = engine.window_handle();
      engine.set_title(&format!("sweetview engine os devtools {debug} {}", std::process::id()));
      assert!(exists(hwnd), "debug {debug}: its window is real");
      // The DevTools window is titled after the page's address, which names this process and
      // round, so another program's DevTools is never taken for it.
      let page = format!("devtools-probe-{}-{debug}.html", std::process::id());
      assert_eq!(engine.set_asset(&page, "text/html", b"<!doctype html><script>window.answer(6, 7).then((v) => window.done(v));</script>".to_vec()), ErrorCode::Ok);
      let replier = engine.clone();
      let answer = Rc::new(move |seq: &str, params: &str| {
        let args: Value = serde_json::from_str(params).unwrap_or(Value::Null);
        let product = args[0].as_i64().unwrap_or(0) * args[1].as_i64().unwrap_or(0);
        replier.return_value(seq, 0, &product.to_string());
      });
      assert_eq!(engine.bind("answer", answer), ErrorCode::Ok);
      let done = record(&engine, "done");
      engine.navigate(&format!("{ORIGIN}/{page}"));
      assert!(pump_until(runtime, Duration::from_secs(20), || !done.borrow().is_empty()), "debug {debug}: the page answered");
      assert_eq!(done.borrow()[0], json!([42]), "debug {debug}: the binding answered");

      hold_foreground(runtime, hwnd);
      settle(runtime, Duration::from_millis(300));
      tap_f12(runtime, &engine);
      let started = Instant::now();
      let mut tapped_at = Instant::now();
      let mut devtools = None;
      while started.elapsed() < Duration::from_secs(10) {
        devtools = desktop::top_level_window_containing(&page);
        if devtools.is_some() {
          break;
        }
        // The move of the keyboard focus into the page is not instant: a key pressed before it
        // lands goes to the window and opens nothing. Pressed again, with debug on and off alike.
        if tapped_at.elapsed() > Duration::from_secs(2) {
          tapped_at = Instant::now();
          tap_f12(runtime, &engine);
        }
        settle(runtime, Duration::from_millis(100));
      }
      if let Some(window) = devtools {
        support::post(window, WM_CLOSE, 0, 0);
      }
      assert_eq!(devtools.is_some(), debug, "debug {debug}: F12 opened the developer tools: {devtools:?}");
      engine.destroy();
      settle(runtime, Duration::from_millis(300));
    }
  });
}

#[test]
fn an_accelerator_key_handler_destroys_its_webview_from_inside_its_own_call_on_a_real_f12() {
  with_webviews(|runtime| {
    let engine = own(360, 240);
    let hwnd = engine.window_handle();
    let keys: Rc<RefCell<Vec<u32>>> = Rc::default();
    let inside: Inside<Codes> = Rc::default();
    {
      let (keys, inside, engine_in, runtime_in) = (keys.clone(), inside.clone(), engine.clone(), runtime.clone());
      let handler = Rc::new(move |key: KeyData| {
        if key.virtual_key != u32::from(VK_F12) {
          return false;
        }
        keys.borrow_mut().push(key.virtual_key);
        engine_in.destroy();
        inside.set(Some(calls_after_destroy(&engine_in)));
        runtime_in.request_exit();
        true
      });
      assert_eq!(engine.set_accelerator_key_handler(Some(handler)), ErrorCode::Ok);
    }
    let ready = record(&engine, "ready");
    open_page(&engine, "<!doctype html><body><script>window.ready();</script></body>");
    assert!(pump_until(runtime, Duration::from_secs(20), || !ready.borrow().is_empty()), "the page loaded");
    hold_foreground(runtime, hwnd);
    engine.move_focus();
    settle(runtime, Duration::from_millis(300));
    let refused = Rc::new(Cell::new(false));
    {
      let (engine_in, refused) = (engine.clone(), refused.clone());
      runtime
        .set_timeout(200, move || {
          if support::foreground() == hwnd {
            engine_in.move_focus();
            assert!(tap_key(VK_F12), "the system took the key");
          } else {
            refused.set(true);
          }
        })
        .expect("timeout");
    }
    let limit = runtime.clone();
    runtime.set_timeout(5_000, move || limit.request_exit()).expect("timeout");
    let _watch = watchdog(Duration::from_secs(30), "run() after an accelerator handler destroyed its webview");
    engine.run().expect("run");
    if refused.get() {
      refuse_to_judge("another program took the foreground before F12 was pressed");
    }
    assert_eq!(*keys.borrow(), [u32::from(VK_F12)], "the handler got F12 once");
    assert_eq!(inside.get(), Some(DESTROYED), "destroyed at once, inside the call");
    assert!(engine.is_destroyed() && Engine::from_id(engine.id()).is_none(), "released");
    assert!(!exists(hwnd), "its window is gone");
  });
}
