//! Desktop notifications with a click that comes back.
//!
//! On Windows a [`Notifier`] shows WinRT toasts and falls back to a balloon on
//! a hidden notification-area icon of its own when WinRT is unavailable or a
//! toast fails. A click on either comes back to the notifier's `on_click`, on
//! the thread that made the notifier, from that thread's message loop.
//!
//! Other platforms get a stand-in whose constructor reports that the platform
//! is not ported yet; the macOS goal replaces it there.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

pub mod ico;
pub mod toast_xml;

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "unported.rs"]
mod platform;

pub use platform::{live_toast_handlers, Notifier};

/// How a notifier identifies itself to the OS.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NotifierOptions {
  /// The toast's Application User Model ID. `None` uses `Sweetview.DesktopApp`.
  /// The TypeScript layer passes `options.appId ?? identity.appId`.
  pub app_id: Option<String>,
  /// The `DisplayName` written for a new AUMID registration. The TypeScript
  /// layer passes `identity.appName`. `None` uses the `app_id` when one was
  /// given, else `Sweetview`.
  pub app_name: Option<String>,
  /// The `.ico` file the balloon fallback shows (today: the current tray icon's
  /// bytes). `None` shows the stock application icon. Toasts carry no icon.
  pub icon_ico: Option<Vec<u8>>,
}

/// One notification.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Notification {
  /// Comes back with a click. The toast's `launch` argument.
  pub id: String,
  pub title: String,
  pub body: String,
  /// No sound.
  pub silent: bool,
  /// Comes back with a click, unchanged.
  pub data_json: Option<String>,
}

/// Which path showed a notification, and the number that names it there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shown {
  /// A WinRT toast, by its cookie (process-wide, counting up from 1).
  Toast(u64),
  /// A balloon on the notifier's hidden notification icon, by the icon's uID
  /// (process-wide, counting up from 10000).
  Balloon(u32),
}

/// The three things WinRT reports about a toast.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastEvent {
  Dismissed,
  Activated,
  Failed,
}

/// What the shell reports about a balloon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BalloonEvent {
  /// `NIN_BALLOONUSERCLICK`.
  Clicked,
  /// `NIN_BALLOONTIMEOUT`.
  TimedOut,
  /// `NIN_BALLOONHIDE`.
  Hidden,
}

/// A test hook: makes a notifier take a path it would otherwise take only when
/// the OS fails.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ForcedPath {
  /// Toasts when WinRT is available, the balloon otherwise.
  #[default]
  Auto,
  /// As if WinRT were unavailable: every notification is a balloon.
  BalloonOnly,
  /// As if `IToastNotifier.Show` failed: the toast is built and subscribed,
  /// then torn down, and the balloon shows the notification.
  ToastShowFails,
  /// The toast is built and subscribed exactly as usual and then not handed to
  /// the notification platform, so the only events it reports are the ones a
  /// test delivers. A platform that shows no toasts (notifications turned off,
  /// a session with nobody at it) dismisses each one at once, and its own
  /// event would race a test's.
  ToastHeld,
}

/// Why a notifier could not be made or configured.
pub use sweetview_shell_data::NotifyError;

/// Tests in this crate count the process's handles and share the desktop, so
/// they run one at a time.
#[cfg(all(test, windows))]
pub(crate) static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
