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
use std::sync::OnceLock;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use sweetview_platform_loop::{MessageWindow, Poster};
use windows::core::{Ref, RuntimeType, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::core::Interface;
use windows::Foundation::{DateTime, IReference, PropertyValue, TypedEventHandler};
use windows::UI::Notifications::{
  ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager, ToastNotifier,
};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, E_UNEXPECTED, HWND, LPARAM, RPC_E_CHANGED_MODE, WPARAM};
use windows::Win32::System::Com::CoIncrementMTAUsage;
use windows::Win32::System::Registry::KEY_QUERY_VALUE;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED};
use windows_registry::CURRENT_USER;
use windows::Win32::UI::Shell::{
  Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_STATE, NIF_TIP, NIIF_INFO, NIIF_LARGE_ICON, NIIF_NOSOUND,
  NIIF_RESPECT_QUIET_TIME, NIIF_USER, NIM_ADD, NIM_DELETE, NIN_BALLOONHIDE, NIN_BALLOONTIMEOUT, NIN_BALLOONUSERCLICK,
  NIS_HIDDEN, NOTIFYICONDATAW, NOTIFY_ICON_INFOTIP_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{
  CreateIconFromResourceEx, DestroyIcon, GetSystemMetrics, LoadIconW, HICON, IDI_APPLICATION, LR_DEFAULTCOLOR, SM_CXICON,
  SM_CXSMICON, SYSTEM_METRICS_INDEX, WM_APP, WM_CLOSE,
};

use crate::toast_xml::{app_id_key, display_name, toast_xml, validate_app_id};
use crate::{ico, BalloonEvent, ForcedPath, Notification, NotifierOptions, NotifyError, Shown, ToastEvent};

/// The shell's balloon events, as today: `wParam` is the icon's uID, the low
/// word of `lParam` the event.
const WM_NOTIFIER: u32 = WM_APP + 2;
/// A toast event: `wParam` is the cookie, `lParam` the event (0 dismissed,
/// 1 activated, 2 failed), as today.
const WM_TOAST_EVENT: u32 = WM_APP + 3;

// The process-wide counters are `OnceLock`s holding an atomic, a form of global state
// `UNSAFE-POLICY.md` lists. They are process-wide because any thread may make a notifier,
// and the count of live handlers changes on WinRT's threads.

/// Toast cookies are process-wide and start at 1, as today.
fn next_cookie() -> &'static AtomicU64 {
  static NEXT_COOKIE: OnceLock<AtomicU64> = OnceLock::new();
  NEXT_COOKIE.get_or_init(|| AtomicU64::new(1))
}

/// Balloon icon uIDs are process-wide and start at 10000, as today.
fn next_balloon_uid() -> &'static AtomicU32 {
  static NEXT_BALLOON_UID: OnceLock<AtomicU32> = OnceLock::new();
  NEXT_BALLOON_UID.get_or_init(|| AtomicU32::new(10_000))
}

/// Toast event handlers alive in the process; see [`live_toast_handlers`].
fn live_handlers() -> &'static AtomicUsize {
  static LIVE_HANDLERS: OnceLock<AtomicUsize> = OnceLock::new();
  LIVE_HANDLERS.get_or_init(|| AtomicUsize::new(0))
}

/// How many toast event handlers exist in the process. A handler lives while
/// WinRT holds its subscription or a pending toast keeps it for
/// [`Notifier::simulate_toast_event`]; a test asserts it returns to zero once
/// every notifier is gone.
pub fn live_toast_handlers() -> usize {
  live_handlers().load(Ordering::SeqCst)
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

// ---- the toast handlers ------------------------------------------------------

/// Counts itself in [`live_handlers`] while a toast handler holds it.
struct HandlerLife;

impl HandlerLife {
  fn new() -> Self {
    live_handlers().fetch_add(1, Ordering::SeqCst);
    HandlerLife
  }
}

impl Drop for HandlerLife {
  fn drop(&mut self) {
    live_handlers().fetch_sub(1, Ordering::SeqCst);
  }
}

/// A toast event handler's body: post the cookie and the event to the owner.
/// The post fails harmlessly once the notifier's window is gone.
fn poster<S: RuntimeType + 'static, R: RuntimeType + 'static>(
  target: Poster,
  cookie: u64,
  event: ToastEvent,
) -> impl Fn(Ref<S>, Ref<R>) -> windows::core::Result<()> + Send + 'static {
  guarded_handler(move || {
    target.post(WM_TOAST_EVENT, cookie as usize, event_code(event));
  })
}

