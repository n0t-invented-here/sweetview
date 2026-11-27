//! The UI thread's COM apartment.
//!
//! WebView2, the folder dialog and the toast notifier need the thread that
//! hosts them to be in a single-threaded apartment. Sweetview's TypeScript
//! entered one before it made its first window; the runtime does it when it
//! starts, so a webview can be mounted in any window the runtime makes.

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
    Ok(Self { _not_send: PhantomData })
  }
}

#[cfg(windows)]
impl Drop for ComApartment {
  fn drop(&mut self) {
    // SAFETY: this value exists only after a successful `CoInitializeEx` on this
    // thread, and each value leaves exactly once.
    unsafe { windows::Win32::System::Com::CoUninitialize() };
  }
}

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
}
