//! Exports of `sweetview_napi::event_loop`.

use napi::bindgen_prelude::Function;
use napi::Env;
use napi_derive::napi;
use sweetview_napi::event_loop as imp;

/// Stays inside the OS loop until `quitLoop()`. JavaScript runs only as callbacks from inside it.
#[napi]
pub fn run_loop() -> napi::Result<()> {
  imp::run_loop()
}

/// Ends the `runLoop()` in progress. With none in progress it does nothing.
#[napi]
pub fn quit_loop() -> napi::Result<()> {
  imp::quit_loop()
}

/// Dispatches what is waiting in the OS loop and returns. Called from inside the loop it does nothing.
#[napi]
pub fn pump_events() -> napi::Result<()> {
  imp::pump_events()
}

/// True while `runLoop()` is on the stack.
#[napi]
pub fn is_loop_blocking() -> napi::Result<bool> {
  imp::is_loop_blocking()
}

/// Calls `job` on a later turn of whichever loop the UI thread is in, a modal one included.
#[napi]
pub fn defer(env: Env, job: Function<'_, (), ()>) -> napi::Result<()> {
  imp::defer(env, job)
}

/// Calls `job` once, `delayMs` milliseconds from now, from inside whichever loop the UI thread is in.
#[napi]
pub fn schedule_timeout(env: Env, delay_ms: u32, job: Function<'_, (), ()>) -> napi::Result<u32> {
  imp::schedule_timeout(env, delay_ms, job)
}

/// Calls `job` every `intervalMs` milliseconds until it is cancelled.
#[napi]
pub fn schedule_interval(env: Env, interval_ms: u32, job: Function<'_, (), ()>) -> napi::Result<u32> {
  imp::schedule_interval(env, interval_ms, job)
}

/// Cancels a timeout or an interval. Cancelling one that is gone does nothing.
#[napi]
pub fn cancel_timeout(id: u32) -> napi::Result<()> {
  imp::cancel_timeout(id)
}

/// Sets the function that `wake(token)` runs on the UI thread. `null` removes it.
#[napi]
pub fn set_drain(env: Env, token: u32, drain: Option<Function<'_, (), ()>>) -> napi::Result<()> {
  imp::set_drain(env, token, drain)
}

/// Runs the drain function registered under `token` on the UI thread.
/// Callable from any thread: this is how a `Worker` wakes the UI thread.
#[napi]
pub fn wake(token: u32) -> bool {
  imp::wake(token)
}
