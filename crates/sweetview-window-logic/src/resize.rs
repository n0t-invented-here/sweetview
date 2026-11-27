//! Moving a frameless window's edges from the page, and its maximise toggle.

use crate::geometry::{Point, Rect};

/// An edge or corner of a window, for `startResize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResizeEdge {
  Left,
  Right,
  Top,
  Bottom,
  TopLeft,
  TopRight,
  BottomLeft,
  BottomRight,
}

impl ResizeEdge {
  /// The names `window.ts` uses: `"left"`, `"top-right"` and so on.
  pub fn parse(name: &str) -> Option<Self> {
    Some(match name {
      "left" => Self::Left,
      "right" => Self::Right,
      "top" => Self::Top,
      "bottom" => Self::Bottom,
      "top-left" => Self::TopLeft,
      "top-right" => Self::TopRight,
      "bottom-left" => Self::BottomLeft,
      "bottom-right" => Self::BottomRight,
      _ => return None,
    })
  }

  fn left(self) -> bool {
    matches!(self, Self::Left | Self::TopLeft | Self::BottomLeft)
  }
  fn right(self) -> bool {
    matches!(self, Self::Right | Self::TopRight | Self::BottomRight)
  }
  fn top(self) -> bool {
    matches!(self, Self::Top | Self::TopLeft | Self::TopRight)
  }
  fn bottom(self) -> bool {
    matches!(self, Self::Bottom | Self::BottomLeft | Self::BottomRight)
  }
}

/// The smallest outer size the resize gesture allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MinSize {
  pub width: i32,
  pub height: i32,
}

/// The floor when a window gives no `minWidth` / `minHeight`: 160 x 120.
pub const DEFAULT_MIN_SIZE: MinSize = MinSize { width: 160, height: 120 };

impl MinSize {
  /// A window's own minimums, each falling back to the default floor on its own.
  pub fn from_options(min_width: Option<i32>, min_height: Option<i32>) -> Self {
    Self { width: min_width.unwrap_or(DEFAULT_MIN_SIZE.width), height: min_height.unwrap_or(DEFAULT_MIN_SIZE.height) }
  }
}

/// The bounds a window takes when `edge` has been dragged from where the
/// gesture began (`from`, with the cursor at `start`) to `cursor`. The
/// opposite edge stays where it was, and the size never goes below `min`.
pub fn resize_from_edge(edge: ResizeEdge, from: Rect, start: Point, cursor: Point, min: MinSize) -> Rect {
  let dx = cursor.x - start.x;
  let dy = cursor.y - start.y;
  let mut out = from;
  if edge.left() {
    out.width = min.width.max(from.width - dx);
    out.x = from.x + from.width - out.width;
  }
  if edge.right() {
    out.width = min.width.max(from.width + dx);
  }
  if edge.top() {
    out.height = min.height.max(from.height - dy);
    out.y = from.y + from.height - out.height;
  }
  if edge.bottom() {
    out.height = min.height.max(from.height + dy);
  }
  out
}

/// A frameless window has no OS maximise: it toggles between its own bounds
/// and the work area of the screen it is on. `restore` is the bounds saved by
/// the last maximise, if the window is maximised now. Returns the bounds to
/// set and the new `restore`.
pub fn toggle_frameless_maximize(restore: Option<Rect>, current: Rect, work_area: Rect) -> (Rect, Option<Rect>) {
  match restore {
    Some(saved) => (saved, None),
    None => (work_area, Some(current)),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const FROM: Rect = Rect::new(100, 100, 400, 300);
  const START: Point = Point { x: 500, y: 400 };

  #[test]
  fn edge_names_parse() {
    assert_eq!(ResizeEdge::parse("top-left"), Some(ResizeEdge::TopLeft));
    assert_eq!(ResizeEdge::parse("bottom-right"), Some(ResizeEdge::BottomRight));
    assert_eq!(ResizeEdge::parse("middle"), None);
  }

  #[test]
  fn right_and_bottom_grow_with_the_cursor() {
    let cursor = Point { x: 530, y: 440 };
    assert_eq!(resize_from_edge(ResizeEdge::BottomRight, FROM, START, cursor, DEFAULT_MIN_SIZE), Rect::new(100, 100, 430, 340));
    assert_eq!(resize_from_edge(ResizeEdge::Right, FROM, START, cursor, DEFAULT_MIN_SIZE), Rect::new(100, 100, 430, 300));
  }

  #[test]
  fn left_and_top_keep_the_opposite_edge_in_place() {
    let cursor = Point { x: 520, y: 390 };
    let out = resize_from_edge(ResizeEdge::TopLeft, FROM, START, cursor, DEFAULT_MIN_SIZE);
    assert_eq!(out, Rect::new(120, 90, 380, 310));
    assert_eq!(out.right(), FROM.right());
    assert_eq!(out.bottom(), FROM.bottom());
  }

  #[test]
  fn the_minimum_size_holds_and_pins_the_moving_edge() {
    let far = Point { x: 2000, y: 2000 };
    let out = resize_from_edge(ResizeEdge::TopLeft, FROM, START, far, DEFAULT_MIN_SIZE);
    assert_eq!(out, Rect::new(FROM.right() - 160, FROM.bottom() - 120, 160, 120));
    let own = MinSize::from_options(Some(250), None);
    assert_eq!(own, MinSize { width: 250, height: 120 });
    let out = resize_from_edge(ResizeEdge::Left, FROM, START, far, own);
    assert_eq!((out.x, out.width), (FROM.right() - 250, 250));
  }

  #[test]
  fn frameless_maximise_toggles_between_the_work_area_and_the_saved_bounds() {
    let work = Rect::new(0, 0, 1920, 1040);
    let (maxed, saved) = toggle_frameless_maximize(None, FROM, work);
    assert_eq!((maxed, saved), (work, Some(FROM)));
    let (restored, saved) = toggle_frameless_maximize(saved, maxed, work);
    assert_eq!((restored, saved), (FROM, None));
  }
}
