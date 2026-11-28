//! Webviews made the way an application's are, through `Engine::create`, for
//! each kind of host (a window of the engine's own, a given window it fills, a
//! child of a given window: the tabs library's pages are such children), and
//! what WebView2 then shows a person, read back from WebView2 itself
//! (`sweetview_platform_webview::test_support`). The measure is the C++
//! fork's webview (DECISIONS D48).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sweetview_platform_webview::test_support::{self, DownloadWatch, PageSettings};

use super::*;
use crate::runtime::testing::on_ui_thread;
use crate::window::{Window, WindowInit};
use sweetview_platform_window::BorrowedWindow;

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
    test_support::release_environment();
  }
}

/// The webview of `engine`, lent to `f`.
fn webview_of<R>(engine: &Engine, f: impl FnOnce(&Webview) -> R) -> R {
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
        let seen = webview_of(&engine, test_support::page_settings);
        eprintln!("-- {host}, debug {debug}: {seen:?}");
        assert_eq!(seen, PageSettings::cpp_fork(debug), "{host}, debug {debug}: the C++ fork's settings");
        engine.destroy();
        settle(&runtime, Duration::from_millis(100));
      }
    }
  });
}

/// The kinds of host, in the order the tests go through them: a window of the
/// engine's own, a given window it fills (as `createApp`'s), a child of a given
/// window (as a tab's page), and a child moved into another window.
const HOSTS: [&str; 4] = ["own window", "given window", "child", "reparented child"];

/// A webview in a host of kind `host`, with the windows it needs kept alive
/// beside it (the one it is in first). `before` runs once that window exists
/// and before the webview is made.
fn make(host: &str, before: impl FnOnce(Option<&Window>)) -> (Engine, Vec<Window>) {
  make_debug(host, false, before)
}

/// [`make`], with the developer tools as `debug`.
fn make_debug(host: &str, debug: bool, before: impl FnOnce(Option<&Window>)) -> (Engine, Vec<Window>) {
  let bounds = Bounds { x: 10, y: 10, width: 300, height: 200 };
  match host {
    "own window" => {
      before(None);
      let engine = Engine::create(debug, Host::Own, None).expect("own");
      engine.set_size(480, 360, SizeHint::None);
      (engine, Vec::new())
    }
    "given window" => {
      let window = host_window("engine test: filled");
      before(Some(&window));
      (Engine::create(debug, Host::Fill(window.handle()), None).expect("fill"), vec![window])
    }
    "child" => {
      let window = host_window("engine test: child");
      before(Some(&window));
      (Engine::create(debug, Host::Child(window.handle(), bounds), None).expect("child"), vec![window])
    }
    _ => {
      let first = host_window("engine test: child before the move");
      let engine = Engine::create(debug, Host::Child(first.handle(), bounds), None).expect("child");
      let window = host_window("engine test: reparented");
      before(Some(&window));
      engine.reparent(window.handle()).expect("reparent");
      engine.set_bounds(bounds);
      (engine, vec![window, first])
    }
  }
}

/// The page still runs and its webview is still in its window.
fn still_there(runtime: &Runtime, engine: &Engine, reports: &Rc<RefCell<Vec<String>>>, mark: &str) -> (bool, bool) {
  let alive = webview_of(engine, test_support::container_alive);
  engine.eval(&format!("report({mark:?})"));
  let answered = pump_until(runtime, Duration::from_secs(3), || reports.borrow().iter().any(|r| r.contains(mark)));
  (alive, answered)
}

#[test]
fn a_page_s_window_close_does_nothing_as_under_the_cpp_fork() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // The C++ fork registered no WindowCloseRequested handler, so WebView2's request to close
    // (from `window.close()` in any document or frame, or from the DevTools protocol's
    // `Page.close`) did nothing, and `window.close` was the browser's own.
    for host in HOSTS {
      let (engine, _windows) = make(host, |_| ());
      // In the initial about:blank document, before any navigation.
      engine.eval("window.close()");
      settle(&runtime, Duration::from_millis(500));
      let blank = webview_of(&engine, test_support::container_alive);
      let reports = load(&runtime, &engine, PAGE);
      let after_blank = still_there(&runtime, &engine, &reports, "after about:blank");

      // In the page, then from a cross-origin frame reaching for the top.
      engine.eval("report('close is ' + window.close.toString())");
      assert!(pump_until(&runtime, Duration::from_secs(3), || reports.borrow().iter().any(|r| r.contains("close is"))), "{host}: the page said what close is");
      let native = reports.borrow().iter().any(|r| r.contains("[native code]"));
      engine.eval("window.close()");
      settle(&runtime, Duration::from_millis(500));
      let after_page = still_there(&runtime, &engine, &reports, "after the page");
      let responder = engine.inner.with_live(|live| live.extras.responder()).expect("live");
      engine.set_request_handler(Some(Rc::new(move |request: RawRequest| {
        let body = "<!doctype html><script>window.top.close(); try { top.window.close() } catch (e) {}</script>";
        responder.complete(request.id, 200, Some(r#"{"Content-Type":"text/html"}"#), Some(body.as_bytes()));
      })));
      engine.eval("(() => { const f = document.createElement('iframe'); f.src = 'http://frames.webview.localhost/close.html'; f.onload = () => report('frame loaded'); document.body.append(f); })()");
      assert!(pump_until(&runtime, Duration::from_secs(10), || reports.borrow().iter().any(|r| r.contains("frame loaded"))), "{host}: the frame loaded");
      settle(&runtime, Duration::from_millis(500));
      let after_frame = still_there(&runtime, &engine, &reports, "after the frame");

      // Through the DevTools protocol.
      assert_eq!(engine.call_devtools_protocol_method("Page.close", "{}"), ErrorCode::Ok);
      settle(&runtime, Duration::from_millis(800));
      let after_devtools = still_there(&runtime, &engine, &reports, "after Page.close");

      eprintln!("-- {host}: about:blank {blank} {after_blank:?}; native close {native}; page {after_page:?}; frame {after_frame:?}; Page.close {after_devtools:?}");
      assert!(blank && after_blank == (true, true), "{host}: window.close() in about:blank left the webview");
      assert!(native, "{host}: window.close is the browser's own");
      assert_eq!(after_page, (true, true), "{host}: the page's window.close() left the webview");
      assert_eq!(after_frame, (true, true), "{host}: a cross-origin frame's window.top.close() left the webview");
      assert_eq!(after_devtools, (true, true), "{host}: Page.close left the webview");
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
  });
}

