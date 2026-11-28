//! The end of the application: what Sweetview made for it is released by Sweetview.
//!
//! The binding calls [`release_all`] when the application ends: when its blocking
//! loop has returned, and when the process exits for any reason JavaScript sees
//! (decision D36). Each owner here already frees its OS resource when it is dropped
//! or disposed; this makes sure that happens before the process goes, in an order
//! that is safe:
//!
//! 1. the system-wide input hooks, which stall the desktop's input while no loop answers them;
//! 2. the webviews, each before the window it lives in;
//! 3. the tray icons, before the loop's windows;
//! 4. the notifiers: their pending toasts hidden, their hidden notification icons removed;
//! 5. the single-instance locks;
//! 6. the menus handed to the application;
//! 7. the windows;
//! 8. the runtime's deferred jobs, timers, drains and listeners.
//!
//! Called from inside the loop (the process exits from inside a callback), what is
//! in use further up the stack is left to the OS, as each owner's own dispose
//! leaves it. Everything else is released at once. The runtime itself, its loop and
//! its COM apartment stay: the application may make new objects afterwards, and
//! they are released the same way at its next end.

use crate::{activation, engine, input, menu, notify, threads, tray, window, Runtime};

/// Releases everything Sweetview made on this thread that is still alive, in the
/// order above. Does nothing on a thread other than the UI thread. Safe to call
/// any number of times.
pub fn release_all() {
  if !threads::is_ui_thread() {
    return;
  }
  input::release_all();
  engine::release_all();
  tray::release_all();
  notify::release_all();
  activation::release_all();
  menu::release_all();
  window::destroy_all();
  if let Some(runtime) = Runtime::existing() {
    runtime.release_callbacks();
  }
}

#[cfg(all(test, windows))]
mod tests {
  use std::cell::Cell;
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
  fn another_thread_releases_nothing() {
    on_ui_thread(|_runtime| {
      let window = Window::create(WindowInit { title: "rt release other thread".into(), frame: true, no_activate: true, ..Default::default() }).expect("window");
      std::thread::spawn(release_all).join().expect("thread");
      assert!(alive(window.handle()));
      window.dispose();
    });
  }
}
