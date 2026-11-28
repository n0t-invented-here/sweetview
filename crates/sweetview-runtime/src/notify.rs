//! Desktop notifications whose click comes back to the UI thread.
//!
//! A [`Notifier`] lives on the UI thread: its clicks arrive from whichever
//! message loop that thread is in, so they reach JavaScript as callbacks from
//! inside the loop, like every other event. The work is done by
//! `sweetview-platform-notify`; this module makes sure the UI thread is set up
//! for it first and turns its errors into the runtime's.

pub use sweetview_platform_notify::{BalloonEvent, ForcedPath, Notification, NotifierOptions, Shown, ToastEvent};

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use crate::error::{Error, Result};
use crate::runtime::Runtime;
use crate::threads;

/// The platform's notifier, or nothing once it is released.
type Slot = RefCell<Option<sweetview_platform_notify::Notifier>>;

thread_local! {
  /// Every notifier of this thread, so [`release_all`] can release the ones still alive.
  static NOTIFIERS: RefCell<Vec<Weak<Slot>>> = const { RefCell::new(Vec::new()) };
}

/// Shows notifications and reports clicks on them. Not `Send`: it belongs to
/// the UI thread. Dropping it, or [`release_all`], hides its pending toasts
/// and removes its hidden notification icons; after a release it shows nothing.
pub struct Notifier {
  slot: Rc<Slot>,
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
    let slot = Rc::new(RefCell::new(Some(inner)));
    NOTIFIERS.with(|all| {
      let mut all = all.borrow_mut();
      all.retain(|weak| weak.strong_count() > 0);
      all.push(Rc::downgrade(&slot));
    });
    Ok(Notifier { slot })
  }

  /// Runs `f` on the platform's notifier; `None` once it is released.
  fn with<R>(&self, f: impl FnOnce(&sweetview_platform_notify::Notifier) -> R) -> Option<R> {
    self.slot.borrow().as_ref().map(f)
  }

  /// Shows a notification: a toast when WinRT accepts it, else a balloon.
  /// True when either was handed to the OS; false once released.
  pub fn notify(&self, notification: &Notification) -> bool {
    self.with(|n| n.notify(notification)).unwrap_or(false)
  }

  /// [`notify`](Self::notify), reporting which path showed the notification.
  pub fn show(&self, notification: &Notification) -> Option<Shown> {
    self.with(|n| n.show(notification)).flatten()
  }

  /// Replaces the `.ico` the balloon fallback shows. `None` shows the stock
  /// application icon. Invalid bytes are refused and the icon is unchanged.
  pub fn set_icon_ico(&self, icon_ico: Option<Vec<u8>>) -> Result<()> {
    self.with(|n| n.set_icon_ico(icon_ico)).unwrap_or(Ok(())).map_err(|e| Error::Os(e.0))
  }

  /// Whether WinRT toasts are in use (false before the first notification).
  pub fn toasts_available(&self) -> bool {
    self.with(|n| n.toasts_available()).unwrap_or(false)
  }

  /// Test hook: makes later notifications take a failure path.
  pub fn force_path(&self, path: ForcedPath) {
    self.with(|n| n.force_path(path));
  }

  /// Test hook: later toasts show no banner and are removed by the platform after `seconds`; `None`: a banner, no expiry.
  pub fn set_toast_life(&self, seconds: Option<u32>) {
    self.with(|n| n.set_toast_life(seconds));
  }

  /// Test hook: delivers a toast event as WinRT would; it arrives from the loop.
  pub fn simulate_toast_event(&self, cookie: u64, event: ToastEvent) -> bool {
    self.with(|n| n.simulate_toast_event(cookie, event)).unwrap_or(false)
  }

  /// Test hook: posts a balloon event as the shell would; it arrives from the loop.
  pub fn simulate_balloon_event(&self, uid: u32, event: BalloonEvent) -> bool {
    self.with(|n| n.simulate_balloon_event(uid, event)).unwrap_or(false)
  }

  /// Toasts shown that have not reported an event.
  pub fn pending_toasts(&self) -> usize {
    self.with(|n| n.pending_toasts()).unwrap_or(0)
  }

  /// Balloons shown that have not been clicked, timed out or hidden.
  pub fn pending_balloons(&self) -> usize {
    self.with(|n| n.pending_balloons()).unwrap_or(0)
  }

  /// Balloons the shell accepted since the notifier was made, whatever became of them.
  pub fn balloons_shown(&self) -> u32 {
    self.with(|n| n.balloons_shown()).unwrap_or(0)
  }

  /// Lets go of the notifier without withdrawing what it showed: see [`release_all`].
  /// It shows nothing afterwards. Safe to call twice.
  pub fn release(&self) {
    release_slot(&self.slot);
  }
}

fn release_slot(slot: &Slot) {
  // Taken out first and released after the borrow: releasing it destroys its window.
  let taken = slot.try_borrow_mut().ok().and_then(|mut inner| inner.take());
  if let Some(notifier) = taken {
    notifier.release();
  }
}

/// Releases every notifier of this thread that is still alive, at the end of the application:
/// its toasts' handlers end and its window and hidden notification icons go (a balloon with its
/// icon), but the toasts it showed stay on the screen and in the notification centre for the user
/// to read. Only `dispose` withdraws them. A notifier in use further up the stack (its click
/// handler is running) is left as it is.
pub(crate) fn release_all() {
  let slots: Vec<Rc<Slot>> = NOTIFIERS
    .try_with(|all| all.borrow_mut().drain(..).filter_map(|weak| weak.upgrade()).collect())
    .unwrap_or_default();
  for slot in slots {
    release_slot(&slot);
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
