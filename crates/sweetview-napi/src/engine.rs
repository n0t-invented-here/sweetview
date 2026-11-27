//! The webview engine as JavaScript sees it.
//!
//! Numeric results are `webview_error_t` codes, so the TypeScript `Webview`
//! class reports them as `WebviewError`s exactly as before.

use std::rc::Rc;

use napi::bindgen_prelude::{BigInt, FnArgs, Function, Uint8Array};
use napi::Env;
use napi_derive::napi;
use sweetview_runtime::engine::{self as runtime, Bounds, Host, SizeHint};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// `WEBVIEW_ERROR_INVALID_STATE`: the webview named is destroyed, or never existed.
const INVALID_STATE: i32 = -3;
/// `WEBVIEW_ERROR_INVALID_ARGUMENT`.
const INVALID_ARGUMENT: i32 = -2;

/// A rectangle in physical pixels.
#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct Rect {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

impl From<Rect> for Bounds {
  fn from(rect: Rect) -> Self {
    Bounds { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
}

/// A request handed to the request handler.
#[napi(object)]
pub struct RawRequest {
  /// Pass to `completeRequest` or `beginResponse`.
  pub id: BigInt,
  pub method: String,
  pub url: String,
  /// The request headers: the JSON text of an array of `[name, value]` pairs.
  pub headers_json: String,
  /// The request body, or null when there is none.
  pub body: Option<Uint8Array>,
}

/// An accelerator key pressed while a page has focus.
#[napi(object)]
#[derive(Debug, Clone, Copy)]
pub struct KeyData {
  pub virtual_key: u32,
  pub control: bool,
  pub shift: bool,
  pub alt: bool,
}

pub type BindingFn<'a> = Function<'a, FnArgs<(String, String)>, ()>;
pub type RequestFn<'a> = Function<'a, RawRequest, ()>;
pub type FileDropFn<'a> = Function<'a, Vec<String>, ()>;
pub type AcceleratorFn<'a> = Function<'a, KeyData, bool>;
pub type UrlFn<'a> = Function<'a, String, ()>;
pub type NavigationFailedFn<'a> = Function<'a, FnArgs<(String, String)>, ()>;

fn handle_value(window: &BigInt) -> isize {
  let (value, _lossless) = window.get_i64();
  value as isize
}

/// One webview. See `packages/sweetview-native/src/webview.ts` for the API applications use.
pub struct Engine {
  inner: runtime::Engine,
}

impl Engine {
  /// Fills `window` with a webview; with `null`, in a window of the webview's own.
  pub fn create(debug: bool, window: Option<BigInt>) -> napi::Result<Engine> {
    let host = window.as_ref().map_or(Host::Own, |window| Host::Fill(handle_value(window)));
    Ok(Engine { inner: runtime::Engine::create(debug, host).or_throw()? })
  }

  /// A child of `window`, at a rectangle of its client area.
  pub fn create_child(debug: bool, window: BigInt, bounds: Rect) -> napi::Result<Engine> {
    let host = Host::Child(handle_value(&window), bounds.into());
    Ok(Engine { inner: runtime::Engine::create(debug, host).or_throw()? })
  }

  /// The live webview a handle names, or null.
  pub fn from_handle(handle: u32) -> napi::Result<Option<Engine>> {
    sweetview_runtime::threads::require_ui_thread().or_throw()?;
    Ok(runtime::Engine::from_id(handle).map(|inner| Engine { inner }))
  }

  pub fn handle(&self) -> u32 {
    self.inner.id()
  }

  pub fn window_handle(&self) -> BigInt {
    BigInt::from(self.inner.window_handle() as i64)
  }

  pub fn destroyed(&self) -> bool {
    self.inner.is_destroyed()
  }

  pub fn set_title(&self, title: String) {
    self.inner.set_title(&title);
  }

  pub fn set_size(&self, width: u32, height: u32, hint: i32) {
    self.inner.set_size(width, height, SizeHint::from_code(hint));
  }

  pub fn set_bounds(&self, bounds: Rect) {
    self.inner.set_bounds(bounds.into());
  }

  pub fn set_visible(&self, visible: bool) {
    self.inner.set_visible(visible);
  }

  pub fn move_focus(&self) {
    self.inner.move_focus();
  }

  pub fn notify_moved(&self) {
    self.inner.notify_moved();
  }

  pub fn reparent(&self, window: BigInt) -> napi::Result<()> {
    self.inner.reparent(handle_value(&window)).or_throw()
  }

  pub fn navigate(&self, url: String) {
    self.inner.navigate(&url);
  }

  pub fn set_html(&self, html: String) {
    self.inner.set_html(&html);
  }

  pub fn init(&self, source: String) {
    self.inner.init(&source);
  }

  pub fn eval(&self, source: String) {
    self.inner.eval(&source);
  }

  pub fn bind(&self, env: Env, name: String, callback: BindingFn<'_>) -> napi::Result<i32> {
    let callback = JsCallback::new(env, &callback, "a binding")?;
    let code = self.inner.bind(
      &name,
      Rc::new(move |seq, params| {
        callback.call((seq.to_owned(), params.to_owned()).into());
      }),
    );
    Ok(code.code())
  }

  pub fn unbind(&self, name: String) -> i32 {
    self.inner.unbind(&name).code()
  }

  pub fn return_value(&self, seq: String, status: i32, result: String) {
    self.inner.return_value(&seq, status, &result);
  }

  pub fn set_asset(&self, path: String, mime: String, data: Uint8Array) -> i32 {
    self.inner.set_asset(&path, &mime, data.to_vec()).code()
  }

  pub fn set_background_color(&self, r: u32, g: u32, b: u32, a: u32) -> i32 {
    match (u8::try_from(r), u8::try_from(g), u8::try_from(b), u8::try_from(a)) {
      (Ok(r), Ok(g), Ok(b), Ok(a)) => self.inner.set_background_color(r, g, b, a).code(),
      _ => INVALID_ARGUMENT,
    }
  }

  pub fn set_allow_external_drop(&self, allow: bool) -> i32 {
    self.inner.set_allow_external_drop(allow).code()
  }

  pub fn set_request_handler(&self, env: Env, handler: Option<RequestFn<'_>>) -> napi::Result<i32> {
    let handler = match handler {
      None => None,
      Some(handler) => {
        let handler = JsCallback::new(env, &handler, "a request handler")?;
        let responder_of = self.inner.id();
        Some(Rc::new(move |request: runtime::RawRequest| {
          let id = request.id;
          let delivered = handler.call(RawRequest {
            id: BigInt::from(request.id),
            method: request.method,
            url: request.url,
            headers_json: request.headers_json,
            body: request.body.map(Uint8Array::from),
          });
          // A handler that threw answers 500, so the page's request never hangs.
          if delivered.is_none() {
            if let Some(responder) = runtime::responder(responder_of) {
              responder.complete(id, 500, None, None);
            }
          }
        }) as Rc<dyn Fn(runtime::RawRequest)>)
      }
    };
    Ok(self.inner.set_request_handler(handler).code())
  }

  pub fn set_file_drop_handler(&self, env: Env, handler: Option<FileDropFn<'_>>) -> napi::Result<i32> {
    let handler = match handler {
      None => None,
      Some(handler) => {
        let handler = JsCallback::new(env, &handler, "a file drop handler")?;
        Some(Rc::new(move |paths: Vec<String>| {
          handler.call(paths);
        }) as Rc<dyn Fn(Vec<String>)>)
      }
    };
    Ok(self.inner.set_file_drop_handler(handler).code())
  }

  /// `handler` returns true to mark the key handled. `null` removes it.
  pub fn on_accelerator_key(&self, env: Env, handler: Option<AcceleratorFn<'_>>) -> napi::Result<i32> {
    let handler = match handler {
      None => None,
      Some(handler) => {
        let handler = JsCallback::new(env, &handler, "an accelerator key handler")?;
        Some(Rc::new(move |key: runtime::KeyData| {
          let key = KeyData { virtual_key: key.virtual_key, control: key.control, shift: key.shift, alt: key.alt };
          // A handler that threw leaves the key to the page.
          handler.call(key).unwrap_or(false)
        }) as Rc<dyn Fn(runtime::KeyData) -> bool>)
      }
    };
    Ok(self.inner.set_accelerator_key_handler(handler).code())
  }

  /// With a handler set, a popup is reported with its URL and not opened. `null` removes it.
  pub fn on_new_window_requested(&self, env: Env, handler: Option<UrlFn<'_>>) -> napi::Result<()> {
    let handler = match handler {
      None => None,
      Some(handler) => {
        let handler = JsCallback::new(env, &handler, "a new-window handler")?;
        Some(Rc::new(move |url: String| {
          handler.call(url);
        }) as Rc<dyn Fn(String)>)
      }
    };
    self.inner.set_new_window_handler(handler);
    Ok(())
  }

  /// Called with the URL and a sentence for the user when a top-level navigation fails. `null` removes it.
  pub fn on_navigation_failed(&self, env: Env, handler: Option<NavigationFailedFn<'_>>) -> napi::Result<i32> {
    let handler = match handler {
      None => None,
      Some(handler) => {
        let handler = JsCallback::new(env, &handler, "a navigation-failed handler")?;
        Some(Rc::new(move |failure: runtime::NavigationFailure| {
          // A failure a newer navigation has already replaced is not reported.
          if failure.is_current() {
            handler.call((failure.url.clone(), failure.reason.clone()).into());
          }
        }) as Rc<dyn Fn(runtime::NavigationFailure)>)
      }
    };
    Ok(self.inner.set_navigation_failed_handler(handler).code())
  }

  pub fn call_dev_tools_protocol_method(&self, method: String, params_json: String) -> i32 {
    self.inner.call_devtools_protocol_method(&method, &params_json).code()
  }

  /// Blocks in the loop until it is asked to quit or this webview's own window is closed.
  pub fn run(&self) -> napi::Result<()> {
    self.inner.run().or_throw()
  }

  pub fn destroy(&self) {
    self.inner.destroy();
  }
}

fn request_id(id: &BigInt) -> u64 {
  let (_negative, value, _lossless) = id.get_u64();
  value
}

/// Answers a request of webview `handle`. Callable from any thread.
pub fn complete_request(handle: u32, id: BigInt, status: i32, headers_json: Option<String>, body: Option<Uint8Array>) -> i32 {
  match runtime::responder(handle) {
    Some(responder) => responder.complete(request_id(&id), status, headers_json.as_deref(), body.as_deref()).code(),
    None => INVALID_STATE,
  }
}

/// Starts a streamed answer to a request of webview `handle`. Callable from any thread.
pub fn begin_response(handle: u32, id: BigInt, status: i32, headers_json: Option<String>) -> i32 {
  match runtime::responder(handle) {
    Some(responder) => responder.begin(request_id(&id), status, headers_json.as_deref()).code(),
    None => INVALID_STATE,
  }
}

/// Appends body bytes to a streamed answer. Callable from any thread.
pub fn write_response_chunk(handle: u32, id: BigInt, chunk: Uint8Array) -> i32 {
  match runtime::responder(handle) {
    Some(responder) => responder.write_chunk(request_id(&id), &chunk).code(),
    None => INVALID_STATE,
  }
}

/// Ends a streamed answer. Callable from any thread.
pub fn end_response(handle: u32, id: BigInt) -> i32 {
  match runtime::responder(handle) {
    Some(responder) => responder.end(request_id(&id)).code(),
    None => INVALID_STATE,
  }
}
