//! Probes of the boundary itself, for the tests that prove it.

use napi::bindgen_prelude::Function;
use napi::Env;
use sweetview_runtime::Runtime;

use crate::callback::JsCallback;
use crate::errors::OrThrow;

/// After `delay_ms`, from inside whichever loop the UI thread is in, calls
/// `transform(input)` and hands what native code received back to `done`:
/// the returned string, or `null` when `transform` threw.
pub fn probe_round_trip(
  env: Env,
  delay_ms: u32,
  input: String,
  transform: Function<'_, String, String>,
  done: Function<'_, Option<String>, ()>,
) -> napi::Result<()> {
  let transform = JsCallback::new(env, &transform, "a probe")?;
  let done = JsCallback::new(env, &done, "a probe's completion")?;
  Runtime::get()
    .or_throw()?
    .set_timeout(delay_ms, move || {
      let received = transform.call(input);
      done.call(received);
    })
    .or_throw()?;
  Ok(())
}
