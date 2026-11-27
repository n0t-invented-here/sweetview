//! Screens and the cursor, with no window required.

use napi::bindgen_prelude::BigInt;
use sweetview_runtime::screen::{self as rt, ScreenInfo};
use sweetview_runtime::{Point, Rect};

use crate::errors::OrThrow;
use crate::window::handle_from;

/// Every monitor.
pub fn screens() -> napi::Result<Vec<ScreenInfo>> {
  rt::all().or_throw()
}

/// The monitor holding the point, else the nearest one.
pub fn screen_at(x: f64, y: f64) -> napi::Result<ScreenInfo> {
  rt::at(Point { x: x.round() as i32, y: y.round() as i32 }).or_throw()
}

/// The monitor a window is on.
pub fn screen_of(handle: &BigInt) -> napi::Result<ScreenInfo> {
  rt::of_window(handle_from(handle)?).or_throw()
}

/// The rectangle holding every monitor.
pub fn virtual_screen() -> napi::Result<Rect> {
  rt::virtual_screen().or_throw()
}

/// The cursor's position on the screen.
pub fn cursor() -> napi::Result<Point> {
  rt::cursor().or_throw()
}
