//! Windows: what the frame of a tabbed window needs that `tao` has no API for.
//!
//! The frame is a `tao` window without decorations (its caption is drawn by
//! the tab strip, a child webview). These are the calls around it: its client
//! area, whether it is the foreground window, handing a press on the strip to
//! the OS move and size loops (synchronously, so the caller knows where the
//! window ended up), the window's system menu, a popup menu that answers with
//! the chosen item, and the system's light or dark app theme.

use std::ffi::c_void;
use std::marker::PhantomData;

use sweetview_window_logic::ResizeEdge;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
use windows::Win32::UI::WindowsAndMessaging::{
  AppendMenuW, CreatePopupMenu, DestroyMenu, EnableMenuItem, GetClientRect, GetForegroundWindow, GetSystemMenu,
  PostMessageW, SendMessageW, SetForegroundWindow, SetMenuDefaultItem, TrackPopupMenu, HMENU, MENU_ITEM_FLAGS, MF_ENABLED,
  MF_GRAYED, MF_SEPARATOR, MF_STRING, SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_MOVE, SC_RESTORE, SC_SIZE, TPM_RETURNCMD,
  TPM_RIGHTBUTTON, WM_NCLBUTTONDOWN, WM_NULL, WM_SYSCOMMAND, WS_CLIPCHILDREN,
};

use crate::{is_zoomed, NativeWindow, Point, Rect};

/// The style bit a frame keeps on, so painting its background never draws
/// over the webviews that are its children.
pub const FRAME_STYLE: u32 = WS_CLIPCHILDREN.0;

/// The client area: `(0, 0)` to the window's inside size, or `None` when the window is gone.
pub fn client_rect(window: &impl NativeWindow) -> Option<Rect> {
  let mut rect = RECT::default();
  // SAFETY: `rect` is a RECT owned by this frame for the call to fill; the
  // handle is named by `NativeWindow`, and an invalid one fails the call.
  unsafe { GetClientRect(window.hwnd(), &mut rect) }.ok()?;
  Some(Rect::from_edges(rect.left, rect.top, rect.right, rect.bottom))
}

/// Where the client area's top-left corner is on the screen.
pub fn client_origin(window: &impl NativeWindow) -> Option<Point> {
  let mut point = POINT::default();
  // SAFETY: `point` is a POINT owned by this frame for the call to convert in place.
  let converted = unsafe { ClientToScreen(window.hwnd(), &mut point) }.as_bool();
  converted.then_some(Point { x: point.x, y: point.y })
}

/// True when the window is the foreground window: the one the user is typing into.
pub fn is_foreground(window: &impl NativeWindow) -> bool {
  // SAFETY: `GetForegroundWindow` reads the system's foreground window and has no preconditions.
  let foreground = unsafe { GetForegroundWindow() };
  foreground == window.hwnd()
}

/// Hands the left button's press to the OS: `hit` is the `HT*` code of the
/// part of the frame the press counts as. Returns when the OS move or size
/// loop ends (the button is released), unlike `tao`'s `drag_window`, which
/// posts the press and returns at once.
fn send_frame_press(hwnd: HWND, hit: u32) {
  // SAFETY: `ReleaseCapture` has no preconditions; it fails only when nothing holds the capture.
  let _released = unsafe { ReleaseCapture() };
  // SAFETY: a window message with plain integer parameters to a handle named by `NativeWindow`.
  let _result = unsafe { SendMessageW(hwnd, WM_NCLBUTTONDOWN, Some(WPARAM(hit as usize)), Some(LPARAM(0))) };
}

/// Moves the window with the mouse until the left button is released, as a press on a title bar does.
pub fn move_with_mouse(window: &impl NativeWindow) {
  send_frame_press(window.hwnd(), 2); // HTCAPTION
}

/// Resizes the window from `edge` with the mouse until the left button is released.
pub fn size_with_mouse(window: &impl NativeWindow, edge: ResizeEdge) {
  let hit = match edge {
    ResizeEdge::Left => 10,
    ResizeEdge::Right => 11,
    ResizeEdge::Top => 12,
    ResizeEdge::TopLeft => 13,
    ResizeEdge::TopRight => 14,
    ResizeEdge::Bottom => 15,
    ResizeEdge::BottomLeft => 16,
    ResizeEdge::BottomRight => 17,
  };
  send_frame_press(window.hwnd(), hit);
}

fn post(hwnd: HWND, message: u32, wparam: usize) {
  // SAFETY: a posted message with plain integer parameters to a handle named by `NativeWindow`.
  let _posted = unsafe { PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(0)) };
}

/// Shows `menu` at `at` (screen pixels) for `hwnd` and returns the chosen
/// command, 0 when it was dismissed. The window is made foreground first and
/// sent a `WM_NULL` after, so the menu closes when the user clicks elsewhere
/// and opens properly the next time (the documented pair for `TrackPopupMenu`).
fn track(menu: HMENU, hwnd: HWND, at: Point) -> u32 {
  // SAFETY: a window function on a handle named by `NativeWindow`. The OS may
  // refuse the foreground to a process that does not hold it; that is not an error.
  let _granted = unsafe { SetForegroundWindow(hwnd) };
  // SAFETY: `menu` is alive for the whole call (the caller owns or borrows it
  // from the window), `hwnd` is named by `NativeWindow`, and no rectangle is passed.
  let chosen = unsafe { TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD, at.x, at.y, None, hwnd, None) };
  post(hwnd, WM_NULL, 0);
  u32::try_from(chosen.0).unwrap_or(0)
}

