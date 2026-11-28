//! Icons as the binding receives them, decoded to the RGBA `tray-icon` and `muda` take.
//!
//! An application hands Sweetview an icon as file bytes: a `.ico` for Windows
//! (several sizes in one file), a PNG, or on macOS an SF Symbol name. The tray
//! and menus need one square image at the size they draw, so the best-fitting
//! image is picked and, when it is not exactly that size, resampled.

use std::io::Cursor;

/// One icon, as Sweetview's `Icon` type carries it to the binding.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IconBytes {
  /// A `.ico` file's bytes.
  pub ico: Option<Vec<u8>>,
  /// A PNG file's bytes.
  pub png: Option<Vec<u8>>,
  /// An SF Symbol name (macOS).
  pub symbol: Option<String>,
  /// Recoloured by the system for light and dark (macOS).
  pub template: Option<bool>,
}

/// A square top-down RGBA image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
  pub size: u32,
  pub pixels: Vec<u8>,
}

impl IconBytes {
  /// The image this platform draws, at `size` pixels a side. `Ok(None)` when
  /// the icon carries nothing this platform uses, so the caller shows its
  /// stock image. Windows reads the `.ico`, then the PNG.
  pub fn rgba(&self, size: u32) -> Result<Option<Rgba>, String> {
    if let Some(ico) = &self.ico {
      return ico_rgba(ico, size).map(Some);
    }
    if let Some(png) = &self.png {
      return png_rgba(png, size).map(Some);
    }
    Ok(None)
  }
}

/// The width of the `.ico` image to use for `want`: the one of exactly that
/// width, else the smallest larger one, else the largest. This is the rule
/// Sweetview has always used (`pickIcoEntry` in `icon.ts`), so a file with 16,
/// 20, 24 and 32 px images gives each DPI its own.
pub fn pick_ico_width(widths: &[u32], want: u32) -> Option<usize> {
  if let Some(exact) = widths.iter().position(|w| *w == want) {
    return Some(exact);
  }
  let larger = widths.iter().enumerate().filter(|(_, w)| **w > want).min_by_key(|(_, w)| **w);
  larger.or_else(|| widths.iter().enumerate().max_by_key(|(_, w)| **w)).map(|(index, _)| index)
}

/// The RGBA of a `.ico` at exactly `size` px: the picked image, resampled when it is another size.
/// Every image format a `.ico` holds is read: PNG, and bitmaps of 1, 4, 8, 24 and 32 bits.
pub fn ico_rgba(ico: &[u8], size: u32) -> Result<Rgba, String> {
  let dir = ico::IconDir::read(Cursor::new(ico)).map_err(|e| format!("not a .ico file: {e}"))?;
  let entries = dir.entries();
  let widths: Vec<u32> = entries.iter().map(|e| e.width()).collect();
  let index = pick_ico_width(&widths, size).ok_or(".ico has no images")?;
  let entry = &entries[index];
  if entry.width() != entry.height() {
    return Err(format!(".ico entry {}x{} is not square", entry.width(), entry.height()));
  }
  let image = entry.decode().map_err(|e| format!(".ico entry {}px: {e}", entry.width()))?;
  Ok(Rgba { size, pixels: resample(image.rgba_data(), image.width(), size) })
}

/// The RGBA of a square PNG at exactly `size` px.
pub fn png_rgba(png: &[u8], size: u32) -> Result<Rgba, String> {
  let image = ico::IconImage::read_png(Cursor::new(png)).map_err(|e| format!("not a PNG file: {e}"))?;
  if image.width() != image.height() {
    return Err(format!("the PNG is {}x{}, not square", image.width(), image.height()));
  }
  Ok(Rgba { size, pixels: resample(image.rgba_data(), image.width(), size) })
}

