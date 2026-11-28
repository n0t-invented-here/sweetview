//! `modal-loop.test.ts` "a process that exits with a native interval still set ends cleanly"
//! (D38, the third review's H2), as an application's process: its main thread is the UI thread,
//! the runtime is held by its thread-local storage alone, and the main thread calls the exit. So
//! this test has no harness (`harness = false`): `main` runs this file again as a child that waits
//! for a live 10 ms interval to tick at least five times, then exits with it still set. The child
//! must end with code 0 within 300 ms of its exit call, with nothing on stderr.
//!
//! What a Rust executable cannot show: here the thread-local destructors run at exit after
//! user32 has been detached, so the runtime's drop stops at its first window call and the
//! `SignalWindow`'s own drop is never reached; under Bun the binding unloads before user32 and it
//! is. That drop (wait for nothing, join nothing) is proven where it lives:
//! `sweetview-platform-loop`'s `a_drop_waits_for_nothing_and_joins_nothing_when_the_tick_thread_can_no_longer_answer`.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sweetview_runtime::{threads, Runtime};

/// Set in the environment of the child process.
const CHILD: &str = "SWEETVIEW_RUNTIME_TEST_EXIT_WITH_TIMER";

fn epoch_ms() -> u128 {
  SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_millis()
}

fn child() -> ! {
  assert!(threads::claim_ui_thread());
  let runtime = Runtime::get().expect("runtime");
  let ticks = Rc::new(Cell::new(0u32));
  let counted = ticks.clone();
  runtime.set_interval(10, move || counted.set(counted.get() + 1)).expect("interval");
  let deadline = Instant::now() + Duration::from_secs(5);
  while ticks.get() < 5 && Instant::now() < deadline {
    runtime.pump();
    std::thread::sleep(Duration::from_millis(5));
  }
  // From here only the thread-local holds the runtime, as in the binding; the interval stays set.
  drop(runtime);
  println!("TICKED {}", ticks.get());
  println!("EXIT_AT {}", epoch_ms());
  use std::io::Write;
  let _ = std::io::stdout().flush();
  std::process::exit(0);
}

fn main() {
  if !cfg!(windows) {
    return;
  }
  if std::env::var_os(CHILD).is_some() {
    child();
  }
  print!("test a_process_that_exits_with_an_interval_still_set_ends_cleanly ... ");
  let output = std::process::Command::new(std::env::current_exe().expect("the test executable")).env(CHILD, "1").output().expect("the child process");
  let ended_ms = epoch_ms();
  let (stdout, stderr) = (String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
  let number = |key: &str| stdout.lines().find_map(|line| line.strip_prefix(key)?.trim().parse::<u128>().ok());
  assert_eq!(output.status.code(), Some(0), "the child's exit code; stdout {stdout}, stderr {stderr}");
  assert!(stderr.trim().is_empty(), "nothing on the child's stderr: {stderr}");
  let ticked = number("TICKED ").expect("the child reported its ticks");
  assert!(ticked >= 5, "the interval ticked in the child: {ticked}");
  let exit_at = number("EXIT_AT ").expect("the child reported its exit call");
  let took = ended_ms.saturating_sub(exit_at);
  assert!(took < 300, "the child ended {took} ms after its exit call");
  println!("ok ({ticked} ticks; ended {took} ms after its exit call)");
}
