//! The window-level OS calls `tao` has no API for, and the events of any window by subclass.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

mod foreign;

pub use foreign::ForeignWindow;
