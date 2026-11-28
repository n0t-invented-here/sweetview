//! What a person does to Sweetview's windows, done with real input on the shared desktop
//! (`SendInput`, never a posted message), and read back from the OS: the rows of
//! `rust-rewrite/PORT-STATUS.md` that a simulated message could not prove. Each test judges the
//! desktop itself within a few seconds (the foreground it needs, no button held, its window not
//! covered) and refuses to judge (`not run: ...`) when the desktop is not its own.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sweetview_platform_window::test_support as os;
use sweetview_platform_window::BorrowedWindow;

use crate::engine::{Engine, Host};
use crate::runtime::testing::on_ui_thread;
use crate::runtime::Runtime;
use crate::window::{Window, WindowInit};
use crate::Rect;

const WM_NCHITTEST: u32 = 0x0084;
const HTCLOSE: isize = 20;
const VK_MENU: u16 = 0x12;
const VK_F4: u16 = 0x73;

fn init(title: &str) -> WindowInit {
  WindowInit { title: title.into(), frame: true, resizable: true, ..Default::default() }
}

fn alive(handle: isize) -> bool {
  BorrowedWindow::with_handle_value(handle, |_| ()).is_some()
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

/// Puts the cursor back, and lets go of every key and button the test pressed, when dropped.
struct InputBack {
  cursor: (i32, i32),
}

impl InputBack {
  fn here() -> Self {
    Self { cursor: os::cursor() }
  }
}

impl Drop for InputBack {
  fn drop(&mut self) {
    for key in [VK_F4, VK_MENU] {
      if os::key_is_down(key) {
        os::send_key(key, true);
      }
    }
    if os::buttons_down() {
      os::send_left_button(false);
    }
    os::set_cursor(self.cursor.0, self.cursor.1);
  }
}

/// A point of the window's close button (the X), as the window itself answers `WM_NCHITTEST`:
/// the middle of the points of its caption row that hit `HTCLOSE`.
fn close_button(handle: isize, bounds: Rect) -> Option<(i32, i32)> {
  let mut hits = Vec::new();
  for y in bounds.y + 1..bounds.y + 60 {
    for x in (bounds.x + bounds.width - 120..bounds.x + bounds.width).step_by(2) {
      let lparam = (((y as u32) & 0xffff) << 16 | ((x as u32) & 0xffff)) as isize;
      if os::send(handle, WM_NCHITTEST, 0, lparam) == HTCLOSE {
        hits.push((x, y));
      }
    }
  }
  let (sx, sy) = hits.iter().fold((0i64, 0i64), |(a, b), (x, y)| (a + *x as i64, b + *y as i64));
  (!hits.is_empty()).then(|| ((sx / hits.len() as i64) as i32, (sy / hits.len() as i64) as i32))
}

/// Section 3 row "A person closing a window (the X, Alt+F4)": a real click on the title bar's
/// close button and a real Alt+F4 close a framed window with no `onClose` listener, and with one
/// they reach the listener once and the window stays.
#[test]
fn a_person_closes_a_framed_window_with_its_close_button_and_with_alt_f4() {
  on_ui_thread(|runtime| {
    let _back = InputBack::here();
    for (by_key, listening) in [(false, false), (false, true), (true, false), (true, true)] {
      let how = if by_key { "Alt+F4" } else { "the close button" };
      let bounds = Rect::new(320, 260, 420, 300);
      let window = Window::create(WindowInit { topmost: true, bounds: Some(bounds), ..init("rt person close") }).expect("window");
      let handle = window.handle();
      let heard = Rc::new(Cell::new(0u32));
      if listening {
        let count = heard.clone();
        window.on_close_request(Some(Rc::new(move || count.set(count.get() + 1)))).expect("listener");
      }
      window.show().expect("show");
      pump_until(runtime.as_ref(), 300, || false);
      if by_key {
        // The foreground, asked for again for up to three seconds (another session may hold it).
        if !pump_until(runtime.as_ref(), 3000, || os::take_foreground(handle)) {
          panic!("not run: {how}: the test's window could not take the foreground (it is with {:#x})", os::foreground());
        }
        os::send_key(VK_MENU, false);
        os::send_key(VK_F4, false);
        os::send_key(VK_F4, true);
        os::send_key(VK_MENU, true);
      } else {
        let outer = window.bounds();
        let Some((x, y)) = close_button(handle, outer) else { panic!("the window answers HTCLOSE nowhere on its caption: {outer:?}") };
        if !pump_until(runtime.as_ref(), 3000, || !os::buttons_down() && os::window_at(x, y) == handle) {
          panic!("not run: {how}: a button is held, or another window ({:#x}) is over the test's at {x},{y}", os::window_at(x, y));
        }
        os::set_cursor(x, y);
        pump_until(runtime.as_ref(), 50, || false);
        // Down and up as one click, as a person's is: the press on the close button starts the
        // window's own tracking loop, which waits for the release.
        os::send_left_button(true);
        os::send_left_button(false);
      }
      pump_until(runtime.as_ref(), 2000, || !alive(handle) || heard.get() > 0);
      if listening {
        pump_until(runtime.as_ref(), 200, || false);
        assert_eq!((heard.get(), alive(handle)), (1, true), "{how}, with a listener: told once, the window stays");
      } else {
        assert!(!alive(handle), "{how}, no listener: the window is closed");
      }
      window.dispose();
    }
  });
}

/// Section 3 row "Per-pixel transparency of a `transparent` window": the screen through a
/// frameless `transparent` window whose webview has a transparent background, as `WebView.attach`
/// gives one (alpha 0), over a window of a known colour: the page's opaque square shows its own
/// colour, and everywhere else the window behind shows through.
#[test]
fn a_transparent_window_shows_its_pages_opaque_shape_and_the_window_behind_everywhere_else() {
  on_ui_thread(|runtime| {
    let at = Rect::new(400, 300, 360, 260);
    let behind = Window::create(WindowInit {
      frame: false,
      topmost: true,
      no_activate: true,
      background_color: Some("#20a040".into()),
      bounds: Some(Rect::new(at.x - 40, at.y - 40, at.width + 80, at.height + 80)),
      ..init("rt person behind")
    })
    .expect("behind");
    behind.show().expect("show");
    let glass = Window::create(WindowInit { frame: false, transparent: true, topmost: true, no_activate: true, bounds: Some(at), ..init("rt person transparent") }).expect("glass");
    let engine = Engine::create(false, Host::Fill(glass.handle()), None).expect("webview");
    engine.set_background_color(0, 0, 0, 0);
    let page = "<style>html,body{background:transparent;margin:0}#box{position:absolute;left:0;top:0;width:120px;height:120px;background:#ff00ff}</style><div id=box></div>";
    engine.navigate(&format!("data:text/html,{}", page.replace('#', "%23")));
    glass.show().expect("show");
    let (inside, outside) = ((at.x + 60, at.y + 60), (at.x + 260, at.y + 180));
    let pixel = |(x, y): (i32, i32)| os::screen_pixel(x, y);
    pump_until(runtime.as_ref(), 8000, || pixel(inside) == Some(0xff_00_ff));
    for (name, point) in [("inside", inside), ("outside", outside)] {
      let over = os::window_at(point.0, point.1);
      if over != glass.handle() && over != behind.handle() {
        panic!("not run: another window ({over:#x}) is over the test's at {name} {point:?}");
      }
    }
    pump_until(runtime.as_ref(), 3000, || pixel(outside) == Some(0x20_a0_40));
    assert_eq!((pixel(inside), pixel(outside)), (Some(0xff_00_ff), Some(0x20_a0_40)), "the page's square, and the window behind through the rest");
    engine.destroy();
    glass.dispose();
    behind.dispose();
    // As the end of an application: every webview released, a pump so each has gone, then the
    // thread's WebView2 environment (as `engine_tests`' `Finish`).
    crate::engine::release_all();
    pump_until(runtime.as_ref(), 300, || false);
    sweetview_platform_webview::test_support::release_environment();
  });
}

/// Section 3 row "No click-through flip while a mouse button is down": the real left button
/// pressed over a hit region's solid part and held while the cursor crosses its edge: the window
/// stays solid while the button is down, and lets clicks through once it is let go, as the poll's
/// rule says.
#[test]
fn a_held_button_freezes_click_through_across_a_hit_regions_edge_until_it_is_let_go() {
  on_ui_thread(|runtime| {
    let _back = InputBack::here();
    let bounds = Rect::new(360, 300, 300, 200);
    let window = Window::create(WindowInit { frame: false, topmost: true, no_activate: true, bounds: Some(bounds), ..init("rt person held button") }).expect("window");
    let handle = window.handle();
    let passing = || BorrowedWindow::with_handle_value(handle, |w| sweetview_platform_window::ex_style(w)).unwrap_or(0) & 0x20 != 0; // WS_EX_TRANSPARENT
    window.show().expect("show");
    // The left half takes clicks, packed as `packRegions` packs it: count, bounds, then the points.
    window.set_hit_regions(Some(vec![4, 0, 0, 150, 200, 0, 0, 150, 0, 150, 200, 0, 200]), None).expect("regions");
    let (inside, outside) = ((bounds.x + 60, bounds.y + 100), (bounds.x + 240, bounds.y + 100));
    os::set_cursor(inside.0, inside.1);
    if !pump_until(runtime.as_ref(), 3000, || !os::buttons_down() && os::window_at(inside.0, inside.1) == handle && !passing()) {
      panic!("not run: a button is held, or another window ({:#x}) is over the test's at {inside:?}", os::window_at(inside.0, inside.1));
    }
    os::send_left_button(true);
    pump_until(runtime.as_ref(), 100, || false);
    assert!(os::buttons_down() && !passing(), "pressed over the solid part");
    // Across the edge, the button still down: no flip.
    for x in (inside.0..=outside.0).step_by(20) {
      os::set_cursor(x, inside.1);
      pump_until(runtime.as_ref(), 30, || false);
      assert!(!passing(), "the button is down at x {x}: the window stays solid");
    }
    pump_until(runtime.as_ref(), 200, || false);
    assert!(!passing(), "held outside the region: still solid");
    // Let go: the next poll lets clicks through where there is no region.
    os::send_left_button(false);
    assert!(pump_until(runtime.as_ref(), 1000, passing), "let go outside the region: clicks fall through");
    window.dispose();
  });
}
