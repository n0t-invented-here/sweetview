//! Exports of `sweetview_napi::diagnostics`.

use napi::bindgen_prelude::{Function, Uint8Array};
use napi::Env;
use napi_derive::napi;
use sweetview_napi::diagnostics as imp;

use crate::menus::{icon_bytes, IconBytes};

/// After `delayMs`, from inside whichever loop the UI thread is in, calls `transform(input)` and
/// hands what native code received back to `done`: the returned string, or `null` when it threw.
#[napi(catch_unwind)]
pub fn probe_round_trip(
  env: Env,
  delay_ms: u32,
  input: String,
  transform: Function<'_, String, String>,
  done: Function<'_, Option<String>, ()>,
) -> napi::Result<()> {
  imp::probe_round_trip(env, delay_ms, input, transform, done)
}

/// The RGBA a tray or menu icon decodes to at `size` pixels a side; `null` when it carries
/// nothing this platform uses.
#[napi(catch_unwind)]
pub fn decode_icon(icon: IconBytes, size: u32) -> napi::Result<Option<Uint8Array>> {
  imp::decode_icon(icon_bytes(icon), size).map(|pixels| pixels.map(Uint8Array::from))
}
