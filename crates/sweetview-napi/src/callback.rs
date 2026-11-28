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
//! * a JavaScript exception is caught here, logged, and reported to the caller
//!   as `None`. Nothing unwinds into the OS.
//!
//! A callback is held in an `Rc` by its owner and cloned for the duration of
//! each call, so it may remove itself, replace itself or destroy its owner
//! from inside its own call.
//!
//! While the blocking loop runs (`runLoop()`), Bun's own event loop does not
//! turn, so nothing would run a promise's continuation. A call that returns
//! to the loop itself (no other callback below it on the stack) is therefore
//! followed by the settle function the TypeScript layer registers, which
//! drains the microtask queue, as Node does when the outermost callback scope
//! closes. A callback inside another one (a handler that opened a modal
//! dialog, or made a webview, which pumps while it starts) is not followed by
//! it: JavaScript is still on the stack there.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use napi::bindgen_prelude::{FromNapiValue, Function, FunctionRef, JsValuesTupleIntoVec};
use napi::Env;

pub(crate) struct JsCallback<Args: JsValuesTupleIntoVec, Return: FromNapiValue> {
  env: Env,
  function: FunctionRef<Args, Return>,
  /// What the function is, for the log line of a thrown exception.
  kind: &'static str,
}

thread_local! {
  /// How many callbacks are on this thread's stack.
  static DEPTH: Cell<u32> = const { Cell::new(0) };
  /// What runs after a callback that returns to the blocking loop itself.
  static SETTLE: RefCell<Option<Rc<JsCallback<(), ()>>>> = const { RefCell::new(None) };
}

/// Makes `settle` what runs after each callback that returns to the blocking
/// loop itself; `None` removes it.
pub(crate) fn set_settle(settle: Option<Rc<JsCallback<(), ()>>>) {
  let old = SETTLE.with(|slot| slot.replace(settle));
  // Dropped outside the borrow: releasing a reference runs no JavaScript, but keep the slot free anyway.
  drop(old);
}

/// Counts a callback on the stack for as long as it lives.
struct Depth;

impl Depth {
  fn enter() -> Self {
    DEPTH.with(|d| d.set(d.get() + 1));
    Depth
  }
}

impl Drop for Depth {
  fn drop(&mut self) {
    DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
  }
}

/// After a callback returned to the loop: settles, when the blocking loop is the one running.
fn settle_after_outermost() {
  if DEPTH.with(Cell::get) != 0 {
    return;
  }
  let Some(settle) = SETTLE.with(|slot| slot.borrow().clone()) else { return };
  let blocking = sweetview_runtime::Runtime::get().map(|runtime| runtime.is_blocking()).unwrap_or(false);
  if !blocking {
    // Under the pumped loop the pump returns to Bun, which settles by itself.
    return;
  }
  // Counted as a callback: a callback its continuations make (a webview pumping as it starts)
  // is inside this one and settles nothing itself.
  let _depth = Depth::enter();
  settle.invoke(());
}

impl<Args: JsValuesTupleIntoVec, Return: FromNapiValue> JsCallback<Args, Return> {
  pub(crate) fn new(env: Env, function: &Function<'_, Args, Return>, kind: &'static str) -> napi::Result<Rc<Self>> {
    Ok(Rc::new(Self { env, function: function.create_ref()?, kind }))
  }

  /// Calls the function. `None` when it threw, or returned a value of the wrong type.
  /// Returning to the blocking loop itself, it then settles the microtasks the call queued.
  pub(crate) fn call(&self, args: Args) -> Option<Return> {
    let result = {
      let _depth = Depth::enter();
      self.invoke(args)
    };
    settle_after_outermost();
    result
  }

  /// The call itself, with nothing after it.
  fn invoke(&self, args: Args) -> Option<Return> {
    let outcome = self.env.run_in_scope(|| self.function.borrow_back(&self.env)?.call(args));
    match outcome {
      Ok(value) => Some(value),
      Err(error) => {
        // The TypeScript layer wraps every application handler and logs its
        // exception with that handler's own message; this line is the
        // backstop for anything that gets past it.
        eprintln!("sweetview: {} threw: {}", self.kind, error.reason);
        None
      }
    }
  }
}
