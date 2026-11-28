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

use crate::runtime::testing::on_ui_thread;
use crate::runtime::Runtime;
use crate::window::{Window, WindowInit};
use crate::Rect;

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
      if os::send(handle, os::Message::NcHitTest { at: (x, y) }) == HTCLOSE {
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
