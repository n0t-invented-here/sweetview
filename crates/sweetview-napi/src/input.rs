//! System-wide mouse and keyboard hooks and the permission model for them.
//!
//! Results are the `webview_error_t` codes of the C API these replace; the
//! TypeScript layer turns them into the errors applications see.

use napi::bindgen_prelude::{FnArgs, Function};
use napi::Env;
use sweetview_runtime::input::{self, permissions};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// `WEBVIEW_ERROR_INVALID_ARGUMENT`: a permission number that names no permission.
const INVALID_ARGUMENT: i32 = -2;

/// The mouse handler: `(event, x, y, wheel, modifiers) => swallow`.
pub type MouseHandler<'a> = Function<'a, FnArgs<(i32, f64, f64, f64, u32)>, bool>;
/// The keyboard handler: `(event, code, raw, modifiers) => swallow`.
pub type KeyHandler<'a> = Function<'a, FnArgs<(i32, String, u32, u32)>, bool>;

/// Installs the process's mouse hook. Returns a `webview_error_t`.
pub fn install_mouse_hook(env: Env, handler: MouseHandler<'_>) -> napi::Result<i32> {
  let handler = JsCallback::new(env, &handler, "a mouse hook handler")?;
  input::install_mouse_hook(move |event| {
    let args = (event.kind as i32, event.x, event.y, event.wheel, event.modifiers);
    // A handler that threw does not swallow the event.
    handler.call(args.into()).unwrap_or(false)
  })
  .or_throw()
}

/// Removes the mouse hook. Returns a `webview_error_t`; 2 when none is installed.
pub fn remove_mouse_hook() -> napi::Result<i32> {
  input::remove_mouse_hook().or_throw()
}

/// Installs the process's keyboard hook. Returns a `webview_error_t`.
pub fn install_keyboard_hook(env: Env, handler: KeyHandler<'_>) -> napi::Result<i32> {
  let handler = JsCallback::new(env, &handler, "a keyboard hook handler")?;
  input::install_keyboard_hook(move |event| {
    let args = (event.kind as i32, event.code.to_owned(), event.raw, event.modifiers);
    // A handler that threw does not swallow the event.
    handler.call(args.into()).unwrap_or(false)
  })
  .or_throw()
}

/// Removes the keyboard hook. Returns a `webview_error_t`; 2 when none is installed.
pub fn remove_keyboard_hook() -> napi::Result<i32> {
  input::remove_keyboard_hook().or_throw()
}

/// The permissions a feature needs, as a bit mask. An unknown feature needs none.
pub fn feature_permissions(feature: i32) -> u32 {
  permissions::Feature::from_code(feature).map_or(0, permissions::needed)
}

/// The state of one permission, as a `webview_error_t`: 0 granted, -5 missing, -1 not applicable.
pub fn permission_status(permission: u32) -> i32 {
  permissions::Permission::from_bits(permission).map_or(INVALID_ARGUMENT, |p| permissions::status(p).code())
}

/// Asks the OS for one permission and returns its state, as `permission_status` does.
pub fn permission_request(permission: u32) -> i32 {
  permissions::Permission::from_bits(permission).map_or(INVALID_ARGUMENT, |p| permissions::request(p).code())
}

/// Whether installing a hook asks for a missing permission by itself.
pub fn permission_set_auto_request(on: bool) {
  permissions::set_auto_request(on);
}
