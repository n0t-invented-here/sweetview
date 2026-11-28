//! Desktop notifications: the `Notifier` class, its test hooks, and the
//! conversions between JavaScript values and the runtime's notifier.

use napi::bindgen_prelude::{FnArgs, Function};
use napi::Env;
use sweetview_runtime::notify::{self, BalloonEvent, ForcedPath, Notification, NotifierOptions, Shown, ToastEvent};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// The click handler: `(id, dataJson) => void`.
pub type ClickHandler<'a> = Function<'a, FnArgs<(String, Option<String>)>, ()>;

/// A notifier, or nothing once disposed.
pub struct Notifier {
  inner: Option<notify::Notifier>,
}

impl Notifier {
  /// Makes a notifier on the UI thread. `appId` and `appName` are the toast
  /// identity (`null` uses today's defaults); `iconIco` is the `.ico` the
  /// balloon fallback shows (`null`: the stock application icon).
  pub fn new(
    env: Env,
    app_id: Option<String>,
    app_name: Option<String>,
    icon_ico: Option<Vec<u8>>,
    on_click: Option<ClickHandler<'_>>,
  ) -> napi::Result<Self> {
    let on_click = on_click.map(|f| JsCallback::new(env, &f, "a notification onClick")).transpose()?;
    let options = NotifierOptions { app_id, app_name, icon_ico };
    let inner = notify::Notifier::new(options, move |id, data| {
      if let Some(on_click) = &on_click {
        on_click.call((id.to_owned(), data.map(str::to_owned)).into());
      }
    })
    .or_throw()?;
    Ok(Self { inner: Some(inner) })
  }

  /// Shows a notification. True when it was handed to the OS; false once disposed.
  pub fn notify(&self, id: String, title: String, body: String, silent: bool, data_json: Option<String>) -> bool {
    self.inner.as_ref().is_some_and(|n| n.notify(&Notification { id, title, body, silent, data_json }))
  }

  /// Replaces the `.ico` the balloon fallback shows. Throws on bytes that are not an icon.
  pub fn set_icon(&self, icon_ico: Option<Vec<u8>>) -> napi::Result<()> {
    match &self.inner {
      Some(n) => n.set_icon_ico(icon_ico).or_throw(),
      None => Ok(()),
    }
  }

  /// Releases the notifier: hides its pending toasts and removes its hidden icons. Safe to call twice.
  pub fn dispose(&mut self) {
    self.inner.take();
  }

  /// Lets go of the notifier as `dispose` does but leaves the toasts it showed for the user:
  /// what the end of the application does. Safe to call twice, and after `dispose`.
  pub fn release(&mut self) {
    if let Some(notifier) = self.inner.take() {
      notifier.release();
    }
  }

  // ---- test hooks ---------------------------------------------------------------

  /// Test hook: `"auto"`, `"balloonOnly"` (as if WinRT were unavailable),
  /// `"toastShowFails"` (as if `IToastNotifier.Show` failed) or `"toastHeld"`
  /// (toasts are built and subscribed but not handed to the platform, so only
  /// simulated events arrive).
  pub fn debug_force_path(&self, path: String) -> napi::Result<()> {
    let path = match path.as_str() {
      "auto" => ForcedPath::Auto,
      "balloonOnly" => ForcedPath::BalloonOnly,
      "toastShowFails" => ForcedPath::ToastShowFails,
      "toastHeld" => ForcedPath::ToastHeld,
      other => return Err(napi::Error::from_reason(format!("sweetview: unknown notifier path {other:?}"))),
    };
    if let Some(n) = &self.inner {
      n.force_path(path);
    }
    Ok(())
  }

  /// Test hook: `notify` reporting the path: `"toast:<cookie>"`, `"balloon:<uid>"`, or `null`.
  pub fn debug_show(&self, id: String, title: String, body: String, silent: bool, data_json: Option<String>) -> Option<String> {
    let shown = self.inner.as_ref()?.show(&Notification { id, title, body, silent, data_json })?;
    Some(match shown {
      Shown::Toast(cookie) => format!("toast:{cookie}"),
      Shown::Balloon(uid) => format!("balloon:{uid}"),
    })
  }

  /// Test hook: invokes the handler WinRT holds for a toast's `"dismissed"`,
  /// `"activated"` or `"failed"` event. The event arrives from the loop.
  pub fn debug_simulate_toast_event(&self, cookie: u32, event: String) -> napi::Result<bool> {
    let event = match event.as_str() {
      "dismissed" => ToastEvent::Dismissed,
      "activated" => ToastEvent::Activated,
      "failed" => ToastEvent::Failed,
      other => return Err(napi::Error::from_reason(format!("sweetview: unknown toast event {other:?}"))),
    };
    Ok(self.inner.as_ref().is_some_and(|n| n.simulate_toast_event(u64::from(cookie), event)))
  }

  /// Test hook: posts a balloon's `"clicked"`, `"timedOut"` or `"hidden"`
  /// event as the shell would. The event arrives from the loop.
  pub fn debug_simulate_balloon_event(&self, uid: u32, event: String) -> napi::Result<bool> {
    let event = match event.as_str() {
      "clicked" => BalloonEvent::Clicked,
      "timedOut" => BalloonEvent::TimedOut,
      "hidden" => BalloonEvent::Hidden,
      other => return Err(napi::Error::from_reason(format!("sweetview: unknown balloon event {other:?}"))),
    };
    Ok(self.inner.as_ref().is_some_and(|n| n.simulate_balloon_event(uid, event)))
  }

  /// Test hook: toasts shown that have not reported an event.
  pub fn debug_pending_toasts(&self) -> u32 {
    self.inner.as_ref().map_or(0, |n| n.pending_toasts() as u32)
  }

  /// Test hook: balloons shown that have not been clicked, timed out or hidden.
  pub fn debug_pending_balloons(&self) -> u32 {
    self.inner.as_ref().map_or(0, |n| n.pending_balloons() as u32)
  }

  /// Test hook: later toasts show no banner and are removed by the platform after `seconds`
  /// (0: a banner and no expiry, as applications get), so a test run leaves no toast on the
  /// screen or in the notification centre.
  pub fn debug_set_toast_life(&self, seconds: u32) {
    if let Some(n) = &self.inner {
      n.set_toast_life((seconds > 0).then_some(seconds));
    }
  }

  /// Test hook: balloons the shell accepted since the notifier was made.
  pub fn debug_balloons_shown(&self) -> u32 {
    self.inner.as_ref().map_or(0, notify::Notifier::balloons_shown)
  }

  /// Test hook: whether WinRT toasts are in use.
  pub fn debug_toasts_available(&self) -> bool {
    self.inner.as_ref().is_some_and(notify::Notifier::toasts_available)
  }
}

/// Test hook: toast event handlers alive in the process; zero once every notifier is disposed.
pub fn debug_live_toast_handlers() -> u32 {
  notify::live_toast_handlers() as u32
}
