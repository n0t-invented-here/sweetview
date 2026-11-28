//! A JavaScript function the runtime calls back.
//!
//! The runtime calls JavaScript synchronously, on the UI thread, from inside
//! the native call that is running the loop (or from inside a modal loop a
//! handler opened). A [`JsCallback`] is what makes that safe to do:
//!
//! * it holds a reference to the function, so the function lives as long as
//!   the native side can call it, and the reference is released when the
//!   callback is dropped;
//! * each call opens its own handle scope, so a loop that runs for hours does
//!   not accumulate handles;
//! * a JavaScript exception is caught here, reported, and returned to the
//!   caller as `None`. Nothing unwinds into the OS. Reported means the line
//!   `sweetview: <kind> threw: <reason>` on stderr, or, while the application
//!   has an `onCallbackError` listener, the sink it registered on this thread
//!   (`set_error_sink`).
//!
//! A callback is held in an `Rc` by its owner and cloned for the duration of
//! each call, so it may remove itself, replace itself or destroy its owner
//! from inside its own call.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use napi::bindgen_prelude::{FnArgs, FromNapiValue, Function, FunctionRef, JsValuesTupleIntoVec};
use napi::Env;

pub(crate) struct JsCallback<Args: JsValuesTupleIntoVec, Return: FromNapiValue> {
  env: Env,
  function: FunctionRef<Args, Return>,
  /// What the function is, for the log line of a thrown exception.
  kind: &'static str,
}

impl<Args: JsValuesTupleIntoVec, Return: FromNapiValue> JsCallback<Args, Return> {
  pub(crate) fn new(env: Env, function: &Function<'_, Args, Return>, kind: &'static str) -> napi::Result<Rc<Self>> {
    Ok(Rc::new(Self { env, function: function.create_ref()?, kind }))
  }

  /// Calls the function. `None` when it threw, or returned a value of the wrong type.
  pub(crate) fn call(&self, args: Args) -> Option<Return> {
    let outcome = self.env.run_in_scope(|| self.function.borrow_back(&self.env)?.call(args));
    match outcome {
      Ok(value) => Some(value),
      Err(error) => {
        // The TypeScript layer wraps every application handler and reports
        // its exception with that handler's own kind; this is the backstop
        // for anything that gets past it.
        report(self.kind, &error.reason);
        None
      }
    }
  }
}

/// The application's sink for the exceptions caught here, with the env of the thread that set it.
/// `onCallbackError` of `@n1h/sweetview-native` sets one while it has a listener, on the UI thread
/// only (`set_callback_error_sink` checks it).
struct ErrorSink {
  env: Env,
  function: Rc<FunctionRef<FnArgs<(String, String)>, ()>>,
}

/// The thread's sink. The reference is released by the environment's cleanup hook
/// (`set_error_sink` adds it), while the environment is alive. If the slot still holds a sink
/// when the thread's storage is destroyed, the environment is gone and the reference cannot be
/// deleted any more: it is left as it is, and a line says the release was missed.
struct SinkSlot(RefCell<Option<ErrorSink>>);

impl Drop for SinkSlot {
  fn drop(&mut self) {
    if let Some(sink) = self.0.get_mut().take() {
      std::mem::forget(sink);
      eprintln!("sweetview: the callback error sink outlived its JavaScript environment");
    }
  }
}

thread_local! {
  static ERROR_SINK: SinkSlot = const { SinkSlot(RefCell::new(None)) };
  /// Whether the cleanup hook that releases the sink is added for this thread's environment.
  static RELEASED_AT_CLEANUP: Cell<bool> = const { Cell::new(false) };
}

/// Makes `sink` where a caught exception's kind and reason go on this thread, in place of the
/// stderr line, or puts the stderr line back with `None`. The first sink a thread sets adds the
/// environment cleanup hook that releases it when the environment ends, whatever else the
/// application made.
pub(crate) fn set_error_sink(env: Env, sink: Option<&Function<'_, FnArgs<(String, String)>, ()>>) -> napi::Result<()> {
  let sink = match sink {
    Some(function) => Some(ErrorSink { env, function: Rc::new(function.create_ref()?) }),
    None => None,
  };
  if sink.is_some() && !RELEASED_AT_CLEANUP.get() {
    env.add_env_cleanup_hook((), |()| clear_error_sink())?;
    RELEASED_AT_CLEANUP.set(true);
  }
  let previous = ERROR_SINK.with(|slot| slot.0.replace(sink));
  drop(previous);
  Ok(())
}

/// Releases this thread's sink, when its environment ends (the cleanup hook).
fn clear_error_sink() {
  let sink = ERROR_SINK.with(|slot| slot.0.borrow_mut().take());
  drop(sink);
}

/// Hands a caught exception to the sink, or prints the line when there is none. When the sink
/// itself throws, both lines are printed.
fn report(kind: &'static str, reason: &str) {
  // Cloned out of the slot, so the sink may replace or remove itself from inside its own call.
  let sink = ERROR_SINK.with(|slot| slot.0.borrow().as_ref().map(|sink| (sink.env, Rc::clone(&sink.function))));
  let Some((env, function)) = sink else {
    eprintln!("sweetview: {kind} threw: {reason}");
    return;
  };
  let outcome = env.run_in_scope(|| function.borrow_back(&env)?.call((kind.to_owned(), reason.to_owned()).into()));
  if let Err(sink_error) = outcome {
    eprintln!("sweetview: {kind} threw: {reason}");
    eprintln!("sweetview: the callback error sink threw: {}", sink_error.reason);
  }
}
