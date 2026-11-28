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
use std::collections::HashMap;
use std::fmt;
use std::marker::PhantomData;
use std::num::NonZeroIsize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GetProcessHandleCount, GR_GDIOBJECTS, GR_USEROBJECTS};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClassInfoExW, GetInputState, GetMessageW, InSendMessageEx, IsWindow, PeekMessageW,
  PostMessageW, PostQuitMessage, RegisterClassExW, TranslateMessage, UnregisterClassW, HWND_MESSAGE, ISMEX_SEND, MSG,
  PEEK_MESSAGE_REMOVE_TYPE, PM_NOREMOVE, PM_NOYIELD, PM_QS_INPUT, PM_QS_POSTMESSAGE, PM_QS_SENDMESSAGE, PM_REMOVE, WINDOW_EX_STYLE,
  WINDOW_STYLE, WM_APP, WM_CLOSE, WM_CREATE, WM_GETMINMAXINFO, WM_NCCALCSIZE, WM_NCCREATE, WM_NCDESTROY, WM_QUIT, WNDCLASSEXW,
  WNDPROC,
};

use crate::signal::{Signal, SignalError, TimerId};
use crate::ResourceCounts;

// ---- message-only windows ----------------------------------------------------------------

/// A message-only window's procedure: the message, `wParam` and `lParam`;
/// `Some(result)` when it handled the message, `None` to let the OS handle it.
type Procedure = Rc<dyn Fn(u32, usize, isize) -> Option<isize>>;

/// What the window procedure keeps for one live message window: its closure,
/// and the post target it disarms when the window is destroyed.
struct Entry {
  procedure: Procedure,
  target: Arc<PostTarget>,
}

thread_local! {
  /// Each live message window of this thread, by window handle value. The
  /// window procedure finds its closure here, so no pointer rides in the window's data.
  static PROCEDURES: RefCell<HashMap<isize, Entry>> = RefCell::new(HashMap::new());
}

/// How many live windows each class this crate registered has, process-wide,
/// so the last window of a class unregisters it. Every registration, window
/// creation and destruction of a [`MessageWindow`] holds this lock, so a class
/// is never unregistered between another thread's registration and its window.
fn classes() -> MutexGuard<'static, HashMap<String, usize>> {
  static CLASSES: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
  CLASSES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(PoisonError::into_inner)
}

/// The handle of the process's own executable, which registers the classes.
fn this_module() -> Result<HMODULE, WindowError> {
  // SAFETY: a null module name asks for the handle of the process's own executable; no pointer is passed.
  unsafe { GetModuleHandleW(None) }.map_err(|error| WindowError { call: "GetModuleHandleW", error })
}

/// The window procedure the class `name` of this module was registered with,
/// or `None` when no such class is registered.
fn class_procedure(module: HMODULE, name: &HSTRING) -> Option<WNDPROC> {
  let mut class = WNDCLASSEXW { cbSize: size_of::<WNDCLASSEXW>() as u32, ..Default::default() };
  // SAFETY: `class` is a WNDCLASSEXW owned by this frame with `cbSize` set, for the call to fill;
  // `name` is an HSTRING alive for the whole call.
  let found = unsafe { GetClassInfoExW(Some(HINSTANCE::from(module)), name, &mut class) };
  found.is_ok().then_some(class.lpfnWndProc)
}

/// True when `procedure` is [`message_window_proc`]. Compared by address: a
/// class another part of the process registered under the same name has its own.
fn is_ours(procedure: WNDPROC) -> bool {
  let ours: WNDPROC = Some(message_window_proc);
  procedure.map(|p| p as usize) == ours.map(|p| p as usize)
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

/// The last message number a [`Poster`] posts: the application's range ends
/// at `0xBFFF`, which this crate keeps for [`WM_STILL_ALIVE`].
const LAST_POSTED: u32 = 0xBFFE;

/// The message a window procedure posts its own window on a `WM_NCDESTROY` it
/// cannot tell from the destruction (see [`PostTarget`]).
const WM_STILL_ALIVE: u32 = 0xBFFF;

/// How many posts a [`PostTarget`] holds while it waits to learn whether its
/// window is alive. Further posts report failure.
const HELD_POSTS: usize = 1024;

/// Where posts to one [`MessageWindow`] go.
///
/// `hwnd` is zero once the window is gone: `MessageWindow::drop` zeroes it
/// before destroying the window, a poster or `live_hwnd` when `IsWindow` shows
/// that other code destroyed it, and the window procedure at the first creation
/// message of a later window of this crate made under the same handle value.
///
/// A post the queue refuses after the window was confirmed alive (a full queue)
/// is held too, and sent first, in order, at the next post or the next message
/// the window gets.
///
/// A window procedure cannot tell the `WM_NCDESTROY` that `DestroyWindow` sends
/// from one posted to a live window (this process or another can post one; the
/// window reads the same in both, `IsWindow` included). So on a `WM_NCDESTROY`
/// of this thread the procedure marks the target `ending` and posts the window
/// [`WM_STILL_ALIVE`]. A window that is alive receives it, and any message it
/// receives, and is armed again; a destroyed window takes its queued messages
/// with it. While `ending`, posts are held, never sent, so none reaches a handle
/// value a destroyed window gave up; they are sent when the window is armed
/// again, and dropped once `IsWindow` shows it gone.
///
/// The lock is held across every post and every change of state, so a post
/// from another thread never reaches a handle that has been destroyed and reused.
struct PostTarget(Mutex<Target>);

struct Target {
  hwnd: isize,
  ending: bool,
  held: Vec<(u32, usize, isize)>,
}

impl Target {
  fn disarm(&mut self) {
    self.hwnd = 0;
    self.ending = false;
    self.held = Vec::new();
  }

  fn window(&self) -> HWND {
    HWND(self.hwnd as *mut core::ffi::c_void)
  }

  /// Posts what is held, in the order it was posted, to `hwnd`, which the caller knows names
  /// this target's live window; stops at the first post the queue refuses, which stays held with
  /// everything after it. True when nothing is left held.
  fn flush(&mut self, hwnd: HWND) -> bool {
    while let Some(&(message, wparam, lparam)) = self.held.first() {
      // SAFETY: `hwnd` names this target's live window for the call (each caller says why), and
      // the parameters are integers the receiving procedure reads as integers.
      let posted = unsafe { PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(lparam)) };
      if posted.is_err() {
        return false;
      }
      self.held.remove(0);
    }
    true
  }
}

impl PostTarget {
  fn new(hwnd: HWND) -> Self {
    Self(Mutex::new(Target { hwnd: hwnd.0 as isize, ending: false, held: Vec::new() }))
  }

  fn lock(&self) -> MutexGuard<'_, Target> {
    self.0.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// The window procedure got a `WM_NCDESTROY` of this thread for `hwnd`: hold
  /// posts until the window shows it is alive.
  fn begin_ending(&self, hwnd: HWND) {
    let mut target = self.lock();
    if target.hwnd != hwnd.0 as isize {
      return;
    }
    target.ending = true;
    // SAFETY: `hwnd` is the window whose procedure is running this call, so it names a window
    // for the whole call; the parameters are integers. A window being destroyed loses the message.
    let posted = unsafe { PostMessageW(Some(hwnd), WM_STILL_ALIVE, WPARAM(0), LPARAM(0)) };
    // Not queued: the window stays `ending` and its owner treats it as gone (`live_hwnd`).
    let _ = posted;
  }

