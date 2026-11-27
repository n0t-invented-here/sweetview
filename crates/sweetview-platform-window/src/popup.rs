//! Popup menus shown for a window.
//!
//! `muda` builds the menu and tracks it, but showing one inside a window is an
//! `unsafe` call (`ContextMenu::show_context_menu_for_hwnd`, which trusts its
//! caller with the window handle), and its position is relative to the window
//! where Sweetview's callers give a point on the screen. Both are done here.
//!
//! The window is a [`BorrowedWindow`](crate::BorrowedWindow): a window a caller
//! named by its handle value (a Sweetview window, one of the application's
//! own, the tray icon's window), checked to be a window when it was lent.

/// Where a popup menu opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupAt {
  /// At the cursor.
  Cursor,
  /// At a point on the screen, in physical pixels.
  Screen { x: i32, y: i32 },
}

#[cfg(windows)]
mod imp {
  use muda::dpi::{PhysicalPosition, Position};
  use muda::ContextMenu;
  use windows::Win32::Foundation::POINT;
  use windows::Win32::Graphics::Gdi::ScreenToClient;
  use windows::Win32::UI::WindowsAndMessaging::{
    GetSubMenu, SetMenuItemInfoW, HMENU, MENUITEMINFOW, MENU_ITEM_STATE, MFS_CHECKED, MFS_DISABLED, MIIM_STATE,
  };

  use super::PopupAt;
  use crate::platform::{after_popup_menu, sealed::Sealed};
  use crate::BorrowedWindow;

  pub fn show_popup(menu: &muda::Menu, owner: &BorrowedWindow<'_>, at: PopupAt) -> bool {
    let hwnd = owner.hwnd();
    let position = match at {
      PopupAt::Cursor => None,
      PopupAt::Screen { x, y } => {
        // `muda` takes a point in the owner's client area and converts it back to the screen.
        let mut point = POINT { x, y };
        // SAFETY: `point` is a POINT owned by this frame for the whole call; the window handle
        // is validated by the OS, and a stale one makes the call fail, which is handled below.
        let converted = unsafe { ScreenToClient(hwnd, &mut point) };
        if !converted.as_bool() {
          return false;
        }
        Some(Position::Physical(PhysicalPosition::new(point.x, point.y)))
      }
    };
    // SAFETY: `show_context_menu_for_hwnd` requires a valid window handle. `owner` was checked
    // with IsWindow when it was made, and is not `Send`, so it is on this thread; `muda` passes the
    // handle only to user32 calls (SetForegroundWindow, ClientToScreen, TrackPopupMenu), which
    // validate it. The menu is borrowed for the whole call.
    let chosen = unsafe { menu.show_context_menu_for_hwnd(hwnd.0 as isize, position) };
    // `muda` brings the owner to the foreground for the menu but does not post the nudge after it.
    after_popup_menu(hwnd);
    chosen
  }

  pub fn check_item(menu: &muda::Menu, path: &[u32], enabled: bool) -> bool {
    let Some((position, parents)) = path.split_last() else { return false };
    let mut hmenu = HMENU(menu.hpopupmenu() as *mut core::ffi::c_void);
    for parent in parents {
      let Ok(index) = i32::try_from(*parent) else { return false };
      // SAFETY: `hmenu` is the popup menu `menu` owns or one of its submenus, all owned by `menu`
      // and valid while it is borrowed (muda's `hpopupmenu` contract); GetSubMenu reads it by value.
      let submenu = unsafe { GetSubMenu(hmenu, index) };
      if submenu.is_invalid() {
        return false;
      }
      hmenu = submenu;
    }
    let disabled = if enabled { MENU_ITEM_STATE(0) } else { MFS_DISABLED };
    let info = MENUITEMINFOW {
      cbSize: size_of::<MENUITEMINFOW>() as u32,
      fMask: MIIM_STATE,
      fState: MFS_CHECKED | disabled,
      ..Default::default()
    };
    // SAFETY: `hmenu` is a menu owned by `menu`, as above; `info` is a fully initialised
    // MENUITEMINFOW owned by this frame for the whole call, and its size field is its own size.
    // A position past the end makes the call fail.
    let set = unsafe { SetMenuItemInfoW(hmenu, *position, true, &info) };
    set.is_ok()
  }
}

#[cfg(not(windows))]
mod imp {
  use super::PopupAt;
  use crate::BorrowedWindow;

  /// Not ported: no menu is shown and nothing is chosen.
  pub fn show_popup(_menu: &muda::Menu, _owner: &BorrowedWindow<'_>, _at: PopupAt) -> bool {
    false
  }

  /// Not ported.
  pub fn check_item(_menu: &muda::Menu, _path: &[u32], _enabled: bool) -> bool {
    false
  }
}

/// Shows `menu` as a popup menu owned by `owner`, at `at`, and returns after it
/// closes: true when an item was chosen. The chosen item is reported the way
/// `muda` reports every activation, as a `muda::MenuEvent`, before this returns.
///
/// The owner is brought to the foreground first so the menu closes when the user
/// clicks elsewhere, and is posted `WM_NULL` afterwards, as the shell asks.
pub fn show_popup(menu: &muda::Menu, owner: &crate::BorrowedWindow<'_>, at: PopupAt) -> bool {
  imp::show_popup(menu, owner, at)
}

/// Puts a check mark on an item `muda` made with an icon. `muda` has no item
/// with both an icon and a check mark, which the OS draws side by side; this
/// sets the item's state to checked, enabled or not as `enabled` says.
///
/// `path` names the item by position: the position of each submenu from the
/// top of `menu`, then the item's position in the last one. Call it once the
/// menu is complete. False when no item is at `path`.
pub fn check_item(menu: &muda::Menu, path: &[u32], enabled: bool) -> bool {
  imp::check_item(menu, path, enabled)
}

#[cfg(all(test, windows))]
mod tests {
  use crate::BorrowedWindow;

  #[test]
  fn a_value_that_names_no_window_is_refused() {
    assert!(BorrowedWindow::with_handle_value(0, |_| ()).is_none());
    assert!(BorrowedWindow::with_handle_value(0x7fff_fff0, |_| ()).is_none());
  }
}

