//! The UI thread's loop and what rides on it.
//!
//! One [`Runtime`] exists per process, on the UI thread, made on first use.
//! It runs the `tao` loop in two modes:
//!
//! * [`Runtime::run_blocking`] stays inside the loop until
//!   [`Runtime::request_exit`]. JavaScript runs only as callbacks from inside it.
//! * [`Runtime::pump`] dispatches what is waiting and returns, so a Bun timer
//!   can call it and Bun's own loop keeps turning.
//!
//! Three things reach the UI thread without going through `tao`'s event
//! handler, so they arrive inside any modal loop a handler has opened:
//! deferred jobs, native timeouts, and wakes from other threads. They ride on
//! the signal window of `sweetview-platform-loop`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::{Mutex, PoisonError};

use sweetview_platform_loop::{LoopHost, Signal, SignalWindow, TimerId, Waker};
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};

use crate::error::{Error, Result};
use crate::threads;

/// Names a timeout or an interval set on the [`Runtime`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimeoutId(pub u32);

/// The wake token of the deferred-job queue. Every other token names a drain function.
const DEFERRED_TOKEN: u64 = 0;

/// The waker of the process's runtime, for [`wake`] on any thread.
static WAKER: Mutex<Option<Waker>> = Mutex::new(None);

thread_local! {
  static RUNTIME: RefCell<Option<Rc<Runtime>>> = const { RefCell::new(None) };
}

/// Runs the drain function registered under `token` on the UI thread.
/// Callable from any thread. Returns false when there is no runtime to wake.
pub fn wake(token: u64) -> bool {
  let waker = WAKER.lock().unwrap_or_else(PoisonError::into_inner).clone();
  waker.is_some_and(|waker| waker.wake(token))
}

enum TimerJob {
  Once(Box<dyn FnOnce()>),
  Repeat(Rc<dyn Fn()>),
}

struct Timer {
  native: TimerId,
  job: TimerJob,
}

