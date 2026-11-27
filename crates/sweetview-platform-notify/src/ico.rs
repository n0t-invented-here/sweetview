//! Reading an `.ico` file's directory and picking the image for a size, as
//! today's `parseIco` and `pickIcoEntry` do. Pure logic.

use crate::NotifyError;

/// One image of an `.ico` file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IcoEntry {
  pub width: u32,
  pub height: u32,
  pub offset: usize,
  pub size: usize,
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
  u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
  u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// The images an `.ico` file lists, each checked to lie inside the file.
pub fn parse_ico(bytes: &[u8]) -> Result<Vec<IcoEntry>, NotifyError> {
  if bytes.len() < 6 || u16_at(bytes, 2) != 1 {
    return Err(NotifyError("not a .ico file".into()));
  }
  let count = usize::from(u16_at(bytes, 4));
  let mut entries = Vec::with_capacity(count);
  for index in 0..count {
    let at = 6 + index * 16;
    if at + 16 > bytes.len() {
      return Err(NotifyError("truncated .ico directory".into()));
    }
    let width = if bytes[at] == 0 { 256 } else { u32::from(bytes[at]) };
    let height = if bytes[at + 1] == 0 { 256 } else { u32::from(bytes[at + 1]) };
    let size = u32_at(bytes, at + 8) as usize;
    let offset = u32_at(bytes, at + 12) as usize;
    if offset.checked_add(size).is_none_or(|end| end > bytes.len()) {
      return Err(NotifyError(format!(".ico image {index} runs past the end of the file")));
    }
    entries.push(IcoEntry { width, height, offset, size });
  }
  Ok(entries)
}

/// The entry `want` pixels wide, else the smallest wider one, else the widest.
pub fn pick_entry(entries: &[IcoEntry], want: u32) -> Result<IcoEntry, NotifyError> {
  if let Some(exact) = entries.iter().find(|e| e.width == want) {
    return Ok(*exact);
  }
  let larger = entries.iter().filter(|e| e.width > want).min_by_key(|e| e.width);
  // `max_by_key` keeps the last of equals; today's sort keeps the first.
  let widest = entries.iter().rev().max_by_key(|e| e.width);
  larger.or(widest).copied().ok_or_else(|| NotifyError(".ico has no images".into()))
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  /// A two-image `.ico` (16 and 32 pixels) of 32bpp DIBs, made in memory.
  pub(crate) fn sample_ico() -> Vec<u8> {
    let sizes = [16u32, 32];
    let mut images: Vec<Vec<u8>> = Vec::new();
    for &px in &sizes {
      let mut image = Vec::new();
      // BITMAPINFOHEADER: height is doubled for the AND mask.
      image.extend_from_slice(&40u32.to_le_bytes());
      image.extend_from_slice(&(px as i32).to_le_bytes());
      image.extend_from_slice(&((px * 2) as i32).to_le_bytes());
      image.extend_from_slice(&1u16.to_le_bytes());
      image.extend_from_slice(&32u16.to_le_bytes());
      image.extend_from_slice(&[0u8; 24]);
      for _ in 0..px * px {
        image.extend_from_slice(&[0x20, 0x80, 0xE0, 0xFF]);
      }
      // AND mask: one bit per pixel, rows padded to 32 bits.
      image.extend(std::iter::repeat_n(0u8, (px.div_ceil(32) * 4 * px) as usize));
      images.push(image);
    }
    let mut ico = Vec::new();
    ico.extend_from_slice(&0u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * sizes.len();
    for (image, &px) in images.iter().zip(&sizes) {
      ico.extend_from_slice(&[px as u8, px as u8, 0, 0]);
      ico.extend_from_slice(&1u16.to_le_bytes());
      ico.extend_from_slice(&32u16.to_le_bytes());
      ico.extend_from_slice(&(image.len() as u32).to_le_bytes());
      ico.extend_from_slice(&(offset as u32).to_le_bytes());
      offset += image.len();
    }
    for image in images {
      ico.extend_from_slice(&image);
    }
    ico
  }

  #[test]
  fn parses_the_directory_and_picks_like_todays_code() {
    let ico = sample_ico();
    let entries = parse_ico(&ico).expect("parse");
    assert_eq!(entries.iter().map(|e| e.width).collect::<Vec<_>>(), [16, 32]);
    assert_eq!(pick_entry(&entries, 16).unwrap().width, 16);
    assert_eq!(pick_entry(&entries, 24).unwrap().width, 32);
    assert_eq!(pick_entry(&entries, 48).unwrap().width, 32);
    assert_eq!(pick_entry(&[], 16).unwrap_err().0, ".ico has no images");
  }

  #[test]
  fn rejects_what_today_rejects() {
    assert_eq!(parse_ico(b"PNG").unwrap_err().0, "not a .ico file");
    assert_eq!(parse_ico(&[0, 0, 2, 0, 1, 0]).unwrap_err().0, "not a .ico file");
    assert_eq!(parse_ico(&[0, 0, 1, 0, 1, 0, 16]).unwrap_err().0, "truncated .ico directory");
    let mut ico = sample_ico();
    ico.truncate(ico.len() - 1);
    assert_eq!(parse_ico(&ico).unwrap_err().0, ".ico image 1 runs past the end of the file");
  }

  #[test]
  fn a_zero_dimension_means_256() {
    let mut ico = vec![0, 0, 1, 0, 1, 0];
    ico.extend_from_slice(&[0, 0, 0, 0, 1, 0, 32, 0]);
    ico.extend_from_slice(&0u32.to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    let entries = parse_ico(&ico).expect("parse");
    assert_eq!((entries[0].width, entries[0].height), (256, 256));
  }
}
