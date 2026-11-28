//! What each window option and call does to the real window, read back from the OS, and the
//! real input the window gestures follow: what `window-native.test.ts` and `window.test.ts`
//! proved from Bun through `bun:ffi` probes. The cursor is moved and put back; the left button is
//! pressed only over the test's own window and always released.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use sweetview_platform_window::test_support as os;
use sweetview_platform_window::{self as platform, BorrowedWindow};
use sweetview_window_logic::style::{
  WS_EX_ACCEPTFILES, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

use crate::runtime::testing::on_ui_thread;
use crate::runtime::Runtime;
use crate::screen;
use crate::window::tab_frame::TabFrame;
use crate::window::{tracked_count, Appearance, Chrome, Dips, Window, WindowInit};
use crate::{Rect, ResizeEdge};

const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_THICKFRAME: u32 = 0x0004_0000;
const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
const WM_CLOSE: u32 = 0x0010;
const WM_SYSCOMMAND: u32 = 0x0112;
const SC_MINIMIZE: usize = 0xf020;
const SC_MAXIMIZE: usize = 0xf030;
const SC_RESTORE: usize = 0xf120;
/// The tab strip of a tabbed window, as `strip-shared.ts` has it.
const STRIP_HEIGHT: u32 = 40;

fn init(title: &str) -> WindowInit {
  WindowInit { title: title.into(), frame: true, resizable: true, ..Default::default() }
}

fn tabbed(title: &str) -> WindowInit {
  WindowInit { tab_strip_height: Some(STRIP_HEIGHT), ..init(title) }
}

fn ex_style(handle: isize) -> u32 {
  BorrowedWindow::with_handle_value(handle, |w| platform::ex_style(w)).expect("a live window")
}

fn style(handle: isize) -> u32 {
  BorrowedWindow::with_handle_value(handle, |w| platform::style(w)).expect("a live window")
}

fn iconic(handle: isize) -> bool {
  BorrowedWindow::with_handle_value(handle, |w| platform::is_minimized(w)).unwrap_or(false)
}

fn alive(handle: isize) -> bool {
  BorrowedWindow::with_handle_value(handle, |_| ()).is_some()
}

fn outer(handle: isize) -> Rect {
  BorrowedWindow::with_handle_value(handle, |w| platform::outer_bounds(w)).flatten().expect("the window's bounds")
}

/// Pumps for `ms`, or until `done`.
fn pump_until(runtime: &Runtime, ms: u64, done: impl Fn() -> bool) -> bool {
  let deadline = Instant::now() + Duration::from_millis(ms);
  while !done() && Instant::now() < deadline {
    runtime.pump();
    std::thread::sleep(Duration::from_millis(5));
  }
  done()
}

/// The shared desktop in the state a check needs (no button held, the test's window under the
/// cursor): tried a few times, with `between` run before each retry, or the test refuses to judge.
fn until_desktop_is_ours(runtime: &Runtime, what: &str, ready: impl Fn() -> bool, between: impl Fn()) {
  for attempt in 1..=5 {
    if ready() {
      return;
    }
    if attempt < 5 {
      pump_until(runtime, 250, || false);
      between();
    }
  }
  panic!("refused to judge: {what}, after 5 attempts (the desktop is shared with other sessions); run again");
}

/// Puts the cursor back, and lets go of the left button if the test left it down, when dropped.
struct InputBack {
  cursor: (i32, i32),
  pressed: Rc<Cell<bool>>,
}

impl InputBack {
  fn here() -> Self {
    Self { cursor: os::cursor(), pressed: Rc::default() }
  }

  fn press(&self) {
    os::send_left_button(true);
    self.pressed.set(true);
  }
}

impl Drop for InputBack {
  fn drop(&mut self) {
    if self.pressed.get() {
      os::send_left_button(false);
    }
    os::set_cursor(self.cursor.0, self.cursor.1);
  }
}

// ---- options, read back from the OS ------------------------------------------------------------------

/// `window-native.test.ts` "bounds, title, frame, resizable and the minimum size".
#[test]
fn the_title_frame_resizability_and_minimum_size_are_the_real_windows() {
  on_ui_thread(|_runtime| {
    let title = format!("rt os framed {}", std::process::id());
    let framed = Window::create(WindowInit { bounds: Some(Rect::new(140, 130, 500, 360)), min_width: Some(420), min_height: Some(300), ..init(&title) }).expect("framed");
    let fixed = Window::create(WindowInit { resizable: false, ..init("rt os fixed") }).expect("fixed");
    let frameless = Window::create(WindowInit { frame: false, bounds: Some(Rect::new(150, 150, 220, 140)), ..init("rt os frameless") }).expect("frameless");
    assert_eq!(framed.bounds(), Rect::new(140, 130, 500, 360));
    assert_eq!(os::title_of(framed.handle()), title);
    framed.set_title(&format!("renamed {title}"));
    assert_eq!(os::title_of(framed.handle()), format!("renamed {title}"));

    let (client, frame) = (os::client_size(framed.handle()), outer(framed.handle()));
    assert!(client.1 < frame.height, "a title bar and borders: client {client:?}, outer {frame:?}");
    let (client, frame) = (os::client_size(frameless.handle()), outer(frameless.handle()));
    assert_eq!(client, (frame.width, frame.height), "frameless: the page fills the whole window");

    assert_eq!(style(framed.handle()) & WS_THICKFRAME, WS_THICKFRAME);
    assert_eq!(style(fixed.handle()) & (WS_THICKFRAME | WS_MAXIMIZEBOX), 0);
    // MINMAXINFO.ptMinTrackSize is the outer minimum, in physical pixels.
    assert_eq!(os::min_track_size(framed.handle()), (420, 300));
    for window in [framed, fixed, frameless] {
      window.dispose();
    }
  });
}

/// `window-native.test.ts` "appearance sets the title bar's dark mode", and `window.test.ts`
/// "tabbed windows keep per-frame appearance; system updates only touch system frames".
#[test]
fn appearance_sets_the_title_bars_dark_mode_and_a_system_change_reaches_only_system_frames() {
  on_ui_thread(|_runtime| {
    let dark = Window::create(WindowInit { appearance: Appearance::Dark, ..init("rt os dark") }).expect("dark");
    let light = Window::create(WindowInit { appearance: Appearance::Light, ..init("rt os light") }).expect("light");
    assert_eq!(os::uses_dark_title_bar(dark.handle()), Some(true));
    assert_eq!(os::uses_dark_title_bar(light.handle()), Some(false));
    dark.dispose();
    light.dispose();

    let windows: Vec<Window> = [Appearance::Dark, Appearance::Light, Appearance::System]
      .into_iter()
      .map(|appearance| Window::create(WindowInit { appearance, ..tabbed("rt os tab appearance") }).expect("tabbed"))
      .collect();
    let frames: Vec<TabFrame> = windows.iter().map(|w| TabFrame::of(w.handle()).expect("a tab frame")).collect();
    let (dark, light, system) = (&frames[0], &frames[1], &frames[2]);
    let dwm = |frame: &TabFrame| os::uses_dark_title_bar(frame.handle()).expect("DwmGetWindowAttribute");
    assert!(dark.is_dark() && dwm(dark));
    assert!(!light.is_dark() && !dwm(light));
    // The system turns dark, then light, as `setDarkWindows` tells every frame.
    for frame in &frames {
      frame.set_system_dark(true);
    }
    assert!(!light.is_dark() && !dwm(light), "an explicit light frame stays light");
    assert!(system.is_dark() && dwm(system), "a system frame follows");
    for frame in &frames {
      frame.set_system_dark(false);
    }
    assert!(dark.is_dark() && dwm(dark), "an explicit dark frame stays dark");
    assert!(!system.is_dark() && !dwm(system));
    // Told one by one.
    system.set_system_dark(true);
    light.set_system_dark(true);
    dark.set_system_dark(false);
    assert!(system.is_dark() && !light.is_dark() && dark.is_dark());
    assert!(!dwm(light));
    for window in windows {
      window.dispose();
    }
  });
}

/// `window.test.ts` "tabbed windows honor topmost on creation and setTopmost afterwards" and
/// "tabbed windows apply resizable, opacity, hideFromTaskbar, noActivate and outer minimum size".
#[test]
fn a_tab_frame_takes_topmost_resizability_opacity_taskbar_activation_and_minimum_size() {
  on_ui_thread(|_runtime| {
    let top = Window::create(WindowInit { topmost: true, ..tabbed("rt os tab topmost") }).expect("tabbed");
    let topmost = || ex_style(top.handle()) & WS_EX_TOPMOST != 0;
    assert!(topmost());
    top.set_topmost(false);
    assert!(!topmost());
    top.set_topmost(true);
    assert!(topmost());
    top.dispose();

    let window = Window::create(WindowInit {
      resizable: false,
      opacity: Some(0.5),
      hide_from_taskbar: true,
      no_activate: true,
      min_width: Some(700),
      min_height: Some(500),
      ..tabbed("rt os tab options")
    })
    .expect("tabbed");
    assert_eq!(style(window.handle()) & (WS_THICKFRAME | WS_MAXIMIZEBOX), 0);
    let ex = ex_style(window.handle());
    assert_eq!(ex & (WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE), WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
    // Outer physical pixels: the caller's minimums apply unscaled.
    assert_eq!(os::min_track_size(window.handle()), (700, 500));
    window.dispose();
  });
}

/// `window.test.ts` "contentSize is the page area in DIPs at the window's scale, centred on the
/// primary work area and kept on it; a tabbed window's page is below its strip" (the framed case
/// is `window_tests.rs`'s).
#[test]
fn content_size_for_frameless_and_tabbed_windows_and_one_larger_than_the_work_area() {
  on_ui_thread(|_runtime| {
    let area = screen::primary().expect("primary").work_area;
    let centred = |bounds: Rect| (area.x + ((area.width - bounds.width) / 2).max(0), area.y + ((area.height - bounds.height) / 2).max(0));
    let frameless = Window::create(WindowInit { frame: false, content_size: Some(Dips::new(410.0, 270.0)), ..init("rt os content frameless") }).expect("frameless");
    let tabs = Window::create(WindowInit { content_size: Some(Dips::new(700.0, 420.0)), ..tabbed("rt os content tabbed") }).expect("tabbed");
    for (name, window, width, height, strip) in [("frameless", &frameless, 410.0, 270.0, 0.0), ("tabbed", &tabs, 700.0, 420.0, f64::from(STRIP_HEIGHT))] {
      let scale = window.scale();
      let want = ((width * scale).round() as i32, ((height + strip) * scale).round() as i32);
      assert_eq!(os::client_size(window.handle()), want, "{name}: the page is what was asked for at the screen's scale");
      let bounds = window.bounds();
      assert_eq!((bounds.x, bounds.y), centred(bounds), "{name}: centred on the primary work area");
      assert!(!window.is_visible(), "{name}");
    }
    assert_eq!(frameless.bounds().width, os::client_size(frameless.handle()).0, "frameless: the outer frame is the page");
    let huge = Window::create(WindowInit { content_size: Some(Dips::new(100_000.0, 100_000.0)), ..init("rt os content huge") }).expect("huge");
    assert_eq!(huge.bounds(), area, "larger than the work area: the whole window is cut to it");
    for window in [frameless, tabs, huge] {
      window.dispose();
    }
  });
}

/// `window.test.ts` "Window.fromHandle reports the wrapped window's frame and resizability".
#[test]
fn adopting_reports_the_wrapped_windows_frame_and_resizability() {
  on_ui_thread(|_runtime| {
    let made = [
      Window::create(WindowInit { frame: false, resizable: false, ..init("rt os frameless") }).expect("frameless"),
      Window::create(WindowInit { resizable: false, ..init("rt os fixed") }).expect("fixed"),
      Window::create(init("rt os framed")).expect("framed"),
    ];
    let detected: Vec<Option<Chrome>> = made.iter().map(|w| Window::adopt(w.handle()).expect("adopt").detected()).collect();
    assert_eq!(
      detected,
      [
        Some(Chrome { frame: false, resizable: false }),
        Some(Chrome { frame: true, resizable: false }),
        Some(Chrome { frame: true, resizable: true }),
      ]
    );
    for window in made {
      window.dispose();
    }
  });
}

/// `window-native.test.ts` "Screen.of a window is the screen its frame is on; Screen.bounds holds
/// every screen".
#[test]
fn the_screen_of_a_window_is_the_one_its_frame_is_on_and_the_virtual_screen_holds_every_screen() {
  on_ui_thread(|_runtime| {
    let primary = screen::primary().expect("primary");
    let at = Rect::new(primary.work_area.x + 40, primary.work_area.y + 40, 200, 120);
    let window = Window::create(WindowInit { bounds: Some(at), ..init("rt os screen") }).expect("window");
    assert_eq!(screen::of_window(window.handle()).expect("screen").bounds, primary.bounds);
    let all = screen::virtual_screen().expect("virtual screen");
    for one in screen::all().expect("screens") {
      let b = one.bounds;
      assert!(b.x >= all.x && b.y >= all.y && b.x + b.width <= all.x + all.width && b.y + b.height <= all.y + all.height, "{b:?} in {all:?}");
    }
    window.dispose();
  });
}

/// `window.test.ts` "backgroundColor is what a window shows where nothing has painted, a tabbed
/// window's page area too", read from the screen; and "the probe's screenPixel throws for a point
/// no screen shows, rather than reading it as white".
#[test]
fn a_windows_background_colour_is_what_the_screen_shows_where_nothing_has_painted() {
  on_ui_thread(|runtime| {
    let area = screen::primary().expect("primary").work_area;
    let plain = Window::create(WindowInit {
      background_color: Some("#204060".into()),
      topmost: true,
      no_activate: true,
      bounds: Some(Rect::new(area.x + 40, area.y + 40, 260, 200)),
      ..init("rt os background plain")
    })
    .expect("plain");
    let tabs = Window::create(WindowInit {
      background_color: Some("#603020".into()),
      topmost: true,
      no_activate: true,
      bounds: Some(Rect::new(area.x + 340, area.y + 40, 460, 340)),
      ..tabbed("rt os background tabbed")
    })
    .expect("tabbed");
    // The middle of the client area below `top` physical pixels (a tab frame's strip).
    let middle = |handle: isize, top: i32| {
      let (width, height) = os::client_size(handle);
      os::client_to_screen(handle, width / 2, top + (height - top) / 2)
    };
    let shows = |window: &Window, want: u32, top: i32| {
      window.show().expect("show");
      let at = middle(window.handle(), top);
      pump_until(runtime.as_ref(), 5000, || os::screen_pixel(at.0, at.1) == Some(want));
      let seen = os::screen_pixel(at.0, at.1);
      if seen != Some(want) && os::window_at(at.0, at.1) != window.handle() {
        panic!("refused to judge: another window ({:#x}) covers the test's window at {at:?}; run again", os::window_at(at.0, at.1));
      }
      seen
    };
    assert_eq!(shows(&plain, 0x20_40_60, 0), Some(0x20_40_60));
    assert_eq!(shows(&tabs, 0x60_30_20, (f64::from(STRIP_HEIGHT) * tabs.scale()).round() as i32), Some(0x60_30_20), "a tabbed window's page area");
    let far = screen::virtual_screen().expect("virtual screen");
    assert_eq!(os::screen_pixel(far.x - 10_000, far.y - 10_000), None, "a point no screen shows is no colour");
    plain.dispose();
    tabs.dispose();
  });
}

// ---- visibility, minimise and maximise -------------------------------------------------------------

/// `window.test.ts` "isMinimized follows the OS (IsIconic) for created, frameless, tabbed and
/// wrapped windows; a hidden window is not minimised" and "a window minimised and then hidden is
/// still minimised (IsIconic), and show() restores it"; `window-native.test.ts` "minimize, show
/// restoring it, and toggleMaximize on a framed window".
#[test]
fn visibility_minimise_and_maximise_follow_the_os_for_every_kind_of_window() {
  on_ui_thread(|_runtime| {
    let framed = Window::create(WindowInit { no_activate: true, bounds: Some(Rect::new(140, 140, 320, 240)), ..init("rt os minimised framed") }).expect("framed");
    let frameless = Window::create(WindowInit { frame: false, no_activate: true, bounds: Some(Rect::new(160, 160, 320, 240)), ..init("rt os minimised frameless") }).expect("frameless");
    let tabs = Window::create(WindowInit { no_activate: true, ..tabbed("rt os minimised tabbed") }).expect("tabbed");
    // A window Sweetview did not make, and one of its own wrapped.
    let own = os::OwnWindow::new("rt os minimised own", (180, 180, 320, 240), |_| {}).expect("the application's own window");
    BorrowedWindow::with_handle_value(own.handle_value(), |w| platform::show_as(w, platform::ShowAs::Hidden));
    let wrapped = Window::adopt(own.handle_value()).expect("adopt");
    let wrapper_of_owned = Window::adopt(framed.handle()).expect("adopt own");
    let state = |w: &Window| (w.is_visible(), w.is_minimized(), iconic(w.handle()));
    for (name, window) in [("framed", &framed), ("frameless", &frameless), ("tabbed", &tabs), ("wrapped", &wrapped)] {
      assert_eq!(state(window), (false, false, false), "{name}: hidden is not minimised");
      window.show().expect("show");
      assert_eq!(state(window), (true, false, false), "{name}: shown");
      window.minimize();
      assert_eq!(state(window), (true, true, true), "{name}: a minimised window is still visible; isMinimized tells them apart");
      window.show().expect("restore");
      assert_eq!(state(window), (true, false, false), "{name}: show() restores it");
      window.hide();
      assert_eq!((window.is_visible(), window.is_minimized()), (false, false), "{name}: hidden");
    }
    framed.show().expect("show");
    framed.minimize();
    assert!(wrapper_of_owned.is_minimized(), "a wrapper of an owned window reads the OS");
    framed.show().expect("restore");
    assert!(!wrapper_of_owned.is_minimized());

    // Minimised, then hidden: still minimised, and show() restores it.
    framed.minimize();
    framed.hide();
    assert_eq!(state(&framed), (false, true, true));
    framed.show().expect("show");
    assert_eq!((framed.is_visible(), framed.is_minimized()), (true, false));

    // A framed window's maximise is the OS's own.
    let zoomed = || BorrowedWindow::with_handle_value(framed.handle(), |w| platform::is_zoomed(w)).unwrap_or(false);
    framed.toggle_maximize().expect("maximise");
    assert!(framed.is_maximized() && zoomed());
    framed.toggle_maximize().expect("restore");
    assert!(!framed.is_maximized() && !zoomed());

    wrapper_of_owned.dispose();
    wrapped.dispose();
    framed.dispose();
    assert!(!framed.is_minimized(), "a disposed window is not minimised");
    frameless.dispose();
    tabs.dispose();
    drop(own);
  });
}

/// `window.test.ts` "onMaximizeChange reports each change, by toggleMaximize or the system's own
/// commands, once; nothing for a minimise and restore; frameless and tabbed windows too".
#[test]
fn the_systems_own_commands_report_maximise_changes_once_for_framed_frameless_and_tabbed_windows() {
  on_ui_thread(|_runtime| {
    let area = screen::primary().expect("primary").work_area;
    let at = Rect::new(area.x + 120, area.y + 120, 420, 300);
    let framed = Window::create(WindowInit { no_activate: true, bounds: Some(at), ..init("rt os maximise commands") }).expect("framed");
    let wrapped = Window::adopt(framed.handle()).expect("adopt");
    let (framed_seen, wrapper_seen) = (Rc::new(RefCell::new(Vec::new())), Rc::new(RefCell::new(Vec::new())));
    let (a, b) = (framed_seen.clone(), wrapper_seen.clone());
    framed.on_maximize_change(Some(Rc::new(move |m| a.borrow_mut().push(m)))).expect("listener");
    wrapped.on_maximize_change(Some(Rc::new(move |m| b.borrow_mut().push(m)))).expect("listener");
    let command = |sc: usize| os::send(framed.handle(), WM_SYSCOMMAND, sc, 0);
    framed.show().expect("show");
    framed.toggle_maximize().expect("maximise");
    framed.toggle_maximize().expect("restore");
    // The frame's maximise button, a snap and a title bar double click all end as the system command.
    command(SC_MAXIMIZE);
    command(SC_MINIMIZE);
    assert!(framed.is_minimized());
    command(SC_RESTORE); // back to maximised: no change to report
    assert!(framed.is_maximized());
    command(SC_RESTORE);
    assert_eq!(*framed_seen.borrow(), [true, false, true, false]);
    assert_eq!(*wrapper_seen.borrow(), [true, false, true, false]);
    wrapped.on_maximize_change(None).expect("removed");
    framed.toggle_maximize().expect("maximise");
    assert_eq!(wrapper_seen.borrow().len(), 4);
    assert_eq!(*framed_seen.borrow(), [true, false, true, false, true]);
    wrapped.dispose();
    framed.dispose();

    let frameless = Window::create(WindowInit { frame: false, no_activate: true, bounds: Some(at), ..init("rt os maximise frameless") }).expect("frameless");
    let tabs = Window::create(WindowInit { no_activate: true, bounds: Some(Rect::new(at.x, at.y, 700, 500)), ..tabbed("rt os maximise tabbed") }).expect("tabbed");
    for (name, window) in [("frameless", &frameless), ("tabbed", &tabs)] {
      let seen = Rc::new(RefCell::new(Vec::new()));
      let sink = seen.clone();
      window.on_maximize_change(Some(Rc::new(move |m| sink.borrow_mut().push(m)))).expect("listener");
      window.show().expect("show");
      window.toggle_maximize().expect("maximise");
      assert!(window.is_maximized(), "{name}");
      window.toggle_maximize().expect("restore");
      window.on_maximize_change(None).expect("removed");
      window.toggle_maximize().expect("maximise again");
      assert_eq!(*seen.borrow(), [true, false], "{name}");
    }
    frameless.dispose();
    tabs.dispose();
  });
}

/// `window.test.ts` "a frameless window maximised by toggleMaximize stays maximised when it is
/// moved or sized, and its next toggle gives back the bounds it had before, as at the tag".
#[test]
fn a_frameless_window_maximised_stays_maximised_when_moved_or_sized_and_its_next_toggle_gives_back_its_bounds() {
  on_ui_thread(|_runtime| {
    let start = Rect::new(150, 150, 320, 240);
    type Change = fn(&Window);
    let changes: [(&str, Change); 3] = [
      ("set_bounds", |w| w.set_bounds(Rect::new(10, 20, 500, 400))),
      ("move_to", |w| w.move_to(30, 40)),
      ("resize", |w| w.resize(600, 450)),
    ];
    for (name, change) in changes {
      let window = Window::create(WindowInit { frame: false, no_activate: true, bounds: Some(start), ..init("rt os frameless maximised") }).expect("window");
      window.toggle_maximize().expect("maximise");
      assert!(window.is_maximized(), "{name}");
      change(&window);
      assert!(window.is_maximized(), "{name}: still maximised");
      window.toggle_maximize().expect("restore");
      assert_eq!((window.is_maximized(), window.bounds()), (false, start), "{name}");
      window.dispose();
    }
  });
}

// ---- the application's own windows -------------------------------------------------------------------

/// `window-native.test.ts` "a popup window the application made reads as not maximised when
/// wrapped, as at the tag, and reports nothing when it is restored".
#[test]
fn an_applications_own_popup_window_wrapped_after_maximise_and_minimise_reads_as_not_maximised() {
  on_ui_thread(|_runtime| {
    let own = os::OwnWindow::new("rt os own popup", (80, 80, 300, 200), |_| {}).expect("the application's own popup");
    let command = |sc: usize| os::send(own.handle_value(), WM_SYSCOMMAND, sc, 0);
    command(SC_MAXIMIZE);
    command(SC_MINIMIZE);
    let wrapped = Window::adopt(own.handle_value()).expect("adopt");
    assert!(!wrapped.is_maximized());
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    wrapped.on_maximize_change(Some(Rc::new(move |m| sink.borrow_mut().push(m)))).expect("listener");
    command(SC_RESTORE);
    assert_eq!((wrapped.is_maximized(), seen.borrow().clone()), (false, vec![]));
    wrapped.dispose();
  });
}

/// `window-native.test.ts` "onResize, onMove, onClose and onFileDrop arrive; dispose leaves the
/// window alive", and `window.test.ts` "Window.fromHandle intercepts events non-mutatingly and
/// dispose does not destroy the external HWND".
#[test]
fn an_applications_own_window_reports_resize_move_close_and_drops_and_outlives_its_wrapper() {
  on_ui_thread(|_runtime| {
    let own = os::OwnWindow::new("rt os own events", (50, 50, 300, 200), |_| {}).expect("the application's own window");
    let handle = own.handle_value();
    let wrapped = Window::adopt(handle).expect("adopt");
    assert_eq!(wrapped.handle(), handle);
    let seen: Rc<RefCell<Vec<String>>> = Rc::default();
    let drops: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
    let (a, b, c, d) = (seen.clone(), seen.clone(), seen.clone(), drops.clone());
    wrapped.on_resize(Some(Rc::new(move |r| a.borrow_mut().push(format!("resize {}x{}", r.width, r.height))))).expect("resize");
    wrapped.on_move(Some(Rc::new(move |r| b.borrow_mut().push(format!("move {},{}", r.x, r.y))))).expect("move");
    wrapped.on_close_request(Some(Rc::new(move || c.borrow_mut().push("close".into())))).expect("close");
    wrapped.on_file_drop(Some(Rc::new(move |paths| d.borrow_mut().push(paths)))).expect("drop");
    wrapped.set_bounds(Rect::new(70, 80, 320, 210));
    assert!(seen.borrow().contains(&"resize 320x210".to_owned()), "{:?}", seen.borrow());
    assert!(seen.borrow().contains(&"move 70,80".to_owned()), "{:?}", seen.borrow());
    os::send(handle, WM_CLOSE, 0, 0);
    assert!(seen.borrow().contains(&"close".to_owned()));
    assert!(own.is_alive(), "the listener took the request");
    let paths = [r"C:\example\one.txt", r"C:\example\two.txt"];
    assert!(os::send_file_drop(handle, &paths), "the drop was freed");
    assert_eq!(*drops.borrow(), [paths.map(str::to_owned).to_vec()]);
    wrapped.dispose();
    assert!(own.is_alive(), "dispose leaves the application's window alive");
    // Unhooked: the window's own procedure gets the close request again, and destroys the window.
    os::send(handle, WM_CLOSE, 0, 0);
    assert_eq!(seen.borrow().iter().filter(|s| *s == "close").count(), 1);
    assert!(!own.is_alive());
  });
}

/// `window.test.ts` "delivers Unicode file drops and cleans up owned, tabbed and borrowed
/// listeners": a drop listener asks the OS for drops (`WS_EX_ACCEPTFILES`) while it is there, the
/// drop arrives with every path, and the window frees it; removing it gives the drops back.
#[test]
fn a_drop_listener_takes_drops_only_while_it_is_there_on_owned_tabbed_and_adopted_windows() {
  on_ui_thread(|_runtime| {
    let own = os::OwnWindow::new("rt os own drops", (60, 60, 300, 200), |_| {}).expect("the application's own window");
    let owned = Window::create(init("rt os drops owned")).expect("owned");
    let tabs = Window::create(tabbed("rt os drops tabbed")).expect("tabbed");
    let borrowed = Window::adopt(own.handle_value()).expect("adopt");
    let paths = ["C:\\example\\\u{65e5}\u{672c}\u{8a9e} \u{1f950}.txt", "C:\\example\\second.bin"];
    for (name, window) in [("owned", &owned), ("tabbed", &tabs), ("borrowed", &borrowed)] {
      let handle = window.handle();
      let tracked = tracked_count(handle);
      let delivered: Rc<RefCell<Vec<Vec<String>>>> = Rc::default();
      let sink = delivered.clone();
      window.on_file_drop(Some(Rc::new(move |files| sink.borrow_mut().push(files)))).expect("drop listener");
      assert_eq!(ex_style(handle) & WS_EX_ACCEPTFILES, WS_EX_ACCEPTFILES, "{name}: accepts drops");
      assert!(os::send_file_drop(handle, &paths), "{name}: the drop was freed");
      assert_eq!(*delivered.borrow(), [paths.map(str::to_owned).to_vec()], "{name}");
      window.on_file_drop(None).expect("removed");
      window.on_file_drop(None).expect("removed twice");
      assert_eq!(ex_style(handle) & WS_EX_ACCEPTFILES, 0, "{name}: accepts no drops");
      assert_eq!(tracked_count(handle), tracked, "{name}");
      window.on_file_drop(Some(Rc::new(|_| {}))).expect("drop listener");
      window.dispose();
      assert_eq!(tracked_count(handle), 0, "{name}: released");
    }
    assert!(own.is_alive());
    assert_eq!(ex_style(own.handle_value()) & WS_EX_ACCEPTFILES, 0, "the application's window accepts no drops after the release");
  });
}

/// `window.test.ts` "closing one window disposes it without posting WM_QUIT to kill the app loop".
#[test]
fn a_window_closed_with_no_listener_goes_and_the_loop_goes_on() {
  on_ui_thread(|runtime| {
    let closing = Window::create(init("rt os close me")).expect("window");
    let staying = Window::create(init("rt os stay alive")).expect("window");
    let handle = closing.handle();
    os::send(handle, WM_CLOSE, 0, 0);
    assert!(!alive(handle));
    assert_eq!(tracked_count(handle), 0);
    assert!(alive(staying.handle()));
    assert!(runtime.pump(), "no quit was posted");
    closing.dispose();
    staying.dispose();
  });
}

/// `window-native.test.ts` "the blocking loop and the Bun-timer loop deliver a close request and
/// run the hit-region poll".
#[test]
fn both_loop_modes_deliver_a_close_request_and_run_the_hit_region_poll() {
  on_ui_thread(|runtime| {
    for blocking in [true, false] {
      let window = Window::create(WindowInit { frame: false, no_activate: true, bounds: Some(Rect::new(-3000, -3000, 100, 100)), ..init("rt os loop modes") }).expect("window");
      let seen: Rc<RefCell<Vec<&'static str>>> = Rc::default();
      let done = Rc::new(Cell::new(false));
      let (sink, finished, inner) = (seen.clone(), done.clone(), runtime.clone());
      window
        .on_close_request(Some(Rc::new(move || {
          sink.borrow_mut().push(if inner.is_blocking() { "close in the blocking loop" } else { "close in a pump" });
          finished.set(true);
          inner.request_exit();
        })))
        .expect("close");
      window.show().expect("show");
      window.set_hit_regions(Some(Vec::new()), None).expect("no polygon: the whole window lets clicks through");
      let handle = window.handle();
      runtime.set_timeout(50, move || {
        os::post(handle, WM_CLOSE, 0, 0);
      }).expect("timeout");
      if blocking {
        let quitter = runtime.clone();
        let watchdog = runtime.set_timeout(5000, move || quitter.request_exit()).expect("watchdog");
        runtime.run_blocking().expect("blocking run");
        runtime.clear_timeout(watchdog);
      } else {
        pump_until(runtime.as_ref(), 5000, || done.get());
        runtime.discard_quit();
      }
      assert_eq!(*seen.borrow(), [if blocking { "close in the blocking loop" } else { "close in a pump" }]);
      assert_eq!(ex_style(handle) & WS_EX_TRANSPARENT, WS_EX_TRANSPARENT, "the poll ran");
      window.dispose();
    }
  });
}

// ---- real input: the hit-region poll and the gestures ------------------------------------------------

/// `window-native.test.ts` "the 10 ms poll follows the cursor into and out of a polygon, with and
/// without the refiner".
#[test]
fn the_hit_region_poll_follows_the_real_cursor_with_and_without_a_refiner() {
  on_ui_thread(|runtime| {
    let _back = InputBack::here();
    let bounds = Rect::new(260, 240, 300, 200);
    let window = Rc::new(Window::create(WindowInit { frame: false, topmost: true, no_activate: true, bounds: Some(bounds), ..init("rt os hit regions") }).expect("window"));
    let handle = window.handle();
    let passing = || ex_style(handle) & WS_EX_TRANSPARENT != 0;
    // The left half, packed as `packRegions` packs it: count, bounds, then the points.
    let left_half = || vec![4, 0, 0, 150, 200, 0, 0, 150, 0, 150, 200, 0, 200];
    // The poll freezes while a button is held: wait for another session's button to be let go.
    until_desktop_is_ours(runtime.as_ref(), "hit-region poll: a mouse button is held", || !os::buttons_down(), || {});
    window.show().expect("show");
    window.set_hit_regions(Some(left_half()), None).expect("regions");
    os::set_cursor(bounds.x + 50, bounds.y + 50);
    pump_until(runtime.as_ref(), 200, || false);
    assert!(!passing(), "inside the polygon: solid");
    os::set_cursor(bounds.x + 250, bounds.y + 50);
    pump_until(runtime.as_ref(), 200, || false);
    assert!(passing(), "outside: clicks fall through");

    // With a refiner the page decides inside the polygon.
    let asked: Rc<RefCell<Vec<(i32, i32)>>> = Rc::default();
    let answer = Rc::new(Cell::new(false));
    let (sink, says, owner) = (asked.clone(), answer.clone(), Rc::downgrade(&window));
    let refiner: crate::window::Refiner = Rc::new(move |x, y, seq| {
      sink.borrow_mut().push((x, y));
      if let Some(window) = owner.upgrade() {
        window.answer_hit(seq, says.get());
      }
    });
    window.set_hit_regions(Some(left_half()), Some(refiner.clone())).expect("regions");
    os::set_cursor(bounds.x + 60, bounds.y + 70);
    pump_until(runtime.as_ref(), 200, || false);
    assert!(asked.borrow().contains(&(60, 70)), "the refiner was asked at the cursor: {:?}", asked.borrow());
    assert!(passing(), "it said transparent");
    answer.set(true);
    window.set_hit_regions(Some(left_half()), Some(refiner)).expect("regions");
    os::set_cursor(bounds.x + 61, bounds.y + 70);
    pump_until(runtime.as_ref(), 200, || false);
    assert!(!passing(), "it said solid");
    // `None` restores normal hit testing.
    window.set_hit_regions(None, None).expect("no regions");
    assert!(!passing());
    window.dispose();
  });
}

/// `window-native.test.ts` "startResize follows the cursor from an edge while the left button is
/// down".
#[test]
fn start_resize_follows_the_real_cursor_while_the_left_button_is_down() {
  on_ui_thread(|runtime| {
    let input = InputBack::here();
    let bounds = Rect::new(300, 300, 300, 200);
    let window = Window::create(WindowInit { frame: false, topmost: true, no_activate: true, bounds: Some(bounds), min_width: Some(250), ..init("rt os resize") }).expect("window");
    let handle = window.handle();
    window.show().expect("show");
    pump_until(runtime.as_ref(), 30, || false);
    let corner = (bounds.x + bounds.width - 2, bounds.y + bounds.height - 2);
    os::set_cursor(corner.0, corner.1);
    until_desktop_is_ours(
      runtime.as_ref(),
      "start_resize: the test window is not under the cursor, or a mouse button is held",
      || !os::buttons_down() && os::window_at(corner.0, corner.1) == handle,
      || {
        window.set_topmost(true);
        let _ = window.show();
        os::set_cursor(corner.0, corner.1);
      },
    );
    input.press();
    pump_until(runtime.as_ref(), 30, || false);
    window.start_resize(ResizeEdge::BottomRight).expect("resize");
    os::set_cursor(corner.0 + 40, corner.1 + 30);
    pump_until(runtime.as_ref(), 200, || window.bounds().width == 340);
    assert_eq!(window.bounds(), Rect::new(300, 300, 340, 230));
    // Never below the minimum width.
    os::set_cursor(corner.0 - 500, corner.1);
    pump_until(runtime.as_ref(), 200, || window.bounds().width == 250);
    assert_eq!(window.bounds().width, 250);
    os::send_left_button(false);
    input.pressed.set(false);
    pump_until(runtime.as_ref(), 60, || false);
    os::set_cursor(corner.0 + 100, corner.1 + 100);
    pump_until(runtime.as_ref(), 60, || false);
    assert_eq!(window.bounds().width, 250, "released: the gesture is over");
    window.dispose();
  });
}

/// Drives a drag of the window with handle value `handle` by the OS's move loop: presses at
/// `grip`, then `start` hands the press to the loop; from inside the loop the cursor is moved by
/// `(60, 45)` as input, and once the window is there (or after 6 s) the button is released.
/// Returns the window's bounds read from inside the loop.
fn drag_by_the_move_loop(runtime: &Rc<Runtime>, handle: isize, grip: (i32, i32), input: &InputBack, start: impl FnOnce()) -> Option<Rect> {
  input.press();
  pump_until(runtime.as_ref(), 2000, os::this_thread_sees_left_down);
  let expected = |from: Rect| (from.x + 60, from.y + 45);
  let from = outer(handle);
  let during: Rc<Cell<Option<Rect>>> = Rc::default();
  runtime.set_timeout(120, move || {
    os::move_cursor_as_input(grip.0 + 60, grip.1 + 45);
  }).expect("move");
  fn read_in_loop(runtime: Rc<Runtime>, handle: isize, want: (i32, i32), end: Instant, pressed: Rc<Cell<bool>>, during: Rc<Cell<Option<Rect>>>) {
    let now = outer(handle);
    if (now.x, now.y) != want && Instant::now() < end && pressed.get() {
      let next = runtime.clone();
      runtime.set_timeout(20, move || read_in_loop(next, handle, want, end, pressed, during)).expect("read");
      return;
    }
    during.set(Some(now));
    os::send_left_button(false);
    pressed.set(false);
  }
  let (inner, pressed, seen) = (runtime.clone(), input.pressed.clone(), during.clone());
  let want = expected(from);
  runtime.set_timeout(140, move || read_in_loop(inner, handle, want, Instant::now() + Duration::from_secs(6), pressed, seen)).expect("read");
  start();
  pump_until(runtime.as_ref(), 8000, || !input.pressed.get());
  pump_until(runtime.as_ref(), 60, || false);
  during.get()
}

/// The control for a drag that did not follow: a plain popup window of the test's own, dragged by
/// the OS's move loop from a title-bar press (`WM_NCLBUTTONDOWN`), as `DefWindowProc` gets one.
/// False when the session's OS runs no move loop for it either.
fn the_os_runs_a_move_loop_here(runtime: &Rc<Runtime>, input: &InputBack) -> bool {
  let area = screen::primary().expect("primary").work_area;
  let own = os::OwnWindow::new("rt os move-loop control", (area.x + 40, area.y + 40, 240, 160), |_| {}).expect("control window");
  let handle = own.handle_value();
  let grip = (area.x + 100, area.y + 80);
  os::set_cursor(grip.0, grip.1);
  pump_until(runtime.as_ref(), 40, || false);
  if os::buttons_down() || os::window_at(grip.0, grip.1) != handle {
    return false;
  }
  let from = outer(handle);
  let at = (grip.0 & 0xffff) | ((grip.1 & 0xffff) << 16);
  let during = drag_by_the_move_loop(runtime, handle, grip, input, || {
    os::send(handle, 0x00a1, 2, at as isize); // WM_NCLBUTTONDOWN, HTCAPTION
  });
  during.is_some_and(|r| (r.x, r.y) == (from.x + 60, from.y + 45))
}

/// `window-native.test.ts` "startDrag hands the window to the OS, which moves it with the cursor
/// until the button is released". When the window does not follow, the same drag of a plain
/// window of the test's own is the control: if the OS ran no move loop for it either, the test
/// refuses to judge.
#[test]
fn start_drag_hands_the_window_to_the_os_move_loop_until_the_button_is_released() {
  on_ui_thread(|runtime| {
    let input = InputBack::here();
    let bounds = Rect::new(320, 320, 300, 200);
    let window = Window::create(WindowInit { frame: false, topmost: true, no_activate: true, bounds: Some(bounds), ..init("rt os drag") }).expect("window");
    let handle = window.handle();
    window.show().expect("show");
    pump_until(runtime.as_ref(), 30, || false);
    let grip = (bounds.x + 40, bounds.y + 20);
    os::set_cursor(grip.0, grip.1);
    until_desktop_is_ours(
      runtime.as_ref(),
      "start_drag: the test window is not under the cursor, or a mouse button is held",
      || !os::buttons_down() && os::window_at(grip.0, grip.1) == handle,
      || {
        window.set_topmost(true);
        let _ = window.show();
        os::set_cursor(grip.0, grip.1);
      },
    );
    let during = drag_by_the_move_loop(&runtime, handle, grip, &input, || window.start_drag());
    let moved = Rect::new(bounds.x + 60, bounds.y + 45, 300, 200);
    if during != Some(moved) && !the_os_runs_a_move_loop_here(&runtime, &input) {
      panic!("refused to judge: the session's OS ran no move loop for the control window either; run again");
    }
    assert_eq!(during, Some(moved), "the window followed the cursor inside the move loop");
    assert_eq!(window.bounds(), moved);
    // Released: the cursor no longer carries the window.
    os::set_cursor(grip.0 + 200, grip.1 + 200);
    pump_until(runtime.as_ref(), 80, || false);
    assert_eq!(window.bounds().x, moved.x);
    window.dispose();
  });
}

/// `window-native.test.ts` "a frameless window maximised by toggleMaximize and dragged by
/// startDrag stays maximised, and its next toggle gives back the bounds it had, as at the tag".
#[test]
fn a_maximised_frameless_window_dragged_by_start_drag_stays_maximised_and_its_next_toggle_gives_back_its_bounds() {
  on_ui_thread(|runtime| {
    let input = InputBack::here();
    let start = Rect::new(320, 320, 300, 200);
    let window = Window::create(WindowInit { frame: false, topmost: true, no_activate: true, bounds: Some(start), ..init("rt os drag maximised") }).expect("window");
    let handle = window.handle();
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    window.on_maximize_change(Some(Rc::new(move |m| sink.borrow_mut().push(m)))).expect("listener");
    window.show().expect("show");
    window.toggle_maximize().expect("maximise");
    let maximised = window.bounds();
    assert_eq!((window.is_maximized(), maximised), (true, screen::of_window(handle).expect("screen").work_area));
    pump_until(runtime.as_ref(), 30, || false);
    let grip = (maximised.x + 40, maximised.y + 20);
    os::set_cursor(grip.0, grip.1);
    until_desktop_is_ours(
      runtime.as_ref(),
      "start_drag (maximised): the test window is not under the cursor, or a mouse button is held",
      || !os::buttons_down() && os::window_at(grip.0, grip.1) == handle,
      || {
        window.set_topmost(true);
        let _ = window.show();
        os::set_cursor(grip.0, grip.1);
      },
    );
    let during = drag_by_the_move_loop(&runtime, handle, grip, &input, || window.start_drag());
    let moved = Rect { x: maximised.x + 60, y: maximised.y + 45, ..maximised };
    if during != Some(moved) && !the_os_runs_a_move_loop_here(&runtime, &input) {
      panic!("refused to judge: the session's OS ran no move loop for the control window either; run again");
    }
    assert_eq!(window.bounds(), moved);
    assert_eq!((window.is_maximized(), seen.borrow().clone()), (true, vec![true]), "still maximised");
    window.toggle_maximize().expect("restore");
    assert_eq!((window.is_maximized(), window.bounds(), seen.borrow().clone()), (false, start, vec![true, false]));
    window.dispose();
  });
}

// ---- a tab frame before its first tab (`win-tabs.ts`'s frame checks) ---------------------------------

/// Whether the system's apps are dark (`AppsUseLightTheme` is 0), read from the registry with
/// `reg.exe`, apart from the product's own reading.
fn registry_says_dark() -> bool {
  let out = std::process::Command::new("reg")
    .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "AppsUseLightTheme"])
    .output()
    .expect("reg.exe");
  let text = String::from_utf8_lossy(&out.stdout);
  // A missing value means light, as the system reads it.
  text.lines().find(|l| l.contains("AppsUseLightTheme")).is_some_and(|l| l.trim_end().ends_with("0x0"))
}

