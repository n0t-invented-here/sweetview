//! Notifications on Windows: WinRT toasts, with a balloon on a hidden
//! notification-area icon as the fallback.
//!
//! WinRT raises a toast's events on one of its own threads. The event handlers
//! only post `WM_TOAST_EVENT` to the notifier's message-only window, so the
//! click and the fallback run on the notifier's thread, from whichever message
//! loop that thread is in. The shell posts balloon events to the same window.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use windows::core::{w, Ref, RuntimeType, HSTRING, PCWSTR};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
  ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager, ToastNotifier,
};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HWND, LPARAM, LRESULT, RPC_E_CHANGED_MODE, WPARAM};
use windows::Win32::System::Com::CoIncrementMTAUsage;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::{
  RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_WRITE,
  REG_OPTION_NON_VOLATILE, REG_SAM_FLAGS, REG_SZ, RRF_RT_ANY,
};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED};
use windows::Win32::UI::Shell::{
  Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_STATE, NIF_TIP, NIIF_INFO, NIIF_LARGE_ICON, NIIF_NOSOUND,
  NIIF_RESPECT_QUIET_TIME, NIIF_USER, NIM_ADD, NIM_DELETE, NIN_BALLOONHIDE, NIN_BALLOONTIMEOUT, NIN_BALLOONUSERCLICK,
  NIS_HIDDEN, NOTIFYICONDATAW, NOTIFY_ICON_INFOTIP_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateIconFromResourceEx, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, GetSystemMetrics, LoadIconW,
  PostMessageW, RegisterClassExW, HICON, HWND_MESSAGE, IDI_APPLICATION, LR_DEFAULTCOLOR, SM_CXICON, SM_CXSMICON,
  SYSTEM_METRICS_INDEX, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_CLOSE, WNDCLASSEXW,
};

use crate::toast_xml::{app_id_key, display_name, toast_xml, validate_app_id};
use crate::{ico, BalloonEvent, ForcedPath, Notification, NotifierOptions, NotifyError, Shown, ToastEvent};

/// The shell's balloon events, as today: `wParam` is the icon's uID, the low
/// word of `lParam` the event.
const WM_NOTIFIER: u32 = WM_APP + 2;
/// A toast event: `wParam` is the cookie, `lParam` the event (0 dismissed,
/// 1 activated, 2 failed), as today.
const WM_TOAST_EVENT: u32 = WM_APP + 3;

/// Toast cookies are process-wide and start at 1, as today.
static NEXT_COOKIE: AtomicU64 = AtomicU64::new(1);
/// Balloon icon uIDs are process-wide and start at 10000, as today.
static NEXT_BALLOON_UID: AtomicU32 = AtomicU32::new(10_000);
/// Toast event handlers alive in the process; see [`live_toast_handlers`].
static LIVE_HANDLERS: AtomicUsize = AtomicUsize::new(0);

/// How many toast event handlers exist in the process. A handler lives while
/// WinRT holds its subscription or a pending toast keeps it for
/// [`Notifier::simulate_toast_event`]; a test asserts it returns to zero once
/// every notifier is gone.
pub fn live_toast_handlers() -> usize {
  LIVE_HANDLERS.load(Ordering::SeqCst)
}

fn event_code(event: ToastEvent) -> isize {
  match event {
    ToastEvent::Dismissed => 0,
    ToastEvent::Activated => 1,
    ToastEvent::Failed => 2,
  }
}

fn hresult_error(method: &str) -> impl Fn(windows::core::Error) -> NotifyError + '_ {
  move |error| NotifyError(format!("sweetview: {method} failed (0x{:x})", error.code().0 as u32))
}

fn last_error() -> i32 {
  std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// Copies `value` into a fixed wide-character field, truncated so the NUL still
/// fits, as today's `setWide` does.
fn copy_wide(field: &mut [u16], value: &str) {
  let room = field.len().saturating_sub(1);
  let mut written = 0;
  for (slot, unit) in field.iter_mut().zip(value.encode_utf16().take(room)) {
    *slot = unit;
    written += 1;
  }
  field[written..].fill(0);
}

// ---- the post target ---------------------------------------------------------

/// The window handle value toast handlers post to. Zero once the window is
/// destroyed. The lock is held across both the post and the destroy, so a
/// handler on a WinRT thread never posts to a handle that was destroyed and
/// reused.
struct PostTarget(Mutex<isize>);

impl PostTarget {
  fn post(&self, message: u32, wparam: usize, lparam: isize) -> bool {
    let target = self.0.lock().unwrap_or_else(PoisonError::into_inner);
    if *target == 0 {
      return false;
    }
    let hwnd = HWND(*target as *mut core::ffi::c_void);
    // SAFETY: `*target` is non-zero only while the `NotifyWindow` that owns the window is
    // alive; its `Drop` zeroes it under this same lock before destroying the window, and
    // the lock is held for the whole call.
    let posted = unsafe { PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(lparam)) };
    posted.is_ok()
  }
}

/// Counts itself in [`LIVE_HANDLERS`] while a toast handler holds it.
struct HandlerLife;

impl HandlerLife {
  fn new() -> Self {
    LIVE_HANDLERS.fetch_add(1, Ordering::SeqCst);
    HandlerLife
  }
}

impl Drop for HandlerLife {
  fn drop(&mut self) {
    LIVE_HANDLERS.fetch_sub(1, Ordering::SeqCst);
  }
}

/// A toast event handler's body: post the cookie and the event to the owner.
/// It runs on a WinRT thread and must never unwind into WinRT.
fn poster<S: RuntimeType + 'static, R: RuntimeType + 'static>(
  target: Arc<PostTarget>,
  cookie: u64,
  event: ToastEvent,
) -> impl Fn(Ref<S>, Ref<R>) -> windows::core::Result<()> + Send + 'static {
  let life = HandlerLife::new();
  move |_sender, _args| {
    let _alive = &life;
    let _ = catch_unwind(AssertUnwindSafe(|| target.post(WM_TOAST_EVENT, cookie as usize, event_code(event))));
    Ok(())
  }
}

// ---- icons -------------------------------------------------------------------

/// An icon for the balloon: one this notifier made from `.ico` bytes and
/// destroys, or the stock application icon, which the system shares for the
/// life of the process and which is never destroyed.
struct BalloonIcon {
  handle: HICON,
  owned: bool,
}

