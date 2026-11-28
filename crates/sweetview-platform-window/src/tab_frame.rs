//! Windows: what the frame of a tabbed window needs that `tao` has no API for.
//!
//! The frame is a `tao` window without decorations (its caption is drawn by
//! the tab strip, a child webview). These are the calls around it: whether it
//! is the foreground window, a synchronous close request, the window's system
//! menu, a popup menu that answers with the chosen item, the system's light or
//! dark app theme, and the two messages the frame answers itself
//! ([`FrameMessages`]): its backdrop and a DPI change. A press on the strip is
//! handed to the OS move and size loops by `press_frame`, which every window has.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, DeleteObject, FillRect, InvalidateRect, HBRUSH, HDC};
use windows::Win32::UI::Shell::{RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
  EnableMenuItem, GetForegroundWindow, GetSystemMenu, SendMessageW, SetMenuDefaultItem, TrackPopupMenu, HMENU, MF_ENABLED,
  MF_GRAYED, SWP_NOACTIVATE, SWP_NOZORDER,
  TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_CLOSE, WM_DPICHANGED, WM_ERASEBKGND, WM_NCDESTROY, WM_SYSCOMMAND, WS_CLIPCHILDREN,
};

use crate::platform::{after_popup_menu, client_size, dpi_of, forward as forward_frame, post_message, set_foreground, set_window_pos};
use crate::{is_on_this_thread, is_zoomed, NativeWindow, Point, Rect};
// What the system menu offers and the ids of its commands, decided without an OS call.
use sweetview_window_logic::system_menu::{system_menu_items, SystemCommand, SystemMenuState};

/// The style bit a frame keeps on, so painting its background never draws
/// over the webviews that are its children.
pub const FRAME_STYLE: u32 = WS_CLIPCHILDREN.0;

/// True when the window is the foreground window: the one the user is typing into.
pub fn is_foreground(window: &impl NativeWindow) -> bool {
  // SAFETY: `GetForegroundWindow` reads the system's foreground window and has no preconditions.
  let foreground = unsafe { GetForegroundWindow() };
  foreground == window.hwnd()
}

/// Asks the window to close, as its close button does (`WM_CLOSE`), and
/// returns once the window has handled the request: its close listeners ran,
/// or it was destroyed. `tao` 0.38.0 has no close request that waits for this.
pub fn request_close(window: &impl NativeWindow) {
  // SAFETY: a message with no parameters to a handle the OS validates; a stale one makes the call fail.
  let _result = unsafe { SendMessageW(window.hwnd(), WM_CLOSE, None, None) };
}

/// A menu that stays alive for as long as this value is borrowed: what
/// [`track`] shows.
trait TrackedMenu {
  fn menu(&self) -> HMENU;
}

/// A window's own system menu, borrowed for as long as the window is (`'w`):
/// the window owns it and destroys it with itself.
struct SystemMenu<'w> {
  menu: HMENU,
  _window: PhantomData<&'w ()>,
}

impl<'w> SystemMenu<'w> {
  /// The system menu of `window`, borrowed for as long as `window` is.
  fn of(window: &'w impl NativeWindow) -> Option<Self> {
    // SAFETY: a window function on a handle named by `NativeWindow`. The menu
    // belongs to the window and is not destroyed here.
    let menu = unsafe { GetSystemMenu(window.hwnd(), false) };
    (!menu.is_invalid()).then_some(Self { menu, _window: PhantomData })
  }
}

impl TrackedMenu for SystemMenu<'_> {
  fn menu(&self) -> HMENU {
    self.menu
  }
}

/// Shows `menu` at `at` (screen pixels) for `window` and returns the chosen
/// command, 0 when it was dismissed. The window is made foreground first and
/// sent a `WM_NULL` after, so the menu closes when the user clicks elsewhere
/// and opens properly the next time (the documented pair for `TrackPopupMenu`).
fn track(menu: &impl TrackedMenu, window: &impl NativeWindow, at: Point) -> u32 {
  let hwnd = window.hwnd();
  set_foreground(hwnd);
  // SAFETY: the menu stays alive for the whole call: `menu` is borrowed for it, and a
  // `TrackedMenu` is a window's system
  // menu (alive while its window is, which `SystemMenu`'s lifetime ties to the borrowed
  // window). `hwnd` is named by `NativeWindow` and validated by the OS; no rectangle is passed.
  let chosen = unsafe { TrackPopupMenu(menu.menu(), TPM_RIGHTBUTTON | TPM_RETURNCMD, at.x, at.y, None, hwnd, None) };
  after_popup_menu(hwnd);
  u32::try_from(chosen.0).unwrap_or(0)
}