/// `win-tabs.ts` "backdrop: the strip and the page areas in their own colours (light, dark)": a
/// frame with no tab has no webview, so what shows is what the frame paints, read from the screen.
#[test]
fn a_tab_frame_with_no_tab_paints_its_strip_and_page_in_the_appearances_colours() {
  on_ui_thread(|runtime| {
    let work = screen::primary().expect("primary").work_area;
    for (appearance, strip_colour, page_colour) in [(Appearance::Light, 0xe9_ea_ee, 0xf9_f9_fb), (Appearance::Dark, 0x29_2a_30, 0x15_16_1a)] {
      let bounds = Rect::new(work.x + 60, work.y + 60, 640.min(work.width - 120), 420.min(work.height - 120));
      let frame = Window::create(WindowInit { appearance, topmost: true, no_activate: true, bounds: Some(bounds), ..tabbed("rt os tab backdrop") }).expect("tabbed");
      frame.show().expect("show");
      let handle = frame.handle();
      let scale = f64::from(os::dpi_of(handle)) / 96.0;
      let (_, height) = os::client_size(handle);
      let strip_at = os::client_to_screen(handle, 30, ((f64::from(STRIP_HEIGHT) - 4.0) * scale).round() as i32);
      let page_at = os::client_to_screen(handle, 30, height - 10);
      let read = || (os::screen_pixel(strip_at.0, strip_at.1), os::screen_pixel(page_at.0, page_at.1));
      let want = (Some(strip_colour), Some(page_colour));
      pump_until(runtime.as_ref(), 2000, || read() == want);
      let ours = os::window_at(strip_at.0, strip_at.1) == handle && os::window_at(page_at.0, page_at.1) == handle;
      if read() != want && !ours {
        panic!("refused to judge: another window covers the frame on the shared desktop; run again");
      }
      assert_eq!(read(), want, "{appearance:?}: the strip and the page in their own colours");
      frame.dispose();
    }
  });
}

