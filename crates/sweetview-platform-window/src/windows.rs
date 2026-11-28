//! Windows: window-level calls on `user32`, `shell32` and `comctl32` that `tao`
//! has no API for, and the subclass that delivers any window's events.
//!
//! Every call here takes a window by a type that names it: a `tao` window this
//! process owns, or a [`BorrowedWindow`] lent for the length of one call,
//! checked with `IsWindow` when it was lent. Window functions validate the
//! handle they are given and fail with `ERROR_INVALID_WINDOW_HANDLE` on one
//! that is gone, so a call on a window someone else destroyed is an error the
//! OS reports, not undefined behaviour.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::num::NonZeroIsize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::time::{Duration, Instant};

use raw_window_handle::{DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use sweetview_window_logic::ico::{parse_ico, pick_ico_entry};
use tao::platform::windows::{MonitorHandleExtWindows, WindowExtWindows};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONULL};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetActiveWindow, GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{DefSubclassProc, DragFinish, DragQueryFileW, RemoveWindowSubclass, SetWindowSubclass, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateIconFromResourceEx, DestroyIcon, DestroyWindow, GetClientRect, GetSystemMetrics, GetWindow, GetWindowLongPtrW,
  GetWindowPlacement, GetWindowRect, WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, LoadIconW, MoveWindow,
  PostMessageW, SendMessageTimeoutW, SendMessageW, SetForegroundWindow, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos,
  SetWindowTextW, SMTO_ABORTIFHUNG, SMTO_BLOCK,
  ShowWindow, GWL_EXSTYLE, GWL_STYLE, GW_CHILD, HICON, HTCAPTION, HWND_NOTOPMOST, HWND_TOPMOST, ICON_BIG, ICON_SMALL,
  IDI_APPLICATION, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LR_DEFAULTCOLOR, LWA_ALPHA, LWA_COLORKEY, SET_WINDOW_POS_FLAGS,
  SHOW_WINDOW_CMD, SIZE_MINIMIZED, SM_CXICON, SM_CXSMICON, STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
  SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SW_SHOW, SW_SHOWNOACTIVATE, WM_ACTIVATE, WM_CLOSE,
  WM_DROPFILES, WM_GETICON, WM_MOVE, WM_NCDESTROY, WM_NCLBUTTONDOWN, WM_NULL, WM_SETICON, WM_SIZE, WM_STYLECHANGING, WS_POPUP,
  WS_THICKFRAME, WS_VISIBLE,
};

use crate::{Chrome, ExStylePolicy, FramePart, HandleCounts, Placement, Rect, ResizeEdge, ShowAs, WindowEvent, ZOrder};

// ---- naming a window ---------------------------------------------------------------

pub(crate) mod sealed {
  /// Gives the crate the handle of a window type it accepts. Not nameable
  /// outside the crate, so no other crate can implement it or call it.
  pub trait Sealed {
    fn hwnd(&self) -> windows::Win32::Foundation::HWND;
  }
}

/// A window the functions of this crate accept: a `tao` window, or a [`BorrowedWindow`].
pub trait NativeWindow: sealed::Sealed {}

impl sealed::Sealed for tao::window::Window {
  fn hwnd(&self) -> HWND {
    HWND(WindowExtWindows::hwnd(self) as *mut c_void)
  }
}
impl NativeWindow for tao::window::Window {}

/// A window lent for as long as `'a`: by [`BorrowedWindow::with_handle_value`]
/// for the length of one call, or by [`BorrowedWindow::of`] for as long as a
/// `tao` window is borrowed. It does not own the window and cannot be kept
/// beyond its lifetime, so a window Sweetview did not make is kept as its
/// handle value and lent again for each call.
///
/// The OS validates the handle on every call made with it: a window destroyed
/// meanwhile (by another thread, or by code this call runs) makes those calls
/// fail. Identity, that the value still names the window it named when lent,
/// is checked where it matters: the subclass and the tab frame's procedure
/// compare the state they installed, and a window of this thread is
/// destroyed only by code this thread runs.
///
/// Not `Send`: a window is used from the thread that borrows it.
#[derive(Debug)]
pub struct BorrowedWindow<'a> {
  hwnd: HWND,
  _window: PhantomData<&'a ()>,
  _not_send: PhantomData<*const ()>,
}

impl sealed::Sealed for BorrowedWindow<'_> {
  fn hwnd(&self) -> HWND {
    self.hwnd
  }
}
impl NativeWindow for BorrowedWindow<'_> {}

impl BorrowedWindow<'_> {
  /// Lends the window whose handle value is `value` to `f`, if it names a
  /// window now; `None` (and `f` is not called) otherwise. This is how an
  /// application hands Sweetview a window of its own.
  pub fn with_handle_value<R>(value: isize, f: impl FnOnce(&BorrowedWindow<'_>) -> R) -> Option<R> {
    let hwnd = HWND(value as *mut c_void);
    if value == 0 || !is_window_handle(hwnd) {
      return None;
    }
    Some(f(&BorrowedWindow { hwnd, _window: PhantomData, _not_send: PhantomData }))
  }
}

impl<'a> BorrowedWindow<'a> {
  /// The window of `window`, borrowed for as long as `window` is: for a
  /// borrower that needs [`HasWindowHandle`] or a common type for both kinds.
  pub fn of(window: &'a tao::window::Window) -> Self {
    Self { hwnd: sealed::Sealed::hwnd(window), _window: PhantomData, _not_send: PhantomData }
  }
}

impl HasWindowHandle for BorrowedWindow<'_> {
  fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
    if !is_window_handle(self.hwnd) {
      return Err(HandleError::Unavailable);
    }
    let value = NonZeroIsize::new(self.hwnd.0 as isize).ok_or(HandleError::Unavailable)?;
    let raw = RawWindowHandle::Win32(Win32WindowHandle::new(value));
    // SAFETY: `borrow_raw` asks that the handle name a window for the borrow. `IsWindow`
    // confirmed it just above, and the borrow is tied to `&self`, which is itself lent
    // for one call or for the borrow of a `tao` window. The OS validates the handle on
    // every call its borrowers make with it (`rfd` and `muda` pass it to user32 as an
    // owner, `wry` as a parent), so a window destroyed during the borrow makes those
    // calls fail; it reads no memory through the handle.
    Ok(unsafe { WindowHandle::borrow_raw(raw) })
  }
}

