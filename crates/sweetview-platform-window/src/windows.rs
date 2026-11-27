//! Windows: window-level calls on `user32`, `shell32` and `comctl32` that `tao`
//! has no API for, and the subclass that delivers any window's events.
//!
//! Every call here takes a window by a type that names it: a `tao` window this
//! process owns, or a [`ForeignWindow`] checked with `IsWindow` when it was
//! made. Window functions validate the handle they are given and fail with
//! `ERROR_INVALID_WINDOW_HANDLE` on one that is gone, so a call on a window
//! someone else destroyed is an error the OS reports, not undefined behaviour.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::num::NonZeroIsize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use sweetview_window_logic::ico::{parse_ico, pick_ico_entry};
use tao::platform::windows::{MonitorHandleExtWindows, WindowExtWindows};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::System::Threading::{
  GetCurrentProcess, GetCurrentThreadId, GetGuiResources, GetProcessHandleCount, GR_GDIOBJECTS, GR_USEROBJECTS,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, ReleaseCapture, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{DefSubclassProc, DragFinish, DragQueryFileW, RemoveWindowSubclass, SetWindowSubclass, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateIconFromResourceEx, DestroyIcon, DestroyWindow, GetClientRect, GetSystemMetrics, GetWindow, GetWindowLongPtrW,
  GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, LoadIconW, MoveWindow,
  SendMessageW, SetForegroundWindow, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, SetWindowTextW,
  ShowWindow, GWL_EXSTYLE, GWL_STYLE, GW_CHILD, HICON, HTCAPTION, HWND_NOTOPMOST, HWND_TOPMOST, ICON_BIG, ICON_SMALL,
  IDI_APPLICATION, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LR_DEFAULTCOLOR, LWA_ALPHA, LWA_COLORKEY, SET_WINDOW_POS_FLAGS,
  SHOW_WINDOW_CMD, SIZE_MINIMIZED, SM_CXICON, SM_CXSMICON, STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
  SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SW_SHOW, SW_SHOWNOACTIVATE, WM_CLOSE,
  WM_DROPFILES, WM_MOVE, WM_NCDESTROY, WM_NCLBUTTONDOWN, WM_SETICON, WM_SIZE, WM_STYLECHANGING, WS_POPUP, WS_THICKFRAME,
};

use crate::{Chrome, ExStylePolicy, HandleCounts, Rect, WindowEvent};

// ---- naming a window ---------------------------------------------------------------

mod sealed {
  /// Gives the crate the handle of a window type it accepts. Not nameable
  /// outside the crate, so no other crate can implement it or call it.
  pub trait Sealed {
    fn hwnd(&self) -> windows::Win32::Foundation::HWND;
  }
}

/// A window the functions of this crate accept: a `tao` window, or a [`ForeignWindow`].
pub trait NativeWindow: sealed::Sealed {}

impl sealed::Sealed for tao::window::Window {
  fn hwnd(&self) -> HWND {
    HWND(WindowExtWindows::hwnd(self) as *mut c_void)
  }
}
impl NativeWindow for tao::window::Window {}

/// A window by its handle, checked to be a window when it was named. It does
/// not own the window: whoever made it destroys it.
///
/// Not `Send`: a window is used from the thread that names it.
#[derive(Debug, Clone)]
pub struct ForeignWindow {
  hwnd: HWND,
  _not_send: PhantomData<*const ()>,
}

impl sealed::Sealed for ForeignWindow {
  fn hwnd(&self) -> HWND {
    self.hwnd
  }
}
impl NativeWindow for ForeignWindow {}

impl ForeignWindow {
  /// The window whose handle value is `value`, if it names a window now.
  /// This is how an application hands Sweetview a window of its own.
  pub fn from_handle_value(value: isize) -> Option<Self> {
    let hwnd = HWND(value as *mut c_void);
    if value == 0 || !is_window_handle(hwnd) {
      return None;
    }
    Some(Self { hwnd, _not_send: PhantomData })
  }

  /// The same window as `window`, named by handle: for a borrower that needs
  /// [`HasWindowHandle`] without owning the `tao` window.
  pub fn of(window: &impl NativeWindow) -> Self {
    Self { hwnd: window.hwnd(), _not_send: PhantomData }
  }
}

impl HasWindowHandle for ForeignWindow {
  fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
    if !is_window_handle(self.hwnd) {
      return Err(HandleError::Unavailable);
    }
    let value = NonZeroIsize::new(self.hwnd.0 as isize).ok_or(HandleError::Unavailable)?;
    let raw = RawWindowHandle::Win32(Win32WindowHandle::new(value));
    // SAFETY: `borrow_raw` asks that the handle stay a valid window for the
    // borrow. `IsWindow` confirmed it just above, the borrow is tied to
    // `&self`, and `ForeignWindow` is not `Send`, so the borrower is on this
    // thread, where the window can be destroyed only by code this thread runs.
    Ok(unsafe { WindowHandle::borrow_raw(raw) })
  }
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

pub fn is_visible(window: &impl NativeWindow) -> bool {
  // SAFETY: a window function on a handle named by `NativeWindow`; an invalid one reads as not visible.
  unsafe { IsWindowVisible(window.hwnd()) }.as_bool()
}

pub fn is_minimized(window: &impl NativeWindow) -> bool {
  // SAFETY: a window function on a handle named by `NativeWindow`; an invalid one reads as false.
  unsafe { IsIconic(window.hwnd()) }.as_bool()
}

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
  // SAFETY: a window function on a handle named by `NativeWindow`; an invalid one returns 0.
  let dpi = unsafe { GetDpiForWindow(window.hwnd()) };
  if dpi == 0 {
    1.0
  } else {
    f64::from(dpi) / 96.0
  }
}

