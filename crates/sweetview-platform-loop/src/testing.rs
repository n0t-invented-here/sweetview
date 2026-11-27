//! How the platform crates' tests check that an owning type gives back every
//! handle it takes: create and drop it in a loop and compare the process's
//! counts before and after.
//!
//! Two lessons are built in. A count is read once it has stopped moving,
//! because the OS and other libraries finish some work after a call returns.
//! And a one-off object the OS or another library makes at a time of its own
//! choosing must not fail the test, so the loop is measured twice and the
//! smaller growth of each kind counts: a leak of the type under test repeats
//! in every round and shows in both measurements.

use std::time::Duration;

use crate::{dispatch_waiting, resource_counts, ResourceCounts};

/// How much each count grew over a measured loop; negative when it fell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Growth {
  pub user_objects: i64,
  pub gdi_objects: i64,
  pub kernel_handles: i64,
}

impl Growth {
  fn between(before: ResourceCounts, after: ResourceCounts) -> Self {
    Self {
      user_objects: i64::from(after.user_objects) - i64::from(before.user_objects),
      gdi_objects: i64::from(after.gdi_objects) - i64::from(before.gdi_objects),
      kernel_handles: i64::from(after.kernel_handles) - i64::from(before.kernel_handles),
    }
  }

  fn smaller(self, other: Self) -> Self {
    Self {
      user_objects: self.user_objects.min(other.user_objects),
      gdi_objects: self.gdi_objects.min(other.gdi_objects),
      kernel_handles: self.kernel_handles.min(other.kernel_handles),
    }
  }

  /// True when no count grew by more than `allowance`.
  pub fn within(&self, allowance: i64) -> bool {
    self.user_objects <= allowance && self.gdi_objects <= allowance && self.kernel_handles <= allowance
  }
}

/// The process's counts once they have stopped moving: this thread's waiting
/// messages are dispatched and the counts read until two reads 20 ms apart
/// agree, at most 50 times.
pub fn settled_counts() -> ResourceCounts {
  let mut last = resource_counts();
  for _ in 0..50 {
    dispatch_waiting();
    std::thread::sleep(Duration::from_millis(20));
    let now = resource_counts();
    if now == last {
      return now;
    }
    last = now;
  }
  last
}

/// Runs `round` once to pay one-time costs, then `rounds` times measured,
/// twice, and returns the smaller growth of each count over the two
/// measurements. Compare the result with `<=`, never `==`.
pub fn smallest_growth(rounds: usize, mut round: impl FnMut()) -> Growth {
  round();
  let mut measure = || {
    let before = settled_counts();
    for _ in 0..rounds {
      round();
    }
    Growth::between(before, settled_counts())
  };
  let first = measure();
  let second = measure();
  first.smaller(second)
}