impl HasDisplayHandle for BorrowedWindow<'_> {
  fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
    Ok(DisplayHandle::windows())
  }
}

/// Posts `message` with plain integer parameters to a window named by
/// [`NativeWindow`]. A failure (the window is gone, its queue is full) is not
/// reported: every caller's message is a request the window may miss.
pub(crate) fn post_message(hwnd: HWND, message: u32, wparam: usize) {
  // SAFETY: a posted message with plain integer parameters; the OS validates
  // the handle, and a stale one makes the call fail.
  let _posted = unsafe { PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(0)) };
}

/// The nudge the shell asks for after a popup menu whose owner was made the
/// foreground window for it (KB 135788): a `WM_NULL`, so the next menu closes
/// when the user clicks elsewhere. Every popup menu this crate shows ends with it.
pub(crate) fn after_popup_menu(hwnd: HWND) {
  post_message(hwnd, WM_NULL, 0);
}

fn is_window_handle(hwnd: HWND) -> bool {
  // SAFETY: `IsWindow` accepts any value and only reports whether it names a window.
  unsafe { IsWindow(Some(hwnd)) }.as_bool()
}

/// The window's handle as a number, for JavaScript (`Window.handle`).
pub fn handle_value(window: &impl NativeWindow) -> isize {
  window.hwnd().0 as isize
}

/// True while the window exists.
pub fn is_window(window: &impl NativeWindow) -> bool {
  is_window_handle(window.hwnd())
}

/// True when the window was made by the calling thread, whose message loop
/// dispatches its messages: the only kind a subclass can be installed on.
pub fn is_on_this_thread(window: &impl NativeWindow) -> bool {
  // SAFETY: the handle is only read by the call; no out-pointer is passed.
  let owner = unsafe { GetWindowThreadProcessId(window.hwnd(), None) };
  // SAFETY: `GetCurrentThreadId` has no preconditions.
  let current = unsafe { GetCurrentThreadId() };
  owner != 0 && owner == current
}

// ---- reading a window ----------------------------------------------------------------

/// True while the window is visible. For a window `tao` made, `tao`'s
/// `Window::is_visible` makes the same call.
pub fn is_visible(window: &impl NativeWindow) -> bool {
  // SAFETY: a window function on a handle named by `NativeWindow`; an invalid one reads as not visible.
  unsafe { IsWindowVisible(window.hwnd()) }.as_bool()
}

/// True when the window is this thread's active window.
pub fn is_active(window: &impl NativeWindow) -> bool {
  // SAFETY: `GetActiveWindow` reads this thread's active window and has no preconditions.
  let active = unsafe { GetActiveWindow() };
  active == window.hwnd()
}

/// True while the window is minimised. For a window `tao` made, `tao`'s
/// `Window::is_minimized` makes the same call.
pub fn is_minimized(window: &impl NativeWindow) -> bool {
  is_iconic(window.hwnd())
}

fn is_iconic(hwnd: HWND) -> bool {
  // SAFETY: `IsIconic` takes the handle by value and reads no memory of ours; the OS
  // validates the handle, and an invalid one reads as false.
  unsafe { IsIconic(hwnd) }.as_bool()
}

/// True when the window, minimised, goes back to maximised when it is
/// restored: what its placement keeps, since `IsZoomed` reads false while it
/// is minimised.
pub fn restores_maximized(window: &impl NativeWindow) -> bool {
  let mut placement = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
  // SAFETY: `placement` is an owned, initialised `WINDOWPLACEMENT` whose `length` is its own size,
  // as the call requires, alive for the whole call; the handle is named by `NativeWindow` and
  // validated by the OS, and a stale one makes the call fail, which reads as false.
  let read = unsafe { GetWindowPlacement(window.hwnd(), &mut placement) };
  read.is_ok() && placement.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0
}

/// True while the OS has the window maximised (its own state, not `tao`'s flag).
pub fn is_zoomed(window: &impl NativeWindow) -> bool {
  // SAFETY: a window function on a handle named by `NativeWindow`; an invalid one reads as false.
  unsafe { IsZoomed(window.hwnd()) }.as_bool()
}

/// The outer frame in screen coordinates, or `None` when the window is gone.
pub fn outer_bounds(window: &impl NativeWindow) -> Option<Rect> {
  outer_bounds_of(window.hwnd())
}

fn outer_bounds_of(hwnd: HWND) -> Option<Rect> {
  let mut rect = RECT::default();
  // SAFETY: `rect` is a RECT owned by this frame for the call to fill.
  unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
  Some(Rect::from_edges(rect.left, rect.top, rect.right, rect.bottom))
}

/// The window's DPI over 96: 1 at 100 %, 1.5 at 150 %.
pub fn dpi_scale(window: &impl NativeWindow) -> f64 {
  f64::from(dpi_of(window.hwnd())) / 96.0
}

/// The window's DPI; 96 when the OS reports none (an invalid handle).
pub(crate) fn dpi_of(hwnd: HWND) -> u32 {
  // SAFETY: `GetDpiForWindow` takes the handle by value and reads no memory of ours; the OS
  // validates the handle, and an invalid one returns 0.
  match unsafe { GetDpiForWindow(hwnd) } {
    0 => 96,
    dpi => dpi,
  }
}

fn style_of(hwnd: HWND, index: windows::Win32::UI::WindowsAndMessaging::WINDOW_LONG_PTR_INDEX) -> isize {
  // SAFETY: reads one window long of a handle named by `NativeWindow`; an invalid one returns 0.
  unsafe { GetWindowLongPtrW(hwnd, index) }
}

