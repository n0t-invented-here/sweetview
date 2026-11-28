//! Colour keys and background colours.

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

/// A window's background colour, `#rrggbb` (the `#` optional, either case),
/// as red, green and blue. Anything else is an error carrying the message
/// applications see.
pub fn parse_background_color(text: &str) -> Result<(u8, u8, u8), String> {
  let rgb = parse_color_key(text).map_err(|_| format!("sweetview: background color must be #rrggbb, got {text}"))?;
  Ok(((rgb & 0xff) as u8, ((rgb >> 8) & 0xff) as u8, ((rgb >> 16) & 0xff) as u8))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_background_color_is_red_green_blue() {
    assert_eq!(parse_background_color("#1e1e2e"), Ok((0x1e, 0x1e, 0x2e)));
    assert_eq!(parse_background_color("FFFFFF"), Ok((255, 255, 255)));
    assert_eq!(parse_background_color("#ff8000"), Ok((255, 128, 0)));
    assert_eq!(parse_background_color("#fff"), Err("sweetview: background color must be #rrggbb, got #fff".into()));
    assert!(parse_background_color("rgb(0,0,0)").is_err());
  }

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
