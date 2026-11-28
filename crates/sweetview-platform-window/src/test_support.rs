//! Reads back what the OS shows, and makes what a person or an application would, for tests:
//! this crate's own, and the runtime's, which enable the `test-support` feature as a
//! dev-dependency only, so nothing here is in the published binding.
//!
//! Real input goes to the shared desktop: callers keep it small (F24, a click on a window of
//! their own) and send every key's up.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};
use windows::Win32::Graphics::Gdi::{ClientToScreen, DeleteObject, GetDC, GetPixel, InvalidateRect, ReleaseDC, CLR_INVALID};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
  GetAsyncKeyState, GetKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
  KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, VIRTUAL_KEY, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
  AppendMenuW, BringWindowToTop, GetClientRect, GetMenuItemCount, GetMenuItemID, GetMenuItemInfoW, GetMenuItemRect, GetMenuState,
  GetMenuStringW, GetSubMenu, IsMenu, RegisterWindowMessageW, MENUITEMINFOW, MF_BYPOSITION, MIIM_BITMAP, TPM_RIGHTBUTTON, GetGUIThreadInfo, GetWindowTextW, SendMessageW, GUITHREADINFO, GUI_INMOVESIZE, MINMAXINFO,
  WM_DROPFILES, WM_GETMINMAXINFO, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow, FindWindowExW,
  FindWindowW, GetCursorPos, GetForegroundWindow, GetIconInfo, GetWindowThreadProcessId, IsWindowVisible, MessageBoxW, PostMessageW,
  RegisterClassW, SetCursorPos, SetForegroundWindow, SetWindowPos, TrackPopupMenu, WindowFromPoint, HICON, HMENU, HWND_TOPMOST, ICONINFO,
  ICON_BIG, ICON_SMALL, MB_OK, MF_STRING, SWP_NOACTIVATE, SWP_SHOWWINDOW, TPM_NONOTIFY, TPM_RETURNCMD, WM_GETICON, WM_NCDESTROY,
  WNDCLASSW, WS_EX_TOOLWINDOW, WS_POPUP,
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

fn hwnd_of(value: isize) -> HWND {
  HWND(value as *mut c_void)
}

// ---- messages and windows by handle value ---------------------------------------------

/// Posts `message` to the window with handle value `window`, as the shell or another process
/// would. False when the OS refused it (no such window, or a full queue).
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

/// The handle value of the taskbar (`Shell_TrayWnd`), a window of another process that can take
/// the foreground; 0 when there is none.
pub fn taskbar() -> isize {
  // SAFETY: the class name is a static wide string and no window name is passed.
  unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) }.map_or(0, |hwnd| hwnd.0 as isize)
}

/// The handle value of a top-level window titled `title`; 0 when there is none.
pub fn window_titled(title: &str) -> isize {
  let title = HSTRING::from(title);
  // SAFETY: `title` is a NUL-terminated wide string owned by this frame for the call; no class is passed.
  unsafe { FindWindowW(PCWSTR::null(), &title) }.map_or(0, |hwnd| hwnd.0 as isize)
}

/// The handle value of the window at a point of the screen; 0 when there is none.
pub fn window_at(x: i32, y: i32) -> isize {
  // SAFETY: the point is passed by value.
  unsafe { WindowFromPoint(POINT { x, y }) }.0 as isize
}

// ---- input ---------------------------------------------------------------------------

fn send_input(inputs: &[INPUT]) -> bool {
  // SAFETY: `inputs` is a slice of fully initialised INPUTs borrowed for the whole call, and the
  // size is INPUT's.
  let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
  sent as usize == inputs.len()
}

/// Presses (`up` false) or releases a key by its virtual-key code, as real input. True when the
/// system took it.
pub fn send_key(virtual_key: u16, up: bool) -> bool {
  let flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
  let ki = KEYBDINPUT { wVk: VIRTUAL_KEY(virtual_key), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 };
  send_input(&[INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki } }])
}

/// Presses or releases the left mouse button where the pointer is, as real input.
pub fn send_left_button(down: bool) -> bool {
  let flags = if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP };
  let mi = MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 };
  send_input(&[INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi } }])
}

/// Whether the system holds a key down: the last event of it that reached the system was a press.
pub fn key_is_down(virtual_key: u16) -> bool {
  // SAFETY: takes a key number and touches no memory of ours.
  let state = unsafe { GetAsyncKeyState(i32::from(virtual_key)) };
  state < 0
}

