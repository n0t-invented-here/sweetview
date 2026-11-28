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
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{DeleteObject, InvalidateRect};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
  GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
  KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, VIRTUAL_KEY, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
  AppendMenuW, BringWindowToTop, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow, FindWindowExW,
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

/// How many visible popup menu windows this process has: open menus, the application's own or
/// Sweetview's.
pub fn popup_menus_open() -> usize {
  // SAFETY: takes nothing and reads no memory.
  let process = unsafe { GetCurrentProcessId() };
  let mut open = 0;
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
    open += usize::from(owner == process && visible);
    after = Some(menu);
  }
  open
}

// ---- input ---------------------------------------------------------------------------

fn send(inputs: &[INPUT]) -> bool {
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
  send(&[INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki } }])
}

/// Presses or releases the left mouse button where the pointer is, as real input.
pub fn send_left_button(down: bool) -> bool {
  let flags = if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP };
  let mi = MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 };
  send(&[INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi } }])
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
    let window = OwnWindow { hwnd, _not_send: std::marker::PhantomData };
    OWN_HANDLERS.with(|all| all.borrow_mut().insert(window.handle_value(), Rc::new(on_message)));
    // SAFETY: `window.hwnd` is the live window made above; the flags are constants.
    unsafe { SetWindowPos(window.hwnd, Some(HWND_TOPMOST), x, y, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE) }.ok()?;
    Some(window)
  }

  pub fn handle_value(&self) -> isize {
    self.hwnd.0 as isize
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
    // SAFETY: `self.hwnd` is owned by this `OwnWindow` and destroyed only here.
    let _destroyed = unsafe { DestroyWindow(self.hwnd) };
  }
}
