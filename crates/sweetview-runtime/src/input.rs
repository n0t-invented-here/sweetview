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

#[cfg(all(test, windows))]
mod tests {
  use std::cell::RefCell;
  use std::rc::Rc;
  use std::time::{Duration, Instant};

  use sweetview_platform_input::KeyEventKind;
  use sweetview_platform_window::test_support as os;

  use super::*;
  use crate::runtime::testing::on_ui_thread;
  use crate::runtime::Runtime;

  /// F24: bound to nothing, and swallowed by the test's hook so no other window sees it.
  const F24: u16 = 0x87;

  fn pump_for(runtime: &Runtime, ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
      runtime.pump();
      std::thread::sleep(Duration::from_millis(5));
    }
  }

  /// F24 down and up as real input, sent from another thread while this one pumps (a hook's
  /// thread busy inside `SendInput` would make the OS pass the first event on unseen).
  fn tap_f24(runtime: &Runtime) {
    let sender = std::thread::spawn(|| os::send_key(F24, false) && os::send_key(F24, true));
    while !sender.is_finished() {
      runtime.pump();
    }
    assert!(sender.join().expect("the sending thread"), "SendInput took both keys");
  }

  /// What the hook saw of one tap of F24, and whether the window was in front when it was typed.
  #[derive(Debug, PartialEq)]
  struct Typed {
    window_in_front: bool,
    saw: Vec<KeyEventKind>,
  }

  /// Installs the keyboard hook, puts the window with handle value `window` in front, taps F24,
  /// then gives the foreground to the taskbar and taps it again: what the hook saw each time.
  fn typed_in_front_and_behind(runtime: &Runtime, window: isize) -> (Typed, Typed) {
    let seen: Rc<RefCell<Vec<KeyEventKind>>> = Rc::default();
    let sink = seen.clone();
    let installed = install_keyboard_hook(move |event| {
      if event.raw != u32::from(F24) {
        return false;
      }
      sink.borrow_mut().push(event.kind);
      true
    });
    assert_eq!(installed, Ok(OK));
    let tap = |front: bool| {
      let before = seen.borrow().len();
      let window_in_front = os::foreground() == window;
      assert_eq!(window_in_front, front, "the foreground is {:#x}, the window is {window:#x}", os::foreground());
      tap_f24(runtime);
      let deadline = Instant::now() + Duration::from_secs(2);
      while seen.borrow().len() < before + 2 && Instant::now() < deadline {
        runtime.pump();
      }
      pump_for(runtime, 30);
      Typed { window_in_front, saw: seen.borrow()[before..].to_vec() }
    };
    pump_for(runtime, 200);
    let mut given = false;
    for _ in 0..10 {
      if os::take_foreground(window) {
        given = true;
        break;
      }
      pump_for(runtime, 100);
    }
    pump_for(runtime, 100);
    assert!(
      given && os::foreground() == window,
      "refused to judge: the desktop did not give the test's window the foreground (it is {:#x}); run again",
      os::foreground()
    );
    let in_front = tap(true);
    assert!(os::take_foreground(os::taskbar()), "the taskbar took the foreground");
    pump_for(runtime, 100);
    let behind = tap(false);
    assert_eq!(remove_keyboard_hook(), Ok(OK));
    (in_front, behind)
  }

  /// Windows does not call a process's own low-level keyboard hook while a window of that
  /// process, registered for raw keyboard input, holds the foreground; `tao` registers its
  /// windows unless told not to (`build_event_loop`). So a key typed into the application's own
  /// window must reach the hook as one typed into another application's does.
  #[test]
  fn a_key_typed_while_the_applications_own_window_is_in_front_reaches_the_keyboard_hook() {
    use crate::window::{Window, WindowInit};
    on_ui_thread(|runtime| {
      let window = Window::create(WindowInit {
        title: "rt hook own foreground".into(),
        bounds: Some(crate::Rect::new(220, 220, 420, 300)),
        frame: true,
        resizable: true,
        ..Default::default()
      })
      .expect("window");
      window.show().expect("show");
      let (in_front, behind) = typed_in_front_and_behind(&runtime, window.handle());
      window.dispose();
      let down_up = vec![KeyEventKind::Down, KeyEventKind::Up];
      assert_eq!(in_front, Typed { window_in_front: true, saw: down_up.clone() }, "typed into the application's own window");
      assert_eq!(behind, Typed { window_in_front: false, saw: down_up }, "the control: typed with another application's window in front");
    });
  }

  /// The same, with the window of a webview of its own in front: WebView2's own windows inside
  /// it must not keep the key from the hook either.
  #[test]
  #[cfg(feature = "webview")]
  fn a_key_typed_while_the_applications_own_webview_window_is_in_front_reaches_the_keyboard_hook() {
    use crate::engine::{Engine, Host, SizeHint};
    crate::loop_tests::use_test_webview_profile();
    on_ui_thread(|runtime| {
      let engine = Engine::create(false, Host::Own, None).expect("webview");
      engine.set_title("rt hook own foreground webview");
      engine.set_html("<!doctype html><p>hook own foreground</p>");
      engine.set_size(420, 300, SizeHint::None);
      let (in_front, behind) = typed_in_front_and_behind(&runtime, engine.window_handle());
      engine.destroy();
      pump_for(&runtime, 50);
      let down_up = vec![KeyEventKind::Down, KeyEventKind::Up];
      assert_eq!(in_front, Typed { window_in_front: true, saw: down_up.clone() }, "typed into the application's own webview window");
      assert_eq!(behind, Typed { window_in_front: false, saw: down_up }, "the control: typed with another application's window in front");
    });
  }
}
