//! The binding: where JavaScript values and functions are converted and handed to the runtime.
//!
//! Every function JavaScript can call is an ordinary safe function here. The
//! export table that makes them visible to JavaScript is the crate
//! `sweetview-platform-node`, because the `#[napi]` attribute expands to
//! `unsafe extern "C"` code and this crate forbids `unsafe`.
#![forbid(unsafe_code)]

mod callback;
pub mod diagnostics;
pub mod engine;
mod errors;
pub mod event_loop;
pub mod input;
pub mod notify;
pub mod shell;
pub mod screen;
pub mod window;

pub use sweetview_runtime::screen::ScreenInfo;
pub use sweetview_runtime::window::{Appearance, Chrome, WindowInit};
pub use sweetview_runtime::{Point, Rect};
pub mod menus;

/// Runs when the binding is loaded, once per JavaScript thread that loads it.
/// The first thread to load it is the UI thread.
pub fn on_load() {
  sweetview_runtime::threads::claim_ui_thread();
}

/// True on the thread that loaded the binding first.
pub fn is_ui_thread() -> bool {
  sweetview_runtime::threads::is_ui_thread()
}
