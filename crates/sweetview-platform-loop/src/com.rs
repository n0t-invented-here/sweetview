//! The UI thread's COM apartment.
//!
//! WebView2, the folder dialog and the toast notifier need the thread that
//! hosts them to be in a single-threaded apartment. Sweetview's TypeScript
//! entered one before it made its first window; the runtime does it when it
//! starts, so a webview can be mounted in any window the runtime makes.
//!
//! The process also keeps COM itself loaded for as long as it lives, whatever
//! apartments come and go (D49). The `windows` crate caches every agile WinRT
//! activation factory it loads in a process-wide static, for good
//! (`FactoryCache` in `windows-core`): `UISettings` (the system theme),
//! `ToastNotificationManager`. When the last apartment of the process is left,
//! COM unloads the DLLs those factories live in (measured: `Windows.UI.dll` is
//! gone the moment the only STA is left), and the next call through a cached
//! factory runs freed code: an access violation. The process's MTA usage
//! (`CoIncrementMTAUsage`), taken once and never given back, is the documented
//! way to keep COM loaded with no thread in an apartment, and what
//! `windows-core` itself does when it finds COM not initialised.

use std::fmt;
use std::marker::PhantomData;

/// The thread was already in the other kind of apartment, or COM refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComError(pub(crate) String);

impl fmt::Display for ComError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(&self.0)
  }
}

impl std::error::Error for ComError {}

/// This thread's membership of a single-threaded COM apartment, left on drop.
/// Not `Send`: an apartment belongs to the thread that entered it.
pub struct ComApartment {
  _not_send: PhantomData<*const ()>,
}

#[cfg(windows)]
impl ComApartment {
  /// Enters a single-threaded apartment on this thread. Entering again is
  /// counted by COM and left again by the matching drop.
  pub fn enter() -> Result<Self, ComError> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    // SAFETY: no reserved pointer is passed; on success the call is matched by
    // the `CoUninitialize` in this value's `Drop`, on the same thread (the type is not `Send`).
    let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if result == RPC_E_CHANGED_MODE {
      return Err(ComError("sweetview: this thread already initialised COM as multi-threaded; WebView2 needs an STA".into()));
    }
    if result.is_err() {
      return Err(ComError(format!("sweetview: CoInitializeEx failed: HRESULT {:#010x}", result.0)));
    }
    hold_com_for_the_process();
    Ok(Self { _not_send: PhantomData })
  }
}

/// The process's usage of the multi-threaded apartment (`CoIncrementMTAUsage`), which keeps COM
/// loaded in the process while no thread is in an apartment (see the module's header). Its
/// owner is the static in [`hold_com_for_the_process`], and a static is never dropped: the usage
/// is given back when the process ends, by the OS, as the factories it keeps valid are cached for
/// the process by the `windows` crate. `Drop` gives it back should a value ever be dropped.
///
/// Another thread sees this (it is what `CoIncrementMTAUsage` is documented to do): a thread
/// that never initialised COM is in the implicit MTA from then on, so `CoGetApartmentType` there
/// answers `APTTYPE_MTA` with `APTTYPEQUALIFIER_IMPLICIT_MTA` where it answered
/// `CO_E_NOTINITIALIZED`, and COM calls made there work as in the MTA. A thread that enters an
/// apartment of its own is unaffected.
#[cfg(windows)]
struct MtaUsage {
  /// The `CO_MTA_USAGE_COOKIE`'s value: an opaque number COM gave, passed back only to
  /// `CoDecrementMTAUsage`, never dereferenced.
  cookie: usize,
}

#[cfg(windows)]
impl Drop for MtaUsage {
  fn drop(&mut self) {
    let cookie = windows::Win32::System::Com::CO_MTA_USAGE_COOKIE(self.cookie as *mut std::ffi::c_void);
    // SAFETY: one call: the cookie is the one `CoIncrementMTAUsage` returned when this value was
    // made, and this value gives it back once, here.
    let _given_back = unsafe { windows::Win32::System::Com::CoDecrementMTAUsage(cookie) };
  }
}

