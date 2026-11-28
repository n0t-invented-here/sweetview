// Internal. The one place the native package inspects a value an application supplied at a
// callback boundary to report it: what a callback threw, the reason its promise rejected with.
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

/** The value as an `Error`: itself when it is one, else a new `Error` described by {@link describeThrown} with the value as its `cause`. */
export function asError(value: unknown): Error {
  return isErrorValue(value) ? value : new Error(describeThrown(value), { cause: value });
}
