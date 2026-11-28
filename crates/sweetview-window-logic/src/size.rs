//! A window's outer frame from the size of its page: `contentSize` is in
//! device-independent pixels (CSS pixels of the page), bounds are physical
//! pixels of the outer frame. The runtime measures the frame's edges and the
//! screen's scale; this module does the arithmetic.

use crate::geometry::Rect;

/// A size in device-independent pixels: CSS pixels of the page.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Dips {
  pub width: f64,
  pub height: f64,
}

impl Dips {
  pub const fn new(width: f64, height: f64) -> Self {
    Self { width, height }
  }
}

/// A scale that is not a positive finite number is taken as 1.
fn usable(scale: f64) -> f64 {
  if scale.is_finite() && scale > 0.0 {
    scale
  } else {
    1.0
  }
}

/// One side in physical pixels: `dips` at `scale`, rounded, at least 1.
fn side(dips: f64, scale: f64) -> i32 {
  let dips = if dips.is_finite() { dips.max(0.0) } else { 0.0 };
  ((dips * usable(scale)).round() as i32).max(1)
}

/// The client area, in physical pixels, that shows `content` at `scale`
/// physical pixels per device-independent pixel.
pub fn client_size(content: Dips, scale: f64) -> (i32, i32) {
  (side(content.width, scale), side(content.height, scale))
}

/// The outer frame's size for a client area that shows `content` at `scale`:
/// the client area plus `edges`, the frame's outer size less its client size
/// in physical pixels (the caption and the borders; zero for a frameless
/// window).
/// A side too large for any screen saturates at `i32::MAX`.
pub fn outer_size_for_content(content: Dips, scale: f64, edges: (i32, i32)) -> (i32, i32) {
  let (width, height) = client_size(content, scale);
  (width.saturating_add(edges.0.max(0)), height.saturating_add(edges.1.max(0)))
}

/// A `width` x `height` rectangle centred in `area`. A side larger than the
/// area's is cut to it, so the whole window, its title bar included, is on
/// the screen.
/// A `width` x `height` rectangle centred in `area`, keeping its size: one
/// wider than the area overhangs both sides equally, one taller keeps its top
/// at the area's top. The tab frame's default placement (no bounds, no
/// `contentSize`), as it was before `contentSize` existed.
pub fn centred_keeping_size(width: i32, height: i32, area: Rect) -> Rect {
  let x = area.x + (area.width - width) / 2;
  let y = area.y + ((area.height - height) / 2).max(0);
  Rect::new(x, y, width, height)
}

pub fn centred(width: i32, height: i32, area: Rect) -> Rect {
  let width = width.min(area.width).max(1);
  let height = height.min(area.height).max(1);
  let x = area.x + ((area.width - width) / 2).max(0);
  let y = area.y + ((area.height - height) / 2).max(0);
  Rect::new(x, y, width, height)
}

#[cfg(test)]
mod tests {
  use super::*;

  // A framed window's edges at 100 %: the caption and the borders.
  const EDGES: (i32, i32) = (16, 39);

  #[test]
  fn the_client_area_is_the_page_at_the_screens_scale() {
    let page = Dips::new(1100.0, 720.0);
    assert_eq!(client_size(page, 1.0), (1100, 720));
    assert_eq!(client_size(page, 1.25), (1375, 900));
    assert_eq!(client_size(page, 1.5), (1650, 1080));
    assert_eq!(client_size(page, 1.75), (1925, 1260));
    assert_eq!(client_size(page, 2.0), (2200, 1440));
    // Rounded to the nearest pixel: 333 x 1.25 = 416.25, 333 x 1.75 = 582.75.
    assert_eq!(client_size(Dips::new(333.0, 333.0), 1.25), (416, 416));
    assert_eq!(client_size(Dips::new(333.0, 333.0), 1.75), (583, 583));
  }