  /// The window procedure got a message for `hwnd`, so the window is alive: arm it again after a
  /// `WM_NCDESTROY`, and send what is held, in order. A post the queue refuses stays held, for
  /// the next post or the next message the window gets.
  fn still_alive(&self, hwnd: HWND) {
    let mut target = self.lock();
    if target.hwnd != hwnd.0 as isize || (!target.ending && target.held.is_empty()) {
      return;
    }
    target.ending = false;
    // `hwnd` is the window whose procedure is running this call, so it names the window.
    let _flushed = target.flush(hwnd);
  }
}

/// True when `hwnd` names a window now. Any value is accepted.
fn names_a_window(hwnd: HWND) -> bool {
  // SAFETY: `IsWindow` accepts any value and only reports whether it names a window.
  unsafe { IsWindow(Some(hwnd)) }.as_bool()
}

/// Posts messages to a [`MessageWindow`] from any thread. Cheap to clone.
/// Once the window is gone, every post reports failure.
#[derive(Clone)]
pub struct Poster(Arc<PostTarget>);

impl Poster {
  /// Posts `message`, a number of the application's range (`WM_APP` to
  /// `0xBFFE`), with plain integer parameters. Returns false for any other
  /// number, when the window is gone, or when the message could not be queued.
  /// A system message is refused because the window would act on it as if the
  /// OS had sent it. A `WM_CLOSE` or `WM_NCDESTROY` posted to the window by
  /// anyone else leaves it working (see [`MessageWindow`]).
  pub fn post(&self, message: u32, wparam: usize, lparam: isize) -> bool {
    if !(WM_APP..=LAST_POSTED).contains(&message) {
      return false;
    }
    let mut target = self.0.lock();
    if target.hwnd == 0 {
      return false;
    }
    if target.ending {
      if !names_a_window(target.window()) {
        target.disarm();
        return false;
      }
      if target.held.len() >= HELD_POSTS {
        return false;
      }
      target.held.push((message, wparam, lparam));
      return true;
    }
    if !target.held.is_empty() {
      // Posts the queue refused earlier go first, in order; this one joins them.
      if target.held.len() >= HELD_POSTS {
        return false;
      }
      target.held.push((message, wparam, lparam));
      let hwnd = target.window();
      // `target.hwnd` names the live window here, as for the post below.
      let _flushed = target.flush(hwnd);
      return true;
    }
    // SAFETY: `target.hwnd` is non-zero and not `ending` only while the window exists: it is
    // zeroed before the owner destroys the window, marked `ending` by the window procedure on any
    // `WM_NCDESTROY` of the window's thread, which `DestroyWindow` sends before the handle is given
    // up, and zeroed at the first creation message of any later window of this crate made under
    // the same value (see `answer`), all under this lock, which is held for the whole call. The parameters are
    // integers the receiving procedure reads as integers.
    let posted = unsafe { PostMessageW(Some(target.window()), message, WPARAM(wparam), LPARAM(lparam)) };
    posted.is_ok()
  }
}

/// A message-only window made on this thread, with its window procedure as a
/// closure. Dropping it disarms every [`Poster`], forgets the closure and
/// destroys the window; the last window of a class unregisters the class.
///
/// The window procedure answers `WM_CLOSE` itself, so a close posted from
/// another thread or process does not destroy the window. Should other code
/// of this thread destroy it anyway (`DestroyWindow` on the handle it lends),
/// `WM_NCDESTROY` disarms this value: posts fail, timers and handles are
/// refused, and `Drop` destroys nothing. A `WM_NCDESTROY` that another thread
/// sends is refused (`DestroyWindow` destroys only windows of the calling
/// thread), and one posted to the live window disarms it only until the window
/// receives its next message, in the same turn of the loop; posts made
/// meanwhile are held and then delivered (see `PostTarget`).
///
/// Not `Send`: the window and its closure belong to the thread that made them.
pub struct MessageWindow {
  hwnd: HWND,
  class: String,
  target: Arc<PostTarget>,
  _not_send: PhantomData<*const ()>,
}

impl MessageWindow {
  /// Registers `class_name` (once per process while any window of it lives;
  /// a class of that name registered with another procedure is refused) and
  /// makes a window of it titled `title`. `procedure` runs on this thread for
  /// each message the window gets once this call has returned, from inside
  /// whichever message loop dispatches it; a panic in it is caught and the
  /// message counts as handled with result 0. It may drop its own window.
  pub fn new(
    class_name: &str,
    title: &str,
    procedure: impl Fn(u32, usize, isize) -> Option<isize> + 'static,
  ) -> Result<Self, WindowError> {
    let module = this_module()?;
    let class_wide = HSTRING::from(class_name);
    let mut classes = classes();
    let registered_here = !classes.contains_key(class_name);
    if registered_here {
      let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(message_window_proc),
        hInstance: module.into(),
        lpszClassName: PCWSTR(class_wide.as_ptr()),
        ..Default::default()
      };
      // SAFETY: `class` is a fully initialised WNDCLASSEXW owned by this frame; the
      // class name it points to is `class_wide`, alive for the whole call, and the
      // system copies it. The procedure is `message_window_proc`, a `'static` fn.
      let atom = unsafe { RegisterClassExW(&class) };
      if atom == 0 {
        let error = windows::core::Error::from_thread();
        // A class of this name that this crate did not count: one this module
        // registered earlier and could not unregister, or another part of the
        // process's. Only one with this crate's own procedure will do.
        if error.code() != ERROR_CLASS_ALREADY_EXISTS.to_hresult() || !class_procedure(module, &class_wide).is_some_and(is_ours) {
          return Err(WindowError { call: "RegisterClassExW", error });
        }
      }
    }
    let making = Making::begin();
    // SAFETY: the class and window names are HSTRINGs alive for the whole call, no
    // creation parameter is passed, and HWND_MESSAGE makes a message-only window
    // with no parent to keep alive. Messages sent during creation find no entry in
    // `PROCEDURES` and go to `DefWindowProcW`: this window's entry is added after this
    // call, and one left under the same handle value by a window destroyed earlier is
    // removed, its owner disarmed, at the first of them (`is_being_made`, `answer`).
    let created = unsafe {
      CreateWindowExW(
        WINDOW_EX_STYLE(0),
        &class_wide,
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
    drop(making);
    let hwnd = match created {
      Ok(hwnd) => hwnd,
      Err(error) => {
        if registered_here {
          unregister_class(module, &class_wide);
        }
        return Err(WindowError { call: "CreateWindowExW", error });
      }
    };
    *classes.entry(class_name.to_owned()).or_insert(0) += 1;
    drop(classes);
    let target = Arc::new(PostTarget::new(hwnd));
    let entry = Entry { procedure: Rc::new(procedure), target: target.clone() };
    PROCEDURES.with(|procedures| procedures.borrow_mut().insert(hwnd.0 as isize, entry));
    Ok(Self { hwnd, class: class_name.to_owned(), target, _not_send: PhantomData })
  }

  /// A handle other threads use to post to this window.
  pub fn poster(&self) -> Poster {
    Poster(self.target.clone())
  }

  /// The window's handle while the window exists, for the calls of this crate
  /// that name the window; `None` once something destroyed it, and while a
  /// `WM_NCDESTROY` is waiting to be confirmed (see `PostTarget`).
  pub(crate) fn live_hwnd(&self) -> Option<HWND> {
    let mut target = self.target.lock();
    if target.ending && !names_a_window(self.hwnd) {
      // Destroyed by other code: forget it now, as the window procedure no longer can.
      target.disarm();
      drop(target);
      self.forget();
      return None;
    }
    (target.hwnd != 0 && !target.ending).then_some(self.hwnd)
  }

  /// Removes this value's own entry from the table. Only its own: a window destroyed
  /// earlier may have left its handle value to a later window of this thread.
  fn forget(&self) {
    // `try_with`: a window kept in thread-local storage is dropped while the
    // thread's storage is being torn down, when the table may already be gone.
    let _ = PROCEDURES.try_with(|procedures| {
      let mut procedures = procedures.borrow_mut();
      if procedures.get(&(self.hwnd.0 as isize)).is_some_and(|entry| Arc::ptr_eq(&entry.target, &self.target)) {
        procedures.remove(&(self.hwnd.0 as isize));
      }
    });
  }
}

/// True when this thread's queue holds a [`WM_STILL_ALIVE`] for `hwnd`, which it takes out.
/// A window that `DestroyWindow` destroyed took its queued messages with it.
fn still_alive_queued(hwnd: HWND) -> bool {
  let mut message = MSG::default();
  // SAFETY: `message` is a MSG owned by this frame for the call to fill; the window filter is
  // a handle value the OS validates, and a value that names no window of this thread matches nothing.
  let found = unsafe { PeekMessageW(&mut message, Some(hwnd), WM_STILL_ALIVE, WM_STILL_ALIVE, PM_REMOVE | PM_NOYIELD) };
  found.as_bool()
}

/// Unregisters the class `name` of `module`; a failure (a window of it still
/// exists somewhere) leaves it registered, which a later `new` accepts.
fn unregister_class(module: HMODULE, name: &HSTRING) {
  // SAFETY: `name` is an HSTRING alive for the whole call; the class was registered by
  // this crate with `message_window_proc`, and the `classes` lock the caller holds keeps
  // any other `MessageWindow::new` from making a window of it meanwhile.
  let _unregistered = unsafe { UnregisterClassW(name, Some(HINSTANCE::from(module))) };
}

impl HasWindowHandle for MessageWindow {
  /// The window, borrowed for as long as this value is: for an OS call of
  /// another platform crate that names its owner window (the clipboard's
  /// owner, a notification-area icon's window). Refused once the window is gone.
  fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
    let hwnd = self.live_hwnd().ok_or(HandleError::Unavailable)?;
    let value = NonZeroIsize::new(hwnd.0 as isize).ok_or(HandleError::Unavailable)?;
    let raw = RawWindowHandle::Win32(Win32WindowHandle::new(value));
    // SAFETY: `borrow_raw` asks that the handle name a window for the whole borrow.
    // `live_hwnd` just read it from the post target, which the window procedure marks
    // `ending` on any `WM_NCDESTROY` of this thread and which `live_hwnd` then refuses, so
    // it names this value's window now; this value destroys it only in `Drop`, which the
    // borrow of `&self` excludes.
    // Should other code of this thread destroy the lent handle during the borrow, the
    // OS validates it on each later call and refuses it, and this value refuses the next.
    Ok(unsafe { WindowHandle::borrow_raw(raw) })
  }
}