fn style_of(hwnd: HWND, index: windows::Win32::UI::WindowsAndMessaging::WINDOW_LONG_PTR_INDEX) -> isize {
  // SAFETY: reads one window long of a handle named by `NativeWindow`; an invalid one returns 0.
  unsafe { GetWindowLongPtrW(hwnd, index) }
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

fn set_window_pos(hwnd: HWND, after: Option<HWND>, rect: Rect, flags: SET_WINDOW_POS_FLAGS) -> bool {
  // SAFETY: a window function on a handle named by `NativeWindow`, with an
  // insert-after value that is either none or one of the HWND_* constants.
  unsafe { SetWindowPos(hwnd, after, rect.x, rect.y, rect.width, rect.height, flags) }.is_ok()
}

/// Moves and sizes the outer frame in one step, without activating. A topmost
/// window is re-asserted topmost; any other keeps its place in the z-order.
pub fn set_outer_bounds(window: &impl NativeWindow, rect: Rect, topmost: bool) -> bool {
  let (after, z) = if topmost { (Some(HWND_TOPMOST), SET_WINDOW_POS_FLAGS(0)) } else { (None, SWP_NOZORDER) };
  set_window_pos(window.hwnd(), after, rect, z | SWP_NOACTIVATE)
}

/// Moves the outer frame, keeping its size.
pub fn move_outer(window: &impl NativeWindow, x: i32, y: i32, topmost: bool) -> bool {
  let (after, z) = if topmost { (Some(HWND_TOPMOST), SET_WINDOW_POS_FLAGS(0)) } else { (None, SWP_NOZORDER) };
  set_window_pos(window.hwnd(), after, Rect::new(x, y, 0, 0), SWP_NOSIZE | z | SWP_NOACTIVATE)
}

/// Sizes the outer frame, keeping its position and z-order.
pub fn resize_outer(window: &impl NativeWindow, width: i32, height: i32) -> bool {
  set_window_pos(window.hwnd(), None, Rect::new(0, 0, width, height), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE)
}

/// Puts the window in the topmost band or takes it out, without moving or activating it.
pub fn set_topmost(window: &impl NativeWindow, on: bool) -> bool {
  let after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
  set_window_pos(window.hwnd(), Some(after), Rect::default(), SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
}

/// Re-reads the frame after a style change.
pub fn refresh_frame(window: &impl NativeWindow, topmost: bool) -> bool {
  let after = if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST };
  set_window_pos(window.hwnd(), Some(after), Rect::default(), SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED)
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
  // SAFETY: a window function on a handle named by `NativeWindow`. The OS may
  // refuse the foreground to a process that does not hold it; that is not an error.
  let _granted = unsafe { SetForegroundWindow(hwnd) };
}

/// `show()` for a window `tao` did not make: a minimised window is restored;
/// otherwise it is shown, without activation for `no_activate`; then, unless
/// it must not activate or is topmost, it is brought to the front.
pub fn show(window: &impl NativeWindow, no_activate: bool, topmost: bool) {
  if is_minimized(window) {
    show_window(window.hwnd(), SW_RESTORE);
  } else {
    show_window(window.hwnd(), if no_activate { SW_SHOWNOACTIVATE } else { SW_SHOW });
  }
  if !no_activate && !topmost {
    bring_to_front(window);
  }
}

pub fn hide(window: &impl NativeWindow) {
  show_window(window.hwnd(), SW_HIDE);
}

pub fn minimize(window: &impl NativeWindow) {
  show_window(window.hwnd(), SW_MINIMIZE);
}

/// Maximises a framed window, or restores it when it is maximised.
pub fn toggle_zoom(window: &impl NativeWindow) {
  let command = if is_zoomed(window) { SW_RESTORE } else { SW_MAXIMIZE };
  show_window(window.hwnd(), command);
}

/// Sets the title bar text.
pub fn set_title(window: &impl NativeWindow, title: &str) -> bool {
  let wide: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
  // SAFETY: `wide` is a NUL-terminated UTF-16 buffer owned by this frame for the whole call.
  unsafe { SetWindowTextW(window.hwnd(), PCWSTR(wide.as_ptr())) }.is_ok()
}

/// Hands the press of the left button to the OS move loop, as a press on the title bar.
pub fn start_os_drag(window: &impl NativeWindow) {
  // SAFETY: `ReleaseCapture` has no preconditions; it fails only when nothing holds the capture.
  let _released = unsafe { ReleaseCapture() };
  // SAFETY: a window message with plain integer parameters to a handle named by `NativeWindow`.
  let _result = unsafe { SendMessageW(window.hwnd(), WM_NCLBUTTONDOWN, Some(WPARAM(HTCAPTION as usize)), Some(LPARAM(0))) };
}

/// Resizes the window's first child to fill its client area, as a window
/// procedure does for the one widget it hosts.
pub fn fill_first_child(window: &impl NativeWindow) {
  fill_first_child_of(window.hwnd());
}

fn fill_first_child_of(hwnd: HWND) {
  // SAFETY: a window function on a handle named by `NativeWindow`; no child is an error result.
  let Ok(child) = (unsafe { GetWindow(hwnd, GW_CHILD) }) else { return };
  let mut client = RECT::default();
  // SAFETY: `client` is a RECT owned by this frame for the call to fill.
  if unsafe { GetClientRect(hwnd, &mut client) }.is_err() {
    return;
  }
  // SAFETY: `child` was just returned by `GetWindow` as a child of this thread's window.
  let _moved = unsafe { MoveWindow(child, 0, 0, client.right, client.bottom, true) };
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
    // SAFETY: writes the extended style of a handle named by `NativeWindow`; the
    // value is the current style with bits the policy decides changed.
    let _previous = unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize) };
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

