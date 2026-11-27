//! The parts of the UI thread's event loop that `tao` has no API for.
//!
//! * [`LoopHost`] owns the `tao` event loop and hands its window target to code
//!   that runs while the loop is running.
//! * [`SignalWindow`] delivers wakes from other threads and native timers through
//!   whichever message loop the UI thread is in, a modal one included.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

mod loop_host;
mod signal;

#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "unported.rs"]
mod platform;

pub use loop_host::{AlreadyRunning, LoopHost};
pub use platform::{SignalWindow, Waker};
pub use signal::{Signal, SignalError, TimerId};

/// Tests in this crate count the process's handles, so they run one at a time.
#[cfg(test)]
pub(crate) static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