#[test]
fn a_download_is_left_to_webview2_which_keeps_an_existing_file_and_shows_its_interface() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // The C++ fork registered no DownloadStarting handler: WebView2 chose the path in the
    // profile's download folder, kept a file already there, and showed its own interface.
    // The profile's folder points at a scratch folder for the test and is put back after.
    let folder = std::env::temp_dir().join(format!("sweetview-engine-download-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    let mut judged = Vec::new();
    for host in HOSTS {
      let (engine, _windows) = make(host, |_| ());
      if host == "own window" {
        engine.show_own_window();
      }
      load(&runtime, &engine, PAGE);
      // Shown and brought to the front, as a person's window is when they click a link in it.
      webview_of(&engine, test_support::bring_to_front);
      settle(&runtime, Duration::from_millis(200));
      let original = webview_of(&engine, test_support::download_folder);
      webview_of(&engine, |webview| test_support::set_download_folder(webview, &folder.to_string_lossy()));
      let existing = folder.join("sweetview-download.txt");
      std::fs::write(&existing, "already here").unwrap();
      let watch = webview_of(&engine, DownloadWatch::attach);
      engine.eval(
        "(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['a download'])); \
         a.download = 'sweetview-download.txt'; document.body.append(a); a.click(); })()",
      );
      assert!(pump_until(&runtime, Duration::from_secs(10), || !watch.handled().is_empty()), "{host}: the download started");
      let saved = pump_until(&runtime, Duration::from_secs(10), || std::fs::read_dir(&folder).map(|d| d.count()).unwrap_or(0) >= 2);
      // WebView2 opens its dialog for a webview in front only, and closes it when the webview
      // loses the focus: the webview's place in front is watched through the whole wait, and a
      // wait during which another window came in front cannot be judged.
      let mut away: Option<String> = webview_of(&engine, test_support::not_in_front);
      let opened = pump_until(&runtime, Duration::from_secs(5), || {
        if away.is_none() {
          away = webview_of(&engine, test_support::not_in_front);
        }
        webview_of(&engine, test_support::download_dialog_open) == Some(true)
      });
      let away = if opened { None } else { away };
      webview_of(&engine, test_support::close_download_dialog);
      let names: Vec<String> = std::fs::read_dir(&folder).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
      let kept = std::fs::read_to_string(&existing).unwrap_or_default();
      eprintln!("-- {host}: handled {:?}; path chosen {:?}; files {names:?}; the existing file holds {kept:?}; interface opened {opened}", watch.handled(), watch.paths());
      webview_of(&engine, |webview| test_support::set_download_folder(webview, &original));
      assert_eq!(watch.handled(), vec![false], "{host}: nothing marked the download handled");
      assert!(saved, "{host}: WebView2 saved the download beside the existing file");
      assert_eq!(kept, "already here", "{host}: the existing file was kept");
      match &away {
        Some(reason) => eprintln!("-- {host}: WebView2's own download interface: not run: {reason}"),
        None => {
          assert!(opened, "{host}: WebView2's own download interface opened");
          judged.push(host);
        }
      }
      drop(watch);
      engine.destroy();
      settle(&runtime, Duration::from_millis(200));
      for entry in std::fs::read_dir(&folder).unwrap().filter_map(|e| e.ok()) {
        let _ = std::fs::remove_file(entry.path());
      }
    }
    let _ = std::fs::remove_dir_all(&folder);
    assert!(!judged.is_empty(), "not judged: in no host was the webview in front through the whole wait");
  });
}

#[test]
fn the_focus_moves_into_the_page_only_where_the_cpp_fork_moved_it() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    let mut checked = Vec::new();
    // 1. Making a webview in a given window, or beside a control that has the focus, leaves
    //    the focus there (read before the loop runs, so only the creation can have moved it).
    // 2. A given window that takes the focus itself afterwards keeps it: nothing forwards a
    //    WM_SETFOCUS of a window Sweetview was given.
    for host in ["given window", "child", "reparented child"] {
      let mut had_focus = false;
      let (engine, windows) = make(host, |window| {
        let window = window.expect("a given window");
        BorrowedWindow::with_handle_value(window.handle(), test_support::focus_window);
        had_focus = BorrowedWindow::with_handle_value(window.handle(), test_support::has_focus) == Some(true);
      });
      let given = windows[0].handle();
      let created_inside = webview_of(&engine, test_support::focus_is_inside);
      load(&runtime, &engine, PAGE);
      BorrowedWindow::with_handle_value(given, test_support::focus_window);
      let took_it = BorrowedWindow::with_handle_value(given, test_support::has_focus) == Some(true);
      settle(&runtime, Duration::from_millis(400));
      let kept = BorrowedWindow::with_handle_value(given, test_support::has_focus) == Some(true);
      let later_inside = webview_of(&engine, test_support::focus_is_inside);
      eprintln!("-- {host}: at creation the window had the focus {had_focus}, the page {created_inside}; the window took it again {took_it}, kept it {kept}, the page has it {later_inside}");
      assert!(!created_inside, "{host}: making the webview did not move the focus into it");
      assert!(!later_inside, "{host}: the page did not take the focus from the window");
      if had_focus {
        checked.push(format!("{host}: creation"));
      }
      if took_it {
        assert!(kept, "{host}: the window that took the focus keeps it");
        checked.push(format!("{host}: the window's own focus"));
      }
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    // 3. A window the engine makes gives its page the focus when shown and activated, as the
    //    fork's own window did on WM_ACTIVATE.
    let (own, _none) = make("own window", |_| ());
    load(&runtime, &own, PAGE);
    let own_inside = pump_until(&runtime, Duration::from_secs(3), || webview_of(&own, test_support::focus_is_inside));
    eprintln!("-- own window: the page has the focus once the window is shown {own_inside}");
    if own_inside {
      checked.push("own window".into());
    }
    own.destroy();
    // 4. A Sweetview window a page fills gives the page nothing on activation unless asked
    //    (a window the application gave, as under the C++ library); the window createApp makes
    //    asks (follow_window_activation), as the tag's createApp window was the webview's own.
    for asked in [false, true] {
      let (filled, windows) = make("given window", |_| ());
      load(&runtime, &filled, PAGE);
      if asked {
        filled.follow_window_activation();
      }
      let window = windows[0].handle();
      BorrowedWindow::with_handle_value(window, test_support::focus_window);
      BorrowedWindow::with_handle_value(window, test_support::send_activate);
      let activated = pump_until(&runtime, Duration::from_secs(3), || webview_of(&filled, test_support::focus_is_inside));
      eprintln!("-- given window, asked {asked}: the page has the focus after the window's activation {activated}");
      assert_eq!(activated, asked, "the page of a filled window gets the focus on activation only when asked (createApp's)");
      checked.push(format!("activation of a filled window, asked {asked}"));
      filled.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    eprintln!("-- checked: {checked:?}");
    assert!(checked.len() >= 4, "too little could be checked on this desktop to say anything: {checked:?}");
  });
}