/// Destroys a window this process made through `tao`, now rather than when
/// `tao` gets to its own deferred destroy. Drop the `tao` window right after.
pub fn destroy_now(window: &tao::window::Window) {
  // SAFETY: `tao` made this window on this thread (its windows are made on the
  // loop's thread, which is the UI thread), and the caller drops the `tao`
  // window next, so nothing uses the handle afterwards.
  let hwnd = sealed::Sealed::hwnd(window);
  // SAFETY: as above: a window `tao` made on this thread, dropped by the caller next.
  let _destroyed = unsafe { DestroyWindow(hwnd) };
}

// ---- style and bounds across a change made by someone else ---------------------------

/// A window's styles and outer bounds at one moment, for `preserveGeometry`:
/// mounting a webview may restyle or move the window it mounts into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GeometrySnapshot {
  style: isize,
  ex_style: isize,
  bounds: Option<Rect>,
}

impl GeometrySnapshot {
  pub fn take(window: &impl NativeWindow) -> Self {
    let hwnd = window.hwnd();
    Self { style: style_of(hwnd, GWL_STYLE), ex_style: style_of(hwnd, GWL_EXSTYLE), bounds: outer_bounds_of(hwnd) }
  }

  /// Puts back whatever changed, and lays the first child out to fill the client area.
  pub fn restore(&self, window: &impl NativeWindow) {
    let hwnd = window.hwnd();
    if !is_window_handle(hwnd) {
      return;
    }
    let mut style_changed = false;
    for (index, before) in [(GWL_STYLE, self.style), (GWL_EXSTYLE, self.ex_style)] {
      if style_of(hwnd, index) != before {
        // SAFETY: writes back a style value this same window had when the snapshot was taken.
        let _previous = unsafe { SetWindowLongPtrW(hwnd, index, before) };
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
    // SAFETY: `self.0` was made by `CreateIconFromResourceEx` for this value
    // alone and is destroyed only here.
    let _destroyed = unsafe { DestroyIcon(self.0) };
  }
}

/// The caption and taskbar icons a window shows. The window draws from them
/// for as long as it shows them, so they live until the next icon replaces them.
#[derive(Debug)]
pub struct WindowIcons {
  _small: Option<OwnedIcon>,
  _big: Option<OwnedIcon>,
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

fn metric(index: windows::Win32::UI::WindowsAndMessaging::SYSTEM_METRICS_INDEX, fallback: i32) -> i32 {
  // SAFETY: `GetSystemMetrics` reads a system value and has no preconditions.
  match unsafe { GetSystemMetrics(index) } {
    0 => fallback,
    value => value,
  }
}

impl WindowIcons {
  /// Sets the window's small and large icons from `.ico` bytes, each from the
  /// image closest to its size, or back to the stock icon for `None`. Keep the
  /// result until the next call: dropping it destroys the icons the window draws.
  pub fn set(window: &impl NativeWindow, ico: Option<&[u8]>) -> Result<Self, String> {
    let (small, small_owned) = load_icon(ico, metric(SM_CXSMICON, 16))?;
    let (big, big_owned) = load_icon(ico, metric(SM_CXICON, 32))?;
    for (kind, icon) in [(ICON_SMALL, small), (ICON_BIG, big)] {
      // SAFETY: `WM_SETICON` with an icon that stays alive in the returned value
      // until the next icon replaces it.
      let _previous = unsafe { SendMessageW(window.hwnd(), WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(icon.0 as isize))) };
    }
    Ok(Self { _small: small_owned, _big: big_owned })
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
  // SAFETY: the pseudo-handle of the current process needs no closing and is always valid.
  let process = unsafe { GetCurrentProcess() };
  // SAFETY: `process` is the current process's pseudo-handle.
  let user_objects = unsafe { GetGuiResources(process, GR_USEROBJECTS) };
  // SAFETY: `process` is the current process's pseudo-handle.
  let gdi_objects = unsafe { GetGuiResources(process, GR_GDIOBJECTS) };
  let mut kernel_handles = 0u32;
  // SAFETY: `kernel_handles` is a u32 owned by this frame for the call to fill.
  let _counted = unsafe { GetProcessHandleCount(process, &mut kernel_handles) };
  HandleCounts { user_objects, gdi_objects, kernel_handles }
}

// ---- the subclass ------------------------------------------------------------------------------

/// The id this crate's subclass is installed under.
const SUBCLASS_ID: usize = 0x5357; // "SW"

type Handler = Rc<dyn Fn(&WindowEvent) -> bool>;

struct SubclassState {
  handler: Handler,
  policy: Cell<ExStylePolicy>,
  fill_child: Cell<bool>,
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

fn take_state(hwnd: HWND) -> Option<Rc<SubclassState>> {
  SUBCLASSES.try_with(|table| table.borrow_mut().remove(&(hwnd.0 as isize))).ok().flatten()
}

fn remove_subclass(hwnd: HWND) {
  // SAFETY: removes this crate's own procedure under its own id; on a window
  // that no longer has it (or no longer exists) the call fails and changes nothing.
  let _removed = unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) };
}

/// The events of one window, delivered by subclassing it. Dropping it removes
/// the subclass; the window's own destruction removes it too, after a last
/// [`WindowEvent::Destroyed`].
///
/// Not `Send`: a subclass belongs to the window's thread.
pub struct WindowSubclass {
  hwnd: HWND,
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
    });
    SUBCLASSES.with(|table| table.borrow_mut().insert(hwnd.0 as isize, state));
    // SAFETY: installs this crate's procedure on a window of this thread (checked
    // above). The procedure finds its state by handle value in a thread-local
    // table and is removed by `Drop` or on `WM_NCDESTROY`.
    let installed = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) }.as_bool();
    if !installed {
      take_state(hwnd);
      return Err("sweetview: SetWindowSubclass failed".into());
    }
    Ok(Self { hwnd, _not_send: PhantomData })
  }

  /// The extended-style policy in force.
  pub fn policy(&self) -> ExStylePolicy {
    state_of(self.hwnd).map(|s| s.policy.get()).unwrap_or_default()
  }

  /// Sets the extended-style policy and applies it now. Every later style
  /// change, by anyone, passes through it.
  pub fn set_policy(&self, policy: ExStylePolicy) {
    if let Some(state) = state_of(self.hwnd) {
      state.policy.set(policy);
    }
    apply_ex_style_to(self.hwnd, &policy);
  }

  /// When on, each resize also lays the window's first child out to fill the
  /// client area: the widget of a webview mounted in it.
  pub fn set_fill_child(&self, on: bool) {
    if let Some(state) = state_of(self.hwnd) {
      state.fill_child.set(on);
    }
  }
}

