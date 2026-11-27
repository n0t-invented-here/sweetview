//! The UI thread's message plumbing on Windows.
//!
//! A message posted to a window is dispatched by whichever message loop the
//! thread is in: `tao`'s, the OS's modal loop of a dialog, a popup menu or a
//! window being resized, or an application's own. That is what makes a wake
//! and a timer arrive while a handler holds a modal dialog open.
//!
//! [`MessageWindow`] is the one owning type for a message-only window in the
//! platform crates: the signal window here, the notifier's window, the
//! clipboard's owner and the single-instance window are each one, with their
//! own window procedure as a closure. The message pump's calls are here too,
//! behind [`QueuedMessage`], so a message is dispatched only as the OS queued it.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::marker::PhantomData;
use std::num::NonZeroIsize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::{Arc, Mutex, PoisonError};

use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use windows::core::HSTRING;
use windows::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GetProcessHandleCount, GR_GDIOBJECTS, GR_USEROBJECTS};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, KillTimer, PeekMessageW, PostMessageW,
  PostQuitMessage, RegisterClassExW, SetTimer, TranslateMessage, HWND_MESSAGE, MSG, PEEK_MESSAGE_REMOVE_TYPE, PM_NOREMOVE,
  PM_QS_INPUT, PM_QS_POSTMESSAGE, PM_QS_SENDMESSAGE, PM_REMOVE, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_QUIT, WM_TIMER,
  WNDCLASSEXW,
};

use crate::signal::{Signal, SignalError, TimerId};
use crate::ResourceCounts;

// ---- message-only windows ----------------------------------------------------------------

/// A message-only window's procedure: the message, `wParam` and `lParam`;
/// `Some(result)` when it handled the message, `None` to let the OS handle it.
type Procedure = Rc<dyn Fn(u32, usize, isize) -> Option<isize>>;

thread_local! {
  /// The procedure of each live message window of this thread, by window handle value.
  /// The window procedure finds its closure here, so no pointer rides in the window's data.
  static PROCEDURES: RefCell<HashMap<isize, Procedure>> = RefCell::new(HashMap::new());
}

/// A message window could not be made: the OS call that failed and its error.
#[derive(Debug, Clone)]
pub struct WindowError {
  call: &'static str,
  error: windows::core::Error,
}

impl WindowError {
  /// The OS function that failed, such as `CreateWindowExW`.
  pub fn call(&self) -> &'static str {
    self.call
  }

  /// The Win32 error code (`GetLastError`) of the failure.
  pub fn code(&self) -> i32 {
    self.error.code().0 & 0xffff
  }
}

impl fmt::Display for WindowError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.call, self.error)
  }
}

impl std::error::Error for WindowError {}

/// The handle value posts go to. Zero once the window is destroyed.
///
/// The lock is held across both the post and the destroy, so a post from
/// another thread never reaches a handle that has been destroyed and reused.
struct PostTarget(Mutex<isize>);

/// Posts messages to a [`MessageWindow`] from any thread. Cheap to clone.
/// Once the window is dropped, every post reports failure.
#[derive(Clone)]
pub struct Poster(Arc<PostTarget>);

impl Poster {
  /// Posts `message` with plain integer parameters. Returns false when the
  /// window is gone or the message could not be queued.
  pub fn post(&self, message: u32, wparam: usize, lparam: isize) -> bool {
    let target = self.0 .0.lock().unwrap_or_else(PoisonError::into_inner);
    if *target == 0 {
      return false;
    }
    let hwnd = HWND(*target as *mut core::ffi::c_void);
    // SAFETY: `*target` is non-zero only while the `MessageWindow` that owns this
    // window is alive; its `Drop` zeroes it under this same lock before destroying
    // the window, and the lock is held for the whole call. The parameters are
    // integers the receiving procedure reads as integers.
    let posted = unsafe { PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(lparam)) };
    posted.is_ok()
  }
}

/// A message-only window made on this thread, with its window procedure as a
/// closure. Dropping it disarms every [`Poster`], forgets the closure and
/// destroys the window.
///
/// Not `Send`: the window and its closure belong to the thread that made them.
pub struct MessageWindow {
  hwnd: HWND,
  target: Arc<PostTarget>,
  _not_send: PhantomData<*const ()>,
}

