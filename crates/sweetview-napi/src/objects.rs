//! The plain data the binding's functions take and return, as JavaScript objects, and every
//! conversion between them and the runtime's own types.
//!
//! `#[napi(object)]` compiles under `#![forbid(unsafe_code)]` (decision D12), so the shapes and
//! what is decided while converting them (rounding, clamping, the default appearance) live here.
//! The export table re-exports them unchanged.

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
use sweetview_runtime as rt;

/// A rectangle in screen coordinates: physical pixels on Windows.
#[napi(object)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl From<rt::Rect> for Rect {
  fn from(r: rt::Rect) -> Self {
    Self { x: r.x.into(), y: r.y.into(), width: r.width.into(), height: r.height.into() }
  }
}

impl From<Rect> for rt::Rect {
  fn from(r: Rect) -> Self {
    crate::window::rect_from(r.x, r.y, r.width, r.height)
  }
}

/// One line of a popup menu: an item with a label, or a separator.
#[napi(object)]
pub struct MenuEntryData {
  /// The item's text; `	` separates a shortcut shown at the right. Absent for a separator.
  pub label: Option<String>,
  pub enabled: bool,
}

/// A size in device-independent pixels: CSS pixels of the page.
#[napi(object)]
pub struct Size {
  pub width: f64,
  pub height: f64,
}

impl From<Size> for rt::window::Dips {
  fn from(s: Size) -> Self {
    rt::window::Dips::new(s.width, s.height)
  }
}

/// A point in screen coordinates.
#[napi(object)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}

impl From<rt::Point> for Point {
  fn from(p: rt::Point) -> Self {
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

impl From<rt::screen::ScreenInfo> for ScreenData {
  fn from(s: rt::screen::ScreenInfo) -> Self {
    Self { bounds: s.bounds.into(), work_area: s.work_area.into(), scale: s.scale, primary: s.primary }
  }
}

/// The chrome of a wrapped window, from its styles.
#[napi(object)]
pub struct Detected {
  pub frame: bool,
  pub resizable: bool,
}

impl From<rt::window::Chrome> for Detected {
  fn from(c: rt::window::Chrome) -> Self {
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
  /// The client area in device-independent pixels, centred on the primary work area; not with `bounds`.
  pub content_size: Option<Size>,
  /// `#rrggbb`: what the window shows where nothing has painted; not applied to a transparent window.
  pub background_color: Option<String>,
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
  /// Windows: makes the window a tabbed window's frame, with a tab strip this
  /// many device-independent pixels tall where the caption was.
  pub tab_strip_height: Option<f64>,
}

/// A size in pixels from JavaScript's number: rounded, and never below zero.
fn pixels(v: f64) -> i32 {
  v.round().max(0.0) as i32
}

impl From<WindowInit> for rt::window::WindowInit {
  fn from(o: WindowInit) -> Self {
    rt::window::WindowInit {
      title: o.title,
      bounds: o.bounds.map(Into::into),
      content_size: o.content_size.map(Into::into),
      background_color: o.background_color,
      min_width: o.min_width.map(pixels),
      min_height: o.min_height.map(pixels),
      frame: o.frame,
      resizable: o.resizable,
      // An appearance this version does not know is the default one, as before the rewrite.
      appearance: rt::window::Appearance::parse(&o.appearance).unwrap_or_default(),
      icon: o.icon.and_then(|i| i.ico).map(|ico| ico.to_vec()),
      transparent: o.transparent,
      color_key: o.color_key,
      opacity: o.opacity,
      topmost: o.topmost,
      hide_from_taskbar: o.hide_from_taskbar,
      no_activate: o.no_activate,
      tab_strip_height: o.tab_strip_height.map(|h| h.round().max(0.0) as u32),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn init(appearance: &str, min_width: Option<f64>, tab_strip_height: Option<f64>) -> WindowInit {
    WindowInit {
      title: "t".into(),
      bounds: None,
      content_size: None,
      background_color: None,
      min_width,
      min_height: None,
      frame: true,
      resizable: true,
      appearance: appearance.into(),
      icon: None,
      transparent: false,
      color_key: None,
      opacity: None,
      topmost: false,
      hide_from_taskbar: false,
      no_activate: false,
      tab_strip_height,
    }
  }

  #[test]
  fn sizes_are_rounded_and_never_negative() {
    let converted: rt::window::WindowInit = init("system", Some(-5.0), Some(-1.0)).into();
    assert_eq!(converted.min_width, Some(0));
    assert_eq!(converted.tab_strip_height, Some(0));
    let converted: rt::window::WindowInit = init("system", Some(99.5), Some(31.6)).into();
    assert_eq!(converted.min_width, Some(100));
    assert_eq!(converted.tab_strip_height, Some(32));
  }

  #[test]
  fn an_unknown_appearance_is_the_default() {
    let converted: rt::window::WindowInit = init("sepia", None, None).into();
    assert_eq!(converted.appearance, rt::window::Appearance::default());
    let converted: rt::window::WindowInit = init("dark", None, None).into();
    assert_eq!(converted.appearance, rt::window::Appearance::parse("dark").unwrap());
  }
}