/// Writes the style (`GWL_STYLE`) or extended style (`GWL_EXSTYLE`) of a
/// window and returns the previous value. Any other index writes nothing and
/// returns 0: those longs hold pointers (the window procedure, user data).
pub(crate) fn set_style_of(hwnd: HWND, index: windows::Win32::UI::WindowsAndMessaging::WINDOW_LONG_PTR_INDEX, value: isize) -> isize {
  if index != GWL_STYLE && index != GWL_EXSTYLE {
    return 0;
  }
  // SAFETY: writes one of the two style longs (checked above), which hold bit flags and no
  // pointer, of a handle the OS validates; an invalid one makes the call fail and write nothing.
  unsafe { SetWindowLongPtrW(hwnd, index, value) }
}

/// The extended style, `GWL_EXSTYLE`.
pub fn ex_style(window: &impl NativeWindow) -> u32 {
  style_of(window.hwnd(), GWL_EXSTYLE) as u32
}

/// The style, `GWL_STYLE`.
pub fn style(window: &impl NativeWindow) -> u32 {
  style_of(window.hwnd(), GWL_STYLE) as u32
}

/// What a window's style says of its chrome: a popup has no frame, a thick
/// frame can be dragged to resize.
pub fn chrome(window: &impl NativeWindow) -> Chrome {
  let style = style(window);
  Chrome { frame: style & WS_POPUP.0 == 0, resizable: style & WS_THICKFRAME.0 != 0 }
}

// ---- changing a window -----------------------------------------------------------------

pub(crate) fn set_window_pos(hwnd: HWND, after: Option<HWND>, rect: Rect, flags: SET_WINDOW_POS_FLAGS) -> bool {
  // SAFETY: a window function on a handle named by `NativeWindow`, with an
  // insert-after value that is either none or one of the HWND_* constants.
  unsafe { SetWindowPos(hwnd, after, rect.x, rect.y, rect.width, rect.height, flags) }.is_ok()
}

/// Moves, sizes and re-orders the outer frame as `placement` says, in one
/// `SetWindowPos`, without activating the window. False when the OS refused.
///
/// `tao` sets an outer position (asynchronously, `SWP_ASYNCWINDOWPOS`) and an
/// inner size as two calls, and its topmost flag through a style rewrite; a
/// window dragged by its left or top edge must move and resize in one step (D8).
pub fn set_placement(window: &impl NativeWindow, placement: Placement) -> bool {
  let mut flags = SWP_NOACTIVATE;
  if placement.position.is_none() {
    flags |= SWP_NOMOVE;
  }
  if placement.size.is_none() {
    flags |= SWP_NOSIZE;
  }
  if placement.frame_changed {
    flags |= SWP_FRAMECHANGED;
  }
  let after = match placement.z {
    ZOrder::Keep => {
      flags |= SWP_NOZORDER;
      None
    }
    ZOrder::Topmost => Some(HWND_TOPMOST),
    ZOrder::NotTopmost => Some(HWND_NOTOPMOST),
  };
  let position = placement.position.unwrap_or_default();
  let (width, height) = placement.size.unwrap_or((0, 0));
  set_window_pos(window.hwnd(), after, Rect::new(position.x, position.y, width, height), flags)
}

fn show_window(hwnd: HWND, command: SHOW_WINDOW_CMD) {
  // SAFETY: a window function on a handle named by `NativeWindow`. The result
  // is the previous visibility, not an error.
  let _was_visible = unsafe { ShowWindow(hwnd, command) };
}

/// Brings a window that is not topmost to the front and gives it the
/// foreground, the way `show()` has always done it: a moment in the topmost
/// band lifts it above everything, then it goes back to the normal band.
pub fn bring_to_front(window: &impl NativeWindow) {
  let hwnd = window.hwnd();
  let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
  set_window_pos(hwnd, Some(HWND_TOPMOST), Rect::default(), flags);
  set_window_pos(hwnd, Some(HWND_NOTOPMOST), Rect::default(), flags);
  set_foreground(hwnd);
}

/// `show()`: a minimised window is restored, otherwise it is shown, either
/// without activation for `no_activate` (as at tag `pre-rust-rewrite`'s tab
/// frame); then, unless it must not activate or is
/// topmost, it is brought to the front. Every window goes through it, a `tao`
/// window included: `tao`'s `set_visible` shows with `SW_SHOW`, which
/// activates even a `WS_EX_NOACTIVATE` window (D9).
pub fn show(window: &impl NativeWindow, no_activate: bool, topmost: bool) {
  if is_minimized(window) {
    // `SW_SHOWNOACTIVATE` restores a minimised window too, without activating it.
    show_window(window.hwnd(), if no_activate { SW_SHOWNOACTIVATE } else { SW_RESTORE });
  } else {
    show_window(window.hwnd(), if no_activate { SW_SHOWNOACTIVATE } else { SW_SHOW });
  }
  if !no_activate && !topmost {
    bring_to_front(window);
  }
}

/// Puts a window `tao` did not make in a show state (`ShowWindow`). A `tao`
/// window goes through `tao`'s `set_visible`, `set_minimized` and
/// `set_maximized`, which keep `tao`'s own flags in step.
pub fn show_as(window: &impl NativeWindow, state: ShowAs) {
  let command = match state {
    ShowAs::Hidden => SW_HIDE,
    ShowAs::Minimized => SW_MINIMIZE,
    ShowAs::Maximized => SW_MAXIMIZE,
    ShowAs::Restored => SW_RESTORE,
  };
  show_window(window.hwnd(), command);
}

/// Sets the title bar text of a window `tao` did not make (`tao`'s
/// `set_title` makes the same call for its own).
pub fn set_title(window: &impl NativeWindow, title: &str) -> bool {
  let wide: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
  // SAFETY: `wide` is a NUL-terminated UTF-16 buffer owned by this frame for the whole call.
  unsafe { SetWindowTextW(window.hwnd(), PCWSTR(wide.as_ptr())) }.is_ok()
}

