//! What a person does on the desktop and what the OS shows them there, by window handle value,
//! for the runtime's webview tests (`engine_os_tests.rs`): the foreground, real keys, the
//! colour of a screen pixel, and a window's title, client size, tracking bounds and title bar,
//! read from the OS. Behind the `test-support` feature, a dev-dependency only, so nothing here is
//! in the published binding.
//!
//! Real input goes to the shared desktop: a caller takes the desktop lock its runner names, holds
//! the foreground for its own window before it sends a key, and sends every key's up.

use std::ffi::c_void;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};
use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY};
use windows::Win32::UI::WindowsAndMessaging::{
  BringWindowToTop, FindWindowExW, GetAncestor, GetClientRect, GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
  PostMessageW, SendMessageW, SetForegroundWindow, WindowFromPoint, GA_ROOT, MINMAXINFO, WM_GETMINMAXINFO,
};

fn hwnd_of(value: isize) -> HWND {
  HWND(value as *mut c_void)
}

/// Posts `message` with integer parameters to the window with handle value `window`, as the
/// shell or another process would. False when the OS refused it.
pub fn post(window: isize, message: u32, wparam: usize, lparam: isize) -> bool {
  // SAFETY: `PostMessageW` validates the handle value; the parameters are integers.
  unsafe { PostMessageW(Some(hwnd_of(window)), message, WPARAM(wparam), LPARAM(lparam)) }.is_ok()
}

/// The handle value of the foreground window; 0 when there is none.
pub fn foreground() -> isize {
  // SAFETY: takes nothing and reads no memory of ours.
  unsafe { GetForegroundWindow() }.0 as isize
}

/// Brings `window` to the foreground: asked plainly first; when the OS refuses, this thread's
/// input is attached to the foreground window's thread (the documented way a cooperating thread
/// hands the foreground over) for the one call, and detached at once. True when `window` holds
/// the foreground afterwards.
pub fn take_foreground(window: isize) -> bool {
  let hwnd = hwnd_of(window);
  // SAFETY: takes the handle by value; the OS validates it.
  let _asked = unsafe { SetForegroundWindow(hwnd) };
  if foreground() == window {
    return true;
  }
  let current = foreground();
  // SAFETY: the handle value is one the OS just returned and validates again; no process id is asked for.
  let theirs = if current == 0 { 0 } else { unsafe { GetWindowThreadProcessId(hwnd_of(current), None) } };
  // SAFETY: takes nothing and reads no memory.
  let ours = unsafe { GetCurrentThreadId() };
  if theirs == 0 || theirs == ours {
    return false;
  }
  // SAFETY: two thread ids and a flag; the OS refuses ids that name no thread.
  if !unsafe { AttachThreadInput(ours, theirs, true) }.as_bool() {
    return false;
  }
  // SAFETY: takes the handle by value; the OS validates it.
  let _top = unsafe { BringWindowToTop(hwnd) };
  // SAFETY: as above.
  let _asked = unsafe { SetForegroundWindow(hwnd) };
  // SAFETY: as the attach above; this detaches what it attached.
  let _detached = unsafe { AttachThreadInput(ours, theirs, false) };
  foreground() == window
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

/// Presses and releases a key by its virtual-key code in one batch of real input, as a person
/// tapping it. True when the system took both.
pub fn tap_key(virtual_key: u16) -> bool {
  let key = |flags| INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(virtual_key), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
  let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
  // SAFETY: `inputs` is an array of fully initialised INPUTs owned by this frame for the whole
  // call, and the size is INPUT's.
  let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
  sent as usize == inputs.len()
}

/// The window's title, as `GetWindowTextW` reads it.
pub fn title_of(window: isize) -> String {
  let mut text = [0u16; 512];
  // SAFETY: `text` is a buffer owned by this frame for the call; its length comes from the slice.
  let length = unsafe { GetWindowTextW(hwnd_of(window), &mut text) };
  String::from_utf16_lossy(&text[..usize::try_from(length).unwrap_or(0)])
}

/// The size of the window's client area, in physical pixels.
pub fn client_size(window: isize) -> (i32, i32) {
  let mut rect = RECT::default();
  // SAFETY: `rect` is a RECT owned by this frame for the call to fill.
  let _read = unsafe { GetClientRect(hwnd_of(window), &mut rect) };
  (rect.right - rect.left, rect.bottom - rect.top)
}

/// The window's outer rectangle on the screen (left, top, right, bottom), in physical pixels.
pub fn window_rect(window: isize) -> (i32, i32, i32, i32) {
  let mut rect = RECT::default();
  // SAFETY: `rect` is a RECT owned by this frame for the call to fill.
  let _read = unsafe { GetWindowRect(hwnd_of(window), &mut rect) };
  (rect.left, rect.top, rect.right, rect.bottom)
}

/// The smallest and the largest outer size the OS lets a person drag the window to
/// (`ptMinTrackSize` and `ptMaxTrackSize` of a `WM_GETMINMAXINFO` sent to it, as the OS sends it
/// when a drag starts), in physical pixels.
pub fn track_sizes(window: isize) -> ((i32, i32), (i32, i32)) {
  let mut info = MINMAXINFO::default();
  let address = (&raw mut info) as isize;
  // SAFETY: `info` is a MINMAXINFO owned by this frame for the whole call; the message's lParam is
  // its address, which the window's procedure fills, as the OS sends it.
  let _answer = unsafe { SendMessageW(hwnd_of(window), WM_GETMINMAXINFO, None, Some(LPARAM(address))) };
  ((info.ptMinTrackSize.x, info.ptMinTrackSize.y), (info.ptMaxTrackSize.x, info.ptMaxTrackSize.y))
}

/// Whether the window's title bar is dark (`DWMWA_USE_IMMERSIVE_DARK_MODE`); `None` when DWM
/// refuses the read.
pub fn uses_dark_title_bar(window: isize) -> Option<bool> {
  let mut value = 0i32;
  let address = (&raw mut value).cast::<c_void>();
  // SAFETY: `value` is an i32 owned by this frame for the call, and the size passed is its size.
  let read = unsafe { DwmGetWindowAttribute(hwnd_of(window), DWMWA_USE_IMMERSIVE_DARK_MODE, address, size_of::<i32>() as u32) };
  read.ok().map(|()| value != 0)
}

/// Whether the user chose the dark mode for apps: `AppsUseLightTheme` 0 under the current user's
/// `Themes\Personalize` key, where Settings writes it. Light when the value is missing.
pub fn system_uses_dark_apps() -> bool {
  let key = windows_registry::CURRENT_USER.open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
  key.and_then(|key| key.get_u32("AppsUseLightTheme")).is_ok_and(|light| light == 0)
}

/// The colour the screen shows at a point, as `0xRRGGBB`; `None` for a point no screen shows
/// (`GetPixel`'s `CLR_INVALID`), rather than reading it as a colour.
pub fn screen_pixel(x: i32, y: i32) -> Option<u32> {
  // SAFETY: the screen's device context, released below; no window is passed.
  let dc = unsafe { GetDC(None) };
  // SAFETY: `dc` is the device context just taken; the point is passed by value.
  let colour = unsafe { GetPixel(dc, x, y) };
  // SAFETY: releases the device context taken above, once.
  let _released = unsafe { ReleaseDC(None, dc) };
  if colour.0 == CLR_INVALID {
    return None;
  }
  // COLORREF is 0x00BBGGRR.
  let (r, g, b) = (colour.0 & 0xff, (colour.0 >> 8) & 0xff, (colour.0 >> 16) & 0xff);
  Some((r << 16) | (g << 8) | b)
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
