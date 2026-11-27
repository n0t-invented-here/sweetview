//! The plain data the binding's functions take and return, as JavaScript objects.
//!
//! The shapes and their conversions live in `sweetview_napi::objects`; they are named here so the
//! export table's signatures can use them.

pub use sweetview_napi::objects::{Detected, MenuEntryData, Point, Rect, ScreenData, WindowInit};