/// Shows the window's system menu (Restore, Move, Size, Minimize, Maximize,
/// Close) at `at`, with the items enabled for its maximised state, and carries
/// out the chosen command as the title bar's own menu does.
pub fn show_system_menu(window: &impl NativeWindow, at: Point) {
  let hwnd = window.hwnd();
  // SAFETY: a window function on a handle named by `NativeWindow`. The menu
  // belongs to the window and is not destroyed here.
  let menu = unsafe { GetSystemMenu(hwnd, false) };
  if menu.is_invalid() {
    return;
  }
  let zoomed = is_zoomed(window);
  for (command, enabled) in [(SC_RESTORE, zoomed), (SC_MOVE, !zoomed), (SC_SIZE, !zoomed), (SC_MINIMIZE, true), (SC_MAXIMIZE, !zoomed)] {
    let state = if enabled { MF_ENABLED } else { MF_GRAYED };
    // SAFETY: `menu` is the window's own system menu, alive while the window is.
    let _previous = unsafe { EnableMenuItem(menu, command, state) };
  }
  // SAFETY: the same menu; `SC_CLOSE` is one of its commands (by command, not position).
  let _set = unsafe { SetMenuDefaultItem(menu, SC_CLOSE, 0) };
  let chosen = track(menu, hwnd, at);
  if chosen != 0 {
    post(hwnd, WM_SYSCOMMAND, chosen as usize);
  }
}

/// One line of a [`popup_menu`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopupEntry {
  Item { label: String, enabled: bool },
  Separator,
}

/// A popup menu this crate made, destroyed on drop.
struct OwnedMenu {
  menu: HMENU,
  _not_send: PhantomData<*const c_void>,
}

impl OwnedMenu {
  fn new() -> Result<Self, String> {
    // SAFETY: `CreatePopupMenu` has no preconditions; the menu is owned by the value returned.
    let menu = unsafe { CreatePopupMenu() }.map_err(|e| format!("sweetview: CreatePopupMenu failed: {e}"))?;
    Ok(Self { menu, _not_send: PhantomData })
  }

  fn append(&self, entry: &PopupEntry, command: usize) -> Result<(), String> {
    match entry {
      PopupEntry::Separator => {
        // SAFETY: `self.menu` is owned by this value; a separator takes no text.
        unsafe { AppendMenuW(self.menu, MF_SEPARATOR, 0, PCWSTR::null()) }
      }
      PopupEntry::Item { label, enabled } => {
        // A lone `&` is a mnemonic prefix: doubled, it shows as itself.
        let wide: Vec<u16> = label.replace('&', "&&").encode_utf16().chain(Some(0)).collect();
        let flags = MF_STRING | if *enabled { MENU_ITEM_FLAGS(0) } else { MF_GRAYED };
        // SAFETY: `self.menu` is owned by this value and `wide` is a NUL-terminated
        // UTF-16 buffer that lives for the whole call; the menu copies the text.
        unsafe { AppendMenuW(self.menu, flags, command, PCWSTR(wide.as_ptr())) }
      }
    }
    .map_err(|e| format!("sweetview: AppendMenuW failed: {e}"))
  }
}

impl Drop for OwnedMenu {
  fn drop(&mut self) {
    // SAFETY: `self.menu` was made by `CreatePopupMenu` for this value alone and is destroyed only here.
    let _destroyed = unsafe { DestroyMenu(self.menu) };
  }
}

/// Shows `entries` as a popup menu at `at` (screen pixels), owned by `window`,
/// and returns the index of the chosen entry once the menu closes; `None` when
/// it was dismissed. Blocks in the menu's own loop until then.
pub fn popup_menu(window: &impl NativeWindow, entries: &[PopupEntry], at: Point) -> Result<Option<usize>, String> {
  let menu = OwnedMenu::new()?;
  for (index, entry) in entries.iter().enumerate() {
    // Command ids are 1-based: `TrackPopupMenu` answers 0 for "nothing chosen".
    menu.append(entry, index + 1)?;
  }
  let chosen = track(menu.menu, window.hwnd(), at) as usize;
  Ok(chosen.checked_sub(1).filter(|index| *index < entries.len()))
}

/// True when the system's app theme is dark (Settings › Personalization ›
/// Colors › "Choose your default app mode"). Read from `UISettings`: apps in
/// dark mode get a light foreground colour. `false` when it cannot be read.
pub fn system_is_dark() -> bool {
  use windows::UI::ViewManagement::{UIColorType, UISettings};
  let foreground = UISettings::new().and_then(|settings| settings.GetColorValue(UIColorType::Foreground));
  match foreground {
    // The weighting Microsoft gives for telling a light colour from a dark one.
    Ok(c) => 5 * u32::from(c.G) + 2 * u32::from(c.R) + u32::from(c.B) > 8 * 128,
    Err(_) => false,
  }
}

#[cfg(test)]
#[path = "tab_frame_tests.rs"]
mod tests;
