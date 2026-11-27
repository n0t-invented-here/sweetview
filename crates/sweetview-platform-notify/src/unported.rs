//! Platforms whose goal has not built the notifier yet.
//!
//! The types exist so shared code compiles; making a notifier reports that the
//! platform is not ported. The macOS goal replaces this file's use on macOS.

use std::marker::PhantomData;

use crate::{BalloonEvent, ForcedPath, Notification, NotifierOptions, NotifyError, Shown, ToastEvent};

/// See the Windows implementation for the contract.
pub fn live_toast_handlers() -> usize {
  0
}

/// See the Windows implementation for the contract.
pub struct Notifier {
  _not_send: PhantomData<*const ()>,
}

impl Notifier {
  pub fn new(_options: NotifierOptions, _on_click: impl Fn(&str, Option<&str>) + 'static) -> Result<Notifier, NotifyError> {
    Err(NotifyError("sweetview: notifications are not ported to this platform yet".into()))
  }

  pub fn notify(&self, _notification: &Notification) -> bool {
    false
  }

  pub fn show(&self, _notification: &Notification) -> Option<Shown> {
    None
  }

  pub fn set_icon_ico(&self, _icon_ico: Option<Vec<u8>>) -> Result<(), NotifyError> {
    Ok(())
  }

  pub fn toasts_available(&self) -> bool {
    false
  }

  pub fn force_path(&self, _path: ForcedPath) {}

  pub fn simulate_toast_event(&self, _cookie: u64, _event: ToastEvent) -> bool {
    false
  }

  pub fn simulate_balloon_event(&self, _uid: u32, _event: BalloonEvent) -> bool {
    false
  }

  pub fn pending_toasts(&self) -> usize {
    0
  }

  pub fn pending_balloons(&self) -> usize {
    0
  }
}