/// Hands the left button's press to the OS as a press on `part` of the frame:
/// the move loop for the caption, the size loop for an edge. Returns when the
/// loop ends (the button is released), unlike `tao`'s `drag_window` and
/// `drag_resize_window`, which post the press and return at once.
pub fn press_frame(window: &impl NativeWindow, part: FramePart) {
  let hit = match part {
    FramePart::Caption => HTCAPTION,
    FramePart::Edge(ResizeEdge::Left) => 10,
    FramePart::Edge(ResizeEdge::Right) => 11,
    FramePart::Edge(ResizeEdge::Top) => 12,
    FramePart::Edge(ResizeEdge::TopLeft) => 13,
    FramePart::Edge(ResizeEdge::TopRight) => 14,
    FramePart::Edge(ResizeEdge::Bottom) => 15,
    FramePart::Edge(ResizeEdge::BottomLeft) => 16,
    FramePart::Edge(ResizeEdge::BottomRight) => 17,
  };
  // SAFETY: `ReleaseCapture` takes nothing and has no preconditions; it fails only when nothing holds the capture.
  let _released = unsafe { ReleaseCapture() };
  // SAFETY: a window message with plain integer parameters (no pointer in either) to a handle
  // named by `NativeWindow`, which the OS validates; a stale one makes the call fail.
  let _result = unsafe { SendMessageW(window.hwnd(), WM_NCLBUTTONDOWN, Some(WPARAM(hit as usize)), Some(LPARAM(0))) };
}

/// Resizes the window's first child to fill its client area, as a window
/// procedure does for the one widget it hosts.
pub fn fill_first_child(window: &impl NativeWindow) {
  fill_first_child_of(window.hwnd());
}

fn fill_first_child_of(hwnd: HWND) {
  // SAFETY: a window function on a handle named by `NativeWindow`; no child is an error result.
  let Ok(child) = (unsafe { GetWindow(hwnd, GW_CHILD) }) else { return };
  let Some((width, height)) = client_size(hwnd) else { return };
  // SAFETY: `child` was just returned by `GetWindow` as a child of this thread's window.
  let _moved = unsafe { MoveWindow(child, 0, 0, width, height, true) };
}

/// The width and height of the window's client area, or `None` when the window is gone.
pub(crate) fn client_size(hwnd: HWND) -> Option<(i32, i32)> {
  let mut client = RECT::default();
  // SAFETY: `client` is a RECT owned by this frame for the call to fill; the OS validates the handle.
  unsafe { GetClientRect(hwnd, &mut client) }.ok()?;
  Some((client.right, client.bottom))
}

/// Sets the extended style to what `policy` decides for it. A window with a
/// [`WindowSubclass`] keeps it that way through later changes.
pub fn apply_ex_style(window: &impl NativeWindow, policy: &ExStylePolicy) {
  apply_ex_style_to(window.hwnd(), policy);
}

fn apply_ex_style_to(hwnd: HWND, policy: &ExStylePolicy) {
  let current = style_of(hwnd, GWL_EXSTYLE) as u32;
  let wanted = policy.apply(current);
  if wanted != current {
    // The current style with bits the policy decides changed.
    let _previous = set_style_of(hwnd, GWL_EXSTYLE, wanted as isize);
  }
}

/// `colorKey` and `opacity` of a layered window. The window must already be
/// layered (`ExStylePolicy::layered`). `color_key` is a `COLORREF`.
pub fn set_layered_attributes(window: &impl NativeWindow, color_key: Option<u32>, opacity: Option<f64>) -> Result<(), String> {
  let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
  if color_key.is_some() {
    flags |= LWA_COLORKEY;
  }
  if opacity.is_some() {
    flags |= LWA_ALPHA;
  }
  let alpha = (opacity.unwrap_or(1.0).clamp(0.0, 1.0) * 255.0).round() as u8;
  // SAFETY: a window function on a handle named by `NativeWindow`, with plain values.
  unsafe { SetLayeredWindowAttributes(window.hwnd(), COLORREF(color_key.unwrap_or(0)), alpha, flags) }
    .map_err(|e| format!("sweetview: SetLayeredWindowAttributes failed: {e}"))
}

/// Destroys a window this process made through `tao` now, rather than when
/// `tao` gets to its own deferred destroy, and drops the `tao` window.
pub fn destroy_now(window: tao::window::Window) {
  let hwnd = sealed::Sealed::hwnd(&window);
  // SAFETY: `tao` made this window on this thread (its windows are made on the loop's
  // thread, which is the UI thread, and `DestroyWindow` refuses another thread's window).
  // `window` is taken by value and dropped at the end of this function, so no later call
  // names the handle through it; `tao`'s own deferred destroy finds the window gone.
  let _destroyed = unsafe { DestroyWindow(hwnd) };
  drop(window);
}

// ---- style and bounds across a change made by someone else ---------------------------

/// A window's styles and outer bounds at one moment, for `preserveGeometry`:
/// mounting a webview may restyle or move the window it mounts into. The
/// default is a snapshot of nothing, which restores nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GeometrySnapshot {
  taken: bool,
  style: isize,
  ex_style: isize,
  bounds: Option<Rect>,
}

impl GeometrySnapshot {
  pub fn take(window: &impl NativeWindow) -> Self {
    let hwnd = window.hwnd();
    Self { taken: true, style: style_of(hwnd, GWL_STYLE), ex_style: style_of(hwnd, GWL_EXSTYLE), bounds: outer_bounds_of(hwnd) }
  }

  /// Puts back whatever changed, and lays the first child out to fill the client area.
  pub fn restore(&self, window: &impl NativeWindow) {
    let hwnd = window.hwnd();
    if !self.taken || !is_window_handle(hwnd) {
      return;
    }
    let mut style_changed = false;
    for (index, before) in [(GWL_STYLE, self.style), (GWL_EXSTYLE, self.ex_style)] {
      if style_of(hwnd, index) != before {
        // Writes back a style value this same window had when the snapshot was taken.
        let _previous = set_style_of(hwnd, index, before);
        style_changed = true;
      }
    }
    if let Some(before) = self.bounds {
      if style_changed || outer_bounds_of(hwnd) != Some(before) {
        let frame = if style_changed { SWP_FRAMECHANGED } else { SET_WINDOW_POS_FLAGS(0) };
        set_window_pos(hwnd, None, before, SWP_NOZORDER | SWP_NOACTIVATE | frame);
      }
    }
    fill_first_child_of(hwnd);
  }
}