#[test]
fn the_container_is_a_control_parent_and_goes_with_its_webview() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // The fork's widget: WS_EX_CONTROLPARENT, destroyed with its webview (deinit), even in a
    // window that stays alive. Over repeated lives, every handle is given back.
    const WS_EX_CONTROLPARENT: u32 = 0x0001_0000;
    for host in ["given window", "child"] {
      let window = host_window("engine test: container");
      let handle = window.handle();
      let life = || {
        let engine = match host {
          "given window" => Engine::create(false, Host::Fill(handle), None).expect("fill"),
          _ => Engine::create(false, Host::Child(handle, Bounds { x: 0, y: 0, width: 200, height: 100 }), None).expect("child"),
        };
        load(&runtime, &engine, PAGE);
        let style = webview_of(&engine, test_support::widget_ex_style);
        let widgets = BorrowedWindow::with_handle_value(handle, test_support::widget_children);
        assert!(style & WS_EX_CONTROLPARENT != 0, "{host}: the container is a control parent ({style:#x})");
        assert_eq!(widgets, Some(1), "{host}: one container while the webview lives");
        engine.destroy();
        settle(&runtime, Duration::from_millis(200));
        assert_eq!(BorrowedWindow::with_handle_value(handle, test_support::widget_children), Some(0), "{host}: the container went with the webview");
      };
      // USER and GDI objects (the widget among them) come back exactly. WebView2 itself keeps
      // about one kernel handle per webview ever made in a process, under the C++ fork and
      // `wry` alike (measured by the webview crate's teardown test against bare webviews):
      // that, and no more, is allowed.
      let lives = 8;
      let growth = sweetview_platform_loop::testing::smallest_growth(lives, life);
      eprintln!("-- {host}: over {lives} lives {growth:?}");
      assert!(growth.user_objects <= 0 && growth.gdi_objects <= 0, "{host}: every window and GDI object given back: {growth:?}");
      // The allowance a_webview_keeps_no_kernel_handle_beyond_webview2_s_own measured WebView2's
      // own count moving by from run to run: one handle of ours per life would add `lives` more.
      let noise = (lives as i64 / 8).max(1);
      assert!(growth.kernel_handles <= lives as i64 + noise, "{host}: no kernel handle beyond WebView2's own one per webview: {growth:?}");
      drop(window);
    }
  });
}

#[test]
fn a_page_may_define_its_own_window_ipc() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // Nothing of Sweetview's defines `window.ipc`, as the fork defined none.
    for host in HOSTS {
      let (engine, _windows) = make(host, |_| ());
      let reports = load(&runtime, &engine, PAGE);
      engine.eval("(() => { 'use strict'; try { window.ipc = { mine: 1 }; report('ipc ' + window.ipc.mine); } catch (e) { report('ipc refused ' + e); } })()");
      assert!(pump_until(&runtime, Duration::from_secs(3), || reports.borrow().iter().any(|r| r.contains("ipc"))), "{host}: the page answered");
      let said = reports.borrow().iter().find(|r| r.contains("ipc")).cloned().unwrap_or_default();
      eprintln!("-- {host}: {said}");
      assert!(said.contains("ipc 1"), "{host}: the page's own window.ipc: {said}");
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
  });
}

#[test]
fn making_a_webview_leaves_the_profile_s_autofill_preference_as_it_is() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // The C++ fork never wrote general autofill. Turned off in one webview, it stays off when
    // another is made, in any kind of host; the profile is put back after.
    let (first, _first_windows) = make("own window", |_| ());
    load(&runtime, &first, PAGE);
    webview_of(&first, |webview| test_support::set_general_autofill(webview, false));
    for host in HOSTS {
      let (second, _windows) = make(host, |_| ());
      load(&runtime, &second, PAGE);
      let seen = (webview_of(&first, |w| test_support::page_settings(w).general_autofill), webview_of(&second, |w| test_support::page_settings(w).general_autofill));
      eprintln!("-- after a second webview in a {host}: general autofill (first, second) {seen:?}");
      assert_eq!(seen, (Some(false), Some(false)), "{host}: the profile's preference is left as it was");
      second.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    webview_of(&first, |webview| test_support::set_general_autofill(webview, true));
    first.destroy();
  });
}

/// Run by `autofill_across_processes` in a process of its own, on the profile
/// it names: makes one webview and, as `SWEETVIEW_AUTOFILL_STEP` says, turns
/// general autofill off ("off") or on ("on"), or only reads it ("read"); then
/// prints `AUTOFILL <value>`, the value seen before any change.
#[test]
#[ignore = "a step of autofill_across_processes, run in a process of its own"]
fn autofill_step() {
  let Ok(step) = std::env::var("SWEETVIEW_AUTOFILL_STEP") else { return };
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    let (engine, _windows) = make("own window", |_| ());
    load(&runtime, &engine, PAGE);
    let seen = webview_of(&engine, |w| test_support::page_settings(w).general_autofill);
    println!("AUTOFILL {seen:?}");
    match step.as_str() {
      "off" => webview_of(&engine, |w| test_support::set_general_autofill(w, false)),
      "on" => webview_of(&engine, |w| test_support::set_general_autofill(w, true)),
      _ => {}
    }
    settle(&runtime, Duration::from_millis(300));
    engine.destroy();
  });
}