impl BalloonIcon {
  fn load(ico_bytes: Option<&[u8]>, metric: SYSTEM_METRICS_INDEX) -> Self {
    if let Some(bytes) = ico_bytes {
      // SAFETY: GetSystemMetrics takes an index by value and reads no memory of ours.
      let measured = unsafe { GetSystemMetrics(metric) };
      let want = if measured > 0 { measured } else if metric == SM_CXICON { 32 } else { 16 };
      let entry = ico::parse_ico(bytes).and_then(|entries| ico::pick_entry(&entries, want as u32));
      match entry {
        Ok(entry) => {
          let bits = &bytes[entry.offset..entry.offset + entry.size];
          // SAFETY: `bits` is a slice of the caller's buffer, which `parse_ico` checked holds
          // the whole image; the call reads it and keeps no reference to it.
          let created = unsafe { CreateIconFromResourceEx(bits, true, 0x0003_0000, want, want, LR_DEFAULTCOLOR) };
          match created {
            Ok(handle) => return BalloonIcon { handle, owned: true },
            Err(error) => {
              eprintln!("sweetview: CreateIconFromResourceEx failed ({}); using the default icon", error.code().0 & 0xffff)
            }
          }
        }
        Err(error) => eprintln!("sweetview: {error}; using the default icon"),
      }
    }
    // SAFETY: IDI_APPLICATION is a predefined resource id and no module is passed, so the
    // shared system icon is returned; nothing of ours is read.
    let stock = unsafe { LoadIconW(None, IDI_APPLICATION) };
    BalloonIcon { handle: stock.unwrap_or_default(), owned: false }
  }
}

impl Drop for BalloonIcon {
  fn drop(&mut self) {
    if self.owned {
      // SAFETY: `self.handle` was made by CreateIconFromResourceEx for this value alone
      // (`owned`), and the shell no longer uses it: its icon is deleted first.
      let destroyed = unsafe { DestroyIcon(self.handle) };
      let _ = destroyed;
    }
  }
}

/// A balloon on screen: its icons and the notification its click reports.
struct Balloon {
  notification: Notification,
  _small: BalloonIcon,
  _large: BalloonIcon,
}

// ---- the window --------------------------------------------------------------

thread_local! {
  /// The notifier of each live notifier window of this thread, by handle value.
  static NOTIFIERS: RefCell<HashMap<isize, Weak<Inner>>> = RefCell::new(HashMap::new());
}

/// The notifier's message-only window and the notification-area icons it owns.
/// Dropping it deletes every icon, disarms the toast handlers and destroys the
/// window.
struct NotifyWindow {
  hwnd: HWND,
  target: Arc<PostTarget>,
  balloons: RefCell<HashMap<u32, Balloon>>,
}

