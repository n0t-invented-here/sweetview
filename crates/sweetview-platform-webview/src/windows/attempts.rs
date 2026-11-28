//! The C++ fork's attempts at making a webview (`win32_edge.hh` 234 to 266
//! and 404 to 425), as one loop over two calls so the rules can be tested
//! with faults injected: each attempt creates a WebView2 environment and
//! starts the controller on the environment that attempt returned, all under
//! one budget of [`MAX_ATTEMPTS`].
//!
//! - The environment call failing at once (`try_create_environment`): with
//!   `ERROR_INVALID_STATE` it gives up; otherwise it waits and tries again.
//! - The environment's completion failing, or the controller call failing at
//!   once (whatever the result, `E_ABORT` included): it tries again at once.
//! - The controller's completion failing: with `ERROR_INVALID_STATE` or
//!   `E_ABORT` (the parent window is gone) it gives up; otherwise it tries
//!   again at once.
//! - A `WM_QUIT` while it waits for either completion cancels.

use std::time::Duration;

use sweetview_http::ErrorCode;
use windows::core::HRESULT;
use windows::Win32::Foundation::{ERROR_INVALID_STATE, E_ABORT};

/// The fork's attempts and the wait between them (`m_max_attempts`, `m_sleep_ms`).
pub(super) const MAX_ATTEMPTS: u32 = 60;
pub(super) const RETRY_WAIT: Duration = Duration::from_millis(200);

/// How one of the two calls failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failed {
    /// The call itself returned this.
    AtOnce(HRESULT),
    /// The call started, and its completion reported this.
    Completed(HRESULT),
    /// A `WM_QUIT` arrived while the completion was awaited.
    Quit,
}

fn invalid_state() -> HRESULT {
    HRESULT::from_win32(ERROR_INVALID_STATE.0)
}

