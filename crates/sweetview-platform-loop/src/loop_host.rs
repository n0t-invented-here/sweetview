//! Access to the event loop's window target while the loop is running.

use std::cell::{Cell, RefCell};
use std::fmt;
use std::ptr::NonNull;

use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoop, EventLoopWindowTarget};
use tao::platform::run_return::EventLoopExtRunReturn;

/// [`LoopHost::run`] was called while a run was already in progress on this thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlreadyRunning;

impl fmt::Display for AlreadyRunning {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("the event loop is already running on this thread")
  }
}

impl std::error::Error for AlreadyRunning {}

/// Owns the `tao` event loop of the UI thread.
///
/// `run_return` borrows the loop mutably for as long as it runs, and gives the
/// window target only to its event handler. Code that the OS calls from inside
/// the run but outside that handler (a WebView2 callback, a timer, a tray
/// click) still has to create windows. `LoopHost` remembers the target `tao`
/// handed to the handler for the duration of the run and lends it out through
/// [`LoopHost::with_target`].
///
/// Not `Send` and not `Sync`: it belongs to the thread that made it.
pub struct LoopHost<T: 'static> {
  event_loop: RefCell<EventLoop<T>>,
  /// The target of the run in progress. Set only by `run`, cleared by its guard.
  running: Cell<Option<NonNull<EventLoopWindowTarget<T>>>>,
}

/// Clears `LoopHost::running` when a run ends, including by unwinding.
struct RunGuard<'a, T: 'static>(&'a LoopHost<T>);

impl<T: 'static> Drop for RunGuard<'_, T> {
  fn drop(&mut self) {
    self.0.running.set(None);
  }
}

impl<T: 'static> LoopHost<T> {
  pub fn new(event_loop: EventLoop<T>) -> Self {
    Self { event_loop: RefCell::new(event_loop), running: Cell::new(None) }
  }

  /// True while [`LoopHost::run`] is on the stack.
  pub fn is_running(&self) -> bool {
    self.event_loop.try_borrow_mut().is_err()
  }

  /// Runs the loop until `handler` sets `ControlFlow::Exit` (or `ExitWithCode`),
  /// or the thread's quit request ends it. Returns the exit code: the one the
  /// handler set, or 0 when a `WM_QUIT` ended the run.
  ///
  /// A call made while a run is already on the stack returns
  /// [`AlreadyRunning`] and runs nothing.
  pub fn run<F>(&self, mut handler: F) -> Result<i32, AlreadyRunning>
  where
    F: FnMut(Event<'_, T>, &EventLoopWindowTarget<T>, &mut ControlFlow),
  {
    let mut event_loop = self.event_loop.try_borrow_mut().map_err(|_| AlreadyRunning)?;
    let _guard = RunGuard(self);
    let code = event_loop.run_return(|event, target, control_flow| {
      // The same target every time; recorded on each event so it is in place
      // before the first callback that could ask for it.
      self.running.set(Some(NonNull::from(target)));
      handler(event, target, control_flow);
    });
    Ok(code)
  }

  /// Lends the loop's window target, whether or not the loop is running.
  ///
  /// Returns `None` only in the window between a run starting and `tao`
  /// delivering its first event, when no callback has run yet.
  pub fn with_target<R>(&self, f: impl FnOnce(&EventLoopWindowTarget<T>) -> R) -> Option<R> {
    if let Some(target) = self.running.get() {
      // SAFETY: `running` is set only inside `run`, from the reference `tao`
      // passed to the event handler. That reference borrows the `EventLoop`
      // held by `run`'s `RefMut` and lives for the whole `run_return` call.
      // `RunGuard` clears `running` before `run` returns or unwinds, and
      // `LoopHost` is neither `Send` nor `Sync`, so this is the same thread
      // and the `run` frame that set it is still on the stack below us.
      let target = unsafe { target.as_ref() };
      return Some(f(target));
    }
    // Not running: nothing else holds the loop, so a shared borrow is free.
    let event_loop = self.event_loop.try_borrow().ok()?;
    Some(f(&event_loop))
  }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;
  use tao::event_loop::EventLoopBuilder;
  use tao::platform::windows::EventLoopBuilderExtWindows;

  #[test]
  fn target_is_reachable_inside_and_outside_a_run_and_a_nested_run_is_refused() {
    let _serial = crate::TEST_SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let host: LoopHost<()> = LoopHost::new(EventLoopBuilder::new().with_any_thread(true).build());
    assert!(!host.is_running());
    // Outside a run: the target comes from the loop itself.
    assert_eq!(host.with_target(|_| 1), Some(1));

    let mut nested = None;
    let mut inside = None;
    host
      .run(|event, _target, control_flow| {
        if let Event::NewEvents(_) = event {
          // Inside a run the loop is borrowed mutably, and the target is still reachable.
          inside = host.with_target(|_| host.is_running());
          nested = Some(host.run(|_, _, flow| *flow = ControlFlow::Exit));
        }
        *control_flow = ControlFlow::Exit;
      })
      .expect("no run was in progress");
    assert_eq!(inside, Some(true));
    assert_eq!(nested, Some(Err(AlreadyRunning)));
    assert!(!host.is_running());
    assert_eq!(host.with_target(|_| 2), Some(2));
  }
}
