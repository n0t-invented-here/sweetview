//! Windows: Sweetview's own, made by `tao`, and an application's own, wrapped by handle.
//!
//! Handles cross the boundary as `bigint`. Rectangles and points arrive as
//! JavaScript numbers and are rounded, as today's code rounds them.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use napi::bindgen_prelude::{BigInt, FnArgs, Function, Int32Array, Uint8Array};
use napi::Env;
use sweetview_runtime::window::{self as rt, Chrome, WindowInit};
use sweetview_runtime::{Rect, ResizeEdge};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// A window's handle from JavaScript: a `bigint`, or a number.
pub fn handle_from(handle: &BigInt) -> napi::Result<isize> {
  let (value, lossless) = handle.get_i64();
  if !lossless || handle.sign_bit {
    return Err(napi::Error::from_reason("sweetview: not a window handle"));
  }
  isize::try_from(value).map_err(|_| napi::Error::from_reason("sweetview: not a window handle"))
}

/// A window's handle for JavaScript.
pub fn handle_to(handle: isize) -> BigInt {
  BigInt::from(handle as i64)
}

/// A rectangle from JavaScript numbers, rounded to whole pixels.
pub fn rect_from(x: f64, y: f64, width: f64, height: f64) -> Rect {
  Rect::new(x.round() as i32, y.round() as i32, width.round() as i32, height.round() as i32)
}

/// One wrapper of a native window, as JavaScript holds it.
pub struct Window {
  inner: rt::Window,
  snapshots: RefCell<HashMap<u32, rt::GeometrySnapshot>>,
  next_snapshot: Cell<u32>,
}

/// Makes a window, hidden.
pub fn create(init: WindowInit) -> napi::Result<Window> {
  rt::Window::create(init).or_throw().map(Window::new)
}

/// Wraps a window by handle: one of Sweetview's own, or an application's own window.
pub fn adopt(handle: &BigInt) -> napi::Result<Window> {
  rt::Window::adopt(handle_from(handle)?).or_throw().map(Window::new)
}

/// How many things Sweetview keeps for the window `handle`. For tests that check nothing leaks.
pub fn tracked_count(handle: &BigInt) -> napi::Result<u32> {
  Ok(rt::tracked_count(handle_from(handle)?) as u32)
}

/// A listener called with `(x, y, width, height)`.
pub type RectFn<'a> = Function<'a, FnArgs<(i32, i32, i32, i32)>, ()>;
/// A refiner called with `(x, y, seq)`.
pub type RefineFn<'a> = Function<'a, FnArgs<(i32, i32, u32)>, ()>;

fn rect_listener(env: Env, function: Option<RectFn<'_>>, kind: &'static str) -> napi::Result<Option<rt::RectListener>> {
  let Some(function) = function else { return Ok(None) };
  let callback = JsCallback::new(env, &function, kind)?;
  Ok(Some(Rc::new(move |r: Rect| {
    callback.call(FnArgs::from((r.x, r.y, r.width, r.height)));
  })))
}

fn listener(env: Env, function: Option<Function<'_, (), ()>>, kind: &'static str) -> napi::Result<Option<rt::Listener>> {
  let Some(function) = function else { return Ok(None) };
  let callback = JsCallback::new(env, &function, kind)?;
  Ok(Some(Rc::new(move || {
    callback.call(());
  })))
}

impl Window {
  fn new(inner: rt::Window) -> Self {
    Self { inner, snapshots: RefCell::new(HashMap::new()), next_snapshot: Cell::new(1) }
  }

  pub fn handle(&self) -> BigInt {
    handle_to(self.inner.handle())
  }

  pub fn detected(&self) -> Option<Chrome> {
    self.inner.detected()
  }

  pub fn is_visible(&self) -> bool {
    self.inner.is_visible()
  }

  pub fn show(&self) -> napi::Result<()> {
    self.inner.show().or_throw()
  }

  pub fn hide(&self) {
    self.inner.hide();
  }

  pub fn bounds(&self) -> Rect {
    self.inner.bounds()
  }

  pub fn set_bounds(&self, rect: Rect) {
    self.inner.set_bounds(rect);
  }

  pub fn move_to(&self, x: f64, y: f64) {
    self.inner.move_to(x.round() as i32, y.round() as i32);
  }

