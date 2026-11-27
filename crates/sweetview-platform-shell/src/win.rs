//! Owning types and helpers for the Windows resources the modules share:
//! kernel handles and registry values. Message-only windows are
//! `sweetview-platform-loop`'s `MessageWindow`; registry keys are
//! `windows-registry`'s `Key`, which closes itself.

use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;
use windows_registry::CURRENT_USER;

use crate::ShellError;

/// The calling thread's last OS error, as today's messages print it.
pub(crate) fn last_error() -> i32 {
  std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// The Win32 error code a registry call failed with, as today's messages print it.
pub(crate) fn registry_code(error: &windows::core::Error) -> u32 {
  (error.code().0 as u32) & 0xffff
}

/// A kernel handle this value owns and closes. The field is private to this
/// module, and the only way to make one is the OS call that opens the handle
/// ([`OwnedHandle::named_mutex`]), so no other code can wrap a handle it does not own.
pub(crate) struct OwnedHandle(HANDLE);

impl OwnedHandle {
  /// Opens the named mutex `name` (`CreateMutexW`, not taken, default
  /// security), creating it when no process has. Also returns whether it
  /// existed already. The error is the Win32 error code.
  pub(crate) fn named_mutex(name: &HSTRING) -> Result<(Self, bool), i32> {
    // SAFETY: `name` is a NUL-terminated wide string that outlives the call; no security
    // attributes are passed and the mutex is not taken.
    let created = unsafe { CreateMutexW(None, false, name) };
    // Read before anything else can overwrite the thread's last error.
    let error = last_error();
    let handle = created.map_err(|_| error)?;
    Ok((Self(handle), error == ERROR_ALREADY_EXISTS.0 as i32))
  }
}

impl Drop for OwnedHandle {
  fn drop(&mut self) {
    // SAFETY: `self.0` was returned to this value alone by the call that opened it (the
    // only constructor, `named_mutex`) and is not used again.
    let closed = unsafe { CloseHandle(self.0) };
    let _ = closed;
  }
}

/// Writes one `REG_SZ` value under `HKCU\<sub_key>`, creating the key, as
/// today's `setRegString` does. `None` names the key's default value.
pub(crate) fn set_reg_string(sub_key: &str, value_name: Option<&str>, data: &str) -> Result<(), ShellError> {
  // Write access only, as today; the key is created when missing and closed when `key` drops.
  let key = CURRENT_USER.options().write().create().open(sub_key);
  let key = key.map_err(|e| ShellError(format!("sweetview: RegCreateKeyExW({sub_key}) failed ({})", registry_code(&e))))?;
  // An empty name is the key's default value, as a null one is.
  key.set_string(value_name.unwrap_or(""), data).map_err(|e| {
    ShellError(format!("sweetview: RegSetValueExW({sub_key}, {}) failed ({})", value_name.unwrap_or("(Default)"), registry_code(&e)))
  })
}

#[cfg(test)]
pub(crate) mod test_support {
  use std::time::{Duration, Instant};

  pub(crate) use sweetview_platform_loop::dispatch_waiting as pump;

  /// Pumps until `done` or the deadline.
  pub(crate) fn pump_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
      pump();
      if done() {
        return true;
      }
      if Instant::now() > deadline {
        return false;
      }
      std::thread::sleep(Duration::from_millis(5));
    }
  }
}
