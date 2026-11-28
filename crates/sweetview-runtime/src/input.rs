//! The process's system-wide mouse and keyboard hooks.
//!
//! One of each per process. A hook lives on the UI thread, whose message loop
//! delivers its events; the runtime keeps the installed hook and removes it on
//! request. The results are the `webview_error_t` codes the C API returned, so
//! the TypeScript layer reports them as before.

use std::cell::RefCell;

pub use sweetview_platform_input::permissions;
pub use sweetview_platform_input::{KeyEvent, MouseEvent};
use sweetview_platform_input::{KeyboardHook, MouseHook};

use crate::error::Result;
use crate::threads;

/// `WEBVIEW_ERROR_OK`.
const OK: i32 = 0;
/// `WEBVIEW_ERROR_NOT_FOUND`: there is no hook to remove.
const NOT_FOUND: i32 = 2;

thread_local! {
  static MOUSE: RefCell<Option<MouseHook>> = const { RefCell::new(None) };
  static KEYBOARD: RefCell<Option<KeyboardHook>> = const { RefCell::new(None) };
}

/// Installs the process's mouse hook. `handler` returns true to swallow the event.
pub fn install_mouse_hook(handler: impl Fn(&MouseEvent) -> bool + 'static) -> Result<i32> {
  threads::require_ui_thread()?;
  Ok(match MouseHook::install(handler) {
    Ok(hook) => {
      MOUSE.with(|slot| *slot.borrow_mut() = Some(hook));
      OK
    }
    Err(error) => error.code(),
  })
}

/// Removes the mouse hook. Safe to call from inside its own handler.
pub fn remove_mouse_hook() -> Result<i32> {
  threads::require_ui_thread()?;
  // Taken out first, so nothing is borrowed while the hook is removed.
  let hook = MOUSE.with(|slot| slot.borrow_mut().take());
  Ok(match hook {
    None => NOT_FOUND,
    Some(hook) => hook.remove().map_or_else(|error| error.code(), |()| OK),
  })
}

/// Installs the process's keyboard hook. `handler` returns true to swallow the event.
pub fn install_keyboard_hook(handler: impl Fn(&KeyEvent) -> bool + 'static) -> Result<i32> {
  threads::require_ui_thread()?;
  Ok(match KeyboardHook::install(handler) {
    Ok(hook) => {
      KEYBOARD.with(|slot| *slot.borrow_mut() = Some(hook));
      OK
    }
    Err(error) => error.code(),
  })
}

/// Removes both hooks, whichever are installed: a system-wide hook must not
/// outlive the loop that answers it. Errors are not reported; the OS removes
/// a hook whose thread is gone in any case.
pub(crate) fn release_all() {
  let mouse = MOUSE.try_with(|slot| slot.try_borrow_mut().ok().and_then(|mut hook| hook.take())).ok().flatten();
  if let Some(hook) = mouse {
    let _ = hook.remove();
  }
  let keyboard = KEYBOARD.try_with(|slot| slot.try_borrow_mut().ok().and_then(|mut hook| hook.take())).ok().flatten();
  if let Some(hook) = keyboard {
    let _ = hook.remove();
  }
}

/// Removes the keyboard hook. Safe to call from inside its own handler.
pub fn remove_keyboard_hook() -> Result<i32> {
  threads::require_ui_thread()?;
  let hook = KEYBOARD.with(|slot| slot.borrow_mut().take());
  Ok(match hook {
    None => NOT_FOUND,
    Some(hook) => hook.remove().map_or_else(|error| error.code(), |()| OK),
  })
}