impl NotifyWindow {
  fn new(owner: Weak<Inner>) -> Result<Self, NotifyError> {
    // SAFETY: a null module name asks for the handle of the process's own executable; no pointer is passed.
    let module = unsafe { GetModuleHandleW(None) }.map_err(hresult_error("GetModuleHandleW"))?;
    let class_name = w!("SweetviewNotifierWindow");
    let class = WNDCLASSEXW {
      cbSize: size_of::<WNDCLASSEXW>() as u32,
      lpfnWndProc: Some(notifier_proc),
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
        w!("sweetview.notifier"),
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
    let hwnd = created.map_err(|e| NotifyError(format!("sweetview: CreateWindowExW failed ({})", e.code().0 & 0xffff)))?;
    NOTIFIERS.with(|map| map.borrow_mut().insert(hwnd.0 as isize, owner));
    Ok(Self { hwnd, target: Arc::new(PostTarget(Mutex::new(hwnd.0 as isize))), balloons: RefCell::new(HashMap::new()) })
  }

  fn show_balloon(&self, notification: &Notification, icon: Option<&[u8]>) -> Option<u32> {
    let uid = NEXT_BALLOON_UID.fetch_add(1, Ordering::SeqCst);
    let small = BalloonIcon::load(icon, SM_CXSMICON);
    let large = BalloonIcon::load(icon, SM_CXICON);
    let own_icon = large.owned;
    let mut info_flags = if own_icon { NIIF_USER | NIIF_LARGE_ICON } else { NIIF_INFO };
    info_flags |= NIIF_RESPECT_QUIET_TIME;
    if notification.silent {
      info_flags |= NIIF_NOSOUND;
    }
    let mut data = NOTIFYICONDATAW {
      cbSize: size_of::<NOTIFYICONDATAW>() as u32,
      hWnd: self.hwnd,
      uID: uid,
      uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_STATE | NIF_INFO,
      uCallbackMessage: WM_NOTIFIER,
      hIcon: small.handle,
      dwState: NIS_HIDDEN,
      dwStateMask: NIS_HIDDEN,
      dwInfoFlags: NOTIFY_ICON_INFOTIP_FLAGS(info_flags.0),
      hBalloonIcon: if own_icon { large.handle } else { HICON::default() },
      ..Default::default()
    };
    copy_wide(&mut data.szTip, &notification.title);
    copy_wide(&mut data.szInfo, &notification.body);
    copy_wide(&mut data.szInfoTitle, &notification.title);
    // SAFETY: `data` is a fully initialised NOTIFYICONDATAW that outlives the call; its
    // window is `self.hwnd`, owned by this value, and its icons are owned by `small` and
    // `large`, which the balloon keeps until its icon is deleted.
    let added = unsafe { Shell_NotifyIconW(NIM_ADD, &data) };
    if !added.as_bool() {
      eprintln!("sweetview: Shell_NotifyIcon notification failed ({})", last_error());
      return None;
    }
    let balloon = Balloon { notification: notification.clone(), _small: small, _large: large };
    self.balloons.borrow_mut().insert(uid, balloon);
    Some(uid)
  }

  /// Deletes a balloon's icon and hands back the balloon.
  fn remove_balloon(&self, uid: u32) -> Option<Balloon> {
    let balloon = self.balloons.borrow_mut().remove(&uid)?;
    self.delete_icon(uid);
    Some(balloon)
  }

  fn delete_icon(&self, uid: u32) {
    let data = NOTIFYICONDATAW { cbSize: size_of::<NOTIFYICONDATAW>() as u32, hWnd: self.hwnd, uID: uid, ..Default::default() };
    // SAFETY: `data` is a fully initialised NOTIFYICONDATAW that outlives the call, naming
    // `self.hwnd`, which this value owns.
    let deleted = unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
    let _ = deleted;
  }
}

impl Drop for NotifyWindow {
  fn drop(&mut self) {
    for (uid, balloon) in self.balloons.take() {
      self.delete_icon(uid);
      drop(balloon);
    }
    {
      // Disarm the toast handlers first, under the lock a post holds.
      let mut target = self.target.0.lock().unwrap_or_else(PoisonError::into_inner);
      *target = 0;
    }
    // `try_with`: a notifier kept in thread-local storage is dropped while the thread's
    // storage is being torn down, when the table may already be gone.
    let _ = NOTIFIERS.try_with(|map| map.borrow_mut().remove(&(self.hwnd.0 as isize)));
    // SAFETY: `self.hwnd` was created by `new` on this thread (the owning `Notifier` is not
    // `Send`), is owned by this value alone, and is not used again after this call.
    let destroyed = unsafe { DestroyWindow(self.hwnd) };
    let _ = destroyed;
  }
}

/// The window procedure of every notifier window. Called by the OS; never unwinds.
extern "system" fn notifier_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  if message == WM_TOAST_EVENT || message == WM_NOTIFIER {
    // A panic must not cross into the OS: it is caught and the message counts as handled.
    let _ = catch_unwind(AssertUnwindSafe(|| {
      // The notifier is upgraded out of the table first, so it may be dropped from inside the call.
      let owner = NOTIFIERS.try_with(|map| map.borrow().get(&(hwnd.0 as isize)).and_then(Weak::upgrade)).ok().flatten();
      if let Some(inner) = owner {
        inner.handle_message(message, wparam, lparam);
      }
    }));
    return LRESULT(0);
  }
  if message == WM_CLOSE {
    // Only the owner tears this window down; an external WM_CLOSE is ignored.
    return LRESULT(0);
  }
  // SAFETY: the arguments are the ones the OS passed to this window procedure for this message.
  unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

// ---- WinRT -------------------------------------------------------------------

/// Keeps the process's COM alive for as long as the process runs, once.
///
/// `windows` caches agile activation factories in statics for the process.
/// Today's notifier balances `RoInitialize` with `RoUninitialize`; without a
/// process-wide reference, the last uninitialise would let COM unload the
/// modules those cached factories live in.
fn keep_com_loaded() {
  static DONE: OnceLock<()> = OnceLock::new();
  DONE.get_or_init(|| {
    // SAFETY: CoIncrementMTAUsage takes no arguments; the cookie it returns is deliberately
    // never passed to CoDecrementMTAUsage, so the reference lasts for the process.
    let cookie = unsafe { CoIncrementMTAUsage() };
    let _ = cookie;
  });
}

/// A balanced `RoInitialize` on this thread, as today's notifier makes.
struct RoInit {
  uninitialize: bool,
  _not_send: std::marker::PhantomData<*const ()>,
}

impl RoInit {
  fn new() -> Result<Self, NotifyError> {
    // SAFETY: RoInitialize takes its apartment type by value; the matching RoUninitialize
    // runs in this value's `Drop` on the same thread, which `_not_send` guarantees.
    let status = unsafe { RoInitialize(RO_INIT_SINGLETHREADED) };
    match status {
      Ok(()) => Ok(Self { uninitialize: true, _not_send: std::marker::PhantomData }),
      // An existing MTA is usable with agile handlers. Its owner balances it.
      Err(error) if error.code() == RPC_E_CHANGED_MODE => Ok(Self { uninitialize: false, _not_send: std::marker::PhantomData }),
      Err(error) => Err(hresult_error("RoInitialize")(error)),
    }
  }
}

impl Drop for RoInit {
  fn drop(&mut self) {
    if self.uninitialize {
      // SAFETY: balances the successful RoInitialize of `new`, on the same thread.
      unsafe { RoUninitialize() };
    }
  }
}

/// A registry key this value opened and closes.
struct OwnedKey(HKEY);

impl OwnedKey {
  fn create(sub_key: &str, access: REG_SAM_FLAGS) -> Result<Self, NotifyError> {
    let name = HSTRING::from(sub_key);
    let mut key = HKEY::default();
    // SAFETY: `name` is a NUL-terminated wide string that outlives the call, and `key` is a
    // valid HKEY for the call to fill; no class, security attributes or disposition are passed.
    let status = unsafe {
      RegCreateKeyExW(HKEY_CURRENT_USER, &name, None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, access, None, &mut key, None)
    };
    if status != ERROR_SUCCESS {
      return Err(NotifyError(format!("sweetview: RegCreateKeyExW({sub_key}) failed ({})", status.0)));
    }
    Ok(Self(key))
  }
}

impl Drop for OwnedKey {
  fn drop(&mut self) {
    // SAFETY: `self.0` was opened by `create` for this value alone and is not used again.
    let closed = unsafe { RegCloseKey(self.0) };
    let _ = closed;
  }
}

/// Registers the AUMID under `HKCU\Software\Classes\AppUserModelId`. A
/// `DisplayName` is written only when the key has none, so names and icons an
/// installer set are kept.
fn register_app_id(app_id: &str, display: &str) -> Result<(), NotifyError> {
  validate_app_id(app_id)?;
  let key = OwnedKey::create(&app_id_key(app_id), KEY_WRITE | KEY_QUERY_VALUE)?;
  let mut size = 0u32;
  // SAFETY: `key` is open for this call's duration, the value name is a static string, and
  // `size` is a valid u32 for the call to fill; no data buffer is passed.
  let existing = unsafe { RegGetValueW(key.0, PCWSTR::null(), w!("DisplayName"), RRF_RT_ANY, None, None, Some(&mut size)) };
  if existing == ERROR_FILE_NOT_FOUND {
    let bytes: Vec<u8> = display.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
    // SAFETY: `key` is open for this call's duration, the value name is a static string,
    // and the data is a slice whose length the call takes from the slice.
    let written = unsafe { RegSetValueExW(key.0, w!("DisplayName"), None, REG_SZ, Some(&bytes)) };
    if written != ERROR_SUCCESS {
      return Err(NotifyError(format!("sweetview: RegSetValueExW(DisplayName) failed ({})", written.0)));
    }
  } else if existing != ERROR_SUCCESS {
    return Err(NotifyError(format!("sweetview: RegGetValueW(DisplayName) failed ({})", existing.0)));
  }
  Ok(())
}

/// One event subscription of a toast: its token and the handler, kept so a
/// test can invoke the handler WinRT holds.
enum Subscription {
  Dismissed(i64, TypedEventHandler<ToastNotification, ToastDismissedEventArgs>),
  Activated(i64, TypedEventHandler<ToastNotification, windows::core::IInspectable>),
  Failed(i64, TypedEventHandler<ToastNotification, ToastFailedEventArgs>),
}

struct PendingToast {
  toast: ToastNotification,
  subscriptions: Vec<Subscription>,
  notification: Notification,
}

/// The WinRT half: a toast notifier for the AUMID, and the toasts it shows
/// that have not reported an event yet.
struct Toasts {
  notifier: ToastNotifier,
  pending: RefCell<HashMap<u64, PendingToast>>,
  disposed: Cell<bool>,
  /// Declared last so it is dropped after the notifier is released.
  _ro: RoInit,
}

impl Toasts {
  fn new(options: &NotifierOptions) -> Result<Self, NotifyError> {
    keep_com_loaded();
    let ro = RoInit::new()?;
    let app_id = crate::toast_xml::app_id(options.app_id.as_deref());
    register_app_id(app_id, display_name(options.app_id.as_deref(), options.app_name.as_deref()))?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
      .map_err(hresult_error("CreateToastNotifierWithId"))?;
    Ok(Self { notifier, pending: RefCell::new(HashMap::new()), disposed: Cell::new(false), _ro: ro })
  }