/// Keeps COM loaded in this process until it ends, once, so no factory the `windows` crate has
/// cached outlives the DLL it lives in (see the module's header): the one owner of the hold, for
/// every crate of the project, called before each WinRT use (`ComApartment::enter`, the system
/// theme and double-click time of `sweetview-platform-window`, the toasts of
/// `sweetview-platform-notify`). A failure leaves COM as it was: the process then depends, as
/// before, on an apartment staying entered.
#[cfg(windows)]
pub fn hold_com_for_the_process() {
  static HELD: std::sync::OnceLock<Option<MtaUsage>> = std::sync::OnceLock::new();
  HELD.get_or_init(|| {
    // SAFETY: one call with no arguments; the cookie it returns is owned by the `MtaUsage` made
    // from it, kept in this static for the rest of the process.
    let cookie = unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() }.ok()?;
    Some(MtaUsage { cookie: cookie.0 as usize })
  });
}

#[cfg(windows)]
impl Drop for ComApartment {
  fn drop(&mut self) {
    // SAFETY: this value exists only after a successful `CoInitializeEx` on this
    // thread, and each value leaves exactly once.
    unsafe { windows::Win32::System::Com::CoUninitialize() };
  }
}

/// No COM on this platform: there is nothing to hold.
#[cfg(not(windows))]
pub fn hold_com_for_the_process() {}

#[cfg(not(windows))]
impl ComApartment {
  /// No COM on this platform: there is nothing to enter.
  pub fn enter() -> Result<Self, ComError> {
    Ok(Self { _not_send: PhantomData })
  }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  #[test]
  fn entering_twice_and_leaving_is_balanced() {
    let outer = ComApartment::enter().expect("an STA");
    let inner = ComApartment::enter().expect("entered again");
    drop(inner);
    drop(outer);
    // A thread that chose the multi-threaded apartment is refused.
    let refused = std::thread::spawn(|| {
      use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
      // SAFETY: enters the multi-threaded apartment on this test thread; left below.
      let mta = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
      let refused = ComApartment::enter().err();
      if mta.is_ok() {
        // SAFETY: matches the successful `CoInitializeEx` above, on the same thread.
        unsafe { CoUninitialize() };
      }
      refused
    })
    .join()
    .expect("thread");
    assert!(refused.is_some_and(|e| e.0.contains("multi-threaded")));
  }

  /// R4 of D49's first review: what the process's MTA usage changes for another thread, as
  /// `CoIncrementMTAUsage` is documented to: once an apartment has been entered, a thread that
  /// never initialised COM reads as in the implicit MTA, where it read as not initialised.
  #[test]
  fn once_an_apartment_is_entered_a_thread_with_no_com_of_its_own_is_in_the_implicit_mta() {
    use windows::Win32::System::Com::{CoGetApartmentType, APTTYPE, APTTYPEQUALIFIER, APTTYPEQUALIFIER_IMPLICIT_MTA, APTTYPE_MTA};
    drop(ComApartment::enter().expect("an STA"));
    let read = std::thread::spawn(|| {
      let (mut kind, mut qualifier) = (APTTYPE::default(), APTTYPEQUALIFIER::default());
      // SAFETY: one call; both out-pointers are to locals of this frame, written for the call.
      let result = unsafe { CoGetApartmentType(&mut kind, &mut qualifier) };
      (result.is_ok(), kind, qualifier)
    })
    .join()
    .expect("thread");
    assert_eq!(read, (true, APTTYPE_MTA, APTTYPEQUALIFIER_IMPLICIT_MTA));
  }

  #[test]
  fn entering_and_leaving_returns_every_handle() {
    let _serial = crate::TEST_SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // On a thread of its own, so the first enter really initialises COM and the last drop
    // really uninitialises it, in every round.
    std::thread::spawn(|| {
      crate::testing::assert_gives_back_every_handle(100, || {
        let outer = ComApartment::enter().expect("an STA");
        let inner = ComApartment::enter().expect("entered again");
        drop(inner);
        drop(outer);
      })
    })
    .join()
    .expect("every count returned to its starting value");
  }
}
