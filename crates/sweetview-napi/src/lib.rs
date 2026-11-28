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
pub mod objects;
pub mod shell;
pub mod tab_frame;
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

/// Also when the binding is loaded, with that thread's environment: makes the guard every callback
/// is held through (`callback.rs`), so what it captures of the global object (`Reflect.apply`,
/// `Object.create`, `String`) is what the environment had when the binding loaded, not what an
/// application left there by the time it makes its first callback.
pub fn prepare_environment(env: napi::Env) -> napi::Result<()> {
  callback::prepare_guard(&env)
}

/// True on the thread that loaded the binding first.
pub fn is_ui_thread() -> bool {
  sweetview_runtime::threads::is_ui_thread()
}

/// The end of the application: releases everything the binding made on the UI thread that
/// is still alive (hooks, webviews, trays, notifiers, single-instance locks, menus, windows,
/// then timers and callbacks), in that order. Does nothing on another thread. The callback error
/// sink is not released here: an `onCallbackError` listener still hears of what happens after,
/// and the environment's cleanup hook releases the sink when the environment ends.
pub fn release_all() {
  sweetview_runtime::lifetime::release_all();
}
