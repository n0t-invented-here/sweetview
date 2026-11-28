//! Which screen a point belongs to, the way the OS picks one: the screen that
//! holds the point, else the nearest. A window's screen is the OS's own answer
//! (`MonitorFromWindow`, in the platform crate), which knows a minimised
//! window's restored position.

use crate::geometry::{Point, Rect};

/// The index in `screens` of the screen at `point`. `None` only when `screens` is empty.
pub fn screen_at(screens: &[Rect], point: Point) -> Option<usize> {
  if let Some(index) = screens.iter().position(|s| s.contains(point)) {
    return Some(index);
  }
  nearest(screens, point)
}

fn nearest(screens: &[Rect], point: Point) -> Option<usize> {
  screens.iter().enumerate().min_by_key(|(i, s)| (s.distance_squared_to(point), *i)).map(|(i, _)| i)
}

/// The rectangle holding every screen: the virtual screen.
pub fn virtual_screen(screens: &[Rect]) -> Rect {
  screens.iter().copied().reduce(|a, b| a.union(&b)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::*;

  const LEFT: Rect = Rect::new(-1920, 0, 1920, 1080);
  const PRIMARY: Rect = Rect::new(0, 0, 2560, 1440);

  #[test]
  fn a_point_maps_to_its_screen_or_the_nearest() {
    let screens = [PRIMARY, LEFT];
    assert_eq!(screen_at(&screens, Point { x: 10, y: 10 }), Some(0));
    assert_eq!(screen_at(&screens, Point { x: -10, y: 10 }), Some(1));
    assert_eq!(screen_at(&screens, Point { x: 999_999, y: 999_999 }), Some(0));
    assert_eq!(screen_at(&screens, Point { x: -5000, y: -100_000 }), Some(1));
    assert_eq!(screen_at(&[], Point { x: 0, y: 0 }), None);
  }

  #[test]
  fn the_virtual_screen_holds_them_all() {
    assert_eq!(virtual_screen(&[PRIMARY, LEFT]), Rect::new(-1920, 0, 4480, 1440));
    assert_eq!(virtual_screen(&[]), Rect::default());
  }
}