/// Whether any mouse button is held down.
pub fn buttons_down() -> bool {
  [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].into_iter().any(|key| key_is_down(key.0))
}

/// Where the pointer is, in screen pixels.
pub fn cursor() -> (i32, i32) {
  let mut at = POINT::default();
  // SAFETY: `at` is a POINT owned by this frame for the call to fill.
  let _read = unsafe { GetCursorPos(&mut at) };
  (at.x, at.y)
}

/// Puts the pointer at a point of the screen. True when the OS moved it.
pub fn set_cursor(x: i32, y: i32) -> bool {
  // SAFETY: takes two numbers and touches no memory of ours.
  unsafe { SetCursorPos(x, y) }.is_ok()
}

// ---- the application's own modal loops -----------------------------------------------

/// Shows a message box titled `title` with no owner, as an application's own `MessageBoxW`
/// does, and returns when it closes: its own modal loop runs meanwhile.
pub fn message_box(text: &str, title: &str) -> i32 {
  let (text, title) = (HSTRING::from(text), HSTRING::from(title));
  // SAFETY: both strings are NUL-terminated wide strings owned by this frame for the whole call.
  unsafe { MessageBoxW(None, &text, &title, MB_OK) }.0
}

/// A popup menu the caller made and owns, destroyed on drop.
struct OwnMenu(HMENU);

impl Drop for OwnMenu {
  fn drop(&mut self) {
    // SAFETY: `self.0` was made by `CreatePopupMenu` in `own_popup_menu`, is owned by this value
    // alone and destroyed only here.
    let _destroyed = unsafe { DestroyMenu(self.0) };
  }
}

/// Tracks a one-item popup menu made with the OS's own calls, owned by the window with handle
/// value `owner` and placed off every screen, as an application's own `TrackPopupMenu` does,
/// and returns when it closes: the chosen item's id (1), or 0. Its own modal loop runs meanwhile.
pub fn own_popup_menu(owner: isize) -> i32 {
  // SAFETY: takes nothing; the menu is owned by the `OwnMenu` below.
  let Ok(menu) = (unsafe { CreatePopupMenu() }) else { return -1 };
  let menu = OwnMenu(menu);
  // SAFETY: `menu.0` is the live menu made above; the label is a static wide string.
  if unsafe { AppendMenuW(menu.0, MF_STRING, 1, w!("One")) }.is_err() {
    return -1;
  }
  // SAFETY: `menu.0` is the live menu made above; the OS validates the owner's handle value; no
  // rectangle is passed.
  unsafe { TrackPopupMenu(menu.0, TPM_RETURNCMD | TPM_NONOTIFY, -2900, -2900, None, hwnd_of(owner), None) }.0
}

// ---- a window of the application's own -----------------------------------------------

type MessageHandler = Rc<dyn Fn(u32)>;

thread_local! {
  /// The handler of each `OwnWindow` of this thread, by handle value.
  static OWN_HANDLERS: RefCell<HashMap<isize, MessageHandler>> = RefCell::new(HashMap::new());
}

/// The procedure of every `OwnWindow`: tells the window's handler each message it is
/// dispatched, then does what `DefWindowProcW` does. It never unwinds.
extern "system" fn own_window_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  let value = hwnd.0 as isize;
  let _ = catch_unwind(AssertUnwindSafe(|| {
    let handler = OWN_HANDLERS.with(|all| all.borrow().get(&value).cloned());
    if let Some(handler) = handler {
      handler(message);
    }
    if message == WM_NCDESTROY {
      OWN_HANDLERS.with(|all| all.borrow_mut().remove(&value));
    }
  }));
  // SAFETY: passes the message the OS gave this procedure on to the default procedure, unchanged.
  unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// A visible, topmost window made with the OS's own calls, as an application makes one of its
/// own, with a procedure of its own that reports every message it is dispatched. Destroyed on
/// drop. Not `Send`: it belongs to the thread that made it.
pub struct OwnWindow {
  hwnd: HWND,
  /// Set when the window is destroyed by other means (its own procedure, for one, on `WM_CLOSE`).
  destroyed: Rc<std::cell::Cell<bool>>,
  _not_send: std::marker::PhantomData<Rc<()>>,
}

