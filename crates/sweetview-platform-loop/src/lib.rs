//! The parts of the UI thread's event loop that `tao` has no API for.
//!
//! * [`LoopHost`] owns the `tao` event loop and hands its window target to code
//!   that runs while the loop is running.
//! * [`SignalWindow`] delivers wakes from other threads and native timers through
//!   whichever message loop the UI thread is in, a modal one included.
//! * [`ComApartment`] puts the UI thread in the single-threaded COM apartment
//!   WebView2 and the shell's dialogs need.
//! * On Windows, [`MessageWindow`] is the owning type of every message-only
//!   window the platform crates make, and [`next_message`], [`wait_message`]
//!   and [`dispatch_waiting`] are the message pump's calls, so a message is
//!   dispatched only as the OS queued it.
//! * [`resource_counts`] reads the process's handle counts, which every
//!   platform crate's tests compare before and after; [`testing`] holds the
//!   way they compare them.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

mod com;
mod loop_host;
pub mod process_owner;
mod signal;

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "unported.rs"]
mod platform;

pub use com::{hold_com_for_the_process, ComApartment, ComError};
pub use loop_host::{AlreadyRunning, LoopHost};
pub use platform::{
  discard_quit, dispatch_waiting, messages_waiting, peek_without_removing_for_tests, post_quit_for_tests, resource_counts, SignalWindow, Waker,
};
#[cfg(windows)]
pub use platform::{next_message, wait_message, MessageWindow, Poster, QueuedMessage, Waited, WindowError};

pub mod testing;

/// The process's own resources, for tests that check every handle is given back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceCounts {
  /// `GetGuiResources(GR_USEROBJECTS)`: windows, icons, menus, hooks.
  pub user_objects: u32,
  /// `GetGuiResources(GR_GDIOBJECTS)`.
  pub gdi_objects: u32,
  /// `GetProcessHandleCount`: kernel handles.
  pub kernel_handles: u32,
}
pub use signal::{Signal, SignalError, TimerId};

/// Tests in this crate count the process's handles, so they run one at a time.
#[cfg(test)]
pub(crate) static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
