//! Hit regions: which parts of a window take clicks.
//!
//! The page sends polygons; `hit-regions.ts` packs them into one flat
//! `Int32Array`, per polygon `[count, minX, minY, maxX, maxY, x0, y0, x1, y1, ...]`.
//! Every 10 ms the runtime reads the cursor and asks [`HitState::poll`]
//! whether the window should let clicks through. With a refiner, the page is
//! asked for the exact answer at the cursor while it is inside a polygon.

use crate::geometry::{Point, Rect};

/// Is `(x, y)` inside any packed polygon? Bounds first, then even-odd ray casting.
///
/// The same test as `hitRegions` in `hit-regions.ts`, including its
/// arithmetic: the crossing is computed in floating point.
pub fn hit_regions(packed: &[i32], x: i32, y: i32) -> bool {
  let mut offset = 0usize;
  while offset < packed.len() {
    let Ok(count) = usize::try_from(packed[offset]) else { return false };
    let Some(header) = packed.get(offset..offset + 5) else { return false };
    let first = offset + 5;
    let Some(points) = packed.get(first..first + count * 2) else { return false };
    let in_bounds = x >= header[1] && x <= header[3] && y >= header[2] && y <= header[4];
    if in_bounds && count > 0 {
      let mut inside = false;
      let mut j = count - 1;
      for i in 0..count {
        let (xi, yi) = (f64::from(points[i * 2]), f64::from(points[i * 2 + 1]));
        let (xj, yj) = (f64::from(points[j * 2]), f64::from(points[j * 2 + 1]));
        let (px, py) = (f64::from(x), f64::from(y));
        if (yi > py) != (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi {
          inside = !inside;
        }
        j = i;
      }
      if inside {
        return true;
      }
    }
    offset = first + count * 2;
  }
  false
}

/// What the window does after a poll or an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitStep {
  /// Leave the window as it is.
  Nothing,
  /// Set click-through on (`true`) or off.
  Pass(bool),
  /// Optionally set click-through first, then ask the refiner whether the
  /// window-local point `(x, y)` is solid; the answer comes back with `seq`.
  Ask { pass: Option<bool>, x: i32, y: i32, seq: u32 },
}

/// The poll's memory for one window: `pollHit` and `refineHit` of today's
/// `win32/window.ts`, as data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HitState {
  packed: Vec<i32>,
  refining: bool,
  in_polygon: bool,
  asked: Option<Point>,
  ask_seq: u32,
}

impl HitState {
  /// Regions with or without a refiner. `packed` is the format of `packRegions`.
  pub fn new(packed: Vec<i32>, refining: bool) -> Self {
    Self { packed, refining, in_polygon: false, asked: None, ask_seq: 0 }
  }

  /// New regions for a window that already had some: whether the cursor was
  /// inside and the ask sequence carry over, the outstanding question does not,
  /// so an answer to it is dropped.
  pub fn replaced(&self, packed: Vec<i32>, refining: bool) -> Self {
    Self { packed, refining, in_polygon: self.in_polygon, asked: None, ask_seq: self.ask_seq }
  }

  /// One tick of the poll. `cursor` is in screen coordinates, `window` is the
  /// window's outer rectangle. While any mouse button is down nothing changes,
  /// so a drag that starts on the shape and leaves it keeps going.
  pub fn poll(&mut self, buttons_down: bool, cursor: Point, window: Rect) -> HitStep {
    if buttons_down {
      return HitStep::Nothing;
    }
    let local = Point { x: cursor.x - window.x, y: cursor.y - window.y };
    let inside_window = local.x >= 0 && local.y >= 0 && local.x < window.width && local.y < window.height;
    let in_polygon = inside_window && hit_regions(&self.packed, local.x, local.y);
    self.refine(in_polygon, local)
  }