impl OwnWindow {
  /// Shows the window at `(x, y)`, `width` by `height` screen pixels, topmost and not
  /// activated; `on_message` is told each message its procedure is dispatched.
  pub fn new(title: &str, (x, y, width, height): (i32, i32, i32, i32), on_message: impl Fn(u32) + 'static) -> Option<OwnWindow> {
    let class = w!("sweetview.test-own-window");
    let description = WNDCLASSW { lpfnWndProc: Some(own_window_procedure), lpszClassName: class, ..Default::default() };
    // SAFETY: `description` is a fully initialised WNDCLASSW on this frame; its class name is a
    // static wide string. A second registration fails harmlessly: the class is already there.
    let _atom = unsafe { RegisterClassW(&description) };
    let title = HSTRING::from(title);
    // SAFETY: the class is registered above; `title` is a wide string owned by this frame for the
    // call; no parent, menu, instance or creation parameter is passed.
    let made = unsafe { CreateWindowExW(WS_EX_TOOLWINDOW, class, &title, WS_POPUP, x, y, width, height, None, None, None, None) };
    let hwnd = made.ok()?;
    // Owned from here: a failure below still destroys the window.
    let destroyed = Rc::new(std::cell::Cell::new(false));
    let window = OwnWindow { hwnd, destroyed: destroyed.clone(), _not_send: std::marker::PhantomData };
    let handler: MessageHandler = Rc::new(move |message| {
      on_message(message);
      if message == WM_NCDESTROY {
        destroyed.set(true);
      }
    });
    OWN_HANDLERS.with(|all| all.borrow_mut().insert(window.handle_value(), handler));
    // SAFETY: `window.hwnd` is the live window made above; the flags are constants.
    unsafe { SetWindowPos(window.hwnd, Some(HWND_TOPMOST), x, y, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE) }.ok()?;
    Some(window)
  }

  pub fn handle_value(&self) -> isize {
    self.hwnd.0 as isize
  }

  /// False once the window has been destroyed, by its drop or by other means.
  pub fn is_alive(&self) -> bool {
    !self.destroyed.get()
  }

  /// Asks the OS to repaint the whole window: a `WM_PAINT` comes when the queue gives it its turn.
  pub fn invalidate(&self) -> bool {
    // SAFETY: `self.hwnd` is owned by this `OwnWindow` and destroyed only in its `Drop`; no
    // rectangle is passed.
    unsafe { InvalidateRect(Some(self.hwnd), None, true) }.as_bool()
  }
}

impl Drop for OwnWindow {
  fn drop(&mut self) {
    if self.destroyed.get() {
      return;
    }
    // SAFETY: `self.hwnd` is owned by this `OwnWindow`, still alive (its `WM_NCDESTROY` has not
    // come), and destroyed only here.
    let _destroyed = unsafe { DestroyWindow(self.hwnd) };
  }
}

// ---- the test process ---------------------------------------------------------------

/// Keeps COM loaded in this test process until it ends (`CoIncrementMTAUsage`, taken once and
/// never given back). Each runtime test runs on a thread of its own and leaves that thread's
/// apartment when it ends; the `windows` crate caches WinRT factories for the whole process (the
/// system theme's `UISettings`), and when the last apartment is left COM unloads the DLLs they live
/// in, so the next test's call through a cached factory runs freed code. An application's UI
/// thread never leaves its apartment while the process lives.
pub fn keep_com_loaded_for_the_test_process() {
  static HELD: std::sync::OnceLock<()> = std::sync::OnceLock::new();
  HELD.get_or_init(|| {
    // SAFETY: one call with no arguments; the cookie it returns is never given back, so the usage
    // lasts until the process ends.
    let _cookie = unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() };
  });
}

// ---- read back from the OS ---------------------------------------------------------------