/// `win-tabs.ts` "a frame given bounds takes them as its outer rectangle", "a frame made with no
/// bounds is centred on the primary work area" and "a "system" frame starts in the system's theme
/// (AppsUseLightTheme)".
#[test]
fn a_tab_frame_takes_given_bounds_is_centred_without_them_and_starts_in_the_systems_theme() {
  on_ui_thread(|_runtime| {
    let area = screen::primary().expect("primary").work_area;
    let given = Rect::new(area.x + 50, area.y + 40, 820.min(area.width - 100), 600.min(area.height - 80));
    let placed = Window::create(WindowInit { bounds: Some(given), ..tabbed("rt os tab bounds") }).expect("tabbed");
    assert_eq!(outer(placed.handle()), given);
    placed.dispose();

    let centred = Window::create(tabbed("rt os tab centred")).expect("tabbed");
    let r = outer(centred.handle());
    // A frame taller than the work area starts at its top, so the strip is on the screen.
    let want = (area.x + (area.width - r.width) / 2, area.y + ((area.height - r.height) / 2).max(0));
    assert!((r.x - want.0).abs() <= 1 && (r.y - want.1).abs() <= 1, "centred: {r:?} in {area:?}");
    centred.dispose();

    // No strip yet, so nothing has reported a theme: the frame's state is what it read from the system.
    let fresh = Window::create(WindowInit { appearance: Appearance::System, ..tabbed("rt os tab system") }).expect("tabbed");
    let dark = registry_says_dark();
    let frame = TabFrame::of(fresh.handle()).expect("a tab frame");
    assert_eq!((frame.is_dark(), os::uses_dark_title_bar(fresh.handle())), (dark, Some(dark)), "the registry says dark: {dark}");
    fresh.dispose();
  });
}

