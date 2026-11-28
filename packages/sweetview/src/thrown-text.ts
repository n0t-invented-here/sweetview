// Internal; no entry point exports it. The text @n1h/sweetview gives a page (or the UI thread, from
// the worker) for a value a handler threw. The native package's own reader of such values is not
// one of its entry points, so this package has its own.

/**
 * As the main branch read it, `error instanceof Error ? error.message : String(error)`, wherever
 * that read returns. It never throws: where that read threw (a Proxy whose `getPrototypeOf` trap
 * throws, an `Error` whose `message` getter throws, an object with no prototype, whose `String()`
 * throws), the value is described by its `String()` form, else its `Object.prototype.toString`
 * tag, else its type.
 */
export function messageOfThrown(error: unknown): string {
  try {
    // Not necessarily a string: an Error's `message` is whatever it holds, as on the main branch.
    if (error instanceof Error) return error.message;
  } catch {
    // Its prototype or its message cannot be read: described below.
  }
  try {
    return String(error);
  } catch {
    try {
      return Object.prototype.toString.call(error);
    } catch {
      return `a thrown ${typeof error}`;
    }
  }
}