/// Sends `message` with integer parameters to the window with handle value `window` and returns
/// its answer, as the OS or another application would send it. Only for messages whose
/// parameters are integers.
pub fn send(window: isize, message: u32, wparam: usize, lparam: isize) -> isize {
  // SAFETY: `SendMessageW` validates the handle value; the parameters are integers, which callers
  // pass only for messages that take integers.
  unsafe { SendMessageW(hwnd_of(window), message, Some(WPARAM(wparam)), Some(LPARAM(lparam))) }.0
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

/// A point of the window's client area in screen pixels.
pub fn client_to_screen(window: isize, x: i32, y: i32) -> (i32, i32) {
  let mut point = POINT { x, y };
  // SAFETY: `point` is a POINT owned by this frame for the call to convert in place.
  let _converted = unsafe { ClientToScreen(hwnd_of(window), &mut point) };
  (point.x, point.y)
}

/// The smallest outer size the OS lets the window be sized to (`MINMAXINFO.ptMinTrackSize` of a
/// `WM_GETMINMAXINFO` sent to it), in physical pixels.
pub fn min_track_size(window: isize) -> (i32, i32) {
  let mut info = MINMAXINFO::default();
  let address = (&raw mut info) as isize;
  // SAFETY: `info` is a MINMAXINFO owned by this frame for the whole call; the message's lParam is
  // its address, which the window's procedure fills, as the OS sends it.
  let _answer = unsafe { SendMessageW(hwnd_of(window), WM_GETMINMAXINFO, None, Some(LPARAM(address))) };
  (info.ptMinTrackSize.x, info.ptMinTrackSize.y)
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

/// Whether this thread is in the OS's move or size loop (`GUI_INMOVESIZE`), read by this thread's
/// id: the foreground thread may be another process's.
pub fn in_move_size() -> bool {
  let mut info = GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
  // SAFETY: takes nothing and reads no memory.
  let thread = unsafe { GetCurrentThreadId() };
  // SAFETY: `info` is a GUITHREADINFO owned by this frame for the call, its size set.
  let read = unsafe { GetGUIThreadInfo(thread, &mut info) };
  read.is_ok() && (info.flags.0 & GUI_INMOVESIZE.0) != 0
}

/// Whether this thread's own key state has the left button down: its queue has seen the press,
/// which is when the OS will start a move loop for it.
pub fn this_thread_sees_left_down() -> bool {
  // SAFETY: takes a key number and touches no memory of ours.
  let state = unsafe { GetKeyState(i32::from(VK_LBUTTON.0)) };
  state < 0
}

/// Moves the cursor to a screen point as a mouse would: an injected absolute move over the whole
/// virtual desktop, which is what the OS's own move loop follows, then `SetCursorPos` so the point
/// is exact (the injected move is rounded to 1/65535 of the desktop).
pub fn move_cursor_as_input(x: i32, y: i32) -> bool {
  use windows::Win32::UI::Input::KeyboardAndMouse::{MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK};
  use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};
  // SAFETY: takes a metric index and touches no memory of ours.
  let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
  // SAFETY: as above.
  let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
  // SAFETY: as above.
  let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
  // SAFETY: as above.
  let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
  let scaled = |at: i32, from: i32, size: i32| ((f64::from(at - from) * 65535.0) / f64::from((size - 1).max(1))).round() as i32;
  let mi = MOUSEINPUT {
    dx: scaled(x, left, width),
    dy: scaled(y, top, height),
    mouseData: 0,
    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    time: 0,
    dwExtraInfo: 0,
  };
  send_input(&[INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi } }]) && set_cursor(x, y)
}

/// A file drop as the shell hands one to a window: a movable global block holding a `DROPFILES`
/// header followed by the NUL-separated wide paths and a final NUL. The window that receives it
/// owns it and frees it with `DragFinish`.
pub fn shell_drop(paths: &[&str]) -> windows::Win32::Foundation::HGLOBAL {
  use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
  use windows::Win32::UI::Shell::DROPFILES;
  let text: Vec<u16> = paths.iter().flat_map(|path| path.encode_utf16().chain([0])).chain([0]).collect();
  let header = DROPFILES { pFiles: size_of::<DROPFILES>() as u32, fWide: true.into(), ..Default::default() };
  let bytes = size_of::<DROPFILES>() + text.len() * 2;
  // SAFETY: GlobalAlloc takes its flags and size by value and reads no memory of ours.
  let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes) }.expect("GlobalAlloc");
  // SAFETY: `memory` is the block just allocated, owned by this function until it is handed over.
  let base = unsafe { GlobalLock(memory) }.cast::<u8>();
  assert!(!base.is_null(), "GlobalLock");
  // SAFETY: the locked block is `bytes` long, at least a DROPFILES, which the `windows` crate lays
  // out; the write is unaligned-safe.
  unsafe { base.cast::<DROPFILES>().write_unaligned(header) };
  let after_header = base.wrapping_add(size_of::<DROPFILES>());
  // SAFETY: the block has exactly `text.len() * 2` bytes after the header (its size above), and
  // `text` is a separate Rust buffer, so the ranges do not overlap.
  unsafe { std::ptr::copy_nonoverlapping(text.as_ptr().cast::<u8>(), after_header, text.len() * 2) };
  // SAFETY: balances the GlobalLock above on the same, still allocated block.
  let _unlocked = unsafe { GlobalUnlock(memory) };
  memory
}

