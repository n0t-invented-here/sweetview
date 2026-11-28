//! Everything that lives on Sweetview's UI thread, with no JavaScript in sight.
//!
//! The binding crate is the only caller. It hands this crate plain closures
//! and gets plain values back.
#![forbid(unsafe_code)]

pub mod activation;
pub mod bridge;
pub mod clipboard;
pub mod engine;
mod error;
pub mod input;
pub mod lifetime;
pub mod notify;
pub mod app;
pub mod dialogs;
pub mod icon;
pub mod menu;
pub mod runtime;
pub mod shell;
pub mod screen;
pub mod threads;
pub mod window;
pub mod tray;

#[cfg(all(test, windows))]
mod loop_tests;

pub use error::{Error, Result};
pub use sweetview_window_logic::{Point, Rect, ResizeEdge};
pub use runtime::{wake, Runtime, TimeoutId};
