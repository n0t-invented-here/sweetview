//! Exports of `sweetview_napi::notify`.

use napi::bindgen_prelude::{FnArgs, Function, Uint8Array};
use napi::Env;
use napi_derive::napi;
use sweetview_napi::notify as imp;

/// Shows desktop notifications and reports clicks on them, on the UI thread.
/// Windows: WinRT toasts, with a balloon on a hidden notification icon of its own as the fallback.
#[napi]
pub struct Notifier {
  inner: imp::Notifier,
}

#[napi]
impl Notifier {
  /// `appId`/`appName`: the toast identity (`null` uses `Sweetview.DesktopApp`); `iconIco`: the
  /// `.ico` the balloon shows (`null`: the stock icon); `onClick(id, dataJson)` runs on the UI thread.
  #[napi(constructor)]
  pub fn new(
    env: Env,
    app_id: Option<String>,
    app_name: Option<String>,
    icon_ico: Option<Uint8Array>,
    on_click: Option<Function<'_, FnArgs<(String, Option<String>)>, ()>>,
  ) -> napi::Result<Self> {
    Ok(Self { inner: imp::Notifier::new(env, app_id, app_name, icon_ico.map(|b| b.to_vec()), on_click)? })
  }

  /// Shows a notification. True when it was handed to the OS; false once disposed.
  #[napi]
  pub fn notify(&self, id: String, title: String, body: String, silent: bool, data_json: Option<String>) -> bool {
    self.inner.notify(id, title, body, silent, data_json)
  }

  /// Replaces the `.ico` the balloon fallback shows. Throws on bytes that are not an icon.
  #[napi]
  pub fn set_icon(&self, icon_ico: Option<Uint8Array>) -> napi::Result<()> {
    self.inner.set_icon(icon_ico.map(|b| b.to_vec()))
  }

  /// Releases the notifier. Safe to call twice.
  #[napi]
  pub fn dispose(&mut self) {
    self.inner.dispose()
  }

  /// Test hook: `"auto"`, `"balloonOnly"` or `"toastShowFails"`.
  #[napi]
  pub fn debug_force_path(&self, path: String) -> napi::Result<()> {
    self.inner.debug_force_path(path)
  }

  /// Test hook: `notify`, reporting `"toast:<cookie>"`, `"balloon:<uid>"` or `null`.
  #[napi]
  pub fn debug_show(&self, id: String, title: String, body: String, silent: bool, data_json: Option<String>) -> Option<String> {
    self.inner.debug_show(id, title, body, silent, data_json)
  }

  /// Test hook: a toast's `"dismissed"`, `"activated"` or `"failed"` event, through the handler WinRT holds.
  #[napi]
  pub fn debug_simulate_toast_event(&self, cookie: u32, event: String) -> napi::Result<bool> {
    self.inner.debug_simulate_toast_event(cookie, event)
  }

  /// Test hook: a balloon's `"clicked"`, `"timedOut"` or `"hidden"` event, posted as the shell would.
  #[napi]
  pub fn debug_simulate_balloon_event(&self, uid: u32, event: String) -> napi::Result<bool> {
    self.inner.debug_simulate_balloon_event(uid, event)
  }

  /// Test hook: toasts shown that have not reported an event.
  #[napi]
  pub fn debug_pending_toasts(&self) -> u32 {
    self.inner.debug_pending_toasts()
  }

  /// Test hook: balloons shown that have not been clicked, timed out or hidden.
  #[napi]
  pub fn debug_pending_balloons(&self) -> u32 {
    self.inner.debug_pending_balloons()
  }

  /// Test hook: whether WinRT toasts are in use.
  #[napi]
  pub fn debug_toasts_available(&self) -> bool {
    self.inner.debug_toasts_available()
  }
}

/// Test hook: toast event handlers alive in the process; zero once every notifier is disposed.
#[napi]
pub fn debug_live_toast_handlers() -> u32 {
  imp::debug_live_toast_handlers()
}
