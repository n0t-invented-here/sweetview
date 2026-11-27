//! Owning types and helpers for the Windows resources the modules share:
//! kernel handles and registry values. Message-only windows are
//! `sweetview-platform-loop`'s `MessageWindow`; registry keys are
//! `windows-registry`'s `Key`, which closes itself.

use windows::Win32::Foundation::{CloseHandle, HANDLE};
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

/// A kernel handle this value owns and closes.
pub(crate) struct OwnedHandle(pub(crate) HANDLE);

impl Drop for OwnedHandle {
  fn drop(&mut self) {
    // SAFETY: `self.0` was returned to this value alone by the call that opened it and is
    // not used again.
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

  /// USER objects, GDI objects and kernel handles of this process.
  pub(crate) fn counts() -> (u32, u32, u32) {
    let counts = sweetview_platform_loop::resource_counts();
    (counts.user_objects, counts.gdi_objects, counts.kernel_handles)
  }
}