impl MessageWindow {
  /// Registers `class_name` (once per process; a second registration's "class
  /// already exists" is the state wanted) and makes a window of it titled
  /// `title`. `procedure` runs on this thread for each message the window gets
  /// once this call has returned, from inside whichever message loop
  /// dispatches it; a panic in it is caught and the message counts as handled
  /// with result 0. It may drop its own window.
  pub fn new(
    class_name: &str,
    title: &str,
    procedure: impl Fn(u32, usize, isize) -> Option<isize> + 'static,
  ) -> Result<Self, WindowError> {
    // SAFETY: a null module name asks for the handle of the process's own executable; no pointer is passed.
    let module = unsafe { GetModuleHandleW(None) }.map_err(|error| WindowError { call: "GetModuleHandleW", error })?;
    let class_name = HSTRING::from(class_name);
    let class = WNDCLASSEXW {
      cbSize: size_of::<WNDCLASSEXW>() as u32,
      lpfnWndProc: Some(message_window_proc),
      hInstance: module.into(),
      lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
      ..Default::default()
    };
    // SAFETY: `class` is a fully initialised WNDCLASSEXW owned by this frame; the
    // class name it points to is `class_name`, alive for the whole call, and the
    // system copies it. The procedure is `message_window_proc`, a `'static` fn.
    let atom = unsafe { RegisterClassExW(&class) };
    if atom == 0 {
      let error = windows::core::Error::from_thread();
      if error.code() != ERROR_CLASS_ALREADY_EXISTS.to_hresult() {
        return Err(WindowError { call: "RegisterClassExW", error });
      }
    }
    // SAFETY: the class and window names are HSTRINGs alive for the whole call, no
    // creation parameter is passed, and HWND_MESSAGE makes a message-only window
    // with no parent to keep alive. Messages sent during creation find no closure
    // in `PROCEDURES` yet and go to `DefWindowProcW`.
    let created = unsafe {
      CreateWindowExW(
        WINDOW_EX_STYLE(0),
        &class_name,
        &HSTRING::from(title),
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
    let hwnd = created.map_err(|error| WindowError { call: "CreateWindowExW", error })?;
    PROCEDURES.with(|procedures| procedures.borrow_mut().insert(hwnd.0 as isize, Rc::new(procedure)));
    Ok(Self { hwnd, target: Arc::new(PostTarget(Mutex::new(hwnd.0 as isize))), _not_send: PhantomData })
  }

  /// A handle other threads use to post to this window.
  pub fn poster(&self) -> Poster {
    Poster(self.target.clone())
  }

  /// The window's handle, for the calls of this crate that name the window.
  pub(crate) fn hwnd(&self) -> HWND {
    self.hwnd
  }
}

impl HasWindowHandle for MessageWindow {
  /// The window, borrowed for as long as this value is: for an OS call of
  /// another platform crate that names its owner window (the clipboard's
  /// owner, a notification-area icon's window).
  fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
    let value = NonZeroIsize::new(self.hwnd.0 as isize).ok_or(HandleError::Unavailable)?;
    let raw = RawWindowHandle::Win32(Win32WindowHandle::new(value));
    // SAFETY: `borrow_raw` asks that the handle name a window for the whole
    // borrow. `self.hwnd` was made by `new` and is destroyed only in this value's
    // `Drop`, which cannot run while the borrow of `&self` is alive.
    Ok(unsafe { WindowHandle::borrow_raw(raw) })
  }
}

impl Drop for MessageWindow {
  fn drop(&mut self) {
    {
      // Disarm the posters first, under the lock a post holds.
      let mut target = self.target.0.lock().unwrap_or_else(PoisonError::into_inner);
      *target = 0;
    }
    // `try_with`: a window kept in thread-local storage is dropped while the
    // thread's storage is being torn down, when the table may already be gone.
    let _ = PROCEDURES.try_with(|procedures| procedures.borrow_mut().remove(&(self.hwnd.0 as isize)));
    // SAFETY: `self.hwnd` was created by `new` on this thread (the type is not
    // `Send`), is owned by this value alone, and is not used again after this call.
    let destroyed = unsafe { DestroyWindow(self.hwnd) };
    // Nothing useful can be done with a failure while dropping.
    let _ = destroyed;
  }
}

/// The window procedure of every [`MessageWindow`]. Called by the OS; never unwinds.
extern "system" fn message_window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  // The closure is cloned out of the table first, so it may drop its own window.
  // `try_with`: a message can arrive while the thread's storage is being torn down.
  let procedure = PROCEDURES.try_with(|procedures| procedures.borrow().get(&(hwnd.0 as isize)).cloned()).ok().flatten();
  if let Some(procedure) = procedure {
    // A panic must not cross into the OS: it is caught and the message counts as handled.
    match catch_unwind(AssertUnwindSafe(|| procedure(message, wparam.0, lparam.0))) {
      Ok(Some(result)) => return LRESULT(result),
      Ok(None) => {}
      Err(_) => return LRESULT(0),
    }
  }
  // SAFETY: the arguments are the ones the OS passed to this window procedure for this message.
  unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

// ---- the message pump ------------------------------------------------------------------

/// A message the OS took off this thread's queue. Only this crate makes one,
/// from `PeekMessageW` or `GetMessageW`, so what it holds is what the OS put
/// there, which is what `TranslateMessage` and `DispatchMessageW` require.
///
/// Not `Send`: a message is dispatched on the thread whose queue it came from.
pub struct QueuedMessage(MSG);

impl QueuedMessage {
  /// True for `WM_QUIT`.
  pub fn is_quit(&self) -> bool {
    self.0.message == WM_QUIT
  }

