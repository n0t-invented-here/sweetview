// Internal. The one place the native package inspects a value an application supplied at a
// callback boundary: what a callback threw, the reason its promise rejected with, what it returned.
// Such a value can be anything: an object with no prototype, a Proxy whose traps throw, an Error
// whose `message` getter throws. Each function here reads it without letting an exception out.

/** Whether `value` is an `Error`. False for a value whose prototype cannot be read (a Proxy whose `getPrototypeOf` trap throws). */
export function isErrorValue(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/** Whether `value` has a callable `then`, as a promise does. False for a value whose `then` cannot be read. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

/** Text for any value: its `String()` form, else its `Object.prototype.toString` tag, else its type. */
export function describeThrown(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return `a thrown ${typeof value}`;
    }
  }
}

/** An `Error`'s `message` when it can be read and is a string; any other value described as {@link describeThrown} does. */
export function messageOf(value: unknown): string {
  if (isErrorValue(value)) {
    try {
      const message = value.message;
      if (typeof message === "string") return message;
    } catch {
      // A message getter that throws: described below.
    }
  }
  return describeThrown(value);
}

/** The value as an `Error`: itself when it is one, else a new `Error` described by {@link describeThrown} with the value as its `cause`. */
export function asError(value: unknown): Error {
  return isErrorValue(value) ? value : new Error(describeThrown(value), { cause: value });
}