#[test]
fn autofill_across_processes() {
  // Autofill turned off in one process; the process ends; a new process's first webview on
  // the same profile is made, and nothing of Sweetview's writes the preference: what it reads
  // is what WebView2 kept. Then the profile, a scratch folder, is removed.
  let profile = std::env::temp_dir().join(format!("sweetview-engine-autofill-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&profile);
  let run = |step: &str| -> String {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
      .args(["engine::tests::autofill_step", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
      .env("SWEETVIEW_AUTOFILL_STEP", step)
      .env("WEBVIEW2_USER_DATA_FOLDER", &profile)
      .output()
      .expect("the step's process");
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(output.status.success(), "the {step} step: {text}{}", String::from_utf8_lossy(&output.stderr));
    // libtest prints a test's output after its "test <name> ... " on the same line.
    text.lines().find_map(|l| l.split_once("AUTOFILL ").map(|(_, value)| value.split_whitespace().next().unwrap_or_default().to_owned())).unwrap_or_default()
  };
  let fresh = run("off");
  let second_process = run("read");
  eprintln!("-- a fresh profile's first webview: {fresh}; after it was turned off and that process ended, the next process's first webview: {second_process}");
  let _ = std::fs::remove_dir_all(&profile);
  // Measured on WebView2 Runtime 158: WebView2 does not keep the preference from one process
  // to the next (it is on again in the next process's first webview), so with nothing of
  // Sweetview's writing it, the next process sees WebView2's own default, as under the fork.
  assert_eq!(fresh, "Some(true)", "WebView2's default on a fresh profile");
  assert_eq!(second_process, fresh, "the next process sees WebView2's own value; nothing of Sweetview's wrote one");
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
fn inject(runtime: &Runtime, args: &[String], timeout: Duration, mut done: impl FnMut() -> bool) -> (bool, String) {
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
  let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
  for line in text.lines() {
    eprintln!("   injector: {line}");
  }
  (reached, text)
}

/// The windows the injector found under the points it pressed, moved to or
/// clicked that belong to another process than this test's (its lines say
/// "on '<title>' (<class>, pid <n>)"). For the Explorer drag the press point
/// is Explorer's own, so only the points after the first count.
fn foreign_windows(output: &str, skip_first: bool) -> Vec<String> {
  let ours = format!("pid {})", std::process::id());
  let mut found = Vec::new();
  for line in output.lines() {
    let mut parts: Vec<&str> = line.split("(on '").skip(1).collect();
    if skip_first && !parts.is_empty() {
      parts.remove(0);
    }
    for part in parts {
      if !part.contains(&ours) {
        found.push(part.split('\'').next().unwrap_or_default().to_string());
      }
    }
  }
  found
}

/// Where element `id` of the input page is on the screen (physical pixels).
fn point(engine: &Engine, centres: &serde_json::Value, id: &str) -> (i32, i32) {
  let (x, y) = webview_of(engine, test_support::screen_origin);
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
    // On a shared desktop other programs open windows at any time: the test window is kept
    // topmost, and a step whose points are on another window, before or after it, is "not
    // run" rather than passed or failed.
    let mut not_run = Vec::new();
    eprintln!("-- this test is process {}", std::process::id());
    for host in HOSTS {
      eprintln!("== {host}");
      let (engine, _windows) = make(host, |_| ());
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
      webview_of(&engine, test_support::keep_on_top);
      let covered = |points: &[(i32, i32)]| points.iter().find_map(|&(x, y)| webview_of(&engine, |w| test_support::covered_at(w, x, y)));
      // Records the step's outcome. A success counts (no other window can make the page do
      // it). A failure counts as "not run" when another window was on its points before the
      // step, after it, or as the injector acted (`injected`, its output).
      let mut outcome = |step: &str, points: &[(i32, i32)], before: Option<String>, injected: &(bool, String), skip_first: bool, ok: bool| {
        if ok {
          return;
        }
        let by = before.or_else(|| covered(points)).or_else(|| foreign_windows(&injected.1, skip_first).into_iter().next());
        match by {
          Some(by) => not_run.push(format!("{host}: {step} (covered by '{by}')")),
          None => failures.push(format!("{host}: {step}")),
        }
      };

      // A press on the app-region area, moved 80 px: the page gets it, the window stays.
      let before = webview_of(&engine, test_support::top_level_rect);
      let (x, y) = point(&engine, &centres, "bar");
      let (x2, ys) = ((x + 80).to_string(), y.to_string());
      let region_points = [(x, y), (x + 80, y)];
      let cover = covered(&region_points);
      let injected = inject(&runtime, &args(&["-Action", "drag", "-X", &x.to_string(), "-Y", &ys, "-ToX", &x2, "-ToY", &ys]), Duration::from_secs(8), || said("bar-down"));
      settle(&runtime, Duration::from_millis(300));
      let after = webview_of(&engine, test_support::top_level_rect);
      eprintln!("-- {host}: app-region press reached the page {}; the window moved by ({}, {})", said("bar-down"), after.0 - before.0, after.1 - before.1);
      outcome("app-region", &region_points, cover, &injected, false, said("bar-down") && after == before);

      // An HTML drag inside the page, with a file drop handler set.
      let dropped: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
      {
        let dropped = dropped.clone();
        assert_eq!(engine.set_file_drop_handler(Some(Rc::new(move |paths| dropped.borrow_mut().push(paths)))), ErrorCode::Ok);
      }
      let (sx, sy) = point(&engine, &centres, "src");
      let (dx, dy) = point(&engine, &centres, "dst");
      let drag = args(&["-Action", "drag", "-X", &sx.to_string(), "-Y", &sy.to_string(), "-ToX", &dx.to_string(), "-ToY", &dy.to_string()]);
      let drag_points = [(sx, sy), (dx, dy)];
      let cover = covered(&drag_points);
      let injected = inject(&runtime, &drag, Duration::from_secs(10), || said("page-drop:from-src"));
      eprintln!("-- {host}: the in-page HTML drag reached the page's drop {}", said("page-drop:from-src"));
      outcome("in-page drag", &drag_points, cover, &injected, false, said("page-drop:from-src"));

      // A file dragged from a real Explorer window onto the page.
      let rect = webview_of(&engine, test_support::top_level_rect);
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
      let cover = covered(&[(fx, fy)]);
      let injected = inject(&runtime, &explorer, Duration::from_secs(40), || !dropped.borrow().is_empty());
      settle(&runtime, Duration::from_millis(300));
      eprintln!("-- {host}: the file drop handler received {:?}", dropped.borrow());
      let delivered = *dropped.borrow() == vec![vec![file.to_string_lossy().into_owned()]];
      outcome("Explorer drop", &[(fx, fy)], cover, &injected, true, delivered);

      // A real click on a download link: WebView2's own download interface opens.
      let original_folder = webview_of(&engine, test_support::download_folder);
      webview_of(&engine, |webview| test_support::set_download_folder(webview, &folder.to_string_lossy()));
      let watch = webview_of(&engine, DownloadWatch::attach);
      let (lx, ly) = point(&engine, &centres, "dl");
      let cover = covered(&[(lx, ly)]);
      let injected = inject(&runtime, &args(&["-Action", "click", "-X", &lx.to_string(), "-Y", &ly.to_string()]), Duration::from_secs(8), || !watch.handled().is_empty());
      let opened = pump_until(&runtime, Duration::from_secs(5), || webview_of(&engine, test_support::download_dialog_open) == Some(true));
      webview_of(&engine, test_support::close_download_dialog);
      eprintln!("-- {host}: download marked handled {:?}; WebView2's download interface opened {opened}", watch.handled());
      outcome("download", &[(lx, ly)], cover, &injected, false, watch.handled() == vec![false] && opened);
      drop(watch);
      webview_of(&engine, |webview| test_support::set_download_folder(webview, &original_folder));

      // Ctrl+wheel, Ctrl+0, Ctrl+plus, Ctrl+0 over the page.
      let (zx, zy) = point(&engine, &centres, "files");
      let (zxs, zys) = (zx.to_string(), zy.to_string());
      let cover = covered(&[(zx, zy)]);
      let mut zooms = vec![webview_of(&engine, test_support::zoom_factor)];
      reports.borrow_mut().clear();
      let mut injected = inject(&runtime, &args(&["-Action", "ctrlwheel", "-X", &zxs, "-Y", &zys]), Duration::from_secs(8), || said("resize:"));
      zooms.push(webview_of(&engine, test_support::zoom_factor));
      for key in ["zero", "plus", "zero"] {
        reports.borrow_mut().clear();
        let step = inject(&runtime, &args(&["-Action", "ctrlkey", "-Key", key, "-X", &zxs, "-Y", &zys]), Duration::from_secs(8), || said("resize:"));
        injected.1.push_str(&step.1);
        zooms.push(webview_of(&engine, test_support::zoom_factor));
      }
      eprintln!("-- {host}: ZoomFactor before, after Ctrl+wheel, Ctrl+0, Ctrl+plus, Ctrl+0: {zooms:?}");
      let near = |a: f64, b: f64| (a - b).abs() < 1e-6;
      let zoomed = near(zooms[0], 1.0) && zooms[1] > 1.0 && near(zooms[2], 1.0) && zooms[3] > 1.0 && near(zooms[4], 1.0);
      outcome("zoom", &[(zx, zy)], cover, &injected, false, zoomed);
      engine.destroy();
      settle(&runtime, Duration::from_millis(200));
    }
    let _ = std::fs::remove_dir_all(&folder);
    eprintln!("-- not run: {not_run:?}");
    eprintln!("-- failed: {failures:?}");
    assert!(failures.is_empty(), "failed: {failures:?}");
    // A step not run proved nothing: the run is not a pass.
    assert!(not_run.is_empty(), "not run: {not_run:?}");
  });
}

#[test]
fn the_window_s_start_colour_is_webview2_s_background_before_the_webview_is_first_shown() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // A window's `backgroundColor`, read by the binding where the webview is made
    // (`window::background_of`), is WebView2's default background before the container is first
    // shown, so WebView2's own white never shows while the page starts: read by the container's
    // own `WM_SHOWWINDOW`, for a window of the engine's own, a given window and a child.
    let colour = "#304050";
    let want = Some(Some((0xff, 0x30, 0x40, 0x50)));
    let window = Window::create(WindowInit {
      title: "engine test: start colour".into(),
      frame: true,
      bounds: Some(crate::Rect::new(80, 80, 520, 420)),
      background_color: Some(colour.into()),
      ..Default::default()
    })
    .expect("window");
    window.show().expect("show");
    let handle = window.handle();
    let read = crate::window::background_of(handle);
    assert_eq!(read, Some((0x30, 0x40, 0x50)), "the binding reads the window's colour");
    for (host, made) in [
      ("own window", Engine::create(false, Host::Own, read)),
      ("given window", Engine::create(false, Host::Fill(handle), read)),
      ("child", Engine::create(false, Host::Child(handle, Bounds { x: 0, y: 0, width: 200, height: 100 }), read)),
    ] {
      let engine = made.expect(host);
      let seen = webview_of(&engine, test_support::background_when_first_shown);
      eprintln!("-- {host}: background when first shown {seen:?}");
      assert_eq!(seen, want, "{host}: the window's colour before the webview is first shown");
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    // With no colour, WebView2's own default stays (not the colour of another window).
    let plain = Engine::create(false, Host::Child(handle, Bounds { x: 0, y: 0, width: 200, height: 100 }), None).expect("plain child");
    let seen = webview_of(&plain, test_support::background_when_first_shown);
    eprintln!("-- no colour: background when first shown {seen:?}");
    assert!(matches!(seen, Some(Some(_))) && seen != want, "no colour given: WebView2's own: {seen:?}");
    plain.destroy();
    drop(window);
  });
}

#[test]
fn a_webview_keeps_no_kernel_handle_beyond_webview2_s_own() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // An application measured about one kernel handle kept per webview attached and disposed
    // (1.02 over 40 cycles, GDI and USER flat). The same 40 lives two ways in one window: a
    // webview made as an application's is (`Engine::create`, every handler Sweetview
    // registers, the bridge, a page that calls it), and the bare webview (`Webview::create`:
    // the widget, the controller and the two settings, no handler of Sweetview's). What the
    // bare one keeps is WebView2's own; the engine may keep no more.
    let window = host_window("engine test: kernel handles");
    let handle = window.handle();
    let engine_life = || {
      let engine = Engine::create(false, Host::Fill(handle), None).expect("fill");
      load(&runtime, &engine, PAGE);
      engine.destroy();
      settle(&runtime, Duration::from_millis(200));
    };
    let bare_life = || {
      let webview = crate::window::with_mount_target(handle, |parent| Webview::create(parent, Layout::Fill, false, None))
        .expect("the window")
        .expect("a bare webview");
      assert_eq!(webview.navigate_to_string("<script>document.title = 'ready'</script>").code(), 0);
      assert!(pump_until(&runtime, Duration::from_secs(20), || test_support::document_title(&webview) == "ready"), "the bare page loaded");
      drop(webview);
      settle(&runtime, Duration::from_millis(200));
    };
    // Warm-up: WebView2's DLLs, its threads and the browser process are there before counting.
    for _ in 0..2 {
      engine_life();
      bare_life();
    }
    let lives = 40;
    let bare = sweetview_platform_loop::testing::smallest_growth(lives, bare_life);
    let engine = sweetview_platform_loop::testing::smallest_growth(lives, engine_life);
    eprintln!("-- over {lives} lives: bare webview {bare:?}, engine {engine:?}");
    assert!(engine.user_objects <= 0 && engine.gdi_objects <= 0, "every window and GDI object given back: {engine:?}");
    assert!(bare.kernel_handles > 0, "WebView2 itself keeps a kernel handle per webview: {bare:?}");
    // Measured, three runs: bare 38, 41, 41; engine 40, 40, 40. WebView2's own count moves by a
    // few from run to run; one handle of ours per life would add `lives` (40) to it.
    let noise = lives as i64 / 8;
    assert!(
      engine.kernel_handles <= bare.kernel_handles + noise,
      "the engine keeps no kernel handle beyond the bare webview's (WebView2's own): {engine:?} vs {bare:?}"
    );
    drop(window);
  });
}

