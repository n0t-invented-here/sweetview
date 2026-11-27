//! Rectangles and points in screen coordinates: physical pixels, the primary
//! monitor's top-left corner at the origin.

/// A point on the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Point {
  pub x: i32,
  pub y: i32,
}

/// A rectangle by its top-left corner and size. A window's rectangle is its
/// outer frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
  pub x: i32,
  pub y: i32,
  pub width: i32,
  pub height: i32,
}

impl Rect {
  pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
    Self { x, y, width, height }
  }

  /// From the left, top, right and bottom edges, as the OS reports a `RECT`.
  pub const fn from_edges(left: i32, top: i32, right: i32, bottom: i32) -> Self {
    Self { x: left, y: top, width: right - left, height: bottom - top }
  }

  pub const fn right(&self) -> i32 {
    self.x + self.width
  }

  pub const fn bottom(&self) -> i32 {
    self.y + self.height
  }

  /// True when `point` is inside, the right and bottom edges excluded.
  pub const fn contains(&self, point: Point) -> bool {
    point.x >= self.x && point.y >= self.y && point.x < self.right() && point.y < self.bottom()
  }

  /// The area this rectangle shares with `other`; zero when they do not overlap.
  pub fn overlap_area(&self, other: &Rect) -> i64 {
    let width = i64::from(self.right().min(other.right())) - i64::from(self.x.max(other.x));
    let height = i64::from(self.bottom().min(other.bottom())) - i64::from(self.y.max(other.y));
    if width <= 0 || height <= 0 {
      0
    } else {
      width * height
    }
  }

  /// The squared distance from `point` to the nearest point of this rectangle; zero inside it.
  pub fn distance_squared_to(&self, point: Point) -> i64 {
    let dx = if point.x < self.x {
      i64::from(self.x) - i64::from(point.x)
    } else if point.x >= self.right() {
      i64::from(point.x) - i64::from(self.right()) + 1
    } else {
      0
    };
    let dy = if point.y < self.y {
      i64::from(self.y) - i64::from(point.y)
    } else if point.y >= self.bottom() {
      i64::from(point.y) - i64::from(self.bottom()) + 1
    } else {
      0
    };
    dx * dx + dy * dy
  }

  /// The smallest rectangle holding both.
  pub fn union(&self, other: &Rect) -> Rect {
    let left = self.x.min(other.x);
    let top = self.y.min(other.y);
    Rect::from_edges(left, top, self.right().max(other.right()), self.bottom().max(other.bottom()))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn contains_excludes_the_right_and_bottom_edges() {
    let r = Rect::new(10, 10, 5, 5);
    assert!(r.contains(Point { x: 10, y: 10 }));
    assert!(r.contains(Point { x: 14, y: 14 }));
    assert!(!r.contains(Point { x: 15, y: 10 }));
    assert!(!r.contains(Point { x: 10, y: 15 }));
  }

  #[test]
  fn overlap_distance_and_union() {
    let a = Rect::new(0, 0, 100, 100);
    let b = Rect::new(50, 50, 100, 100);
    assert_eq!(a.overlap_area(&b), 2500);
    assert_eq!(a.overlap_area(&Rect::new(100, 0, 10, 10)), 0);
    assert_eq!(a.distance_squared_to(Point { x: 50, y: 50 }), 0);
    assert_eq!(a.distance_squared_to(Point { x: -3, y: 50 }), 9);
    assert_eq!(a.union(&b), Rect::new(0, 0, 150, 150));
    assert_eq!(Rect::from_edges(1, 2, 11, 22), Rect::new(1, 2, 10, 20));
  }
}