impl Drop for MessageWindow {
  fn drop(&mut self) {
    // Disarm the posters first, under the lock a post holds. Zero already when
    // something else destroyed the window and this value has seen it.
    let (armed, ending) = {
      let mut target = self.target.lock();
      let state = (target.hwnd != 0, target.ending);
      target.disarm();
      state
    };
    self.forget();
    // A `WM_NCDESTROY` not yet confirmed either way: the window is alive only if the message
    // it posted itself then is still queued (a destroyed window took it with it).
    let live = armed && (!ending || still_alive_queued(self.hwnd));
    let mut classes = classes();
    if live {
      // SAFETY: `self.hwnd` was created by `new` on this thread (the type is not `Send`)
      // and still exists: `live` was read from the post target, which the window procedure
      // marks on any `WM_NCDESTROY` of this thread before `DestroyWindow` gives the handle
      // value up (a marked one counts only when the window's own `WM_STILL_ALIVE` is still
      // queued for it), and which a later window of this crate made under the same value
      // disarms at its first creation message; so the value still names this window. Not used
      // again after this call.
      let destroyed = unsafe { DestroyWindow(self.hwnd) };
      // Nothing useful can be done with a failure while dropping.
      let _ = destroyed;
    }
    let last = match classes.get_mut(&self.class) {
      Some(count) => {
        *count = count.saturating_sub(1);
        *count == 0
      }
      None => false,
    };
    if last {
      classes.remove(&self.class);
      if let Ok(module) = this_module() {
        unregister_class(module, &HSTRING::from(self.class.as_str()));
      }
    }
  }
}

/// What the window procedure does with one message: `Some` when it answered
/// it, `None` to hand it to `DefWindowProcW`.
fn answer(hwnd: HWND, message: u32, wparam: usize, lparam: isize) -> Option<isize> {
  if is_being_made(message) {
    // A window of this crate is being made under this handle value (`WM_GETMINMAXINFO` comes
    // even before `WM_NCCREATE`). An entry is added only after `CreateWindowExW` returns, so one
    // found now was left by a window destroyed earlier: its owner is disarmed and the entry
    // forgotten before anything of the new window runs.
    forget_stale(hwnd);
    return None;
  }
  // The closure is cloned out of the table first, so it may drop its own window.
  // `try_with`: a message can arrive while the thread's storage is being torn down.
  let found = PROCEDURES
    .try_with(|procedures| procedures.borrow().get(&(hwnd.0 as isize)).map(|entry| (entry.procedure.clone(), entry.target.clone())))
    .ok()
    .flatten();
  let (procedure, target) = found?;
  if message == WM_NCDESTROY {
    // SAFETY: `InSendMessageEx` takes a reserved pointer that must be null and reads nothing.
    let how = unsafe { InSendMessageEx(None) };
    if how & ISMEX_SEND != 0 {
      // Sent from another thread, so not the destruction: `DestroyWindow` destroys only
      // windows of the thread that calls it, and sends this message on that thread.
      return Some(0);
    }
    // Destroyed by someone other than the owner's `Drop` (which removes the entry first), or
    // posted to the live window: posts are held until the window shows which.
    target.begin_ending(hwnd);
    return None;
  }
  // Any later message proves the window alive.
  target.still_alive(hwnd);
  if message == WM_STILL_ALIVE {
    return Some(0);
  }
  match procedure(message, wparam, lparam) {
    // `DefWindowProcW` destroys a window on `WM_CLOSE`; only the owner destroys this one.
    None if message == WM_CLOSE => Some(0),
    answered => answered,
  }
}

thread_local! {
  /// True while `MessageWindow::new` is inside `CreateWindowExW` on this thread.
  static MAKING: Cell<bool> = const { Cell::new(false) };
}

/// True for the messages the OS sends a window while `CreateWindowExW` makes it, while this
/// thread is making a window of this crate. Outside that, the same message numbers (which anyone
/// can post) go to the window's owner as usual.
fn is_being_made(message: u32) -> bool {
  matches!(message, WM_GETMINMAXINFO | WM_NCCREATE | WM_NCCALCSIZE | WM_CREATE) && MAKING.try_with(Cell::get).unwrap_or(false)
}

/// Marks this thread as making a window for as long as it lives.
struct Making;

impl Making {
  fn begin() -> Self {
    let _ = MAKING.try_with(|making| making.set(true));
    Self
  }
}

impl Drop for Making {
  fn drop(&mut self) {
    let _ = MAKING.try_with(|making| making.set(false));
  }
}

/// Forgets the table entry under `hwnd`, which belongs to a window destroyed earlier, and
/// disarms its owner, so neither acts on the new window that has that handle value now.
fn forget_stale(hwnd: HWND) {
  let stale = PROCEDURES.try_with(|procedures| procedures.borrow_mut().remove(&(hwnd.0 as isize))).ok().flatten();
  if let Some(entry) = stale {
    entry.target.lock().disarm();
  }
}

