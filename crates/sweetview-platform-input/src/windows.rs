//! The hooks on Windows: `WH_MOUSE_LL` and `WH_KEYBOARD_LL`, installed on the
//! calling thread, whose message loop the OS calls them through.
//!
//! The hook procedures find their handlers in this thread's storage, so no
//! pointer rides in global state. A process-wide flag per kind keeps it to one
//! hook of each kind per process, whichever thread installs it.

use std::cell::RefCell;
use std::marker::PhantomData;
use std::mem::ManuallyDrop;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

use sweetview_keycodes::{dom_code_from_windows_scan, win, KeysDown};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, MapVirtualKeyW, MAPVK_VK_TO_VSC_EX};
use windows::Win32::UI::WindowsAndMessaging::{
  CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, HOOKPROC, KBDLLHOOKSTRUCT, LLKHF_EXTENDED,
  MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WINDOWS_HOOK_ID,
};

use crate::events::{HookError, KeyEvent, MouseEvent};

type MouseHandler = Rc<dyn Fn(&MouseEvent) -> bool>;

/// What the keyboard hook procedure needs: the handler, and the keys it has
/// seen go down, which a new install starts afresh.
struct KeyboardState {
  handler: Box<dyn Fn(&KeyEvent) -> bool>,
  keys: RefCell<KeysDown>,
}

thread_local! {
  /// The mouse hook's handler, on the thread that installed it.
  static MOUSE: RefCell<Option<MouseHandler>> = const { RefCell::new(None) };
  /// The keyboard hook's handler and key state, on the thread that installed it.
  static KEYBOARD: RefCell<Option<Rc<KeyboardState>>> = const { RefCell::new(None) };
}

/// Whether the process has a mouse hook, on any thread.
static MOUSE_INSTALLED: AtomicBool = AtomicBool::new(false);
/// Whether the process has a keyboard hook, on any thread.
static KEYBOARD_INSTALLED: AtomicBool = AtomicBool::new(false);

/// The process's one place for a hook of a kind, held while the hook lives
/// and given back when this is dropped.
struct ProcessSlot(&'static AtomicBool);

impl ProcessSlot {
  fn take(flag: &'static AtomicBool) -> Result<Self, HookError> {
    match flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire) {
      Ok(_) => Ok(Self(flag)),
      Err(_) => Err(HookError::AlreadyInstalled),
    }
  }
}

impl Drop for ProcessSlot {
  fn drop(&mut self) {
    self.0.store(false, Ordering::Release);
  }
}

/// An installed low-level hook. Dropping it unhooks it.
struct OwnedHook {
  hhook: HHOOK,
  name: &'static str,
}

impl OwnedHook {
  /// Installs `procedure` as a low-level hook on this thread's message loop.
  fn install(id: WINDOWS_HOOK_ID, procedure: HOOKPROC, name: &'static str) -> Result<Self, HookError> {
    // SAFETY: a null module name asks for the handle of the process's own executable; no pointer is passed.
    let module = unsafe { GetModuleHandleW(None) }.map_err(|e| HookError::Os(format!("GetModuleHandleW: {e}")))?;
    // SAFETY: `procedure` is one of this file's `extern "system"` hook procedures, which have the
    // HOOKPROC signature, live as long as the program and never unwind; the module is the process's
    // own executable, which stays loaded; thread 0 with a low-level hook id is what the OS requires.
    let installed = unsafe { SetWindowsHookExW(id, procedure, Some(module.into()), 0) };
    let hhook = installed.map_err(|e| HookError::Os(format!("SetWindowsHookEx({name}) failed: {e}")))?;
    Ok(Self { hhook, name })
  }

  /// Unhooks, reporting a failure that `Drop` would have to swallow.
  fn remove(self) -> Result<(), HookError> {
    let this = ManuallyDrop::new(self);
    let name = this.name;
    // SAFETY: `this.hhook` came from SetWindowsHookExW in `install` and is owned by this value
    // alone; ManuallyDrop keeps `Drop` from unhooking it a second time.
    let removed = unsafe { UnhookWindowsHookEx(this.hhook) };
    removed.map_err(|e| HookError::Os(format!("UnhookWindowsHookEx({name}) failed: {e}")))
  }
}

impl Drop for OwnedHook {
  fn drop(&mut self) {
    // SAFETY: `self.hhook` came from SetWindowsHookExW in `install`, is owned by this value
    // alone, and is unhooked only here or in `remove`, which skips this `Drop`.
    let removed = unsafe { UnhookWindowsHookEx(self.hhook) };
    // Nothing useful can be done with a failure while dropping; `remove` reports it.
    let _ = removed;
  }
}

