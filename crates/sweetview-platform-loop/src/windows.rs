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
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GetProcessHandleCount, GR_GDIOBJECTS, GR_USEROBJECTS};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClassInfoExW, GetMessageW, InSendMessageEx, IsWindow, PeekMessageW,
  PostMessageW, PostQuitMessage, RegisterClassExW, TranslateMessage, UnregisterClassW, HWND_MESSAGE, ISMEX_SEND, MSG,
  PEEK_MESSAGE_REMOVE_TYPE, PM_NOREMOVE, PM_NOYIELD, PM_QS_INPUT, PM_QS_POSTMESSAGE, PM_QS_SENDMESSAGE, PM_REMOVE, WINDOW_EX_STYLE,
  WINDOW_STYLE, WM_APP, WM_CLOSE, WM_NCDESTROY, WM_QUIT, WNDCLASSEXW, WNDPROC,
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
/// before destroying the window, and so does the window procedure when it
/// learns that other code destroyed it.
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

  /// The window procedure got a message for `hwnd` after a `WM_NCDESTROY`, so
  /// the window is alive: arm it again and send what was held.
  fn still_alive(&self, hwnd: HWND) {
    let mut target = self.lock();
    if !target.ending || target.hwnd != hwnd.0 as isize {
      return;
    }
    target.ending = false;
    for (message, wparam, lparam) in std::mem::take(&mut target.held) {
      // SAFETY: as in `begin_ending`: `hwnd` is the window whose procedure is running this call.
      let posted = unsafe { PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(lparam)) };
      let _ = posted;
    }
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
    // SAFETY: `target.hwnd` is non-zero and not `ending` only while the window exists: it is
    // zeroed before the owner destroys the window, and marked `ending` by the window procedure
    // on any `WM_NCDESTROY` of the window's thread, which `DestroyWindow` sends before the handle
    // is given up, all under this lock, which is held for the whole call. The parameters are
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
    // SAFETY: the class and window names are HSTRINGs alive for the whole call, no
    // creation parameter is passed, and HWND_MESSAGE makes a message-only window
    // with no parent to keep alive. Messages sent during creation find no entry
    // in `PROCEDURES` yet and go to `DefWindowProcW`.
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
    // `live_hwnd` just read it from the post target, which the window procedure zeroes
    // on `WM_NCDESTROY` whoever destroys the window, so it names this value's window
    // now; this value destroys it only in `Drop`, which the borrow of `&self` excludes.
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
      // value up, and a marked one counts only when the window's own `WM_STILL_ALIVE` is
      // still queued for it, so its handle value has not been given to another window. It
      // is not used again after this call.
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
    // timer procedure only when this thread registered it with `SetTimer` (measured, D38).
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

/// The message a timer's tick posts. `wParam` carries the timer's id.
const WM_SWEETVIEW_TICK: u32 = WM_APP + 0x54;

/// The shortest period a timer gets, as `SetTimer` gives (`USER_TIMER_MINIMUM`).
const SHORTEST_PERIOD_MS: u32 = 10;
/// The longest period a timer gets, as `SetTimer` gives (`USER_TIMER_MAXIMUM`).
const LONGEST_PERIOD_MS: u32 = 0x7FFF_FFFF;

/// One timer of a [`SignalWindow`], as its tick thread keeps it.
struct Schedule {
  period: Duration,
  /// When the next tick is due.
  next: Instant,
  /// A tick was posted and the UI thread has not taken it yet: no second one is posted, so a
  /// timer that comes due while the thread is busy delivers once, as a `WM_TIMER` does.
  outstanding: bool,
}

/// The timers of one [`SignalWindow`], shared between the UI thread and the tick thread.
#[derive(Default)]
struct Ticks {
  state: Mutex<TickState>,
  changed: Condvar,
}

#[derive(Default)]
struct TickState {
  timers: HashMap<usize, Schedule>,
  stop: bool,
}

impl Ticks {
  fn lock(&self) -> MutexGuard<'_, TickState> {
    self.state.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// The UI thread took the tick of timer `id`. True while that timer is set: a tick posted
  /// before the timer was cancelled finds none and is dropped.
  fn take_tick(&self, id: usize) -> bool {
    match self.lock().timers.get_mut(&id) {
      Some(timer) => {
        timer.outstanding = false;
        true
      }
      None => false,
    }
  }
}

/// The tick thread's body: posts each timer's tick to the signal window when it comes due, until
/// told to stop. Posting never blocks, so the lock is held only for moments.
fn post_ticks(ticks: &Ticks, poster: &Poster) {
  let mut state = ticks.lock();
  while !state.stop {
    let now = Instant::now();
    let mut earliest: Option<Instant> = None;
    for (id, timer) in &mut state.timers {
      if timer.next <= now {
        if !timer.outstanding && poster.post(WM_SWEETVIEW_TICK, *id, 0) {
          timer.outstanding = true;
        }
        // As a native timer counts: the next period starts when this one ended, and one that
        // was missed altogether is not made up.
        timer.next += timer.period;
        if timer.next <= now {
          timer.next = now + timer.period;
        }
      }
      earliest = Some(earliest.map_or(timer.next, |at| at.min(timer.next)));
    }
    state = match earliest {
      Some(at) => ticks.changed.wait_timeout(state, at.saturating_duration_since(now)).unwrap_or_else(PoisonError::into_inner).0,
      None => ticks.changed.wait(state).unwrap_or_else(PoisonError::into_inner),
    };
  }
}

