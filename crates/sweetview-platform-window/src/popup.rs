//! Popup menus shown for a window.
//!
//! `muda` builds the menu (its items, check marks, icon bitmaps and submenus),
//! and this module tracks it with `TrackPopupMenu` itself. `muda` 0.22's own
//! `ContextMenu::show_context_menu_for_hwnd` is an `unsafe` call that passes
//! `TPM_LEFTALIGN | TPM_RETURNCMD` only, so letting go of the right button over
//! an item would not choose it and a menu could not open above the cursor, and
//! it reports the chosen item through its process-wide `MenuEvent` handler.
//! Here the menu's items carry the caller's own command ids
//! ([`set_command_id`]) and the chosen one is the call's result (D24).
//!
//! The window is a [`BorrowedWindow`](crate::BorrowedWindow), lent for the
//! length of the call: a Sweetview window, one of the application's own, or
//! the tray menu's owner, named by its handle value.

/// Which corner of a popup menu sits at its point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupCorner {
  /// The menu opens below and to the right of the point (`Menu.popup`).
  TopLeft,
  /// The menu opens above and to the right of the point (`TPM_BOTTOMALIGN`): the
  /// tray's menu, which opens at the cursor above the taskbar.
  BottomLeft,
}

/// Where a popup menu opens: a point on the screen, in physical pixels, and the
/// corner of the menu at that point. Near a screen edge the OS moves the menu
/// to fit, as it does for every popup menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PopupAt {
  pub x: i32,
  pub y: i32,
  pub corner: PopupCorner,
}

#[cfg(windows)]
mod imp {
  use muda::ContextMenu;
  use windows::Win32::UI::WindowsAndMessaging::{
    GetSubMenu, SetMenuItemInfoW, TrackPopupMenu, HMENU, MENUITEMINFOW, MENU_ITEM_STATE, MFS_CHECKED, MFS_DISABLED,
    MIIM_ID, MIIM_STATE, TPM_BOTTOMALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TRACK_POPUP_MENU_FLAGS,
  };

  use super::{PopupAt, PopupCorner};
  use crate::platform::{after_popup_menu, set_foreground, sealed::Sealed};
  use crate::BorrowedWindow;

  /// The popup menu `menu` owns, valid while `menu` is borrowed (`muda`'s `hpopupmenu`).
  fn popup_handle(menu: &muda::Menu) -> HMENU {
    HMENU(menu.hpopupmenu() as *mut core::ffi::c_void)
  }

  pub fn show_popup(menu: &muda::Menu, owner: &BorrowedWindow<'_>, at: PopupAt) -> u32 {
    let hwnd = owner.hwnd();
    // The right button chooses as the left does, as Sweetview's menus always have.
    let corner = match at.corner {
      PopupCorner::TopLeft => TRACK_POPUP_MENU_FLAGS(0),
      PopupCorner::BottomLeft => TPM_BOTTOMALIGN,
    };
    // The owner must be the foreground window or the menu does not close when the user clicks elsewhere.
    set_foreground(hwnd);
    // SAFETY: the menu handle is `menu`'s popup menu, owned by `menu` and alive while `menu` is borrowed
    // for this whole call. `hwnd` is the handle of the window `owner` lends for this call; TrackPopupMenu
    // validates it on this call, as every user32 call does, and a handle that no longer names a window,
    // or names one of another thread, makes the call fail and return 0. The point is passed by value and
    // no rectangle is passed.
    let chosen = unsafe { TrackPopupMenu(popup_handle(menu), TPM_RIGHTBUTTON | TPM_RETURNCMD | corner, at.x, at.y, None, hwnd, None) };
    // The nudge the shell asks for after such a menu, so the next one closes properly.
    after_popup_menu(hwnd);
    u32::try_from(chosen.0).unwrap_or(0)
  }

  /// Sets `info` on the item at `path` of `menu`: each submenu's position from
  /// the top, then the item's position in the last one. False when none is there.
  fn set_item_info(menu: &muda::Menu, path: &[u32], info: &MENUITEMINFOW) -> bool {
    let Some((position, parents)) = path.split_last() else { return false };
    let mut hmenu = popup_handle(menu);
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
    // SAFETY: `hmenu` is a menu owned by `menu`, as above; `info` is a fully initialised
    // MENUITEMINFOW borrowed for the whole call, and its size field is its own size.
    // A position past the end makes the call fail.
    let set = unsafe { SetMenuItemInfoW(hmenu, *position, true, info) };
    set.is_ok()
  }

  pub fn check_item(menu: &muda::Menu, path: &[u32], enabled: bool) -> bool {
    let disabled = if enabled { MENU_ITEM_STATE(0) } else { MFS_DISABLED };
    let info = MENUITEMINFOW {
      cbSize: size_of::<MENUITEMINFOW>() as u32,
      fMask: MIIM_STATE,
      fState: MFS_CHECKED | disabled,
      ..Default::default()
    };
    set_item_info(menu, path, &info)
  }

  pub fn menu_handle_value(menu: &muda::Menu) -> isize {
    menu.hpopupmenu()
  }

  pub fn set_command_id(menu: &muda::Menu, path: &[u32], id: u32) -> bool {
    let info = MENUITEMINFOW { cbSize: size_of::<MENUITEMINFOW>() as u32, fMask: MIIM_ID, wID: id, ..Default::default() };
    set_item_info(menu, path, &info)
  }
}

#[cfg(not(windows))]
mod imp {
  use super::PopupAt;
  use crate::BorrowedWindow;

  /// Not ported: no menu is shown and nothing is chosen.
  pub fn show_popup(_menu: &muda::Menu, _owner: &BorrowedWindow<'_>, _at: PopupAt) -> u32 {
    0
  }

  /// Not ported.
  pub fn check_item(_menu: &muda::Menu, _path: &[u32], _enabled: bool) -> bool {
    false
  }

  /// Not ported: no OS menu handle.
  pub fn menu_handle_value(_menu: &muda::Menu) -> isize {
    0
  }

  /// Not ported.
  pub fn set_command_id(_menu: &muda::Menu, _path: &[u32], _id: u32) -> bool {
    false
  }
}

/// Shows `menu` as a popup menu owned by `owner`, at `at`, and returns after it
/// closes: the command id of the chosen item ([`set_command_id`]), or 0 when the
/// menu was dismissed. Releasing either mouse button over an item chooses it.
///
/// The owner is brought to the foreground first so the menu closes when the user
/// clicks elsewhere, and is posted `WM_NULL` afterwards, as the shell asks.
pub fn show_popup(menu: &muda::Menu, owner: &crate::BorrowedWindow<'_>, at: PopupAt) -> u32 {
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

/// Gives the item at `path` (as for [`check_item`]) the command id `id`: what
/// [`show_popup`] returns when it is chosen, and what `TrackPopupMenu` and
/// `WM_COMMAND` report for it when an application tracks the menu itself.
///
/// For items that can be chosen only, not submenus: `muda` removes a submenu
/// from its parent by the id the OS keeps for it. Ids stay below 0x10000, as
/// `WM_COMMAND` carries 16 bits. False when no item is at `path`.
pub fn set_command_id(menu: &muda::Menu, path: &[u32], id: u32) -> bool {
  imp::set_command_id(menu, path, id)
}

/// The value of the popup menu handle (`HMENU`) `menu` owns, for an
/// application's own `TrackPopupMenu`; valid while `menu` lives. 0 where the
/// platform has no such handle.
pub fn menu_handle_value(menu: &muda::Menu) -> isize {
  imp::menu_handle_value(menu)
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
