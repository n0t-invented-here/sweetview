//! Exports of `sweetview_napi::screen`.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use sweetview_napi::screen as imp;

use crate::types::{Point, Rect, ScreenData};

/// Every monitor.
#[napi]
pub fn screens() -> napi::Result<Vec<ScreenData>> {
  imp::screens().map(|all| all.into_iter().map(Into::into).collect())
}

/// The monitor holding the point, else the nearest one.
#[napi]
pub fn screen_at(x: f64, y: f64) -> napi::Result<ScreenData> {
  imp::screen_at(x, y).map(Into::into)
}

/// The monitor a window is on: the one its outer frame overlaps most, else the nearest.
#[napi]
pub fn screen_of(handle: BigInt) -> napi::Result<ScreenData> {
  imp::screen_of(&handle).map(Into::into)
}

/// The rectangle holding every monitor.
#[napi]
pub fn virtual_screen() -> napi::Result<Rect> {
  imp::virtual_screen().map(Into::into)
}

/// The cursor's position on the screen.
#[napi]
pub fn cursor() -> napi::Result<Point> {
  imp::cursor().map(Into::into)
}
