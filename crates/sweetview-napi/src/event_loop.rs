//! Both loop modes, deferred jobs, native timeouts, and the wake a `Worker` calls.

use napi::bindgen_prelude::{FnArgs, Function};
use napi::Env;
use sweetview_runtime::{Runtime, TimeoutId};

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// Stays inside the OS loop until `quitLoop()`. JavaScript runs only as callbacks from inside it.
pub fn run_loop() -> napi::Result<()> {
  Runtime::get().or_throw()?.run_blocking().or_throw()
}

/// Ends the `runLoop()` in progress. With none in progress the quit waits: the next
/// `pumpEvents()` returns false, and the next `runLoop()` returns at once.
pub fn quit_loop() -> napi::Result<()> {
  Runtime::get().or_throw()?.request_exit();
  Ok(())
}

/// Dispatches what is waiting in the OS loop and returns. Called from inside the loop it does nothing.
/// Returns false when a quit was waiting or the thread's quit request (`PostQuitMessage`) ended the pump; either is consumed.
pub fn pump_events() -> napi::Result<bool> {
  Ok(Runtime::get().or_throw()?.pump())
}

/// Takes back a quit request of this thread, dispatching what is waiting ahead of it.
/// Returns at once when none was made and nothing waits. Returns whether one was taken back.
pub fn discard_quit() -> napi::Result<bool> {
  Ok(Runtime::get().or_throw()?.discard_quit())
}

/// True while `runLoop()` is on the stack.
pub fn is_loop_blocking() -> napi::Result<bool> {
  Ok(Runtime::get().or_throw()?.is_blocking())
}

/// Makes `sink` where an exception a JavaScript callback threw goes on this thread, with the
/// callback's kind and the exception's message, in place of the `sweetview: <kind> threw:` line on
/// stderr; `null` puts the line back. `onCallbackError` sets it while it has a listener. On the UI
/// thread only: no other thread runs the callbacks it would hear of.
pub fn set_callback_error_sink(env: Env, sink: Option<Function<'_, FnArgs<(String, String)>, ()>>) -> napi::Result<()> {
  sweetview_runtime::threads::require_ui_thread().or_throw()?;
  crate::callback::set_error_sink(env, sink.as_ref())
}

/// Calls `job` on a later turn of whichever loop the UI thread is in, a modal one included.
pub fn defer(env: Env, job: Function<'_, (), ()>) -> napi::Result<()> {
  let job = JsCallback::new(env, &job, "a deferred job")?;
  Runtime::get().or_throw()?.defer(move || {
    job.call(());
  });
  Ok(())
}

/// Calls `job` once, `delayMs` milliseconds from now, from inside whichever loop the UI thread is in.
pub fn schedule_timeout(env: Env, delay_ms: u32, job: Function<'_, (), ()>) -> napi::Result<u32> {
  let job = JsCallback::new(env, &job, "a native timeout")?;
  let id = Runtime::get()
    .or_throw()?
    .set_timeout(delay_ms, move || {
      job.call(());
    })
    .or_throw()?;
  Ok(id.0)
}

/// Calls `job` every `intervalMs` milliseconds until it is cancelled.
pub fn schedule_interval(env: Env, interval_ms: u32, job: Function<'_, (), ()>) -> napi::Result<u32> {
  let job = JsCallback::new(env, &job, "a native interval")?;
  let id = Runtime::get()
    .or_throw()?
    .set_interval(interval_ms, move || {
      job.call(());
    })
    .or_throw()?;
  Ok(id.0)
}

/// Cancels a timeout or an interval. Cancelling one that is gone does nothing.
pub fn cancel_timeout(id: u32) -> napi::Result<()> {
  Runtime::get().or_throw()?.clear_timeout(TimeoutId(id));
  Ok(())
}

/// Sets the function that `wake(token)` runs on the UI thread. `null` removes it.
pub fn set_drain(env: Env, token: u32, drain: Option<Function<'_, (), ()>>) -> napi::Result<()> {
  if token == 0 {
    return Err(napi::Error::from_reason("sweetview: wake token 0 is reserved"));
  }
  let runtime = Runtime::get().or_throw()?;
  match drain {
    Some(drain) => {
      let drain = JsCallback::new(env, &drain, "a drain function")?;
      runtime.set_drain(
        u64::from(token),
        Some(std::rc::Rc::new(move || {
          drain.call(());
        })),
      );
    }
    None => runtime.set_drain(u64::from(token), None),
  }
  Ok(())
}

/// Runs the drain function registered under `token` on the UI thread.
/// Callable from any thread: this is how a `Worker` wakes the UI thread.
/// Returns false when there is nothing to wake.
pub fn wake(token: u32) -> bool {
  token != 0 && sweetview_runtime::wake(u64::from(token))
}
