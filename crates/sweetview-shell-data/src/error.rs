//! The errors the shell integrations and notifications report. The text is the
//! message today's code throws.

/// Why a shell call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellError(pub String);

impl std::fmt::Display for ShellError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.0)
  }
}

impl std::error::Error for ShellError {}
