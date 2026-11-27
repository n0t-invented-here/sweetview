//! Owning types for the Windows resources the modules share: kernel handles,
//! registry keys and message-only windows.

use std::marker::PhantomData;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_CLASS_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::{
  RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSEXW,
  WNDPROC,
};

use crate::ShellError;

/// The calling thread's last OS error, as today's messages print it.
pub(crate) fn last_error() -> i32 {
  std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
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

/// A registry key under `HKEY_CURRENT_USER` this value created or opened, and closes.
struct OwnedKey(HKEY);

impl OwnedKey {
  fn create(sub_key: &str) -> Result<Self, ShellError> {
    let name = HSTRING::from(sub_key);
    let mut key = HKEY::default();
    // SAFETY: `name` is a NUL-terminated wide string that outlives the call, and `key` is a
    // valid HKEY for the call to fill; no class, security attributes or disposition are passed.
    let status = unsafe {
      RegCreateKeyExW(HKEY_CURRENT_USER, &name, None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut key, None)
    };
    if status != ERROR_SUCCESS {
      return Err(ShellError(format!("sweetview: RegCreateKeyExW({sub_key}) failed ({})", status.0)));
    }
    Ok(Self(key))
  }
}

impl Drop for OwnedKey {
  fn drop(&mut self) {
    // SAFETY: `self.0` was opened by `create` for this value alone and is not used again.
    let closed = unsafe { RegCloseKey(self.0) };
    let _ = closed;
  }
}

/// Writes one `REG_SZ` value under `HKCU\<sub_key>`, creating the key, as
/// today's `setRegString` does. `None` names the key's default value.
pub(crate) fn set_reg_string(sub_key: &str, value_name: Option<&str>, data: &str) -> Result<(), ShellError> {
  let key = OwnedKey::create(sub_key)?;
  let name = value_name.map(HSTRING::from);
  let name_ptr = name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
  let bytes: Vec<u8> = data.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
  // SAFETY: `key` is open for the call's duration, `name_ptr` is null or points into `name`,
  // which outlives the call, and the data is a slice whose length the call takes from the slice.
  let status = unsafe { RegSetValueExW(key.0, name_ptr, None, REG_SZ, Some(&bytes)) };
  if status != ERROR_SUCCESS {
    return Err(ShellError(format!("sweetview: RegSetValueExW({sub_key}, {}) failed ({})", value_name.unwrap_or("(Default)"), status.0)));
  }
  Ok(())
}

/// A message-only window this value created on this thread and destroys.
pub(crate) struct MessageWindow {
  hwnd: HWND,
  _not_send: PhantomData<*const ()>,
}

impl MessageWindow {
  /// Registers `class_name` with `procedure` (once per process; a second
  /// registration's "class already exists" is the state wanted) and makes a
  /// window of it.
  pub(crate) fn new(class_name: &HSTRING, title: &HSTRING, procedure: WNDPROC) -> Result<Self, ShellError> {
    // SAFETY: a null module name asks for the handle of the process's own executable; no pointer is passed.
    let module = unsafe { GetModuleHandleW(None) }.map_err(|e| ShellError(format!("sweetview: GetModuleHandleW failed ({})", e.code().0)))?;
    let class = WNDCLASSEXW {
      cbSize: size_of::<WNDCLASSEXW>() as u32,
      lpfnWndProc: procedure,
      hInstance: module.into(),
      lpszClassName: PCWSTR(class_name.as_ptr()),
      ..Default::default()
    };
    // SAFETY: `class` is a fully initialised WNDCLASSEXW, and the class name it points to is
    // `class_name`, which outlives the call; the system copies the name.
    let atom = unsafe { RegisterClassExW(&class) };
    if atom == 0 {
      let error = last_error();
      if error != ERROR_CLASS_ALREADY_EXISTS.0 as i32 {
        return Err(ShellError(format!("sweetview: RegisterClassExW({class_name}) failed ({error})")));
      }
    }
    // SAFETY: the class and window names outlive the call, no creation parameter is passed,
    // and HWND_MESSAGE makes a message-only window with no parent to keep alive.
    let created = unsafe {
      CreateWindowExW(
        WINDOW_EX_STYLE(0),
        class_name,
        title,
        WINDOW_STYLE(0),
        0,
        0,
        0,
        0,
        Some(HWND_MESSAGE),
        None,
        Some(module.into()),
        None,
      )
    };
    let hwnd = created.map_err(|_| ShellError(format!("sweetview: CreateWindowExW({class_name}) failed ({})", last_error())))?;
    Ok(Self { hwnd, _not_send: PhantomData })
  }

  pub(crate) fn hwnd(&self) -> HWND {
    self.hwnd
  }
}

impl Drop for MessageWindow {
  fn drop(&mut self) {
    // SAFETY: `self.hwnd` was created by `new` on this thread (the type is not `Send`), is
    // owned by this value alone, and is not used again after this call.
    let destroyed = unsafe { DestroyWindow(self.hwnd) };
    let _ = destroyed;
  }
}

/// A window procedure that handles nothing itself. Called by the OS; it makes
/// one OS call and cannot panic.
pub(crate) extern "system" fn default_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  // SAFETY: the arguments are the ones the OS passed to this window procedure for this message.
  unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
pub(crate) mod test_support {
  use std::time::{Duration, Instant};

  use windows::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GetProcessHandleCount, GR_GDIOBJECTS, GR_USEROBJECTS};
  use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, MSG, PM_REMOVE};

  /// Dispatches this thread's queued and sent messages.
  pub(crate) fn pump() {
    let mut message = MSG::default();
    // SAFETY: `message` is a valid MSG for the call to fill.
    while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
      // SAFETY: `message` was filled by PeekMessageW just above.
      unsafe { DispatchMessageW(&message) };
    }
  }

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
    // SAFETY: the pseudo-handle of the current process is always valid.
    let process = unsafe { GetCurrentProcess() };
    // SAFETY: `process` is the current process's pseudo-handle.
    let user = unsafe { GetGuiResources(process, GR_USEROBJECTS) };
    // SAFETY: `process` is the current process's pseudo-handle.
    let gdi = unsafe { GetGuiResources(process, GR_GDIOBJECTS) };
    let mut kernel = 0u32;
    // SAFETY: `kernel` is a valid u32 for the call to fill.
    unsafe { GetProcessHandleCount(process, &mut kernel) }.expect("GetProcessHandleCount");
    (user, gdi, kernel)
  }
}
