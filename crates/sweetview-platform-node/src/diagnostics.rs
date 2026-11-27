//! Exports of `sweetview_napi::diagnostics`.

use napi::bindgen_prelude::Function;
use napi::Env;
use napi_derive::napi;
use sweetview_napi::diagnostics as imp;

/// After `delayMs`, from inside whichever loop the UI thread is in, calls `transform(input)` and
/// hands what native code received back to `done`: the returned string, or `null` when it threw.
#[napi]
pub fn probe_round_trip(
  env: Env,
  delay_ms: u32,
  input: String,
  transform: Function<'_, String, String>,
  done: Function<'_, Option<String>, ()>,
) -> napi::Result<()> {
  imp::probe_round_trip(env, delay_ms, input, transform, done)
}