/// `win-tabs.ts` "before its first tab the frame shows the window's title", "frame styles", "frame
/// metrics: ... the system border kept", "resize edges: left, right, bottom and the bottom
/// corners" and "default minimum size: a 560 x 420 page plus the strip and the frame" (the page
/// size and the caption's removal are `window_tests.rs`'s
/// `a_tab_frame_keeps_the_system_frame_and_lays_out_a_strip_and_a_page`).
#[test]
fn a_tab_frame_keeps_its_title_system_styles_border_resize_edges_and_default_minimum() {
  const WS_CAPTION: u32 = 0x00c0_0000;
  const WS_SYSMENU: u32 = 0x0008_0000;
  const WS_MINIMIZEBOX: u32 = 0x0002_0000;
  const WS_CLIPCHILDREN: u32 = 0x0200_0000;
  const WM_NCHITTEST: u32 = 0x0084;
  on_ui_thread(|_runtime| {
    let title = format!("rt os tab frame {}", std::process::id());
    let frame = Window::create(WindowInit { appearance: Appearance::Dark, ..tabbed(&title) }).expect("tabbed");
    let handle = frame.handle();
    assert_eq!(os::title_of(handle), title);
    let all = WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN;
    assert_eq!(style(handle) & all, all, "frame styles: {:#x}", style(handle));

    let dpi = os::dpi_of(handle);
    let (outer, (client_w, client_h)) = (outer(handle), os::client_size(handle));
    let origin = os::client_to_screen(handle, 0, 0);
    let edge = os::frame_edge(dpi);
    assert_eq!(origin.0 - outer.x, edge, "the left border is the system's");
    assert_eq!(outer.x + outer.width - (origin.0 + client_w), edge, "the right border");
    assert_eq!(outer.y + outer.height - (origin.1 + client_h), edge, "the bottom border");

    let hit = |x: i32, y: i32| os::send(handle, WM_NCHITTEST, 0, (((y & 0xffff) << 16) | (x & 0xffff)) as isize);
    let mid = (outer.x + outer.width / 2, outer.y + outer.height / 2);
    let right = outer.x + outer.width - 3;
    let bottom = outer.y + outer.height - 3;
    // HTLEFT, HTRIGHT, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT.
    assert_eq!([hit(outer.x + 2, mid.1), hit(right, mid.1), hit(mid.0, bottom), hit(outer.x + 2, bottom), hit(right, bottom)], [10, 11, 15, 16, 17]);

    let scale = f64::from(dpi) / 96.0;
    let want = ((560.0 * scale).round() as i32 + (outer.width - client_w), ((420.0 + f64::from(STRIP_HEIGHT)) * scale).round() as i32 + (outer.height - client_h));
    let track = os::min_track_size(handle);
    assert!((track.0 - want.0).abs() <= 1 && (track.1 - want.1).abs() <= 1, "the default minimum: {track:?}, want {want:?}");
    assert_eq!(os::uses_dark_title_bar(handle), Some(true), "dark appearance: dark title bar");
    frame.dispose();
  });
}