/// The window procedure of every [`MessageWindow`]. Called by the OS; never
/// unwinds: its body runs inside `catch_unwind`, and a panic counts as handled
/// with result 0.
extern "system" fn message_window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  match catch_unwind(AssertUnwindSafe(|| answer(hwnd, message, wparam.0, lparam.0))) {
    Ok(Some(result)) => LRESULT(result),
    Err(_) => LRESULT(0),
    // SAFETY: the arguments are the ones the OS passed to this window procedure for this message.
    Ok(None) => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
  }
}

// ---- the message pump ------------------------------------------------------------------

/// A message the OS took off this thread's queue. Only this crate makes one,
/// from `PeekMessageW` or `GetMessageW`, so what it holds is what the OS put
/// there, which is what `TranslateMessage` and `DispatchMessageW` require.
/// Dispatching consumes it, so a message is dispatched at most once: a message
/// can carry ownership in its parameters (a boxed closure `tao` posts to its
/// own window and takes back when its procedure runs).
///
/// Not `Send`: a message is dispatched on the thread whose queue it came from.
///
/// A second dispatch of the same message does not compile:
///
/// ```compile_fail,E0382
/// if let Some(message) = sweetview_platform_loop::next_message() {
///   message.dispatch();
///   message.dispatch();
/// }
/// ```
pub struct QueuedMessage(MSG);

impl QueuedMessage {
  /// True for `WM_QUIT`.
  pub fn is_quit(&self) -> bool {
    self.0.message == WM_QUIT
  }

  /// Turns a key message into its character messages, as a message loop does.
  /// Call it before [`QueuedMessage::dispatch`].
  pub fn translate(&self) {
    // SAFETY: `self.0` was filled by the OS from this thread's queue (see the type).
    let _translated = unsafe { TranslateMessage(&self.0) };
  }

  /// Hands the message to its window's procedure, once: the message is consumed.
  pub fn dispatch(self) {
    // The parameters are whatever the poster chose, and any process of the session may post:
    // the window procedure reads them as the message defines, and the OS calls a `WM_TIMER`'s
    // timer procedure only when this thread registered it with `SetTimer` (measured, D39).
    // SAFETY: `self.0` was filled by the OS from this thread's queue (see the type), so its
    // window is one the OS queued it for and validates again here (parameters: above); `self`
    // is consumed, so this message is not dispatched again.
    unsafe { DispatchMessageW(&self.0) };
  }
}

/// `PeekMessageW` on this thread's queue: the first message for `window`
/// (any window for `None`) in `first..=last` (every message for `0, 0`).
/// Nothing for a window that is gone.
fn peek(window: Option<&MessageWindow>, first: u32, last: u32, flags: PEEK_MESSAGE_REMOVE_TYPE) -> Option<QueuedMessage> {
  let hwnd = match window {
    Some(window) => Some(window.live_hwnd()?),
    None => None,
  };
  let mut message = MSG::default();
  // SAFETY: `message` is a MSG owned by this frame for the call to fill; the window
  // filter is none or the live window of a `MessageWindow` borrowed for the call
  // (`live_hwnd`), and the OS validates it.
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

/// Looks at this thread's queue without removing anything, with no filter, as the message waits
/// inside COM calls do. For tests of code that must survive what that does: when the next
/// message is a repaint request for a window with no update region, the OS drops the request.
#[doc(hidden)]
pub fn peek_without_removing_for_tests() -> bool {
  peek(None, 0, 0, PM_NOREMOVE).is_some()
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

/// The message a timer's tick posts. `wParam` carries the timer's id, `lParam` the tick's number.
const WM_SWEETVIEW_TICK: u32 = WM_APP + 0x54;

/// The shortest period a timer gets, as `SetTimer` gives (`USER_TIMER_MINIMUM`).
const SHORTEST_PERIOD_MS: u32 = 10;
/// The longest period a timer gets, as `SetTimer` gives (`USER_TIMER_MAXIMUM`).
const LONGEST_PERIOD_MS: u32 = 0x7FFF_FFFF;

/// A posted tick not taken within this many periods, and at least [`LOST_AFTER_LEAST`], counts as
/// lost (a loop that removed it without dispatching it, a queue that refused a re-post), and the
/// timer's tick is posted again under a new number; the lost one is dropped if it arrives later.
const LOST_AFTER_PERIODS: u32 = 4;
const LOST_AFTER_LEAST: Duration = Duration::from_millis(250);

/// A tick taken while keyboard or mouse-button input waits is handed back and posted again this
/// much later, so the input is taken first, as it was ahead of a `WM_TIMER`; for no longer than
/// [`INPUT_DEFER_LIMIT`] after the tick came due, after which it runs whatever waits (D38).
const INPUT_DEFER_STEP: Duration = Duration::from_millis(1);
const INPUT_DEFER_LIMIT: Duration = Duration::from_millis(100);

/// The longest the tick thread sleeps before it looks at its stop flag again, for a stop whose
/// wake it missed (`stop_ticker` cannot always take the lock).
const TICKER_WAKE_CAP: Duration = Duration::from_millis(100);

/// How long the release at the end of the application waits for the tick thread to return.
const TICKER_STOP_WAIT: Duration = Duration::from_millis(20);

fn lost_after(period: Duration) -> Duration {
  (period * LOST_AFTER_PERIODS).max(LOST_AFTER_LEAST)
}

/// Where one timer's tick is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
  /// The next tick is posted at `Schedule::next`.
  Waiting,
  /// Tick number `tick` was posted at `at` and has not been taken.
  Posted { tick: isize, at: Instant },
  /// The UI thread took the tick and runs the timer's job; the next period starts when it returns.
  Running,
}

/// One timer of a [`SignalWindow`].
struct Schedule {
  period: Duration,
  /// When the next tick is posted, while `Waiting`.
  next: Instant,
  phase: Phase,
  /// The number of the last tick posted.
  last_tick: isize,
  /// When the tick being delivered came due, for the limit on how long input may hold it back.
  due_since: Option<Instant>,
}

/// The timers of one [`SignalWindow`], shared between the UI thread and the tick thread.
#[derive(Default)]
struct Ticks {
  timers: Mutex<HashMap<usize, Schedule>>,
  changed: Condvar,
}

/// What the UI thread does with a tick it took.
#[derive(Debug, PartialEq, Eq)]
enum Take {
  /// Run the timer's job, then `finish_tick`.
  Run,
  /// Handed back: input is waiting.
  Later,
  /// A tick of a cancelled timer, or one posted again after it was counted lost: dropped.
  Stale,
}

impl Ticks {
  fn lock(&self) -> MutexGuard<'_, HashMap<usize, Schedule>> {
    self.timers.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// The UI thread took tick number `tick` of timer `id`; `input_waiting` says whether keyboard or
  /// mouse-button input is waiting in its queue.
  fn take_tick(&self, id: usize, tick: isize, input_waiting: bool) -> Take {
    let mut timers = self.lock();
    let Some(timer) = timers.get_mut(&id) else { return Take::Stale };
    if !matches!(timer.phase, Phase::Posted { tick: posted, .. } if posted == tick) {
      return Take::Stale;
    }
    let now = Instant::now();
    if input_waiting && timer.due_since.is_some_and(|since| now.saturating_duration_since(since) < INPUT_DEFER_LIMIT) {
      timer.phase = Phase::Waiting;
      timer.next = now + INPUT_DEFER_STEP;
      drop(timers);
      self.changed.notify_all();
      return Take::Later;
    }
    timer.phase = Phase::Running;
    timer.due_since = None;
    Take::Run
  }

  /// The job of timer `id` returned (or unwound): its next period starts now, so a job that takes
  /// longer than its period leaves the rest of the queue a whole period before its next tick.
  fn finish_tick(&self, id: usize) {
    let mut timers = self.lock();
    if let Some(timer) = timers.get_mut(&id) {
      if timer.phase == Phase::Running {
        timer.phase = Phase::Waiting;
        timer.next = Instant::now() + timer.period;
      }
    }
    drop(timers);
    self.changed.notify_all();
  }
}

/// Runs `finish_tick` when the job returns or unwinds.
struct Finish<'a>(&'a Ticks, usize);