/// A listener for the loop's own events, called from inside `tao`'s handler.
pub type EventListener = Rc<dyn Fn(&Event<'_, ()>, &EventLoopWindowTarget<()>)>;

pub struct Runtime {
  host: LoopHost<()>,
  signals: SignalWindow,
  proxy: EventLoopProxy<()>,
  /// Set by `request_exit`; ends the blocking run in progress.
  exit_requested: Cell<bool>,
  /// True while `run_blocking` is on the stack.
  blocking: Cell<bool>,
  deferred: RefCell<VecDeque<Box<dyn FnOnce()>>>,
  timers: RefCell<HashMap<u32, Timer>>,
  next_timer: Cell<u32>,
  drains: RefCell<HashMap<u64, Rc<dyn Fn()>>>,
  listeners: RefCell<Vec<(u64, EventListener)>>,
  next_listener: Cell<u64>,
}

impl Runtime {
  /// The process's runtime, made on first use. Only the UI thread may ask.
  pub fn get() -> Result<Rc<Runtime>> {
    threads::require_ui_thread()?;
    if let Some(runtime) = RUNTIME.with(|slot| slot.borrow().clone()) {
      return Ok(runtime);
    }
    let runtime = Rc::new(Self::new()?);
    RUNTIME.with(|slot| *slot.borrow_mut() = Some(runtime.clone()));
    Ok(runtime)
  }

  /// The runtime if this thread has made one. Never makes one.
  pub fn existing() -> Option<Rc<Runtime>> {
    // `try_with`: a signal can arrive while the thread's storage is being torn down.
    RUNTIME.try_with(|slot| slot.borrow().clone()).ok().flatten()
  }

  fn new() -> Result<Self> {
    let event_loop = build_event_loop();
    let proxy = event_loop.create_proxy();
    let signals = SignalWindow::new(|signal| {
      if let Some(runtime) = Runtime::existing() {
        runtime.on_signal(signal);
      }
    })
    .map_err(|e| Error::os("the signal window could not be made", e))?;
    *WAKER.lock().unwrap_or_else(PoisonError::into_inner) = Some(signals.waker());
    Ok(Self {
      host: LoopHost::new(event_loop),
      signals,
      proxy,
      exit_requested: Cell::new(false),
      blocking: Cell::new(false),
      deferred: RefCell::new(VecDeque::new()),
      timers: RefCell::new(HashMap::new()),
      next_timer: Cell::new(1),
      drains: RefCell::new(HashMap::new()),
      listeners: RefCell::new(Vec::new()),
      next_listener: Cell::new(1),
    })
  }

  /// Drops this thread's runtime. Tests only: a process keeps its runtime for life.
  #[doc(hidden)]
  pub fn shutdown_for_tests() {
    *WAKER.lock().unwrap_or_else(PoisonError::into_inner) = None;
    RUNTIME.with(|slot| slot.borrow_mut().take());
  }

  // ---- the loop ---------------------------------------------------------------

  /// True while either mode of the loop is on the stack.
  pub fn is_running(&self) -> bool {
    self.host.is_running()
  }

  /// True while [`Runtime::run_blocking`] is on the stack.
  pub fn is_blocking(&self) -> bool {
    self.blocking.get()
  }

  /// Stays inside the loop until [`Runtime::request_exit`] is called.
  pub fn run_blocking(&self) -> Result<()> {
    if self.host.is_running() {
      return Err(Error::state("sweetview: the event loop is already running on this thread"));
    }
    self.exit_requested.set(false);
    self.blocking.set(true);
    let ran = self.host.run(|event, target, control_flow| {
      *control_flow = ControlFlow::Wait;
      self.dispatch(&event, target);
      if self.exit_requested.get() {
        *control_flow = ControlFlow::Exit;
      }
    });
    self.blocking.set(false);
    ran.map_err(|e| Error::state(format!("sweetview: {e}")))
  }

  /// Ends the blocking run in progress. With none in progress it does nothing.
  pub fn request_exit(&self) {
    if !self.blocking.get() {
      return;
    }
    self.exit_requested.set(true);
    // `tao` calls its handler only for its own messages; this is one.
    let _ = self.proxy.send_event(());
  }

  /// Dispatches what is waiting and returns. Called while the loop is already
  /// running (from a callback) it does nothing.
  pub fn pump(&self) {
    let _ = self.host.run(|event, target, control_flow| {
      *control_flow = ControlFlow::Poll;
      self.dispatch(&event, target);
      if matches!(event, Event::MainEventsCleared) {
        *control_flow = ControlFlow::Exit;
      }
    });
    // A pumped loop always has its own repaint request queued, which the OS
    // serves before any timer; the timers are taken explicitly.
    self.signals.dispatch_due_timers();
  }

  /// Lends the loop's window target, for building windows.
  pub fn with_target<R>(&self, f: impl FnOnce(&EventLoopWindowTarget<()>) -> R) -> Result<R> {
    self.host.with_target(f).ok_or_else(|| Error::state("sweetview: the event loop is starting; no window can be made yet"))
  }

  /// Adds a listener for the loop's events. Returns the token that removes it.
  pub fn add_event_listener(&self, listener: EventListener) -> u64 {
    let token = self.next_listener.get();
    self.next_listener.set(token + 1);
    self.listeners.borrow_mut().push((token, listener));
    token
  }

  pub fn remove_event_listener(&self, token: u64) {
    self.listeners.borrow_mut().retain(|(t, _)| *t != token);
  }

  fn dispatch(&self, event: &Event<'_, ()>, target: &EventLoopWindowTarget<()>) {
    // Cloned out first: a listener may add or remove listeners.
    let listeners: Vec<EventListener> = self.listeners.borrow().iter().map(|(_, l)| l.clone()).collect();
    for listener in listeners {
      listener(event, target);
    }
  }

  // ---- deferred jobs ------------------------------------------------------------

  /// Runs `job` on a later turn of whichever message loop the UI thread is in.
  pub fn defer(&self, job: impl FnOnce() + 'static) {
    self.deferred.borrow_mut().push_back(Box::new(job));
    self.signals.waker().wake(DEFERRED_TOKEN);
  }

  fn run_deferred(&self) {
    // One at a time, with nothing borrowed: a job may defer more, and a job
    // that opens a modal loop lets the jobs behind it run inside that loop.
    loop {
      let job = self.deferred.borrow_mut().pop_front();
      match job {
        Some(job) => job(),
        None => break,
      }
    }
  }

  // ---- timeouts -----------------------------------------------------------------

  /// Runs `job` once, `delay_ms` milliseconds from now.
  pub fn set_timeout(&self, delay_ms: u32, job: impl FnOnce() + 'static) -> Result<TimeoutId> {
    self.add_timer(delay_ms, TimerJob::Once(Box::new(job)))
  }

  /// Runs `job` every `interval_ms` milliseconds until it is cleared.
  pub fn set_interval(&self, interval_ms: u32, job: impl Fn() + 'static) -> Result<TimeoutId> {
    self.add_timer(interval_ms, TimerJob::Repeat(Rc::new(job)))
  }

  fn add_timer(&self, ms: u32, job: TimerJob) -> Result<TimeoutId> {
    let native = self.signals.set_timer(ms).map_err(|e| Error::os("a timer could not be set", e))?;
    let id = self.next_timer.get();
    self.next_timer.set(id.wrapping_add(1).max(1));
    self.timers.borrow_mut().insert(id, Timer { native, job });
    Ok(TimeoutId(id))
  }

  /// Clears a timeout or an interval. Clearing one that is gone does nothing.
  pub fn clear_timeout(&self, id: TimeoutId) {
    let timer = self.timers.borrow_mut().remove(&id.0);
    if let Some(timer) = timer {
      self.signals.cancel_timer(timer.native);
    }
  }

  fn on_timer(&self, native: TimerId) {
    let id = self.timers.borrow().iter().find(|(_, timer)| timer.native == native).map(|(id, _)| *id);
    let Some(id) = id else { return };
    // A repeating job is cloned out and a one-shot is removed before it runs,
    // so either may clear itself or set new timers from inside its own call.
    let repeat = match self.timers.borrow().get(&id) {
      Some(Timer { job: TimerJob::Repeat(job), .. }) => Some(job.clone()),
      _ => None,
    };
    if let Some(job) = repeat {
      job();
      return;
    }
    let timer = self.timers.borrow_mut().remove(&id);
    if let Some(Timer { native, job: TimerJob::Once(job) }) = timer {
      self.signals.cancel_timer(native);
      job();
    }
  }

  // ---- wakes from other threads ---------------------------------------------------

  /// Registers the function [`wake`]`(token)` runs on the UI thread. `None` removes it.
  pub fn set_drain(&self, token: u64, drain: Option<Rc<dyn Fn()>>) {
    debug_assert_ne!(token, DEFERRED_TOKEN);
    match drain {
      Some(drain) => self.drains.borrow_mut().insert(token, drain),
      None => self.drains.borrow_mut().remove(&token),
    };
  }

  fn on_signal(&self, signal: Signal) {
    match signal {
      Signal::Wake(DEFERRED_TOKEN) => self.run_deferred(),
      Signal::Wake(token) => {
        let drain = self.drains.borrow().get(&token).cloned();
        if let Some(drain) = drain {
          drain();
        }
      }
      Signal::Timer(native) => self.on_timer(native),
    }
  }
}

#[cfg(windows)]
fn build_event_loop() -> EventLoop<()> {
  use tao::platform::windows::EventLoopBuilderExtWindows;
  // The UI thread is the thread that loaded the binding, which `threads`
  // checks; `tao`'s own idea of the main thread is not the one that matters
  // inside a host process.
  EventLoopBuilder::new().with_any_thread(true).build()
}

#[cfg(not(windows))]
fn build_event_loop() -> EventLoop<()> {
  EventLoopBuilder::new().build()
}

#[cfg(all(test, windows))]
pub(crate) mod tests {
  use super::*;
  use std::time::{Duration, Instant};

  /// Runs `body` as the UI thread with a fresh runtime, one test at a time.
  pub(crate) fn on_ui_thread(body: impl FnOnce(Rc<Runtime>)) {
    static SERIAL: Mutex<()> = Mutex::new(());
    let _serial = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
    struct Release;
    impl Drop for Release {
      fn drop(&mut self) {
        Runtime::shutdown_for_tests();
        threads::release_ui_thread_for_tests();
      }
    }
    assert!(threads::claim_ui_thread());
    let _release = Release;
    body(Runtime::get().expect("runtime"));
  }

  #[test]
  fn another_thread_is_refused_and_can_still_wake() {
    on_ui_thread(|runtime| {
      let woke = Rc::new(Cell::new(0u32));
      let seen = woke.clone();
      runtime.set_drain(42, Some(Rc::new(move || seen.set(seen.get() + 1))));
      let refused = std::thread::spawn(|| (Runtime::get().err(), wake(42))).join().expect("thread");
      assert_eq!(refused, (Some(Error::NotUiThread), true));
      let deadline = Instant::now() + Duration::from_secs(5);
      while woke.get() == 0 && Instant::now() < deadline {
        runtime.pump();
      }
      assert_eq!(woke.get(), 1);
    });
  }

  #[test]
  fn the_blocking_run_serves_jobs_timeouts_and_wakes_and_ends_on_request() {
    on_ui_thread(|runtime| {
      let log: Rc<RefCell<Vec<&'static str>>> = Rc::new(RefCell::new(Vec::new()));
      let (a, b, c, d) = (log.clone(), log.clone(), log.clone(), log.clone());
      runtime.defer(move || a.borrow_mut().push("deferred"));
      runtime.set_drain(7, Some(Rc::new(move || b.borrow_mut().push("drain"))));
      let ticks = Rc::new(Cell::new(0u32));
      let counted = ticks.clone();
      let interval = runtime.set_interval(2, move || counted.set(counted.get() + 1)).expect("interval");
      let inner = runtime.clone();
      runtime
        .set_timeout(30, move || {
          c.borrow_mut().push("timeout");
          assert!(inner.is_blocking());
          // A pump from inside the run is refused quietly.
          inner.pump();
          std::thread::spawn(|| wake(7)).join().expect("thread");
          let quitter = inner.clone();
          inner.defer(move || {
            d.borrow_mut().push("quit");
            quitter.request_exit();
          });
        })
        .expect("timeout");
      runtime.run_blocking().expect("blocking run");
      runtime.clear_timeout(interval);
      assert!(!runtime.is_running());
      let log = log.borrow();
      assert_eq!(log[0], "deferred");
      assert_eq!(log[1], "timeout");
      assert!(log.contains(&"drain") && log.contains(&"quit"), "{log:?}");
      assert!(ticks.get() >= 2, "the interval repeated: {}", ticks.get());
    });
  }

  #[test]
  fn a_job_may_clear_itself_and_a_cleared_timeout_never_runs() {
    on_ui_thread(|runtime| {
      let fired = Rc::new(Cell::new(0u32));
      let slot: Rc<Cell<Option<TimeoutId>>> = Rc::new(Cell::new(None));
      let (count, own, inner) = (fired.clone(), slot.clone(), runtime.clone());
      let interval = runtime
        .set_interval(1, move || {
          count.set(count.get() + 1);
          if let Some(id) = own.get() {
            inner.clear_timeout(id);
          }
        })
        .expect("interval");
      slot.set(Some(interval));
      let never = runtime.set_timeout(1, || panic!("a cleared timeout ran")).expect("timeout");
      runtime.clear_timeout(never);
      let deadline = Instant::now() + Duration::from_millis(200);
      while Instant::now() < deadline {
        runtime.pump();
      }
      assert_eq!(fired.get(), 1, "the interval cleared itself on its first run");
    });
  }
}