/// Sends the window with handle value `window` a file drop of `paths`, as the shell does, and
/// returns whether the window freed the drop (`DragFinish`), as the window that takes one must.
pub fn send_file_drop(window: isize, paths: &[&str]) -> bool {
  use windows::Win32::System::Memory::GlobalSize;
  let drop = shell_drop(paths);
  send(window, WM_DROPFILES, drop.0 as usize, 0);
  // SAFETY: GlobalSize takes a handle value by value and only reports on it, 0 for a value that
  // names no block; nothing of ours is read or written.
  let size = unsafe { GlobalSize(drop) };
  size == 0
}

// ---- menus ---------------------------------------------------------------------------

/// The visible popup menu windows (`#32768`) of this process, by handle value.
fn popup_menu_windows() -> Vec<isize> {
  // SAFETY: takes nothing and reads no memory.
  let process = unsafe { GetCurrentProcessId() };
  let mut open = Vec::new();
  let mut after: Option<HWND> = None;
  loop {
    // SAFETY: the class name is a static wide string and no window name is passed; `after` is
    // none or a handle value the previous call returned, which the OS validates.
    let found = unsafe { FindWindowExW(None, after, w!("#32768"), PCWSTR::null()) };
    let Ok(menu) = found else { break };
    let mut owner = 0u32;
    // SAFETY: `menu` is a handle value the OS just returned and validates again; `owner` is a u32
    // owned by this frame for the call to fill.
    let _thread = unsafe { GetWindowThreadProcessId(menu, Some(&mut owner)) };
    // SAFETY: as above, the OS validates the handle value.
    let visible = unsafe { IsWindowVisible(menu) }.as_bool();
    if owner == process && visible {
      open.push(menu.0 as isize);
    }
    after = Some(menu);
  }
  open
}

/// How many visible popup menu windows this process has: open menus, the application's own or
/// Sweetview's.
pub fn popup_menus_open() -> usize {
  popup_menu_windows().len()
}

/// The handle value of a visible popup menu window of this process; 0 when none is open.
pub fn open_popup_menu() -> isize {
  popup_menu_windows().first().copied().unwrap_or(0)
}

/// The menu a popup menu window shows (`MN_GETHMENU`), as a handle value.
pub fn menu_of_window(menu_window: isize) -> isize {
  send(menu_window, 0x01e1, 0, 0)
}

fn hmenu_of(menu: isize) -> HMENU {
  HMENU(menu as *mut c_void)
}

/// One entry of a menu as the OS holds it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MenuEntry {
  pub label: String,
  pub separator: bool,
  pub checked: bool,
  pub disabled: bool,
  /// The item draws a bitmap of its own (`hbmpItem`): an icon.
  pub has_bitmap: bool,
  pub submenu: Option<Vec<MenuEntry>>,
}

/// Reads a menu back from the OS: what each entry shows and its state, submenus included.
pub fn read_menu(menu: isize) -> Vec<MenuEntry> {
  let hmenu = hmenu_of(menu);
  // SAFETY: the OS validates the handle value; -1 for one that names no menu.
  let count = unsafe { GetMenuItemCount(Some(hmenu)) };
  (0..u32::try_from(count).unwrap_or(0))
    .map(|position| {
      // SAFETY: as above; the position is one the count covers.
      let state = unsafe { GetMenuState(hmenu, position, MF_BYPOSITION) };
      let mut text = [0u16; 256];
      // SAFETY: `text` is a buffer owned by this frame for the call; its length comes from the slice.
      let length = unsafe { GetMenuStringW(hmenu, position, Some(&mut text), MF_BYPOSITION) };
      let mut info = MENUITEMINFOW { cbSize: size_of::<MENUITEMINFOW>() as u32, fMask: MIIM_BITMAP, ..Default::default() };
      // SAFETY: `info` is a MENUITEMINFOW owned by this frame for the call, its size set.
      let _read = unsafe { GetMenuItemInfoW(hmenu, position, true, &mut info) };
      // SAFETY: as above; a null handle for an item with no submenu.
      let sub = unsafe { GetSubMenu(hmenu, position as i32) };
      MenuEntry {
        label: String::from_utf16_lossy(&text[..usize::try_from(length).unwrap_or(0)]),
        separator: state & 0x800 != 0,
        checked: state & 0x8 != 0,
        disabled: state & 0x3 != 0,
        has_bitmap: !info.hbmpItem.is_invalid(),
        submenu: (!sub.is_invalid()).then(|| read_menu(sub.0 as isize)),
      }
    })
    .collect()
}