impl Drop for Finish<'_> {
  fn drop(&mut self) {
    self.0.finish_tick(self.1);
  }
}

/// The tick thread's body: posts each timer's tick when it comes due, in the order they came due
/// and then the order they were set, until `stop` is set. Posting never blocks, so the lock is
/// held only for moments.
fn post_ticks(ticks: &Ticks, poster: &Poster, stop: &AtomicBool) {
  let mut timers = ticks.lock();
  while !stop.load(Ordering::Acquire) {
    let now = Instant::now();
    let mut due: Vec<(Instant, usize)> = timers
      .iter()
      .filter_map(|(id, timer)| match timer.phase {
        Phase::Waiting if timer.next <= now => Some((timer.due_since.unwrap_or(timer.next), *id)),
        Phase::Posted { at, .. } if now.saturating_duration_since(at) >= lost_after(timer.period) => Some((at, *id)),
        _ => None,
      })
      .collect();
    due.sort();
    for (came_due, id) in due {
      let Some(timer) = timers.get_mut(&id) else { continue };
      let tick = timer.last_tick.wrapping_add(1);
      if poster.post(WM_SWEETVIEW_TICK, id, tick) {
        timer.last_tick = tick;
        timer.due_since.get_or_insert(came_due);
        timer.phase = Phase::Posted { tick, at: now };
      } else {
        // Not queued (the window is gone, or its queue is full): tried again a period later.
        timer.phase = Phase::Waiting;
        timer.next = now + timer.period;
      }
    }
    let wake = timers
      .values()
      .filter_map(|timer| match timer.phase {
        Phase::Waiting => Some(timer.next),
        Phase::Posted { at, .. } => Some(at + lost_after(timer.period)),
        Phase::Running => None,
      })
      .min();
    let sleep = wake.map_or(TICKER_WAKE_CAP, |at| at.saturating_duration_since(Instant::now()).min(TICKER_WAKE_CAP));
    timers = ticks.changed.wait_timeout(timers, sleep).unwrap_or_else(PoisonError::into_inner).0;
  }
}

/// True when keyboard or mouse-button input waits in this thread's queue. `GetInputState` only
/// reads the queue's state; it does not mark anything in the queue as seen.
fn input_waiting() -> bool {
  // MEASURE: 0 = gap only, 1 = gap + input, 2 = gap + input + paint.
  let mode: u8 = std::env::var("SWEETVIEW_TICK_MODE").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
  if mode == 0 {
    return false;
  }
  // SAFETY: `GetInputState` takes nothing and reads the calling thread's queue state.
  let input = unsafe { GetInputState() }.as_bool();
  if mode == 2 {
    // SAFETY: measurement only.
    let paint = (unsafe { windows::Win32::UI::WindowsAndMessaging::GetQueueStatus(windows::Win32::UI::WindowsAndMessaging::QS_PAINT) } >> 16) != 0;
    return input || paint;
  }
  input
}

/// The tick thread, with its own stop flag and the flag it sets as the last thing it does.
struct Ticker {
  thread: std::thread::JoinHandle<()>,
  stop: Arc<AtomicBool>,
  returned: Arc<AtomicBool>,
}

/// A message-only window owned by the UI thread. Dropping it stops its tick
/// thread, destroys the window and disarms every [`Waker`] made from it.
///
/// Its timers do not use `SetTimer`. A `WM_TIMER` is made only when the
/// thread's queue holds nothing else, after every paint request, and a modal
/// loop such as a popup menu's can wait with one already due and never take it
/// (D38). Each tick is instead a message posted to the window by a thread of
/// this value's own; a posted message wakes any loop that waits for new
/// messages. A posted message also comes ahead of input and paint, so a tick is
/// kept from crowding them out: a timer's next period starts only when its job
/// returns, and a tick taken while keyboard or mouse-button input waits is
/// posted again shortly after, up to a limit (D38).
pub struct SignalWindow {
  next_timer: Cell<usize>,
  ticks: Arc<Ticks>,
  /// The thread that posts the ticks, started with the first timer.
  ticker: RefCell<Option<Ticker>>,
  window: MessageWindow,
}

impl SignalWindow {
  /// Makes the window. `handler` runs on this thread for every signal, from
  /// inside whichever message loop dispatched it. A handler that panics is
  /// caught; the signal is dropped.
  pub fn new(handler: impl Fn(Signal) + 'static) -> Result<Self, SignalError> {
    let ticks = Arc::new(Ticks::default());
    let taken = ticks.clone();
    let window = MessageWindow::new("SweetviewSignalWindow", "sweetview.signal", move |message, wparam, lparam| {
      match message {
        WM_SWEETVIEW_WAKE => handler(Signal::Wake(wparam as u64)),
        WM_SWEETVIEW_TICK => {
          if taken.take_tick(wparam, lparam, input_waiting()) == Take::Run {
            let _finish = Finish(&taken, wparam);
            handler(Signal::Timer(TimerId(wparam)));
          }
        }
        _ => return None,
      }
      Some(0)
    })
    .map_err(|e| SignalError(e.to_string()))?;
    Ok(Self { next_timer: Cell::new(1), ticks, ticker: RefCell::new(None), window })
  }

  /// A handle other threads use to wake this one.
  pub fn waker(&self) -> Waker {
    Waker(self.window.poster())
  }

  /// Starts a timer that delivers `Signal::Timer` every `interval_ms`
  /// milliseconds until it is cancelled. The period is held to 10 ms and
  /// above, as `SetTimer` holds it, and the next period starts when the job of
  /// the last tick has returned.
  pub fn set_timer(&self, interval_ms: u32) -> Result<TimerId, SignalError> {
    if self.window.live_hwnd().is_none() {
      return Err(SignalError("a timer could not be set: the signal window is gone".into()));
    }
    self.start_ticker()?;
    let id = self.next_timer.get();
    self.next_timer.set(id.wrapping_add(1).max(1));
    let period = Duration::from_millis(u64::from(interval_ms.clamp(SHORTEST_PERIOD_MS, LONGEST_PERIOD_MS)));
    let schedule = Schedule { period, next: Instant::now() + period, phase: Phase::Waiting, last_tick: 0, due_since: None };
    self.ticks.lock().insert(id, schedule);
    self.ticks.changed.notify_all();
    Ok(TimerId(id))
  }

  fn start_ticker(&self) -> Result<(), SignalError> {
    let mut ticker = self.ticker.borrow_mut();
    if ticker.is_none() {
      let (ticks, poster) = (self.ticks.clone(), self.window.poster());
      let (stop, returned) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
      let (stopped, said) = (stop.clone(), returned.clone());
      let thread = std::thread::Builder::new()
        .name("sweetview-timers".into())
        .spawn(move || {
          post_ticks(&ticks, &poster, &stopped);
          said.store(true, Ordering::Release);
        })
        .map_err(|e| SignalError(format!("a timer could not be set: its thread did not start: {e}")))?;
      *ticker = Some(Ticker { thread, stop, returned });
    }
    Ok(())
  }

  /// Cancels a timer. Cancelling one that is not set does nothing. A
  /// cancelled timer delivers nothing more, a tick already posted included.
  pub fn cancel_timer(&self, timer: TimerId) {
    self.ticks.lock().remove(&timer.0);
  }

