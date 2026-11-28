//! The end of the application: what Sweetview made for it is released by Sweetview.
//!
//! The binding calls [`release_all`] when the application's process ends: on Bun's
//! `exit` event, which fires when the script ends, on `process.exit` and after an
//! uncaught exception (decision D36). Nothing is released while the process runs.
//! Each owner here already frees its OS resource when it is dropped or disposed;
//! this makes sure that happens before the process goes, in an order that is safe:
//!
//! 1. the system-wide input hooks, which stall the desktop's input while no loop answers them;
//! 2. the webviews, each before the window it lives in;
//! 3. the tray icons, before the loop's windows;
//! 4. the notifiers: their handlers end and their window and hidden notification icons go,
//!    but the toasts they showed stay for the user to read;
//! 5. the single-instance locks;
//! 6. the menus handed to the application;
//! 7. the windows, those whose destroy was waiting for a later turn too;
//! 8. the runtime's deferred jobs, timers, drains and listeners.
//!
//! Each step runs whatever the one before it did: a step that panics is caught, named
//! on stderr once, and the next step runs. Called from inside the loop (the process
//! exits from inside a callback), what is in use further up the stack is left to the
//! OS, as each owner's own dispose leaves it. The runtime itself, its loop and its COM
//! apartment stay, so objects made afterwards (in another `exit` listener) still work.

use std::panic::{catch_unwind, AssertUnwindSafe};

#[cfg(feature = "webview")]
use crate::engine;
use crate::{activation, input, menu, notify, threads, tray, window, Runtime};

/// One step of the release: its name for the log line, and what it does.
type Step = (&'static str, fn());

/// The steps, in the order above.
const STEPS: &[Step] = &[
  ("the input hooks", input::release_all),
  #[cfg(feature = "webview")]
  ("the webviews", engine::release_all),
  ("the tray icons", tray::release_all),
  ("the notifiers", notify::release_all),
  ("the single-instance locks", activation::release_all),
  ("the menus handed out", menu::release_all),
  ("the windows", window::destroy_all),
  ("the runtime's callbacks", release_runtime_callbacks),
];

fn release_runtime_callbacks() {
  if let Some(runtime) = Runtime::existing() {
    runtime.release_callbacks();
  }
}

/// Releases everything Sweetview made on this thread that is still alive, in the
/// order above. Does nothing on a thread other than the UI thread. Safe to call
/// any number of times.
pub fn release_all() {
  if !threads::is_ui_thread() {
    return;
  }
  run_steps(STEPS);
}

/// Runs every step, each whatever the others do: a panic in one is caught and named once.
/// Returns how many steps panicked.
fn run_steps(steps: &[Step]) -> usize {
  let mut panicked = 0;
  for (name, step) in steps {
    // Each step leaves its own state consistent before anything it calls can panic (every
    // registry is drained before its entries are released), so going on after one is sound.
    if catch_unwind(AssertUnwindSafe(step)).is_err() {
      panicked += 1;
      eprintln!("sweetview: releasing {name} at the end of the application panicked; the rest were released");
    }
  }
  panicked
}

#[cfg(all(test, windows))]
mod tests {
  use std::cell::{Cell, RefCell};
  use std::rc::Rc;
  use std::time::{Duration, Instant};

  use sweetview_platform_window::BorrowedWindow;

  use super::*;
  use crate::menu::MenuItem;
  use crate::notify::{ForcedPath, Notification, NotifierOptions, Shown};
  use crate::runtime::testing::on_ui_thread;
  use crate::tray::{Tray, TrayInit};
  use crate::window::{Window, WindowInit};

  fn alive(handle: isize) -> bool {
    BorrowedWindow::with_handle_value(handle, |_| ()).is_some()
  }

  #[test]
  fn release_all_releases_what_is_alive_and_the_owners_go_on_answering() {
    on_ui_thread(|runtime| {
      let window = Window::create(WindowInit { title: "rt release".into(), frame: true, resizable: true, no_activate: true, ..Default::default() }).expect("window");
      let tray = Tray::new(TrayInit {
        tooltip: "sweetview runtime release test".into(),
        icon: None,
        has_menu: false,
        on_click: None,
        on_double_click: None,
        open_menu: Rc::new(Vec::new),
        menu_chosen: Rc::new(|_| {}),
      })
      .expect("tray");
      let notifier = notify::Notifier::new(NotifierOptions::default(), |_, _| {}).expect("notifier");
      notifier.force_path(ForcedPath::BalloonOnly);
      let note = Notification { id: "release".into(), title: "Sweetview test".into(), silent: true, ..Default::default() };
      assert!(matches!(notifier.show(&note), Some(Shown::Balloon(_))));
      assert_eq!(notifier.pending_balloons(), 1);
      let menu = menu::build_handed_out(&[MenuItem::Item { id: 1, label: "one".into(), enabled: true, checked: false, icon: None }]).expect("menu");
      let fired = Rc::new(Cell::new(false));
      let seen = fired.clone();
      runtime.set_timeout(30, move || seen.set(true)).expect("timeout");
      let (window_handle, tray_handle) = (window.handle(), tray.window_handle_value());
      assert!(alive(window_handle) && alive(tray_handle));

      release_all();

      assert!(!alive(window_handle), "the window was destroyed");
      assert!(!alive(tray_handle), "the tray icon's window was destroyed");
      assert_eq!(tray.window_handle_value(), 0);
      assert_eq!(notifier.pending_balloons(), 0, "the balloon's icon was removed");
      assert!(!notifier.notify(&note), "a released notifier shows nothing");
      assert!(!menu::destroy_handed_out(menu), "the handed-out menu was freed");
      let deadline = Instant::now() + Duration::from_millis(200);
      while Instant::now() < deadline {
        runtime.pump();
      }
      assert!(!fired.get(), "a released timeout never runs");
      // Each owner's own dispose, after the release, does nothing more; a second release neither.
      tray.dispose();
      window.dispose();
      release_all();
      // The runtime goes on: what is made afterwards works.
      let later = Rc::new(Cell::new(false));
      let seen = later.clone();
      runtime.set_timeout(5, move || seen.set(true)).expect("timeout");
      let deadline = Instant::now() + Duration::from_secs(2);
      while !later.get() && Instant::now() < deadline {
        runtime.pump();
      }
      assert!(later.get());
    });
  }

  #[test]
  fn a_step_that_panics_does_not_stop_the_others() {
    thread_local! {
      static RAN: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
    }
    fn first() {
      RAN.with(|ran| ran.borrow_mut().push("first"));
    }
    fn panics() {
      RAN.with(|ran| ran.borrow_mut().push("panics"));
      panic!("a release step panicked on purpose");
    }
    fn last() {
      RAN.with(|ran| ran.borrow_mut().push("last"));
    }
    let steps: [Step; 3] = [("the first", first), ("the one that panics", panics), ("the last", last)];
    assert_eq!(run_steps(&steps), 1);
    assert_eq!(RAN.with(|ran| ran.borrow().clone()), ["first", "panics", "last"]);
  }

  #[test]
  fn another_thread_releases_nothing() {
    on_ui_thread(|_runtime| {
      let window = Window::create(WindowInit { title: "rt release other thread".into(), frame: true, no_activate: true, ..Default::default() }).expect("window");
      std::thread::spawn(release_all).join().expect("thread");
      assert!(alive(window.handle()));
      window.dispose();
    });
  }
}