#[test]
fn a_popup_is_registered_for_only_while_a_handler_is_set_and_then_goes_to_it_and_not_to_a_window() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // With no handler, nothing of Sweetview's is registered for popups and WebView2 opens them
    // itself, as under the C++ fork (`wry` registered a handler on every webview and took a
    // deferral on every popup). With one (the tabs library's), a popup is reported to it on a
    // later turn of the loop and opens nothing; unset, the registration goes.
    let registered = |engine: &Engine| engine.inner.with_live(|live| test_support::new_window_registered(&live.extras)).expect("live");
    for host in HOSTS {
      let (engine, _windows) = make(host, |_| ());
      if host == "own window" {
        engine.show_own_window();
      }
      let reports = load(&runtime, &engine, PAGE);
      assert!(!registered(&engine), "{host}: nothing registered for popups with no handler");
      let popups: Rc<RefCell<Vec<String>>> = Rc::default();
      let sink = popups.clone();
      engine.set_new_window_handler(Some(Rc::new(move |url| sink.borrow_mut().push(url))));
      assert!(registered(&engine), "{host}: registered while a handler is set");
      engine.eval(
        "document.body.insertAdjacentHTML('beforeend', '<a href=\"https://popup.invalid/opened\" target=\"_blank\" style=\"position:fixed;left:0;top:0;width:150px;height:80px;display:block\">pop</a>'); report('link')",
      );
      assert!(pump_until(&runtime, Duration::from_secs(3), || reports.borrow().iter().any(|r| r.contains("link"))), "{host}: the link is there");
      let before = test_support::top_level_windows_of_process();
      for kind in ["mousePressed", "mouseReleased"] {
        let params = format!(r#"{{"type":"{kind}","x":40,"y":40,"button":"left","clickCount":1}}"#);
        assert_eq!(engine.call_devtools_protocol_method("Input.dispatchMouseEvent", &params), ErrorCode::Ok);
      }
      assert!(pump_until(&runtime, Duration::from_secs(5), || !popups.borrow().is_empty()), "{host}: the handler got the popup");
      settle(&runtime, Duration::from_millis(300));
      eprintln!("-- {host}: popups {:?}", popups.borrow());
      assert_eq!(*popups.borrow(), vec!["https://popup.invalid/opened".to_string()], "{host}: once, with its address");
      assert_eq!(test_support::top_level_windows_of_process(), before, "{host}: no window was opened for it");
      engine.set_new_window_handler(None);
      assert!(!registered(&engine), "{host}: the registration goes with the handler");
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
  });
}

