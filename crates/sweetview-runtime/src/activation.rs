//! Custom URL schemes and the single-instance lock.
//!
//! The work is done by `sweetview-platform-shell`, with today's names, limits
//! and wire format, so an application built before the rewrite and one built
//! after it hand off to each other. Its errors carry today's messages.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use sweetview_platform_shell::{single_instance, url_scheme};

pub use sweetview_platform_shell::url_scheme::Registration;

use crate::error::{Error, Result};
use crate::runtime::Runtime;
use crate::threads;

/// Registers `scheme` for the current user (Windows: under
/// `HKCU\Software\Classes`). The scheme is validated and normalised first.
/// Callable from any thread.
pub fn register_url_scheme(scheme: &str, registration: &Registration) -> Result<()> {
  url_scheme::register(scheme, registration).map_err(|e| Error::Os(e.0))
}

/// Removes the current user's registration of `scheme`; removing one that is
/// not registered succeeds. Callable from any thread.
pub fn unregister_url_scheme(scheme: &str) -> Result<()> {
  url_scheme::unregister(scheme).map_err(|e| Error::Os(e.0))
}

/// The primary's lock, or nothing once it is released.
type Lock = RefCell<Option<single_instance::SingleInstance>>;

thread_local! {
  /// Every primary's lock on this thread, so [`release_all`] can release the ones still held.
  static LOCKS: RefCell<Vec<Weak<Lock>>> = const { RefCell::new(Vec::new()) };
}

/// The primary's hold on an application id, or a secondary's result.
/// Not `Send`: the primary's window belongs to the UI thread.
pub struct SingleInstance {
  lock: Rc<Lock>,
  primary: bool,
  handed_off: bool,
}

impl SingleInstance {
  /// Takes the lock for `app_id`, or hands `payload_json` to the instance
  /// that holds it. On the primary, `on_second(payload_json)` runs on the UI
  /// thread, from its message loop, once per later launch. A secondary
  /// returns after at most 10 lookups 25 ms apart and a 5000 ms send.
  pub fn acquire(app_id: &str, payload_json: &str, on_second: impl Fn(&str) + 'static) -> Result<SingleInstance> {
    threads::require_ui_thread()?;
    // The runtime's event loop makes the process per-monitor DPI aware before
    // the primary makes its window, as `ensureWin32Init` did.
    Runtime::get()?;
    match single_instance::acquire(app_id, payload_json, on_second).map_err(|e| Error::Os(e.0))? {
      single_instance::Acquired::Primary(lock) => {
        let lock = Rc::new(RefCell::new(Some(lock)));
        LOCKS.with(|all| {
          let mut all = all.borrow_mut();
          all.retain(|weak| weak.strong_count() > 0);
          all.push(Rc::downgrade(&lock));
        });
        Ok(SingleInstance { lock, primary: true, handed_off: false })
      }
      single_instance::Acquired::Secondary { handed_off } => Ok(SingleInstance { lock: Rc::new(RefCell::new(None)), primary: false, handed_off }),
    }
  }

  /// Whether this process holds the lock.
  pub fn is_primary(&self) -> bool {
    self.primary
  }

  /// Secondary only: the payload was delivered over the native transport.
  pub fn handed_off(&self) -> bool {
    self.handed_off
  }

  /// Primary: releases the lock and its window, so a later launch becomes the
  /// primary. Does nothing on a secondary or a second time.
  pub fn release(&mut self) {
    release_lock(&self.lock);
  }
}

fn release_lock(lock: &Lock) {
  // Taken out first and dropped after the borrow: dropping it destroys its window.
  let taken = lock.try_borrow_mut().ok().and_then(|mut held| held.take());
  drop(taken);
}

/// Releases every single-instance lock this thread still holds, as
/// [`SingleInstance::release`] does, so a later launch becomes the primary.
pub(crate) fn release_all() {
  let locks: Vec<Rc<Lock>> = LOCKS.try_with(|all| all.borrow_mut().drain(..).filter_map(|weak| weak.upgrade()).collect()).unwrap_or_default();
  for lock in locks {
    release_lock(&lock);
  }
}

#[cfg(all(test, windows))]
mod tests {
  use std::cell::RefCell;
  use std::rc::Rc;

  use super::*;
  use crate::runtime::testing::on_ui_thread;

  fn unique_app_id() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("dev.sweetview.runtime-test-{}-{nanos}", std::process::id())
  }

  #[test]
  fn another_thread_is_refused_but_schemes_are_validated_anywhere() {
    on_ui_thread(|_runtime| {
      let (refused, scheme) = std::thread::spawn(|| {
        let refused = SingleInstance::acquire("dev.sweetview.x", "{}", |_| {}).err();
        let scheme = register_url_scheme("123bad scheme!", &Registration::for_executable("x", "y")).err();
        (refused, scheme)
      })
      .join()
      .expect("thread");
      assert_eq!(refused, Some(Error::NotUiThread));
      assert_eq!(
        scheme,
        Some(Error::Os("sweetview: invalid URL scheme \"123bad scheme!\" (must match /^[a-z][a-z0-9+.-]*$/i)".into()))
      );
    });
  }

  #[test]
  fn a_second_acquisition_hands_off_and_release_frees_the_id() {
    on_ui_thread(|_runtime| {
      let app_id = unique_app_id();
      let received: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
      let sink = received.clone();
      let payload = r#"{"args":["--first"],"cwd":"C:\\"}"#;
      let mut primary = SingleInstance::acquire(&app_id, payload, move |p| sink.borrow_mut().push(p.to_owned())).expect("primary");
      assert!(primary.is_primary());
      assert!(!primary.handed_off());
      let sent = r#"{"args":["--second"],"cwd":"C:\\"}"#;
      let mut secondary = SingleInstance::acquire(&app_id, sent, |_| panic!("a secondary never receives")).expect("secondary");
      assert!(!secondary.is_primary());
      assert!(secondary.handed_off());
      assert_eq!(*received.borrow(), [sent.to_owned()]);
      secondary.release();
      primary.release();
      primary.release();
      let again = SingleInstance::acquire(&app_id, payload, |_| {}).expect("again");
      assert!(again.is_primary());
      assert_eq!(
        SingleInstance::acquire("", "{}", |_| {}).err(),
        Some(Error::Os("sweetview: singleInstance requires appId or identity".into()))
      );
    });
  }
}