  /// Turns a key message into its character messages, as a message loop does.
  pub fn translate(&self) {
    // SAFETY: `self.0` was filled by the OS from this thread's queue (see the type).
    let _translated = unsafe { TranslateMessage(&self.0) };
  }

  /// Hands the message to its window's procedure.
  pub fn dispatch(&self) {
    // SAFETY: `self.0` was filled by the OS from this thread's queue (see the
    // type), so its window, parameters and any timer procedure are the OS's own.
    unsafe { DispatchMessageW(&self.0) };
  }
}

/// `PeekMessageW` on this thread's queue: the first message for `hwnd` (any
/// window for `None`) in `first..=last` (every message for `0, 0`).
fn peek(hwnd: Option<HWND>, first: u32, last: u32, flags: PEEK_MESSAGE_REMOVE_TYPE) -> Option<QueuedMessage> {
  let mut message = MSG::default();
  // SAFETY: `message` is a MSG owned by this frame for the call to fill; the
  // window filter is a handle the caller owns or none, and the OS validates it.
  let found = unsafe { PeekMessageW(&mut message, hwnd, first, last, flags) };
  found.as_bool().then_some(QueuedMessage(message))
}

/// Takes the next waiting message off this thread's queue, if there is one.
pub fn next_message() -> Option<QueuedMessage> {
  peek(None, 0, 0, PM_REMOVE)
}

/// What [`wait_message`] got.
pub enum Waited {
  /// A message other than `WM_QUIT`.
  Message(QueuedMessage),
  /// `WM_QUIT`: the thread's quit request, now taken off the queue.
  Quit,
  /// `GetMessageW` failed.
  Failed,
}

/// Waits for the next message of this thread, as `GetMessageW` does.
pub fn wait_message() -> Waited {
  let mut message = MSG::default();
  // SAFETY: `message` is a MSG owned by this frame for the call to fill; no window filter.
  let got = unsafe { GetMessageW(&mut message, None, 0, 0) };
  match got.0 {
    -1 => Waited::Failed,
    0 => Waited::Quit,
    _ if message.message == WM_QUIT => Waited::Quit,
    _ => Waited::Message(QueuedMessage(message)),
  }
}

/// Dispatches every message waiting in this thread's queue (no translation).
pub fn dispatch_waiting() {
  while let Some(message) = next_message() {
    message.dispatch();
  }
}

/// Takes back a quit request (`PostQuitMessage`) of this thread.
///
/// The OS keeps a quit request as a flag and hands out `WM_QUIT` only once
/// nothing posted is left in the queue, so the one way to remove it is to
/// dispatch what is waiting until it comes out, and drop it. Returns at once
/// when no quit was asked for and nothing waits. Works from inside any loop,
/// a handler of `tao`'s own included, as a modal loop does.
///
/// Returns true when a quit request was taken back.
pub fn discard_quit() -> bool {
  // Bounded, so a handler that keeps posting cannot hold the caller here.
  for _ in 0..10_000 {
    let Some(message) = next_message() else { return false };
    if message.is_quit() {
      return true;
    }
    message.translate();
    message.dispatch();
  }
  false
}

/// True when a message is waiting in this thread's queue: one posted (a
/// wake, a due timer, an application's own), input, or one sent from another
/// thread. Paint requests, which a window keeps until it is drawn, do not
/// count. Nothing is removed.
pub fn messages_waiting() -> bool {
  peek(None, 0, 0, PM_NOREMOVE | PM_QS_POSTMESSAGE | PM_QS_INPUT | PM_QS_SENDMESSAGE).is_some()
}

/// Sets this thread's quit request, as `PostQuitMessage(0)` does. For tests
/// of code that must survive one.
#[doc(hidden)]
pub fn post_quit_for_tests() {
  // SAFETY: `PostQuitMessage` sets the calling thread's quit flag; it takes an integer and reads no memory.
  unsafe { PostQuitMessage(0) };
}

// ---- the process's resources ------------------------------------------------------------

/// The process's USER objects, GDI objects and kernel handles now.
pub fn resource_counts() -> ResourceCounts {
  // SAFETY: `GetCurrentProcess` takes nothing and returns a constant pseudo-handle that needs no closing.
  let process = unsafe { GetCurrentProcess() };
  // SAFETY: `process` is the current process's pseudo-handle, valid for the life of the process.
  let user_objects = unsafe { GetGuiResources(process, GR_USEROBJECTS) };
  // SAFETY: as above.
  let gdi_objects = unsafe { GetGuiResources(process, GR_GDIOBJECTS) };
  let mut kernel_handles = 0u32;
  // SAFETY: `process` as above; `kernel_handles` is a u32 owned by this frame for the call to fill.
  let _counted = unsafe { GetProcessHandleCount(process, &mut kernel_handles) };
  ResourceCounts { user_objects, gdi_objects, kernel_handles }
}

// ---- the signal window --------------------------------------------------------------------

/// The message a [`Waker`] posts. `wParam` carries the token.
const WM_SWEETVIEW_WAKE: u32 = WM_APP + 0x53;

/// Wakes the UI thread from any thread. Cheap to clone.
#[derive(Clone)]
pub struct Waker(Poster);

impl Waker {
  /// Delivers `Signal::Wake(token)` on the UI thread. Returns false when the
  /// signal window is gone or the message could not be queued.
  pub fn wake(&self, token: u64) -> bool {
    let Ok(wparam) = usize::try_from(token) else { return false };
    self.0.post(WM_SWEETVIEW_WAKE, wparam, 0)
  }
}

/// A message-only window owned by the UI thread. Dropping it destroys the
/// window, cancels its timers and disarms every [`Waker`] made from it.
pub struct SignalWindow {
  next_timer: Cell<usize>,
  timers: RefCell<HashSet<usize>>,
  /// Declared last, so the timers are killed (in `Drop`) while the window exists.
  window: MessageWindow,
}

impl SignalWindow {
  /// Makes the window. `handler` runs on this thread for every signal, from
  /// inside whichever message loop dispatched it. A handler that panics is
  /// caught; the signal is dropped.
  pub fn new(handler: impl Fn(Signal) + 'static) -> Result<Self, SignalError> {
    let window = MessageWindow::new("SweetviewSignalWindow", "sweetview.signal", move |message, wparam, _lparam| {
      let signal = match message {
        WM_SWEETVIEW_WAKE => Signal::Wake(wparam as u64),
        WM_TIMER => Signal::Timer(TimerId(wparam)),
        _ => return None,
      };
      handler(signal);
      Some(0)
    })
    .map_err(|e| SignalError(e.to_string()))?;
    Ok(Self { next_timer: Cell::new(1), timers: RefCell::new(HashSet::new()), window })
  }