  fn show(&self, notification: &Notification, target: &Arc<PostTarget>, forced: ForcedPath) -> Result<u64, NotifyError> {
    let xml = toast_xml(&notification.id, &notification.title, &notification.body, notification.silent);
    let document = XmlDocument::new().map_err(hresult_error("RoActivateInstance(XmlDocument)"))?;
    document.LoadXml(&HSTRING::from(xml)).map_err(hresult_error("IXmlDocumentIO.LoadXml"))?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(hresult_error("CreateToastNotification"))?;
    let cookie = NEXT_COOKIE.fetch_add(1, Ordering::SeqCst);
    let entry = PendingToast { toast: toast.clone(), subscriptions: Vec::new(), notification: notification.clone() };
    self.pending.borrow_mut().insert(cookie, entry);
    let shown = self.subscribe_and_show(cookie, &toast, target, forced);
    if let Err(error) = shown {
      self.remove(cookie);
      return Err(error);
    }
    Ok(cookie)
  }

  fn subscribe_and_show(
    &self,
    cookie: u64,
    toast: &ToastNotification,
    target: &Arc<PostTarget>,
    forced: ForcedPath,
  ) -> Result<(), NotifyError> {
    let keep = |subscription: Subscription| {
      if let Some(entry) = self.pending.borrow_mut().get_mut(&cookie) {
        entry.subscriptions.push(subscription);
      }
    };
    let dismissed = TypedEventHandler::new(poster(target.clone(), cookie, ToastEvent::Dismissed));
    let token = toast.Dismissed(&dismissed).map_err(hresult_error("IToastNotification.add_Dismissed"))?;
    keep(Subscription::Dismissed(token, dismissed));
    let activated = TypedEventHandler::new(poster(target.clone(), cookie, ToastEvent::Activated));
    let token = toast.Activated(&activated).map_err(hresult_error("IToastNotification.add_Activated"))?;
    keep(Subscription::Activated(token, activated));
    let failed = TypedEventHandler::new(poster(target.clone(), cookie, ToastEvent::Failed));
    let token = toast.Failed(&failed).map_err(hresult_error("IToastNotification.add_Failed"))?;
    keep(Subscription::Failed(token, failed));
    if forced == ForcedPath::ToastShowFails {
      return Err(NotifyError("sweetview: IToastNotifier.Show failed (forced by ForcedPath::ToastShowFails)".into()));
    }
    if forced == ForcedPath::ToastHeld {
      return Ok(());
    }
    self.notifier.Show(toast).map_err(hresult_error("IToastNotifier.Show"))
  }

  /// Ends a toast's subscriptions (and hides it once disposed) and hands back its entry.
  fn remove(&self, cookie: u64) -> Option<PendingToast> {
    let entry = self.pending.borrow_mut().remove(&cookie)?;
    for subscription in &entry.subscriptions {
      let removed = match subscription {
        Subscription::Dismissed(token, _) => entry.toast.RemoveDismissed(*token),
        Subscription::Activated(token, _) => entry.toast.RemoveActivated(*token),
        Subscription::Failed(token, _) => entry.toast.RemoveFailed(*token),
      };
      let _ = removed;
    }
    if self.disposed.get() {
      let _ = self.notifier.Hide(&entry.toast);
    }
    Some(entry)
  }

  fn dispose(&self) {
    if self.disposed.replace(true) {
      return;
    }
    let cookies: Vec<u64> = self.pending.borrow().keys().copied().collect();
    for cookie in cookies {
      self.remove(cookie);
    }
  }

