//! Reads back what the OS shows, for tests: this crate's own, and the
//! runtime's, which enable the `test-support` feature as a dev-dependency only,
//! so nothing here is in the published binding.

use std::ffi::c_void;

use windows::Win32::Graphics::Gdi::DeleteObject;
use windows::Win32::UI::WindowsAndMessaging::{
  GetIconInfo, GetMenuState, GetSystemMenu, HICON, ICONINFO, ICON_BIG, ICON_SMALL, MF_BYCOMMAND, MF_DISABLED, MF_GRAYED, SC_MAXIMIZE, SC_MINIMIZE,
  SC_MOVE, SC_RESTORE, SC_SIZE, WM_GETICON,
};

use crate::platform::icon_message;
use crate::NativeWindow;

/// True when the window shows a small and a big icon (`WM_GETICON`) and
/// `GetIconInfo` accepts both: icons that exist, not ones already destroyed.
pub fn shows_valid_icons(window: &impl NativeWindow) -> bool {
  [ICON_SMALL, ICON_BIG].into_iter().all(|kind| {
    let icon = icon_message(window.hwnd(), WM_GETICON, kind, None);
    icon != 0 && icon_is_valid(HICON(icon as *mut c_void))
  })
}

/// Whether each of the window's system menu items Restore, Move, Size, Minimize
/// and Maximize is enabled, by command; `None` when the window has no system menu.
pub fn system_menu_enabled(window: &impl NativeWindow) -> Option<[bool; 5]> {
  // SAFETY: a window function on a handle named by `NativeWindow`; the menu is the window's and
  // is not destroyed here.
  let menu = unsafe { GetSystemMenu(window.hwnd(), false) };
  if menu.is_invalid() {
    return None;
  }
  Some([SC_RESTORE, SC_MOVE, SC_SIZE, SC_MINIMIZE, SC_MAXIMIZE].map(|command| {
    // SAFETY: `menu` is the window's system menu, alive while the window is; the item is named by command.
    let state = unsafe { GetMenuState(menu, command, MF_BYCOMMAND) };
    state & (MF_GRAYED.0 | MF_DISABLED.0) == 0
  }))
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
