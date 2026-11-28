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
/// How often, while a pump is still running, the guard gives `tao` another message.
const PUMP_GUARD_MS: u32 = 15;

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
  /// The native timer that keeps a pump from waiting for good; set only while one runs.
  pump_guard: Cell<Option<TimerId>>,
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
      pump_guard: Cell::new(None),
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
    // The webviews go while the thread is still in its apartment.
    crate::engine::release_all();
    crate::window::destroy_all();
    *WAKER.lock().unwrap_or_else(PoisonError::into_inner) = None;
    // Before the runtime, whose apartment the environment belongs to.
    #[cfg(feature = "webview")]
    crate::engine::release_environment_for_tests();
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
    // From a callback of either loop mode: nothing is posted and no guard is set, so a nested
    // call costs nothing and leaves the guard of the pump in progress as it is.
    if self.host.is_running() {
      return true;
    }
    // `tao` clears its events after each message it takes in this mode, so a
    // pump goes round until nothing posted is waiting, as `pumpEvents` always
    // dispatched everything that was. Bounded, so a timer that is always due
    // cannot hold the caller here.
    let rounds = Cell::new(0u32);
    // A pump must never wait. `tao` starts a run by waiting for a message, and in this mode it
    // keeps one coming for itself: a repaint request on its own hidden window, renewed after each
    // message it handles. That request can be lost: any `PeekMessageW` that looks without
    // removing takes a window with no update region out of the repaint queue (`tao` works around
    // its own such calls), and the message waits inside COM calls into WebView2 look that way.
    // Seen with a tabbed window just shown and in front: the pump waited for good, and Bun's
    // loop with it. So each pump posts `tao` a message of its own first, and a native timer
    // posts another while the pump is still running; each makes `tao` renew its request.
    let _ = self.proxy.send_event(());
    let guard = PumpGuard::set(self);
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
    drop(guard);
    let Ok(code) = ran else { return true };
    // Timer ticks are posted messages (D38): `messages_waiting` sees them and `tao`'s loop
    // dispatches them, so nothing is left to take here. The run also ends when the OS hands `tao` a `WM_QUIT`, with code 0.
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

  /// Tests only: how many listeners the loop has.
  #[cfg(all(test, feature = "webview"))]
  pub(crate) fn listener_count(&self) -> usize {
    self.listeners.borrow().len()
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

  // ---- the end of the application -------------------------------------------------

  /// Lets go of every function the runtime would call: the jobs still deferred, the
  /// timeouts and intervals (their native timers are cancelled), the drains and the loop's
  /// listeners. What [`crate::lifetime::release_all`] does last, once everything that
  /// registered them is gone. The runtime itself stays, so the application may go on.
  pub(crate) fn release_callbacks(&self) {
    // Each is taken out first and dropped after its borrow: a job's or a
    // listener's drop may release the last reference to something that calls back in.
    let deferred = std::mem::take(&mut *self.deferred.borrow_mut());
    let timers = std::mem::take(&mut *self.timers.borrow_mut());
    for timer in timers.values() {
      self.signals.cancel_timer(timer.native);
    }
    let drains = std::mem::take(&mut *self.drains.borrow_mut());
    let listeners = std::mem::take(&mut *self.listeners.borrow_mut());
    drop((deferred, timers, drains, listeners));
    // The thread that posts the timers' ticks (D38) ends with them; a pump in progress keeps
    // it for its guard, and a timer set afterwards starts it again.
    self.signals.stop_ticker_if_idle();
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
      Signal::Timer(native) if self.pump_guard.get() == Some(native) => {
        // The pump in progress is still inside `tao`'s wait: give it another message.
        let _ = self.proxy.send_event(());
      }
      Signal::Timer(native) => self.on_timer(native),
    }
  }
}

/// The native timer of the one pump in progress (D30), set when the pump starts. Dropping it
/// cancels the timer and empties the runtime's cell, on every way out of the pump: a return, and
/// the unwind `tao` raises again when a handler panicked.
struct PumpGuard<'a> {
  runtime: &'a Runtime,
}

impl<'a> PumpGuard<'a> {
  fn set(runtime: &'a Runtime) -> Self {
    // `pump` makes a guard only when no loop is running, so no other guard is set.
    debug_assert!(runtime.pump_guard.get().is_none());
    runtime.pump_guard.set(runtime.signals.set_timer(PUMP_GUARD_MS).ok());
    Self { runtime }
  }
}

