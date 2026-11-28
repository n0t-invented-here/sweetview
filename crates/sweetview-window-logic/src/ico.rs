//! Picking one image out of an `.ico` file, as `parseIco` and `pickIcoEntry`
//! of `icon.ts` do.

/// One image of an `.ico` directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IcoEntry {
  pub width: u32,
  pub height: u32,
  pub offset: usize,
  pub size: usize,
}

/// The directory of an `.ico` file. Errors carry the message `icon.ts` uses.
pub fn parse_ico(bytes: &[u8]) -> Result<Vec<IcoEntry>, String> {
  let u16_at = |at: usize| bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
  let u32_at = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
  if bytes.len() < 6 || u16_at(2) != Some(1) {
    return Err("not a .ico file".into());
  }
  let count = usize::from(u16_at(4).unwrap_or(0));
  let mut entries = Vec::with_capacity(count);
  for i in 0..count {
    let at = 6 + i * 16;
    let (Some(size), Some(offset)) = (u32_at(at + 8), u32_at(at + 12)) else {
      return Err("truncated .ico directory".into());
    };
    let width = match bytes[at] {
      0 => 256,
      w => u32::from(w),
    };
    let height = match bytes[at + 1] {
      0 => 256,
      h => u32::from(h),
    };
    let (offset, size) = (offset as usize, size as usize);
    if offset.checked_add(size).is_none_or(|end| end > bytes.len()) {
      return Err(format!(".ico image {i} runs past the end of the file"));
    }
    entries.push(IcoEntry { width, height, offset, size });
  }
  Ok(entries)
}

/// Which of several equally wide largest images a pick falls back to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WidestTie {
  /// The first, as the sort of `icon.ts` keeps it: the notifier's balloon and tray icon.
  First,
  /// The last: the window's icon.
  Last,
}

/// The image of `width == want`, else the smallest larger one, else the largest,
/// of equally wide largest ones the one `tie` names.
pub fn select_ico_entry(entries: &[IcoEntry], want: u32, tie: WidestTie) -> Result<IcoEntry, String> {
  if let Some(exact) = entries.iter().find(|e| e.width == want) {
    return Ok(*exact);
  }
  let larger = entries.iter().filter(|e| e.width > want).min_by_key(|e| e.width);
  // `max_by_key` keeps the last of equals; reversed, it keeps the first.
  let widest = match tie {
    WidestTie::First => entries.iter().rev().max_by_key(|e| e.width),
    WidestTie::Last => entries.iter().max_by_key(|e| e.width),
  };
  larger.or(widest).copied().ok_or_else(|| ".ico has no images".into())
}

/// The window's pick: [`select_ico_entry`] keeping the last of equally wide largest images.
pub fn pick_ico_entry(entries: &[IcoEntry], want: u32) -> Result<IcoEntry, String> {
  select_ico_entry(entries, want, WidestTie::Last)
}

/// The notifier's pick: [`select_ico_entry`] keeping the first of equally wide largest images.
pub fn pick_ico_entry_keeping_first(entries: &[IcoEntry], want: u32) -> Result<IcoEntry, String> {
  select_ico_entry(entries, want, WidestTie::First)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ico(sizes: &[(u8, usize)]) -> Vec<u8> {
    let mut out = vec![0, 0, 1, 0, sizes.len() as u8, 0];
    let mut offset = 6 + sizes.len() * 16;
    for &(w, len) in sizes {
      out.extend([w, w, 0, 0, 1, 0, 32, 0]);
      out.extend((len as u32).to_le_bytes());
      out.extend((offset as u32).to_le_bytes());
      offset += len;
    }
    for &(_, len) in sizes {
      out.extend(std::iter::repeat_n(0u8, len));
    }
    out
  }

  #[test]
  fn picks_exact_then_smallest_larger_then_largest() {
    let entries = parse_ico(&ico(&[(16, 4), (32, 4), (0, 4)])).expect("valid");
    assert_eq!(entries.iter().map(|e| e.width).collect::<Vec<_>>(), vec![16, 32, 256]);
    assert_eq!(pick_ico_entry(&entries, 32).map(|e| e.width), Ok(32));
    assert_eq!(pick_ico_entry(&entries, 20).map(|e| e.width), Ok(32));
    assert_eq!(pick_ico_entry(&entries[..2], 48).map(|e| e.width), Ok(32));
    assert!(pick_ico_entry(&[], 16).is_err());
  }

  #[test]
  fn rejects_what_is_not_an_ico() {
    assert_eq!(parse_ico(b"PNG"), Err("not a .ico file".into()));
    let mut truncated = ico(&[(16, 4)]);
    truncated.truncate(10);
    assert_eq!(parse_ico(&truncated), Err("truncated .ico directory".into()));
    let mut short = ico(&[(16, 4)]);
    short.pop();
    assert!(parse_ico(&short).is_err());
  }
  #[test]
  fn the_notifiers_pick_is_exact_then_smallest_larger_then_the_first_largest() {
    let entries = parse_ico(&ico(&[(16, 4), (32, 4)])).expect("parse");
    assert_eq!(entries.iter().map(|e| e.width).collect::<Vec<_>>(), [16, 32], "one entry per image, in order");
    assert_eq!(pick_ico_entry_keeping_first(&entries, 16).map(|e| e.width), Ok(16));
    assert_eq!(pick_ico_entry_keeping_first(&entries, 24).map(|e| e.width), Ok(32));
    assert_eq!(pick_ico_entry_keeping_first(&entries, 48).map(|e| e.width), Ok(32));
    assert_eq!(pick_ico_entry_keeping_first(&[], 16), Err(".ico has no images".into()));
    // Of equally wide largest images, the notifier's pick keeps the first and the window's the last.
    let twins = parse_ico(&ico(&[(32, 4), (32, 4)])).expect("parse");
    assert_eq!(pick_ico_entry_keeping_first(&twins, 48), Ok(twins[0]));
    assert_eq!(pick_ico_entry(&twins, 48), Ok(twins[1]));
  }

  #[test]
  fn an_image_past_the_end_is_named_and_a_zero_dimension_means_256() {
    assert_eq!(parse_ico(&[0, 0, 2, 0, 1, 0]), Err("not a .ico file".into()));
    assert_eq!(parse_ico(&[0, 0, 1, 0, 1, 0, 16]), Err("truncated .ico directory".into()));
    let mut cut = ico(&[(16, 4), (32, 4)]);
    cut.pop();
    assert_eq!(parse_ico(&cut), Err(".ico image 1 runs past the end of the file".into()));
    let entries = parse_ico(&ico(&[(0, 4)])).expect("parse");
    assert_eq!((entries[0].width, entries[0].height), (256, 256));
  }
}
