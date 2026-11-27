//! Everything that lives on Sweetview's UI thread, with no JavaScript in sight.
//!
//! The binding crate is the only caller. It hands this crate plain closures
//! and gets plain values back.
#![forbid(unsafe_code)]

pub mod activation;
pub mod bridge;
pub mod clipboard;
mod error;
pub mod input;
pub mod notify;
pub mod runtime;
pub mod shell;
pub mod threads;

pub use error::{Error, Result};
pub use runtime::{wake, Runtime, TimeoutId};