#[test]
fn webview2_is_told_each_time_the_window_moves_in_every_kind_of_host() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // A webview whose window moves without WebView2 being told
    // (`NotifyParentWindowPositionChanged`) places what it draws itself at the window's old
    // place: a `<select>`'s list, a tooltip, and the input it routes (a click on a torn-off
    // tab's page missed its link). The page's `screenX`/`screenY` are WebView2's idea of
    // where it is: after a real move of the top-level window they follow it.
    for host in HOSTS {
      let (engine, _windows) = make(host, |_| ());
      if host == "own window" {
        engine.show_own_window();
      }
      let reports = load(&runtime, &engine, PAGE);
      let ask = |mark: &str| -> (f64, f64, f64) {
        reports.borrow_mut().clear();
        engine.eval(&format!("report('{mark} ' + screenX + ' ' + screenY + ' ' + devicePixelRatio)"));
        assert!(pump_until(&runtime, Duration::from_secs(3), || reports.borrow().iter().any(|r| r.contains(mark))), "{host}: the page answered");
        let said = reports.borrow().iter().find(|r| r.contains(mark)).cloned().unwrap_or_default();
        let numbers: Vec<f64> = said.trim_matches(|c| c == '[' || c == ']' || c == '"').split(' ').skip(1).filter_map(|n| n.trim_matches('"').parse().ok()).collect();
        assert_eq!(numbers.len(), 3, "{host}: {said}");
        (numbers[0], numbers[1], numbers[2])
      };
      let (x0, y0, scale) = ask("before");
      let (dx, dy) = (120, 80);
      webview_of(&engine, |webview| test_support::move_top_level_by(webview, dx, dy));
      settle(&runtime, Duration::from_millis(500));
      let (x1, y1, _) = ask("after");
      let want = (f64::from(dx) / scale, f64::from(dy) / scale);
      eprintln!("-- {host}: screenX/Y {x0},{y0} -> {x1},{y1} (scale {scale}), moved by {want:?}");
      assert!(((x1 - x0) - want.0).abs() <= 1.0 && ((y1 - y0) - want.1).abs() <= 1.0, "{host}: WebView2 follows the move: {x0},{y0} -> {x1},{y1}, want +{want:?}");
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
  });
}