/// Shows the window's system menu (Restore, Move, Size, Minimize, Maximize,
/// Close) at `at` and carries out the chosen command, as the tag's
/// `windowMenu(hwnd)` did for every window: Restore enabled when `IsZoomed`,
/// Move, Size and Maximize when not, Minimize always, Close left as it is and
/// made the default item, the command posted as `WM_SYSCOMMAND`. Blocks until
/// the menu closes.
pub fn show_system_menu(window: &impl NativeWindow, at: Point) {
  let Some(menu) = SystemMenu::of(window) else { return };
  for (command, enabled) in system_menu_items(SystemMenuState { maximized: is_zoomed(window) }) {
    let flag = if enabled { MF_ENABLED } else { MF_GRAYED };
    // SAFETY: `menu` is the window's own system menu, alive while the window is.
    let _previous = unsafe { EnableMenuItem(menu.menu, command.id(), flag) };
  }
  // SAFETY: the same menu; `SC_CLOSE` is one of its commands (by command, not position).
  let _set = unsafe { SetMenuDefaultItem(menu.menu, SystemCommand::Close.id(), 0) };
  let chosen = track(&menu, window, at);
  if chosen != 0 {
    post_message(window.hwnd(), WM_SYSCOMMAND, chosen as usize);
  }
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

// ---- the messages the frame answers itself -------------------------------------------

/// The fixed colours the frame paints where no webview covers it: the strip's
/// across the top `strip_height` device-independent pixels, the page's below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backdrop {
  pub strip_height: u32,
  /// Red, green, blue.
  pub strip: (u8, u8, u8),
  pub page: (u8, u8, u8),
}

/// A solid GDI brush, deleted on drop.
struct OwnedBrush {
  brush: HBRUSH,
  _not_send: PhantomData<*const c_void>,
}

impl OwnedBrush {
  fn new((red, green, blue): (u8, u8, u8)) -> Result<Self, String> {
    let colour = COLORREF(u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16));
    // SAFETY: `CreateSolidBrush` takes a colour by value and has no preconditions;
    // the brush is owned by the value returned and deleted only in its `Drop`.
    let brush = unsafe { CreateSolidBrush(colour) };
    if brush.is_invalid() {
      return Err("sweetview: CreateSolidBrush failed".into());
    }
    Ok(Self { brush, _not_send: PhantomData })
  }
}

impl Drop for OwnedBrush {
  fn drop(&mut self) {
    // SAFETY: `self.brush` was made by `CreateSolidBrush` for this value alone; a
    // brush is selected into no device context here (`FillRect` does not select
    // it), so it may be deleted, and it is deleted only here.
    let _deleted = unsafe { DeleteObject(self.brush.into()) };
  }
}

/// The brushes of one backdrop.
struct Brushes {
  strip_height: u32,
  strip: OwnedBrush,
  page: OwnedBrush,
}

impl Brushes {
  fn new(backdrop: Backdrop) -> Result<Self, String> {
    Ok(Self { strip_height: backdrop.strip_height, strip: OwnedBrush::new(backdrop.strip)?, page: OwnedBrush::new(backdrop.page)? })
  }
}

/// What the frame procedure keeps for one frame.
struct FrameState {
  brushes: RefCell<Brushes>,
  /// Set once the window is destroyed and the procedure removed.
  gone: Cell<bool>,
}

/// The id this crate's frame procedure is installed under ("ST"); the window
/// subclass of `windows.rs` has its own procedure and id.
const FRAME_SUBCLASS_ID: usize = 0x5354;

thread_local! {
  /// The state of each frame of this thread, by handle value, as the window subclass keeps its own.
  static FRAMES: RefCell<HashMap<isize, Rc<FrameState>>> = RefCell::new(HashMap::new());
}

fn frame_state(hwnd: HWND) -> Option<Rc<FrameState>> {
  FRAMES.try_with(|table| table.borrow().get(&(hwnd.0 as isize)).cloned()).ok().flatten()
}

/// Takes `hwnd`'s entry out of the table when it is `state` (not a later
/// frame that was given the same handle value), and removes the procedure.
fn forget_frame(hwnd: HWND, state: &Rc<FrameState>) {
  if state.gone.replace(true) {
    return;
  }
  let _ = FRAMES.try_with(|table| {
    let mut table = table.borrow_mut();
    if table.get(&(hwnd.0 as isize)).is_some_and(|known| Rc::ptr_eq(known, state)) {
      table.remove(&(hwnd.0 as isize));
    }
  });
  // SAFETY: removes this crate's own frame procedure under its own id; on a
  // window that no longer has it the call fails and changes nothing.
  let _removed = unsafe { RemoveWindowSubclass(hwnd, Some(frame_proc), FRAME_SUBCLASS_ID) };
}

/// The messages a tab frame answers itself, beyond every window's subclass:
///
/// - `WM_ERASEBKGND`: the [`Backdrop`]'s two colours, so the strip area never
///   shows the page's colour while the window is resized or before the
///   strip's webview has painted. `tao` paints one colour only.
/// - `WM_DPICHANGED`: the suggested rectangle is applied, as the system asks.
///   `tao` keeps its own size when the scale is unchanged and works one out
///   from the old inner size otherwise.
///
/// Installed as a second subclass procedure of the frame, so the window
/// subclass of every window stays as it is. Dropping it removes the
/// procedure and deletes the brushes; the window's destruction removes it too.
///
/// Not `Send`: it belongs to the window's thread.
pub struct FrameMessages {
  hwnd: HWND,
  state: Rc<FrameState>,
  _not_send: PhantomData<*const ()>,
}