// ---- icons ---------------------------------------------------------------------------------

/// An icon this crate made, destroyed on drop.
#[derive(Debug)]
struct OwnedIcon(HICON);

impl Drop for OwnedIcon {
  fn drop(&mut self) {
    // SAFETY: `self.0` was made by `CreateIconFromResourceEx` for this value alone and is
    // destroyed only here; an `OwnedIcon` is dropped only once no window shows it
    // (`WindowIcons`' drop parks it until then).
    let _destroyed = unsafe { DestroyIcon(self.0) };
  }
}

/// The caption and taskbar icons a window shows.
///
/// The window draws from them for as long as it shows them, so dropping a
/// `WindowIcons` never destroys an icon a live window still shows: the icons
/// are parked, by the window's handle value, until the window is gone or
/// shows other icons, and destroyed at the next [`WindowIcons::set`] of any
/// window of this thread after that. An adopted window released while it shows icons
/// Sweetview gave it keeps valid icons for its whole life.
///
/// Not `Send`: icons are set and destroyed on the window's thread.
#[derive(Debug)]
pub struct WindowIcons {
  /// The window the icons were given to, as a number (it is not owned).
  window: isize,
  small: Option<OwnedIcon>,
  big: Option<OwnedIcon>,
}

thread_local! {
  /// Icons whose `WindowIcons` was dropped while their window still showed them.
  static PARKED: RefCell<Vec<WindowIcons>> = const { RefCell::new(Vec::new()) };
}

/// `WM_SETICON` (with `icon`) or `WM_GETICON` (with none) for `kind`
/// (`ICON_SMALL`, `ICON_BIG`); the icon the window had or has, 0 for none.
pub(crate) fn icon_message(hwnd: HWND, message: u32, kind: u32, icon: Option<HICON>) -> isize {
  debug_assert!(message == WM_SETICON || message == WM_GETICON);
  let icon = icon.map_or(0, |icon| icon.0 as isize);
  // SAFETY: `WM_SETICON` or `WM_GETICON` to a handle named by `NativeWindow` or a parked
  // window's value, both validated by the OS; the parameters are an integer and an icon
  // handle by value. An icon set here is one `WindowIcons` owns, which keeps it alive while
  // the window shows it (its drop parks it), or the stock icon, which is never destroyed.
  unsafe { SendMessageW(hwnd, message, Some(WPARAM(kind as usize)), Some(LPARAM(icon))) }.0
}

/// An icon from `.ico` bytes at `size` pixels; the stock application icon when there are none.
fn load_icon(ico: Option<&[u8]>, size: i32) -> Result<(HICON, Option<OwnedIcon>), String> {
  if let Some(bytes) = ico {
    let entry = pick_ico_entry(&parse_ico(bytes)?, size as u32)?;
    let image = &bytes[entry.offset..entry.offset + entry.size];
    // SAFETY: `image` is a slice of the caller's bytes, alive for the whole call;
    // the OS copies what it needs into the icon it returns.
    match unsafe { CreateIconFromResourceEx(image, true, 0x0003_0000, size, size, LR_DEFAULTCOLOR) } {
      Ok(icon) => return Ok((icon, Some(OwnedIcon(icon)))),
      Err(e) => eprintln!("sweetview: CreateIconFromResourceEx failed ({e}); using the default icon"),
    }
  }
  // SAFETY: a stock icon by its predefined id; the OS owns it and it is never destroyed.
  let stock = unsafe { LoadIconW(None, IDI_APPLICATION) }.map_err(|e| format!("sweetview: LoadIconW failed: {e}"))?;
  Ok((stock, None))
}

pub(crate) fn metric(index: windows::Win32::UI::WindowsAndMessaging::SYSTEM_METRICS_INDEX, fallback: i32) -> i32 {
  // SAFETY: `GetSystemMetrics` reads a system value and has no preconditions.
  match unsafe { GetSystemMetrics(index) } {
    0 => fallback,
    value => value,
  }
}

impl WindowIcons {
  /// Sets the window's small and large icons from `.ico` bytes, each from the
  /// image closest to its size, or back to the stock icon for `None`. Keep the
  /// result while the window should show them; dropping it is always safe.
  ///
  /// `tao`'s `Window::set_window_icon` and `WindowExtWindows::set_taskbar_icon`
  /// set the same two icons of a window `tao` made, but from an RGBA image at
  /// one size each (`Icon::from_rgba`, drawn with `CreateIcon`): the `.ico`'s
  /// best entry for each size would have to be decoded (PNG or bitmap with its
  /// mask) and scaled in this project instead of by `CreateIconFromResourceEx`,
  /// `None` would clear the icons instead of setting the stock one, and an
  /// adopted window has no `tao` window. So every window goes through here.
  pub fn set(window: &impl NativeWindow, ico: Option<&[u8]>) -> Result<Self, String> {
    sweep_parked_icons();
    let (small, small_owned) = load_icon(ico, metric(SM_CXSMICON, 16))?;
    let (big, big_owned) = load_icon(ico, metric(SM_CXICON, 32))?;
    let icons = Self { window: handle_value(window), small: small_owned, big: big_owned };
    for (kind, icon) in [(ICON_SMALL, small), (ICON_BIG, big)] {
      let _previous = icon_message(window.hwnd(), WM_SETICON, kind, Some(icon));
    }
    Ok(icons)
  }

  /// True while the window still exists and shows one of these icons, or does
  /// not answer the question: a window lent by its handle value may belong to
  /// another process, and one that is hung or slow keeps its icons parked.
  /// Asks no later than `until`: a window not asked in time counts as still showing them.
  fn still_shown(&self, until: Instant) -> bool {
    let hwnd = HWND(self.window as *mut c_void);
    if !is_window_handle(hwnd) {
      return false;
    }
    let shows = |kind, mine: &Option<OwnedIcon>| {
      mine.as_ref().is_some_and(|icon| shown_icon(hwnd, kind, until).is_none_or(|shown| shown == icon.0 .0 as isize))
    };
    shows(ICON_SMALL, &self.small) || shows(ICON_BIG, &self.big)
  }
}

