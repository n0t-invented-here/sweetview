//! Exports of `sweetview_napi::event_loop`.

use napi::bindgen_prelude::Function;
use napi::Env;
use napi_derive::napi;
use sweetview_napi::event_loop as imp;

/// Stays inside the OS loop until `quitLoop()`. JavaScript runs only as callbacks from inside it.
#[napi(catch_unwind)]
pub fn run_loop() -> napi::Result<()> {
  imp::run_loop()
}

/// Ends the `runLoop()` in progress. With none in progress the quit waits: the next
/// `pumpEvents()` returns false, and the next `runLoop()` returns at once.
#[napi(catch_unwind)]
pub fn quit_loop() -> napi::Result<()> {
  imp::quit_loop()
}

/// Dispatches what is waiting in the OS loop and returns. Called from inside the loop it does nothing.
/// Returns false when a quit was waiting or the thread's quit request (`PostQuitMessage`) ended the pump; either is consumed.
#[napi(catch_unwind)]
pub fn pump_events() -> napi::Result<bool> {
  imp::pump_events()
}

/// Takes back a quit request of this thread, dispatching what is waiting ahead of it.
/// Returns at once when none was made and nothing waits. Returns whether one was taken back.
#[napi(catch_unwind)]
pub fn discard_quit() -> napi::Result<bool> {
  imp::discard_quit()
}

/// True while `runLoop()` is on the stack.
#[napi(catch_unwind)]
pub fn is_loop_blocking() -> napi::Result<bool> {
  imp::is_loop_blocking()
}

/// Calls `job` on a later turn of whichever loop the UI thread is in, a modal one included.
#[napi(catch_unwind)]
pub fn defer(env: Env, job: Function<'_, (), ()>) -> napi::Result<()> {
  imp::defer(env, job)
}

/// Calls `job` once, `delayMs` milliseconds from now, from inside whichever loop the UI thread is in.
#[napi(catch_unwind)]
pub fn schedule_timeout(env: Env, delay_ms: u32, job: Function<'_, (), ()>) -> napi::Result<u32> {
  imp::schedule_timeout(env, delay_ms, job)
}

/// Calls `job` every `intervalMs` milliseconds until it is cancelled.
#[napi(catch_unwind)]
pub fn schedule_interval(env: Env, interval_ms: u32, job: Function<'_, (), ()>) -> napi::Result<u32> {
  imp::schedule_interval(env, interval_ms, job)
}

/// Cancels a timeout or an interval. Cancelling one that is gone does nothing.
#[napi(catch_unwind)]
pub fn cancel_timeout(id: u32) -> napi::Result<()> {
  imp::cancel_timeout(id)
}

/// Sets the function that `wake(token)` runs on the UI thread. `null` removes it.
#[napi(catch_unwind)]
pub fn set_drain(env: Env, token: u32, drain: Option<Function<'_, (), ()>>) -> napi::Result<()> {
  imp::set_drain(env, token, drain)
}

/// Runs the drain function registered under `token` on the UI thread.
/// Callable from any thread: this is how a `Worker` wakes the UI thread.
#[napi(catch_unwind)]
pub fn wake(token: u32) -> bool {
  imp::wake(token)
}
