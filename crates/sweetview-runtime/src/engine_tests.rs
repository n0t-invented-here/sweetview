//! Webviews made the way an application's are, through `Engine::create`, for
//! each kind of host (a window of the engine's own, a given window it fills, a
//! child of a given window: the tabs library's pages are such children), and
//! what WebView2 then shows a person, read back from WebView2 itself
//! (`sweetview_platform_webview::test_support`). The measure is the C++
//! fork's webview (DECISIONS D45).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sweetview_platform_webview::test_support::{self, DownloadWatch, PageSettings};

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

/// At the end of each test, on success or while a failed assertion unwinds:
/// what the end of an application does (`release_all`), a pump so every
/// webview has gone, then the thread's WebView2 environment.
struct Finish<'a>(&'a Runtime);

impl Drop for Finish<'_> {
  fn drop(&mut self) {
    release_all();
    settle(self.0, Duration::from_millis(300));
    release_environment_for_tests();
  }
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

#[test]
fn every_kind_of_host_has_the_cpp_fork_s_page_settings() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // Made as an application makes them (Engine::create, the runtime's own WebView2
    // environment), with `debug` off and on.
    for debug in [false, true] {
      for host in HOSTS {
        let (engine, _window) = make_debug(host, debug, |_| ());
        load(&runtime, &engine, PAGE);
        let seen = wry_of(&engine, test_support::page_settings);
        eprintln!("-- {host}, debug {debug}: {seen:?}");
        assert_eq!(seen, PageSettings::cpp_fork(debug), "{host}, debug {debug}: the C++ fork's settings");
        engine.destroy();
        settle(&runtime, Duration::from_millis(100));
      }
    }
  });
}

/// The kinds of host, in the order the tests go through them.
const HOSTS: [&str; 3] = ["own window", "given window", "child"];

/// A webview in a host of kind `host`, with the window it needs kept alive
/// beside it. `before` runs once that window exists and before the webview is
/// made.
fn make(host: &str, before: impl FnOnce(Option<&Window>)) -> (Engine, Option<Window>) {
  make_debug(host, false, before)
}

/// [`make`], with the developer tools as `debug`.
fn make_debug(host: &str, debug: bool, before: impl FnOnce(Option<&Window>)) -> (Engine, Option<Window>) {
  match host {
    "own window" => {
      before(None);
      let engine = Engine::create(debug, Host::Own).expect("own");
      engine.set_size(480, 360, SizeHint::None);
      (engine, None)
    }
    "given window" => {
      let window = host_window("engine test: filled");
      before(Some(&window));
      (Engine::create(debug, Host::Fill(window.handle())).expect("fill"), Some(window))
    }
    _ => {
      let window = host_window("engine test: child");
      before(Some(&window));
      let bounds = Bounds { x: 10, y: 10, width: 300, height: 200 };
      (Engine::create(debug, Host::Child(window.handle(), bounds)).expect("child"), Some(window))
    }
  }
}

#[test]
fn a_download_shows_webview2_s_own_interface_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
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
  });
}


#[test]
fn a_webview_takes_the_focus_only_in_a_window_of_its_own_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
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
  });
}

#[test]
fn a_page_that_calls_window_close_stays_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
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
  });
}

#[test]
fn a_new_webview_leaves_the_profile_s_autofill_preference_as_it_is_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
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
  });
}

// ---- real input -----------------------------------------------------------------------

const INPUT_PAGE: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>real input</title>
<style>
  body { margin: 0; font: 13px sans-serif; }
  #bar { -webkit-app-region: drag; app-region: drag; height: 50px; background: #cde; }
  #src { position: absolute; left: 10px; top: 60px; width: 80px; height: 40px; background: #fc9; }
  #dst { position: absolute; left: 180px; top: 60px; width: 100px; height: 60px; background: #9cf; }
  #files { position: absolute; left: 10px; top: 130px; width: 270px; height: 60px; background: #cfc; }
  #dl { position: absolute; left: 200px; top: 10px; }