/// How long a parked window may take to answer `WM_GETICON`.
const ICON_QUERY_MS: u32 = 100;

/// How long one sweep of the parked icons may spend asking in all (D41): with many slow parked
/// windows the sweep stops asking at this bound, and the windows it did not ask keep their icons
/// parked until a later sweep.
const SWEEP_BUDGET: Duration = Duration::from_millis(200);

/// The icon `hwnd` answers `WM_GETICON` with for `kind`, or `None` when it did not answer
/// within [`ICON_QUERY_MS`] or by `until`, or the OS reports its thread hung, so no `setIcon`
/// waits on a window of another process. A window of this thread answers at once, as a plain
/// send does.
fn shown_icon(hwnd: HWND, kind: u32, until: Instant) -> Option<isize> {
  let left = u32::try_from(until.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(u32::MAX);
  if left == 0 {
    return None;
  }
  let mut shown = 0usize;
  // SAFETY: `WM_GETICON` carries an integer each way; `hwnd` is a parked window's value, which
  // the OS validates; `shown` is a usize owned by this frame for the call to fill. `SMTO_BLOCK`
  // keeps this thread from handling other messages while it waits, so nothing runs re-entrantly.
  let answered = unsafe {
    SendMessageTimeoutW(hwnd, WM_GETICON, WPARAM(kind as usize), LPARAM(0), SMTO_ABORTIFHUNG | SMTO_BLOCK, left.min(ICON_QUERY_MS), Some(&mut shown))
  };
  (answered.0 != 0).then_some(shown as isize)
}

/// Destroys the parked icons whose window is gone or shows other icons now.
fn sweep_parked_icons() {
  let done: Vec<WindowIcons> = PARKED
    .try_with(|parked| {
      let mut parked = parked.borrow_mut();
      let until = Instant::now() + SWEEP_BUDGET;
      let (keep, done): (Vec<_>, Vec<_>) = parked.drain(..).partition(|icons| icons.still_shown(until));
      *parked = keep;
      done
    })
    .unwrap_or_default();
  // Dropped outside the borrow; each has nothing left to park.
  drop(done);
}

impl Drop for WindowIcons {
  fn drop(&mut self) {
    if self.small.is_none() && self.big.is_none() {
      return;
    }
    if !self.still_shown(Instant::now() + Duration::from_millis(u64::from(ICON_QUERY_MS))) {
      // `small` and `big` are destroyed as this value's fields drop.
      return;
    }
    let mut parked = Some(WindowIcons { window: self.window, small: self.small.take(), big: self.big.take() });
    let _ = PARKED.try_with(|list| list.borrow_mut().extend(parked.take()));
    if let Some(left) = parked {
      // The thread is ending and its storage is gone: the icons are left to the
      // process's end rather than destroyed under a window that shows them.
      std::mem::forget(left);
    }
  }
}

// ---- input and screens -----------------------------------------------------------------------

fn key_down(key: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY) -> bool {
  // SAFETY: `GetAsyncKeyState` reads the state of a virtual key and has no preconditions.
  let state = unsafe { GetAsyncKeyState(i32::from(key.0)) };
  state < 0
}

/// True while the left, right or middle mouse button is down.
pub fn mouse_buttons_down() -> bool {
  key_down(VK_LBUTTON) || key_down(VK_RBUTTON) || key_down(VK_MBUTTON)
}

/// True while the left mouse button is down.
pub fn left_button_down() -> bool {
  key_down(VK_LBUTTON)
}

/// The one of `monitors` the OS has the window on (`MonitorFromWindow`): the one its frame overlaps
/// most, else the nearest, and for a minimised window the one its restored position is on. `None`
/// when the handle names no window or the monitor is not among `monitors`.
pub fn monitor_of(window: &impl NativeWindow, monitors: impl IntoIterator<Item = tao::monitor::MonitorHandle>) -> Option<tao::monitor::MonitorHandle> {
  // SAFETY: `MonitorFromWindow` takes the handle by value and reads no memory of ours; the OS
  // validates the handle, and with `MONITOR_DEFAULTTONULL` an invalid one answers null.
  let monitor = unsafe { MonitorFromWindow(window.hwnd(), MONITOR_DEFAULTTONULL) };
  if monitor.is_invalid() {
    return None;
  }
  monitors.into_iter().find(|m| m.hmonitor() == monitor.0 as isize)
}

/// The part of a monitor windows should use: its bounds less the taskbar.
pub fn work_area(monitor: &tao::monitor::MonitorHandle) -> Option<Rect> {
  let hmonitor = HMONITOR(monitor.hmonitor() as *mut c_void);
  let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
  // SAFETY: `info` is a MONITORINFO owned by this frame with `cbSize` set, and
  // the monitor handle comes from `tao`, which got it from the OS.
  if !unsafe { GetMonitorInfoW(hmonitor, &mut info) }.as_bool() {
    return None;
  }
  let r = info.rcWork;
  Some(Rect::from_edges(r.left, r.top, r.right, r.bottom))
}

/// The process's handle counts, for the tests that check every handle is given back.
pub fn handle_counts() -> HandleCounts {
  sweetview_platform_loop::resource_counts()
}

// ---- the subclass ------------------------------------------------------------------------------

/// The id this crate's subclass is installed under.
const SUBCLASS_ID: usize = 0x5357; // "SW"

type Handler = Rc<dyn Fn(&WindowEvent) -> bool>;

struct SubclassState {
  handler: Handler,
  policy: Cell<ExStylePolicy>,
  fill_child: Cell<bool>,
  hold_visibility: Cell<bool>,
  /// `GWL_STYLE` bits kept on through every style rewrite.
  forced_style: Cell<u32>,
  /// Set once the window is destroyed and the subclass removed (`WM_NCDESTROY`).
  gone: Cell<bool>,
}

thread_local! {
  /// The state of each subclassed window of this thread, by handle value. The
  /// subclass procedure finds its state here, so no pointer rides in the window.
  static SUBCLASSES: RefCell<HashMap<isize, Rc<SubclassState>>> = RefCell::new(HashMap::new());
}

fn state_of(hwnd: HWND) -> Option<Rc<SubclassState>> {
  // `try_with`: a message can arrive while the thread's storage is being torn down.
  SUBCLASSES.try_with(|table| table.borrow().get(&(hwnd.0 as isize)).cloned()).ok().flatten()
}

/// Takes `hwnd`'s entry out of the table when it is `state` (not a later
/// window that was given the same handle value), removes the procedure, and
/// marks the state gone. Does nothing the second time.
fn forget_subclass(hwnd: HWND, state: &Rc<SubclassState>) {
  if state.gone.replace(true) {
    return;
  }
  let _ = SUBCLASSES.try_with(|table| {
    let mut table = table.borrow_mut();
    if table.get(&(hwnd.0 as isize)).is_some_and(|known| Rc::ptr_eq(known, state)) {
      table.remove(&(hwnd.0 as isize));
    }
  });
  // SAFETY: removes this crate's own procedure under its own id from the window `state` was
  // installed on, which still exists: `gone` was not set, and it is set on `WM_NCDESTROY`.
  let _removed = unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) };
}

