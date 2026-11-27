//! The signal window on Windows: a message-only window.
//!
//! A message posted to a window is dispatched by whichever message loop the
//! thread is in: `tao`'s, the OS's modal loop of a dialog, a popup menu or a
//! window being resized, or an application's own. That is what makes a wake
//! and a timer arrive while a handler holds a modal dialog open.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::marker::PhantomData;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::{Arc, Mutex, PoisonError};

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, KillTimer, PeekMessageW, PostMessageW,
  RegisterClassExW, SetTimer, HWND_MESSAGE, MSG, PM_REMOVE, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_TIMER,
  WNDCLASSEXW,
};

use crate::signal::{Signal, SignalError, TimerId};

/// The message a [`Waker`] posts. `wParam` carries the token.
const WM_SWEETVIEW_WAKE: u32 = WM_APP + 0x53;

type Handler = Rc<dyn Fn(Signal)>;

thread_local! {
  /// The handler of each live signal window of this thread, by window handle value.
  /// The window procedure finds its handler here, so no pointer rides in the window's data.
  static HANDLERS: RefCell<HashMap<isize, Handler>> = RefCell::new(HashMap::new());
}

/// The handle value a [`Waker`] posts to. Zero once the window is destroyed.
///
/// The lock is held across both the post and the destroy, so a wake from
/// another thread never posts to a handle that has been destroyed and reused.
struct WakeTarget(Mutex<isize>);

/// Wakes the UI thread from any thread. Cheap to clone.
#[derive(Clone)]
pub struct Waker(Arc<WakeTarget>);

impl Waker {
  /// Delivers `Signal::Wake(token)` on the UI thread. Returns false when the
  /// signal window is gone or the message could not be queued.
  pub fn wake(&self, token: u64) -> bool {
    let Ok(wparam) = usize::try_from(token) else { return false };
    let target = self.0 .0.lock().unwrap_or_else(PoisonError::into_inner);
    if *target == 0 {
      return false;
    }
    let hwnd = HWND(*target as *mut core::ffi::c_void);
    // SAFETY: `*target` is non-zero only while the `SignalWindow` that owns
    // this window is alive; its `Drop` zeroes it under this same lock before
    // destroying the window, and we hold the lock for the whole call.
    let posted = unsafe { PostMessageW(Some(hwnd), WM_SWEETVIEW_WAKE, WPARAM(wparam), LPARAM(0)) };
    posted.is_ok()
  }
}

/// A message-only window owned by the UI thread. Dropping it destroys the
/// window, cancels its timers and disarms every [`Waker`] made from it.
pub struct SignalWindow {
  hwnd: HWND,
  wake_target: Arc<WakeTarget>,
  next_timer: Cell<usize>,
  timers: RefCell<HashSet<usize>>,
  /// The window and its handler belong to the thread that made them.
  _not_send: PhantomData<*const ()>,
}

impl SignalWindow {
  /// Makes the window. `handler` runs on this thread for every signal, from
  /// inside whichever message loop dispatched it. A handler that panics is
  /// caught; the signal is dropped.
  pub fn new(handler: impl Fn(Signal) + 'static) -> Result<Self, SignalError> {
    // SAFETY: a null module name asks for the handle of the process's own executable; no pointer is passed.
    let module = unsafe { GetModuleHandleW(None) }.map_err(|e| SignalError(format!("GetModuleHandleW: {e}")))?;
    let class_name = w!("SweetviewSignalWindow");
    let class = WNDCLASSEXW {
      cbSize: size_of::<WNDCLASSEXW>() as u32,
      lpfnWndProc: Some(signal_proc),
      hInstance: module.into(),
      lpszClassName: class_name,
      ..Default::default()
    };
    // Registering twice fails with "class already exists", which is the state wanted;
    // any other failure shows up as CreateWindowExW failing below.
    // SAFETY: `class` is a fully initialised WNDCLASSEXW that outlives the call, and its class name is a static string.
    let _atom = unsafe { RegisterClassExW(&class) };
    // SAFETY: the class name and window name are static strings, no creation parameter is
    // passed, and HWND_MESSAGE makes a message-only window with no parent to keep alive.
    let created = unsafe {
      CreateWindowExW(
        WINDOW_EX_STYLE(0),
        class_name,
        w!("sweetview.signal"),
        WINDOW_STYLE(0),
        0,
        0,
        0,
        0,
        Some(HWND_MESSAGE),
        None,
        Some(module.into()),
        None,
      )
    };
    let hwnd = created.map_err(|e| SignalError(format!("CreateWindowExW: {e}")))?;
    HANDLERS.with(|handlers| handlers.borrow_mut().insert(hwnd.0 as isize, Rc::new(handler)));
    Ok(Self {
      hwnd,
      wake_target: Arc::new(WakeTarget(Mutex::new(hwnd.0 as isize))),
      next_timer: Cell::new(1),
      timers: RefCell::new(HashSet::new()),
      _not_send: PhantomData,
    })
  }