</style></head>
<body>
<div id="bar">app-region: drag</div>
<a id="dl" download="sweetview-real-download.txt">download</a>
<div id="src" draggable="true">drag me</div>
<div id="dst">drop here</div>
<div id="files">files</div>
<script>
  dl.href = URL.createObjectURL(new Blob(['a download']));
  bar.addEventListener('mousedown', () => report('bar-down'));
  src.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'from-src'); });
  dst.addEventListener('dragover', (e) => e.preventDefault());
  dst.addEventListener('drop', (e) => { e.preventDefault(); report('page-drop:' + e.dataTransfer.getData('text/plain')); });
  window.addEventListener('resize', () => report('resize:' + devicePixelRatio));
  const centre = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
  window.__centres = () => JSON.stringify({ bar: centre('bar'), src: centre('src'), dst: centre('dst'), files: centre('files'), dl: centre('dl'), dpr: devicePixelRatio });
  report('ready');
</script>
</body></html>"#;

/// Runs the injector, `rust-rewrite/checks/webview-real-input.ps1`, with `args`
/// while pumping, until it has exited and `done` holds, or `timeout`; prints its
/// output. Ends it by its id if it is still running then.
fn inject(runtime: &Runtime, args: &[String], timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
  let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../rust-rewrite/checks/webview-real-input.ps1");
  let mut child = std::process::Command::new("pwsh")
    .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
    .arg(script)
    .args(args)
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .expect("pwsh");
  let mut exited = false;
  let reached = pump_until(runtime, timeout, || {
    exited = exited || child.try_wait().ok().flatten().is_some();
    exited && done()
  });
  if child.try_wait().ok().flatten().is_none() {
    eprintln!("   the injector (pid {}) is still running: ended by its id", child.id());
    let _ = child.kill();
  }
  let output = child.wait_with_output().expect("the injector's output");
  for line in String::from_utf8_lossy(&output.stdout).lines().chain(String::from_utf8_lossy(&output.stderr).lines()) {
    eprintln!("   injector: {line}");
  }
  reached
}

/// Where element `id` of the input page is on the screen (physical pixels).
fn point(engine: &Engine, centres: &serde_json::Value, id: &str) -> (i32, i32) {
  let (x, y) = wry_of(engine, test_support::screen_origin);
  let dpr = centres["dpr"].as_f64().unwrap();
  (x + (centres[id][0].as_f64().unwrap() * dpr).round() as i32, y + (centres[id][1].as_f64().unwrap() * dpr).round() as i32)
}

fn args(list: &[&str]) -> Vec<String> {
  list.iter().map(|s| s.to_string()).collect()
}