  /// A handle other threads use to wake this one.
  pub fn waker(&self) -> Waker {
    Waker(self.window.poster())
  }

  /// Starts a timer that delivers `Signal::Timer` every `interval_ms`
  /// milliseconds until it is cancelled.
  pub fn set_timer(&self, interval_ms: u32) -> Result<TimerId, SignalError> {
    let id = self.next_timer.get();
    self.next_timer.set(id.wrapping_add(1).max(1));
    // SAFETY: the window is owned by `self.window` and destroyed only in its `Drop`;
    // no timer procedure is passed, so the timer arrives as a WM_TIMER message.
    let set = unsafe { SetTimer(Some(self.window.hwnd()), id, interval_ms, None) };
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
      let Some(message) = peek(Some(self.window.hwnd()), WM_TIMER, WM_TIMER, PM_REMOVE) else { break };
      message.dispatch();
    }
  }

  fn kill(&self, id: usize) {
    // SAFETY: the window is owned by `self.window` and destroyed only in its `Drop`,
    // which runs after this value's own `Drop` has killed the timers.
    let killed = unsafe { KillTimer(Some(self.window.hwnd()), id) };
    // A timer that is already gone is the state wanted.
    let _ = killed;
  }
}

impl Drop for SignalWindow {
  fn drop(&mut self) {
    for id in self.timers.take() {
      self.kill(id);
    }
    // `self.window` is dropped next: it disarms the wakers and destroys the window.
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::testing::smallest_growth;
  use std::time::{Duration, Instant};

  /// Dispatches this thread's queued messages until `done` or the deadline.
  fn pump_until(done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() && Instant::now() < deadline {
      dispatch_waiting();
      std::thread::sleep(Duration::from_millis(1));
    }
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
  fn a_quit_request_is_taken_back_after_what_was_posted_ahead_of_it() {
    let _serial = serial();
    let seen = Rc::new(Cell::new(0u32));
    let count = seen.clone();
    let window = SignalWindow::new(move |_| count.set(count.get() + 1)).expect("signal window");
    assert!(window.waker().wake(5));
    post_quit_for_tests();
    assert!(discard_quit());
    assert_eq!(seen.get(), 1, "the wake posted ahead of the quit was dispatched");
    assert!(!discard_quit(), "nothing asked for, nothing waiting");
  }

  #[test]
  fn creating_and_dropping_returns_every_handle() {
    let _serial = serial();
    // One round first, so one-time costs (the window class, lazily loaded modules) are paid.
    drop(SignalWindow::new(|_| {}).expect("signal window"));
    let (user_before, kernel_before) = {
      let counts = resource_counts();
      (counts.user_objects, counts.kernel_handles)
    };
    for _ in 0..200 {
      let window = SignalWindow::new(|_| {}).expect("signal window");
      let timer = window.set_timer(1000).expect("timer");
      let _waker = window.waker();
      window.cancel_timer(timer);
      let _left_set = window.set_timer(1000).expect("timer");
    }
    let after = resource_counts();
    assert_eq!(after.user_objects, user_before, "USER objects returned to the starting count");
    assert!(after.kernel_handles <= kernel_before + 2, "kernel handles returned to the starting count");
  }

  #[test]
  fn message_windows_give_back_every_handle_and_route_posts_to_their_closure() {
    let _serial = serial();
    let seen = Rc::new(Cell::new(0usize));
    let sink = seen.clone();
    let window = MessageWindow::new("SweetviewLoopTestWindow", "sweetview.loop-test", move |message, wparam, lparam| {
      (message == WM_APP + 7).then(|| {
        sink.set(wparam + lparam as usize);
        0
      })
    })
    .expect("message window");
    let poster = window.poster();
    assert!(std::thread::spawn(move || poster.post(WM_APP + 7, 40, 2)).join().expect("poster thread"));
    pump_until(|| seen.get() == 42);
    assert_eq!(seen.get(), 42);
    assert!(window.window_handle().is_ok());
    let poster = window.poster();
    drop(window);
    assert!(!poster.post(WM_APP + 7, 0, 0), "a post after the drop fails");

    let growth = smallest_growth(100, || {
      let window = MessageWindow::new("SweetviewLoopTestWindow", "sweetview.loop-test", |_, _, _| None).expect("message window");
      let _poster = window.poster();
    });
    assert!(growth.user_objects <= 0 && growth.gdi_objects <= 0 && growth.kernel_handles <= 0, "{growth:?}");
  }
}
