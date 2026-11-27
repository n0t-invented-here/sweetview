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

use sweetview_platform_loop::{ComApartment, LoopHost, Signal, SignalWindow, TimerId, Waker};
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};

use crate::error::{Error, Result};
use crate::threads;

/// Names a timeout or an interval set on the [`Runtime`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimeoutId(pub u32);

/// The wake token of the deferred-job queue. Every other token names a drain function.
const DEFERRED_TOKEN: u64 = 0;

/// The exit code a pump ends its run with, told apart from the 0 of a `WM_QUIT`.
const PUMP_DONE: i32 = 0x5357;

/// The most rounds of `tao`'s loop one pump takes before it returns.
const PUMP_ROUNDS: u32 = 256;

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
  /// A quit asked for while no blocking run was in progress. The next pump
  /// reports it and the next blocking run ends at once, as a quit message
  /// waiting in the thread's queue did.
  quit_pending: Cell<bool>,
  deferred: RefCell<VecDeque<Box<dyn FnOnce()>>>,
  timers: RefCell<HashMap<u32, Timer>>,
  next_timer: Cell<u32>,
  drains: RefCell<HashMap<u64, Rc<dyn Fn()>>>,
  listeners: RefCell<Vec<(u64, EventListener)>>,
  next_listener: Cell<u64>,
  /// Declared last so it is dropped last: the apartment is left after the loop and its windows.
  _com: Option<ComApartment>,
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
    // The single-threaded apartment WebView2 needs, entered before any window
    // exists. A thread already in the multi-threaded one still gets a loop;
    // what needs the STA reports that when it is made.
    let com = match ComApartment::enter() {
      Ok(com) => Some(com),
      Err(error) => {
        eprintln!("{error}");
        None
      }
    };
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
      quit_pending: Cell::new(false),
      deferred: RefCell::new(VecDeque::new()),
      timers: RefCell::new(HashMap::new()),
      next_timer: Cell::new(1),
      drains: RefCell::new(HashMap::new()),
      listeners: RefCell::new(Vec::new()),
      next_listener: Cell::new(1),
      _com: com,
    })
  }

  /// Drops this thread's runtime. Tests only: a process keeps its runtime for life.
  #[doc(hidden)]
  pub fn shutdown_for_tests() {
    crate::window::destroy_all_for_tests();
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

  /// Stays inside the loop until [`Runtime::request_exit`] is called, or the
  /// thread's quit request (`PostQuitMessage`) ends it.
  pub fn run_blocking(&self) -> Result<()> {
    if self.host.is_running() {
      return Err(Error::state("sweetview: the event loop is already running on this thread"));
    }
    if self.quit_pending.replace(false) {
      return Ok(());
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
    ran.map(|_code| ()).map_err(|e| Error::state(format!("sweetview: {e}")))
  }

  /// Ends the blocking run in progress. With none in progress the quit waits:
  /// the next [`Runtime::pump`] reports it, and the next blocking run ends at once.
  pub fn request_exit(&self) {
    if !self.blocking.get() {
      self.quit_pending.set(true);
      return;
    }
    self.exit_requested.set(true);
    // `tao` calls its handler only for its own messages; this is one.
    let _ = self.proxy.send_event(());
  }

  /// Dispatches what is waiting and returns. Called while the loop is already
  /// running (from a callback) it does nothing.
  ///
  /// Returns false when a quit ended the pump: one asked for with
  /// [`Runtime::request_exit`] while no blocking run was in progress, or the
  /// thread's own quit request (`PostQuitMessage`). Either is consumed, and the
  /// caller should stop pumping, as `pumpEvents` has always reported. True otherwise.
  pub fn pump(&self) -> bool {
    // `tao` clears its events after each message it takes in this mode, so a
    // pump goes round until nothing posted is waiting, as `pumpEvents` always
    // dispatched everything that was. Bounded, so a timer that is always due
    // cannot hold the caller here.
    let rounds = Cell::new(0u32);
    let ran = self.host.run(|event, target, control_flow| {
      *control_flow = ControlFlow::Poll;
      self.dispatch(&event, target);
      if matches!(event, Event::MainEventsCleared) {
        rounds.set(rounds.get() + 1);
        if rounds.get() >= PUMP_ROUNDS || !sweetview_platform_loop::messages_waiting() {
          *control_flow = ControlFlow::ExitWithCode(PUMP_DONE);
        }
      }
    });
    let Ok(code) = ran else { return true };
    // A pumped loop always has its own repaint request queued, which the OS
    // serves before any timer; the timers are taken explicitly.
    self.signals.dispatch_due_timers();
    // The run also ends when the OS hands `tao` a `WM_QUIT`, with code 0.
    let quit_message = code != PUMP_DONE;
    let quit_pending = self.quit_pending.replace(false);
    !(quit_message || quit_pending)
  }

  /// Takes back a quit that is waiting, so it ends nothing: one asked for with
  /// [`Runtime::request_exit`] outside a blocking run, and a quit request of
  /// this thread (`PostQuitMessage`), for which it dispatches what is waiting
  /// until the request comes out and drops it. Returns at once when none was
  /// made and nothing waits. Callable from inside either loop mode. Returns
  /// true when a quit was taken back.
  pub fn discard_quit(&self) -> bool {
    let pending = self.quit_pending.replace(false);
    sweetview_platform_loop::discard_quit() || pending
  }

  /// Lends the loop's window target, for building windows.
  pub fn with_target<R>(&self, f: impl FnOnce(&EventLoopWindowTarget<()>) -> R) -> Result<R> {
    Ok(self.host.with_target(f))
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

/// What the crate's tests share.
#[cfg(all(test, windows))]
pub(crate) mod testing {
  use super::*;

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
}

#[cfg(all(test, windows))]
mod tests {
  use super::testing::on_ui_thread;
  use super::*;
  use std::time::{Duration, Instant};

  #[test]
  fn one_pump_dispatches_everything_that_was_waiting() {
    on_ui_thread(|runtime| {
      let drained = Rc::new(Cell::new(0u32));
      let count = drained.clone();
      runtime.set_drain(9, Some(Rc::new(move || count.set(count.get() + 1))));
      for _ in 0..5 {
        assert!(wake(9));
      }
      assert!(runtime.pump());
      assert_eq!(drained.get(), 5);
    });
  }

  #[test]
  fn a_quit_request_ends_a_pump_and_can_be_taken_back() {
    on_ui_thread(|runtime| {
      assert!(runtime.pump(), "nothing queued");
      post_quit();
      assert!(!runtime.pump(), "the quit request ended the pump");
      assert!(runtime.pump(), "and is gone after it");
      post_quit();
      assert!(runtime.discard_quit());
      assert!(runtime.pump());
      // From inside the blocking run: taken back, the run goes on until asked to end.
      let inner = runtime.clone();
      let taken = Rc::new(Cell::new(false));
      let seen = taken.clone();
      runtime
        .set_timeout(5, move || {
          post_quit();
          seen.set(inner.discard_quit());
          let quitter = inner.clone();
          inner.set_timeout(20, move || quitter.request_exit()).expect("timeout");
        })
        .expect("timeout");
      runtime.run_blocking().expect("blocking run");
      assert!(taken.get());
    });
  }

  /// Asks this thread's loop to end, the way the C++ webview library does when a webview is destroyed.
  fn post_quit() {
    sweetview_platform_loop::post_quit_for_tests();
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
      // Long enough for a 2 ms interval to tick twice at the OS's default 15.6 ms timer resolution.
      runtime
        .set_timeout(100, move || {
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
      // A quit asked for outside a blocking run waits for the next pump, once.
      runtime.request_exit();
      assert!(!runtime.pump());
      assert!(runtime.pump());
      // Taken back, it ends nothing.
      runtime.request_exit();
      runtime.discard_quit();
      assert!(runtime.pump());
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