  /// A handle other threads use to wake this one.
  pub fn waker(&self) -> Waker {
    Waker(self.wake_target.clone())
  }

  /// Starts a timer that delivers `Signal::Timer` every `interval_ms`
  /// milliseconds until it is cancelled.
  pub fn set_timer(&self, interval_ms: u32) -> Result<TimerId, SignalError> {
    let id = self.next_timer.get();
    self.next_timer.set(id.wrapping_add(1).max(1));
    // SAFETY: `self.hwnd` is owned by this `SignalWindow` and destroyed only in its `Drop`;
    // no timer procedure is passed, so the timer arrives as a WM_TIMER message.
    let set = unsafe { SetTimer(Some(self.hwnd), id, interval_ms, None) };
    if set == 0 {
      return Err(SignalError(format!("SetTimer: {}", windows::core::Error::from_thread())));
    }
    self.timers.borrow_mut().insert(id);
    Ok(TimerId(id))
  }

  /// Cancels a timer. Cancelling one that is not set does nothing.
  pub fn cancel_timer(&self, timer: TimerId) {
    if self.timers.borrow_mut().remove(&timer.0) {
      self.kill(timer.0);
    }
  }

  /// Delivers the timers that are due now, without waiting for the thread's
  /// queue to empty.
  ///
  /// The OS hands out a timer message only when nothing else is queued, and a
  /// loop that is pumped in short bursts always has something else queued (its
  /// own repaint request), so its timers would never arrive. A pump calls this
  /// after each burst.
  pub fn dispatch_due_timers(&self) {
    // Bounded: a handler that keeps timers due cannot hold the caller here.
    for _ in 0..64 {
      let mut message = MSG::default();
      // SAFETY: `message` is a valid MSG for the call to fill, and `self.hwnd` is owned by
      // this `SignalWindow` and destroyed only in its `Drop`.
      let found = unsafe { PeekMessageW(&mut message, Some(self.hwnd), WM_TIMER, WM_TIMER, PM_REMOVE) };
      if !found.as_bool() {
        break;
      }
      // SAFETY: `message` was filled by the PeekMessageW call just above.
      unsafe { DispatchMessageW(&message) };
    }
  }

  fn kill(&self, id: usize) {
    // SAFETY: `self.hwnd` is owned by this `SignalWindow` and destroyed only in its `Drop`.
    let killed = unsafe { KillTimer(Some(self.hwnd), id) };
    // A timer that is already gone is the state wanted.
    let _ = killed;
  }
}

impl Drop for SignalWindow {
  fn drop(&mut self) {
    {
      // Disarm the wakers first, under the lock a wake holds while it posts.
      let mut target = self.wake_target.0.lock().unwrap_or_else(PoisonError::into_inner);
      *target = 0;
    }
    for id in self.timers.take() {
      self.kill(id);
    }
    // `try_with`: a signal window kept in thread-local storage is dropped while the
    // thread's storage is being torn down, when the table may already be gone.
    let _ = HANDLERS.try_with(|handlers| handlers.borrow_mut().remove(&(self.hwnd.0 as isize)));
    // SAFETY: `self.hwnd` was created by `new` on this thread (the type is not `Send`),
    // is owned by this value alone, and is not used again after this call.
    let destroyed = unsafe { DestroyWindow(self.hwnd) };
    // Nothing useful can be done with a failure while dropping.
    let _ = destroyed;
  }
}

/// The handler of the signal window `hwnd`, if it is one of this thread's.
fn handler_of(hwnd: HWND) -> Option<Handler> {
  // `try_with`: a message can arrive while the thread's storage is being torn down.
  HANDLERS.try_with(|handlers| handlers.borrow().get(&(hwnd.0 as isize)).cloned()).ok().flatten()
}

/// Turns a window message into a signal and delivers it. True when it was one of ours.
fn deliver(hwnd: HWND, message: u32, wparam: WPARAM) -> bool {
  let signal = match message {
    WM_SWEETVIEW_WAKE => Signal::Wake(wparam.0 as u64),
    WM_TIMER => Signal::Timer(TimerId(wparam.0)),
    _ => return false,
  };
  // The handler is cloned out of the table first, so it may drop its own
  // signal window from inside the call.
  if let Some(handler) = handler_of(hwnd) {
    handler(signal);
  }
  true
}