/// The process's mouse hook: every mouse event on the system goes to the
/// handler before any window gets it, and the handler returns true to swallow
/// it. One per process. Dropping it removes the hook, from inside its own
/// handler too. Not `Send`, not `Sync`: the hook belongs to the thread that
/// installed it, whose message loop delivers its events.
pub struct MouseHook {
  hook: Option<OwnedHook>,
  _slot: ProcessSlot,
  _not_send: PhantomData<*const ()>,
}

impl MouseHook {
  /// Installs the hook on this thread, which must pump messages for it to see
  /// anything. Fails with [`HookError::AlreadyInstalled`] when the process has
  /// one, on any thread, or [`HookError::Os`] when the OS refuses. A handler
  /// that panics is caught; the event is not swallowed.
  pub fn install(handler: impl Fn(&MouseEvent) -> bool + 'static) -> Result<MouseHook, HookError> {
    let slot = ProcessSlot::take(&MOUSE_INSTALLED)?;
    let handler: MouseHandler = Rc::new(handler);
    MOUSE.with(|mouse| mouse.borrow_mut().replace(handler));
    match OwnedHook::install(WH_MOUSE_LL, Some(mouse_proc), "WH_MOUSE_LL") {
      Ok(hook) => Ok(MouseHook { hook: Some(hook), _slot: slot, _not_send: PhantomData }),
      Err(error) => {
        clear_mouse();
        Err(error)
      }
    }
  }

  /// Removes the hook, reporting an OS failure that dropping would swallow.
  /// The handler is released either way.
  pub fn remove(mut self) -> Result<(), HookError> {
    self.hook.take().map_or(Ok(()), OwnedHook::remove)
  }
}

impl Drop for MouseHook {
  fn drop(&mut self) {
    // Unhook first, so no event can find the handler after it is gone. A call
    // already running holds its own reference to the handler.
    drop(self.hook.take());
    clear_mouse();
  }
}

fn clear_mouse() {
  // The handler is dropped after the borrow ends: dropping it may run code
  // that reaches this table again. `try_with`: a hook kept in thread-local
  // storage is dropped while that storage is being torn down.
  let old = MOUSE.try_with(|mouse| mouse.borrow_mut().take()).ok().flatten();
  drop(old);
}

/// The process's keyboard hook: every key event on the system (down, up and
/// the OS's auto-repeat) goes to the handler before the focused window gets
/// it, and the handler returns true to swallow it. One per process,
/// independent of the mouse hook. Dropping it removes the hook, from inside
/// its own handler too. Not `Send`, not `Sync`.
pub struct KeyboardHook {
  hook: Option<OwnedHook>,
  _slot: ProcessSlot,
  _not_send: PhantomData<*const ()>,
}

impl KeyboardHook {
  /// Installs the hook on this thread, which must pump messages for it to see
  /// anything. Fails with [`HookError::AlreadyInstalled`] when the process has
  /// one, on any thread, or [`HookError::Os`] when the OS refuses. A handler
  /// that panics is caught; the event is not swallowed.
  pub fn install(handler: impl Fn(&KeyEvent) -> bool + 'static) -> Result<KeyboardHook, HookError> {
    let slot = ProcessSlot::take(&KEYBOARD_INSTALLED)?;
    let state = Rc::new(KeyboardState { handler: Box::new(handler), keys: RefCell::new(KeysDown::new()) });
    KEYBOARD.with(|keyboard| keyboard.borrow_mut().replace(state));
    match OwnedHook::install(WH_KEYBOARD_LL, Some(keyboard_proc), "WH_KEYBOARD_LL") {
      Ok(hook) => Ok(KeyboardHook { hook: Some(hook), _slot: slot, _not_send: PhantomData }),
      Err(error) => {
        clear_keyboard();
        Err(error)
      }
    }
  }

  /// Removes the hook, reporting an OS failure that dropping would swallow.
  /// The handler is released either way.
  pub fn remove(mut self) -> Result<(), HookError> {
    self.hook.take().map_or(Ok(()), OwnedHook::remove)
  }
}

impl Drop for KeyboardHook {
  fn drop(&mut self) {
    drop(self.hook.take());
    clear_keyboard();
  }
}

fn clear_keyboard() {
  let old = KEYBOARD.try_with(|keyboard| keyboard.borrow_mut().take()).ok().flatten();
  drop(old);
}

/// Whether a virtual key is down by the asynchronous key state, which inside
/// a low-level hook is the keyboard as it was for the event (without the event
/// itself, for a key event).
fn key_down(vk: u32) -> bool {
  let Ok(vk) = i32::try_from(vk) else { return false };
  // SAFETY: GetAsyncKeyState takes a key number and touches no memory of ours.
  let state = unsafe { GetAsyncKeyState(vk) };
  state < 0
}

