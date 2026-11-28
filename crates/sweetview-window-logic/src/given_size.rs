//! What the C++ webview library's `webview_set_size` decided for a window it was
//! given (`webview_create` with a window handle), which a webview mounted in an
//! application's own window still does: the style for a size hint, and a size in
//! device-independent pixels scaled to a DPI as the library scaled it. The
//! platform crate applies the answer to the window.

/// The hint of a size, as the C API numbered it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GivenWindowSizeHint {
  None,
  Min,
  Max,
  Fixed,
}

/// The style the window gets for `hint`, from the style it has: `FIXED` takes
/// `WS_THICKFRAME` and `WS_MAXIMIZEBOX` off; every other hint puts them on.
pub fn style_for_size_hint(style: u32, hint: GivenWindowSizeHint) -> u32 {
  const WS_THICKFRAME: u32 = 0x0004_0000;
  const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
  if hint == GivenWindowSizeHint::Fixed {
    style & !(WS_THICKFRAME | WS_MAXIMIZEBOX)
  } else {
    style | WS_THICKFRAME | WS_MAXIMIZEBOX
  }
}

/// `width` device-independent pixels at `dpi`, as the library scaled them (`MulDiv`, rounded).
pub fn scale_to_dpi(value: u32, dpi: u32) -> i32 {
  let scaled = (u64::from(value) * u64::from(dpi) + 48) / 96;
  i32::try_from(scaled).unwrap_or(i32::MAX)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fixed_takes_the_resize_frame_and_the_maximize_box_off_and_every_other_hint_puts_them_on() {
    const OVERLAPPED: u32 = 0x00CF_0000;
    const WITHOUT: u32 = OVERLAPPED & !(0x0004_0000 | 0x0001_0000);
    assert_eq!(style_for_size_hint(OVERLAPPED, GivenWindowSizeHint::Fixed), WITHOUT);
    for hint in [GivenWindowSizeHint::None, GivenWindowSizeHint::Min, GivenWindowSizeHint::Max] {
      assert_eq!(style_for_size_hint(WITHOUT, hint), OVERLAPPED);
    }
  }

  #[test]
  fn sizes_scale_with_the_dpi_and_round_as_muldiv_does() {
    assert_eq!(scale_to_dpi(500, 96), 500);
    assert_eq!(scale_to_dpi(500, 144), 750);
    assert_eq!(scale_to_dpi(333, 120), 416);
    assert_eq!(scale_to_dpi(u32::MAX, 960), i32::MAX);
  }
}