  /// How many timers are set. For tests that check nothing is left running.
  #[doc(hidden)]
  pub fn timers_set_for_tests(&self) -> usize {
    self.ticks.lock().len()
  }

  /// True while the tick thread runs. For tests of the release at the end of the application.
  #[doc(hidden)]
  pub fn ticker_running_for_tests(&self) -> bool {
    self.ticker.borrow().is_some()
  }

  /// Ends the tick thread when no timer is set, as the release at the end of the
  /// application leaves it; the next timer starts a new one.
  pub fn stop_ticker_if_idle(&self) {
    if !self.ticks.lock().is_empty() {
      return;
    }
    self.stop_ticker(TICKER_STOP_WAIT);
  }

  /// Tells the tick thread to end, waits up to `wait` for it to say it returned, and joins it
  /// then; otherwise it is left to end on its own (it owns everything it uses, and the window's
  /// drop disarms its `Poster`).
  ///
  /// The thread is told under the lock when the lock is free, so the wake cannot fall between
  /// its look at its flag and its wait; when the lock is held, it looks at its flag again within
  /// `TICKER_WAKE_CAP`. At process exit Windows ends every other thread before it runs the exiting
  /// thread's thread-local destructors, where a runtime kept in thread-local storage drops this
  /// value; the lock may then belong to a thread the OS ended, and `std`'s `join` panics on such
  /// a thread. So `Drop` waits for nothing (`wait` is zero) and joins nothing.
  fn stop_ticker(&self, wait: Duration) {
    let Some(ticker) = self.ticker.borrow_mut().take() else { return };
    ticker.stop.store(true, Ordering::Release);
    match self.ticks.timers.try_lock() {
      Ok(_timers) => self.ticks.changed.notify_all(),
      Err(TryLockError::Poisoned(_timers)) => self.ticks.changed.notify_all(),
      Err(TryLockError::WouldBlock) => self.ticks.changed.notify_all(),
    }
    if wait.is_zero() {
      return;
    }
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
      if ticker.returned.load(Ordering::Acquire) {
        let _ = ticker.thread.join();
        return;
      }
      std::thread::yield_now();
    }
  }
}

impl Drop for SignalWindow {
  fn drop(&mut self) {
    self.stop_ticker(Duration::ZERO);
    // `self.window` is dropped next: it disarms the wakers and destroys the window.
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::testing::assert_gives_back_every_handle;
  use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, HCBT_CREATEWND, WH_CBT};

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
    assert_gives_back_every_handle(200, || {
      let window = SignalWindow::new(|_| {}).expect("signal window");
      let timer = window.set_timer(1000).expect("timer");
      let _waker = window.waker();
      window.cancel_timer(timer);
      let _left_set = window.set_timer(1000).expect("timer");
    });
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

