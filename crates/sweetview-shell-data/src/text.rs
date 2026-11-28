//! Text as today's code reads it.

/// JavaScript's `\s`, which today's `trim()` and checks use. It differs from
/// Unicode `White_Space` in two characters: it has U+FEFF and lacks U+0085.
pub fn js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn whitespace_is_javascripts() {
    for c in ['\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}'] {
      assert!(js_whitespace(c), "{c:?}");
    }
    for c in ['a', '\u{85}', '\u{200b}', '\0'] {
      assert!(!js_whitespace(c), "{c:?}");
    }
  }
}
