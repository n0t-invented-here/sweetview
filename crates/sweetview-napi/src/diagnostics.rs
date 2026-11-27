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

/// The RGBA a tray or menu icon decodes to at `size` pixels a side, as the binding decodes it;
/// `null` when the icon carries nothing this platform uses. Throws with the reason it cannot be decoded.
pub fn decode_icon(icon: sweetview_runtime::icon::IconBytes, size: u32) -> napi::Result<Option<Vec<u8>>> {
  if !(1..=256).contains(&size) {
    return Err(napi::Error::from_reason(format!("sweetview: an icon size is 1 to 256 pixels, not {size}")));
  }
  icon.rgba(size).map(|image| image.map(|image| image.pixels)).map_err(|e| napi::Error::from_reason(format!("sweetview: {e}")))
}