    assert_gives_back_every_handle(100, || {
      let window = MessageWindow::new("SweetviewLoopTestWindow", "sweetview.loop-test", |_, _, _| None).expect("message window");
      let _poster = window.poster();
    });
  }

  /// The raw handle a `MessageWindow` lends, as another platform crate gets it.
  fn lent_hwnd(window: &MessageWindow) -> HWND {
    match window.window_handle().expect("a live window").as_raw() {
      RawWindowHandle::Win32(handle) => HWND(handle.hwnd.get() as *mut core::ffi::c_void),
      _ => unreachable!("a Win32 handle"),
    }
  }

  fn registered(name: &str) -> bool {
    class_procedure(this_module().expect("module"), &HSTRING::from(name)).is_some()
  }

  /// `WM_CLOSE` from any thread is answered by the procedure: the window, its
  /// posters and its closure carry on as before.
  #[test]
  fn a_posted_close_leaves_the_window_and_its_owner_coherent() {
    let _serial = serial();
    let closes = Rc::new(Cell::new(0u32));
    let pings = Rc::new(Cell::new(0u32));
    let (close_sink, ping_sink) = (closes.clone(), pings.clone());
    let window = MessageWindow::new("SweetviewLoopCloseTest", "sweetview.close-test", move |message, _, _| {
      match message {
        WM_CLOSE => close_sink.set(close_sink.get() + 1),
        m if m == WM_APP + 9 => ping_sink.set(ping_sink.get() + 1),
        _ => return None,
      }
      // The close is seen and left to the OS's default answer: the window procedure answers it.
      (message != WM_CLOSE).then_some(0)
    })
    .expect("message window");
    let poster = window.poster();
    assert!(!poster.post(WM_CLOSE, 0, 0), "a Poster refuses a system message");
    // Posted from another thread with `PostMessageW` itself, as another process can.
    let value = lent_hwnd(&window).0 as isize;
    let remote = std::thread::spawn(move || {
      // SAFETY: `PostMessageW` validates the handle value; the parameters are integers.
      unsafe { PostMessageW(Some(HWND(value as *mut core::ffi::c_void)), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok()
    });
    assert!(remote.join().expect("poster thread"));
    pump_until(|| closes.get() == 1);
    assert_eq!(closes.get(), 1, "the closure saw the close");
    let hwnd = lent_hwnd(&window);
    // SAFETY: `IsWindow` accepts any value and only reports whether it names a window.
    assert!(unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(hwnd)) }.as_bool(), "the window still exists");
    assert!(poster.post(WM_APP + 9, 0, 0), "posts still reach it");
    pump_until(|| pings.get() == 1);
    assert_eq!(pings.get(), 1);
    drop(window);
    assert!(!poster.post(WM_APP + 9, 0, 0));
    assert!(!registered("SweetviewLoopCloseTest"), "the last window of the class unregistered it");
  }

  /// A window destroyed out from under its owner disarms the owner: every
  /// later call is refused instead of acting on the stale handle value.
  #[test]
  fn a_window_destroyed_by_other_code_disarms_its_owner() {
    let _serial = serial();
    let window = SignalWindow::new(|_| {}).expect("signal window");
    let waker = window.waker();
    let timer = window.set_timer(1000).expect("timer");
    let hwnd = lent_hwnd(&window.window);
    // SAFETY: the test destroys the window of its own `SignalWindow` on this thread, as code
    // of this thread holding the lent handle could.
    unsafe { DestroyWindow(hwnd) }.expect("DestroyWindow");
    assert!(peek(None, WM_STILL_ALIVE, WM_STILL_ALIVE, PM_NOREMOVE).is_none(), "the destroyed window took its own confirmation with it");
    assert!(window.window.live_hwnd().is_none());
    assert!(matches!(window.window.window_handle(), Err(HandleError::Unavailable)), "no handle is lent");
    assert!(!waker.wake(1), "posts fail");
    assert!(window.set_timer(1000).is_err(), "timers are refused");
    window.cancel_timer(timer);
    assert!(PROCEDURES.with(|p| !p.borrow().contains_key(&(hwnd.0 as isize))), "the closure is forgotten");
    drop(window);
    // The class stays usable, and a new window of it works.
    let fired = Rc::new(Cell::new(false));
    let sink = fired.clone();
    let again = SignalWindow::new(move |_| sink.set(true)).expect("a new signal window");
    assert!(again.waker().wake(2));
    pump_until(|| fired.get());
    assert!(fired.get());
  }

  /// Posts `message` to `window` with `PostMessageW` itself, as other code of the
  /// session can, past the range a `Poster` keeps to.
  fn post_directly(window: &MessageWindow, message: u32) {
    let hwnd = lent_hwnd(window);
    // SAFETY: `hwnd` is the live window `window` lends; the parameters are integers.
    unsafe { PostMessageW(Some(hwnd), message, WPARAM(0), LPARAM(0)) }.expect("PostMessageW");
  }

  /// A `WM_NCDESTROY` posted to a live window disarms its owner only until the
  /// window's next message; what was posted meanwhile arrives, and the owner,
  /// its timers and its `Drop` work as before (the review's G3).
  #[test]
  fn a_posted_ncdestroy_leaves_the_window_and_its_owner_working() {
    let _serial = serial();
    let signals: Rc<RefCell<Vec<Signal>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = signals.clone();
    let window = SignalWindow::new(move |signal| sink.borrow_mut().push(signal)).expect("signal window");
    let waker = window.waker();
    let poster = window.window.poster();
    assert!(!poster.post(WM_NCDESTROY, 0, 0), "a Poster refuses a system message");
    assert!(!poster.post(0x0113, 0, 0), "and a WM_TIMER");
    let hwnd = lent_hwnd(&window.window);
    post_directly(&window.window, WM_NCDESTROY);
    let message = next_message().expect("the posted WM_NCDESTROY");
    assert_eq!(message.0.message, WM_NCDESTROY);
    message.dispatch();
    // Not yet confirmed: refused for now, a post is held, not lost.
    assert!(window.window.live_hwnd().is_none());
    assert!(waker.wake(11), "a wake made meanwhile is held");
    pump_until(|| signals.borrow().contains(&Signal::Wake(11)));
    assert!(signals.borrow().contains(&Signal::Wake(11)), "and delivered once the window showed it is alive: {:?}", signals.borrow());
    assert!(window.window.live_hwnd().is_some(), "armed again");
    assert!(waker.wake(12));
    let timer = window.set_timer(10).expect("timers work");
    pump_until(|| signals.borrow().contains(&Signal::Wake(12)) && signals.borrow().contains(&Signal::Timer(timer)));
    assert!(signals.borrow().contains(&Signal::Timer(timer)), "{:?}", signals.borrow());
    drop(window);
    assert!(!names_a_window(hwnd), "Drop destroyed the window");
    assert!(!waker.wake(13));
  }

  /// Dropped before a posted `WM_NCDESTROY` is confirmed, the owner still destroys
  /// its live window; a `WM_NCDESTROY` sent from another thread is refused outright.
  #[test]
  fn an_unconfirmed_ncdestroy_still_lets_drop_destroy_and_a_sent_one_is_refused() {
    let _serial = serial();
    let window = MessageWindow::new("SweetviewLoopNcTest", "sweetview.nc-test", |_, _, _| None).expect("message window");
    let hwnd = lent_hwnd(&window);
    post_directly(&window, WM_NCDESTROY);
    next_message().expect("the posted WM_NCDESTROY").dispatch();
    assert!(window.live_hwnd().is_none(), "waiting for the confirmation");
    drop(window);
    assert!(!names_a_window(hwnd), "Drop destroyed the live window");
    assert!(!registered("SweetviewLoopNcTest"));

    let window = MessageWindow::new("SweetviewLoopNcTest", "sweetview.nc-test", |_, _, _| None).expect("message window");
    let value = lent_hwnd(&window).0 as isize;
    let sender = std::thread::spawn(move || {
      // SAFETY: `SendMessageW` validates the handle value; the parameters are integers.
      unsafe { windows::Win32::UI::WindowsAndMessaging::SendMessageW(HWND(value as *mut core::ffi::c_void), WM_NCDESTROY, None, None) }
    });
    while !sender.is_finished() {
      // A message sent from another thread is answered inside a look at the queue.
      let _ = peek_without_removing_for_tests();
    }
    sender.join().expect("sender thread");
    assert!(window.live_hwnd().is_some(), "a WM_NCDESTROY from another thread changed nothing");
  }

  /// A tick that never reaches the window (a loop took it off the queue and did not dispatch it)
  /// counts as lost after a while; the timer's tick is posted again and the timer goes on (the
  /// third review's H4).
  #[test]
  fn a_lost_tick_is_posted_again_and_the_timer_goes_on() {
    let _serial = serial();
    let ticks = Rc::new(Cell::new(0u32));
    let count = ticks.clone();
    let window = SignalWindow::new(move |signal| {
      if matches!(signal, Signal::Timer(_)) {
        count.set(count.get() + 1);
      }
    })
    .expect("signal window");
    let _timer = window.set_timer(10).expect("timer");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut taken_away = false;
    while !taken_away && Instant::now() < deadline {
      taken_away = peek(Some(&window.window), WM_SWEETVIEW_TICK, WM_SWEETVIEW_TICK, PM_REMOVE).is_some();
      std::thread::sleep(Duration::from_millis(1));
    }
    assert!(taken_away, "the first tick was posted");
    let lost_at = Instant::now();
    pump_until(|| ticks.get() >= 3);
    assert!(ticks.get() >= 3, "the timer went on after its tick was lost: {} ticks", ticks.get());
    let took = lost_at.elapsed();
    assert!(took >= lost_after(Duration::from_millis(10)) - Duration::from_millis(20), "posted again only once counted lost: {took:?}");
    assert!(took < Duration::from_secs(2), "{took:?}");
  }

  /// A post that the queue refuses when held posts are sent stays held, and goes out first, in
  /// order, with the next message the window gets or the next post (the third review's H4).
  #[test]
  fn a_held_post_the_queue_refuses_stays_held_and_goes_out_in_order() {
    let _serial = serial();
    let seen: Rc<RefCell<Vec<usize>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    let window = MessageWindow::new("SweetviewLoopHeldTest", "sweetview.held-test", move |message, wparam, _| {
      (message == WM_APP + 9).then(|| {
        sink.borrow_mut().push(wparam);
        0
      })
    })
    .expect("message window");
    let poster = window.poster();
    let hwnd = lent_hwnd(&window);
    post_directly(&window, WM_NCDESTROY);
    next_message().expect("the posted WM_NCDESTROY").dispatch();
    assert!(poster.post(WM_APP + 9, 1, 0) && poster.post(WM_APP + 9, 2, 0), "held while unconfirmed");
    // Fill the thread's queue to its limit, behind the window's own confirmation.
    let mut filled = 0;
    // SAFETY: `hwnd` is the live window `window` lends; the parameters are integers.
    while filled < 20_000 && unsafe { PostMessageW(Some(hwnd), WM_APP + 10, WPARAM(0), LPARAM(0)) }.is_ok() {
      filled += 1;
    }
    assert!(filled > 0 && filled < 20_000, "the queue has a limit: {filled}");
    // The confirmation comes out first and arms the window: the first held post takes the slot it
    // freed, the second is refused and stays held.
    let confirmation = next_message().expect("the confirmation");
    assert_eq!(confirmation.0.message, WM_STILL_ALIVE);
    confirmation.dispatch();
    assert_eq!(window.target.lock().held, vec![(WM_APP + 9, 2, 0)], "the refused post stays held");
    // The next message the window gets (the first filler) sends the held post, behind the first.
    dispatch_waiting();
    assert_eq!(*seen.borrow(), vec![1, 2], "the refused post went out in order");
    assert!(poster.post(WM_APP + 9, 3, 0));
    pump_until(|| seen.borrow().len() == 3);
    assert_eq!(*seen.borrow(), vec![1, 2, 3]);
  }

  /// Timers that come due at the same wake tick in the order they came due, and those set in
  /// order for the same period in the order they were set (the third review's H5).
  #[test]
  fn timers_due_at_the_same_wake_tick_in_the_order_they_were_set() {
    let _serial = serial();
    let order: Rc<RefCell<Vec<TimerId>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = order.clone();
    let window = SignalWindow::new(move |signal| {
      if let Signal::Timer(timer) = signal {
        sink.borrow_mut().push(timer);
      }
    })
    .expect("signal window");
    for round in 0..20 {
      let set: Vec<TimerId> = (0..6).map(|_| window.set_timer(30).expect("timer")).collect();
      pump_until(|| order.borrow().len() >= set.len());
      for timer in &set {
        window.cancel_timer(*timer);
      }
      let first: Vec<TimerId> = order.borrow().iter().take(set.len()).copied().collect();
      assert_eq!(first, set, "round {round}: the first ticks came in the order the timers were set");
      dispatch_waiting();
      order.borrow_mut().clear();
    }
  }

  /// Dropping a window with a timer set waits for nothing, and its tick thread ends by itself
  /// (the third review's H2). A thread left to end does not tick beside the next one (H6).
  #[test]
  fn a_drop_waits_for_nothing_and_a_thread_left_to_end_does_not_tick_beside_its_successor() {
    let _serial = serial();
    let window = SignalWindow::new(|_| {}).expect("signal window");
    let _timer = window.set_timer(10).expect("timer");
    let returned = window.ticker.borrow().as_ref().map(|ticker| ticker.returned.clone()).expect("a tick thread");
    let started = Instant::now();
    drop(window);
    let took = started.elapsed();
    assert!(took < Duration::from_millis(50), "the drop waited {took:?}");
    let deadline = Instant::now() + Duration::from_secs(1);
    while !returned.load(Ordering::Acquire) && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(1));
    }
    assert!(returned.load(Ordering::Acquire), "the thread left to end returned by itself");

    let ticks: Rc<RefCell<Vec<(TimerId, Instant)>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = ticks.clone();
    let window = SignalWindow::new(move |signal| {
      if let Signal::Timer(timer) = signal {
        sink.borrow_mut().push((timer, Instant::now()));
      }
    })
    .expect("signal window");
    let timer = window.set_timer(50).expect("timer");
    let first = window.ticker.borrow().as_ref().map(|ticker| ticker.returned.clone()).expect("a tick thread");
    window.stop_ticker(Duration::ZERO);
    let _second = window.set_timer(1000).expect("a timer, on a new thread");
    let deadline = Instant::now() + Duration::from_secs(1);
    while !first.load(Ordering::Acquire) && Instant::now() < deadline {
      dispatch_waiting();
      std::thread::sleep(Duration::from_millis(1));
    }
    assert!(first.load(Ordering::Acquire), "the first thread ended");
    pump_until(|| ticks.borrow().iter().filter(|(t, _)| *t == timer).count() >= 6);
    let at: Vec<Instant> = ticks.borrow().iter().filter(|(t, _)| *t == timer).map(|(_, at)| *at).collect();
    assert!(at.len() >= 6, "{} ticks", at.len());
    for pair in at.windows(2) {
      let gap = pair[1].duration_since(pair[0]);
      assert!(gap >= Duration::from_millis(40), "one thread ticks the 50 ms timer: a gap of {gap:?}");
    }
  }

  /// The stale owner's post target and a count of its closure's calls.
  type Planted = (Arc<PostTarget>, Rc<Cell<u32>>);

  thread_local! {
    /// What `plant_stale_entry` plants at the next window this thread makes.
    static PLANT: RefCell<Option<Planted>> = const { RefCell::new(None) };
  }

  /// A `WH_CBT` hook that, when the next window of this thread is being made, plants under its
  /// handle value the entry a window destroyed earlier under that value would have left.
  extern "system" fn plant_stale_entry(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HCBT_CREATEWND as i32 {
      if let Some((target, calls)) = PLANT.with(|plant| plant.borrow_mut().take()) {
        let value = wparam.0 as isize;
        {
          let mut stale = target.lock();
          stale.hwnd = value;
          stale.ending = true;
        }
        let procedure: Procedure = Rc::new(move |_, _, _| {
          calls.set(calls.get() + 1);
          None
        });
        PROCEDURES.with(|procedures| procedures.borrow_mut().insert(value, Entry { procedure, target }));
      }
    }
    // SAFETY: passes the hook's own arguments on, as every hook procedure does.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
  }

  /// A table entry left by a window destroyed earlier under the handle value a new window gets is
  /// forgotten at the new window's `WM_NCCREATE`, before anything of the new window runs: its
  /// closure is never called, its owner is disarmed, and that owner's drop leaves the new window
  /// alone (the third review's H3).
  #[test]
  fn a_stale_entry_under_a_new_windows_handle_value_is_forgotten_at_its_creation() {
    let _serial = serial();
    let stale = Arc::new(PostTarget::new(HWND(std::ptr::null_mut())));
    let calls = Rc::new(Cell::new(0u32));
    PLANT.with(|plant| *plant.borrow_mut() = Some((stale.clone(), calls.clone())));
    // SAFETY: `GetCurrentThreadId` takes nothing.
    let thread = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    // SAFETY: a thread hook of this thread with a procedure of this module; removed below.
    let hook = unsafe { SetWindowsHookExW(WH_CBT, Some(plant_stale_entry), None, thread) }.expect("hook");
    let seen = Rc::new(Cell::new(0u32));
    let sink = seen.clone();
    let made = MessageWindow::new("SweetviewLoopStaleTest", "sweetview.stale-test", move |message, _, _| {
      (message == WM_APP + 9).then(|| {
        sink.set(sink.get() + 1);
        0
      })
    });
    // SAFETY: the hook set above.
    let _ = unsafe { UnhookWindowsHookEx(hook) };
    let window = made.expect("message window");
    assert!(PLANT.with(|plant| plant.borrow().is_none()), "the stale entry was planted under the new window's handle value");
    assert_eq!(calls.get(), 0, "the stale closure never ran for the new window");
    assert_eq!(stale.lock().hwnd, 0, "the stale owner is disarmed");
    let hwnd = lent_hwnd(&window);
    assert!(PROCEDURES.with(|p| p.borrow().get(&(hwnd.0 as isize)).is_some_and(|entry| Arc::ptr_eq(&entry.target, &window.target))));
    // The stale owner goes, as its owner's `Drop` would run: the new window is left alone.
    *classes().entry("SweetviewLoopStaleTest".into()).or_insert(0) += 1;
    drop(MessageWindow { hwnd, class: "SweetviewLoopStaleTest".into(), target: stale, _not_send: PhantomData });
    assert!(names_a_window(hwnd), "the new window is alive");
    assert!(window.poster().post(WM_APP + 9, 0, 0));
    pump_until(|| seen.get() == 1);
    assert_eq!(seen.get(), 1, "and works");
  }

  /// A class of the same name that other code registered with its own
  /// procedure is not taken over.
  #[test]
  fn a_class_registered_with_another_procedure_is_refused() {
    let _serial = serial();
    extern "system" fn other_procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
      // SAFETY: the arguments are the ones the OS passed to this window procedure.
      unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }
    let module = this_module().expect("module");
    let name = HSTRING::from("SweetviewLoopForeignClass");
    let class = WNDCLASSEXW {
      cbSize: size_of::<WNDCLASSEXW>() as u32,
      lpfnWndProc: Some(other_procedure),
      hInstance: module.into(),
      lpszClassName: PCWSTR(name.as_ptr()),
      ..Default::default()
    };
    // SAFETY: a fully initialised WNDCLASSEXW owned by this frame; `name` outlives the call.
    assert_ne!(unsafe { RegisterClassExW(&class) }, 0);
    let refused = MessageWindow::new("SweetviewLoopForeignClass", "sweetview.foreign", |_, _, _| None);
    assert!(refused.as_ref().is_err_and(|e| e.call() == "RegisterClassExW"), "{:?}", refused.err());
    unregister_class(module, &name);
  }
}
