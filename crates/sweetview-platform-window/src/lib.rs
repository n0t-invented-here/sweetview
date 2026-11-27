//! The window-level OS calls `tao` has no API for.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

mod metrics;
mod popup;

pub use metrics::{double_click_time_ms, small_icon_size};
pub use popup::{show_popup, OwnerWindow, PopupAt};
