//! The plain data the binding's functions take and return, as JavaScript objects.
//!
//! `#[napi(object)]` generates the conversion, so these live in the export
//! table; each converts to or from the runtime's own type in one step.

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
use sweetview_napi as imp;

/// A rectangle in screen coordinates: physical pixels on Windows.
#[napi(object)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl From<imp::Rect> for Rect {
  fn from(r: imp::Rect) -> Self {
    Self { x: r.x.into(), y: r.y.into(), width: r.width.into(), height: r.height.into() }
  }
}

impl From<Rect> for imp::Rect {
  fn from(r: Rect) -> Self {
    imp::window::rect_from(r.x, r.y, r.width, r.height)
  }
}

/// A point in screen coordinates.
#[napi(object)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}

impl From<imp::Point> for Point {
  fn from(p: imp::Point) -> Self {
    Self { x: p.x.into(), y: p.y.into() }
  }
}

/// One monitor.
#[napi(object)]
pub struct ScreenData {
  pub bounds: Rect,
  pub work_area: Rect,
  pub scale: f64,
  pub primary: bool,
}

impl From<imp::ScreenInfo> for ScreenData {
  fn from(s: imp::ScreenInfo) -> Self {
    Self { bounds: s.bounds.into(), work_area: s.work_area.into(), scale: s.scale, primary: s.primary }
  }
}

/// The chrome of a wrapped window, from its styles.
#[napi(object)]
pub struct Detected {
  pub frame: bool,
  pub resizable: bool,
}

impl From<imp::Chrome> for Detected {
  fn from(c: imp::Chrome) -> Self {
    Self { frame: c.frame, resizable: c.resizable }
  }
}

/// One icon, as Sweetview's `Icon` type carries it. Windows uses `ico`.
#[napi(object)]
pub struct IconBytes {
  pub ico: Option<Uint8Array>,
}

/// Everything a new window is made with. Bounds are the outer frame.
#[napi(object)]
pub struct WindowInit {
  pub title: String,
  pub bounds: Option<Rect>,
  pub min_width: Option<f64>,
  pub min_height: Option<f64>,
  pub frame: bool,
  pub resizable: bool,
  /// `"system"`, `"light"` or `"dark"`.
  pub appearance: String,
  pub icon: Option<IconBytes>,
  pub transparent: bool,
  pub color_key: Option<String>,
  pub opacity: Option<f64>,
  pub topmost: bool,
  pub hide_from_taskbar: bool,
  pub no_activate: bool,
}

impl From<WindowInit> for imp::WindowInit {
  fn from(o: WindowInit) -> Self {
    let size = |v: f64| v.round().max(0.0) as i32;
    imp::WindowInit {
      title: o.title,
      bounds: o.bounds.map(Into::into),
      min_width: o.min_width.map(size),
      min_height: o.min_height.map(size),
      frame: o.frame,
      resizable: o.resizable,
      appearance: imp::Appearance::parse(&o.appearance).unwrap_or_default(),
      icon: o.icon.and_then(|i| i.ico).map(|ico| ico.to_vec()),
      transparent: o.transparent,
      color_key: o.color_key,
      opacity: o.opacity,
      topmost: o.topmost,
      hide_from_taskbar: o.hide_from_taskbar,
      no_activate: o.no_activate,
    }
  }
}
