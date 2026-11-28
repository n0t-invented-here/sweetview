//! A WinRT call made in one COM apartment, after every apartment an earlier one was made in
//! has been left: the theme read of `system_is_dark` (WinRT's `UISettings`), on two threads one
//! after the other, each entering and leaving its own single-threaded apartment.
#![cfg(windows)]

use sweetview_platform_loop::ComApartment;

fn read_in_a_fresh_apartment() -> bool {
  std::thread::spawn(|| {
    let apartment = ComApartment::enter().expect("an STA");
    let dark = sweetview_platform_window::system_is_dark();
    drop(apartment);
    dark
  })
  .join()
  .expect("the thread")
}

#[test]
fn the_system_theme_reads_in_an_apartment_made_after_the_last_one_was_left() {
  let first = read_in_a_fresh_apartment();
  let second = read_in_a_fresh_apartment();
  let third = read_in_a_fresh_apartment();
  assert_eq!((first, second), (second, third), "the same theme each time");
}
