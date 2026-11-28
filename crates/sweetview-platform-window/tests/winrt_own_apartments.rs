//! S2 of D46's first review: a WinRT read that does not pass through `ComApartment` (a thread that
//! entered its apartment itself, as a host, `tao` or WebView2 can) is safe too. Two threads one
//! after the other each enter a single-threaded apartment with `CoInitializeEx`, read the system
//! theme and the double-click time (WinRT's `UISettings`), and leave. Before the hold was taken by
//! those reads themselves, the second faulted: the factory the `windows` crate cached on the first
//! pointed into a DLL COM had unloaded when the first apartment was left. A file of its own, so no
//! other test of the process takes the hold first.
#![cfg(windows)]
#![allow(unsafe_code)]

use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

fn read_in_an_apartment_of_its_own() -> (bool, u32) {
  std::thread::spawn(|| {
    // SAFETY: one call with no reserved pointer; balanced by the `CoUninitialize` below, on this thread.
    let entered = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let read = (sweetview_platform_window::system_is_dark(), sweetview_platform_window::double_click_time_ms());
    if entered {
      // SAFETY: matches the successful `CoInitializeEx` above, on the same thread.
      unsafe { CoUninitialize() };
    }
    read
  })
  .join()
  .expect("the thread")
}

#[test]
fn winrt_reads_in_apartments_entered_without_comapartment_one_after_the_other() {
  let first = read_in_an_apartment_of_its_own();
  let second = read_in_an_apartment_of_its_own();
  assert_eq!(first, second, "the same answers each time");
}
