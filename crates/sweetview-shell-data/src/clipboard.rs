//! The text the clipboard holds: `CF_UNICODETEXT`, UTF-16LE with a NUL
//! terminator.

use crate::ShellError;

/// Decodes `CF_UNICODETEXT` bytes up to the first NUL. `bytes` is the whole
/// global block (`GlobalSize` bounds it); a trailing odd byte is padding.
pub fn decode_unicode_text(bytes: &[u8]) -> Result<String, ShellError> {
  let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
  let end = units.iter().position(|&unit| unit == 0).ok_or_else(|| ShellError("sweetview: CF_UNICODETEXT has no NUL terminator".into()))?;
  Ok(String::from_utf16_lossy(&units[..end]))
}

/// The bytes written as `CF_UNICODETEXT`: UTF-16LE with a NUL terminator.
pub fn encode_unicode_text(text: &str) -> Vec<u8> {
  text.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn text_is_framed_as_nul_terminated_utf16() {
    assert_eq!(encode_unicode_text("A\u{e9}"), [0x41, 0, 0xe9, 0, 0, 0]);
    assert_eq!(decode_unicode_text(&encode_unicode_text("h\u{e9}llo \u{1f600}")).unwrap(), "h\u{e9}llo \u{1f600}");
    assert_eq!(decode_unicode_text(&encode_unicode_text("")).unwrap(), "");
    // Padding after the terminator, and an odd trailing byte, are not text.
    assert_eq!(decode_unicode_text(&[0x41, 0, 0, 0, 0x42, 0, 7]).unwrap(), "A");
    assert_eq!(decode_unicode_text(&[0x41, 0, 0x42]).unwrap_err().0, "sweetview: CF_UNICODETEXT has no NUL terminator");
  }
}