/// Runs the attempts: `environment(attempt)` makes this attempt's environment
/// (attempt 0 may hand back one the thread already has), `controller(&env)`
/// makes the controller on it, `wait()` is the pause after the environment
/// call fails at once. The environment and controller of the attempt that
/// made one.
pub(super) fn attempt<E, C>(
    mut environment: impl FnMut(u32) -> Result<E, Failed>,
    mut controller: impl FnMut(&E) -> Result<C, Failed>,
    mut wait: impl FnMut(),
) -> Result<(E, C), ErrorCode> {
    for number in 0..MAX_ATTEMPTS {
        let made = match environment(number) {
            Ok(made) => made,
            Err(Failed::Quit) => return Err(ErrorCode::Canceled),
            Err(Failed::AtOnce(code)) if code == invalid_state() => return Err(ErrorCode::InvalidState),
            Err(Failed::AtOnce(_)) => {
                wait();
                continue;
            }
            Err(Failed::Completed(_)) => continue,
        };
        match controller(&made) {
            Ok(controller) => return Ok((made, controller)),
            Err(Failed::Quit) => return Err(ErrorCode::Canceled),
            Err(Failed::Completed(code)) if code == invalid_state() || code == E_ABORT => return Err(ErrorCode::InvalidState),
            Err(Failed::Completed(_) | Failed::AtOnce(_)) => continue,
        }
    }
    Err(ErrorCode::InvalidState)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use windows::Win32::Foundation::E_FAIL;

    /// Scripted outcomes for each call, in order, and what was asked.
    struct Faults {
        environments: RefCell<Vec<Result<u32, Failed>>>,
        controllers: RefCell<Vec<Result<(), Failed>>>,
        asked: RefCell<Vec<String>>,
        waits: RefCell<u32>,
    }

    impl Faults {
        fn new(environments: Vec<Result<u32, Failed>>, controllers: Vec<Result<(), Failed>>) -> Self {
            Self { environments: RefCell::new(environments), controllers: RefCell::new(controllers), asked: RefCell::default(), waits: RefCell::default() }
        }

        fn run(&self) -> Result<(u32, u32), ErrorCode> {
            attempt(
                |number| {
                    self.asked.borrow_mut().push(format!("environment {number}"));
                    let mut left = self.environments.borrow_mut();
                    if left.is_empty() { Ok(100 + number) } else { left.remove(0) }
                },
                |environment: &u32| {
                    self.asked.borrow_mut().push(format!("controller on {environment}"));
                    let mut left = self.controllers.borrow_mut();
                    let outcome = if left.is_empty() { Ok(()) } else { left.remove(0) };
                    outcome.map(|()| *environment)
                },
                || *self.waits.borrow_mut() += 1,
            )
        }
    }

    #[test]
    fn a_retried_controller_starts_on_the_environment_its_own_attempt_made() {
        // The fork goes back through the environment's creation on every retryable failure.
        let faults = Faults::new(vec![Ok(1), Ok(2), Ok(3)], vec![Err(Failed::Completed(E_FAIL)), Err(Failed::AtOnce(E_FAIL))]);
        assert_eq!(faults.run(), Ok((3, 3)));
        assert_eq!(*faults.asked.borrow(), ["environment 0", "controller on 1", "environment 1", "controller on 2", "environment 2", "controller on 3"]);
        assert_eq!(*faults.waits.borrow(), 0, "no pause after a controller failure");
    }

    #[test]
    fn one_budget_counts_every_attempt_whichever_call_failed() {
        let mut controllers = Vec::new();
        let mut environments = Vec::new();
        for n in 0..MAX_ATTEMPTS {
            if n % 2 == 0 {
                environments.push(Err(Failed::Completed(E_FAIL)));
            } else {
                environments.push(Ok(n));
                controllers.push(Err(Failed::Completed(E_FAIL)));
            }
        }
        environments.push(Ok(999));
        let faults = Faults::new(environments, controllers);
        assert_eq!(faults.run(), Err(ErrorCode::InvalidState));
        let asked = faults.asked.borrow();
        assert_eq!(asked.iter().filter(|a| a.starts_with("environment")).count(), MAX_ATTEMPTS as usize, "{MAX_ATTEMPTS} attempts in all");
        assert!(!asked.iter().any(|a| a == "controller on 999"), "nothing after the budget");
    }

    #[test]
    fn the_failures_the_fork_gives_up_on_are_judged_in_the_controller_s_completion() {
        // E_ABORT and ERROR_INVALID_STATE in the controller's completion give up.
        for code in [E_ABORT, invalid_state()] {
            let faults = Faults::new(vec![], vec![Err(Failed::Completed(code))]);
            assert_eq!(faults.run(), Err(ErrorCode::InvalidState), "{code:?}");
            assert_eq!(faults.asked.borrow().len(), 2, "{code:?}: no retry");
        }
        // The same results from the controller call itself are tried again.
        for code in [E_ABORT, invalid_state()] {
            let faults = Faults::new(vec![], vec![Err(Failed::AtOnce(code))]);
            assert_eq!(faults.run(), Ok((101, 101)), "{code:?} at once: tried again");
        }
        // The environment call failing at once with ERROR_INVALID_STATE gives up; any other
        // result waits and tries again, as does a failed environment completion (at once).
        let faults = Faults::new(vec![Err(Failed::AtOnce(invalid_state()))], vec![]);
        assert_eq!(faults.run(), Err(ErrorCode::InvalidState));
        let faults = Faults::new(vec![Err(Failed::AtOnce(E_ABORT)), Err(Failed::Completed(invalid_state())), Ok(7)], vec![]);
        assert_eq!(faults.run(), Ok((7, 7)));
        assert_eq!(*faults.waits.borrow(), 1, "a pause after the environment call failed at once, none after its completion failed");
    }

    #[test]
    fn a_quit_while_waiting_cancels() {
        assert_eq!(Faults::new(vec![Err(Failed::Quit)], vec![]).run(), Err(ErrorCode::Canceled));
        assert_eq!(Faults::new(vec![], vec![Err(Failed::Quit)]).run(), Err(ErrorCode::Canceled));
    }
}
