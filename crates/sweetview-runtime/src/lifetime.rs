//! The end of the application: what Sweetview made for it is released by Sweetview.
//!
//! The binding calls [`release_all`] when the application ends: when its blocking
//! loop has returned, and when the process exits for any reason JavaScript sees
//! (decision D35). Each owner here already frees its OS resource when it is dropped
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
