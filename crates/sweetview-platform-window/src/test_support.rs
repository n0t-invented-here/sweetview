//! Reads back what the OS shows, for tests: this crate's own, and the
//! runtime's, which enable the `test-support` feature as a dev-dependency only,
//! so nothing here is in the published binding.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::DeleteObject;
use windows::Win32::UI::Shell::{RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, GetWindow, GW_CHILD, HICON, ICONINFO, ICON_BIG, ICON_SMALL, WM_DESTROY, WM_GETICON, WM_NCDESTROY};

use crate::platform::{forward, icon_message};
use crate::{is_on_this_thread, NativeWindow};

/// True when the window shows a small and a big icon (`WM_GETICON`) and
/// `GetIconInfo` accepts both: icons that exist, not ones already destroyed.
pub fn shows_valid_icons(window: &impl NativeWindow) -> bool {
  [ICON_SMALL, ICON_BIG].into_iter().all(|kind| {
    let icon = icon_message(window.hwnd(), WM_GETICON, kind, None);
    icon != 0 && icon_is_valid(HICON(icon as *mut c_void))
  })
}

fn icon_is_valid(icon: HICON) -> bool {
  let mut info = ICONINFO::default();
  // SAFETY: `info` is an ICONINFO owned by this frame for the call to fill; the icon is passed
  // by value, and the OS refuses one that names no icon.
  if unsafe { GetIconInfo(icon, &mut info) }.is_err() {
    return false;
  }
  for bitmap in [info.hbmMask, info.hbmColor] {
    if !bitmap.is_invalid() {
      // SAFETY: `GetIconInfo` made these bitmaps for its caller, who deletes them; they are
      // selected into no device context.
      let _deleted = unsafe { DeleteObject(bitmap.into()) };
    }
  }
  true
}

/// The id the destroy watch's procedure is installed under ("DW").
const WATCH_SUBCLASS_ID: usize = 0x4457;

type OnDestroy = Box<dyn FnOnce()>;

thread_local! {
  /// What to call when each watched window of this thread is destroyed, by handle value.
  static WATCHED: RefCell<HashMap<isize, OnDestroy>> = RefCell::new(HashMap::new());
}

/// Calls a function when a window of this thread receives `WM_DESTROY`, for a test to read what
/// else is alive or on the screen at that moment (the order a teardown runs in). Dropping it
/// before the window is destroyed takes the watch back; after, it does nothing.
pub struct DestroyWatch {
  hwnd: HWND,
}

/// Watches `window` until it is destroyed: `on_destroy` runs inside its `WM_DESTROY`.
pub fn watch_destroy(window: &impl NativeWindow, on_destroy: impl FnOnce() + 'static) -> Result<DestroyWatch, String> {
  if !is_on_this_thread(window) {
    return Err("sweetview: a window of another thread cannot be watched".into());
  }
  let hwnd = window.hwnd();
  WATCHED.with(|watched| watched.borrow_mut().insert(hwnd.0 as isize, Box::new(on_destroy)));
  // SAFETY: installs this module's procedure on a window of this thread (checked above). The
  // procedure finds what to call by handle value in a thread-local table, and is removed by
  // `Drop` or on `WM_NCDESTROY`.
  let installed = unsafe { SetWindowSubclass(hwnd, Some(watch_proc), WATCH_SUBCLASS_ID, 0) }.as_bool();
  if !installed {
    WATCHED.with(|watched| watched.borrow_mut().remove(&(hwnd.0 as isize)));
    return Err("sweetview: SetWindowSubclass failed".into());
  }
  Ok(DestroyWatch { hwnd })
}

impl Drop for DestroyWatch {
  fn drop(&mut self) {
    let still = WATCHED.try_with(|watched| watched.borrow_mut().remove(&(self.hwnd.0 as isize)).is_some()).unwrap_or(false);
    if still {
      // SAFETY: removes this module's procedure from the window it was installed on; the
      // window is alive (its entry is removed on `WM_NCDESTROY`, which had not come).
      let _removed = unsafe { RemoveWindowSubclass(self.hwnd, Some(watch_proc), WATCH_SUBCLASS_ID) };
    }
  }
}

/// The destroy watch's procedure. A safe `extern "system"` function, which `SUBCLASSPROC`'s
/// `unsafe` function pointer type accepts; its body runs inside `catch_unwind`.
extern "system" fn watch_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
  let _ran = catch_unwind(AssertUnwindSafe(|| {
    if message == WM_DESTROY {
      // Taken out of the table first, so the function may watch or drop anything.
      let on_destroy = WATCHED.try_with(|watched| watched.borrow_mut().remove(&(hwnd.0 as isize))).ok().flatten();
      if let Some(on_destroy) = on_destroy {
        on_destroy();
      }
    } else if message == WM_NCDESTROY {
      let _forgotten = WATCHED.try_with(|watched| watched.borrow_mut().remove(&(hwnd.0 as isize)));
      // SAFETY: removes this procedure from the window being destroyed, inside its own
      // message, as `RemoveWindowSubclass` allows.
      let _removed = unsafe { RemoveWindowSubclass(hwnd, Some(watch_proc), WATCH_SUBCLASS_ID) };
    }
  }));
  forward(hwnd, message, wparam, lparam)
}

/// The handle value of a window's first child (`GetWindow` with `GW_CHILD`), if it has one.
pub fn first_child(window: &impl NativeWindow) -> Option<isize> {
  // SAFETY: one call with a handle the OS validates; it returns an error for none.
  let child = unsafe { GetWindow(window.hwnd(), GW_CHILD) }.ok()?;
  Some(child.0 as isize)
}

/// Whether DWM keeps the window off the screen (`DWMWA_CLOAKED` reads any reason: this process's
/// cloak, the shell's, or another desktop's).
pub fn is_cloaked(window: &impl NativeWindow) -> bool {
  let mut cloaked = 0u32;
  // SAFETY: one call with a handle DWM validates; the out-value is a `u32` local of the size given.
  let read = unsafe {
    windows::Win32::Graphics::Dwm::DwmGetWindowAttribute(window.hwnd(), windows::Win32::Graphics::Dwm::DWMWA_CLOAKED, (&raw mut cloaked).cast(), size_of::<u32>() as u32)
  };
  read.is_ok() && cloaked != 0
}

/// Posts `WM_CLOSE` to a window, as a click on its title bar's close button does: the loop
/// delivers it when it next pumps.
pub fn post_close(window: &impl NativeWindow) {
  crate::platform::post_message(window.hwnd(), windows::Win32::UI::WindowsAndMessaging::WM_CLOSE, 0);
}
