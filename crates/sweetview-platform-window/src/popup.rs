//! Popup menus, and the window that owns a popup menu or a dialog.
//!
//! `muda` builds the menu and tracks it, but showing one inside a window is an
//! `unsafe` call (`ContextMenu::show_context_menu_for_hwnd`, which trusts its
//! caller with the window handle), and its position is relative to the window
//! where Sweetview's callers give a point on the screen. Both are done here.
//!
//! An [`OwnerWindow`] names a window that a caller passed by handle value: a
//! Sweetview window, one of the application's own, the tray icon's window. It
//! is checked to be a window when it is made and is handed to `rfd` and `muda`
//! through `raw-window-handle`.

use std::marker::PhantomData;

use raw_window_handle::{DisplayHandle, HandleError, HasDisplayHandle};

/// Where a popup menu opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupAt {
  /// At the cursor.
  Cursor,
  /// At a point on the screen, in physical pixels.
  Screen { x: i32, y: i32 },
}

/// A window, named by its handle, that a popup menu or a dialog is shown for.
///
/// It does not own the window: the window belongs to whoever made it. It is
/// checked to be a window when it is made, and every OS call it is passed to
/// validates the handle again, so a window destroyed in the meantime makes the
/// call fail rather than touch freed memory. It stays on the thread that made it.
pub struct OwnerWindow {
  #[cfg(windows)]
  hwnd: windows::Win32::Foundation::HWND,
  _not_send: PhantomData<*const ()>,
}

impl HasDisplayHandle for OwnerWindow {
  fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
    #[cfg(windows)]
    return Ok(DisplayHandle::windows());
    #[cfg(not(windows))]
    return Err(HandleError::NotSupported);
  }
}

#[cfg(windows)]
mod imp {
  use std::marker::PhantomData;
  use std::num::NonZeroIsize;

  use muda::dpi::{PhysicalPosition, Position};
  use muda::ContextMenu;
  use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
  use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
  use windows::Win32::Graphics::Gdi::ScreenToClient;
  use windows::Win32::UI::WindowsAndMessaging::{IsWindow, PostMessageW, WM_NULL};

  use super::{OwnerWindow, PopupAt};

  impl OwnerWindow {
    /// The window `handle` names, when it names one now.
    pub fn from_handle_value(handle: isize) -> Option<Self> {
      if handle == 0 {
        return None;
      }
      let hwnd = HWND(handle as *mut core::ffi::c_void);
      // SAFETY: IsWindow accepts any value and reports whether it names a window; it dereferences nothing.
      let is_window = unsafe { IsWindow(Some(hwnd)) };
      is_window.as_bool().then_some(Self { hwnd, _not_send: PhantomData })
    }

    /// The handle value, as the caller gave it.
    pub fn handle_value(&self) -> isize {
      self.hwnd.0 as isize
    }
  }

  impl HasWindowHandle for OwnerWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
      let hwnd = NonZeroIsize::new(self.handle_value()).ok_or(HandleError::Unavailable)?;
      let raw = RawWindowHandle::Win32(Win32WindowHandle::new(hwnd));
      // SAFETY: `borrow_raw` asks that the handle name a window for as long as the borrow lasts.
      // `self.hwnd` was checked with IsWindow when this value was made, and its consumers (rfd's
      // IFileDialog::Show) hand it only to the OS, which validates the handle on use.
      Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
  }

  pub fn show_popup(menu: &muda::Menu, owner: &OwnerWindow, at: PopupAt) -> bool {
    let position = match at {
      PopupAt::Cursor => None,
      PopupAt::Screen { x, y } => {
        // `muda` takes a point in the owner's client area and converts it back to the screen.
        let mut point = POINT { x, y };
        // SAFETY: `point` is a POINT owned by this frame for the whole call; the window handle
        // is validated by the OS, and a stale one makes the call fail, which is handled below.
        let converted = unsafe { ScreenToClient(owner.hwnd, &mut point) };
        if !converted.as_bool() {
          return false;
        }
        Some(Position::Physical(PhysicalPosition::new(point.x, point.y)))
      }
    };
    // SAFETY: `show_context_menu_for_hwnd` requires a valid window handle. `owner` was checked
    // with IsWindow when it was made, on this thread, and nothing has run since; `muda` passes the
    // handle only to user32 calls (SetForegroundWindow, ClientToScreen, TrackPopupMenu), which
    // validate it. The menu is borrowed for the whole call.
    let chosen = unsafe { menu.show_context_menu_for_hwnd(owner.handle_value(), position) };
    // The documented nudge after a popup menu owned by a window that was made foreground for
    // it, so the next one closes when the user clicks elsewhere (KB 135788). `muda` does not post it.
    // SAFETY: PostMessageW takes the handle and two integers by value; the OS validates the handle.
    let posted = unsafe { PostMessageW(Some(owner.hwnd), WM_NULL, WPARAM(0), LPARAM(0)) };
    // A failed nudge changes nothing about the menu that just closed.
    let _ = posted;
    chosen
  }
}

#[cfg(not(windows))]
mod imp {
  use raw_window_handle::{HandleError, HasWindowHandle, WindowHandle};

  use super::{OwnerWindow, PopupAt};

  impl OwnerWindow {
    /// Not ported: no handle names a window here yet.
    pub fn from_handle_value(_handle: isize) -> Option<Self> {
      None
    }

    pub fn handle_value(&self) -> isize {
      0
    }
  }

  impl HasWindowHandle for OwnerWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
      Err(HandleError::NotSupported)
    }
  }

  /// Not ported: no menu is shown and nothing is chosen.
  pub fn show_popup(_menu: &muda::Menu, _owner: &OwnerWindow, _at: PopupAt) -> bool {
    false
  }
}

/// Shows `menu` as a popup menu owned by `owner`, at `at`, and returns after it
/// closes: true when an item was chosen. The chosen item is reported the way
/// `muda` reports every activation, as a `muda::MenuEvent`, before this returns.
///
/// The owner is brought to the foreground first so the menu closes when the user
/// clicks elsewhere, and is posted `WM_NULL` afterwards, as the shell asks.
pub fn show_popup(menu: &muda::Menu, owner: &OwnerWindow, at: PopupAt) -> bool {
  imp::show_popup(menu, owner, at)
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;

  #[test]
  fn a_value_that_names_no_window_is_refused() {
    assert!(OwnerWindow::from_handle_value(0).is_none());
    assert!(OwnerWindow::from_handle_value(0x7fff_fff0).is_none());
  }
}
