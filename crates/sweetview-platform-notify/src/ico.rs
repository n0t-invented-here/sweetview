//! Reading an `.ico` file's directory and picking the image for a size, without an
//! OS call, in `sweetview-window-logic`, and named here as before.

pub use sweetview_window_logic::ico::{parse_ico, pick_ico_entry_keeping_first as pick_entry, IcoEntry};

#[cfg(test)]
pub(crate) mod tests {
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
}
