//! Exports of `sweetview_napi::tab_frame`.

use napi::bindgen_prelude::{BigInt, Function};
use napi::Env;
use napi_derive::napi;
use sweetview_napi::tab_frame as imp;

use crate::types::{MenuEntryData, Rect};

/// Windows: the tab side of a tabbed window's frame (a `Window` made with `tabStripHeight`).
/// The strip and the tabs are `Engine.createChild` webviews placed in `stripRect()` and `pageRect()`.
#[napi]
pub struct TabFrame(imp::TabFrame);

#[napi]
impl TabFrame {
  /// The frame with this handle, or null when the handle names no live tab frame.
  #[napi]
  pub fn of(handle: BigInt) -> napi::Result<Option<TabFrame>> {
    Ok(imp::of(&handle)?.map(TabFrame))
  }

  /// Every live tab frame.
  #[napi]
  pub fn all() -> napi::Result<Vec<TabFrame>> {
    Ok(imp::all()?.into_iter().map(TabFrame).collect())
  }

  /// The frame's `HWND`.
  #[napi(getter)]
  pub fn handle(&self) -> BigInt {
    self.0.handle()
  }

  /// False once the window is destroyed.
  #[napi(getter)]
  pub fn live(&self) -> bool {
    self.0.is_live()
  }

  /// The strip's height in physical pixels.
  #[napi]
  pub fn strip_height(&self) -> i32 {
    self.0.strip_height()
  }

  /// The strip in the frame's client coordinates, physical pixels.
  #[napi]
  pub fn strip_rect(&self) -> Rect {
    self.0.strip_rect().into()
  }

  /// The page area below the strip, in the frame's client coordinates.
  #[napi]
  pub fn page_rect(&self) -> Rect {
    self.0.page_rect().into()
  }

  /// The strip on the screen.
  #[napi]
  pub fn strip_screen_rect(&self) -> Rect {
    self.0.strip_screen_rect().into()
  }

  /// True when the frame is the foreground window.
  #[napi]
  pub fn is_foreground(&self) -> bool {
    self.0.is_foreground()
  }

  /// The frame's activation listener, called with `true` on activation; `null` removes it.
  #[napi]
  pub fn on_activate(&self, env: Env, listener: Option<Function<'_, bool, ()>>) -> napi::Result<()> {
    self.0.on_activate(env, listener)
  }

  /// Hands the left button's press to the OS move loop; returns when it is released.
  /// `heldX`/`heldY`: where in the strip the press was, in device-independent pixels.
  #[napi]
  pub fn start_drag(&self, held_x: Option<f64>, held_y: Option<f64>) -> napi::Result<()> {
    self.0.start_drag(held_x, held_y)
  }

  /// Hands the left button's press to the OS size loop from `edge`; returns when it is released.
  #[napi]
  pub fn start_resize(&self, edge: String, held_x: Option<f64>, held_y: Option<f64>) -> napi::Result<()> {
    self.0.start_resize(edge, held_x, held_y)
  }

  /// The window's system menu at the cursor; the chosen command is carried out.
  #[napi]
  pub fn show_system_menu(&self) -> napi::Result<()> {
    self.0.show_system_menu()
  }

  /// A popup menu at the cursor; returns the chosen entry's index once it closes, or -1.
  #[napi]
  pub fn show_menu(&self, entries: Vec<MenuEntryData>) -> napi::Result<i32> {
    self.0.show_menu(entries.into_iter().map(|e| (e.label, e.enabled)).collect())
  }

  /// `"system"`, `"light"` or `"dark"`.
  #[napi]
  pub fn appearance(&self) -> &'static str {
    self.0.appearance()
  }

  /// The frame's effective dark state.
  #[napi]
  pub fn is_dark(&self) -> bool {
    self.0.is_dark()
  }

  /// The system's dark state; changes only a frame whose appearance is `"system"`.
  #[napi]
  pub fn set_system_dark(&self, dark: bool) {
    self.0.set_system_dark(dark)
  }
}

/// True when the system's app theme is dark.
#[napi]
pub fn system_is_dark() -> bool {
  imp::system_is_dark()
}

/// True while the left mouse button is down.
#[napi]
pub fn left_button_down() -> bool {
  imp::left_button_down()
}

/// True when `handle` names a window now.
#[napi]
pub fn window_exists(handle: BigInt) -> napi::Result<bool> {
  imp::window_exists(&handle)
}