  /// Invokes the handler WinRT holds for `event`, if the toast is still subscribed.
  fn invoke(&self, cookie: u64, event: ToastEvent) -> bool {
    let handler = {
      let pending = self.pending.borrow();
      let Some(entry) = pending.get(&cookie) else { return false };
      entry
        .subscriptions
        .iter()
        .find(|s| {
          matches!(
            (s, event),
            (Subscription::Dismissed(..), ToastEvent::Dismissed)
              | (Subscription::Activated(..), ToastEvent::Activated)
              | (Subscription::Failed(..), ToastEvent::Failed)
          )
        })
        .map(|s| match s {
          Subscription::Dismissed(_, h) => Invocable::Dismissed(h.clone()),
          Subscription::Activated(_, h) => Invocable::Activated(h.clone()),
          Subscription::Failed(_, h) => Invocable::Failed(h.clone()),
        })
    };
    let Some(handler) = handler else { return false };
    let invoked = match handler {
      Invocable::Dismissed(h) => h.Invoke(None::<&ToastNotification>, None::<&ToastDismissedEventArgs>),
      Invocable::Activated(h) => h.Invoke(None::<&ToastNotification>, None::<&windows::core::IInspectable>),
      Invocable::Failed(h) => h.Invoke(None::<&ToastNotification>, None::<&ToastFailedEventArgs>),
    };
    invoked.is_ok()
  }
}

enum Invocable {
  Dismissed(TypedEventHandler<ToastNotification, ToastDismissedEventArgs>),
  Activated(TypedEventHandler<ToastNotification, windows::core::IInspectable>),
  Failed(TypedEventHandler<ToastNotification, ToastFailedEventArgs>),
}

// ---- the notifier ------------------------------------------------------------

enum ToastSlot {
  Untried,
  Unavailable,
  Ready(Rc<Toasts>),
}

/// The click handler: `(id, data_json)`.
type OnClick = Box<dyn Fn(&str, Option<&str>)>;

struct Inner {
  options: NotifierOptions,
  icon: RefCell<Option<Vec<u8>>>,
  on_click: OnClick,
  window: RefCell<Option<NotifyWindow>>,
  toasts: RefCell<ToastSlot>,
  forced: Cell<ForcedPath>,
  /// Balloons the shell accepted, over this notifier's whole life.
  balloons_shown: Cell<u32>,
  disposed: Cell<bool>,
}

impl Inner {
  fn toasts(&self) -> Option<Rc<Toasts>> {
    match &*self.toasts.borrow() {
      ToastSlot::Ready(toasts) => Some(toasts.clone()),
      _ => None,
    }
  }

  fn target(&self) -> Option<Arc<PostTarget>> {
    self.window.borrow().as_ref().map(|window| window.target.clone())
  }

  fn show(&self, notification: &Notification) -> Option<Shown> {
    if self.disposed.get() {
      return None;
    }
    let forced = self.forced.get();
    if forced != ForcedPath::BalloonOnly {
      let untried = matches!(&*self.toasts.borrow(), ToastSlot::Untried);
      if untried {
        // WinRT or per-user identity registration can be unavailable.
        let slot = match Toasts::new(&self.options) {
          Ok(toasts) => ToastSlot::Ready(Rc::new(toasts)),
          Err(_) => ToastSlot::Unavailable,
        };
        *self.toasts.borrow_mut() = slot;
      }
      if let (Some(toasts), Some(target)) = (self.toasts(), self.target()) {
        // A synchronous WinRT failure leaves the balloon responsible for delivery.
        if let Ok(cookie) = toasts.show(notification, &target, forced) {
          return Some(Shown::Toast(cookie));
        }
      }
    }
    self.show_balloon(notification).map(Shown::Balloon)
  }

  fn show_balloon(&self, notification: &Notification) -> Option<u32> {
    if self.disposed.get() {
      return None;
    }
    let icon = self.icon.borrow().clone();
    let window = self.window.borrow();
    let uid = window.as_ref()?.show_balloon(notification, icon.as_deref())?;
    self.balloons_shown.set(self.balloons_shown.get() + 1);
    Some(uid)
  }

  fn click(&self, notification: &Notification) {
    if self.disposed.get() {
      return;
    }
    let clicked = catch_unwind(AssertUnwindSafe(|| (self.on_click)(&notification.id, notification.data_json.as_deref())));
    if clicked.is_err() {
      eprintln!("sweetview: notification onClick threw: a panic in the click handler");
    }
  }

  fn handle_message(&self, message: u32, wparam: WPARAM, lparam: LPARAM) {
    if message == WM_TOAST_EVENT {
      let event = match lparam.0 {
        0 => ToastEvent::Dismissed,
        1 => ToastEvent::Activated,
        2 => ToastEvent::Failed,
        _ => return,
      };
      let Some(toasts) = self.toasts() else { return };
      let Some(entry) = toasts.remove(wparam.0 as u64) else { return };
      match event {
        ToastEvent::Activated => self.click(&entry.notification),
        ToastEvent::Failed => {
          // Shown from the event; its own success is not reported back, as today.
          let _ = self.show_balloon(&entry.notification);
        }
        ToastEvent::Dismissed => {}
      }
      return;
    }
    let uid = wparam.0 as u32;
    let event = (lparam.0 as u32) & 0xffff;
    if event == NIN_BALLOONUSERCLICK {
      // The window's borrow ends before the click, so the handler may drop the notifier.
      let balloon = self.window.borrow().as_ref().and_then(|window| window.remove_balloon(uid));
      if let Some(balloon) = balloon {
        self.click(&balloon.notification);
      }
    } else if event == NIN_BALLOONTIMEOUT || event == NIN_BALLOONHIDE {
      let balloon = self.window.borrow().as_ref().and_then(|window| window.remove_balloon(uid));
      drop(balloon);
    }
  }

  fn dispose(&self) {
    if self.disposed.replace(true) {
      return;
    }
    let toasts = std::mem::replace(&mut *self.toasts.borrow_mut(), ToastSlot::Unavailable);
    if let ToastSlot::Ready(toasts) = toasts {
      toasts.dispose();
    }
    let window = self.window.borrow_mut().take();
    drop(window);
  }
}

/// Shows notifications and reports clicks on them. Not `Send`, not `Sync`:
/// it belongs to the thread that made it, whose message loop delivers clicks.
/// Dropping it hides its pending toasts, ends their subscriptions, deletes its
/// hidden notification icons and destroys its window.
pub struct Notifier {
  inner: Rc<Inner>,
}

impl Notifier {
  /// Makes a notifier. `on_click(id, data_json)` runs on this thread, from its
  /// message loop, once per clicked notification. WinRT is first tried on the
  /// first [`notify`](Self::notify), as today.
  pub fn new(options: NotifierOptions, on_click: impl Fn(&str, Option<&str>) + 'static) -> Result<Notifier, NotifyError> {
    if let Some(bytes) = &options.icon_ico {
      validate_icon(bytes)?;
    }
    let inner = Rc::new(Inner {
      icon: RefCell::new(options.icon_ico.clone()),
      options,
      on_click: Box::new(on_click),
      window: RefCell::new(None),
      toasts: RefCell::new(ToastSlot::Untried),
      forced: Cell::new(ForcedPath::Auto),
      balloons_shown: Cell::new(0),
      disposed: Cell::new(false),
    });
    let window = NotifyWindow::new(Rc::downgrade(&inner))?;
    *inner.window.borrow_mut() = Some(window);
    Ok(Notifier { inner })
  }

