//! Which thread is the UI thread.
//!
//! The UI thread is the thread that first claims it: the thread that loads the
//! binding first, which is the Bun main thread. Every other thread (a Bun
//! `Worker` that loads the binding again) may call only the functions
//! documented as callable from any thread.

use std::sync::{Mutex, PoisonError};
use std::thread::{self, ThreadId};

use crate::error::{Error, Result};

static UI_THREAD: Mutex<Option<ThreadId>> = Mutex::new(None);

/// Makes the calling thread the UI thread unless one is claimed already.
/// Returns true when the calling thread is the UI thread afterwards.
pub fn claim_ui_thread() -> bool {
  let mut owner = UI_THREAD.lock().unwrap_or_else(PoisonError::into_inner);
  *owner.get_or_insert_with(|| thread::current().id()) == thread::current().id()
}

/// True on the UI thread. False on every thread before one is claimed.
pub fn is_ui_thread() -> bool {
  *UI_THREAD.lock().unwrap_or_else(PoisonError::into_inner) == Some(thread::current().id())
}

/// The check every UI-thread entry point makes first.
pub fn require_ui_thread() -> Result<()> {
  if is_ui_thread() {
    Ok(())
  } else {
    Err(Error::NotUiThread)
  }
}

/// Gives the claim up, so another test thread can be the UI thread. Tests
/// only: a process has one UI thread for its whole life.
#[doc(hidden)]
pub fn release_ui_thread_for_tests() {
  let mut owner = UI_THREAD.lock().unwrap_or_else(PoisonError::into_inner);
  if *owner == Some(thread::current().id()) {
    *owner = None;
  }
}
