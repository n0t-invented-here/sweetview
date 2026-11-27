//! Clipboard text, URL schemes, the single-instance lock and the shell icon refresh.
//!
//! Errors are thrown with the messages today's TypeScript throws.

use napi::bindgen_prelude::Function;
use napi::Env;
use sweetview_runtime::activation::{self, Registration};
use sweetview_runtime::{clipboard, shell};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// The clipboard's text, or `null` when it holds no text. UI thread.
pub fn clipboard_read_text() -> napi::Result<Option<String>> {
  clipboard::read_text().or_throw()
}

/// Replaces the whole clipboard with `text`. UI thread.
pub fn clipboard_write_text(text: String) -> napi::Result<()> {
  clipboard::write_text(&text).or_throw()
}

/// Empties the clipboard. UI thread.
pub fn clipboard_clear() -> napi::Result<()> {
  clipboard::clear().or_throw()
}

/// Registers `scheme` for the current user with the given registry values. Any thread.
pub fn register_url_scheme(scheme: String, app_name: String, icon_path: String, command: String) -> napi::Result<()> {
  activation::register_url_scheme(&scheme, &Registration { app_name, icon_path, command }).or_throw()
}

/// Removes the current user's registration of `scheme`. Any thread.
pub fn unregister_url_scheme(scheme: String) -> napi::Result<()> {
  activation::unregister_url_scheme(&scheme).or_throw()
}

/// Tells the shell that program icons changed. Any thread.
pub fn refresh_shell_icons() {
  shell::refresh_shell_icons();
}

/// The single-instance lock of this process, or a secondary's result.
pub struct SingleInstance {
  inner: activation::SingleInstance,
}

impl SingleInstance {
  /// Takes the lock for `appId`, or hands `payloadJson` to the instance that
  /// holds it. On the primary, `onSecond(payloadJson)` runs on the UI thread
  /// for each later launch. UI thread.
  pub fn acquire(env: Env, app_id: String, payload_json: String, on_second: Function<'_, String, ()>) -> napi::Result<Self> {
    let on_second = JsCallback::new(env, &on_second, "a singleInstance onSecondInstance")?;
    let inner = activation::SingleInstance::acquire(&app_id, &payload_json, move |payload| {
      on_second.call(payload.to_owned());
    })
    .or_throw()?;
    Ok(Self { inner })
  }

  pub fn is_primary(&self) -> bool {
    self.inner.is_primary()
  }

  pub fn handed_off(&self) -> bool {
    self.inner.handed_off()
  }

  /// Primary: releases the lock. Does nothing on a secondary or a second time.
  pub fn dispose(&mut self) {
    self.inner.release();
  }
}
