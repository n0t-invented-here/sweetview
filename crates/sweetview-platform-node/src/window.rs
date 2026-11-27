//! Exports of `sweetview_napi::window`.

use napi::bindgen_prelude::{BigInt, FnArgs, Function, Int32Array, Uint8Array};
use napi::Env;
use napi_derive::napi;
use sweetview_napi::window as imp;

use crate::types::{Detected, Rect, WindowInit};

/// A native window: one Sweetview made, or a wrapper of any window by handle.
#[napi]
pub struct Window(imp::Window);

#[napi]
impl Window {
  /// Makes a window, hidden. Show it once it is positioned and wired.
  #[napi(factory, catch_unwind)]
  pub fn create(options: WindowInit) -> napi::Result<Self> {
    imp::create(options.into()).map(Self)
  }

  /// Wraps a window by handle: one of Sweetview's own (sharing it), or an application's own window.
  #[napi(factory, catch_unwind)]
  pub fn adopt(handle: BigInt) -> napi::Result<Self> {
    imp::adopt(&handle).map(Self)
  }

  /// The `HWND`.
  #[napi(getter, catch_unwind)]
  pub fn handle(&self) -> BigInt {
    self.0.handle()
  }

  /// For a wrapper: the window's frame and resizability.
  #[napi(getter, catch_unwind)]
  pub fn detected(&self) -> Option<Detected> {
    self.0.detected().map(Into::into)
  }

  #[napi(catch_unwind)]
  pub fn is_visible(&self) -> bool {
    self.0.is_visible()
  }

  /// Restores a minimised window; brings any other to the front unless it is `noActivate` or topmost.
  #[napi(catch_unwind)]
  pub fn show(&self) -> napi::Result<()> {
    self.0.show()
  }

  #[napi(catch_unwind)]
  pub fn hide(&self) {
    self.0.hide()
  }

  /// The outer frame.
  #[napi(catch_unwind)]
  pub fn bounds(&self) -> Rect {
    self.0.bounds().into()
  }

  #[napi(catch_unwind)]
  pub fn set_bounds(&self, rect: Rect) {
    self.0.set_bounds(rect.into())
  }

  #[napi(catch_unwind)]
  pub fn move_to(&self, x: f64, y: f64) {
    self.0.move_to(x, y)
  }

  #[napi(catch_unwind)]
  pub fn resize(&self, width: f64, height: f64) {
    self.0.resize(width, height)
  }

  /// The window's DPI over 96.
  #[napi(catch_unwind)]
  pub fn scale(&self) -> f64 {
    self.0.scale()
  }

  #[napi(catch_unwind)]
  pub fn set_title(&self, title: String) {
    self.0.set_title(title)
  }

  /// Caption and taskbar icons from `.ico` bytes; `null` for the stock icon.
  #[napi(catch_unwind)]
  pub fn set_icon(&self, ico: Option<Uint8Array>) -> napi::Result<()> {
    self.0.set_icon(ico)
  }

  #[napi(catch_unwind)]
  pub fn minimize(&self) {
    self.0.minimize()
  }

  /// A framed window maximises through the OS; a frameless one fills the work area of its screen.
  #[napi(catch_unwind)]
  pub fn toggle_maximize(&self) -> napi::Result<()> {
    self.0.toggle_maximize()
  }

  #[napi(catch_unwind)]
  pub fn is_maximized(&self) -> bool {
    self.0.is_maximized()
  }

  #[napi(catch_unwind)]
  pub fn set_topmost(&self, on: bool) {
    self.0.set_topmost(on)
  }

  /// Hands the left button's press to the OS move loop.
  #[napi(catch_unwind)]
  pub fn start_drag(&self) {
    self.0.start_drag()
  }

  /// Resizes from `edge` ("left", "top-right", ...) until the left button is released.
  #[napi(catch_unwind)]
  pub fn start_resize(&self, edge: String) -> napi::Result<()> {
    self.0.start_resize(edge)
  }

  /// The whole window lets clicks through, or none of it. Clears hit regions.
  #[napi(catch_unwind)]
  pub fn set_click_through(&self, on: bool) {
    self.0.set_click_through(on)
  }

  /// Only the packed polygons take clicks (`packRegions`); `null` restores normal hit testing.
  /// `refine(x, y, seq)` asks for the exact answer at a window-local point; reply with `answerHit`.
  // The callback types are spelled out so the generated declarations name their arguments.
  #[allow(clippy::type_complexity)]
  #[napi(catch_unwind)]
  pub fn set_hit_regions(&self, env: Env, packed: Option<Int32Array>, refine: Option<Function<'_, FnArgs<(i32, i32, u32)>, ()>>) -> napi::Result<()> {
    self.0.set_hit_regions(env, packed, refine)
  }

  /// The refiner's answer to the question numbered `seq`.
  #[napi(catch_unwind)]
  pub fn answer_hit(&self, seq: u32, solid: bool) {
    self.0.answer_hit(seq, solid)
  }

  /// This wrapper's resize listener, with the outer bounds; `null` removes it.
  // The callback types are spelled out so the generated declarations name their arguments.
  #[allow(clippy::type_complexity)]
  #[napi(catch_unwind)]
  pub fn on_resize(&self, env: Env, listener: Option<Function<'_, FnArgs<(i32, i32, i32, i32)>, ()>>) -> napi::Result<()> {
    self.0.on_resize(env, listener)
  }

  /// This wrapper's move listener, with the outer bounds; `null` removes it.
  // The callback types are spelled out so the generated declarations name their arguments.
  #[allow(clippy::type_complexity)]
  #[napi(catch_unwind)]
  pub fn on_move(&self, env: Env, listener: Option<Function<'_, FnArgs<(i32, i32, i32, i32)>, ()>>) -> napi::Result<()> {
    self.0.on_move(env, listener)
  }

  /// This wrapper's close listener; while any wrapper has one, the window stays open on a close request.
  #[napi(catch_unwind)]
  pub fn on_close_request(&self, env: Env, listener: Option<Function<'_, (), ()>>) -> napi::Result<()> {
    self.0.on_close_request(env, listener)
  }

  /// The owner's action for a close request no listener takes; without one the window is destroyed.
  #[napi(catch_unwind)]
  pub fn on_default_close(&self, env: Env, action: Option<Function<'_, (), ()>>) -> napi::Result<()> {
    self.0.on_default_close(env, action)
  }

  /// This wrapper's file-drop listener, with every path of one drop; `null` removes it.
  #[napi(catch_unwind)]
  pub fn on_file_drop(&self, env: Env, listener: Option<Function<'_, Vec<String>, ()>>) -> napi::Result<()> {
    self.0.on_file_drop(env, listener)
  }

  /// Saves the window's styles and outer bounds; returns the number `restoreGeometry` takes.
  #[napi(catch_unwind)]
  pub fn preserve_geometry(&self) -> u32 {
    self.0.preserve_geometry()
  }

  /// Puts back what `preserveGeometry` saved, once, and lays a mounted widget out.
  #[napi(catch_unwind)]
  pub fn restore_geometry(&self, id: u32) {
    self.0.restore_geometry(id)
  }

  /// The owner destroys the window; a wrapper removes what it added. Safe to call twice.
  #[napi(catch_unwind)]
  pub fn dispose(&self) {
    self.0.dispose()
  }
}

/// How many things Sweetview keeps for the window `handle`. For tests that check nothing leaks.
#[napi(catch_unwind)]
pub fn window_tracked_count(handle: BigInt) -> napi::Result<u32> {
  imp::tracked_count(&handle)
}