impl FrameMessages {
  /// Starts answering the frame's backdrop and DPI changes.
  pub fn install(window: &impl NativeWindow, backdrop: Backdrop) -> Result<Self, String> {
    let hwnd = window.hwnd();
    if !is_on_this_thread(window) {
      return Err("sweetview: a window of another thread cannot be a tab frame".into());
    }
    if frame_state(hwnd).is_some() {
      return Err("sweetview: this window is a tab frame already".into());
    }
    let state = Rc::new(FrameState { brushes: RefCell::new(Brushes::new(backdrop)?), gone: Cell::new(false) });
    FRAMES.with(|table| table.borrow_mut().insert(hwnd.0 as isize, state.clone()));
    // SAFETY: installs this crate's procedure on a window of this thread (checked
    // above). The procedure finds its state by handle value in a thread-local
    // table, and is removed by `Drop` or on `WM_NCDESTROY`.
    let installed = unsafe { SetWindowSubclass(hwnd, Some(frame_proc), FRAME_SUBCLASS_ID, 0) }.as_bool();
    if !installed {
      forget_frame(hwnd, &state);
      return Err("sweetview: SetWindowSubclass failed".into());
    }
    Ok(Self { hwnd, state, _not_send: PhantomData })
  }

  /// Paints the backdrop in other colours from now on, and repaints it now.
  pub fn set_backdrop(&self, backdrop: Backdrop) -> Result<(), String> {
    if self.state.gone.get() {
      return Ok(());
    }
    let next = Brushes::new(backdrop)?;
    let previous = self.state.brushes.replace(next);
    drop(previous);
    // SAFETY: a window function on the frame this value was installed on (alive:
    // `gone` is set when it is destroyed); no rectangle is passed, so the whole
    // client area is invalidated and erased with the new brushes.
    let _invalidated = unsafe { InvalidateRect(Some(self.hwnd), None, true) };
    Ok(())
  }
}

impl Drop for FrameMessages {
  fn drop(&mut self) {
    forget_frame(self.hwnd, &self.state);
  }
}

/// Fills the strip and the page area of `hwnd`'s client area with the backdrop.
fn paint_backdrop(hwnd: HWND, hdc: HDC, state: &FrameState) -> bool {
  let Some((width, height)) = client_size(hwnd) else { return false };
  let client = RECT { left: 0, top: 0, right: width, bottom: height };
  let scale = f64::from(dpi_of(hwnd)) / 96.0;
  let brushes = state.brushes.borrow();
  let strip = ((f64::from(brushes.strip_height) * scale).round() as i32).clamp(0, client.bottom.max(0));
  let strip_rect = RECT { bottom: strip, ..client };
  let page_rect = RECT { top: strip, ..client };
  for (rect, brush) in [(&strip_rect, &brushes.strip), (&page_rect, &brushes.page)] {
    // SAFETY: `hdc` is the device context the OS passed with this WM_ERASEBKGND, valid for
    // the message; the rectangle is owned by this frame and the brush by `state`, which the
    // borrow of `brushes` keeps alive for the call.
    let _filled = unsafe { FillRect(hdc, rect, brush.brush) };
  }
  true
}

/// What the frame procedure does with one message: `Some` when it is done
/// with it (having forwarded it itself where needed), `None` to forward it.
fn handle_frame(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
  let state = frame_state(hwnd)?;
  match message {
    WM_ERASEBKGND => {
      let hdc = HDC(wparam.0 as *mut c_void);
      // Non-zero: the background is erased.
      paint_backdrop(hwnd, hdc, &state).then_some(LRESULT(1))
    }
    WM_DPICHANGED => {
      let suggested = lparam.0 as *const RECT;
      if suggested.is_null() {
        return None;
      }
      // SAFETY: for WM_DPICHANGED the OS passes a RECT it owns for the duration
      // of the message; it is read once, here, before anything else runs.
      let rect = unsafe { *suggested };
      // `tao` records the new scale (its logical sizes, the default minimum
      // among them, follow it); the suggested rectangle is applied after it.
      let result = forward_frame(hwnd, message, wparam, lparam);
      // The frame this procedure is installed on, moved and sized in one step, keeping its z-order.
      set_window_pos(hwnd, None, Rect::from_edges(rect.left, rect.top, rect.right, rect.bottom), SWP_NOZORDER | SWP_NOACTIVATE);
      Some(result)
    }
    WM_NCDESTROY => {
      forget_frame(hwnd, &state);
      None
    }
    _ => None,
  }
}

/// The frame procedure the OS calls with the arguments of a window message. A
/// safe `extern "system"` function, which `SUBCLASSPROC`'s `unsafe` function
/// pointer type accepts. It never unwinds: its body runs inside `catch_unwind`,
/// and a panic forwards the message unchanged.
extern "system" fn frame_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
  let handled = catch_unwind(AssertUnwindSafe(|| handle_frame(hwnd, message, wparam, lparam))).unwrap_or(None);
  match handled {
    Some(result) => result,
    None => forward_frame(hwnd, message, wparam, lparam),
  }
}

#[cfg(test)]
#[path = "tab_frame_tests.rs"]
mod tests;
