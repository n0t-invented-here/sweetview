//! What a [`SignalWindow`](crate::SignalWindow) delivers.

use std::fmt;

/// Names one native timer of a [`SignalWindow`](crate::SignalWindow).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimerId(pub usize);

/// One delivery to the UI thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
  /// A [`Waker`](crate::Waker) was fired with this token, from any thread.
  Wake(u64),
  /// A timer came due. A timer repeats until it is cancelled.
  Timer(TimerId),
}

/// A signal window could not be made, or a timer could not be set.
#[derive(Debug)]
pub struct SignalError(pub(crate) String);

impl fmt::Display for SignalError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(&self.0)
  }
}

impl std::error::Error for SignalError {}
