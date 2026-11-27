//! What a window should do next, decided from cursor positions, button states and bounds.
//!
//! No OS call happens here. The runtime reads the cursor, the buttons and the
//! window's bounds through the platform crate, asks this crate what follows,
//! and applies the answer.
#![forbid(unsafe_code)]

pub mod color;
pub mod geometry;
pub mod hit;
pub mod ico;
pub mod resize;
pub mod screen;
pub mod style;

pub use color::parse_color_key;
pub use geometry::{Point, Rect};
pub use hit::{hit_regions, HitState, HitStep};
pub use resize::{resize_from_edge, toggle_frameless_maximize, MinSize, ResizeEdge, DEFAULT_MIN_SIZE};
pub use style::ExStylePolicy;
