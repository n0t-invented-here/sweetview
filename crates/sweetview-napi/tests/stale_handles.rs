//! A handle that names no webview, given to the functions any thread may call: each refuses it
//! with `WEBVIEW_ERROR_INVALID_STATE` (-3), and `Engine.fromHandle` finds none. There is no NULL
//! pointer to pass to them, so 0 is such a handle too. Moved here from the native package's
//! `request-handler.test.ts` (W2.7 binding exports).

use napi::bindgen_prelude::{BigInt, Uint8Array};
use sweetview_napi::engine::{begin_response, complete_request, end_response, write_response_chunk, Engine};

const INVALID_STATE: i32 = -3;

#[test]
fn a_handle_that_names_no_webview_is_refused_by_every_responder_function_and_names_no_engine() {
  sweetview_napi::on_load();
  for stale in [0, 0x1000] {
    assert_eq!(complete_request(stale, BigInt::from(1u64), 200, None, None), INVALID_STATE, "complete, handle {stale}");
    assert_eq!(complete_request(stale, BigInt::from(0u64), 200, None, None), INVALID_STATE, "complete with request 0, handle {stale}");
    assert_eq!(begin_response(stale, BigInt::from(1u64), 200, None), INVALID_STATE, "begin, handle {stale}");
    assert_eq!(write_response_chunk(stale, BigInt::from(1u64), Uint8Array::from(Vec::new())), INVALID_STATE, "write, handle {stale}");
    assert_eq!(end_response(stale, BigInt::from(1u64)), INVALID_STATE, "end, handle {stale}");
    assert!(Engine::from_handle(stale).expect("on the UI thread").is_none(), "fromHandle, handle {stale}");
  }
}
