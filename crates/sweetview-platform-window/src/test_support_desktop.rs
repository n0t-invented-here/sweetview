//! What the runtime's webview tests (`engine_os_tests.rs`) read of the desktop beyond
//! `test_support`: the top-level window at a screen point (to refuse to judge a covered pixel),
//! a window's outer rectangle and the largest size a person can drag it to, the user's app
//! theme, and a top-level window by part of its title (the DevTools window). Behind the
//! `test-support` feature, a dev-dependency only, so nothing here is in the published binding.

use std::ffi::c_void;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetAncestor, GetWindowRect, SendMessageW, WindowFromPoint, GA_ROOT, MINMAXINFO, WM_GETMINMAXINFO};

use crate::test_support::title_of;

fn hwnd_of(value: isize) -> HWND {
  HWND(value as *mut c_void)
}

/// The handle value of the top-level window at a point of the screen (the root of the window
/// `WindowFromPoint` finds there); 0 when there is none.
pub fn top_level_at(x: i32, y: i32) -> isize {
  // SAFETY: the point is passed by value.
  let at = unsafe { WindowFromPoint(POINT { x, y }) };
  if at.is_invalid() {
    return 0;
  }
  // SAFETY: the handle value was just returned by the OS, which validates it again.
  unsafe { GetAncestor(at, GA_ROOT) }.0 as isize
}

/// The window's outer rectangle on the screen (left, top, right, bottom), in physical pixels.
pub fn window_rect(window: isize) -> (i32, i32, i32, i32) {
  let mut rect = RECT::default();
  // SAFETY: `rect` is a RECT owned by this frame for the call to fill.
  let _read = unsafe { GetWindowRect(hwnd_of(window), &mut rect) };
  (rect.left, rect.top, rect.right, rect.bottom)
}

/// The largest outer size the OS lets a person drag the window to (`MINMAXINFO.ptMaxTrackSize`
/// of a `WM_GETMINMAXINFO` sent to it, as the OS sends it when a drag starts), in physical
/// pixels: `test_support::min_track_size`'s other bound.
pub fn max_track_size(window: isize) -> (i32, i32) {
  let mut info = MINMAXINFO::default();
  let address = (&raw mut info) as isize;
  // SAFETY: `info` is a MINMAXINFO owned by this frame for the whole call; the message's lParam is
  // its address, which the window's procedure fills, as the OS sends it.
  let _answer = unsafe { SendMessageW(hwnd_of(window), WM_GETMINMAXINFO, None, Some(LPARAM(address))) };
  (info.ptMaxTrackSize.x, info.ptMaxTrackSize.y)
}

/// Whether the user chose the dark mode for apps: `AppsUseLightTheme` 0 under the current user's
/// `Themes\Personalize` key, where Settings writes it. Light when the value is missing.
pub fn system_uses_dark_apps() -> bool {
  let key = windows_registry::CURRENT_USER.open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
  key.and_then(|key| key.get_u32("AppsUseLightTheme")).is_ok_and(|light| light == 0)
}

/// The handle value of a top-level window, of any process, whose title contains `text`; `None`
/// when there is none. Walks the top-level windows with `FindWindowExW`, so no callback is lent
/// to the OS.
pub fn top_level_window_containing(text: &str) -> Option<isize> {
  let mut after: Option<HWND> = None;
  loop {
    // SAFETY: no parent, class or name is passed; `after` is a handle value the OS returned on
    // the previous turn, which it validates again.
    let next = unsafe { FindWindowExW(None, after, PCWSTR::null(), PCWSTR::null()) }.ok()?;
    let value = next.0 as isize;
    if title_of(value).contains(text) {
      return Some(value);
    }
    after = Some(next);
  }
}