/// A toast event handler around `body`, counted in [`live_handlers`] while it
/// lives. It runs on a WinRT thread and must never unwind into WinRT: `body`
/// runs inside `catch_unwind`, and a panic is reported to WinRT as
/// `E_UNEXPECTED` instead of success.
fn guarded_handler<S: RuntimeType + 'static, R: RuntimeType + 'static>(
  body: impl Fn() + Send + 'static,
) -> impl Fn(Ref<S>, Ref<R>) -> windows::core::Result<()> + Send + 'static {
  let life = HandlerLife::new();
  move |_sender, _args| {
    let _alive = &life;
    catch_unwind(AssertUnwindSafe(&body)).map_err(|_| E_UNEXPECTED.into())
  }
}

// ---- icons -------------------------------------------------------------------

/// An icon this notifier made from `.ico` bytes: it owns the handle and
/// destroys it in `Drop`.
struct OwnedIcon(HICON);

impl Drop for OwnedIcon {
  fn drop(&mut self) {
    // SAFETY: `self.0` was made by CreateIconFromResourceEx for this value alone (only
    // `BalloonIcon::load` makes one), and the shell no longer uses it: a `Balloon` keeps
    // its icons until its notification-area icon is deleted.
    let destroyed = unsafe { DestroyIcon(self.0) };
    let _ = destroyed;
  }
}

/// The stock application icon, which the system shares for the life of the
/// process. It is never destroyed, so no handle of it is stored: it is asked
/// for each time a notification-area icon is built.
fn stock_icon() -> HICON {
  // SAFETY: IDI_APPLICATION is a predefined resource id and no module is passed, so the
  // shared system icon is returned; nothing of ours is read.
  let stock = unsafe { LoadIconW(None, IDI_APPLICATION) };
  stock.unwrap_or_default()
}

/// An icon for the balloon: one this notifier made from `.ico` bytes, or the
/// stock application icon. The variant says which is owned.
enum BalloonIcon {
  Own(OwnedIcon),
  Stock,
}

impl BalloonIcon {
  /// The handle a `NOTIFYICONDATAW` names, valid for as long as `self` is.
  fn handle(&self) -> HICON {
    match self {
      BalloonIcon::Own(icon) => icon.0,
      BalloonIcon::Stock => stock_icon(),
    }
  }

  fn is_own(&self) -> bool {
    matches!(self, BalloonIcon::Own(_))
  }

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
            Ok(handle) => return BalloonIcon::Own(OwnedIcon(handle)),
            Err(error) => {
              eprintln!("sweetview: CreateIconFromResourceEx failed ({}); using the default icon", error.code().0 & 0xffff)
            }
          }
        }
        Err(error) => eprintln!("sweetview: {error}; using the default icon"),
      }
    }
    BalloonIcon::Stock
  }
}

/// A balloon on screen: its icons and the notification its click reports.
struct Balloon {
  notification: Notification,
  _small: BalloonIcon,
  _large: BalloonIcon,
}

