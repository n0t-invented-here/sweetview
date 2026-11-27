//! Desktop notifications whose click comes back to the UI thread.
//!
//! A [`Notifier`] lives on the UI thread: its clicks arrive from whichever
//! message loop that thread is in, so they reach JavaScript as callbacks from
//! inside the loop, like every other event. The work is done by
//! `sweetview-platform-notify`; this module makes sure the UI thread is set up
//! for it first and turns its errors into the runtime's.

pub use sweetview_platform_notify::{BalloonEvent, ForcedPath, Notification, NotifierOptions, Shown, ToastEvent};

use crate::error::{Error, Result};
use crate::runtime::Runtime;
use crate::threads;

/// Shows notifications and reports clicks on them. Not `Send`: it belongs to
/// the UI thread. Dropping it hides its pending toasts and removes its hidden
/// notification icons.
pub struct Notifier {
  inner: sweetview_platform_notify::Notifier,
}

impl Notifier {
  /// Makes a notifier on the UI thread. `on_click(id, data_json)` runs on the
  /// UI thread, from its message loop, once per clicked notification.
  pub fn new(options: NotifierOptions, on_click: impl Fn(&str, Option<&str>) + 'static) -> Result<Notifier> {
    threads::require_ui_thread()?;
    // The runtime's event loop makes the process per-monitor DPI aware before
    // the notifier makes its first window, as `ensureWin32Init` did.
    Runtime::get()?;
    let inner = sweetview_platform_notify::Notifier::new(options, on_click).map_err(|e| Error::Os(e.0))?;
    Ok(Notifier { inner })
  }

  /// Shows a notification: a toast when WinRT accepts it, else a balloon.
  /// True when either was handed to the OS.
  pub fn notify(&self, notification: &Notification) -> bool {
    self.inner.notify(notification)
  }

  /// [`notify`](Self::notify), reporting which path showed the notification.
  pub fn show(&self, notification: &Notification) -> Option<Shown> {
    self.inner.show(notification)
  }

  /// Replaces the `.ico` the balloon fallback shows. `None` shows the stock
  /// application icon. Invalid bytes are refused and the icon is unchanged.
  pub fn set_icon_ico(&self, icon_ico: Option<Vec<u8>>) -> Result<()> {
    self.inner.set_icon_ico(icon_ico).map_err(|e| Error::Os(e.0))
  }

  /// Whether WinRT toasts are in use (false before the first notification).
  pub fn toasts_available(&self) -> bool {
    self.inner.toasts_available()
  }

  /// Test hook: makes later notifications take a failure path.
  pub fn force_path(&self, path: ForcedPath) {
    self.inner.force_path(path);
  }

  /// Test hook: delivers a toast event as WinRT would; it arrives from the loop.
  pub fn simulate_toast_event(&self, cookie: u64, event: ToastEvent) -> bool {
    self.inner.simulate_toast_event(cookie, event)
  }

  /// Test hook: posts a balloon event as the shell would; it arrives from the loop.
  pub fn simulate_balloon_event(&self, uid: u32, event: BalloonEvent) -> bool {
    self.inner.simulate_balloon_event(uid, event)
  }

  /// Toasts shown that have not reported an event.
  pub fn pending_toasts(&self) -> usize {
    self.inner.pending_toasts()
  }

  /// Balloons shown that have not been clicked, timed out or hidden.
  pub fn pending_balloons(&self) -> usize {
    self.inner.pending_balloons()
  }

  /// Balloons the shell accepted since the notifier was made, whatever became of them.
  pub fn balloons_shown(&self) -> u32 {
    self.inner.balloons_shown()
  }
}

/// How many toast event handlers exist in the process; zero once every
/// notifier is gone. A test hook.
pub fn live_toast_handlers() -> usize {
  sweetview_platform_notify::live_toast_handlers()
}

#[cfg(all(test, windows))]
mod tests {
  use std::cell::RefCell;
  use std::rc::Rc;
  use std::time::{Duration, Instant};

  use super::*;
  use crate::runtime::testing::on_ui_thread;

  #[test]
  fn another_thread_is_refused() {
    on_ui_thread(|_runtime| {
      let refused = std::thread::spawn(|| Notifier::new(NotifierOptions::default(), |_, _| {}).err()).join().expect("thread");
      assert_eq!(refused, Some(Error::NotUiThread));
    });
  }

  #[test]
  fn a_balloon_click_arrives_from_the_runtime_loop() {
    on_ui_thread(|runtime| {
      type Clicks = Rc<RefCell<Vec<(String, Option<String>)>>>;
      let clicks: Clicks = Rc::new(RefCell::new(Vec::new()));
      let sink = clicks.clone();
      let notifier = Notifier::new(NotifierOptions::default(), move |id, data| {
        sink.borrow_mut().push((id.to_owned(), data.map(str::to_owned)));
      })
      .expect("notifier");
      notifier.force_path(ForcedPath::BalloonOnly);
      let note = Notification { id: "runtime".into(), title: "Sweetview test".into(), data_json: Some("[1]".into()), silent: true, ..Default::default() };
      let Some(Shown::Balloon(uid)) = notifier.show(&note) else { panic!("balloon") };
      assert!(notifier.simulate_balloon_event(uid, BalloonEvent::Clicked));
      let deadline = Instant::now() + Duration::from_secs(5);
      while clicks.borrow().is_empty() && Instant::now() < deadline {
        runtime.pump();
      }
      assert_eq!(*clicks.borrow(), [("runtime".to_owned(), Some("[1]".to_owned()))]);
      assert_eq!(notifier.pending_balloons(), 0);
    });
  }
}
