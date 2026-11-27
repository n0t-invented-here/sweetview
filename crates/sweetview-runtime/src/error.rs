//! The one error type of the runtime.

use std::fmt;

/// The message of [`Error::NotUiThread`]. Applications see it as the text of a thrown `Error`.
pub const NOT_UI_THREAD: &str = "sweetview: this call must be made on the UI thread";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
  /// A UI-thread function was called from another thread.
  NotUiThread,
  /// The OS, or a crate over it, refused. The text says which call and why.
  Os(String),
  /// The caller asked for something that cannot be done in the current state.
  State(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
  pub fn os(context: &str, cause: impl fmt::Display) -> Self {
    Error::Os(format!("sweetview: {context}: {cause}"))
  }

  pub fn state(message: impl Into<String>) -> Self {
    Error::State(message.into())
  }
}

impl fmt::Display for Error {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Error::NotUiThread => f.write_str(NOT_UI_THREAD),
      Error::Os(message) | Error::State(message) => f.write_str(message),
    }
  }
}

impl std::error::Error for Error {}