/// The `NOTIFYICONDATAW` a balloon is added with: a notification-area icon of
/// the notifier's window that is hidden (`NIS_HIDDEN`), carrying the balloon
/// (`NIF_INFO`: the body, and the title as its title and the icon's tip). With
/// the notifier's own icon the balloon shows it large (`NIIF_USER |
/// NIIF_LARGE_ICON`), else the stock information icon (`NIIF_INFO`); a silent
/// notification adds `NIIF_NOSOUND`, and every balloon respects quiet time.
/// The icons are borrowed: the struct is valid while `small` and `large` are.
fn balloon_data(window: HWND, uid: u32, notification: &Notification, small: &BalloonIcon, large: &BalloonIcon) -> NOTIFYICONDATAW {
  let own_icon = large.is_own();
  let mut info_flags = if own_icon { NIIF_USER | NIIF_LARGE_ICON } else { NIIF_INFO };
  info_flags |= NIIF_RESPECT_QUIET_TIME;
  if notification.silent {
    info_flags |= NIIF_NOSOUND;
  }
  let mut data = NOTIFYICONDATAW {
    cbSize: size_of::<NOTIFYICONDATAW>() as u32,
    hWnd: window,
    uID: uid,
    uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_STATE | NIF_INFO,
    uCallbackMessage: WM_NOTIFIER,
    hIcon: small.handle(),
    dwState: NIS_HIDDEN,
    dwStateMask: NIS_HIDDEN,
    dwInfoFlags: NOTIFY_ICON_INFOTIP_FLAGS(info_flags.0),
    hBalloonIcon: if own_icon { large.handle() } else { HICON::default() },
    ..Default::default()
  };
  copy_wide(&mut data.szTip, &notification.title);
  copy_wide(&mut data.szInfo, &notification.body);
  copy_wide(&mut data.szInfoTitle, &notification.title);
  data
}

// ---- the window --------------------------------------------------------------

/// The notifier's message-only window and the notification-area icons it owns.
/// Dropping it deletes every icon, then the window (which disarms the toast
/// handlers' [`Poster`]s and destroys it).
struct NotifyWindow {
  balloons: RefCell<HashMap<u32, Balloon>>,
  /// The icons name this window, so it is dropped after them.
  window: MessageWindow,
}

/// The window a notification-area icon names: `window`'s handle, borrowed for
/// as long as `window` is.
fn icon_owner(window: &MessageWindow) -> HWND {
  match window.window_handle().map(|handle| handle.as_raw()) {
    Ok(RawWindowHandle::Win32(handle)) => HWND(handle.hwnd.get() as *mut core::ffi::c_void),
    _ => HWND::default(),
  }
}

impl NotifyWindow {
  fn new(owner: Weak<Inner>) -> Result<Self, NotifyError> {
    // The window procedure. The notifier is upgraded first, so it may be dropped from
    // inside the call; `MessageWindow` catches a panic, which counts as handled.
    let procedure = move |message: u32, wparam: usize, lparam: isize| match message {
      WM_TOAST_EVENT | WM_NOTIFIER => {
        if let Some(inner) = owner.upgrade() {
          inner.handle_message(message, WPARAM(wparam), LPARAM(lparam));
        }
        Some(0)
      }
      // Only the owner tears this window down; an external WM_CLOSE is ignored.
      WM_CLOSE => Some(0),
      _ => None,
    };
    let window = MessageWindow::new("SweetviewNotifierWindow", "sweetview.notifier", procedure)
      .map_err(|e| NotifyError(format!("sweetview: {} failed ({})", e.call(), e.code())))?;
    Ok(Self { balloons: RefCell::new(HashMap::new()), window })
  }

  fn poster(&self) -> Poster {
    self.window.poster()
  }

