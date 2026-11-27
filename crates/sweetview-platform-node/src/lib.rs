//! The export table of the binding: the items that carry the `#[napi]` attribute.
//!
//! Every item forwards to `sweetview-napi`, where the behaviour lives under
//! `#![forbid(unsafe_code)]`. The attribute expands to `unsafe extern "C"`
//! trampolines, which is why these items cannot live there. There is no
//! hand-written `unsafe` in this crate.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]
// The TypeScript declarations are generated from the signature text of each `#[napi]` item, and
// a type alias would erase a callback's parameter types there, so callback types are written out.
#![allow(clippy::type_complexity)]

pub mod diagnostics;
pub mod engine;
pub mod event_loop;
pub mod input;
pub mod notify;
pub mod shell;

use napi_derive::napi;

/// Runs when the binding is loaded, once per JavaScript thread that loads it.
#[napi(module_exports)]
pub fn on_load(_exports: napi::bindgen_prelude::Object) -> napi::Result<()> {
  sweetview_napi::on_load();
  Ok(())
}

/// True on the thread that loaded the binding first.
#[napi]
pub fn is_ui_thread() -> bool {
  sweetview_napi::is_ui_thread()
}
