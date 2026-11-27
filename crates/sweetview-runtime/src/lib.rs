//! Everything that lives on Sweetview's UI thread, with no JavaScript in sight.
//!
//! The binding crate is the only caller. It hands this crate plain closures
//! and gets plain values back.
#![forbid(unsafe_code)]

mod error;
pub mod runtime;
pub mod screen;
pub mod threads;
pub mod window;

pub use error::{Error, Result};
pub use sweetview_window_logic::{Point, Rect, ResizeEdge};
pub use runtime::{wake, Runtime, TimeoutId};
