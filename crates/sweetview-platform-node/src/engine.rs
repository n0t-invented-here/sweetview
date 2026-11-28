//! Exports of `sweetview_napi::engine`.

use napi::bindgen_prelude::{BigInt, FnArgs, Function, Uint8Array};
use napi::Env;
use napi_derive::napi;
use sweetview_napi::engine as imp;
use sweetview_napi::engine::{KeyData, RawRequest};

use crate::types::Rect;

/// One webview: on Windows WebView2, made as the C++ library made it, plus Sweetview's request handling.
/// Numeric results are `webview_error_t` codes.
#[napi]
pub struct Engine(imp::Engine);

#[napi]
impl Engine {
  /// Fills `window` with a webview; with `null`, in a window of the webview's own.
  #[napi(factory, catch_unwind)]
  pub fn create(debug: bool, window: Option<BigInt>) -> napi::Result<Engine> {
    imp::Engine::create(debug, window).map(Engine)
  }

  /// A child of `window`, at a rectangle of its client area in physical pixels.
  #[napi(factory, catch_unwind)]
  pub fn create_child(debug: bool, window: BigInt, bounds: Rect) -> napi::Result<Engine> {
    imp::Engine::create_child(debug, window, bounds.into()).map(Engine)
  }

  /// The live webview a handle names, or null.
  #[napi(catch_unwind)]
  pub fn from_handle(handle: u32) -> napi::Result<Option<Engine>> {
    Ok(imp::Engine::from_handle(handle)?.map(Engine))
  }

  /// The number that names this webview to the functions a Worker calls.
  #[napi(getter, catch_unwind)]
  pub fn handle(&self) -> u32 {
    self.0.handle()
  }

  /// The native window the webview lives in: the `HWND` on Windows.
  #[napi(getter, catch_unwind)]
  pub fn window_handle(&self) -> BigInt {
    self.0.window_handle()
  }

  #[napi(getter, catch_unwind)]
  pub fn destroyed(&self) -> bool {
    self.0.destroyed()
  }

  #[napi(catch_unwind)]
  pub fn set_title(&self, title: String) {
    self.0.set_title(title)
  }

  /// Sizes the webview's window, in device-independent pixels; `hint` is a `SizeHint`. A window the webview was given is restyled and resized but not shown.
  #[napi(catch_unwind)]
  pub fn set_size(&self, width: u32, height: u32, hint: i32) {
    self.0.set_size(width, height, hint)
  }

  /// Moves a child webview inside its host window.
  #[napi(catch_unwind)]
  pub fn set_bounds(&self, bounds: Rect) {
    self.0.set_bounds(bounds.into())
  }

  #[napi(catch_unwind)]
  pub fn set_visible(&self, visible: bool) {
    self.0.set_visible(visible)
  }

  /// Gives the page the keyboard focus.
  #[napi(catch_unwind)]
  pub fn move_focus(&self) {
    self.0.move_focus()
  }

  /// Tells the webview its host window moved, so its popups follow.
  #[napi(catch_unwind)]
  pub fn notify_moved(&self) {
    self.0.notify_moved()
  }

  /// Test hook: how many times `notifyMoved` reached the live webview.
  #[napi(catch_unwind)]
  pub fn moves_told(&self) -> u32 {
    self.0.moves_told()
  }

  /// Moves the webview into another window without reloading it.
  #[napi(catch_unwind)]
  pub fn reparent(&self, window: BigInt) -> napi::Result<()> {
    self.0.reparent(window)
  }

  #[napi(catch_unwind)]
  pub fn navigate(&self, url: String) {
    self.0.navigate(url)
  }

  #[napi(catch_unwind)]
  pub fn set_html(&self, html: String) {
    self.0.set_html(html)
  }

  /// Runs `source` at the start of every document the webview opens from now on.
  #[napi(catch_unwind)]
  pub fn init(&self, source: String) {
    self.0.init(source)
  }

  /// Runs `source` in the current document. The result is discarded.
  #[napi(catch_unwind)]
  pub fn eval(&self, source: String) {
    self.0.eval(source)
  }

  /// Makes `name` a global async function of the page; `callback(seq, params)` runs for each call.
  #[napi(catch_unwind)]
  pub fn bind(&self, env: Env, name: String, callback: Function<'_, FnArgs<(String, String)>, ()>) -> napi::Result<i32> {
    self.0.bind(env, name, callback)
  }