  pub fn resize(&self, width: f64, height: f64) {
    self.inner.resize(width.round() as i32, height.round() as i32);
  }

  pub fn scale(&self) -> f64 {
    self.inner.scale()
  }

  pub fn set_title(&self, title: String) {
    self.inner.set_title(&title);
  }

  /// `.ico` bytes, or `null` for the stock icon.
  pub fn set_icon(&self, ico: Option<Uint8Array>) -> napi::Result<()> {
    self.inner.set_icon(ico.as_deref()).or_throw()
  }

  pub fn minimize(&self) {
    self.inner.minimize();
  }

  pub fn toggle_maximize(&self) -> napi::Result<()> {
    self.inner.toggle_maximize().or_throw()
  }

  pub fn is_maximized(&self) -> bool {
    self.inner.is_maximized()
  }

  pub fn set_topmost(&self, on: bool) {
    self.inner.set_topmost(on);
  }

  pub fn start_drag(&self) {
    self.inner.start_drag();
  }

  pub fn start_resize(&self, edge: String) -> napi::Result<()> {
    let edge = ResizeEdge::parse(&edge).ok_or_else(|| napi::Error::from_reason(format!("sweetview: not a window edge: {edge}")))?;
    self.inner.start_resize(edge).or_throw()
  }

  pub fn set_click_through(&self, on: bool) {
    self.inner.set_click_through(on);
  }

  /// `packed` in the format of `packRegions`, or `null` for normal hit
  /// testing. `refine(x, y, seq)` asks the page; its answer comes back
  /// through `answer_hit(seq, solid)`.
  pub fn set_hit_regions(&self, env: Env, packed: Option<Int32Array>, refine: Option<RefineFn<'_>>) -> napi::Result<()> {
    let refine: Option<rt::Refiner> = match refine {
      Some(function) => {
        let callback = JsCallback::new(env, &function, "a hit-region refiner")?;
        Some(Rc::new(move |x, y, seq| {
          callback.call(FnArgs::from((x, y, seq)));
        }))
      }
      None => None,
    };
    self.inner.set_hit_regions(packed.map(|p| p.to_vec()), refine).or_throw()
  }

  pub fn answer_hit(&self, seq: u32, solid: bool) {
    self.inner.answer_hit(seq, solid);
  }

  pub fn on_resize(&self, env: Env, function: Option<RectFn<'_>>) -> napi::Result<()> {
    self.inner.on_resize(rect_listener(env, function, "an onResize handler")?).or_throw()
  }

  pub fn on_move(&self, env: Env, function: Option<RectFn<'_>>) -> napi::Result<()> {
    self.inner.on_move(rect_listener(env, function, "an onMove handler")?).or_throw()
  }

  pub fn on_close_request(&self, env: Env, function: Option<Function<'_, (), ()>>) -> napi::Result<()> {
    self.inner.on_close_request(listener(env, function, "an onClose handler")?).or_throw()
  }

  pub fn on_default_close(&self, env: Env, function: Option<Function<'_, (), ()>>) -> napi::Result<()> {
    self.inner.on_default_close(listener(env, function, "a window's default close")?);
    Ok(())
  }

  pub fn on_file_drop(&self, env: Env, function: Option<Function<'_, Vec<String>, ()>>) -> napi::Result<()> {
    let listener: Option<rt::DropListener> = match function {
      Some(function) => {
        let callback = JsCallback::new(env, &function, "an onFileDrop handler")?;
        Some(Rc::new(move |paths: Vec<String>| {
          callback.call(paths);
        }))
      }
      None => None,
    };
    self.inner.on_file_drop(listener).or_throw()
  }

  /// Saves the window's styles and outer bounds; returns the number that puts them back.
  pub fn preserve_geometry(&self) -> u32 {
    let id = self.next_snapshot.get();
    self.next_snapshot.set(id.wrapping_add(1).max(1));
    self.snapshots.borrow_mut().insert(id, self.inner.preserve_geometry());
    id
  }

  /// Puts back what `preserve_geometry` saved under `id`, once.
  pub fn restore_geometry(&self, id: u32) {
    let snapshot = self.snapshots.borrow_mut().remove(&id);
    if let Some(snapshot) = snapshot {
      self.inner.restore_geometry(&snapshot);
    }
  }

  pub fn dispose(&self) {
    self.snapshots.borrow_mut().clear();
    self.inner.dispose();
  }
}
