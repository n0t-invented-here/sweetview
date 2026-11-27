//! Runtime errors become thrown JavaScript errors with the runtime's own text.

use sweetview_runtime::Error as RuntimeError;

pub(crate) fn thrown(error: RuntimeError) -> napi::Error {
  napi::Error::from_reason(error.to_string())
}

/// `?` on a runtime result inside a `#[napi]` function.
pub(crate) trait OrThrow<T> {
  fn or_throw(self) -> napi::Result<T>;
}

impl<T> OrThrow<T> for sweetview_runtime::Result<T> {
  fn or_throw(self) -> napi::Result<T> {
    self.map_err(thrown)
  }
}