/// Bilinear resample of a square top-down RGBA image from `from` to `to` px a side,
/// sampling pixel centres (`resampleRgba` in `icon.ts`). The input when the size matches.
pub fn resample(src: &[u8], from: u32, to: u32) -> Vec<u8> {
  if from == to || from == 0 {
    return src.to_vec();
  }
  let (from_px, to_px) = (from as usize, to as usize);
  let mut out = vec![0u8; to_px * to_px * 4];
  let scale = f64::from(from) / f64::from(to);
  let last = f64::from(from - 1);
  let at = |x: usize, y: usize, c: usize| f64::from(src[(y * from_px + x) * 4 + c]);
  for y in 0..to_px {
    let sy = ((y as f64 + 0.5) * scale - 0.5).clamp(0.0, last);
    let (y0, fy) = (sy.floor() as usize, sy - sy.floor());
    let y1 = (y0 + 1).min(from_px - 1);
    for x in 0..to_px {
      let sx = ((x as f64 + 0.5) * scale - 0.5).clamp(0.0, last);
      let (x0, fx) = (sx.floor() as usize, sx - sx.floor());
      let x1 = (x0 + 1).min(from_px - 1);
      for c in 0..4 {
        let top = at(x0, y0, c) + (at(x1, y0, c) - at(x0, y0, c)) * fx;
        let bottom = at(x0, y1, c) + (at(x1, y1, c) - at(x0, y1, c)) * fx;
        out[(y * to_px + x) * 4 + c] = (top + (bottom - top) * fy).round() as u8;
      }
    }
  }
  out
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  /// A `.ico` of solid squares, one per (size, rgba colour), as 32-bit bitmaps; a 256 px one as PNG.
  pub(crate) fn solid_ico(images: &[(u32, [u8; 4])]) -> Vec<u8> {
    let mut dir = ico::IconDir::new(ico::ResourceType::Icon);
    for (size, colour) in images {
      let pixels: Vec<u8> = colour.iter().copied().cycle().take((size * size * 4) as usize).collect();
      let image = ico::IconImage::from_rgba_data(*size, *size, pixels);
      dir.add_entry(ico::IconDirEntry::encode(&image).expect("encode"));
    }
    let mut bytes = Vec::new();
    dir.write(&mut bytes).expect("write");
    bytes
  }

  const RED: [u8; 4] = [255, 0, 0, 255];
  const GREEN: [u8; 4] = [0, 255, 0, 255];
  const BLUE: [u8; 4] = [0, 0, 255, 255];

  fn centre(image: &Rgba) -> [u8; 4] {
    let i = ((image.size / 2 * image.size + image.size / 2) * 4) as usize;
    [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2], image.pixels[i + 3]]
  }

  #[test]
  fn the_exact_size_else_the_next_larger_else_the_largest_is_picked() {
    let widths = [32, 16, 24];
    assert_eq!(pick_ico_width(&widths, 16), Some(1));
    assert_eq!(pick_ico_width(&widths, 20), Some(2));
    assert_eq!(pick_ico_width(&widths, 40), Some(0));
    assert_eq!(pick_ico_width(&[], 16), None);
  }

  #[test]
  fn each_size_comes_from_its_own_image_or_the_next_larger_one() {
    let ico = solid_ico(&[(16, RED), (24, GREEN), (32, BLUE)]);
    for (size, colour) in [(16, RED), (20, GREEN), (24, GREEN), (32, BLUE), (48, BLUE)] {
      let image = ico_rgba(&ico, size).expect("decoded");
      assert_eq!(image.size, size);
      assert_eq!(image.pixels.len(), (size * size * 4) as usize);
      assert_eq!(centre(&image), colour, "size {size}");
    }
  }

  /// `tray-menu.test.ts` "a multi-size .ico picks the exact size at each of 16, 20, 24 and 32 px":
  /// one file, one colour per size, decoded through `IconBytes` as the binding's `decodeIcon` does;
  /// the colour read back names the image used. An icon with nothing for Windows (an SF Symbol
  /// only) decodes to nothing.
  #[test]
  fn a_multi_size_ico_gives_each_of_16_20_24_and_32_px_its_own_image() {
    const YELLOW: [u8; 4] = [255, 255, 0, 255];
    let images = [(16, RED), (20, GREEN), (24, BLUE), (32, YELLOW)];
    let icon = IconBytes { ico: Some(solid_ico(&images)), ..Default::default() };
    for (size, colour) in images {
      let image = icon.rgba(size).expect("decoded").expect("an image");
      assert_eq!((image.size, centre(&image)), (size, colour), "size {size}");
    }
    let symbol = IconBytes { symbol: Some("gearshape".into()), ..Default::default() };
    assert_eq!(symbol.rgba(16), Ok(None));
  }

  #[test]
  fn a_png_image_inside_the_ico_decodes() {
    let ico = solid_ico(&[(256, GREEN)]);
    let image = ico_rgba(&ico, 16).expect("decoded");
    assert_eq!(centre(&image), GREEN);
  }

  #[test]
  fn a_png_on_its_own_decodes_at_the_asked_size() {
    let mut png = Vec::new();
    ico::IconImage::from_rgba_data(8, 8, RED.repeat(64)).write_png(&mut png).expect("png");
    let image = IconBytes { png: Some(png), ..Default::default() }.rgba(16).expect("decoded").expect("an image");
    assert_eq!((image.size, centre(&image)), (16, RED));
  }

  #[test]
  fn resampling_keeps_a_solid_colour_and_blends_an_edge() {
    let solid = resample(&RED.repeat(32 * 32), 32, 16);
    assert!(solid.chunks(4).all(|p| p == RED));
    // Left half red, right half blue: the middle column of the 3 px result is a blend.
    let mut half = Vec::new();
    for _ in 0..4 {
      half.extend(RED.repeat(2));
      half.extend(BLUE.repeat(2));
    }
    let out = resample(&half, 4, 3);
    assert_eq!(&out[0..4], &RED);
    assert_eq!(&out[8..12], &BLUE);
    assert!(out[4] > 0 && out[6] > 0, "the middle pixel mixes both: {:?}", &out[4..8]);
  }

  #[test]
  fn bytes_that_are_no_icon_are_refused_with_a_reason() {
    assert!(ico_rgba(b"not an icon", 16).unwrap_err().starts_with("not a .ico file"));
    assert_eq!(IconBytes::default().rgba(16), Ok(None));
  }
}