#[test]
fn a_script_asked_for_right_after_a_new_webview_s_first_navigation_runs_in_the_new_document() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // D21: what the host asks of the page happens in the order asked. On a new webview, a
    // navigation, a binding and a script asked for at once (as `webview-load-in-flight.ts`
    // does): the script runs in the document the navigation makes, where the binding answers,
    // never in the blank document the webview starts with. Each round is a new webview.
    for host in HOSTS {
      for round in 0..6 {
        let (engine, _windows) = make(host, |_| ());
        let answers: Rc<RefCell<Vec<String>>> = Rc::default();
        let sink = answers.clone();
        let title = format!("first {round}");
        engine.set_html(&format!("<!doctype html><title>{title}</title><body>first</body>"));
        assert_eq!(engine.bind("answer", Rc::new(move |_seq, args| sink.borrow_mut().push(args.to_string()))), ErrorCode::Ok);
        engine.eval("answer(document.title)");
        assert!(pump_until(&runtime, Duration::from_secs(10), || !answers.borrow().is_empty()), "{host}, round {round}: the script answered");
        let said = answers.borrow().first().cloned().unwrap_or_default();
        eprintln!("-- {host}, round {round}: {said}");
        assert!(said.contains(&title), "{host}, round {round}: answered from the new document: {said}");
        engine.destroy();
        settle(&runtime, Duration::from_millis(50));
      }
    }
  });
}

#[test]
fn a_page_filling_a_window_follows_its_client_area_whoever_made_the_window() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // One rule for every filled host: the page is the size of the window's client area after
    // every resize, whoever resizes it. A window the application made itself (a plain Win32
    // window), the same adopted as a Sweetview `Window` (`Window.fromHandle`), a Sweetview
    // window, the size set through the webview (`setSize` on a filled window), and a window of
    // the webview's own.
    let check = |what: &str, engine: &Engine| {
      settle(&runtime, Duration::from_millis(400));
      let seen = webview_of(engine, test_support::fill_sizes);
      eprintln!("-- {what}: {seen:?}");
      assert!(seen.parent.0 > 0 && seen.parent.1 > 0, "{what}: a client area: {seen:?}");
      assert_eq!(seen.container, seen.parent, "{what}: the container fills the client area: {seen:?}");
      assert_eq!(seen.controller, seen.container, "{what}: the page fills the container: {seen:?}");
    };
    {
      let bare = test_support::BareWindow::new("engine test: bare");
      let engine = Engine::create(false, Host::Fill(bare.handle_value()), None).expect("fill a bare window");
      load(&runtime, &engine, PAGE);
      check("bare window, at first", &engine);
      bare.resize(700, 520);
      check("bare window, resized by its frame", &engine);
      engine.set_size(560, 400, SizeHint::None);
      check("bare window, setSize", &engine);
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    {
      let bare = test_support::BareWindow::new("engine test: adopted");
      let adopted = Window::adopt(bare.handle_value()).expect("adopt");
      let engine = Engine::create(false, Host::Fill(adopted.handle()), None).expect("fill an adopted window");
      load(&runtime, &engine, PAGE);
      bare.resize(720, 500);
      check("adopted window, resized by its frame", &engine);
      engine.set_size(540, 420, SizeHint::None);
      check("adopted window, setSize", &engine);
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
      drop(adopted);
    }
    {
      let window = host_window("engine test: sweetview window");
      let engine = Engine::create(false, Host::Fill(window.handle()), None).expect("fill");
      load(&runtime, &engine, PAGE);
      window.set_bounds(crate::Rect::new(60, 60, 680, 500));
      check("Sweetview window, set_bounds", &engine);
      engine.set_size(500, 360, SizeHint::None);
      check("Sweetview window, setSize", &engine);
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
    {
      let engine = Engine::create(false, Host::Own, None).expect("own");
      engine.show_own_window();
      load(&runtime, &engine, PAGE);
      engine.set_size(620, 440, SizeHint::None);
      check("own window, setSize", &engine);
      engine.destroy();
    }
  });
}

/// The order a webview and the window it is in go (D49, R1 and R3 of its first review), read
/// inside the `WM_DESTROY` of WebView2's own window under the webview's widget
/// (`Chrome_WidgetWin_0`), which closing the controller destroys.
mod teardown_order {
  use std::cell::Cell;

  use sweetview_platform_window::test_support::{first_child, post_close, watch_destroy};

  use super::*;

  /// WebView2's own window under the webview's widget.
  fn browser_window(engine: &Engine) -> isize {
    let container = engine.inner.with_live(|live| test_support::container_value(&live.webview)).flatten().expect("the webview's widget");
    BorrowedWindow::with_handle_value(container, |c| first_child(c)).flatten().expect("WebView2's window under the widget")
  }

  /// A standalone webview (its own window) shown, and `end` run: whether its own window was still
  /// on the screen at the moment the webview went.
  fn on_screen_as_it_goes(runtime: &Rc<Runtime>, end: fn(&Engine, isize)) -> Option<bool> {
    let engine = Engine::create(false, Host::Own, None).expect("a standalone webview");
    engine.show_own_window();
    let window = engine
      .inner
      .with_live(|live| {
        let HostWindow::Own { window, .. } = &live.window else { panic!("its own window") };
        window_value_of(window)
      })
      .expect("live");
    let browser = browser_window(&engine);
    let seen = Rc::new(Cell::new(None));
    let record = seen.clone();
    let watch = BorrowedWindow::with_handle_value(browser, |b| {
      watch_destroy(b, move || record.set(BorrowedWindow::with_handle_value(window, |w| sweetview_platform_window::is_visible(w))))
    })
    .expect("WebView2's window")
    .expect("watched");
    end(&engine, window);
    let deadline = Instant::now() + Duration::from_secs(5);
    while seen.get().is_none() && Instant::now() < deadline {
      runtime.pump();
    }
    drop(watch);
    seen.get()
  }

  /// R1: a standalone webview's window leaves the screen before the webview goes, on every path
  /// that ends it: `destroy()`, a close of its own window (the title bar's, `WM_CLOSE`), and the
  /// release at the end of the application. `Some(false)`: the window was hidden, and still a
  /// window, when the webview went.
  #[test]
  fn a_standalone_webviews_window_leaves_the_screen_before_the_webview_goes() {
    on_ui_thread(|runtime| {
      assert_eq!(on_screen_as_it_goes(&runtime, |engine, _| engine.destroy()), Some(false), "destroy()");
      assert_eq!(
        on_screen_as_it_goes(&runtime, |_, window| {
          BorrowedWindow::with_handle_value(window, |w| post_close(w));
        }),
        Some(false),
        "its own window closed"
      );
      assert_eq!(on_screen_as_it_goes(&runtime, |_, _| release_all()), Some(false), "the release at the end");
    });
  }

