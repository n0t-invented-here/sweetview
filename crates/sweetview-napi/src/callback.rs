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
//! The function is held through a guard, a small JavaScript function made by
//! this thread's [`GUARD_SCRIPT`] that calls it and catches what it throws, in
//! JavaScript. While a sink is set, the guard hands the sink the value thrown,
//! as it is, and throws `undefined` on to napi instead. napi turns a thrown
//! value into an `Error` by making a reference to it (which Bun refuses for a
//! primitive below Node-API 10), by calling its `toString` and by reading its
//! `cause`: none of that is done to an application's value while a listener
//! is set. With no sink the guard throws the value on, and napi turns it into
//! the stderr line as it always did.
//!
//! A callback is held in an `Rc` by its owner and cloned for the duration of
//! each call, so it may remove itself, replace itself or destroy its owner
//! from inside its own call.

use std::cell::RefCell;
use std::rc::Rc;

use napi::bindgen_prelude::{FnArgs, FromNapiValue, Function, FunctionRef, JsObjectValue, JsValuesTupleIntoVec, Null, Object, ObjectRef, Unknown};
use napi::{Env, JsValue};

pub(crate) struct JsCallback<Args: JsValuesTupleIntoVec, Return: FromNapiValue> {
  env: Env,
  /// The guard around the application's function (see the module's comment).
  function: FunctionRef<Args, Return>,
  /// What the function is, for the log line of a thrown exception.
  kind: &'static str,
  /// The application's own name for it, when it gave one (a binding's name).
  label: Option<String>,
}

impl<Args: JsValuesTupleIntoVec, Return: FromNapiValue> JsCallback<Args, Return> {
  pub(crate) fn new(env: Env, function: &Function<'_, Args, Return>, kind: &'static str) -> napi::Result<Rc<Self>> {
    Ok(Rc::new(Self { env, function: guarded(env, function, kind, None)?, kind, label: None }))
  }

  /// The same, with the name the application gave the function (a binding's name), which the
  /// sink is handed with an exception it throws.
  pub(crate) fn named(env: Env, function: &Function<'_, Args, Return>, kind: &'static str, label: &str) -> napi::Result<Rc<Self>> {
    Ok(Rc::new(Self { env, function: guarded(env, function, kind, Some(label))?, kind, label: Some(label.to_owned()) }))
  }

  /// Calls the function. `None` when it threw, or returned a value of the wrong type.
  pub(crate) fn call(&self, args: Args) -> Option<Return> {
    let outcome = self.env.run_in_scope(|| self.function.borrow_back(&self.env)?.call(args));
    match outcome {
      Ok(value) => Some(value),
      Err(error) => {
        match taken(&self.env) {
          // The guard handed what was thrown to the sink: the `undefined` it threw on is no fault.
          Taken::HandedOn => return None,
          // The sink threw: both lines, the callback's (napi's text of the stand-in the guard
          // threw on, as with no sink) and the sink's.
          Taken::SinkThrew(sink_text) => {
            eprintln!("sweetview: {} threw: {}", self.kind, error.reason);
            eprintln!("sweetview: the callback error sink threw: {sink_text}");
            return None;
          }
          Taken::Nothing => {}
        }
        // The TypeScript layer wraps every application handler and reports
        // its exception with that handler's own kind; this is the backstop
        // for anything that gets past it.
        report(self.kind, self.label.as_deref(), error);
        None
      }
    }
  }
}

