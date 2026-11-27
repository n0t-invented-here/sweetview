//! Exports of `sweetview_napi::input`.

use napi::Env;
use napi_derive::napi;
use sweetview_napi::input as imp;

/// Installs the process's mouse hook: `(event, x, y, wheel, modifiers) => swallow`. Returns a `webview_error_t`.
#[napi(ts_args_type = "handler: (event: number, x: number, y: number, wheel: number, modifiers: number) => boolean")]
pub fn install_mouse_hook(env: Env, handler: imp::MouseHandler<'_>) -> napi::Result<i32> {
  imp::install_mouse_hook(env, handler)
}

/// Removes the mouse hook. Returns a `webview_error_t`; 2 when none is installed.
#[napi]
pub fn remove_mouse_hook() -> napi::Result<i32> {
  imp::remove_mouse_hook()
}

/// Installs the process's keyboard hook: `(event, code, raw, modifiers) => swallow`. Returns a `webview_error_t`.
#[napi(ts_args_type = "handler: (event: number, code: string, raw: number, modifiers: number) => boolean")]
pub fn install_keyboard_hook(env: Env, handler: imp::KeyHandler<'_>) -> napi::Result<i32> {
  imp::install_keyboard_hook(env, handler)
}

/// Removes the keyboard hook. Returns a `webview_error_t`; 2 when none is installed.
#[napi]
pub fn remove_keyboard_hook() -> napi::Result<i32> {
  imp::remove_keyboard_hook()
}

/// The permissions a feature needs, as a bit mask. An unknown feature needs none.
#[napi]
pub fn feature_permissions(feature: i32) -> u32 {
  imp::feature_permissions(feature)
}

/// The state of one permission, as a `webview_error_t`: 0 granted, -5 missing, -1 not applicable.
#[napi]
pub fn permission_status(permission: u32) -> i32 {
  imp::permission_status(permission)
}

/// Asks the OS for one permission and returns its state, as `permissionStatus` does.
#[napi]
pub fn permission_request(permission: u32) -> i32 {
  imp::permission_request(permission)
}

/// Whether installing a hook asks for a missing permission by itself.
#[napi]
pub fn permission_set_auto_request(on: bool) {
  imp::permission_set_auto_request(on)
}