#[test]
#[ignore = "real input on the desktop: run with --ignored, under the shared desktop's input lock"]
fn real_input() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    let folder = std::env::temp_dir().join(format!("sweetview-real-input-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join("sweetview real drop.txt");
    std::fs::write(&file, "a file dragged from Explorer").unwrap();
    let mut failures = Vec::new();
    for host in HOSTS {
      eprintln!("== {host}");
      let (engine, _window) = make(host, |_| ());
      let reports = load(&runtime, &engine, INPUT_PAGE);
      settle(&runtime, Duration::from_millis(500));
      let centres: Rc<RefCell<Option<serde_json::Value>>> = Rc::default();
      {
        let sink = centres.clone();
        let _ = engine.unbind("centres");
        engine.bind(
          "centres",
          Rc::new(move |_seq, args| {
            *sink.borrow_mut() = serde_json::from_str::<Vec<String>>(args).ok().and_then(|a| serde_json::from_str(&a[0]).ok());
          }),
        );
      }
      engine.eval("centres(window.__centres())");
      assert!(pump_until(&runtime, Duration::from_secs(5), || centres.borrow().is_some()), "{host}: the page's layout");
      let centres = centres.borrow().clone().unwrap();
      let said = |what: &str| reports.borrow().iter().any(|r| r.contains(what));

      // A press on the app-region area, moved 80 px: the page gets it, the window stays.
      let before = wry_of(&engine, test_support::top_level_rect);
      let (x, y) = point(&engine, &centres, "bar");
      let (x2, ys) = ((x + 80).to_string(), y.to_string());
      inject(&runtime, &args(&["-Action", "drag", "-X", &x.to_string(), "-Y", &ys, "-ToX", &x2, "-ToY", &ys]), Duration::from_secs(8), || said("bar-down"));
      settle(&runtime, Duration::from_millis(300));
      let after = wry_of(&engine, test_support::top_level_rect);
      eprintln!("-- {host}: app-region press reached the page {}; the window moved by ({}, {})", said("bar-down"), after.0 - before.0, after.1 - before.1);
      if !said("bar-down") || after != before {
        failures.push(format!("{host}: app-region"));
      }

      // An HTML drag inside the page, with a file drop handler set.
      let dropped: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
      {
        let dropped = dropped.clone();
        assert_eq!(engine.set_file_drop_handler(Some(Rc::new(move |paths| dropped.borrow_mut().push(paths)))), ErrorCode::Ok);
      }
      let (sx, sy) = point(&engine, &centres, "src");
      let (dx, dy) = point(&engine, &centres, "dst");
      let drag = args(&["-Action", "drag", "-X", &sx.to_string(), "-Y", &sy.to_string(), "-ToX", &dx.to_string(), "-ToY", &dy.to_string()]);
      inject(&runtime, &drag, Duration::from_secs(10), || said("page-drop:from-src"));
      eprintln!("-- {host}: the in-page HTML drag reached the page's drop {}", said("page-drop:from-src"));
      if !said("page-drop:from-src") {
        failures.push(format!("{host}: in-page drag"));
      }

      // A file dragged from a real Explorer window onto the page.
      let rect = wry_of(&engine, test_support::top_level_rect);
      let explorer_x = if rect.0 > test_support::screen_width() / 2 { 40 } else { rect.2 + 40 };
      let (fx, fy) = point(&engine, &centres, "files");
      let folder_arg = folder.to_string_lossy().into_owned();
      let explorer_at = format!("{explorer_x},{}", rect.1);
      let explorer = args(&[
        "-Action",
        "explorer",
        "-Folder",
        &folder_arg,
        "-File",
        "sweetview real drop.txt",
        "-ToX",
        &fx.to_string(),
        "-ToY",
        &fy.to_string(),
        "-ExplorerAt",
        &explorer_at,
      ]);
      inject(&runtime, &explorer, Duration::from_secs(40), || !dropped.borrow().is_empty());
      settle(&runtime, Duration::from_millis(300));
      eprintln!("-- {host}: the file drop handler received {:?}", dropped.borrow());
      if *dropped.borrow() != vec![vec![file.to_string_lossy().into_owned()]] {
        failures.push(format!("{host}: Explorer drop"));
      }

      // A real click on a download link: WebView2's own download interface opens.
      let watch = wry_of(&engine, |webview| DownloadWatch::attach(webview, folder.clone()));
      let (lx, ly) = point(&engine, &centres, "dl");
      inject(&runtime, &args(&["-Action", "click", "-X", &lx.to_string(), "-Y", &ly.to_string()]), Duration::from_secs(8), || !watch.handled().is_empty());
      let opened = pump_until(&runtime, Duration::from_secs(5), || wry_of(&engine, test_support::download_dialog_open) == Some(true));
      wry_of(&engine, test_support::close_download_dialog);
      eprintln!("-- {host}: download marked handled {:?}; WebView2's download interface opened {opened}", watch.handled());
      if watch.handled() != vec![false] || !opened {
        failures.push(format!("{host}: download"));
      }
      drop(watch);

      // Ctrl+wheel, Ctrl+0, Ctrl+plus, Ctrl+0 over the page.
      let (zx, zy) = point(&engine, &centres, "files");
      let (zxs, zys) = (zx.to_string(), zy.to_string());
      let mut zooms = vec![wry_of(&engine, test_support::zoom_factor)];
      reports.borrow_mut().clear();
      inject(&runtime, &args(&["-Action", "ctrlwheel", "-X", &zxs, "-Y", &zys]), Duration::from_secs(8), || said("resize:"));
      zooms.push(wry_of(&engine, test_support::zoom_factor));
      for key in ["zero", "plus", "zero"] {
        reports.borrow_mut().clear();
        inject(&runtime, &args(&["-Action", "ctrlkey", "-Key", key, "-X", &zxs, "-Y", &zys]), Duration::from_secs(8), || said("resize:"));
        zooms.push(wry_of(&engine, test_support::zoom_factor));
      }
      eprintln!("-- {host}: ZoomFactor before, after Ctrl+wheel, Ctrl+0, Ctrl+plus, Ctrl+0: {zooms:?}");
      let near = |a: f64, b: f64| (a - b).abs() < 1e-6;
      if !(near(zooms[0], 1.0) && zooms[1] > 1.0 && near(zooms[2], 1.0) && zooms[3] > 1.0 && near(zooms[4], 1.0)) {
        failures.push(format!("{host}: zoom"));
      }
      engine.destroy();
      settle(&runtime, Duration::from_millis(200));
    }
    let _ = std::fs::remove_dir_all(&folder);
    assert!(failures.is_empty(), "failed: {failures:?}");
  });
}