/// `MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX)`: the scan code a virtual key has
/// on the current layout, with 0xE0 in the high byte for an extended key.
pub(crate) fn map_vk_to_vsc_ex(vk: u32) -> u32 {
  // SAFETY: MapVirtualKeyW takes two numbers and touches no memory of ours.
  unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX) }
}

/// Builds the event for a mouse message and hands it to the handler. True
/// swallows it.
fn deliver_mouse(message: u32, info: &MSLLHOOKSTRUCT) -> bool {
  let Some(kind) = win::mouse_event_kind(message) else { return false };
  // Cloned out of the table, so the handler may drop its own hook mid-call.
  let Some(handler) = MOUSE.try_with(|mouse| mouse.borrow().clone()).ok().flatten() else { return false };
  let wheel = if kind == sweetview_keycodes::MouseEventKind::Wheel { win::wheel_notches(info.mouseData) } else { 0.0 };
  let event = MouseEvent {
    kind,
    x: f64::from(info.pt.x),
    y: f64::from(info.pt.y),
    wheel,
    // The low-level message has no modifier field; the asynchronous key state
    // inside the hook is the keyboard as it was for this event.
    modifiers: win::modifiers_now(key_down),
  };
  handler(&event)
}

/// Builds the event for a key message and hands it to the handler. True
/// swallows it.
fn deliver_key(message: u32, info: &KBDLLHOOKSTRUCT) -> bool {
  let Some(state) = KEYBOARD.try_with(|keyboard| keyboard.borrow().clone()).ok().flatten() else { return false };
  let scan = win::dom_scan(info.vkCode, info.scanCode, info.flags.contains(LLKHF_EXTENDED), map_vk_to_vsc_ex);
  if win::is_fake_shift(scan) {
    return false;
  }
  let down = win::is_key_down_message(message);
  let vk = info.vkCode & 0xFF;
  let kind = win::key_event_kind(&mut state.keys.borrow_mut(), vk, down, || key_down(vk));
  let event = KeyEvent {
    kind,
    code: dom_code_from_windows_scan(scan),
    raw: info.vkCode,
    modifiers: win::modifiers_after_key(info.vkCode, down, key_down),
  };
  (state.handler)(&event)
}

/// The `WH_MOUSE_LL` procedure. Called by the OS; never unwinds.
extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  // HC_ACTION (0) is the only code with an event; a negative one must go straight on.
  if code >= 0 && lparam.0 != 0 {
    // SAFETY: for a non-negative code the OS passes in lParam a pointer to an MSLLHOOKSTRUCT
    // that is valid and aligned for the duration of this call; it is non-null (checked above)
    // and copied out here, before anything else runs.
    let info = unsafe { *(lparam.0 as *const MSLLHOOKSTRUCT) };
    // A panic must not cross into the OS: it is caught and the event goes on.
    let swallow = catch_unwind(AssertUnwindSafe(|| deliver_mouse(wparam.0 as u32, &info))).unwrap_or(false);
    if swallow {
      return LRESULT(1);
    }
  }
  // SAFETY: the arguments are the ones the OS passed to this hook procedure; the OS ignores the hook handle.
  unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// The `WH_KEYBOARD_LL` procedure. Called by the OS; never unwinds.
extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  if code >= 0 && lparam.0 != 0 {
    // SAFETY: for a non-negative code the OS passes in lParam a pointer to a KBDLLHOOKSTRUCT
    // that is valid and aligned for the duration of this call; it is non-null (checked above)
    // and copied out here, before anything else runs.
    let info = unsafe { *(lparam.0 as *const KBDLLHOOKSTRUCT) };
    let swallow = catch_unwind(AssertUnwindSafe(|| deliver_key(wparam.0 as u32, &info))).unwrap_or(false);
    if swallow {
      return LRESULT(1);
    }
  }
  // SAFETY: the arguments are the ones the OS passed to this hook procedure; the OS ignores the hook handle.
  unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use sweetview_keycodes::win::{message, vk};
  use windows::Win32::UI::Input::KeyboardAndMouse as kam;
  use windows::Win32::UI::WindowsAndMessaging as wm;

  /// The constants `sweetview-keycodes` decides by are the Win32 ones.
  #[test]
  fn the_keycodes_crate_constants_are_the_win32_values() {
    let messages = [
      (message::WM_KEYDOWN, wm::WM_KEYDOWN),
      (message::WM_KEYUP, wm::WM_KEYUP),
      (message::WM_SYSKEYDOWN, wm::WM_SYSKEYDOWN),
      (message::WM_SYSKEYUP, wm::WM_SYSKEYUP),
      (message::WM_MOUSEMOVE, wm::WM_MOUSEMOVE),
      (message::WM_LBUTTONDOWN, wm::WM_LBUTTONDOWN),
      (message::WM_LBUTTONUP, wm::WM_LBUTTONUP),
      (message::WM_RBUTTONDOWN, wm::WM_RBUTTONDOWN),
      (message::WM_RBUTTONUP, wm::WM_RBUTTONUP),
      (message::WM_MBUTTONDOWN, wm::WM_MBUTTONDOWN),
      (message::WM_MBUTTONUP, wm::WM_MBUTTONUP),
      (message::WM_MOUSEWHEEL, wm::WM_MOUSEWHEEL),
      (message::WM_XBUTTONDOWN, wm::WM_XBUTTONDOWN),
      (message::WM_XBUTTONUP, wm::WM_XBUTTONUP),
      (message::WM_MOUSEHWHEEL, wm::WM_MOUSEHWHEEL),
    ];
    for (ours, theirs) in messages {
      assert_eq!(ours, theirs);
    }
    let keys = [
      (vk::VK_RETURN, kam::VK_RETURN),
      (vk::VK_SHIFT, kam::VK_SHIFT),
      (vk::VK_CONTROL, kam::VK_CONTROL),
      (vk::VK_MENU, kam::VK_MENU),
      (vk::VK_PAUSE, kam::VK_PAUSE),
      (vk::VK_PRIOR, kam::VK_PRIOR),
      (vk::VK_NEXT, kam::VK_NEXT),
      (vk::VK_END, kam::VK_END),
      (vk::VK_HOME, kam::VK_HOME),
      (vk::VK_LEFT, kam::VK_LEFT),
      (vk::VK_UP, kam::VK_UP),
      (vk::VK_RIGHT, kam::VK_RIGHT),
      (vk::VK_DOWN, kam::VK_DOWN),
      (vk::VK_SNAPSHOT, kam::VK_SNAPSHOT),
      (vk::VK_INSERT, kam::VK_INSERT),
      (vk::VK_DELETE, kam::VK_DELETE),
      (vk::VK_LWIN, kam::VK_LWIN),
      (vk::VK_RWIN, kam::VK_RWIN),
      (vk::VK_APPS, kam::VK_APPS),
      (vk::VK_DIVIDE, kam::VK_DIVIDE),
      (vk::VK_F24, kam::VK_F24),
      (vk::VK_NUMLOCK, kam::VK_NUMLOCK),
      (vk::VK_LSHIFT, kam::VK_LSHIFT),
      (vk::VK_RSHIFT, kam::VK_RSHIFT),
      (vk::VK_LCONTROL, kam::VK_LCONTROL),
      (vk::VK_RCONTROL, kam::VK_RCONTROL),
      (vk::VK_LMENU, kam::VK_LMENU),
      (vk::VK_RMENU, kam::VK_RMENU),
      (vk::VK_PACKET, kam::VK_PACKET),
    ];
    for (ours, theirs) in keys {
      assert_eq!(ours, u32::from(theirs.0));
    }
    assert_eq!(i32::from(win::WHEEL_DELTA), wm::WHEEL_DELTA as i32);
  }

  /// C++ fork, `unit_tests.cc`: "Keyboard hook: scan code from a bare virtual
  /// key on Windows", against the real `MapVirtualKeyW` as the C++ test runs it.
  #[test]
  fn keyboard_hook_scan_code_from_a_bare_virtual_key_on_windows() {
    let bare = |vk: u32| win::dom_scan(vk, 0, false, map_vk_to_vsc_ex);
    assert_eq!(bare(vk::VK_DELETE), 0xE053);
    assert_eq!(bare(vk::VK_HOME), 0xE047);
    assert_eq!(bare(vk::VK_LEFT), 0xE04B);
    assert_eq!(bare(vk::VK_RETURN), 0x001C);
    assert_eq!(bare(vk::VK_PAUSE), 0x0045);
    assert_eq!(bare(vk::VK_NUMLOCK), 0xE045);
    assert_eq!(bare(vk::VK_SNAPSHOT), 0xE037);
    assert_eq!(bare(vk::VK_RCONTROL), 0xE01D);
    assert_eq!(bare(vk::VK_LWIN), 0xE05B);
    assert_eq!(bare(vk::VK_DIVIDE), 0xE035);
    assert_eq!(bare(vk::VK_PACKET), 0);
    assert_eq!(bare(u32::from(b'Z')), 0x002C);
    // A scan code that is there is used as it is, with the extended flag.
    assert_eq!(win::dom_scan(vk::VK_DELETE, 0x53, true, map_vk_to_vsc_ex), 0xE053);
    // The numpad's decimal under Num Lock off.
    assert_eq!(win::dom_scan(vk::VK_DELETE, 0x53, false, map_vk_to_vsc_ex), 0x0053);
  }
}
