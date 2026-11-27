//! Platforms whose goal has not built the hooks yet.
//!
//! The types exist so shared code compiles; installing one reports that the
//! platform has no hooks yet, with the code the C API gives for a platform
//! without hooks. The macOS goal replaces this file's use on macOS.

use std::marker::PhantomData;

use crate::events::{HookError, KeyEvent, MouseEvent};

/// See the Windows implementation for the contract.
pub struct MouseHook {
  _not_send: PhantomData<*const ()>,
}

impl MouseHook {
  pub fn install(_handler: impl Fn(&MouseEvent) -> bool + 'static) -> Result<MouseHook, HookError> {
    Err(HookError::Os("mouse hooks are not ported to this platform yet".into()))
  }

  pub fn remove(self) -> Result<(), HookError> {
    Ok(())
  }
}

/// See the Windows implementation for the contract.
pub struct KeyboardHook {
  _not_send: PhantomData<*const ()>,
}

impl KeyboardHook {
  pub fn install(_handler: impl Fn(&KeyEvent) -> bool + 'static) -> Result<KeyboardHook, HookError> {
    Err(HookError::Os("keyboard hooks are not ported to this platform yet".into()))
  }

  pub fn remove(self) -> Result<(), HookError> {
    Ok(())
  }
}
