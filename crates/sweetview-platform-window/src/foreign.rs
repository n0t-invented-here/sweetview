//! A window this process did not create through Sweetview.
//!
//! Applications hand Sweetview the handle of a window of their own
//! (`Window.fromHandle`, or the window a webview is mounted into). The handle
//! arrives as a number. [`ForeignWindow`] is the one place that number becomes
//! a window handle: it is checked when the value is taken, and every later use
//! goes through this type.

use std::marker::PhantomData;
use std::num::NonZeroIsize;

use raw_window_handle::{HandleError, HasWindowHandle, WindowHandle};

/// A top-level or child window owned by someone else, on this thread.
///
/// The owner may destroy the window at any time, so nothing here assumes it is
/// still alive: each OS call on it fails cleanly when it is gone.
///
/// Not `Send` and not `Sync`: a window belongs to the thread that made it, and
/// Sweetview uses it from the UI thread only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForeignWindow {
  value: NonZeroIsize,
  _not_send: PhantomData<*const ()>,
}

impl ForeignWindow {
  /// Takes a handle value. `None` when it is zero or names no window.
  pub fn from_handle_value(value: isize) -> Option<Self> {
    let value = NonZeroIsize::new(value)?;
    platform::is_window(value).then_some(Self { value, _not_send: PhantomData })
  }

  /// The handle value, as it was given.
  pub fn handle_value(&self) -> isize {
    self.value.get()
  }

  /// True while the window still exists.
  pub fn is_alive(&self) -> bool {
    platform::is_window(self.value)
  }

  /// Sets the window's title text. Does nothing when the window is gone.
  pub fn set_title(&self, title: &str) {
    platform::set_title(self.value, title);
  }
}

impl HasWindowHandle for ForeignWindow {
  fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
    if !self.is_alive() {
      return Err(HandleError::Unavailable);
    }
    let raw = platform::raw_handle(self.value);
    // SAFETY: `self.value` named a live window a moment ago (`is_alive`), and the borrow
    // lasts no longer than `self`. The window's owner can still destroy it on this thread
    // while the borrow is held; the consumers of this handle (the webview's creation) make
    // OS calls that fail on a destroyed window and dereference nothing through the handle.
    Ok(unsafe { WindowHandle::borrow_raw(raw) })
  }
}

#[cfg(windows)]
mod platform {
  use std::num::NonZeroIsize;

  use raw_window_handle::{RawWindowHandle, Win32WindowHandle};
  use windows::core::HSTRING;
  use windows::Win32::Foundation::HWND;
  use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetWindowTextW};

  fn hwnd(value: NonZeroIsize) -> HWND {
    HWND(value.get() as *mut core::ffi::c_void)
  }

  pub(super) fn is_window(value: NonZeroIsize) -> bool {
    // SAFETY: IsWindow accepts any value and only reports whether it names a window.
    unsafe { IsWindow(Some(hwnd(value))) }.as_bool()
  }

  pub(super) fn set_title(value: NonZeroIsize, title: &str) {
    let title = HSTRING::from(title);
    // SAFETY: `title` is an owned, NUL-terminated wide string that outlives the call; a
    // handle that no longer names a window makes the call fail and changes nothing.
    let set = unsafe { SetWindowTextW(hwnd(value), &title) };
    // A window that is gone has no title to set.
    let _ = set;
  }

  pub(super) fn raw_handle(value: NonZeroIsize) -> RawWindowHandle {
    RawWindowHandle::Win32(Win32WindowHandle::new(value))
  }
}

#[cfg(not(windows))]
mod platform {
  //! The macOS goal gives these their bodies; until then no value names a window.
  use std::num::NonZeroIsize;

  use raw_window_handle::RawWindowHandle;

  pub(super) fn is_window(_value: NonZeroIsize) -> bool {
    false
  }

  pub(super) fn set_title(_value: NonZeroIsize, _title: &str) {}

  pub(super) fn raw_handle(_value: NonZeroIsize) -> RawWindowHandle {
    unreachable!("no ForeignWindow exists on this platform: `is_window` never accepts one")
  }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  #[test]
  fn zero_and_a_value_that_names_no_window_are_refused() {
    assert!(ForeignWindow::from_handle_value(0).is_none());
    // An odd value far from any real handle: handles are multiples of two.
    assert!(ForeignWindow::from_handle_value(0x7FFF_FFF1).is_none());
  }
}