impl Drop for PumpGuard<'_> {
  fn drop(&mut self) {
    if let Some(guard) = self.runtime.pump_guard.take() {
      self.runtime.signals.cancel_timer(guard);
    }
  }
}

#[cfg(windows)]
fn build_event_loop() -> EventLoop<()> {
  use tao::platform::windows::EventLoopBuilderExtWindows;
  // The UI thread is the thread that loaded the binding, which `threads`
  // checks; `tao`'s own idea of the main thread is not the one that matters
  // inside a host process.
  let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
  // `tao` registers the process for raw keyboard and mouse input, once, with the loop's own
  // hidden window as the target (raw-input registration is per process), for its device
  // events. Sweetview reports no device events, and the registration has a cost: while a
  // process that takes raw keyboard input holds the foreground, Windows does not call that
  // process's own low-level keyboard hook, so `installKeyboardHook` would see nothing typed
  // while one of the application's own windows is in front. With this filter `tao` registers
  // nothing.
  event_loop.set_device_event_filter(tao::event_loop::DeviceEventFilter::Always);
  event_loop
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
    // Every test leaves its thread's apartment when it ends; COM stays loaded for the next.
    sweetview_platform_window::test_support::keep_com_loaded_for_the_test_process();
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

  /// `tao` keeps its poll mode going with a repaint request on a hidden window of its own, and a
  /// look at the queue that removes nothing (the message wait inside a COM call does one) makes
  /// the OS drop that request. A pump must return all the same: without the wake and the guard
  /// timer in `pump`, it waits for a message that never comes.
  #[test]
  fn a_pump_returns_though_a_handler_looked_at_the_queue_without_removing_anything() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    on_ui_thread(|runtime| {
      let (finished, wait) = mpsc::channel::<()>();
      let rescued = Arc::new(AtomicBool::new(false));
      let flag = rescued.clone();
      // A pump that waits cannot fail by itself: this thread gives it messages until it returns,
      // so the test fails with a sentence instead of hanging.
      let watchdog = std::thread::spawn(move || {
        if wait.recv_timeout(Duration::from_secs(20)).is_ok() {
          return;
        }
        flag.store(true, Ordering::SeqCst);
        let limit = Instant::now() + Duration::from_secs(30);
        while wait.recv_timeout(Duration::from_millis(50)).is_err() {
          wake(78);
          if Instant::now() > limit {
            eprintln!("a pump is still waiting for a message after every rescue");
            std::process::abort();
          }
        }
      });
      let looks = Rc::new(Cell::new(0u32));
      let count = looks.clone();
      runtime.set_drain(
        77,
        Some(Rc::new(move || {
          sweetview_platform_loop::peek_without_removing_for_tests();
          count.set(count.get() + 1);
        })),
      );
      for _ in 0..300 {
        assert!(wake(77));
        assert!(runtime.pump());
        sweetview_platform_loop::peek_without_removing_for_tests();
        assert!(runtime.pump());
      }
      finished.send(()).expect("the watchdog is waiting");
      watchdog.join().expect("watchdog");
      runtime.set_drain(77, None);
      assert_eq!(looks.get(), 300);
      assert!(!rescued.load(Ordering::SeqCst), "a pump waited for a message instead of returning");
    });
  }

  /// A pump called from inside a pump does nothing, as `pump` and `pumpEvents` say: it sets no
  /// second guard and leaves the outer pump's guard set, which still gives `tao` its event. A pump
  /// that a handler's panic unwinds out of leaves no timer set (the review's G2).
  #[test]
  fn a_nested_pump_does_nothing_and_every_way_out_of_a_pump_cancels_its_guard() {
    on_ui_thread(|runtime| {
      let user_events = Rc::new(Cell::new(0u32));
      let counted = user_events.clone();
      let listener = runtime.add_event_listener(Rc::new(move |event, _| {
        if matches!(event, Event::UserEvent(())) {
          counted.set(counted.get() + 1);
        }
      }));
      type Seen = (Option<TimerId>, Option<TimerId>, usize);
      let seen: Rc<Cell<Option<Seen>>> = Rc::default();
      let (inner, record) = (runtime.clone(), seen.clone());
      runtime.set_drain(
        31,
        Some(Rc::new(move || {
          let guard = inner.pump_guard.get();
          for _ in 0..100 {
            assert!(inner.pump(), "a nested pump reports nothing ended");
          }
          record.set(Some((guard, inner.pump_guard.get(), inner.signals.timers_set_for_tests())));
          // Long enough for the outer pump's guard to come due while that pump still runs.
          std::thread::sleep(Duration::from_millis(u64::from(PUMP_GUARD_MS) * 4));
        })),
      );
      let before = user_events.get();
      assert!(wake(31));
      assert!(runtime.pump());
      runtime.set_drain(31, None);
      let (guard, after_nested, set_inside) = seen.get().expect("the drain ran inside the pump");
      assert!(guard.is_some(), "the outer pump had its guard");
      assert_eq!(after_nested, guard, "the nested pumps left the outer pump's guard as it was");
      assert_eq!(set_inside, 1, "the nested pumps set no timer of their own");
      assert!(user_events.get() - before >= 2, "the pump's own event and the guard's: {}", user_events.get() - before);
      assert_eq!(runtime.pump_guard.get(), None);
      assert_eq!(runtime.signals.timers_set_for_tests(), 0, "no timer is left set after the pump");

      let panicking = runtime.add_event_listener(Rc::new(|event, _| {
        if matches!(event, Event::UserEvent(())) {
          panic!("a handler panics inside a pump (expected by this test)");
        }
      }));
      let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime.pump()));
      runtime.remove_event_listener(panicking);
      assert!(unwound.is_err(), "tao raised the handler's panic again out of the pump");
      assert_eq!(runtime.pump_guard.get(), None);
      assert_eq!(runtime.signals.timers_set_for_tests(), 0, "the guard went with the unwind");
      assert!(runtime.pump(), "and the loop pumps again");
      runtime.remove_event_listener(listener);
    });
  }

  /// One round of the test below: an interval set a moment before a popup menu opens from a
  /// deferred job, which closes the menu from inside it after three ticks.
  struct MenuRound {
    ticks: Rc<Cell<u32>>,
    closed: Rc<Cell<bool>>,
    interval: TimeoutId,
    /// When the menu was about to open, and when the interval first ticked inside it.
    opened: Rc<Cell<Option<Instant>>>,
    first_tick: Rc<Cell<Option<Instant>>>,
  }

  /// The longest a menu's first tick may take: the interval's period is 10 ms. A menu whose loop
  /// waits with the timers due delivers its first tick only when something else wakes the thread.
  const FIRST_TICK_LIMIT: Duration = Duration::from_millis(250);

  fn open_menu_round(
    runtime: &Rc<Runtime>,
    menu: &Rc<crate::menu::BuiltMenu>,
    owner: &Rc<tao::window::Window>,
    opened_at: &std::sync::Arc<std::sync::atomic::AtomicI64>,
    start: Instant,
  ) -> MenuRound {
    use std::sync::atomic::Ordering;
    use sweetview_platform_window::{end_menu_for_tests, BorrowedWindow, PopupAt, PopupCorner};
    let ticks = Rc::new(Cell::new(0u32));
    let closed = Rc::new(Cell::new(false));
    let opened: Rc<Cell<Option<Instant>>> = Rc::default();
    let first_tick: Rc<Cell<Option<Instant>>> = Rc::default();
    let (counted, menu_open, first) = (ticks.clone(), opened.clone(), first_tick.clone());
    let interval = runtime
      .set_interval(10, move || {
        if menu_open.get().is_none() {
          return;
        }
        if first.get().is_none() {
          first.set(Some(Instant::now()));
        }
        counted.set(counted.get() + 1);
        if counted.get() == 3 {
          end_menu_for_tests();
        }
      })
      .expect("interval");
    let (menu, owner, opened_at, done, opening) = (menu.clone(), owner.clone(), opened_at.clone(), closed.clone(), opened.clone());
    runtime.defer(move || {
      // Longer than the interval's period and the pump guard's: every timer of the thread is due
      // when the menu's loop first looks at the queue.
      std::thread::sleep(Duration::from_millis(40));
      let at = crate::screen::cursor().map_or(PopupAt { x: 0, y: 0, corner: PopupCorner::BottomLeft }, |c| PopupAt {
        x: c.x,
        y: c.y,
        corner: PopupCorner::BottomLeft,
      });
      opened_at.store(start.elapsed().as_millis() as i64, Ordering::SeqCst);
      opening.set(Some(Instant::now()));
      let _chosen = crate::menu::show(&menu, &BorrowedWindow::of(&owner), at);
      opened_at.store(-1, Ordering::SeqCst);
      done.set(true);
    });
    MenuRound { ticks, closed, interval, opened, first_tick }
  }

  /// D38: native timers keep firing inside a popup menu's loop in both loop modes. The menu opens
  /// from a deferred job, its owner is a hidden `tao` window as the tray menu's is, and every
  /// timer is due when the menu's loop first looks at the queue. With timers on `WM_TIMER` the
  /// loop took `tao`'s paint request for idle and waited with them due, until something else
  /// woke the thread or the watchdog's Escape closed the menu; so each menu's first tick must
  /// come within `FIRST_TICK_LIMIT` of its opening.
  #[test]
  fn an_interval_ticks_inside_a_popup_menu_opened_from_a_deferred_job_in_both_loop_modes() {
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
    use std::sync::Arc;
    const ROUNDS: u32 = 8;
    on_ui_thread(|runtime| {
      let owner = runtime
        .with_target(|target| tao::window::WindowBuilder::new().with_visible(false).with_title("sweetview.timer-menu-test").build(target))
        .expect("target")
        .expect("the menu's owner");
      let owner = Rc::new(owner);
      let item = crate::menu::MenuItem::Item { id: 1, label: "One".into(), enabled: true, checked: false, icon: None };
      let menu = Rc::new(crate::menu::build(&[item]).expect("menu"));
      // A menu still open 1.5 s after it opened is closed with Escape and counted, so a menu whose
      // loop delivers no tick fails the test instead of holding it.
      let start = Instant::now();
      let opened_at = Arc::new(AtomicI64::new(-1));
      let rescues = Arc::new(AtomicUsize::new(0));
      let stop = Arc::new(AtomicBool::new(false));
      let watchdog = {
        let (opened_at, rescues, stop) = (opened_at.clone(), rescues.clone(), stop.clone());
        std::thread::spawn(move || {
          while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(20));
            let at = opened_at.load(Ordering::SeqCst);
            if at >= 0 && start.elapsed().as_millis() as i64 - at > 1500 && sweetview_platform_window::escape_menus_of_this_process_for_tests() > 0 {
              rescues.fetch_add(1, Ordering::SeqCst);
              opened_at.store(-1, Ordering::SeqCst);
            }
          }
        })
      };
      let mut stuck: Vec<String> = Vec::new();
      let mut judge = |mode: &str, round: u32, played: &MenuRound, rescued: bool| {
        let first = match (played.opened.get(), played.first_tick.get()) {
          (Some(opened), Some(first)) => Some(first.saturating_duration_since(opened)),
          _ => None,
        };
        if rescued || played.ticks.get() < 3 || !played.closed.get() || first.is_none_or(|delay| delay > FIRST_TICK_LIMIT) {
          stuck.push(format!("{mode} round {round}: {} ticks, first after {first:?}, rescued {rescued}", played.ticks.get()));
        }
      };

      // The loop pumped in short bursts, as `pumpEvents` from a Bun timer.
      for round in 0..ROUNDS {
        let before = rescues.load(Ordering::SeqCst);
        let played = open_menu_round(&runtime, &menu, &owner, &opened_at, start);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !played.closed.get() && Instant::now() < deadline {
          runtime.pump();
          std::thread::sleep(Duration::from_millis(5));
        }
        runtime.clear_timeout(played.interval);
        judge("pumped", round, &played, rescues.load(Ordering::SeqCst) > before);
      }

      // The blocking loop: each round opens from a deferred job and the next starts once it closed.
      let results: Rc<RefCell<Vec<(MenuRound, bool)>>> = Rc::default();
      fn next_round(
        runtime: Rc<Runtime>,
        menu: Rc<crate::menu::BuiltMenu>,
        owner: Rc<tao::window::Window>,
        opened_at: Arc<AtomicI64>,
        rescues: Arc<AtomicUsize>,
        results: Rc<RefCell<Vec<(MenuRound, bool)>>>,
        start: Instant,
      ) {
        if results.borrow().len() as u32 == ROUNDS {
          runtime.request_exit();
          return;
        }
        let before = rescues.load(Ordering::SeqCst);
        let played = open_menu_round(&runtime, &menu, &owner, &opened_at, start);
        let closed = played.closed.clone();
        results.borrow_mut().push((played, false));
        let poll = Rc::new(Cell::new(None::<TimeoutId>));
        let (inner, slot) = (runtime.clone(), poll.clone());
        let id = runtime
          .set_interval(20, move || {
            if !closed.get() {
              return;
            }
            if let Some(id) = slot.take() {
              inner.clear_timeout(id);
            }
            if let Some((played, rescued)) = results.borrow_mut().last_mut() {
              inner.clear_timeout(played.interval);
              *rescued = rescues.load(Ordering::SeqCst) > before;
            }
            let (runtime, menu, owner, opened_at, rescues, results) =
              (inner.clone(), menu.clone(), owner.clone(), opened_at.clone(), rescues.clone(), results.clone());
            inner.defer(move || next_round(runtime, menu, owner, opened_at, rescues, results, start));
          })
          .expect("poll");
        poll.set(Some(id));
      }
      {
        let (inner, menu, owner, opened_at, rescues, results) =
          (runtime.clone(), menu.clone(), owner.clone(), opened_at.clone(), rescues.clone(), results.clone());
        runtime.defer(move || next_round(inner, menu, owner, opened_at, rescues, results, start));
      }
      let quitter = runtime.clone();
      let limit = runtime.set_timeout(60_000, move || quitter.request_exit()).expect("limit");
      runtime.run_blocking().expect("blocking run");
      runtime.clear_timeout(limit);
      for (round, (played, rescued)) in results.borrow().iter().enumerate() {
        judge("blocking", round as u32, played, *rescued);
      }
      assert_eq!(results.borrow().len() as u32, ROUNDS, "every blocking round ran");

      stop.store(true, Ordering::SeqCst);
      watchdog.join().expect("watchdog");
      assert!(stuck.is_empty(), "menus whose interval did not tick three times, or not within FIRST_TICK_LIMIT of the opening: {stuck:#?}");
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

  /// The worst and the count of the waits `measure_paint_behind_a_busy_interval` saw.
  struct PaintWaits {
    worst: Duration,
    seen: usize,
    asked: usize,
    ticks: u32,
  }

  /// Runs a 10 ms interval whose job takes 15 ms for `run`, and every 40 ms asks `tao` for a paint
  /// of its own (a user event, after which `tao` renews the paint request of its visible, layered
  /// thread target, and sends `MainEventsCleared` once the OS serves it). Returns how long each ask
  /// waited for that `MainEventsCleared`. `pumped` pumps every 2 ms; otherwise the blocking run.
  fn measure_paint_behind_a_busy_interval(runtime: &Rc<Runtime>, pumped: bool, run: Duration) -> (PaintWaits, Duration) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let ticks = Rc::new(Cell::new(0u32));
    let counted = ticks.clone();
    // Ended after 120 ticks whatever happens, so a starved loop still ends and the test fails on its numbers.
    let interval_id: Rc<Cell<Option<TimeoutId>>> = Rc::default();
    let (own, inner) = (interval_id.clone(), runtime.clone());
    let interval = runtime
      .set_interval(10, move || {
        counted.set(counted.get() + 1);
        std::thread::sleep(Duration::from_millis(15));
        if counted.get() >= 120 {
          if let Some(id) = own.get() {
            inner.clear_timeout(id);
          }
        }
      })
      .expect("interval");
    interval_id.set(Some(interval));
    let asked_at: Rc<Cell<Option<Instant>>> = Rc::default();
    let waits: Rc<RefCell<Vec<Duration>>> = Rc::default();
    let asks = Rc::new(Cell::new(0usize));
    let (pending, seen) = (asked_at.clone(), waits.clone());
    let listener = runtime.add_event_listener(Rc::new(move |event, _| {
      if matches!(event, Event::MainEventsCleared) {
        if let Some(at) = pending.take() {
          seen.borrow_mut().push(at.elapsed());
        }
      }
    }));
    let (pending, proxy, count) = (asked_at.clone(), runtime.proxy.clone(), asks.clone());
    runtime.set_drain(
      61,
      Some(Rc::new(move || {
        if pending.get().is_none() {
          pending.set(Some(Instant::now()));
          count.set(count.get() + 1);
          let _ = proxy.send_event(());
        }
      })),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let asker = {
      let stop = stop.clone();
      std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
          std::thread::sleep(Duration::from_millis(40));
          wake(61);
        }
      })
    };
    let started = Instant::now();
    let mut worst_pump = Duration::ZERO;
    if pumped {
      while started.elapsed() < run {
        let pump = Instant::now();
        runtime.pump();
        worst_pump = worst_pump.max(pump.elapsed());
        std::thread::sleep(Duration::from_millis(2));
      }
    } else {
      let quitter = runtime.clone();
      runtime.set_timeout(run.as_millis() as u32, move || quitter.request_exit()).expect("timeout");
      runtime.run_blocking().expect("blocking run");
    }
    stop.store(true, Ordering::SeqCst);
    asker.join().expect("asker");
    runtime.clear_timeout(interval);
    runtime.set_drain(61, None);
    runtime.remove_event_listener(listener);
    let waits = waits.borrow();
    let unanswered = asked_at.get().map(|at| at.elapsed());
    let worst = waits.iter().copied().chain(unanswered).max().unwrap_or(Duration::ZERO);
    (PaintWaits { worst, seen: waits.len(), asked: asks.get(), ticks: ticks.get() }, worst_pump)
  }

  /// D38 (the third review's H1): a 10 ms interval whose job takes 15 ms does not hold back
  /// paint. With each tick posted again the moment it was taken, the next tick was always queued
  /// when the job returned, posted messages come ahead of paint, and `tao`'s paint (and with it
  /// `MainEventsCleared`, which ends a pump) never came out. Now a timer's next period starts
  /// when its job returns, so paint has its turn in between, in both loop modes.
  #[test]
  fn a_busy_interval_leaves_paint_its_turn_in_both_loop_modes() {
    const LIMIT: Duration = Duration::from_millis(100);
    on_ui_thread(|runtime| {
      let mut report = Vec::new();
      for pumped in [true, false] {
        let (paint, worst_pump) = measure_paint_behind_a_busy_interval(&runtime, pumped, Duration::from_millis(800));
        let mode = if pumped { "pumped" } else { "blocking" };
        eprintln!(
          "{mode}: {} ticks; {} of {} paint asks answered, the longest wait {:?}; the longest pump {worst_pump:?}",
          paint.ticks, paint.seen, paint.asked, paint.worst
        );
        report.push((mode, paint, worst_pump));
      }
      for (mode, paint, worst_pump) in &report {
        assert!(paint.ticks >= 10, "{mode}: the interval ran ({} ticks)", paint.ticks);
        assert!(paint.asked >= 5 && paint.seen + 1 >= paint.asked, "{mode}: {} of {} paint asks answered", paint.seen, paint.asked);
        assert!(paint.worst <= LIMIT, "{mode}: a paint waited {:?} behind the interval", paint.worst);
        assert!(*worst_pump <= LIMIT, "{mode}: a pump took {worst_pump:?}");
      }
    });
  }

  /// The release at the end of the application (D36) ends the thread that posts the timers'
  /// ticks (D38) with the timers, and a timer set afterwards starts it again and fires.
  #[test]
  fn the_release_at_the_end_ends_the_tick_thread_and_a_later_timer_starts_it_again() {
    on_ui_thread(|runtime| {
      let _interval = runtime.set_interval(10, || {}).expect("interval");
      assert!(runtime.signals.ticker_running_for_tests());
      runtime.release_callbacks();
      assert_eq!(runtime.signals.timers_set_for_tests(), 0);
      assert!(!runtime.signals.ticker_running_for_tests(), "the tick thread ended with the timers");
      let fired = Rc::new(Cell::new(false));
      let seen = fired.clone();
      runtime.set_timeout(10, move || seen.set(true)).expect("timeout");
      assert!(runtime.signals.ticker_running_for_tests());
      let deadline = Instant::now() + Duration::from_secs(5);
      while !fired.get() && Instant::now() < deadline {
        runtime.pump();
        std::thread::sleep(Duration::from_millis(5));
      }
      assert!(fired.get(), "a timeout set after the release fires");
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
