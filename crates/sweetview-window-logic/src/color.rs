//! Colour keys.

/// `#rrggbb` (the `#` optional, either case) to a `COLORREF`, `0x00bbggrr`.
/// Anything else is an error carrying the message applications see.
pub fn parse_color_key(text: &str) -> Result<u32, String> {
  let hex = text.strip_prefix('#').unwrap_or(text);
  let valid = hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit());
  let parsed = if valid { u32::from_str_radix(hex, 16).ok() } else { None };
  let Some(n) = parsed else {
    return Err(format!("sweetview: color key must be #rrggbb, got {text}"));
  };
  Ok(((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn swaps_rrggbb_into_colorref() {
    assert_eq!(parse_color_key("#ff00ff"), Ok(0x00ff00ff));
    assert_eq!(parse_color_key("#112233"), Ok(0x00332211));
    assert_eq!(parse_color_key("00ff00"), Ok(0x0000ff00));
    assert_eq!(parse_color_key("#AbCdEf"), Ok(0x00efcdab));
  }

  #[test]
  fn rejects_anything_else() {
    assert_eq!(parse_color_key("#fff"), Err("sweetview: color key must be #rrggbb, got #fff".into()));
    assert!(parse_color_key("magenta").is_err());
    assert!(parse_color_key("#+12345").is_err());
    assert!(parse_color_key("##ff00ff").is_err());
  }
}