  /// Shows a notification: a toast when WinRT is available and accepts it,
  /// else a balloon. True when either was handed to the OS.
  pub fn notify(&self, notification: &Notification) -> bool {
    self.show(notification).is_some()
  }

  /// [`notify`](Self::notify), reporting which path showed the notification.
  pub fn show(&self, notification: &Notification) -> Option<Shown> {
    self.inner.show(notification)
  }

  /// Replaces the `.ico` the balloon shows (today: the tray icon's, read at
  /// each balloon). `None` shows the stock application icon.
  pub fn set_icon_ico(&self, icon_ico: Option<Vec<u8>>) -> Result<(), NotifyError> {
    if let Some(bytes) = &icon_ico {
      validate_icon(bytes)?;
    }
    *self.inner.icon.borrow_mut() = icon_ico;
    Ok(())
  }

  /// Whether WinRT toasts are in use: false before the first notification,
  /// and after WinRT or the AUMID registration failed.
  pub fn toasts_available(&self) -> bool {
    self.inner.toasts().is_some()
  }

  /// Test hook: makes later notifications take a failure path. See [`ForcedPath`].
  pub fn force_path(&self, path: ForcedPath) {
    self.inner.forced.set(path);
  }

  /// Test hook: delivers a toast event as WinRT would. While the toast is
  /// subscribed, the handler WinRT holds is invoked, which posts the event to
  /// this notifier's window; the result is then true. Once the toast is no
  /// longer subscribed (it reported an event, or the notifier was disposed),
  /// the same message is posted directly, as a WinRT thread still inside the
  /// handler would, and the result is false. Either way the event arrives
  /// when this thread's message loop next runs.
  pub fn simulate_toast_event(&self, cookie: u64, event: ToastEvent) -> bool {
    if let Some(toasts) = self.inner.toasts() {
      if toasts.invoke(cookie, event) {
        return true;
      }
    }
    if let Some(target) = self.inner.target() {
      target.post(WM_TOAST_EVENT, cookie as usize, event_code(event));
    }
    false
  }

  /// Test hook: posts the message the shell posts for a balloon event. The
  /// event arrives when this thread's message loop next runs.
  pub fn simulate_balloon_event(&self, uid: u32, event: BalloonEvent) -> bool {
    let code = match event {
      BalloonEvent::Clicked => NIN_BALLOONUSERCLICK,
      BalloonEvent::TimedOut => NIN_BALLOONTIMEOUT,
      BalloonEvent::Hidden => NIN_BALLOONHIDE,
    };
    self.inner.target().is_some_and(|target| target.post(WM_NOTIFIER, uid as usize, code as isize))
  }

  /// Toasts shown that have not reported an event.
  pub fn pending_toasts(&self) -> usize {
    self.inner.toasts().map_or(0, |toasts| toasts.pending.borrow().len())
  }

  /// Balloons shown that have not been clicked, timed out or hidden.
  pub fn pending_balloons(&self) -> usize {
    self.inner.window.borrow().as_ref().map_or(0, |window| window.balloons.borrow().len())
  }

