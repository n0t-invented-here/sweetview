// Exceptions thrown by an application's callbacks. The native module calls an application's
// handlers (a tray click, a menu item, a window listener, a hook, ...) on the UI thread, from inside
// the event loop, and catches what they throw there: an exception never unwinds into the OS and
// never ends the loop (W1.3). Every such catch of this package, in the TypeScript and in the
// binding, hands the exception to `reportCallbackError`. With no listener set it does exactly what
// that catch did before: the same `console.error` line. With one set, the listener is told
// instead, and the callback's own fallback (the event let through, no menu opened) still applies.
//
// The catches of `@n1h/sweetview` (a page's UI-thread methods, a request handler, the ready hooks,
// the worker's faults) do not reach this module: it is no entry point of the package, and an
// application must not be able to call it to fabricate a fault (D44).

import { binding } from "./binding";
import { macosKeepsTagPath } from "./platform";

/**
 * Where an exception came from: the public API the application wrote the handler for. `internal` is
 * Sweetview's own code at a callback boundary (the tab machinery, a webview handler of its own); a
 * fault there is a defect of Sweetview's.
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
  | "windowChromeEvents"
  | "window.onFileDrop"
  | "window.onNewTab"
  | "window.onTabSelect"
  | "window.onTabClose"
  | "hitRegions.refine"
  | "mouseHook"
  | "keyboardHook"
  | "singleInstance.onSecondInstance"
  | "onOpenUrl"
  | "timeout"
  | "interval"
  | "deferred"
  | "worker"
  | "internal";

/** What `onCallbackError` is told about an exception, besides the error. */
export type CallbackErrorSource = {
  /** The kind of callback that threw. */
  readonly kind: CallbackKind;
  /** The binding's own name for the callback, when the binding caught the exception itself. */
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

const listeners = new Set<CallbackErrorHandler>();

/**
 * A key an exception may carry to name the kind it came from, for code that cannot import this
 * module (`windowChromeEvents` of `@n1h/sweetview/window-chrome`, which a page bundle loads too).
 */
const KIND_TAG = Symbol.for("sweetview.callbackKind");
const KINDS_TAGGED: ReadonlySet<string> = new Set<CallbackKind>(["windowChromeEvents"]);
const taggedKind = (error: unknown): CallbackKind | undefined => {
  const tag = error !== null && typeof error === "object" ? (error as Record<symbol, unknown>)[KIND_TAG] : undefined;
  return typeof tag === "string" && KINDS_TAGGED.has(tag) ? (tag as CallbackKind) : undefined;
};

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error), { cause: error }));

function printDefault(kind: CallbackKind, error: unknown, fallback: DefaultReport): void {
  if (typeof fallback === "function") fallback(error);
  else console.error(fallback ?? `sweetview: ${kind} threw:`, error);
}

/**
 * Hands an exception a catch at a callback boundary caught to the application's listeners, or does
 * what that catch did before when there are none. Never throws.
 */
export function reportCallbackError(kind: CallbackKind, error: unknown, fallback: DefaultReport, name?: string): void {
  // macOS keeps the main branch's path until its goal (D42): no listener is called there.
  if (listeners.size === 0 || macosKeepsTagPath()) {
    if (fallback !== null) printDefault(kind, error, fallback);
    return;
  }
  const reported = taggedKind(error) ?? kind;
  const source: CallbackErrorSource = name === undefined ? { kind: reported } : { kind: reported, name };
  const wrapped = asError(error);
  for (const listener of [...listeners]) {
    try {
      listener(wrapped, source);
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
  "a file drop handler": "window.onFileDrop",
  "a hit-region refiner": "hitRegions.refine",
  "a mouse hook handler": "mouseHook",
  "a keyboard hook handler": "keyboardHook",
  "a singleInstance onSecondInstance": "singleInstance.onSecondInstance",
  "a native timeout": "timeout",
  "a native interval": "interval",
  "a deferred job": "deferred",
  "a drain function": "worker",
};

/** The binding's kind string as a public kind; one with no public counterpart is `internal`. */
export const kindOfBindingCallback = (bindingKind: string): CallbackKind => BINDING_KINDS[bindingKind] ?? "internal";

let sinkRegistered = false;

/**
 * Routes the binding's own last-resort catch (`sweetview: <kind> threw: <reason>` on stderr, from
 * Rust) here while a listener is set, and back to stderr when the last one is removed.
 */
function setBindingSink(on: boolean): void {
  if (process.platform !== "win32" || on === sinkRegistered) return;
  try {
    binding().setCallbackErrorSink(
      on
        ? (bindingKind: string, reason: string) =>
            reportCallbackError(kindOfBindingCallback(bindingKind), new Error(reason), () => console.error(`sweetview: ${bindingKind} threw: ${reason}`), bindingKind)
        : null,
    );
    sinkRegistered = on;
  } catch {
    // The binding cannot load here; its own calls will say why. Its line stays on stderr.
  }
}

/**
 * Tells `handler` about every exception Sweetview catches at a callback boundary on the UI thread:
 * one thrown by a tray or menu click, a window listener, a notification click, a hit-region
 * refiner, an input hook, a single-instance or open-URL listener, a page's UI-thread method, a
 * request handler, the ready hooks, a native timeout, interval or deferred job, and what the UI
 * thread learns of the worker's faults (its crash, a call it rejected). The handler gets the error
 * (an `Error`; a thrown non-error is wrapped, with the value as its `cause`) and where it came from.
 *
 * While at least one handler is set, the `console.error` line Sweetview prints for such an
 * exception is not printed; the callback's fallback still applies (the page's call is rejected, a
 * request answers 500, a hook lets the event through, a menu function that throws opens no menu, a
 * close request is still taken). A handler that throws is caught; Sweetview then prints its own
 * line for both errors. Handlers run on the UI thread, in the order they were added.
 *
 * Returns a function that removes this handler. With none left, Sweetview prints its lines again.
 */
export function onCallbackError(handler: CallbackErrorHandler): () => void {
  listeners.add(handler);
  setBindingSink(true);
  return () => {
    listeners.delete(handler);
    if (listeners.size === 0) setBindingSink(false);
  };
}