impl Drop for WindowSubclass {
  fn drop(&mut self) {
    // Gone already when the window was destroyed first.
    if take_state(self.hwnd).is_some() {
      remove_subclass(self.hwnd);
    }
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
  fn paths(&self) -> Vec<String> {
    // SAFETY: with index 0xFFFFFFFF and no buffer, the call returns the file count.
    let count = unsafe { DragQueryFileW(self.0, u32::MAX, None) };
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
      // SAFETY: with no buffer, the call returns the length of one path in characters.
      let length = unsafe { DragQueryFileW(self.0, index, None) };
      let mut buffer = vec![0u16; length as usize + 1];
      // SAFETY: `buffer` is owned by this frame and its length is passed with it as a slice.
      let copied = unsafe { DragQueryFileW(self.0, index, Some(&mut buffer)) } as usize;
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

fn forward(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  // SAFETY: passes the message the OS gave the subclass procedure on to the next procedure in the chain.
  unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// What the procedure does with one message: `Some` when it is done with it
/// (having forwarded it itself where needed), `None` to forward it.
fn handle(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> Option<LRESULT> {
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
      // SAFETY: a window function on the handle the OS passed to this procedure.
      let iconic = unsafe { IsIconic(hwnd) }.as_bool();
      if !iconic {
        if let Some(bounds) = outer_bounds_of(hwnd) {
          deliver(&state, &WindowEvent::Moved(bounds));
        }
      }
      Some(result)
    }
    WM_CLOSE => deliver(&state, &WindowEvent::CloseRequested).then_some(LRESULT(0)),
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
      let change = lparam.0 as *mut STYLESTRUCT;
      if !change.is_null() {
        // SAFETY: for WM_STYLECHANGING the OS passes a STYLESTRUCT it owns for the duration of the message.
        let wanted = unsafe { (*change).styleNew };
        let enforced = state.policy.get().apply(wanted);
        // SAFETY: the same STYLESTRUCT; the OS reads `styleNew` back after the message returns.
        unsafe { (*change).styleNew = enforced };
      }
      None
    }
    WM_NCDESTROY => {
      take_state(hwnd);
      remove_subclass(hwnd);
      deliver(&state, &WindowEvent::Destroyed);
      None
    }
    _ => None,
  }
}

// SAFETY: this is the subclass procedure the OS calls with the arguments of a
// window message; it is `unsafe extern "system"` only because `SUBCLASSPROC`
// requires that signature. It never unwinds: its body runs inside
// `catch_unwind`, and a panic forwards the message unchanged.
unsafe extern "system" fn subclass_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
  let handled = catch_unwind(AssertUnwindSafe(|| handle(hwnd, message, wparam, lparam))).unwrap_or(None);
  match handled {
    Some(result) => result,
    None => forward(hwnd, message, wparam, lparam),
  }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
