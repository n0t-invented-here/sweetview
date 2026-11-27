//! Exports of `sweetview_napi::shell`.

use napi::bindgen_prelude::Function;
use napi::Env;
use napi_derive::napi;
use sweetview_napi::shell as imp;

/// The clipboard's text, or `null` when it holds no text. UI thread.
#[napi]
pub fn clipboard_read_text() -> napi::Result<Option<String>> {
  imp::clipboard_read_text()
}

/// Replaces the whole clipboard with `text`. UI thread.
#[napi]
pub fn clipboard_write_text(text: String) -> napi::Result<()> {
  imp::clipboard_write_text(text)
}

/// Empties the clipboard. UI thread.
#[napi]
pub fn clipboard_clear() -> napi::Result<()> {
  imp::clipboard_clear()
}

/// Registers `scheme` for the current user with the given registry values. Any thread.
#[napi]
pub fn register_url_scheme(scheme: String, app_name: String, icon_path: String, command: String) -> napi::Result<()> {
  imp::register_url_scheme(scheme, app_name, icon_path, command)
}

/// Removes the current user's registration of `scheme`. Any thread.
#[napi]
pub fn unregister_url_scheme(scheme: String) -> napi::Result<()> {
  imp::unregister_url_scheme(scheme)
}

/// Tells the shell that program icons changed. Any thread.
#[napi]
pub fn refresh_shell_icons() {
  imp::refresh_shell_icons()
}

/// The single-instance lock of this process, or a secondary's result.
#[napi]
pub struct SingleInstance {
  inner: imp::SingleInstance,
}

#[napi]
impl SingleInstance {
  /// Takes the lock for `appId`, or hands `payloadJson` to the instance that holds it.
  /// On the primary, `onSecond(payloadJson)` runs on the UI thread for each later launch. UI thread.
  #[napi(factory)]
  pub fn acquire(env: Env, app_id: String, payload_json: String, on_second: Function<'_, String, ()>) -> napi::Result<Self> {
    Ok(Self { inner: imp::SingleInstance::acquire(env, app_id, payload_json, on_second)? })
  }

  /// Whether this process holds the lock.
  #[napi(getter)]
  pub fn is_primary(&self) -> bool {
    self.inner.is_primary()
  }

  /// Secondary only: the payload was delivered over the native transport.
  #[napi(getter)]
  pub fn handed_off(&self) -> bool {
    self.inner.handed_off()
  }

  /// Primary: releases the lock. Does nothing on a secondary or a second time.
  #[napi]
  pub fn dispose(&mut self) {
    self.inner.dispose()
  }
}