  /// Balloons the shell accepted since this notifier was made, whatever became
  /// of them since. A shell that shows no balloons (notifications turned off,
  /// a session with nobody at it) hides each one at once, so
  /// [`pending_balloons`](Self::pending_balloons) may never see it.
  pub fn balloons_shown(&self) -> u32 {
    self.inner.balloons_shown.get()
  }
}

impl Drop for Notifier {
  fn drop(&mut self) {
    self.inner.dispose();
  }
}

fn validate_icon(bytes: &[u8]) -> Result<(), NotifyError> {
  let entries = ico::parse_ico(bytes).map_err(|e| NotifyError(format!("sweetview: notifier icon: {e}")))?;
  ico::pick_entry(&entries, 16).map_err(|e| NotifyError(format!("sweetview: notifier icon: {e}")))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{Duration, Instant};
  use windows::Win32::System::Registry::RegDeleteTreeW;
  use windows::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GetProcessHandleCount, GR_GDIOBJECTS, GR_USEROBJECTS};
  use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, PeekMessageW, MSG, PM_REMOVE};

  fn serial() -> std::sync::MutexGuard<'static, ()> {
    crate::TEST_SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// Dispatches this thread's queued messages until `done` or a deadline.
  fn pump_until(done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
      pump();
      if done() || Instant::now() > deadline {
        return;
      }
      std::thread::sleep(Duration::from_millis(5));
    }
  }

  fn pump() {
    let mut message = MSG::default();
    // SAFETY: `message` is a valid MSG for the call to fill.
    while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
      // SAFETY: `message` was filled by PeekMessageW just above.
      unsafe { DispatchMessageW(&message) };
    }
  }

  fn counts() -> (u32, u32, u32) {
    // SAFETY: the pseudo-handle of the current process is always valid.
    let process = unsafe { GetCurrentProcess() };
    // SAFETY: `process` is the current process's pseudo-handle.
    let user = unsafe { GetGuiResources(process, GR_USEROBJECTS) };
    // SAFETY: `process` is the current process's pseudo-handle.
    let gdi = unsafe { GetGuiResources(process, GR_GDIOBJECTS) };
    let mut kernel = 0u32;
    // SAFETY: `kernel` is a valid u32 for the call to fill.
    unsafe { GetProcessHandleCount(process, &mut kernel) }.expect("GetProcessHandleCount");
    (user, gdi, kernel)
  }

  fn unique_app_id(kind: &str) -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("Sweetview.{kind}.{}.{nanos}", std::process::id())
  }

  /// Deletes the AUMID key a test registered, when it goes out of scope.
  struct AppIdKey(String);

  impl Drop for AppIdKey {
    fn drop(&mut self) {
      let name = HSTRING::from(app_id_key(&self.0));
      // SAFETY: `name` is a NUL-terminated wide string that outlives the call.
      let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &name) };
      assert!(status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND, "RegDeleteTreeW: {status:?}");
    }
  }

  fn display_name_of(app_id: &str) -> Option<String> {
    let name = HSTRING::from(app_id_key(app_id));
    let mut buffer = [0u16; 256];
    let mut size = size_of_val(&buffer) as u32;
    // SAFETY: `name` is a NUL-terminated wide string, and `buffer` and `size` are valid
    // for the call to fill, with `size` the buffer's length in bytes.
    let status = unsafe {
      RegGetValueW(
        HKEY_CURRENT_USER,
        &name,
        w!("DisplayName"),
        windows::Win32::System::Registry::RRF_RT_REG_SZ,
        None,
        Some(buffer.as_mut_ptr().cast()),
        Some(&mut size),
      )
    };
    (status == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&buffer[..(size as usize / 2).saturating_sub(1)]))
  }

  fn note(id: &str) -> Notification {
    Notification { id: id.into(), title: "Sweetview test".into(), body: "From cargo test".into(), silent: true, data_json: None }
  }

  type Clicks = Rc<RefCell<Vec<(String, Option<String>)>>>;

  fn recorder() -> (Clicks, impl Fn(&str, Option<&str>) + 'static) {
    let clicks: Clicks = Rc::new(RefCell::new(Vec::new()));
    let sink = clicks.clone();
    (clicks, move |id: &str, data: Option<&str>| sink.borrow_mut().push((id.to_owned(), data.map(str::to_owned))))
  }

  #[test]
  fn copy_wide_truncates_so_the_nul_fits() {
    let mut field = [0xffffu16; 4];
    copy_wide(&mut field, "abcdef");
    assert_eq!(field, [97, 98, 99, 0]);
    copy_wide(&mut field, "x");
    assert_eq!(field, [120, 0, 0, 0]);
  }

  /// What `notifier.test.ts` "registers an AUMID and shows real WinRT toasts
  /// with independently routed clicks" proves, against real WinRT.
  #[test]
  fn toasts_register_the_app_id_and_route_each_click_once() {
    let _serial = serial();
    let app_id = unique_app_id("NotifierTest");
    let _cleanup = AppIdKey(app_id.clone());
    let (clicks, on_click) = recorder();
    let options = NotifierOptions { app_id: Some(app_id.clone()), app_name: Some("Sweetview <test> & \"toast\"".into()), icon_ico: None };
    // A real IToastNotifier.Show under this app id, on a notifier of its own: a toast, not a fallback.
    {
      let real = Notifier::new(options.clone(), |_, _| {}).expect("notifier");
      let Some(Shown::Toast(_)) = real.show(&note("really shown")) else { panic!("WinRT toasts are unavailable on this machine") };
      assert!(real.toasts_available());
      assert_eq!(real.balloons_shown(), 0, "the real toast did not fall back");
    }
    // The toasts whose events are routed below are built and subscribed the same way and held back
    // from the platform, so its own events (a machine that shows no toasts dismisses each at once)
    // cannot arrive between the ones this test delivers.
    let notifier = Notifier::new(options, on_click).expect("notifier");
    notifier.force_path(ForcedPath::ToastHeld);
    let first = Notification { id: "first<&>\"".into(), data_json: Some("{\"index\":1}".into()), ..note("") };
    let second = Notification { id: "second".into(), data_json: Some("[\"different\",2]".into()), ..note("") };
    let Some(Shown::Toast(first_cookie)) = notifier.show(&first) else { panic!("WinRT toasts are unavailable on this machine") };
    let Some(Shown::Toast(second_cookie)) = notifier.show(&second) else { panic!("second toast") };
    let Some(Shown::Toast(outstanding)) = notifier.show(&note("outstanding")) else { panic!("third toast") };
    assert_ne!(first_cookie, second_cookie);
    assert!(notifier.toasts_available());
    assert_eq!(display_name_of(&app_id).as_deref(), Some("Sweetview <test> & \"toast\""));
    assert_eq!(notifier.pending_toasts(), 3);
    assert_eq!(notifier.pending_balloons(), 0, "no toast failed");

    // The real subscribed handlers post; the clicks arrive only from the message loop.
    assert!(notifier.simulate_toast_event(second_cookie, ToastEvent::Activated));
    assert!(notifier.simulate_toast_event(first_cookie, ToastEvent::Activated));
    // WinRT may raise a second event before the first is handled: it posts again.
    assert!(notifier.simulate_toast_event(second_cookie, ToastEvent::Activated));
    assert!(clicks.borrow().is_empty());
    pump_until(|| clicks.borrow().len() >= 2);
    pump();
    assert_eq!(
      *clicks.borrow(),
      [("second".to_owned(), Some("[\"different\",2]".to_owned())), ("first<&>\"".to_owned(), Some("{\"index\":1}".to_owned()))]
    );
    assert_eq!(notifier.pending_toasts(), 1);

    // A failed toast falls back to a balloon once; a dismissed one only goes away.
    let Some(Shown::Toast(failed)) = notifier.show(&note("failed")) else { panic!("toast") };
    let Some(Shown::Toast(dismissed)) = notifier.show(&note("dismissed")) else { panic!("toast") };
    assert!(notifier.simulate_toast_event(failed, ToastEvent::Failed));
    assert!(notifier.simulate_toast_event(failed, ToastEvent::Failed));
    assert!(notifier.simulate_toast_event(dismissed, ToastEvent::Dismissed));
    assert!(notifier.simulate_toast_event(failed, ToastEvent::Activated));
    assert!(notifier.simulate_toast_event(dismissed, ToastEvent::Activated));
    pump_until(|| notifier.pending_toasts() == 1 && notifier.balloons_shown() == 1);
    pump();
    assert_eq!(clicks.borrow().len(), 2, "no click from a failed or dismissed toast");
    // Counted as shown, not as still pending: a shell that shows no balloons hides one at once.
    assert_eq!(notifier.balloons_shown(), 1, "one fallback balloon for the failed toast");
    assert!(notifier.pending_balloons() <= 1);
    assert_eq!(notifier.pending_toasts(), 1);

    // After the notifier is gone, a late event clicks nothing and every handler is released.
    let probe = notifier.inner.clone();
    drop(notifier);
    let late = Notifier { inner: probe };
    assert!(!late.simulate_toast_event(outstanding, ToastEvent::Activated));
    pump();
    assert_eq!(clicks.borrow().len(), 2);
    drop(late);
    assert_eq!(live_toast_handlers(), 0, "every toast event handler was released");
  }

  /// What `notifier.test.ts` "uses the explicit app ID and falls back when
  /// WinRT Show fails" proves.
  #[test]
  fn a_failed_show_falls_back_to_a_balloon_whose_click_comes_back() {
    let _serial = serial();
    let app_id = unique_app_id("NotifierFallbackTest");
    let _cleanup = AppIdKey(app_id.clone());
    let (clicks, on_click) = recorder();
    let options = NotifierOptions { app_id: Some(app_id.clone()), app_name: Some("Sweetview fallback test".into()), icon_ico: None };
    let notifier = Notifier::new(options, on_click).expect("notifier");
    assert!(matches!(notifier.show(&note("winrt")), Some(Shown::Toast(_))));
    assert!(display_name_of(&app_id).is_some(), "the explicit app id was registered");
    notifier.force_path(ForcedPath::ToastShowFails);
    let fallback = Notification { data_json: Some("[1]".into()), ..note("fallback") };
    let Some(Shown::Balloon(uid)) = notifier.show(&fallback) else { panic!("the balloon did not take over") };
    assert_eq!(notifier.pending_balloons(), 1);
    assert_eq!(notifier.pending_toasts(), 1, "the failed toast was torn down");

    // The click the shell posts for that balloon comes back with its id and data.
    assert!(notifier.simulate_balloon_event(uid, BalloonEvent::Clicked));
    pump_until(|| !clicks.borrow().is_empty());
    assert_eq!(*clicks.borrow(), [("fallback".to_owned(), Some("[1]".to_owned()))]);
    assert_eq!(notifier.pending_balloons(), 0);

    // A balloon that times out reports no click.
    let Some(Shown::Balloon(uid)) = notifier.show(&note("timeout")) else { panic!("balloon") };
    assert!(notifier.simulate_balloon_event(uid, BalloonEvent::TimedOut));
    pump_until(|| notifier.pending_balloons() == 0);
    assert_eq!(clicks.borrow().len(), 1);
  }

  #[test]
  fn without_winrt_every_notification_is_a_balloon_with_or_without_an_icon() {
    let _serial = serial();
    let (_clicks, on_click) = recorder();
    let options = NotifierOptions { icon_ico: Some(crate::ico::tests::sample_ico()), ..Default::default() };
    let notifier = Notifier::new(options, on_click).expect("notifier");
    notifier.force_path(ForcedPath::BalloonOnly);
    assert!(matches!(notifier.show(&note("own icon")), Some(Shown::Balloon(_))));
    notifier.set_icon_ico(None).expect("stock icon");
    assert!(matches!(notifier.show(&note("stock icon")), Some(Shown::Balloon(_))));
    assert!(notifier.notify(&note("notify reports true")));
    assert!(!notifier.toasts_available(), "WinRT was never tried");
    assert_eq!(notifier.pending_balloons(), 3);
    assert!(notifier.set_icon_ico(Some(b"not an icon".to_vec())).is_err());
    assert!(Notifier::new(NotifierOptions { icon_ico: Some(vec![1, 2, 3]), ..Default::default() }, |_, _| {}).is_err());
  }

  #[test]
  fn a_click_handler_may_drop_its_notifier_and_a_panic_does_not_unwind() {
    let _serial = serial();
    let slot: Rc<RefCell<Option<Notifier>>> = Rc::new(RefCell::new(None));
    let calls = Rc::new(Cell::new(0u32));
    let (inner_slot, inner_calls) = (slot.clone(), calls.clone());
    let notifier = Notifier::new(NotifierOptions::default(), move |_, _| {
      inner_calls.set(inner_calls.get() + 1);
      inner_slot.borrow_mut().take();
      panic!("a click handler that panics is caught");
    })
    .expect("notifier");
    notifier.force_path(ForcedPath::BalloonOnly);
    let Some(Shown::Balloon(uid)) = notifier.show(&note("drop me")) else { panic!("balloon") };
    assert!(notifier.simulate_balloon_event(uid, BalloonEvent::Clicked));
    *slot.borrow_mut() = Some(notifier);
    pump_until(|| calls.get() == 1);
    assert_eq!(calls.get(), 1);
    assert!(slot.borrow().is_none());
  }

  #[test]
  fn creating_and_dropping_returns_every_handle() {
    let _serial = serial();
    let app_id = unique_app_id("NotifierHandles");
    let _cleanup = AppIdKey(app_id.clone());
    let options = NotifierOptions { app_id: Some(app_id), icon_ico: Some(crate::ico::tests::sample_ico()), ..Default::default() };
    let round = |shows: bool| {
      let notifier = Notifier::new(options.clone(), |_, _| {}).expect("notifier");
      if shows {
        assert!(matches!(notifier.show(&note("toast")), Some(Shown::Toast(_))));
        notifier.force_path(ForcedPath::BalloonOnly);
        assert!(matches!(notifier.show(&note("balloon")), Some(Shown::Balloon(_))));
      }
    };
    // Rounds first, so one-time costs are paid: the window class, WinRT's modules and factories,
    // and the threads and ports WinRT's calls to the notification platform start as they go.
    for _ in 0..8 {
      round(true);
    }
    // The platform works on each toast after `Show` and `Hide` return, on its own threads, and
    // holds kernel handles while it does: counts are read once they have stopped moving.
    let settled = || {
      let mut last = counts();
      let deadline = Instant::now() + Duration::from_secs(10);
      let mut steady_since = Instant::now();
      while Instant::now() < deadline && steady_since.elapsed() < Duration::from_millis(400) {
        std::thread::sleep(Duration::from_millis(50));
        pump();
        let now = counts();
        if now != last {
          last = now;
          steady_since = Instant::now();
        }
      }
      last
    };
    let before = settled();
    for _ in 0..100 {
      round(false);
    }
    let idle = settled();
    for _ in 0..32 {
      round(true);
    }
    let after = settled();
    eprintln!("(USER, GDI, kernel) before {before:?}, after 100 notifiers that show nothing {idle:?}, after 32 that show {after:?}");
    // `<=`: an earlier test's thread may still be exiting, freeing its own USER objects.
    assert!(after.0 <= before.0, "USER objects returned to the starting count: {before:?} -> {after:?}");
    assert!(after.1 <= before.1, "GDI objects returned to the starting count: {before:?} -> {after:?}");
    assert!(idle.2 <= before.2 + 4, "kernel handles returned to the starting count with nothing shown: {before:?} -> {idle:?}");
    assert!(after.2 <= before.2 + 4, "kernel handles returned to the starting count: {before:?} -> {after:?}");
    assert_eq!(live_toast_handlers(), 0);
  }
}