/// A message-only window owned by the UI thread. Dropping it stops its tick
/// thread, destroys the window and disarms every [`Waker`] made from it.
///
/// Its timers do not use `SetTimer`. A `WM_TIMER` is made only when the
/// thread's queue holds nothing else, after every paint request, and a modal
/// loop such as a popup menu's can wait with one already due and never take it
/// (D37). Each tick is instead a message posted to the window by a thread of
/// this value's own; posted messages come before input, paint and `WM_TIMER`,
/// and wake any loop that waits for new messages.
pub struct SignalWindow {
  next_timer: Cell<usize>,
  ticks: Arc<Ticks>,
  /// The thread that posts the ticks, started with the first timer and joined in `Drop`.
  ticker: RefCell<Option<std::thread::JoinHandle<()>>>,
  window: MessageWindow,
}

impl SignalWindow {
  /// Makes the window. `handler` runs on this thread for every signal, from
  /// inside whichever message loop dispatched it. A handler that panics is
  /// caught; the signal is dropped.
  pub fn new(handler: impl Fn(Signal) + 'static) -> Result<Self, SignalError> {
    let ticks = Arc::new(Ticks::default());
    let taken = ticks.clone();
    let window = MessageWindow::new("SweetviewSignalWindow", "sweetview.signal", move |message, wparam, _lparam| {
      let signal = match message {
        WM_SWEETVIEW_WAKE => Signal::Wake(wparam as u64),
        WM_SWEETVIEW_TICK if taken.take_tick(wparam) => Signal::Timer(TimerId(wparam)),
        WM_SWEETVIEW_TICK => return Some(0),
        _ => return None,
      };
      handler(signal);
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
  /// above, as `SetTimer` holds it.
  pub fn set_timer(&self, interval_ms: u32) -> Result<TimerId, SignalError> {
    if self.window.live_hwnd().is_none() {
      return Err(SignalError("a timer could not be set: the signal window is gone".into()));
    }
    self.start_ticker()?;
    let id = self.next_timer.get();
    self.next_timer.set(id.wrapping_add(1).max(1));
    let period = Duration::from_millis(u64::from(interval_ms.clamp(SHORTEST_PERIOD_MS, LONGEST_PERIOD_MS)));
    let schedule = Schedule { period, next: Instant::now() + period, outstanding: false };
    self.ticks.lock().timers.insert(id, schedule);
    self.ticks.changed.notify_all();
    Ok(TimerId(id))
  }

  fn start_ticker(&self) -> Result<(), SignalError> {
    let mut ticker = self.ticker.borrow_mut();
    if ticker.is_none() {
      let (ticks, poster) = (self.ticks.clone(), self.window.poster());
      let thread = std::thread::Builder::new()
        .name("sweetview-timers".into())
        .spawn(move || post_ticks(&ticks, &poster))
        .map_err(|e| SignalError(format!("a timer could not be set: its thread did not start: {e}")))?;
      *ticker = Some(thread);
    }
    Ok(())
  }

  /// Cancels a timer. Cancelling one that is not set does nothing. A
  /// cancelled timer delivers nothing more, a tick already posted included.
  pub fn cancel_timer(&self, timer: TimerId) {
    self.ticks.lock().timers.remove(&timer.0);
  }

  /// Delivers the ticks that are waiting now, ahead of anything else in the
  /// thread's queue. A pump calls this after each burst, so a tick posted while
  /// the burst was ending is not left for the next one.
  pub fn dispatch_due_timers(&self) {
    // Bounded: a handler that keeps timers due cannot hold the caller here.
    for _ in 0..64 {
      let Some(message) = peek(Some(&self.window), WM_SWEETVIEW_TICK, WM_SWEETVIEW_TICK, PM_REMOVE) else { break };
      message.dispatch();
    }
  }

  /// How many timers are set. For tests that check nothing is left running.
  #[doc(hidden)]
  pub fn timers_set_for_tests(&self) -> usize {
    self.ticks.lock().timers.len()
  }

  /// True while the tick thread runs. For tests of the release at the end of the application.
  #[doc(hidden)]
  pub fn ticker_running_for_tests(&self) -> bool {
    self.ticker.borrow().is_some()
  }

  /// Ends the tick thread when no timer is set, as the release at the end of the
  /// application leaves it; the next timer starts a new one.
  pub fn stop_ticker_if_idle(&self) {
    if !self.ticks.lock().timers.is_empty() {
      return;
    }
    self.stop_ticker();
  }

  fn stop_ticker(&self) {
    let Some(thread) = self.ticker.borrow_mut().take() else { return };
    self.ticks.lock().stop = true;
    self.ticks.changed.notify_all();
    // The thread only posts and waits on the lock; it ends at once.
    let _ = thread.join();
    self.ticks.lock().stop = false;
  }
}

impl Drop for SignalWindow {
  fn drop(&mut self) {
    self.ticks.lock().timers.clear();
    self.stop_ticker();
    // `self.window` is dropped next: it disarms the wakers and destroys the window.
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::testing::assert_gives_back_every_handle;
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
    window.dispatch_due_timers();
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
