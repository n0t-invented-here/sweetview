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
  use std::cell::{Cell, RefCell};
  use std::collections::VecDeque;
  use std::rc::Rc;
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::Arc;

  use sweetview_platform_input::KeyEventKind;
  use sweetview_platform_window::test_support as os;

  use super::*;
  use crate::runtime::testing::on_ui_thread;

  /// F24: bound to nothing, and swallowed by the test's hook so no other window sees it.
  const F24: u16 = 0x87;
  /// Set, with the mode, in the environment of the child process each test starts.
  const CHILD: &str = "SWEETVIEW_RUNTIME_TEST_HOOK_OWN_FOREGROUND";

  fn kind_name(kind: KeyEventKind) -> &'static str {
    match kind {
      KeyEventKind::Down => "down",
      KeyEventKind::Up => "up",
      KeyEventKind::Repeat => "repeat",
    }
  }

  type Step = Box<dyn FnOnce()>;

  /// The child's half, as `hook-own-foreground.ts` was: in a process of its own, a window of the
  /// application's own (a `Window`, or a webview's own window) shown, the keyboard hook installed,
  /// and the blocking loop run; one step every 350 ms from a native interval: take the foreground
  /// twice, tap F24 (down and up, as real input, from another thread so the hook's thread is free),
  /// record what the hook saw; give the foreground to the taskbar, tap again, record; end the loop.
  /// Prints `RESULT <json>`.
  fn child(mode: &str) {
    use crate::engine::{Engine, Host, SizeHint};
    use crate::window::{Window, WindowInit};
    crate::loop_tests::use_test_webview_profile();
    on_ui_thread(|runtime| {
      let (handle, keep): (isize, Step) = if mode == "webview" {
        let engine = Engine::create(false, Host::Own, None).expect("webview");
        engine.set_title("rt hook own foreground webview");
        engine.set_html("<!doctype html><p>hook own foreground</p>");
        engine.set_size(420, 300, SizeHint::None);
        (engine.window_handle(), Box::new(move || engine.destroy()))
      } else {
        let init = WindowInit { title: "rt hook own foreground".into(), bounds: Some(crate::Rect::new(220, 220, 420, 300)), frame: true, resizable: true, ..Default::default() };
        let window = Window::create(init).expect("window");
        window.show().expect("show");
        (window.handle(), Box::new(move || window.dispose()))
      };
      let seen: Rc<RefCell<Vec<&'static str>>> = Rc::default();
      let sink = seen.clone();
      let installed = install_keyboard_hook(move |event| {
        if event.raw == u32::from(F24) {
          sink.borrow_mut().push(kind_name(event.kind));
        }
        true // swallowed, so F24 reaches nothing else on the desktop
      });
      assert_eq!(installed, Ok(OK));
      let result: Rc<RefCell<serde_json::Map<String, serde_json::Value>>> = Rc::default();
      let (before, ours) = (Rc::new(Cell::new(0usize)), Rc::new(Cell::new(false)));
      let sent = Arc::new(AtomicBool::new(false));
      let typing = || -> Step {
        let (seen, before, ours, sent) = (seen.clone(), before.clone(), ours.clone(), sent.clone());
        Box::new(move || {
          before.set(seen.borrow().len());
          ours.set(os::foreground() == handle);
          std::thread::spawn(move || {
            let down = os::send_key(F24, false);
            let up = os::send_key(F24, true);
            sent.store(down && up, Ordering::SeqCst);
          });
        })
      };
      let record = |name: &'static str| -> Step {
        let (seen, result, before, ours, sent) = (seen.clone(), result.clone(), before.clone(), ours.clone(), sent.clone());
        Box::new(move || {
          let saw: Vec<&str> = seen.borrow()[before.get()..].to_vec();
          let entry = serde_json::json!({ "foregroundIsOurs": ours.get(), "saw": saw, "sent": sent.load(Ordering::SeqCst) });
          result.borrow_mut().insert(name.into(), entry);
        })
      };
      let quitter = runtime.clone();
      let steps: VecDeque<Step> = VecDeque::from(vec![
        Box::new(|| {}) as Step,
        Box::new(move || {
          os::take_foreground(handle);
        }),
        Box::new(move || {
          os::take_foreground(handle);
        }),
        typing(),
        record("inFront"),
        Box::new(|| {
          os::take_foreground(os::taskbar());
        }),
        typing(),
        record("behind"),
        Box::new(move || quitter.request_exit()),
      ]);
      let steps = RefCell::new(steps);
      let interval = runtime
        .set_interval(350, move || {
          let step = steps.borrow_mut().pop_front();
          if let Some(step) = step {
            step();
          }
        })
        .expect("steps");
      // The limit: whatever happens, the run ends.
      let ender = runtime.clone();
      let limit = runtime.set_timeout(20_000, move || ender.request_exit()).expect("limit");
      runtime.run_blocking().expect("the blocking run");
      runtime.clear_timeout(interval);
      runtime.clear_timeout(limit);
      assert_eq!(remove_keyboard_hook(), Ok(OK));
      keep();
      println!("RESULT {}", serde_json::Value::Object(result.borrow().clone()));
    });
  }

  /// The parent's half: runs the child up to three times until a run can judge, then judges what
  /// the hook saw. A run can judge when the desktop gave the child's window the foreground and the
  /// control (typed with another window in front) reached the hook: when the control saw nothing,
  /// the injected key reached no hook at all (`SendInput` refused, or another process's later hook
  /// took it), whatever window was in front. Three runs that cannot judge say `not run`, as the TS
  /// test skipped.
  fn typed_in_front_and_behind(mode: &str, test: &str) {
    if let Some(child_mode) = std::env::var_os(CHILD) {
      if child_mode == mode {
        child(mode);
      }
      return;
    }
    let mut last = serde_json::Value::Null;
    for _ in 0..3 {
      let output = std::process::Command::new(std::env::current_exe().expect("the test executable"))
        .args([test, "--exact", "--nocapture", "--test-threads=1"])
        .env(CHILD, mode)
        .output()
        .expect("the child process");
      let stdout = String::from_utf8_lossy(&output.stdout);
      assert!(output.status.success(), "the child ran: {stdout}\n{}", String::from_utf8_lossy(&output.stderr));
      let line = stdout.split("RESULT ").nth(1).and_then(|rest| rest.lines().next()).unwrap_or("null");
      last = serde_json::from_str(line).unwrap_or(serde_json::Value::Null);
      if judged(&last) {
        break;
      }
    }
    if last["inFront"]["foregroundIsOurs"] != serde_json::Value::Bool(true) {
      panic!("not run: the desktop did not give the child's window the foreground in three runs: {last}");
    }
    if !judged(&last) {
      panic!("not run: in three runs the key typed with another window in front (the control) reached no hook, so this desktop's injected input could not be judged: {last}");
    }
    let down_up = serde_json::json!(["down", "up"]);
    assert_eq!(last["inFront"]["saw"], down_up, "typed into the application's own {mode} window: {last}");
    assert_eq!(last["behind"]["foregroundIsOurs"], serde_json::Value::Bool(false), "the control ran with another window in front: {last}");
    assert_eq!(last["behind"]["saw"], down_up, "the control: typed with another application's window in front: {last}");
  }

  /// A run that can judge: the child's window was in front, and the control reached the hook.
  fn judged(run: &serde_json::Value) -> bool {
    run["inFront"]["foregroundIsOurs"] == serde_json::Value::Bool(true) && run["behind"]["saw"] == serde_json::json!(["down", "up"])
  }

  /// Windows does not call a process's own low-level keyboard hook while a window of that
  /// process, registered for raw keyboard input, holds the foreground; `tao` registers its
  /// windows unless told not to (`build_event_loop`). So a key typed into the application's own
  /// window must reach the hook as one typed into another application's does. Run, as
  /// `hook-own-foreground.ts` was, in a process of its own under the blocking loop.
  #[test]
  fn a_key_typed_while_the_applications_own_window_is_in_front_reaches_the_keyboard_hook() {
    typed_in_front_and_behind("window", "input::tests::a_key_typed_while_the_applications_own_window_is_in_front_reaches_the_keyboard_hook");
  }

  /// The same, with the window of a webview of its own in front: WebView2's own windows inside
  /// it must not keep the key from the hook either.
  #[test]
  fn a_key_typed_while_the_applications_own_webview_window_is_in_front_reaches_the_keyboard_hook() {
    typed_in_front_and_behind("webview", "input::tests::a_key_typed_while_the_applications_own_webview_window_is_in_front_reaches_the_keyboard_hook");
  }
}