/// The window procedure of every signal window. Called by the OS; never unwinds.
extern "system" fn signal_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  // A panic must not cross into the OS: it is caught and the message counts as handled.
  let handled = catch_unwind(AssertUnwindSafe(|| deliver(hwnd, message, wparam))).unwrap_or(true);
  if handled {
    return LRESULT(0);
  }
  // SAFETY: the arguments are the ones the OS passed to this window procedure for this message.
  unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{Duration, Instant};
  use windows::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GetProcessHandleCount, GR_USEROBJECTS};

  /// Dispatches this thread's queued messages until `done` or the deadline.
  fn pump_until(done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() && Instant::now() < deadline {
      let mut message = MSG::default();
      // SAFETY: `message` is a valid MSG for the call to fill.
      while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
        // SAFETY: `message` was filled by PeekMessageW just above.
        unsafe { DispatchMessageW(&message) };
      }
      std::thread::sleep(Duration::from_millis(1));
    }
  }

  fn user_objects() -> u32 {
    // SAFETY: the pseudo-handle of the current process is always valid.
    let process = unsafe { GetCurrentProcess() };
    // SAFETY: `process` is the current process's pseudo-handle.
    unsafe { GetGuiResources(process, GR_USEROBJECTS) }
  }

  fn kernel_handles() -> u32 {
    // SAFETY: the pseudo-handle of the current process is always valid.
    let process = unsafe { GetCurrentProcess() };
    let mut count = 0u32;
    // SAFETY: `count` is a valid u32 for the call to fill.
    unsafe { GetProcessHandleCount(process, &mut count) }.expect("GetProcessHandleCount");
    count
  }

  fn serial() -> std::sync::MutexGuard<'static, ()> {
    crate::TEST_SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
  }

  #[test]
  fn a_wake_from_another_thread_and_a_timer_are_delivered_on_this_thread() {
    let _serial = serial();
    let seen: Rc<RefCell<Vec<Signal>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    let window = SignalWindow::new(move |signal| sink.borrow_mut().push(signal)).expect("signal window");
    let waker = window.waker();
    let thread = std::thread::spawn(move || waker.wake(0xDEAD_BEEF_0001));
    assert!(thread.join().expect("waker thread"));
    let timer = window.set_timer(5).expect("timer");
    pump_until(|| {
      let seen = seen.borrow();
      seen.contains(&Signal::Wake(0xDEAD_BEEF_0001)) && seen.iter().filter(|s| **s == Signal::Timer(timer)).count() >= 2
    });
    window.cancel_timer(timer);
    let seen = seen.borrow();
    assert!(seen.contains(&Signal::Wake(0xDEAD_BEEF_0001)), "the wake arrived: {seen:?}");
    assert!(seen.iter().filter(|s| **s == Signal::Timer(timer)).count() >= 2, "the timer repeated: {seen:?}");
  }

  #[test]
  fn due_timers_are_delivered_on_request_while_other_messages_are_queued() {
    let _serial = serial();
    let fired = Rc::new(Cell::new(0u32));
    let count = fired.clone();
    let window = SignalWindow::new(move |signal| {
      if matches!(signal, Signal::Timer(_)) {
        count.set(count.get() + 1);
      }
    })
    .expect("signal window");
    let _timer = window.set_timer(1).expect("timer");
    let deadline = Instant::now() + Duration::from_secs(5);
    while fired.get() < 3 && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(5));
      // No general pump runs here: only the timers of this window are taken.
      window.dispatch_due_timers();
    }
    assert!(fired.get() >= 3, "timers fired {} times", fired.get());
  }

  #[test]
  fn a_waker_outlives_its_window_and_then_reports_failure() {
    let _serial = serial();
    let window = SignalWindow::new(|_| {}).expect("signal window");
    let waker = window.waker();
    assert!(waker.wake(1));
    drop(window);
    assert!(!waker.wake(2));
  }

  #[test]
  fn a_handler_may_drop_its_own_window_and_a_panic_does_not_unwind() {
    let _serial = serial();
    let slot: Rc<RefCell<Option<SignalWindow>>> = Rc::new(RefCell::new(None));
    let calls = Rc::new(Cell::new(0u32));
    let (inner_slot, inner_calls) = (slot.clone(), calls.clone());
    let window = SignalWindow::new(move |_| {
      inner_calls.set(inner_calls.get() + 1);
      // Destroys the window whose procedure is running this handler.
      inner_slot.borrow_mut().take();
      panic!("a handler that panics is caught at the window procedure");
    })
    .expect("signal window");
    let waker = window.waker();
    *slot.borrow_mut() = Some(window);
    assert!(waker.wake(7));
    pump_until(|| calls.get() == 1);
    assert_eq!(calls.get(), 1);
    assert!(slot.borrow().is_none());
    assert!(!waker.wake(8));
  }

  #[test]
  fn creating_and_dropping_returns_every_handle() {
    let _serial = serial();
    // One round first, so one-time costs (the window class, lazily loaded modules) are paid.
    drop(SignalWindow::new(|_| {}).expect("signal window"));
    let (user_before, kernel_before) = (user_objects(), kernel_handles());
    for _ in 0..200 {
      let window = SignalWindow::new(|_| {}).expect("signal window");
      let timer = window.set_timer(1000).expect("timer");
      let _waker = window.waker();
      window.cancel_timer(timer);
      let _left_set = window.set_timer(1000).expect("timer");
    }
    assert_eq!(user_objects(), user_before, "USER objects returned to the starting count");
    assert!(kernel_handles() <= kernel_before + 2, "kernel handles returned to the starting count");
  }
}
