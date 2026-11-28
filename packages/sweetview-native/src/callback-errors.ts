// Exceptions thrown by an application's callbacks. The native module calls an application's
// handlers (a tray click, a menu item, a window listener, a hook, ...) on the UI thread, from inside
// the event loop, and catches what they throw there: an exception never unwinds into the OS and
// never ends the loop (W1.3). Every such catch of this package, in the TypeScript and in the
// binding, hands the exception to `reportCallbackError`. With no listener set it does exactly what
// that catch did before: the same `console.error` line. With one set, the listener is told
// instead, and the callback's own fallback (the event let through, no menu opened) still applies.
//
// The catches of `@n1h/sweetview` (a page's UI-thread methods, a request handler, the ready hooks,
// the worker's crash and rejected calls, the tab machinery) do not reach this module: it is no
// entry point of the package, and an application must not be able to call it to fabricate a fault
// (D44). What does reach it from that package is what leaves its code into this one's catches: an
// `onEvent` listener's exception, which leaves the worker's drain (`ui-thread.ts`, kind `worker`).

import { isMainThread } from "node:worker_threads";
import { binding } from "./binding";
import { macosKeepsTagPath } from "./platform";
import { asError, describeThrown } from "./thrown";

/**
 * Where an exception came from: the public API the application wrote the handler for. `internal` is
 * the native module's own code at a callback boundary (the tab frame's callbacks, a window's
 * dispose hooks, its own native timeouts, intervals and deferred jobs); a fault there is a defect
 * of Sweetview's.
 */
export type CallbackKind =
  | "tray.onClick"
  | "tray.onDoubleClick"
  | "tray.menu"
  | "menu.click"
  | "notifier.onClick"
  | "window.onClose"
  | "window.onResize"
  | "window.onMove"
  | "window.onMaximizeChange"
  | "window.onFileDrop"
  | "window.onNewTab"
  | "window.onTabSelect"
  | "window.onTabClose"
  | "hitRegions.refine"
  | "mouseHook"
  | "keyboardHook"
  | "singleInstance.onSecondInstance"
  | "onOpenUrl"
  | "webview.bind"
  | "webview.bindRaw"
  | "webview.setRequestHandler"
  | "webview.setFileDropHandler"
  | "worker"
  | "internal";

/** What `onCallbackError` is told about an exception, besides the error. */
export type CallbackErrorSource = {
  /** The kind of callback that threw. */
  readonly kind: CallbackKind;
  /**
   * For `webview.bind` and `webview.bindRaw`, the name the function was bound under. For any other
   * exception the binding caught itself, the binding's name for the callback (such as
   * `a tray click handler`). Absent otherwise.
   */
  readonly name?: string;
};

/** Told about an exception Sweetview caught at a callback boundary. */
export type CallbackErrorHandler = (error: Error, source: CallbackErrorSource) => void;

/**
 * What a catch prints when no listener is set: a `console.error` line followed by the error (a
 * string), its own output (a function), or nothing (`null`: a page call or a request, which go
 * back to the page instead).
 */
export type DefaultReport = string | ((error: unknown) => void) | null;

/** One entry per registration, so each unsubscribe removes its own, once, even for the same function. */
const listeners = new Set<{ readonly handler: CallbackErrorHandler }>();

function printDefault(kind: CallbackKind, error: unknown, fallback: DefaultReport): void {
  if (typeof fallback === "function") fallback(error);
  else console.error(fallback ?? `sweetview: ${kind} threw:`, error);
}

/**
 * Hands an exception a catch at a callback boundary caught to the application's listeners, or does
 * what that catch did before when there are none (and on macOS, until its goal). With a listener
 * set it never throws, whatever was thrown, so the catch's fallback always follows.
 */
export function reportCallbackError(kind: CallbackKind, error: unknown, fallback: DefaultReport, name?: string): void {
  // macOS keeps the main branch's path until its goal (D42): no listener is called there.
  if (listeners.size === 0 || macosKeepsTagPath()) {
    if (fallback !== null) printDefault(kind, error, fallback);
    return;
  }
  // A fault raised while a report is in progress (application code it runs: the thrown value's
  // conversion, or a listener that calls back into Sweetview, whose callback throws) is printed,
  // not delivered again, as a nested pump does nothing (D40): the report ends, and the fault is not
  // lost.
  if (delivering) {
    printNested(kind, error, fallback);
    return;
  }
  // The listeners present when the fault came, taken before anything of the value is read: its
  // conversion can run application code, which may add or remove a listener.
  const present = [...listeners];
  delivering = true;
  try {
    const source: CallbackErrorSource = name === undefined ? { kind } : { kind, name };
    deliver(present, asError(error), source, kind, error, fallback);
  } finally {
    delivering = false;
  }
}

let delivering = false;
let printingNested = false;

/**
 * Prints a fault raised during a report with its catch's line. Printing inspects the value, which
 * can run application code and raise yet another report: that one is printed as text alone, without
 * the value, so it ends.
 */
function printNested(kind: CallbackKind, error: unknown, fallback: DefaultReport): void {
  try {
    if (printingNested) {
      console.error(`sweetview: ${kind} threw while another fault was being reported`);
      return;
    }
    printingNested = true;
    try {
      printDefault(kind, error, fallback);
    } finally {
      printingNested = false;
    }
  } catch {
    // console.error itself replaced by something that throws: nothing more to do.
  }
}