/// Run once per thread that makes a callback: the guard, and the state it shares with this file.
/// `sink` is the application's sink or `null`; `handedOn` counts the values handed to it whose
/// `undefined` napi has not yet returned to [`JsCallback::call`] (one per guard on the stack);
/// `sinkThrew` holds the text of what the sink threw, when it threw, until that call takes it.
/// Nothing outside this file can reach the state.
///
/// With no sink, what napi is given in place of the value: a primitive other than a symbol as it
/// is (napi keeps no reference to one below Node-API 10, and that refusal is the line's text, as
/// it always was); anything else as a stand-in that carries the text napi made of it, its
/// `String()` form or nothing when that throws, and has no `cause` to follow. So the line reads as
/// it did, while napi's conversion runs no application code, leaves no exception pending (a
/// symbol's, or a `toString` that throws) and follows no `cause` (one that is itself overflowed
/// the stack).
const GUARD_SCRIPT: &str = r#"(() => {
  "use strict";
  const apply = Reflect.apply;
  const create = Object.create;
  const toText = String;
  const state = { sink: null, handedOn: 0, sinkThrew: null, guard: null };
  const textOf = (value) => {
    try {
      return toText(value);
    } catch {
      return "";
    }
  };
  const onward = (thrown) => {
    const type = typeof thrown;
    if (thrown === null || (type !== "object" && type !== "function" && type !== "symbol")) return thrown;
    let text = "";
    if (type !== "symbol") {
      try {
        text = toText(thrown);
      } catch {
        text = "";
      }
    }
    const standIn = create(null);
    standIn.toString = () => text;
    standIn.cause = undefined;
    return standIn;
  };
  state.guard = (fn, kind, label) =>
    function () {
      try {
        return apply(fn, this, arguments);
      } catch (thrown) {
        const sink = state.sink;
        if (sink === null) throw onward(thrown);
        try {
          sink(kind, label, thrown);
        } catch (sinkError) {
          state.sinkThrew = textOf(sinkError);
          throw onward(thrown);
        }
        state.handedOn += 1;
        throw undefined;
      }
    };
  return state;
})()"#;

/// The thread's guard state, with the env of the thread that made it, and whether a sink is set.
struct Guard {
  env: Env,
  state: ObjectRef<false>,
  sink_set: bool,
}

/// The thread's guard state. The reference is released by the environment's cleanup hook (added
/// when the state is made), while the environment is alive. If the slot still holds it when the
/// thread's storage is destroyed, the environment is gone and the reference cannot be deleted any
/// more: it is left as it is, and, when a sink was still set, a line says its release was missed.
struct GuardSlot(RefCell<Option<Guard>>);

impl Drop for GuardSlot {
  fn drop(&mut self) {
    if let Some(guard) = self.0.get_mut().take() {
      if guard.sink_set {
        eprintln!("sweetview: the callback error sink outlived its JavaScript environment");
      }
      // An ObjectRef<false> dropped undeleted: nothing is called on the gone environment.
      drop(guard.state);
    }
  }
}

thread_local! {
  static GUARD: GuardSlot = const { GuardSlot(RefCell::new(None)) };
}

/// Makes this thread's guard state, when the binding loads (`prepare_environment`).
pub(crate) fn prepare_guard(env: &Env) -> napi::Result<()> {
  env.run_in_scope(|| state(env).map(|_| ()))
}

/// This thread's guard state: made when the binding loads, else on first use.
fn state(env: &Env) -> napi::Result<Object<'_>> {
  if let Some(state) = GUARD.with(|slot| slot.0.borrow().as_ref().map(|guard| guard.state.get_value(env))) {
    return state;
  }
  let state: Object<'_> = env.run_script(GUARD_SCRIPT)?;
  let reference = state.create_ref::<false>()?;
  env.add_env_cleanup_hook(*env, release_guard)?;
  GUARD.with(|slot| *slot.0.borrow_mut() = Some(Guard { env: *env, state: reference, sink_set: false }));
  Ok(state)
}

/// Releases this thread's guard state, and the sink it holds, when its environment ends (the cleanup hook).
fn release_guard(_env: Env) {
  if let Some(guard) = GUARD.with(|slot| slot.0.borrow_mut().take()) {
    let _ = guard.state.unref(&guard.env);
  }
}