/// The events of one window, delivered by subclassing it. Dropping it removes
/// the subclass; the window's own destruction removes it too, after a last
/// [`WindowEvent::Destroyed`]. Once the window is gone, every method does
/// nothing: the handle value it was installed on may name another window by then.
///
/// Not `Send`: a subclass belongs to the window's thread.
pub struct WindowSubclass {
  /// The window the subclass is installed on: the key of the registration this value owns.
  hwnd: HWND,
  /// The state it installed, which says whether the window is gone.
  state: Rc<SubclassState>,
  _not_send: PhantomData<*const ()>,
}

impl WindowSubclass {
  /// Subclasses `window`. `handler` runs for each event from inside whichever
  /// message loop dispatched it; for [`WindowEvent::CloseRequested`] it
  /// returns whether it took the request (the window then stays open). A
  /// handler that panics is caught and counts as `false`.
  pub fn install(window: &impl NativeWindow, handler: impl Fn(&WindowEvent) -> bool + 'static) -> Result<Self, String> {
    let hwnd = window.hwnd();
    if !is_on_this_thread(window) {
      return Err("sweetview: a window of another thread cannot be observed".into());
    }
    if state_of(hwnd).is_some() {
      return Err("sweetview: this window is subclassed already".into());
    }
    let state = Rc::new(SubclassState {
      handler: Rc::new(handler),
      policy: Cell::new(ExStylePolicy::default()),
      fill_child: Cell::new(false),
      hold_visibility: Cell::new(false),
      forced_style: Cell::new(0),
      gone: Cell::new(false),
    });
    SUBCLASSES.with(|table| table.borrow_mut().insert(hwnd.0 as isize, state.clone()));
    // SAFETY: installs this crate's procedure on a window of this thread (checked
    // above). The procedure finds its state by handle value in a thread-local
    // table and is removed by `Drop` or on `WM_NCDESTROY`.
    let installed = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) }.as_bool();
    if !installed {
      state.gone.set(true);
      let _ = SUBCLASSES.try_with(|table| table.borrow_mut().remove(&(hwnd.0 as isize)));
      return Err("sweetview: SetWindowSubclass failed".into());
    }
    Ok(Self { hwnd, state, _not_send: PhantomData })
  }

  /// The window, while it exists: `None` once it is destroyed.
  fn live_hwnd(&self) -> Option<HWND> {
    (!self.state.gone.get()).then_some(self.hwnd)
  }

  /// The extended-style policy in force.
  pub fn policy(&self) -> ExStylePolicy {
    self.state.policy.get()
  }

  /// Sets the extended-style policy and applies it now. Every later style
  /// change, by anyone, passes through it.
  pub fn set_policy(&self, policy: ExStylePolicy) {
    self.state.policy.set(policy);
    if let Some(hwnd) = self.live_hwnd() {
      apply_ex_style_to(hwnd, &policy);
    }
  }

  /// When on, a rewrite of the window's style (`SetWindowLongPtr(GWL_STYLE)`)
  /// never changes `WS_VISIBLE`: visibility changes only through `ShowWindow`.
  /// `tao` writes the style from its own idea of the window's visibility, which
  /// is stale after a show it did not make.
  pub fn set_hold_visibility(&self, on: bool) {
    self.state.hold_visibility.set(on);
  }

  /// Keeps the `GWL_STYLE` bits `bits` on from now on, through every later
  /// rewrite of the style (by `tao` or anyone), and turns them on now.
  pub fn force_style(&self, bits: u32) {
    self.state.forced_style.set(bits);
    let Some(hwnd) = self.live_hwnd() else { return };
    let current = style_of(hwnd, GWL_STYLE) as u32;
    if current & bits != bits {
      // The current style with `bits` added, on the window this subclass is installed on.
      let _previous = set_style_of(hwnd, GWL_STYLE, (current | bits) as isize);
    }
  }

  /// When on, each resize also lays the window's first child out to fill the
  /// client area: the widget of a webview mounted in it.
  pub fn set_fill_child(&self, on: bool) {
    self.state.fill_child.set(on);
  }
}

impl Drop for WindowSubclass {
  fn drop(&mut self) {
    // Nothing to do when the window was destroyed first.
    forget_subclass(self.hwnd, &self.state);
  }
}

/// A file drop the OS handed this window; finished (freed) on drop.
struct Drop_(HDROP);

impl Drop for Drop_ {
  fn drop(&mut self) {
    // SAFETY: the `HDROP` of a `WM_DROPFILES` belongs to the window that
    // receives it, which must finish it once; this value is made once per message.
    unsafe { DragFinish(self.0) };
  }
}