  fn refine(&mut self, in_polygon: bool, local: Point) -> HitStep {
    let entered = in_polygon && !self.in_polygon;
    self.in_polygon = in_polygon;
    if !in_polygon {
      self.asked = None;
      return HitStep::Pass(true);
    }
    if !self.refining {
      return HitStep::Pass(false);
    }
    let pass = entered.then_some(false);
    if self.asked == Some(local) {
      return pass.map_or(HitStep::Nothing, HitStep::Pass);
    }
    self.asked = Some(local);
    self.ask_seq = self.ask_seq.wrapping_add(1);
    HitStep::Ask { pass, x: local.x, y: local.y, seq: self.ask_seq }
  }

  /// The refiner's answer to the question numbered `seq`. Returns the
  /// click-through state to set, or `None` when the answer is stale (a later
  /// question was asked, the cursor left the polygon, the regions were
  /// replaced) or a mouse button is down.
  pub fn answer(&self, seq: u32, solid: bool, buttons_down: bool) -> Option<bool> {
    if seq != self.ask_seq || self.asked.is_none() || buttons_down {
      return None;
    }
    Some(!solid)
  }

  /// True while the last poll found the cursor inside a polygon.
  pub fn in_polygon(&self) -> bool {
    self.in_polygon
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// `packRegions` of `hit-regions.ts`, for building test input.
  fn pack(polygons: &[&[(f64, f64)]]) -> Vec<i32> {
    let mut packed = Vec::new();
    for polygon in polygons.iter().filter(|p| p.len() >= 3) {
      let min_x = polygon.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
      let min_y = polygon.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
      let max_x = polygon.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
      let max_y = polygon.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
      packed.extend([polygon.len() as i32, min_x.floor() as i32, min_y.floor() as i32, max_x.ceil() as i32, max_y.ceil() as i32]);
      for p in polygon.iter() {
        packed.extend([p.0.round() as i32, p.1.round() as i32]);
      }
    }
    packed
  }

  fn rect(x: f64, y: f64, w: f64, h: f64) -> [(f64, f64); 4] {
    [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
  }

  #[test]
  fn packing_matches_pack_regions() {
    assert_eq!(pack(&[&rect(1.4, 2.6, 3.2, 1.1)]), vec![4, 1, 2, 5, 4, 1, 3, 5, 3, 5, 4, 1, 4]);
    assert!(pack(&[&[(0.0, 0.0), (5.0, 5.0)]]).is_empty());
  }

  #[test]
  fn inside_any_polygon_and_outside_is_outside() {
    let packed = pack(&[&rect(10.0, 10.0, 10.0, 10.0), &rect(50.0, 0.0, 5.0, 5.0)]);
    assert!(hit_regions(&packed, 11, 11));
    assert!(hit_regions(&packed, 19, 19));
    assert!(hit_regions(&packed, 52, 2));
    assert!(!hit_regions(&packed, 25, 15));
    assert!(!hit_regions(&packed, 15, 25));
    assert!(!hit_regions(&packed, 0, 0));
    assert!(!hit_regions(&[], 0, 0));
  }

  #[test]
  fn a_diamond_misses_the_corners_of_its_bounds() {
    let diamond = pack(&[&[(10.0, 0.0), (20.0, 10.0), (10.0, 20.0), (0.0, 10.0)]]);
    assert!(hit_regions(&diamond, 10, 10));
    assert!(!hit_regions(&diamond, 1, 1));
    assert!(!hit_regions(&diamond, 19, 19));
  }

  #[test]
  fn a_truncated_buffer_is_a_miss_not_a_panic() {
    assert!(!hit_regions(&[4, 0, 0, 10, 10, 0, 0], 5, 5));
    assert!(!hit_regions(&[-1, 0, 0, 10, 10], 5, 5));
  }

  const WINDOW: Rect = Rect::new(100, 100, 200, 200);
  const AT_SQUARE: Point = Point { x: 115, y: 115 };
  const OFF_SQUARE: Point = Point { x: 250, y: 250 };
  const OUTSIDE_WINDOW: Point = Point { x: 50, y: 50 };

  fn square() -> Vec<i32> {
    pack(&[&rect(10.0, 10.0, 10.0, 10.0)])
  }

  #[test]
  fn without_a_refiner_the_polygon_decides() {
    let mut state = HitState::new(square(), false);
    assert_eq!(state.poll(false, AT_SQUARE, WINDOW), HitStep::Pass(false));
    assert!(state.in_polygon());
    assert_eq!(state.poll(false, OFF_SQUARE, WINDOW), HitStep::Pass(true));
    assert_eq!(state.poll(false, OUTSIDE_WINDOW, WINDOW), HitStep::Pass(true));
  }

  #[test]
  fn empty_regions_make_the_whole_window_click_through() {
    let mut state = HitState::new(Vec::new(), true);
    assert_eq!(state.poll(false, AT_SQUARE, WINDOW), HitStep::Pass(true));
  }

  #[test]
  fn nothing_flips_while_a_mouse_button_is_down() {
    let mut state = HitState::new(square(), false);
    assert_eq!(state.poll(false, AT_SQUARE, WINDOW), HitStep::Pass(false));
    // A drag that started on the shape leaves it: still solid.
    assert_eq!(state.poll(true, OFF_SQUARE, WINDOW), HitStep::Nothing);
    assert!(state.in_polygon());
    // Released: the poll catches up.
    assert_eq!(state.poll(false, OFF_SQUARE, WINDOW), HitStep::Pass(true));
  }

  #[test]
  fn the_refiner_is_asked_once_per_point_and_its_answer_decides() {
    let mut state = HitState::new(square(), true);
    // Entering: solid at once, and the page is asked.
    let HitStep::Ask { pass, x, y, seq } = state.poll(false, AT_SQUARE, WINDOW) else { panic!("expected an ask") };
    assert_eq!((pass, x, y), (Some(false), 15, 15));
    // Same point again: no second question.
    assert_eq!(state.poll(false, AT_SQUARE, WINDOW), HitStep::Nothing);
    // The page says transparent there.
    assert_eq!(state.answer(seq, false, false), Some(true));
    // The page says solid.
    assert_eq!(state.answer(seq, true, false), Some(false));
    // A button is down: the answer is not applied.
    assert_eq!(state.answer(seq, false, true), None);
  }

  #[test]
  fn a_stale_answer_is_dropped() {
    let mut state = HitState::new(square(), true);
    let HitStep::Ask { seq: first, .. } = state.poll(false, AT_SQUARE, WINDOW) else { panic!("expected an ask") };
    let HitStep::Ask { pass, seq: second, .. } = state.poll(false, Point { x: 116, y: 115 }, WINDOW) else { panic!("expected an ask") };
    assert_eq!(pass, None, "not entering again");
    assert_eq!(state.answer(first, true, false), None, "a later question was asked");
    assert_eq!(state.answer(second, true, false), Some(false));
    // Leaving the polygon drops the question.
    assert_eq!(state.poll(false, OFF_SQUARE, WINDOW), HitStep::Pass(true));
    assert_eq!(state.answer(second, true, false), None);
  }

  #[test]
  fn replacing_the_regions_keeps_the_sequence_and_drops_the_question() {
    let mut state = HitState::new(square(), true);
    let HitStep::Ask { seq, .. } = state.poll(false, AT_SQUARE, WINDOW) else { panic!("expected an ask") };
    let mut replaced = state.replaced(square(), true);
    assert!(replaced.in_polygon());
    assert_eq!(replaced.answer(seq, true, false), None);
    // Still inside: no "entered" flip, but a new question with a new number.
    let HitStep::Ask { pass, seq: next, .. } = replaced.poll(false, AT_SQUARE, WINDOW) else { panic!("expected an ask") };
    assert_eq!(pass, None);
    assert_eq!(next, seq + 1);
  }
}