/// The guard maker: `(function, kind, label)` to the function inside its guard.
type GuardFunction<'scope, Args, Return> = Function<'scope, FnArgs<(Unknown<'scope>, String, Option<String>)>, Function<'scope, Args, Return>>;

/// `function` inside this thread's guard, with the names the sink is handed.
fn guarded<Args: JsValuesTupleIntoVec, Return: FromNapiValue>(env: Env, function: &Function<'_, Args, Return>, kind: &'static str, label: Option<&str>) -> napi::Result<FunctionRef<Args, Return>> {
  env.run_in_scope(|| {
    let state = state(&env)?;
    let guard: GuardFunction<'_, Args, Return> = state.get_named_property("guard")?;
    guard.call((function.to_unknown(), kind.to_owned(), label.map(str::to_owned)).into())?.create_ref()
  })
}

/// What the guard did with the exception a call just returned.
enum Taken {
  /// It handed the value to the sink, and threw `undefined` on.
  HandedOn,
  /// The sink threw (its text): the guard threw the value on as it does with no sink.
  SinkThrew(String),
  /// Nothing: the value (or the stand-in for it) reached napi with no sink set, or the failure is
  /// napi's own (a value of the wrong type returned).
  Nothing,
}

/// Takes what the guard left for the call that just returned an error: one count of `handedOn`,
/// or the text of what the sink threw.
fn taken(env: &Env) -> Taken {
  let outcome = env.run_in_scope(|| {
    let mut state = state(env)?;
    if let Some(text) = state.get_named_property::<Option<String>>("sinkThrew")? {
      state.set_named_property("sinkThrew", Null)?;
      return Ok(Taken::SinkThrew(text));
    }
    let pending: u32 = state.get_named_property("handedOn")?;
    if pending == 0 {
      return Ok(Taken::Nothing);
    }
    state.set_named_property("handedOn", pending - 1)?;
    Ok(Taken::HandedOn)
  });
  outcome.unwrap_or(Taken::Nothing)
}

/// Makes `sink` where a caught exception goes on this thread, in place of the stderr line, or puts
/// the stderr line back with `None`. The first use of the guard on a thread adds the environment
/// cleanup hook that releases it, and the sink with it, when the environment ends.
pub(crate) fn set_error_sink(env: Env, sink: Option<&Function<'_, SinkArgs, ()>>) -> napi::Result<()> {
  env.run_in_scope(|| {
    let mut state = state(&env)?;
    match sink {
      Some(function) => state.set_named_property("sink", function.to_unknown())?,
      None => state.set_named_property("sink", Null)?,
    }
    GUARD.with(|slot| {
      if let Some(guard) = slot.0.borrow_mut().as_mut() {
        guard.sink_set = sink.is_some();
      }
    });
    Ok(())
  })
}

/// What the sink is called with: the callback's kind, the application's name for it (or `null`),
/// and what was thrown. From the guard that is the value itself, whatever it is; from here (a
/// value of the wrong type returned, a failure of napi's own) it is an `Error` with napi's text.
pub type SinkArgs = FnArgs<(String, Option<String>, napi::Error)>;

/// Hands a caught exception the guard did not hand on to the sink, or prints the line when there
/// is none. When the sink itself throws, both lines are printed.
fn report(kind: &'static str, label: Option<&str>, error: napi::Error) {
  let reason = error.reason.clone();
  let env = GUARD.with(|slot| slot.0.borrow().as_ref().map(|guard| guard.env));
  let outcome = env.map(|env| {
    env.run_in_scope(|| {
      let state = state(&env)?;
      match state.get_named_property::<Option<Function<'_, SinkArgs, ()>>>("sink")? {
        Some(sink) => sink.call((kind.to_owned(), label.map(str::to_owned), error).into()).map(|()| true),
        None => Ok(false),
      }
    })
  });
  match outcome {
    Some(Ok(true)) => {}
    Some(Err(sink_error)) => {
      eprintln!("sweetview: {kind} threw: {reason}");
      eprintln!("sweetview: the callback error sink threw: {}", sink_error.reason);
    }
    Some(Ok(false)) | None => eprintln!("sweetview: {kind} threw: {reason}"),
  }
}
