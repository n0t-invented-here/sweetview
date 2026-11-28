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
  #[cfg(feature = "webview")]
  pub(crate) fn named(env: Env, function: &Function<'_, Args, Return>, kind: &'static str, label: &str) -> napi::Result<Rc<Self>> {
    Ok(Rc::new(Self { env, function: guarded(env, function, kind, Some(label))?, kind, label: Some(label.to_owned()) }))
  }

  /// Calls the function. `None` when it threw, or returned a value of the wrong type.
  pub(crate) fn call(&self, args: Args) -> Option<Return> {
    let outcome = self.env.run_in_scope(|| self.function.borrow_back(&self.env)?.call(args));
    match outcome {
      Ok(value) => Some(value),
      Err(error) => {
        match outcome_of(&error.reason) {
          // The guard handed what was thrown to the sink, which took it.
          Outcome::Told => return None,
          // The sink threw: the callback's line and the sink's.
          Outcome::SinkThrew { reason, sink } => {
            eprintln!("sweetview: {} threw: {reason}", self.kind);
            eprintln!("sweetview: the callback error sink threw: {sink}");
            return None;
          }
          // No sink was set when the callback threw: its line, whatever is set by now.
          Outcome::NoSink { reason } => {
            eprintln!("sweetview: {} threw: {reason}", self.kind);
            return None;
          }
          // napi's own failure (a value of the wrong type returned), not the guard's.
          Outcome::NotTheGuards => {}
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

/// Run when the binding loads on a thread: the guard, and the state it shares with this file
/// (`sink`, the application's sink or `null`). Nothing outside this file can reach the state.
///
/// Every exception the guard catches is answered by one it throws on to napi: a stand-in made
/// here, whose text (its `toString`, all napi reads of it) carries what the guard did with that
/// call's exception, after the thread's mark (`__MARK__`). So the outcome belongs to the call: a
/// callback made while the guard reads the value (its `toString` calls back into Sweetview) has
/// one of its own. The sink is read once, when the callback threw: the listeners told about a
/// fault are those set then. The text is `mark:outcome:reason:sink`, the last two percent-encoded:
/// `told` (the sink took the value), `sink` (the sink threw: the callback's line and the sink's),
/// `none` (no sink was set: the callback's line).
///
/// `reason` is the text napi made of a thrown value on the main branch: for a primitive other
/// than a symbol, its refusal to keep a reference to one below Node-API 10 (this binding is
/// `napi8`); for a symbol, nothing; for anything else, its `String()` form, or nothing when that
/// throws. So the line reads as it did, while napi's conversion runs no application code, leaves
/// no exception pending and follows no `cause` (one that is itself overflowed the stack).
const GUARD_SCRIPT: &str = r#"(() => {
  "use strict";
  const MARK = "__MARK__";
  const apply = Reflect.apply;
  const create = Object.create;
  const toText = String;
  const encode = encodeURIComponent;
  // An unpaired surrogate makes encodeURIComponent throw: each becomes U+FFFD first, so only it is lost.
  const toWellFormed = String.prototype.toWellFormed;
  const state = { sink: null, guard: null };
  const textOf = (value) => {
    try {
      return toText(value);
    } catch {
      return "";
    }
  };
  const encoded = (text) => {
    try {
      return encode(apply(toWellFormed, text, []));
    } catch {
      return encode("(text that is not well-formed)");
    }
  };
  const napiText = (thrown) => {
    const type = typeof thrown;
    if (type === "symbol") return "";
    if (thrown === null || (type !== "object" && type !== "function")) return "Create Error reference failed";
    return textOf(thrown);
  };
  const outcome = (what, reason, sink) => {
    const text = MARK + ":" + what + ":" + encoded(reason) + ":" + encoded(sink);
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
        if (sink === null) throw outcome("none", napiText(thrown), "");
        try {
          sink(kind, label, thrown);
        } catch (sinkError) {
          throw outcome("sink", napiText(thrown), textOf(sinkError));
        }
        throw outcome("told", "", "");
      }
    };
  return state;
})()"#;

/// The thread's guard state, with the env of the thread that made it, and whether a sink is set.
struct Guard {
  env: Env,
  state: ObjectRef<false>,
  sink_set: bool,
  /// What marks this thread's stand-ins (see [`GUARD_SCRIPT`]): not to be guessed by a value an
  /// application throws.
  mark: String,
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
  let mark = new_mark();
  let state: Object<'_> = env.run_script(GUARD_SCRIPT.replace("__MARK__", &mark))?;
  let reference = state.create_ref::<false>()?;
  env.add_env_cleanup_hook(*env, release_guard)?;
  GUARD.with(|slot| *slot.0.borrow_mut() = Some(Guard { env: *env, state: reference, sink_set: false, mark }));
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

/// A mark for a thread's guard: random, from the standard library's per-process hash keys.
fn new_mark() -> String {
  use std::hash::{BuildHasher, Hasher};
  let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
  hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
  format!("sweetview-guard-{:016x}", hasher.finish())
}

/// What the guard did with the exception one call returned (see [`GUARD_SCRIPT`]).
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
  Told,
  SinkThrew { reason: String, sink: String },
  NoSink { reason: String },
  /// The error is none of the guard's stand-ins: napi's own failure.
  NotTheGuards,
}

/// The outcome a returned error's text carries, read with this thread's mark.
fn outcome_of(reason: &str) -> Outcome {
  match GUARD.with(|slot| slot.0.borrow().as_ref().map(|guard| guard.mark.clone())) {
    Some(mark) => decode_outcome(reason, &mark),
    None => Outcome::NotTheGuards,
  }
}

/// `mark:outcome:reason:sink`, the last two percent-encoded; any other text is not the guard's.
fn decode_outcome(text: &str, mark: &str) -> Outcome {
  let Some(rest) = text.strip_prefix(mark).and_then(|rest| rest.strip_prefix(':')) else {
    return Outcome::NotTheGuards;
  };
  let mut fields = rest.splitn(3, ':');
  let (Some(what), Some(reason), Some(sink)) = (fields.next(), fields.next(), fields.next()) else {
    return Outcome::NotTheGuards;
  };
  match what {
    "told" => Outcome::Told,
    "sink" => Outcome::SinkThrew { reason: percent_decoded(reason), sink: percent_decoded(sink) },
    "none" => Outcome::NoSink { reason: percent_decoded(reason) },
    _ => Outcome::NotTheGuards,
  }
}

/// The text `encodeURIComponent` encoded.
fn percent_decoded(text: &str) -> String {
  let bytes = text.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    let digit = |at: usize| bytes.get(at).and_then(|&b| (b as char).to_digit(16));
    if bytes[i] == b'%' {
      if let (Some(high), Some(low)) = (digit(i + 1), digit(i + 2)) {
        out.push((high * 16 + low) as u8);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
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

#[cfg(test)]
mod tests {
  use super::{decode_outcome, percent_decoded, Outcome};

  const MARK: &str = "sweetview-guard-0123456789abcdef";

  // Review 4, C2 and C5: each call's outcome is read from the error that call returned, so a
  // nested call's cannot be taken for it, and "no sink when it threw" is its own outcome.
  #[test]
  fn each_outcome_is_read_from_the_calls_own_text() {
    assert_eq!(decode_outcome(&format!("{MARK}:told::"), MARK), Outcome::Told);
    assert_eq!(decode_outcome(&format!("{MARK}:none:Error%3A%20boom:"), MARK), Outcome::NoSink { reason: "Error: boom".into() });
    assert_eq!(
      decode_outcome(&format!("{MARK}:sink:Create%20Error%20reference%20failed:Error%3A%20sink%20%E2%9C%93%0Aline"), MARK),
      Outcome::SinkThrew { reason: "Create Error reference failed".into(), sink: "Error: sink \u{2713}\nline".into() }
    );
  }

  #[test]
  fn a_text_without_this_threads_mark_is_not_the_guards() {
    for text in ["Error: boom", "Create Error reference failed", "sweetview-guard-ffffffffffffffff:told::", &format!("{MARK}:told"), &format!("{MARK}:else::"), &format!("{MARK}told::")] {
      assert_eq!(decode_outcome(text, MARK), Outcome::NotTheGuards, "{text}");
    }
  }

  #[test]
  fn percent_decoding_keeps_what_is_not_an_escape() {
    assert_eq!(percent_decoded("100%25%20sure%"), "100% sure%");
    assert_eq!(percent_decoded("%zz%4"), "%zz%4");
  }
}