/// Posts key presses to a popup menu window, which its menu loop takes as the keyboard.
pub fn press_keys(menu_window: isize, keys: &[u16]) {
  for &key in keys {
    post(menu_window, 0x0100, usize::from(key), 1); // WM_KEYDOWN
  }
}

/// The screen rectangle (left, top, right, bottom) of the item at `position` of `menu`, while a
/// popup menu window shows it.
pub fn menu_item_rect(menu: isize, position: u32) -> Option<(i32, i32, i32, i32)> {
  let mut rect = RECT::default();
  // SAFETY: `rect` is a RECT owned by this frame for the call to fill; the OS validates the menu.
  unsafe { GetMenuItemRect(None, hmenu_of(menu), position, &mut rect) }.ok()?;
  Some((rect.left, rect.top, rect.right, rect.bottom))
}

/// The command id the OS keeps for the item at `position` of `menu` (`u32::MAX` for a submenu).
pub fn menu_item_id(menu: isize, position: i32) -> u32 {
  // SAFETY: the OS validates the menu handle value and the position.
  unsafe { GetMenuItemID(hmenu_of(menu), position) }
}

/// The submenu at `position` of `menu`, as a handle value; 0 when there is none.
pub fn sub_menu(menu: isize, position: i32) -> isize {
  // SAFETY: the OS validates the menu handle value and the position.
  unsafe { GetSubMenu(hmenu_of(menu), position) }.0 as isize
}

/// Whether `menu` names a live menu.
pub fn is_menu(menu: isize) -> bool {
  // SAFETY: the OS validates the handle value.
  unsafe { IsMenu(hmenu_of(menu)) }.as_bool()
}

/// Tracks `menu` owned by the window with handle value `owner` at a point, as an application's own
/// `TrackPopupMenu` with `TPM_RETURNCMD | TPM_RIGHTBUTTON` does, and returns the chosen command id
/// (0 when dismissed).
pub fn track_menu(menu: isize, x: i32, y: i32, owner: isize) -> i32 {
  // SAFETY: the OS validates the menu and the owner's handle values; no rectangle is passed.
  unsafe { TrackPopupMenu(hmenu_of(menu), TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, None, hwnd_of(owner), None) }.0
}

/// Presses or releases the right mouse button where the pointer is, as real input.
pub fn send_right_button(down: bool) -> bool {
  use windows::Win32::UI::Input::KeyboardAndMouse::{MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP};
  let flags = if down { MOUSEEVENTF_RIGHTDOWN } else { MOUSEEVENTF_RIGHTUP };
  let mi = MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 };
  send_input(&[INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi } }])
}

/// The number the OS gives a registered window message, as Explorer broadcasts `TaskbarCreated`.
pub fn registered_message(name: &str) -> u32 {
  let name = HSTRING::from(name);
  // SAFETY: `name` is a NUL-terminated wide string owned by this frame for the call.
  unsafe { RegisterWindowMessageW(&name) }
}

/// The window's DPI (`GetDpiForWindow`).
pub fn dpi_of(window: isize) -> u32 {
  // SAFETY: takes the handle by value; the OS validates it and answers 0 for one that names no window.
  unsafe { windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd_of(window)) }
}

/// The width of a sizable window's resize border at `dpi`: `SM_CXSIZEFRAME` plus
/// `SM_CXPADDEDBORDER`, as the system frame draws it.
pub fn frame_edge(dpi: u32) -> i32 {
  use windows::Win32::UI::HiDpi::GetSystemMetricsForDpi;
  use windows::Win32::UI::WindowsAndMessaging::{SM_CXPADDEDBORDER, SM_CXSIZEFRAME};
  // SAFETY: takes a metric index and a DPI, and touches no memory of ours.
  let frame = unsafe { GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) };
  // SAFETY: as above.
  let padded = unsafe { GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi) };
  frame + padded
}
