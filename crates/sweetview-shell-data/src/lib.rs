//! The data the shell integrations and notifications write, read and check,
//! built and checked without an OS call.
//!
//! The platform crates make the OS calls and use these functions for
//! everything around them.
#![forbid(unsafe_code)]

pub mod error;
pub mod single_instance;
pub mod text;
pub mod url_scheme;

pub use error::ShellError;
pub use text::js_whitespace;