  /// R3: a webview whose drop waits because a webview callback is on the stack (a synchronous
  /// handler that disposes the application) still goes before the window it fills. Inside a
  /// callback scope the webview is destroyed, then its window disposed; once the scope is left
  /// and the loop turns, the order the two went in is read from their `WM_DESTROY`s.
  #[test]
  fn a_webview_whose_drop_waits_for_a_callback_still_goes_before_its_window() {
    on_ui_thread(|runtime| {
      let window = Window::create(WindowInit { title: "rt r3".into(), frame: true, resizable: true, no_activate: true, ..Default::default() }).expect("window");
      let handle = window.handle();
      let engine = Engine::create(false, Host::Fill(handle), crate::window::background_of(handle)).expect("webview");
      let browser = browser_window(&engine);
      let order = Rc::new(RefCell::new(Vec::new()));
      let (to_webview, to_window) = (order.clone(), order.clone());
      let watch_webview = BorrowedWindow::with_handle_value(browser, |b| watch_destroy(b, move || to_webview.borrow_mut().push("webview"))).expect("WebView2's window").expect("watched");
      let watch_window = BorrowedWindow::with_handle_value(handle, |w| watch_destroy(w, move || to_window.borrow_mut().push("window"))).expect("the window").expect("watched");
      {
        let _in_a_callback = CallbackScope::enter();
        engine.destroy();
        window.dispose();
      }
      let deadline = Instant::now() + Duration::from_secs(5);
      while order.borrow().len() < 2 && Instant::now() < deadline {
        runtime.pump();
      }
      drop((watch_webview, watch_window));
      assert_eq!(*order.borrow(), ["webview", "window"]);
    });
  }
}

#[test]
fn a_webview_whose_setup_fails_leaves_no_listener_of_its_own_window() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // X3: when WebView2 refuses the webview's request handling after the engine has made its own
    // window and registered that window's listener, the listener goes with the failed webview.
    let before = runtime.listener_count();
    test_support::fail_next_attach();
    assert!(Engine::create(false, Host::Own, None).is_err(), "the forced failure");
    settle(&runtime, Duration::from_millis(100));
    assert_eq!(runtime.listener_count(), before, "no listener left behind");
  });
}

/// A page at `http://webview.localhost/<name>` titled `name` that reports `ready <name>`.
fn serve_page(engine: &Engine, name: &str) -> String {
  let html = format!("<!doctype html><title>{name}</title><body>{name}<script>report('ready {name}')</script></body>");
  assert_eq!(engine.set_asset(name, "text/html", html.into_bytes()), ErrorCode::Ok);
  format!("http://webview.localhost/{name}")
}

#[test]
fn a_script_after_a_navigation_within_the_document_runs_at_once() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // Y1: a navigation that changes only the fragment makes no new document, and WebView2
    // raises no NavigationStarting for it: a script asked for after it runs in that document,
    // and what is asked for after it is not held behind it.
    let (engine, _windows) = make("given window", |_| ());
    let reports: Rc<RefCell<Vec<String>>> = Rc::default();
    let sink = reports.clone();
    assert_eq!(engine.bind("report", Rc::new(move |_seq, args| sink.borrow_mut().push(args.to_string()))), ErrorCode::Ok);
    let url = serve_page(&engine, "first");
    engine.navigate(&url);
    assert!(pump_until(&runtime, Duration::from_secs(10), || reports.borrow().iter().any(|r| r.contains("ready first"))), "the page loaded");
    for round in 0..3 {
      reports.borrow_mut().clear();
      engine.navigate(&format!("{url}#part{round}"));
      engine.eval("report('after ' + location.hash + ' in ' + document.title)");
      let ran = pump_until(&runtime, Duration::from_secs(5), || reports.borrow().iter().any(|r| r.contains("after")));
      eprintln!("-- round {round}: {:?}", reports.borrow());
      assert!(ran, "round {round}: the script after a fragment navigation ran");
      assert!(reports.borrow().iter().any(|r| r.contains("in first")), "round {round}: in the same document");
    }
    engine.destroy();
  });
}

#[test]
fn a_script_after_two_overlapping_navigations_runs_in_the_second_s_document() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // Y1: two navigations sent back to back, then a script: the first one's events are not
    // taken for the second's, and the script runs in the second one's document.
    for host in HOSTS {
      let (engine, _windows) = make(host, |_| ());
      let reports: Rc<RefCell<Vec<String>>> = Rc::default();
      let sink = reports.clone();
      assert_eq!(engine.bind("report", Rc::new(move |_seq, args| sink.borrow_mut().push(args.to_string()))), ErrorCode::Ok);
      let start = serve_page(&engine, "start");
      engine.navigate(&start);
      assert!(pump_until(&runtime, Duration::from_secs(10), || reports.borrow().iter().any(|r| r.contains("ready start"))), "{host}: loaded");
      for round in 0..4 {
        reports.borrow_mut().clear();
        let a = serve_page(&engine, &format!("a{round}"));
        let b = serve_page(&engine, &format!("b{round}"));
        engine.navigate(&a);
        engine.navigate(&b);
        engine.eval("report('script in ' + document.title)");
        let ran = pump_until(&runtime, Duration::from_secs(10), || reports.borrow().iter().any(|r| r.contains("script in")));
        let said = reports.borrow().iter().find(|r| r.contains("script in")).cloned().unwrap_or_default();
        eprintln!("-- {host}, round {round}: {said}");
        assert!(ran, "{host}, round {round}: the script ran");
        assert!(said.contains(&format!("script in b{round}")), "{host}, round {round}: in the second navigation's document: {said}");
      }
      engine.destroy();
      settle(&runtime, Duration::from_millis(100));
    }
  });
}

#[test]
fn a_webview_whose_drop_script_is_refused_is_a_failed_setup() {
  on_ui_thread(|runtime| {
    let _finish = Finish(&runtime);
    // Y4: WebView2 refusing the drop script's registration (an answer with no script id) is a
    // failed setup, not a webview that would take no drop; nothing of it is left.
    for host in HOSTS {
      let before = runtime.listener_count();
      test_support::refuse_next_drop_script();
      let made = match host {
        "own window" => Engine::create(false, Host::Own, None).map(|engine| (engine, Vec::new())),
        _ => {
          let window = host_window("engine test: refused drop script");
          Engine::create(false, Host::Fill(window.handle()), None).map(|engine| (engine, vec![window]))
        }
      };
      assert!(made.is_err(), "{host}: the refused registration fails the setup");
      settle(&runtime, Duration::from_millis(100));
      assert_eq!(runtime.listener_count(), before, "{host}: nothing left behind");
      if host != "own window" {
        break;
      }
    }
  });
}
