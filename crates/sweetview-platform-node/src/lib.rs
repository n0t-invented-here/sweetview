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
#[cfg(feature = "webview")]
pub mod engine;
pub mod event_loop;
pub mod input;
pub mod notify;
pub mod shell;
pub mod tab_frame;
pub mod screen;
pub mod types;
pub mod window;
pub mod menus;

use napi_derive::napi;

/// Runs when the binding is loaded, once per JavaScript thread that loads it. `module_exports`
/// takes no `catch_unwind` attribute, so the panic is caught here and the load fails with an error.
#[napi(module_exports)]
pub fn on_load(_exports: napi::bindgen_prelude::Object, env: napi::Env) -> napi::Result<()> {
  std::panic::catch_unwind(sweetview_napi::on_load).map_err(|_| napi::Error::from_reason("sweetview: the binding panicked while it was loading"))?;
  sweetview_napi::prepare_environment(env)
}

/// The file of the binding that owns this process: `file` when this is the process's first claim,
/// else the file the first claim recorded, which the loader then uses on every thread (D50).
#[napi(catch_unwind)]
pub fn claim_process(file: String) -> napi::Result<String> {
  sweetview_napi::claim_process(&file)
}

/// True on the thread that loaded the binding first.
#[napi(catch_unwind)]
pub fn is_ui_thread() -> bool {
  sweetview_napi::is_ui_thread()
}

/// The end of the application: releases everything the binding made on the UI thread that is
/// still alive, in a safe order: the input hooks, the webviews (each before its window), the
/// tray icons, the notifiers, the single-instance locks, the menus handed out, the windows, then
/// the timers and callbacks. The TypeScript layer calls it when the blocking loop has returned
/// and when the process exits. Objects made afterwards work as usual. Does nothing on another thread.
#[napi(catch_unwind)]
pub fn release_all() {
  sweetview_napi::release_all();
}
