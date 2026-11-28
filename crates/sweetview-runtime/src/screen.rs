//! Screens and the cursor, with no window required.
//!
//! Monitors, their bounds and scale, and the cursor come from `tao`; the work
//! area, which `tao`'s `MonitorHandle` does not carry, from the platform crate.
//! Which screen a point is on is decided in the logic crate, the way the OS
//! picks one; which screen a window is on, by the OS (`MonitorFromWindow`).

use sweetview_platform_window as platform;
use sweetview_window_logic::screen as pick;
use tao::monitor::MonitorHandle;

use crate::error::{Error, Result};
use crate::runtime::Runtime;
use crate::{Point, Rect};

/// One monitor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenInfo {
  /// The whole monitor.
  pub bounds: Rect,
  /// The part windows should use: the bounds less the taskbar.
  pub work_area: Rect,
  /// The monitor's effective DPI over 96.
  pub scale: f64,
  pub primary: bool,
}

fn info(monitor: &MonitorHandle, primary: Option<&MonitorHandle>) -> ScreenInfo {
  let position = monitor.position();
  let size = monitor.size();
  let bounds = Rect::new(position.x, position.y, size.width as i32, size.height as i32);
  ScreenInfo {
    bounds,
    work_area: platform::work_area(monitor).unwrap_or(bounds),
    scale: monitor.scale_factor(),
    primary: primary.is_some_and(|p| p == monitor),
  }
}

/// Every monitor, the primary among them. Never empty: with no monitor
/// reported, one empty primary screen stands in.
pub fn all() -> Result<Vec<ScreenInfo>> {
  let runtime = Runtime::get()?;
  let screens = runtime.with_target(|target| {
    let primary = target.primary_monitor();
    target.available_monitors().map(|m| info(&m, primary.as_ref())).collect::<Vec<_>>()
  })?;
  if screens.is_empty() {
    return Ok(vec![ScreenInfo { bounds: Rect::default(), work_area: Rect::default(), scale: 1.0, primary: true }]);
  }
  Ok(screens)
}

/// The primary monitor.
pub fn primary() -> Result<ScreenInfo> {
  let screens = all()?;
  Ok(screens.iter().find(|s| s.primary).copied().unwrap_or(screens[0]))
}

/// The monitor holding `point`, else the nearest one.
pub fn at(point: Point) -> Result<ScreenInfo> {
  let screens = all()?;
  let bounds: Vec<Rect> = screens.iter().map(|s| s.bounds).collect();
  Ok(screens[pick::screen_at(&bounds, point).unwrap_or(0)])
}

/// The monitor a window is on, as `MonitorFromWindow` answers: the one its
/// outer frame overlaps most, else the nearest, and for a minimised window
/// the one its restored position is on. A handle that names no window gets
/// the primary monitor.
pub fn of_window(handle: isize) -> Result<ScreenInfo> {
  let runtime = Runtime::get()?;
  let screen = runtime.with_target(|target| {
    let primary = target.primary_monitor();
    let monitor = platform::BorrowedWindow::with_handle_value(handle, |window| platform::monitor_of(window, target.available_monitors()))?;
    Some(info(&monitor?, primary.as_ref()))
  })?;
  match screen {
    Some(screen) => Ok(screen),
    None => primary(),
  }
}

/// The rectangle holding every monitor.
pub fn virtual_screen() -> Result<Rect> {
  let bounds: Vec<Rect> = all()?.iter().map(|s| s.bounds).collect();
  Ok(pick::virtual_screen(&bounds))
}

/// The cursor's position on the screen.
pub fn cursor() -> Result<Point> {
  let runtime = Runtime::get()?;
  let position = runtime
    .with_target(|target| target.cursor_position())?
    .map_err(|e| Error::os("the cursor position could not be read", e))?;
  Ok(Point { x: position.x.round() as i32, y: position.y.round() as i32 })
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;
  use crate::runtime::testing::on_ui_thread;
  use crate::window::{Window, WindowInit};

  #[test]
  fn screens_without_a_window() {
    on_ui_thread(|_runtime| {
      let screens = all().expect("screens");
      assert!(!screens.is_empty());
      let primary = primary().expect("primary");
      assert!(primary.primary && primary.bounds.width > 0 && primary.work_area.height > 0 && primary.scale > 0.0);
      assert!(primary.bounds.contains(Point { x: primary.work_area.x, y: primary.work_area.y }));
      assert_eq!(at(Point { x: primary.bounds.x + 10, y: primary.bounds.y + 10 }).expect("at").bounds, primary.bounds);
      assert!(at(Point { x: 999_999, y: 999_999 }).expect("far").bounds.width > 0);
      let all_bounds = virtual_screen().expect("virtual screen");
      assert!(all_bounds.width >= primary.bounds.width && all_bounds.height >= primary.bounds.height);
      cursor().expect("cursor");
      assert_eq!(of_window(1).expect("no window: the primary").bounds, primary.bounds);
    });
  }

  /// A minimised window is on the screen of its restored position, as `MonitorFromWindow` answers
  /// and as at tag `pre-rust-rewrite`, not on the screen nearest its minimised rectangle (which is
  /// off every screen). Fails only where a screen is not the one nearest that rectangle, so with
  /// two screens or more.
  #[test]
  fn a_minimised_window_is_on_the_screen_of_its_restored_position() {
    on_ui_thread(|runtime| {
      for screen in all().expect("screens") {
        let w = screen.work_area;
        let bounds = Rect::new(w.x + w.width / 2 - 150, w.y + w.height / 2 - 100, 300, 200);
        let init = WindowInit { title: "rt screen of minimised".into(), frame: true, bounds: Some(bounds), no_activate: true, ..Default::default() };
        let window = Window::create(init).expect("window");
        window.show().expect("show");
        window.minimize();
        runtime.pump();
        assert!(window.is_minimized());
        assert_eq!(of_window(window.handle()).expect("screen").bounds, screen.bounds, "a window minimised from {bounds:?}");
        window.dispose();
      }
    });
  }
}
