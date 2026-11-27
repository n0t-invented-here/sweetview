//! Everything that lives on Sweetview's UI thread, with no JavaScript in sight.
//!
//! The binding crate is the only caller. It hands this crate plain closures
//! and gets plain values back.
#![forbid(unsafe_code)]

pub mod app;
pub mod dialogs;
mod error;
pub mod icon;
pub mod menu;
pub mod runtime;
pub mod threads;
pub mod tray;

pub use error::{Error, Result};
pub use runtime::{wake, Runtime, TimeoutId};