function deliver(present: readonly { readonly handler: CallbackErrorHandler }[], wrapped: Error, source: CallbackErrorSource, kind: CallbackKind, error: unknown, fallback: DefaultReport): void {
  for (const { handler } of present) {
    try {
      handler(wrapped, source);
    } catch (listenerError) {
      // A listener that throws never takes the application down: both errors are printed.
      try {
        printDefault(kind, error, fallback);
        console.error("sweetview: an onCallbackError handler threw:", listenerError);
      } catch {
        // console.error itself replaced by something that throws: nothing more to do.
      }
    }
  }
}

// What the binding calls its callbacks (crates/sweetview-napi), as the public kinds.
const BINDING_KINDS: Record<string, CallbackKind> = {
  "a tray click handler": "tray.onClick",
  "a tray double-click handler": "tray.onDoubleClick",
  "a tray menu function": "tray.menu",
  "a tray menu handler": "menu.click",
  "a notification onClick": "notifier.onClick",
  "an onClose handler": "window.onClose",
  "an onResize handler": "window.onResize",
  "an onMove handler": "window.onMove",
  "an onMaximizeChange handler": "window.onMaximizeChange",
  "an onFileDrop handler": "window.onFileDrop",
  "a file drop handler": "webview.setFileDropHandler",
  "a binding": "webview.bindRaw",
  "a request handler": "webview.setRequestHandler",
  "a hit-region refiner": "hitRegions.refine",
  "a mouse hook handler": "mouseHook",
  "a keyboard hook handler": "keyboardHook",
  "a singleInstance onSecondInstance": "singleInstance.onSecondInstance",
  "a drain function": "worker",
};

/** The binding's kind string as a public kind; one with no public counterpart is `internal`. */
export const kindOfBindingCallback = (bindingKind: string): CallbackKind => BINDING_KINDS[bindingKind] ?? "internal";

let sinkRegistered = false;
let releasedAtExit = false;

/**
 * Routes the binding's own last-resort catch (`sweetview: <kind> threw: <reason>` on stderr, from
 * Rust) here while a listener is set, and back to stderr when the last one is removed.
 */
function setBindingSink(on: boolean): void {
  if (process.platform !== "win32" || on === sinkRegistered) return;
  // A binding that cannot load, or one without this export (an older build named by
  // SWEETVIEW_NATIVE_PATH), throws here, as any call of the package does in that case.
  binding().setCallbackErrorSink(
    on
      ? (bindingKind: string, label: string | undefined | null, thrown: unknown) =>
          // `thrown` is the value the callback threw, as it is: the binding's guard caught it in
          // JavaScript and read nothing of it. `label` is the application's name for the callback
          // (a binding's), else the binding's own name for it is the source's name. The line,
          // printed only when a listener throws or a report is nested, reads the value here,
          // after the reporter took its listeners and set its guard.
          reportCallbackError(kindOfBindingCallback(bindingKind), thrown, () => console.error(`sweetview: ${bindingKind} threw: ${describeThrown(thrown)}`), label ?? bindingKind)
      : null,
  );
  sinkRegistered = on;
  // The application's end, by the end of its script or by process.exit() (also from inside a
  // callback, where the environment's cleanup hook does not run): the sink is removed while the
  // environment is alive, so the binding holds no reference to a JavaScript function past it.
  if (on && !releasedAtExit) {
    releasedAtExit = true;
    process.once("exit", () => setBindingSink(false));
  }
}

/**
 * Tells `handler` about an exception the native module catches at a callback boundary on the UI
 * thread, on Windows: one thrown by a tray click, double-click or menu function, a tray menu item,
 * a notification click, a `Window` listener (`onClose`, `onResize`, `onMove`, `onMaximizeChange`,
 * `onFileDrop`, `onNewTab`, `onTabSelect`, `onTabClose`), a hit-region refiner, an input hook, a
 * single-instance or open-URL listener, a function bound on the raw webview class (`bind`,
 * `bindRaw`), its request or file drop handler, an `onEvent` listener (kind `worker`), and the
 * native module's own code at such a boundary (kind `internal`). On macOS no handler is called.
 *
 * Not told: the faults `@n1h/sweetview` catches itself (a page's UI-thread method, a request
 * handler, the ready hooks, the worker's crash and its rejected calls, the tab machinery), a fault
 * inside a Worker, and on Windows a `Menu.popup` item's `click`, whose exception comes out of
 * `Menu.popup`.
 *
 * The handler gets the error, the thrown object itself when it is an `Error` (a thrown non-error is
 * wrapped, with the value as its `cause`), and where it came from. While at least one handler is
 * set, the `console.error` line the native module prints for such an exception is not printed; the
 * callback's fallback still applies (a raw webview's page call is rejected, its request answers
 * 500, a hook lets the event through, a menu function that throws opens no menu, a close request is
 * still taken). A handler that throws is caught; the line for the original error and one for the
 * handler's are printed. Handlers run on the UI thread, in the order they were added.
 *
 * Returns a function that removes this registration, once. With none left, the lines are printed
 * again. Throws when called from a Worker.
 */
export function onCallbackError(handler: CallbackErrorHandler): () => void {
  // The callbacks it hears of run on the UI thread, Bun's main thread; a Worker would hear of
  // none. Decided before anything loads, so a Worker never becomes the binding's UI thread.
  if (!isMainThread) throw new Error("sweetview: this call must be made on the UI thread");
  setBindingSink(true);
  const entry = { handler };
  listeners.add(entry);
  return () => {
    if (!listeners.delete(entry)) return;
    if (listeners.size === 0) setBindingSink(false);
  };
}