  #[napi(catch_unwind)]
  pub fn unbind(&self, name: String) -> i32 {
    self.0.unbind(name)
  }

  /// Settles the page's promise for call `seq`.
  #[napi(catch_unwind)]
  pub fn return_value(&self, seq: String, status: i32, result: String) {
    self.0.return_value(seq, status, result)
  }

  /// Serves bytes at a path of the page's own origin.
  #[napi(catch_unwind)]
  pub fn set_asset(&self, path: String, mime: String, data: Uint8Array) -> i32 {
    self.0.set_asset(path, mime, data)
  }

  #[napi(catch_unwind)]
  pub fn set_background_color(&self, r: u32, g: u32, b: u32, a: u32) -> i32 {
    self.0.set_background_color(r, g, b, a)
  }

  #[napi(catch_unwind)]
  pub fn set_allow_external_drop(&self, allow: bool) -> i32 {
    self.0.set_allow_external_drop(allow)
  }

  /// Hands every request no asset answers to `handler`. `null` removes it.
  #[napi(catch_unwind)]
  pub fn set_request_handler(&self, env: Env, handler: Option<Function<'_, RawRequest, ()>>) -> napi::Result<i32> {
    self.0.set_request_handler(env, handler)
  }

  /// Hands the paths of files dropped from the OS to `handler`. `null` removes it.
  #[napi(catch_unwind)]
  pub fn set_file_drop_handler(&self, env: Env, handler: Option<Function<'_, Vec<String>, ()>>) -> napi::Result<i32> {
    self.0.set_file_drop_handler(env, handler)
  }

  /// `handler` returns true to mark the key handled. `null` removes it.
  #[napi(catch_unwind)]
  pub fn on_accelerator_key(&self, env: Env, handler: Option<Function<'_, KeyData, bool>>) -> napi::Result<i32> {
    self.0.on_accelerator_key(env, handler)
  }

  /// With a handler set, a popup is reported with its URL and not opened. `null` removes it.
  #[napi(catch_unwind)]
  pub fn on_new_window_requested(&self, env: Env, handler: Option<Function<'_, String, ()>>) -> napi::Result<()> {
    self.0.on_new_window_requested(env, handler)
  }

  /// Called with the URL and a sentence for the user when a top-level navigation fails. `null` removes it.
  #[napi(catch_unwind)]
  pub fn on_navigation_failed(&self, env: Env, handler: Option<Function<'_, FnArgs<(String, String)>, ()>>) -> napi::Result<i32> {
    self.0.on_navigation_failed(env, handler)
  }

  /// Sends a DevTools Protocol command to the webview; `paramsJson` is the JSON text of its parameters.
  #[napi(catch_unwind)]
  pub fn call_dev_tools_protocol_method(&self, method: String, params_json: String) -> i32 {
    self.0.call_dev_tools_protocol_method(method, params_json)
  }

  /// Blocks in the loop until it is asked to quit or this webview's own window is closed.
  #[napi(catch_unwind)]
  pub fn run(&self) -> napi::Result<()> {
    self.0.run()
  }

  /// Destroys the webview. It counts as destroyed at once.
  #[napi(catch_unwind)]
  pub fn destroy(&self) {
    self.0.destroy()
  }
}

/// Answers a request of webview `handle`. Callable from any thread.
#[napi(catch_unwind)]
pub fn complete_request(handle: u32, id: BigInt, status: i32, headers_json: Option<String>, body: Option<Uint8Array>) -> i32 {
  imp::complete_request(handle, id, status, headers_json, body)
}

/// Starts a streamed answer to a request of webview `handle`. Callable from any thread.
#[napi(catch_unwind)]
pub fn begin_response(handle: u32, id: BigInt, status: i32, headers_json: Option<String>) -> i32 {
  imp::begin_response(handle, id, status, headers_json)
}

/// Appends body bytes to a streamed answer. Callable from any thread.
#[napi(catch_unwind)]
pub fn write_response_chunk(handle: u32, id: BigInt, chunk: Uint8Array) -> i32 {
  imp::write_response_chunk(handle, id, chunk)
}

/// Ends a streamed answer. Callable from any thread.
#[napi(catch_unwind)]
pub fn end_response(handle: u32, id: BigInt) -> i32 {
  imp::end_response(handle, id)
}
