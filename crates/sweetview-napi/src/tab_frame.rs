//! The frame of a tabbed window, for the Windows tabs library.
//!
//! A frame is a `Window` made with `tabStripHeight`; this class is its tab
//! side, found by the window's handle. The tab strip and the tabs are
//! `Engine.createChild` webviews the tabs library places in `stripRect()`
//! and `pageRect()`.

use std::rc::Rc;

use napi::bindgen_prelude::{BigInt, Function};
use napi::Env;
use sweetview_runtime::window::tab_frame::{self as rt, PopupEntry};
use sweetview_runtime::{Rect, ResizeEdge};

use crate::callback::JsCallback;
use crate::errors::OrThrow;
use crate::window::{handle_from, handle_to};

/// The tab side of a frame window.
pub struct TabFrame {
  inner: rt::TabFrame,
}

/// The frame whose handle is `handle`, or `None` when it is not a live tab frame.
pub fn of(handle: &BigInt) -> napi::Result<Option<TabFrame>> {
  sweetview_runtime::threads::require_ui_thread().or_throw()?;
  Ok(rt::TabFrame::of(handle_from(handle)?).map(|inner| TabFrame { inner }))
}

/// Every live tab frame.
pub fn all() -> napi::Result<Vec<TabFrame>> {
  sweetview_runtime::threads::require_ui_thread().or_throw()?;
  Ok(rt::TabFrame::all().into_iter().map(|inner| TabFrame { inner }).collect())
}

/// True when the system's app theme is dark.
pub fn system_is_dark() -> bool {
  rt::system_is_dark()
}

/// True while the left mouse button is down.
pub fn left_button_down() -> bool {
  rt::left_button_down()
}

/// True when `handle` names a window now.
pub fn window_exists(handle: &BigInt) -> napi::Result<bool> {
  Ok(rt::window_exists(handle_from(handle)?))
}

fn edge_from(edge: &str) -> napi::Result<ResizeEdge> {
  ResizeEdge::parse(edge).ok_or_else(|| napi::Error::from_reason(format!("sweetview: not a window edge: {edge}")))
}

fn held_from(x: Option<f64>, y: Option<f64>) -> Option<(f64, f64)> {
  Some((x?, y?))
}

impl TabFrame {
  pub fn handle(&self) -> BigInt {
    handle_to(self.inner.handle())
  }

  pub fn is_live(&self) -> bool {
    self.inner.is_live()
  }

  pub fn strip_height(&self) -> i32 {
    self.inner.strip_height()
  }

  pub fn strip_rect(&self) -> Rect {
    self.inner.strip_rect()
  }

  pub fn page_rect(&self) -> Rect {
    self.inner.page_rect()
  }

  pub fn strip_screen_rect(&self) -> Rect {
    self.inner.strip_screen_rect()
  }

  pub fn is_foreground(&self) -> bool {
    self.inner.is_foreground()
  }

  pub fn on_activate(&self, env: Env, function: Option<Function<'_, bool, ()>>) -> napi::Result<()> {
    let listener: Option<rt::ActivateListener> = match function {
      Some(function) => {
        let callback = JsCallback::new(env, &function, "a tab frame's activation listener")?;
        Some(Rc::new(move |active: bool| {
          callback.call(active);
        }))
      }
      None => None,
    };
    self.inner.on_activate(listener);
    Ok(())
  }

  /// `held_x`/`held_y`: where in the strip (device-independent pixels) the press was.
  pub fn start_drag(&self, held_x: Option<f64>, held_y: Option<f64>) -> napi::Result<()> {
    self.inner.start_drag_at(held_from(held_x, held_y)).or_throw()
  }

  pub fn start_resize(&self, edge: String, held_x: Option<f64>, held_y: Option<f64>) -> napi::Result<()> {
    self.inner.start_resize_at(edge_from(&edge)?, held_from(held_x, held_y)).or_throw()
  }

  pub fn request_close(&self) {
    self.inner.request_close();
  }

  pub fn show_system_menu(&self) -> napi::Result<()> {
    self.inner.show_system_menu().or_throw()
  }

  /// `entries`: `(label, enabled)`, a missing label for a separator. The chosen index, or -1.
  pub fn show_menu(&self, entries: Vec<(Option<String>, bool)>) -> napi::Result<i32> {
    let entries: Vec<PopupEntry> = entries.into_iter().map(|(label, enabled)| rt::popup_entry(label, enabled)).collect();
    let chosen = self.inner.show_menu(&entries).or_throw()?;
    Ok(chosen.and_then(|index| i32::try_from(index).ok()).unwrap_or(-1))
  }

  pub fn appearance(&self) -> &'static str {
    match self.inner.appearance() {
      sweetview_runtime::window::Appearance::System => "system",
      sweetview_runtime::window::Appearance::Light => "light",
      sweetview_runtime::window::Appearance::Dark => "dark",
    }
  }

  pub fn is_dark(&self) -> bool {
    self.inner.is_dark()
  }

  pub fn set_system_dark(&self, dark: bool) {
    self.inner.set_system_dark(dark);
  }
}