impl Drop_ {
  /// `DragQueryFileW`: the file count for index `u32::MAX`; a path's length in
  /// characters with no buffer; the characters copied into `buffer` otherwise.
  fn query(&self, index: u32, buffer: Option<&mut [u16]>) -> u32 {
    // SAFETY: `self.0` is the drop of the message being handled, finished only in this
    // value's `Drop`; `buffer` is none or a slice whose length the call takes from it.
    unsafe { DragQueryFileW(self.0, index, buffer) }
  }

  fn paths(&self) -> Vec<String> {
    let count = self.query(u32::MAX, None);
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
      let length = self.query(index, None);
      let mut buffer = vec![0u16; length as usize + 1];
      let copied = self.query(index, Some(&mut buffer)) as usize;
      if copied > 0 {
        paths.push(String::from_utf16_lossy(&buffer[..copied.min(buffer.len())]));
      }
    }
    paths
  }
}

fn deliver(state: &SubclassState, event: &WindowEvent) -> bool {
  catch_unwind(AssertUnwindSafe(|| (state.handler)(event))).unwrap_or(false)
}

/// Makes `hwnd` the foreground window. The OS may refuse the foreground to a
/// process that does not hold it; that is not an error.
pub(crate) fn set_foreground(hwnd: HWND) {
  // SAFETY: takes the handle by value and reads no memory of ours; the OS validates the handle.
  let _granted = unsafe { SetForegroundWindow(hwnd) };
}

/// Passes a message the OS gave a subclass procedure on to the next procedure
/// in the window's chain, whichever subclass of this crate received it.
pub(crate) fn forward(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  // SAFETY: passes the message the OS gave the subclass procedure on to the next procedure in the chain.
  unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// The `STYLESTRUCT` of a `WM_STYLECHANGING` the OS passed to the subclass
/// procedure, borrowed for as long as `lparam`, the procedure's own argument,
/// is: the duration of the message. `None` for any other message or a null one.
fn style_change(message: u32, lparam: &mut LPARAM) -> Option<&mut STYLESTRUCT> {
  let change = lparam.0 as *mut STYLESTRUCT;
  if message != WM_STYLECHANGING || change.is_null() {
    return None;
  }
  // SAFETY: for WM_STYLECHANGING the OS passes a STYLESTRUCT it owns, aligned and valid for
  // the duration of the message, and reads `styleNew` back after the procedure returns; the
  // borrow is tied to `lparam`, the procedure's argument, so it cannot outlive the message,
  // and nothing else touches the struct meanwhile.
  Some(unsafe { &mut *change })
}

/// What the procedure does with one message: `Some` when it is done with it
/// (having forwarded it itself where needed), `None` to forward it.
fn handle(hwnd: HWND, message: u32, wparam: WPARAM, mut lparam: LPARAM) -> Option<LRESULT> {
  let state = state_of(hwnd)?;
  match message {
    WM_SIZE => {
      let result = forward(hwnd, message, wparam, lparam);
      if wparam.0 != SIZE_MINIMIZED as usize {
        if state.fill_child.get() {
          fill_first_child_of(hwnd);
        }
        if let Some(bounds) = outer_bounds_of(hwnd) {
          deliver(&state, &WindowEvent::Resized(bounds));
        }
      }
      Some(result)
    }
    WM_MOVE => {
      let result = forward(hwnd, message, wparam, lparam);
      if !is_iconic(hwnd) {
        if let Some(bounds) = outer_bounds_of(hwnd) {
          deliver(&state, &WindowEvent::Moved(bounds));
        }
      }
      Some(result)
    }
    WM_CLOSE => deliver(&state, &WindowEvent::CloseRequested).then_some(LRESULT(0)),
    WM_ACTIVATE => {
      let result = forward(hwnd, message, wparam, lparam);
      // The low word is WA_INACTIVE (0), WA_ACTIVE or WA_CLICKACTIVE.
      deliver(&state, &WindowEvent::Activated(wparam.0 & 0xffff != 0));
      Some(result)
    }
    WM_DROPFILES => {
      if state.policy.get().accept_files != Some(true) {
        return None;
      }
      let drop = Drop_(HDROP(wparam.0 as *mut c_void));
      let paths = drop.paths();
      std::mem::drop(drop);
      if !paths.is_empty() {
        deliver(&state, &WindowEvent::FilesDropped(paths));
      }
      Some(LRESULT(0))
    }
    WM_STYLECHANGING if wparam.0 as i32 == GWL_EXSTYLE.0 => {
      if let Some(change) = style_change(message, &mut lparam) {
        // The OS reads `styleNew` back after the message returns.
        change.styleNew = state.policy.get().apply(change.styleNew);
      }
      None
    }
    WM_STYLECHANGING if wparam.0 as i32 == GWL_STYLE.0 && (state.hold_visibility.get() || state.forced_style.get() != 0) => {
      if let Some(change) = style_change(message, &mut lparam) {
        let mut held = change.styleNew | state.forced_style.get();
        if state.hold_visibility.get() {
          held = (held & !WS_VISIBLE.0) | (change.styleOld & WS_VISIBLE.0);
        }
        // The OS reads `styleNew` back after the message returns.
        change.styleNew = held;
      }
      None
    }
    WM_NCDESTROY => {
      forget_subclass(hwnd, &state);
      deliver(&state, &WindowEvent::Destroyed);
      None
    }
    _ => None,
  }
}

/// The subclass procedure the OS calls with the arguments of a window message.
/// A safe `extern "system"` function, which `SUBCLASSPROC`'s `unsafe` function
/// pointer type accepts. It never unwinds: its body runs inside `catch_unwind`,
/// and a panic forwards the message unchanged.
extern "system" fn subclass_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
  let handled = catch_unwind(AssertUnwindSafe(|| handle(hwnd, message, wparam, lparam))).unwrap_or(None);
  match handled {
    Some(result) => result,
    None => forward(hwnd, message, wparam, lparam),
  }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
pub(crate) mod tests;
