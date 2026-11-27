//! The shell integrations that are one OS conversation each: clipboard text,
//! URL schemes, single instance, icon refresh.
//!
//! Names, limits and wire formats are today's, so an application built from
//! the TypeScript native layer and one built from this crate find each other.
//! Other platforms get stand-ins that report the platform is not ported yet.
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(clippy::undocumented_unsafe_blocks)]
#![deny(clippy::multiple_unsafe_ops_per_block)]
#![deny(clippy::missing_safety_doc)]

pub mod clipboard;
pub mod icons;
pub mod single_instance;
pub mod url_scheme;

#[cfg(windows)]
mod win;

/// Why a shell call failed. The text is the message today's code throws.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellError(pub String);

impl std::fmt::Display for ShellError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.0)
  }
}

impl std::error::Error for ShellError {}

#[cfg(not(windows))]
pub(crate) fn unported(what: &str) -> ShellError {
  ShellError(format!("sweetview: {what} is not ported to this platform yet"))
}

/// JavaScript's `\s`, which today's `trim()` removes.
pub(crate) fn js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
  )
}

/// Tests in this crate share the clipboard, the registry and the process's
/// handle counts, so they run one at a time.
#[cfg(all(test, windows))]
pub(crate) static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(all(test, windows))]
pub(crate) fn serial() -> std::sync::MutexGuard<'static, ()> {
  TEST_SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