  #[test]
  fn the_outer_frame_adds_the_measured_edges_at_every_scale() {
    let page = Dips::new(1100.0, 720.0);
    assert_eq!(outer_size_for_content(page, 1.0, EDGES), (1116, 759));
    // The edges are measured at the window's own scale, so they are added as they are.
    assert_eq!(outer_size_for_content(page, 1.5, (24, 58)), (1674, 1138));
    assert_eq!(outer_size_for_content(page, 2.0, (32, 78)), (2232, 1518));
    // Frameless: the outer frame is the client area.
    assert_eq!(outer_size_for_content(page, 1.5, (0, 0)), (1650, 1080));
  }

  #[test]
  fn the_page_looks_the_same_size_at_every_scale() {
    // What the page gets back, in CSS pixels, is what was asked for.
    let page = Dips::new(1100.0, 720.0);
    for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0] {
      let (w, h) = client_size(page, scale);
      assert!((f64::from(w) / scale - 1100.0).abs() <= 0.5 / scale, "{scale}: {w}");
      assert!((f64::from(h) / scale - 720.0).abs() <= 0.5 / scale, "{scale}: {h}");
    }
  }

  #[test]
  fn sizes_and_scales_that_make_no_sense_are_bounded() {
    assert_eq!(client_size(Dips::new(-5.0, f64::NAN), 1.5), (1, 1));
    assert_eq!(client_size(Dips::new(100.0, 100.0), 0.0), (100, 100));
    assert_eq!(client_size(Dips::new(100.0, 100.0), f64::INFINITY), (100, 100));
    assert_eq!(outer_size_for_content(Dips::new(10.0, 10.0), 1.0, (-3, -3)), (10, 10));
  }

  #[test]
  fn a_page_too_large_for_any_screen_saturates_instead_of_overflowing() {
    // Review finding 4: 3e9 DIPs saturate the side to i32::MAX, and adding the frame overflowed.
    let (width, height) = outer_size_for_content(Dips::new(3_000_000_000.0, 300.0), 1.0, EDGES);
    assert_eq!((width, height), (i32::MAX, 339));
    assert_eq!(centred(width, height, Rect::new(0, 0, 1920, 1040)), Rect::new(0, 350, 1920, 339));
  }

  #[test]
  fn the_tab_frames_default_keeps_its_size_on_a_small_work_area_as_before_the_range() {
    // Review finding 4: a 1040 x 720 page plus a 36 DIP strip at 150 % on a 1366 x 728 work
    // area is 1560 + 24 by (756 x 1.5 = 1134) + 58 physical pixels; it kept that size, its left
    // edge left of the area and its top at the area's top, as `tab_frame::finish` placed it at
    // tag pre-rust-rewrite.
    let area = Rect::new(0, 0, 1366, 728);
    let (width, height) = outer_size_for_content(Dips::new(1040.0, 756.0), 1.5, (24, 58));
    assert_eq!((width, height), (1584, 1192));
    assert_eq!(centred_keeping_size(width, height, area), Rect::new(-109, 0, 1584, 1192));
    // Room on both sides: the same as `centred`.
    assert_eq!(centred_keeping_size(1116, 759, Rect::new(0, 0, 1920, 1040)), centred(1116, 759, Rect::new(0, 0, 1920, 1040)));
  }

  #[test]
  fn centred_in_the_work_area_and_kept_on_it_when_larger() {
    let area = Rect::new(0, 0, 1920, 1040);
    assert_eq!(centred(1116, 759, area), Rect::new(402, 140, 1116, 759));
    // A work area that does not start at the origin: a taskbar on the left, a second monitor.
    assert_eq!(centred(400, 300, Rect::new(48, 0, 1872, 1080)), Rect::new(784, 390, 400, 300));
    assert_eq!(centred(400, 300, Rect::new(-1920, -200, 1920, 1080)), Rect::new(-1160, 190, 400, 300));
    // Larger than the area: cut to it, one side or both.
    assert_eq!(centred(2232, 1518, area), area);
    assert_eq!(centred(1116, 1518, area), Rect::new(402, 0, 1116, 1040));
    assert_eq!(centred(1116, 1518, Rect::new(0, 40, 1920, 1000)), Rect::new(402, 40, 1116, 1000));
  }
}
