//! Access to the event loop's window target while the loop is running.

use std::cell::RefCell;
use std::fmt;

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
/// click) still has to create windows. `LoopHost` keeps its own handle on the
/// loop's window target, taken when the loop is handed over, and lends it out
/// through [`LoopHost::with_target`]. `tao`'s `EventLoopWindowTarget` is
/// `Clone`, and a clone shares the loop's thread, message target and runner
/// with the one `tao` passes to the event handler, so a window made through it
/// is made exactly as one made inside the handler. (`tao` derives that
/// `Clone`, so the loop's user-event type must be `Clone` too.)
///
/// Not `Send` and not `Sync`: it belongs to the thread that made it.
pub struct LoopHost<T: 'static> {
  event_loop: RefCell<EventLoop<T>>,
  /// The loop's window target, cloned from `event_loop` when the host was made.
  target: EventLoopWindowTarget<T>,
}

impl<T: Clone + 'static> LoopHost<T> {
  pub fn new(event_loop: EventLoop<T>) -> Self {
    let target = (*event_loop).clone();
    Self { event_loop: RefCell::new(event_loop), target }
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
  pub fn run<F>(&self, handler: F) -> Result<i32, AlreadyRunning>
  where
    F: FnMut(Event<'_, T>, &EventLoopWindowTarget<T>, &mut ControlFlow),
  {
    let mut event_loop = self.event_loop.try_borrow_mut().map_err(|_| AlreadyRunning)?;
    Ok(event_loop.run_return(handler))
  }

  /// Lends the loop's window target, whether or not the loop is running.
  pub fn with_target<R>(&self, f: impl FnOnce(&EventLoopWindowTarget<T>) -> R) -> R {
    f(&self.target)
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
    assert_eq!(host.with_target(|_| 1), 1);

    let mut nested = None;
    let mut inside = None;
    host
      .run(|event, _target, control_flow| {
        if let Event::NewEvents(_) = event {
          // Inside a run the loop is borrowed mutably, and the target is still reachable.
          inside = Some(host.with_target(|_| host.is_running()));
          nested = Some(host.run(|_, _, flow| *flow = ControlFlow::Exit));
        }
        *control_flow = ControlFlow::Exit;
      })
      .expect("no run was in progress");
    assert_eq!(inside, Some(true));
    assert_eq!(nested, Some(Err(AlreadyRunning)));
    assert!(!host.is_running());
    assert_eq!(host.with_target(|_| 2), 2);
  }
}