  fn show_balloon(&self, notification: &Notification, icon: Option<&[u8]>) -> Option<u32> {
    let uid = next_balloon_uid().fetch_add(1, Ordering::SeqCst);
    let small = BalloonIcon::load(icon, SM_CXSMICON);
    let large = BalloonIcon::load(icon, SM_CXICON);
    let data = balloon_data(icon_owner(&self.window), uid, notification, &small, &large);
    // SAFETY: `data` is a fully initialised NOTIFYICONDATAW that outlives the call; its
    // window is `self.window`'s, owned by this value and dropped after every icon, and its
    // icons are owned by `small` and `large`, which the balloon keeps until its icon is deleted.
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
    let data = NOTIFYICONDATAW { cbSize: size_of::<NOTIFYICONDATAW>() as u32, hWnd: icon_owner(&self.window), uID: uid, ..Default::default() };
    // SAFETY: `data` is a fully initialised NOTIFYICONDATAW that outlives the call, naming
    // the window of `self.window`, which this value owns.
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
    // `self.window` is dropped next: it disarms the toast handlers' posters and destroys the window.
  }
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

/// The Win32 error code a registry call failed with, as today's messages print it.
fn registry_code(error: &windows::core::Error) -> u32 {
  (error.code().0 as u32) & 0xffff
}

/// Registers the AUMID under `HKCU\Software\Classes\AppUserModelId`. A
/// `DisplayName` is written only when the key has none, so names and icons an
/// installer set are kept.
fn register_app_id(app_id: &str, display: &str) -> Result<(), NotifyError> {
  validate_app_id(app_id)?;
  let sub_key = app_id_key(app_id);
  // Created when missing, opened to write and query values as today, and closed when `key` drops.
  let key = CURRENT_USER.options().write().access(KEY_QUERY_VALUE.0).create().open(&sub_key);
  let key = key.map_err(|e| NotifyError(format!("sweetview: RegCreateKeyExW({sub_key}) failed ({})", registry_code(&e))))?;
  match key.get_type("DisplayName") {
    Ok(_) => Ok(()),
    Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => key
      .set_string("DisplayName", display)
      .map_err(|e| NotifyError(format!("sweetview: RegSetValueExW(DisplayName) failed ({})", registry_code(&e)))),
    Err(error) => Err(NotifyError(format!("sweetview: RegGetValueW(DisplayName) failed ({})", registry_code(&error)))),
  }
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

  fn show(&self, notification: &Notification, target: &Poster, forced: ForcedPath, life: Option<u32>) -> Result<u64, NotifyError> {
    let xml = toast_xml(&notification.id, &notification.title, &notification.body, notification.silent);
    let document = XmlDocument::new().map_err(hresult_error("RoActivateInstance(XmlDocument)"))?;
    document.LoadXml(&HSTRING::from(xml)).map_err(hresult_error("IXmlDocumentIO.LoadXml"))?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(hresult_error("CreateToastNotification"))?;
    if let Some(seconds) = life {
      // A test's toast: it goes to the notification centre with no banner on the screen, and the
      // platform removes it from there by itself. On a machine with nobody at it Windows keeps a
      // banner up until someone comes back, hidden or expired or not, so a test run would leave
      // its banners over the corner of the screen.
      toast.SetSuppressPopup(true).map_err(hresult_error("IToastNotification2.put_SuppressPopup"))?;
      let expires = expiry_after(seconds).map_err(hresult_error("PropertyValue.CreateDateTime"))?;
      toast.SetExpirationTime(&expires).map_err(hresult_error("IToastNotification.put_ExpirationTime"))?;
    }
    let cookie = next_cookie().fetch_add(1, Ordering::SeqCst);
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
    target: &Poster,
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

  /// Ends every subscription as [`dispose`](Self::dispose) does, but leaves the toasts shown:
  /// they stay on the screen and in the notification centre, and report nothing more.
  fn forget(&self) {
    if self.disposed.get() {
      return;
    }
    // Removed while not yet disposed, so `remove` hides nothing.
    let cookies: Vec<u64> = self.pending.borrow().keys().copied().collect();
    for cookie in cookies {
      self.remove(cookie);
    }
    self.disposed.set(true);
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

impl Drop for Toasts {
  /// Ends every subscription this value made and hides its toasts, whoever
  /// drops it; after `dispose` this does nothing.
  fn drop(&mut self) {
    self.dispose();
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
  /// A test's toasts: no banner, and removed by the platform after this many seconds. `None`, as applications get: a banner and no expiry.
  toast_life: Cell<Option<u32>>,
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

  fn target(&self) -> Option<Poster> {
    self.window.borrow().as_ref().map(NotifyWindow::poster)
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
        if let Ok(cookie) = toasts.show(notification, &target, forced, self.toast_life.get()) {
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
    self.end(true);
  }

  /// Ends the notifier: its toasts' subscriptions, its hidden icons and its window. With
  /// `withdraw` the toasts still showing are hidden too ([`Notifier::dispose`]); without, they
  /// stay for the user ([`Notifier::release`]).
  fn end(&self, withdraw: bool) {
    if self.disposed.replace(true) {
      return;
    }
    let toasts = std::mem::replace(&mut *self.toasts.borrow_mut(), ToastSlot::Unavailable);
    if let ToastSlot::Ready(toasts) = toasts {
      if withdraw {
        toasts.dispose();
      } else {
        toasts.forget();
      }
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
      toast_life: Cell::new(DEFAULT_TOAST_LIFE),
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

  /// Test hook: later toasts show no banner and expire after `seconds`, when the platform removes
  /// them from the notification centre by itself. `None`, what applications get: a banner, and no expiry.
  pub fn set_toast_life(&self, seconds: Option<u32>) {
    self.inner.toast_life.set(seconds);
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

impl Notifier {
  /// Ends the notifier as dropping it does, but leaves the toasts it showed on the screen and in
  /// the notification centre: their subscriptions end, so they report nothing more. Its hidden
  /// notification icons are removed with its window, and a balloon goes with its icon. What the
  /// end of an application does. Dropping it afterwards does nothing more.
  pub fn release(&self) {
    self.inner.end(false);
  }
}

impl Drop for Notifier {
  fn drop(&mut self) {
    self.inner.dispose();
  }
}

/// How long this crate's own tests leave a toast with the platform; applications' toasts never expire.
#[cfg(test)]
const DEFAULT_TOAST_LIFE: Option<u32> = Some(4);
#[cfg(not(test))]
const DEFAULT_TOAST_LIFE: Option<u32> = None;

/// The moment `seconds` from now, as the reference to a date and time a toast's expiry takes.
fn expiry_after(seconds: u32) -> windows::core::Result<IReference<DateTime>> {
  // A DateTime counts 100 ns ticks from 1601-01-01 UTC; the Unix epoch is 11 644 473 600 s after it.
  let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
  let ticks = (unix + 11_644_473_600 + u64::from(seconds)) * 10_000_000;
  PropertyValue::CreateDateTime(DateTime { UniversalTime: ticks as i64 })?.cast()
}

fn validate_icon(bytes: &[u8]) -> Result<(), NotifyError> {
  let entries = ico::parse_ico(bytes).map_err(|e| NotifyError(format!("sweetview: notifier icon: {e}")))?;
  ico::pick_entry(&entries, 16).map_err(|e| NotifyError(format!("sweetview: notifier icon: {e}")))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::PoisonError;
  use std::time::{Duration, Instant};
  use sweetview_platform_loop::dispatch_waiting as pump;

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

  fn counts() -> (u32, u32, u32) {
    let counts = sweetview_platform_loop::resource_counts();
    (counts.user_objects, counts.gdi_objects, counts.kernel_handles)
  }

  fn unique_app_id(kind: &str) -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("Sweetview.{kind}.{}.{nanos}", std::process::id())
  }

  /// Deletes the AUMID key a test registered, when it goes out of scope, and the entry the
  /// notification platform keeps for every app id that has shown a toast.
  struct AppIdKey(String);

  impl Drop for AppIdKey {
    fn drop(&mut self) {
      if let Err(error) = CURRENT_USER.remove_tree(app_id_key(&self.0)) {
        assert_eq!(error.code(), ERROR_FILE_NOT_FOUND.to_hresult(), "RegDeleteTreeW: {error:?}");
      }
      // The platform's own entry: there only when a toast was shown, and the platform may still
      // be writing it, so a failure here fails nothing.
      let _ = CURRENT_USER.remove_tree(format!(r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{}", self.0));
    }
  }

  fn display_name_of(app_id: &str) -> Option<String> {
    CURRENT_USER.open(app_id_key(app_id)).ok()?.get_string("DisplayName").ok()
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

  /// The text of a fixed wide-character field, up to its NUL.
  fn wide(field: &[u16]) -> String {
    let end = field.iter().position(|&unit| unit == 0).unwrap_or(field.len());
    String::from_utf16_lossy(&field[..end])
  }

  /// A window value for the structs built below; nothing is sent to it.
  const SOME_WINDOW: HWND = HWND(0x1234 as *mut core::ffi::c_void);

  // Counterpart of the baseline's "notifyIconData lays out the balloon fields where Windows
  // expects them": the struct handed to `Shell_NotifyIconW(NIM_ADD, ..)` is the `windows` crate's,
  // sized as Windows expects, and carries the window, the id, the callback message and the text.
  #[test]
  fn balloon_data_lays_out_the_balloon_fields_where_windows_expects_them() {
    let (small, large) = (BalloonIcon::Stock, BalloonIcon::Stock);
    let long_body = "b".repeat(300);
    let notification = Notification { body: long_body.clone(), ..note("layout") };
    let data = balloon_data(SOME_WINDOW, 10_042, &notification, &small, &large);
    assert_eq!(data.cbSize as usize, size_of::<NOTIFYICONDATAW>());
    assert_eq!(data.hWnd, SOME_WINDOW);
    assert_eq!(data.uID, 10_042);
    assert_eq!(data.uCallbackMessage, WM_NOTIFIER);
    assert_eq!(wide(&data.szInfoTitle), "Sweetview test");
    assert_eq!(wide(&data.szTip), "Sweetview test");
    // The body is cut so its NUL still fits in the 256-unit field.
    assert_eq!(wide(&data.szInfo), long_body[..data.szInfo.len() - 1]);
  }

  // Counterpart of the baseline's "hiddenBalloonData sets NIS_HIDDEN and NIF_INFO for standalone
  // notifications": the fallback's icon is hidden, carries the balloon, and the info flags are the
  // ones the code documents for its own icon, the stock icon, and silence.
  #[test]
  fn balloon_data_is_hidden_and_carries_the_balloon_with_the_documented_flags() {
    let sample = crate::ico::tests::sample_ico();
    let (small, large) = (BalloonIcon::load(Some(&sample), SM_CXSMICON), BalloonIcon::load(Some(&sample), SM_CXICON));
    assert!(small.is_own() && large.is_own());
    let silent = balloon_data(SOME_WINDOW, 1, &note("own icon"), &small, &large);
    assert_eq!(silent.uFlags, NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_STATE | NIF_INFO);
    assert_eq!(silent.dwState, NIS_HIDDEN);
    assert_eq!(silent.dwStateMask, NIS_HIDDEN);
    assert_eq!(silent.dwInfoFlags, NIIF_USER | NIIF_LARGE_ICON | NIIF_RESPECT_QUIET_TIME | NIIF_NOSOUND);
    assert_eq!(silent.hIcon, small.handle());
    assert_eq!(silent.hBalloonIcon, large.handle());

    let (stock_small, stock_large) = (BalloonIcon::load(None, SM_CXSMICON), BalloonIcon::load(None, SM_CXICON));
    let audible = Notification { silent: false, ..note("stock icon") };
    let data = balloon_data(SOME_WINDOW, 2, &audible, &stock_small, &stock_large);
    assert_eq!(data.uFlags, NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_STATE | NIF_INFO);
    assert_eq!((data.dwState, data.dwStateMask), (NIS_HIDDEN, NIS_HIDDEN));
    assert_eq!(data.dwInfoFlags, NIIF_INFO | NIIF_RESPECT_QUIET_TIME);
    assert_eq!(data.hIcon, stock_icon());
    assert!(data.hBalloonIcon.is_invalid(), "no balloon icon of its own: the shell shows its information icon");
  }

  // Counterpart of the baseline's "the 32px balloon icon loads from the generated .ico": an `.ico`
  // given as the balloon icon is made into an icon of the notifier's own, not the stock icon; bytes
  // that are not an icon, or none, give the stock icon.
  #[test]
  fn an_ico_given_as_the_balloon_icon_loads_and_is_not_the_stock_icon() {
    let sample = crate::ico::tests::sample_ico();
    let stock = stock_icon();
    assert!(!stock.is_invalid());
    for metric in [SM_CXICON, SM_CXSMICON] {
      let icon = BalloonIcon::load(Some(&sample), metric);
      assert!(icon.is_own(), "the .ico was loaded");
      assert!(!icon.handle().is_invalid());
      assert_ne!(icon.handle(), stock, "the balloon's icon is not the stock icon");
    }
    let refused = BalloonIcon::load(Some(b"not an icon"), SM_CXICON);
    assert!(!refused.is_own());
    assert_eq!(refused.handle(), stock);
    assert!(!BalloonIcon::load(None, SM_CXICON).is_own());
  }

  // F24, read from the shell: the fallback's notification-area icon is registered with the shell
  // (a modify of it succeeds) and has no place on the screen (`Shell_NotifyIconGetRect` gives an
  // empty rectangle, or fails). The control: the same icon made visible for one reading has a
  // rectangle, so the reading tells hidden from shown. Once the notifier is gone the shell has no
  // such icon.
  #[test]
  fn the_shell_holds_the_fallback_icon_hidden_until_the_notifier_goes() {
    use windows::Win32::UI::Shell::{Shell_NotifyIconGetRect, NIM_MODIFY, NOTIFYICONIDENTIFIER, NOTIFY_ICON_STATE};
    let _serial = serial();
    let (_clicks, on_click) = recorder();
    let notifier = Notifier::new(NotifierOptions { icon_ico: Some(crate::ico::tests::sample_ico()), ..Default::default() }, on_click)
      .expect("notifier");
    notifier.force_path(ForcedPath::BalloonOnly);
    let Some(Shown::Balloon(uid)) = notifier.show(&note("hidden")) else { panic!("balloon") };
    let window = notifier.inner.window.borrow().as_ref().map(|window| icon_owner(&window.window)).expect("window");
    assert!(!window.is_invalid());
    // A modify of the icon's state only: `NIS_HIDDEN` set or cleared. It fails when the shell
    // has no icon with this window and id.
    let set_hidden = |hidden: bool| {
      let data = NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: window,
        uID: uid,
        uFlags: NIF_STATE,
        dwState: if hidden { NIS_HIDDEN } else { NOTIFY_ICON_STATE(0) },
        dwStateMask: NIS_HIDDEN,
        ..Default::default()
      };
      // SAFETY: `data` is a fully initialised NOTIFYICONDATAW on this frame for the call; it
      // changes only the hidden state of an icon this test's notifier added.
      unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) }.as_bool()
    };
    // The icon's rectangle on the screen, if it has a non-empty one.
    let place = || {
      let identifier = NOTIFYICONIDENTIFIER { cbSize: size_of::<NOTIFYICONIDENTIFIER>() as u32, hWnd: window, uID: uid, ..Default::default() };
      // SAFETY: `identifier` is a fully initialised NOTIFYICONIDENTIFIER on this frame for the call.
      let rect = unsafe { Shell_NotifyIconGetRect(&identifier) };
      rect.ok().filter(|r| r.right > r.left && r.bottom > r.top)
    };
    assert_eq!(place(), None, "the fallback's icon is hidden: no place on the screen");
    assert!(set_hidden(false), "the shell holds the fallback's icon");
    let shown = place();
    assert!(set_hidden(true));
    assert!(shown.is_some(), "the control: the same icon, shown, has a place on the screen");
    // (Read straight after hiding it again, the shell still reports where the icon was.)
    drop(notifier);
    assert!(!set_hidden(true), "the icon was deleted with the notifier");
  }

  // F8: a toast handler whose body panics reports failure to WinRT, through the handler object
  // WinRT would hold, and the process goes on.
  #[test]
  fn a_toast_handler_that_panics_reports_failure_and_does_not_unwind() {
    let _serial = serial();
    let before = live_toast_handlers();
    let panicking = TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(guarded_handler(|| panic!("provoked by the test")));
    assert_eq!(live_toast_handlers(), before + 1);
    let result = panicking.Invoke(None::<&ToastNotification>, None::<&ToastDismissedEventArgs>);
    assert_eq!(result.map_err(|e| e.code()), Err(E_UNEXPECTED));
    let calm = TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(guarded_handler(|| {}));
    assert!(calm.Invoke(None::<&ToastNotification>, None::<&ToastFailedEventArgs>).is_ok());
    drop((panicking, calm));
    assert_eq!(live_toast_handlers(), before);
  }

  // F32: `Toasts` ends its own subscriptions when it is dropped, without the notifier's dispose.
  #[test]
  fn toasts_end_their_subscriptions_when_dropped() {
    let _serial = serial();
    let app_id = unique_app_id("NotifierToastsDrop");
    let _cleanup = AppIdKey(app_id.clone());
    let window = NotifyWindow::new(Weak::new()).expect("window");
    let toasts = Toasts::new(&NotifierOptions { app_id: Some(app_id), ..Default::default() }).expect("WinRT toasts");
    let before = live_toast_handlers();
    let cookie = toasts.show(&note("held"), &window.poster(), ForcedPath::ToastHeld, Some(4)).expect("subscribed");
    assert_eq!(live_toast_handlers(), before + 3, "three subscriptions");
    assert!(toasts.pending.borrow().contains_key(&cookie));
    drop(toasts);
    assert_eq!(live_toast_handlers(), before, "every subscription was ended and its handler released");
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
    // Showing rounds are measured twice and the smaller growth counts: what a notifier leaks it
    // leaks every round, so it shows in both runs; what the notification platform's client side
    // sets up once in the process, some time after its first use, shows in one.
    for _ in 0..32 {
      round(true);
    }
    let first = settled();
    for _ in 0..32 {
      round(true);
    }
    let second = settled();
    eprintln!(
      "(USER, GDI, kernel) before {before:?}, after 100 notifiers that show nothing {idle:?}, after 32 that show {first:?}, after 32 more {second:?}"
    );
    let grew = |from: (u32, u32, u32), to: (u32, u32, u32)| {
      (i64::from(to.0) - i64::from(from.0), i64::from(to.1) - i64::from(from.1), i64::from(to.2) - i64::from(from.2))
    };
    let (a, b) = (grew(idle, first), grew(first, second));
    let shown = (a.0.min(b.0), a.1.min(b.1), a.2.min(b.2));
    assert!(idle.0 == before.0 && shown.0 == 0, "USER objects returned to the starting count: {before:?} -> {idle:?} -> {first:?} -> {second:?}");
    assert!(idle.1 == before.1 && shown.1 == 0, "GDI objects returned to the starting count: {before:?} -> {idle:?} -> {first:?} -> {second:?}");
    assert_eq!(idle.2, before.2, "kernel handles returned to the starting count with nothing shown: {before:?} -> {idle:?}");
    // The one allowance: the notification platform's client side opens kernel handles of its own
    // on its threads at moments of its choosing after toasts are shown, and keeps them. Measured on
    // this machine over eleven runs (five of them on the code before this change), the growth of a
    // 32-round showing run was between 0 and 15 handles, and the smaller of the two runs up to 9.
    // A handle the notifier leaked would leak in every round: at least 32 in each run. So the
    // smaller growth must stay below half the rounds.
    assert!(shown.2 < 16, "no kernel handle is leaked per notifier: {idle:?} -> {first:?} -> {second:?}");
    assert_eq!(live_toast_handlers(), 0);
  }
}
