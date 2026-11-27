//! Platforms whose goal has not built the signal window yet.
//!
//! The types exist so shared code compiles; making one reports that the
//! platform is not ported. The macOS goal replaces this file's use on macOS.

use std::marker::PhantomData;

use crate::signal::{Signal, SignalError, TimerId};

/// See the Windows implementation for the contract. Other platforms have no COM.
pub struct ComApartment {
  _not_send: PhantomData<*const ()>,
}

impl ComApartment {
  pub fn single_threaded() -> Self {
    Self { _not_send: PhantomData }
  }
}

/// See the Windows implementation for the contract.
pub struct SignalWindow {
  _not_send: PhantomData<*const ()>,
}

/// See the Windows implementation for the contract.
#[derive(Clone)]
pub struct Waker {
  _private: (),
}

impl SignalWindow {
  pub fn new(_handler: impl Fn(Signal) + 'static) -> Result<Self, SignalError> {
    Err(SignalError("the signal window is not ported to this platform yet".into()))
  }

  pub fn waker(&self) -> Waker {
    Waker { _private: () }
  }

  pub fn set_timer(&self, _interval_ms: u32) -> Result<TimerId, SignalError> {
    Err(SignalError("native timers are not ported to this platform yet".into()))
  }

  pub fn cancel_timer(&self, _timer: TimerId) {}

  pub fn dispatch_due_timers(&self) {}
}

impl Waker {
  pub fn wake(&self, _token: u64) -> bool {
    false
  }
}
